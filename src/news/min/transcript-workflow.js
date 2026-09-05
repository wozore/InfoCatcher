/**
 * transcript-workflow.js —— 字幕文件落库与外部 AI 总结（维护者工作台）
 *
 * 流程：Top 选中后，维护者在前端上传 YouTube 候选的字幕文件 →
 *   本模块把文件存到 data/manual/transcripts/<candidate_id>/<file>（可提交、不发布），
 *   并把字幕文本写入候选层 transcript 字段（不进公开投影）→
 *   维护者显式确认成本后，用外部默认 provider（registry DEFAULT_PROVIDER_NAME）对字幕重新总结，
 *   写回 summary / summary_key_points（随 approved 进公开投影，卡片摘要变厚）。
 *
 * 边界：文件名校验防路径穿越；字幕文本截断存储；外部 AI 必须 confirm_cost。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DIRS } = require('../../shared/paths');
const { DEFAULT_PROVIDER_NAME } = require('../../shared/providers');
const { readMinStore, commitMinStoreMutation, revisionOfMinStore, assertExpectedMinRevision } = require('./min-store');
const { setCandidateTranscriptMin, setCandidateTranscriptSummaryMin } = require('./min-review-actions');
const { summarizeCandidate, runPool } = require('../classify/content-summarizer');

const MAX_TRANSCRIPT_STORED_CHARS = 60000;
const SAFE_CANDIDATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const SAFE_FILENAME_RE = /^[^<>:"/\\|?*\x00-\x1f]+$/u;
const ALLOWED_TRANSCRIPT_EXTENSIONS = new Set(['.srt', '.vtt', '.txt']);
const MAX_SUMMARIZE_PER_RUN = 8;
const DEFAULT_SUMMARIZE_CONCURRENCY = 2;
const DEFAULT_SUMMARIZE_BATCH_TIMEOUT_MS = 90_000;

function combinedSignal(parentSignal, timeoutMs) {
  const deadlineController = new AbortController();
  const timer = setTimeout(() => deadlineController.abort(), timeoutMs);
  const signal = parentSignal
    ? (typeof AbortSignal.any === 'function'
      ? AbortSignal.any([parentSignal, deadlineController.signal])
      : deadlineController.signal)
    : deadlineController.signal;
  if (parentSignal && typeof AbortSignal.any !== 'function') {
    if (parentSignal.aborted) deadlineController.abort();
    else parentSignal.addEventListener('abort', () => deadlineController.abort(), { once: true });
  }
  return { signal, cancel: () => clearTimeout(timer) };
}

function summaryAbortError() {
  return Object.assign(new Error('字幕总结超时或已取消，结果未写回，请刷新状态后重试'), {
    code: 'TRANSCRIPT_SUMMARY_TIMEOUT',
    status: 504,
  });
}

function transcriptDir() {
  return path.join(DIRS.manual, 'transcripts');
}

/** 构造安全的仓库内字幕文件相对路径（候选 id + 文件名都拒绝路径分隔符）。 */
function safeTranscriptFile(candidateId, filename) {
  const id = String(candidateId || '').trim();
  if (!SAFE_CANDIDATE_ID_RE.test(id)) throw new Error('候选 id 非法');
  const name = String(filename || '').trim();
  const extension = path.extname(name).toLowerCase();
  if (!SAFE_FILENAME_RE.test(name) || name.length > 120 || /[. ]$/.test(name) || !ALLOWED_TRANSCRIPT_EXTENSIONS.has(extension)) {
    throw new Error('文件名非法（仅允许 .srt、.vtt、.txt，且不得含路径分隔符、Windows 保留字符或控制字符）');
  }
  return path.join('transcripts', id, name);
}

/** 解码并校验字幕内容，尚不产生文件副作用。 */
function prepareTranscriptFile(candidateId, filename, contentBase64) {
  if (typeof contentBase64 !== 'string' || !contentBase64.trim()) throw new Error('字幕文件内容为空');
  let text;
  try {
    text = Buffer.from(contentBase64, 'base64').toString('utf8');
  } catch {
    throw new Error('字幕文件 base64 解码失败');
  }
  if (!text.trim()) throw new Error('字幕文件解码后为空');
  return { file: safeTranscriptFile(candidateId, filename), text: text.slice(0, MAX_TRANSCRIPT_STORED_CHARS), sourceText: text, textLength: text.length };
}

/** 保存字幕文件到仓库，返回文件相对路径与解码文本。 */
function saveTranscriptFile(candidateId, filename, contentBase64, options = {}) {
  const saved = prepareTranscriptFile(candidateId, filename, contentBase64);
  const file = path.join(options.baseDir || DIRS.manual, saved.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, saved.sourceText, 'utf8');
  return saved;
}

