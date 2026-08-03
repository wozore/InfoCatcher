/**
 * news-transcripts.js —— 视频字幕/文字稿获取与证据映射（B16 决策 51/52/54/61/67）
 *
 * 在热点管线中的位置：对 YouTube 候选做字幕/文字稿 enrichment，把获取结果
 * 映射到候选的双状态轴（决策 52/57），并把完整字幕写入内部运行时目录。
 *
 * ═══════════════════════════════════════════════════════════════
 * 结果映射（决策 52）：
 * ═══════════════════════════════════════════════════════════════
 *   获取成功        → candidate.transcript（元数据 + 证据片段），不改状态
 *   字幕缺失/过短   → review_status: held + hold_reason（等待补充后复审）
 *   技术获取失败    → ai_processing_status: error + error_type/retryable
 *
 * 补充字幕后重新处理（决策 52）：成功获取且此前因字幕原因 held 的候选
 * 重置为 pending，由管理者再次审核。
 *
 * ═══════════════════════════════════════════════════════════════
 * 存储边界（决策 61/68）：
 * ═══════════════════════════════════════════════════════════════
 *   完整字幕写入 data/news/runtime/transcripts/<id>.json（内部，不发布、不进 PR）；
 *   候选记录只携带元数据 + 短证据片段（transcript_evidence），供 PR 审核并列核验。
 *
 * 获取方式：YouTube 自动字幕 timedtext 端点（best-effort、无需 OAuth/API Key）。
 * 不使用绕过平台限制或逆向接口的方式（决策 52/67）。B站字幕获取已搁置。
 * fetchImpl 可注入，便于离线测试。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('../core/news-storage');
const { DIRS } = require('../../shared/paths');
const { markHeld, markAiError } = require('../core/news-candidates');

const TRANSCRIPTS_DIR = path.join(DIRS.newsRuntime, 'transcripts');

const DEFAULT_BASE_URL = 'https://www.youtube.com/api/timedtext';
const DEFAULT_LANGUAGES = Object.freeze(['zh-Hans', 'zh-Hant', 'zh', 'en']);
const DEFAULT_MIN_CHARS = 80;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_ITEMS = 30;

/** 字幕内容指纹：sha256（决策 52：记录字幕来源与内容指纹，便于追溯）。 */
function transcriptFingerprint(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

/** 候选 id → 内部字幕文件路径。候选 id 由 platform + hash 组成，安全可作文件名。 */
function transcriptPath(id, dir = TRANSCRIPTS_DIR) {
  return path.join(dir, `${id}.json`);
}

/**
 * 解析 timedtext fmt=json3 响应为字幕片段 [{ start, dur, text }]。
 * 同一事件的多个 seg 合并为一行字幕（对应一条字幕行）；非 JSON（纯文本）
 * 响应退化为逐行片段。空/纯空白输入返回空数组。
 */
function parseTimedTextJson3(body) {
  const text = String(body || '');
  if (!text.trim()) return [];
  let payload;
  try { payload = JSON.parse(text); }
  catch { return text.split(/\n+/).map(line => line.trim()).filter(Boolean).map(line => ({ start: 0, dur: 0, text: line })); }
  const segments = [];
  for (const event of payload.events || []) {
    if (!Array.isArray(event.segs)) continue;
    const line = event.segs
      .map(seg => String(seg.utf8 || '').replace(/\n/g, ' '))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;
    segments.push({ start: Number(event.tStart) || 0, dur: Number(event.dDuration) || 0, text: line });
  }
  return segments;
}

/** 从片段生成证据摘要：总文本、字符数、片段数、截断证据片段。 */
function transcriptSummary(segments, maxSnippetChars = 300) {
  const text = segments.map(segment => segment.text).join(' ');
  return {
    text,
    chars: text.length,
    segments_count: segments.length,
    snippet: text.slice(0, maxSnippetChars),
  };
}

/**
 * 尝试获取 YouTube 视频的自动字幕/文字稿（best-effort，无 OAuth）。
 * 按语言列表依次请求，首个返回可用文本的语言胜出。
 *
 * @returns {object} 结果对象：
 *   - ok: true   → source_type / language / fetched_at / fingerprint / chars /
 *                  segments_count / segments / text / snippet
 *   - ok: false  → reason: not_found | too_short | fetch_failed | blocked，
 *                  error_type / retryable（fetch_failed/blocked）
 */
async function fetchYouTubeTranscript(videoId, {
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  languages = DEFAULT_LANGUAGES,
  minChars = DEFAULT_MIN_CHARS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = new Date().toISOString(),
} = {}) {
  if (!videoId) return { ok: false, reason: 'not_found', error_type: 'transcript_unavailable' };

  for (const lang of languages) {
    const url = `${baseUrl}?lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(videoId)}&fmt=json3`;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        if (response.status === 404) continue; // 该语言无字幕 → 试下一语言
        throw Object.assign(new Error(`timedtext HTTP ${response.status}`), { status: response.status });
      }
      const segments = parseTimedTextJson3(await response.text());
      if (!segments.length) continue; // 空响应 → 试下一语言
      const { text, chars, segments_count, snippet } = transcriptSummary(segments);
      if (chars < minChars) {
        return { ok: false, reason: 'too_short', chars, segments_count, min_chars: minChars };
      }
      return {
        ok: true,
        source_type: 'youtube_timedtext',
        language: lang,
        fetched_at: now,
        fingerprint: transcriptFingerprint(text),
        chars,
        segments_count,
        segments,
        text,
        snippet,
      };
    } catch (error) {
      const status = error.status;
      if (status === 403) {
        return { ok: false, reason: 'blocked', error_type: 'transcript_blocked', retryable: false };
      }
      return {
        ok: false,
        reason: 'fetch_failed',
        error_type: 'transcript_fetch_failed',
        retryable: !(status && status >= 400 && status < 500),
      };
    }
  }
  return { ok: false, reason: 'not_found', error_type: 'transcript_unavailable' };
}