function assertTranscriptUploadAllowed(store, candidateId, expectedRevision) {
  assertExpectedMinRevision(store, expectedRevision);
  const candidate = store.candidates.find(item => String(item?.id) === String(candidateId));
  if (!candidate) throw new Error('候选不存在');
  if (candidate.review_status !== 'approved') throw new Error('仅 approved 候选可上传字幕');
}

/** 上传字幕：先通过候选/revision 门禁；若随后 commit 失败则回滚文件副作用。 */
function uploadTranscript(candidateId, filename, contentBase64, options = {}) {
  const saved = prepareTranscriptFile(candidateId, filename, contentBase64);
  const expectedRevision = options.expectedRevision;
  const store = options.store || readMinStore();
  assertTranscriptUploadAllowed(store, candidateId, expectedRevision);
  const file = path.join(options.baseDir || DIRS.manual, saved.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
  fs.writeFileSync(file, saved.sourceText, 'utf8');
  try {
    const result = commitMinStoreMutation(
      current => setCandidateTranscriptMin(current, candidateId, { transcript: saved.text, transcript_file: saved.file }, { expectedRevision }),
      { expectedRevision, store, writeStore: options.writeStore, runId: `transcript-upload-${Date.now()}` },
    );
    if (result.updated !== 1) throw new Error('字幕候选写入被拒绝');
    return { ok: true, candidate_id: candidateId, transcript_chars: saved.textLength, transcript_file: saved.file, ...result };
  } catch (error) {
    if (previous === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, previous);
    throw error;
  }
}

/**
 * 外部 AI 总结字幕：先全部请求总结，再一次 commit 写回，避免中途 revision 冲突。
 * 必须 confirmCost === true 才允许调用外部 DeepSeek。
 */
async function summarizeTranscripts(candidateIds, options = {}) {
  if (options.confirmCost !== true) {
    throw new Error('外部 AI 总结字幕需要显式成本确认（confirm_cost=true）');
  }
  const ids = [...new Set((Array.isArray(candidateIds) ? candidateIds : []).map(id => String(id)))];
  if (!ids.length) throw new Error('缺少候选 id');
  if (ids.length > MAX_SUMMARIZE_PER_RUN) throw new Error(`单次最多总结 ${MAX_SUMMARIZE_PER_RUN} 条字幕`);
  const store = options.store || readMinStore();
  const expectedRevision = options.expectedRevision;
  assertExpectedMinRevision(store, expectedRevision);
  const deadline = combinedSignal(options.signal, options.batchTimeoutMs ?? DEFAULT_SUMMARIZE_BATCH_TIMEOUT_MS);
  let results;
  try {
    results = await runPool(ids, options.concurrency ?? DEFAULT_SUMMARIZE_CONCURRENCY, async id => {
      if (deadline.signal.aborted) return { id, ok: false, error: '字幕总结超时或已取消', code: 'timeout' };
      const candidate = store.candidates.find(item => String(item?.id) === id);
      if (!candidate) return { id, ok: false, error: '候选不存在' };
      if (!candidate.transcript) return { id, ok: false, error: '无字幕可总结' };
      try {
        const suggestion = await summarizeCandidate(candidate, {
          provider: DEFAULT_PROVIDER_NAME,
          external: true,
          apiKey: options.apiKey,
          fetchImpl: options.fetchImpl,
          model: options.model,
          timeoutMs: options.timeoutMs,
          signal: deadline.signal,
        });
        if (suggestion.summary) return { id, ok: true, summary: suggestion.summary, key_points: suggestion.key_points };
        return { id, ok: false, error: suggestion.llm_error || '总结失败' };
      } catch (error) {
        return { id, ok: false, error: error.message || '总结失败', code: error.code };
      }
    });
    if (deadline.signal.aborted) throw summaryAbortError();
  } finally {
    deadline.cancel();
  }
  const commit = commitMinStoreMutation(
    current => {
      let next = current;
      for (const result of results) {
        if (!result.ok) continue;
        const mutation = setCandidateTranscriptSummaryMin(next, result.id, {
          summary: result.summary,
          key_points: result.key_points,
          llm: DEFAULT_PROVIDER_NAME,
        }, { expectedRevision: revisionOfMinStore(next) });
        next = mutation.store;
      }
      return { store: next, changed: results.filter(result => result.ok).length };
    },
    { expectedRevision, store: options.store, writeStore: options.writeStore, runId: `transcript-summarize-${Date.now()}` },
  );
  return { ok: true, summarized: results.filter(result => result.ok).map(result => ({ id: result.id, summary: result.summary })), failed: results.filter(result => !result.ok), ...commit };
}

module.exports = {
  MAX_TRANSCRIPT_STORED_CHARS,
  MAX_SUMMARIZE_PER_RUN,
  transcriptDir,
  safeTranscriptFile,
  saveTranscriptFile,
  uploadTranscript,
  summarizeTranscripts,
};