/**
 * 把字幕获取结果映射到候选状态（决策 52/57）：
 *   - ok         → 写入 transcript 元数据 + transcript_evidence，不改状态轴；
 *   - too_short  → markHeld（review_status: held + hold_reason）；
 *   - 缺失       → markHeld；
 *   - 获取失败   → markAiError（ai_processing_status: error + error_type/retryable）。
 */
function applyTranscriptOutcome(candidate, result, { now } = {}) {
  if (!candidate) throw new Error('候选不存在');
  const timestamp = now || new Date().toISOString();

  if (result.ok) {
    candidate.transcript = {
      source_type: result.source_type,
      language: result.language,
      fetched_at: result.fetched_at,
      fingerprint: result.fingerprint,
      chars: result.chars,
      segments_count: result.segments_count,
      path: transcriptPath(candidate.id),
    };
    candidate.transcript_status = 'ok';
    candidate.transcript_evidence = result.snippet || (result.text || '').slice(0, 300);
    candidate.transcript_updated_at = timestamp;
    return candidate;
  }

  if (result.reason === 'fetch_failed' || result.reason === 'blocked') {
    markAiError(candidate, {
      errorType: result.error_type || 'transcript_fetch_failed',
      retryable: result.retryable !== false,
      retryCount: Number(candidate.retry_count || 0) + 1,
    });
    candidate.transcript_status = 'fetch_failed';
    return candidate;
  }

  if (result.reason === 'too_short') {
    markHeld(candidate, {
      reason: `字幕过短（${result.chars} 字符，低于 ${result.min_chars}），证据不足，等待补充后复审`,
      now: timestamp,
    });
    candidate.transcript_status = 'too_short';
    return candidate;
  }

  markHeld(candidate, {
    reason: '字幕缺失：YouTube 未返回可用的自动字幕/文字稿，等待补充后复审',
    now: timestamp,
  });
  candidate.transcript_status = 'missing';
  return candidate;
}

/** 把完整字幕原子写入内部运行时目录（决策 61：完整字幕仅保存在内部记录）。 */
function storeTranscript(candidate, result, { runId, transcriptsDir = TRANSCRIPTS_DIR } = {}) {
  if (!candidate || !result || !result.ok) return null;
  fs.mkdirSync(transcriptsDir, { recursive: true });
  const file = transcriptPath(candidate.id, transcriptsDir);
  writeJsonAtomic(file, {
    id: candidate.id,
    native_id: candidate.native_id,
    source_type: result.source_type,
    language: result.language,
    fetched_at: result.fetched_at,
    fingerprint: result.fingerprint,
    chars: result.chars,
    segments_count: result.segments_count,
    segments: result.segments,
  }, runId || 'transcript');
  return file;
}

/**
 * 管线钩子：对本轮候选中的 YouTube 内容做字幕 enrichment。
 * 只处理候选层中还没有成功字幕、且非人工已决（approved 且带审核时间）的候选；
 * 跳过 discarded。成功获取且此前因字幕原因 held 的候选重置为 pending
 * （决策 52：补充字幕后重新置为 pending 再审核）。
 *
 * @returns {{ processed, ok, held, failed, recovered }}
 */
async function enrichYouTubeTranscripts(store, activeIds, options = {}) {
  const enabled = options.enabled === true;
  if (!enabled || !store) return { processed: 0, ok: 0, held: 0, failed: 0, recovered: 0 };

  const ids = new Set(activeIds || []);
  const targets = (store.candidates || [])
    .filter(candidate => ids.has(candidate.id)
      && candidate.platform === 'youtube'
      && candidate.transcript_status !== 'ok'
      && candidate.review_status !== 'discarded'
      && !(candidate.review_status === 'approved' && candidate.reviewed_at))
    .slice(0, options.maxItems ?? DEFAULT_MAX_ITEMS);

  const counts = { processed: 0, ok: 0, held: 0, failed: 0, recovered: 0 };
  for (const candidate of targets) {
    const result = await fetchYouTubeTranscript(candidate.native_id, {
      fetchImpl: options.fetchImpl,
      baseUrl: options.baseUrl,
      languages: options.languages,
      minChars: options.minChars,
      timeoutMs: options.timeoutMs,
      now: options.now,
    });
    const wasTranscriptHeld = candidate.review_status === 'held' && candidate.transcript_status && candidate.transcript_status !== 'ok';
    applyTranscriptOutcome(candidate, result, { now: options.now });
    if (result.ok) {
      if (wasTranscriptHeld) { candidate.review_status = 'pending'; counts.recovered += 1; }
      storeTranscript(candidate, result, { runId: options.runId, transcriptsDir: options.transcriptsDir });
      counts.ok += 1;
    } else if (result.reason === 'fetch_failed' || result.reason === 'blocked') {
      counts.failed += 1;
    } else {
      counts.held += 1;
    }
    counts.processed += 1;
  }
  return counts;
}

module.exports = {
  TRANSCRIPTS_DIR,
  DEFAULT_BASE_URL,
  DEFAULT_LANGUAGES,
  DEFAULT_MIN_CHARS,
  DEFAULT_TIMEOUT_MS,
  transcriptFingerprint,
  transcriptPath,
  parseTimedTextJson3,
  transcriptSummary,
  fetchYouTubeTranscript,
  applyTranscriptOutcome,
  storeTranscript,
  enrichYouTubeTranscripts,
};
