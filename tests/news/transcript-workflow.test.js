'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMinStore, revisionOfMinStore } = require('../../src/news/min/min-store');
const { AI_PROTOCOLS, DEFAULT_PROVIDER_NAME, getProvider } = require('../../src/shared/ai-provider-registry');
const {
  safeTranscriptFile,
  uploadTranscript,
  summarizeTranscripts,
  MAX_TRANSCRIPT_STORED_CHARS,
} = require('../../src/news/min/transcript-workflow');

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-wf-'));
}

function approvedStore(base) {
  return createMinStore({
    candidates: [
      { id: 'yt-1', review_status: 'approved', platform: 'youtube', title: 'Video A', top_selected: true },
      { id: 'yt-2', review_status: 'pending', platform: 'youtube', title: 'Video B' },
    ],
  });
}

function localResponse(value) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ output_text: JSON.stringify(value) }),
    text: async () => '',
  };
}

test('safeTranscriptFile 拒绝路径穿越与非法文件名', () => {
  assert.throws(() => safeTranscriptFile('../etc', 'a.txt'), /非法/);
  assert.throws(() => safeTranscriptFile('.. ', 'a.txt'), /非法/);
  assert.throws(() => safeTranscriptFile('yt-1', '../../evil.txt'), /文件名非法/);
  assert.throws(() => safeTranscriptFile('yt-1', 'a\\b.txt'), /文件名非法/);
  assert.throws(() => safeTranscriptFile('yt-1', 'subtitle.exe'), /文件名非法/);
  assert.equal(safeTranscriptFile('yt-1', '字幕（完整）.srt'), path.join('transcripts', 'yt-1', '字幕（完整）.srt'));
  assert.equal(safeTranscriptFile('yt-1', 'sub.srt'), path.join('transcripts', 'yt-1', 'sub.srt'));
});

test('uploadTranscript 仅 approved 候选写入字幕并保存文件（revision 门禁）', () => {
  const base = tmpBase();
  const store = approvedStore();
  const revision = revisionOfMinStore(store);
  let written = null;
  const content = Buffer.from('hello 字幕'.repeat(20), 'utf8').toString('base64');
  const result = uploadTranscript('yt-1', 'sub.srt', content, {
    baseDir: base,
    store,
    expectedRevision: revision,
    writeStore: (next) => { written = next; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.updated, 1);
  assert.ok(written.candidates.find(c => c.id === 'yt-1').transcript.includes('字幕'));
  assert.equal(written.candidates.find(c => c.id === 'yt-1').transcript_file, path.join('transcripts', 'yt-1', 'sub.srt'));
  const fileOnDisk = path.join(base, 'transcripts', 'yt-1', 'sub.srt');
  assert.ok(fs.existsSync(fileOnDisk));
  // 非 approved（pending）候选在任何文件副作用前拒绝。
  assert.throws(() => uploadTranscript('yt-2', 'b.srt', content, {
    baseDir: base,
    store,
    expectedRevision: revision,
    writeStore: () => {},
  }), /仅 approved/);
  assert.equal(fs.existsSync(path.join(base, 'transcripts', 'yt-2', 'b.srt')), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('uploadTranscript 在 revision 冲突时回滚新文件且不覆盖既有文件', () => {
  const base = tmpBase();
  const store = approvedStore();
  const relative = path.join('transcripts', 'yt-1', 'subtitle.srt');
  const file = path.join(base, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'previous content', 'utf8');
  assert.throws(() => uploadTranscript('yt-1', 'subtitle.srt', Buffer.from('new content').toString('base64'), {
    baseDir: base,
    store,
    expectedRevision: 'stale-revision',
    writeStore: () => {},
  }), /revision 冲突/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'previous content');
  fs.rmSync(base, { recursive: true, force: true });
});

test('summarizeTranscripts 需成本确认并调用外部 AI 写回 summary', async () => {
  const base = tmpBase();
  const store = approvedStore();
  store.candidates.find(c => c.id === 'yt-1').transcript = 'transcript text';
  const revision = revisionOfMinStore(store);
  let written = null;
  await assert.rejects(() => summarizeTranscripts(['yt-1'], { store, expectedRevision: revision }), /成本确认/);
  let requestedEndpoint = '';
  const fetchImpl = async (endpoint) => {
    requestedEndpoint = String(endpoint);
    return localResponse({ summary: '基于字幕的中文总结', key_points: ['要点一', '要点二'] });
  };
  const result = await summarizeTranscripts(['yt-1'], {
    store,
    expectedRevision: revision,
    confirmCost: true,
    apiKey: 'test-key',
    fetchImpl,
    writeStore: (next) => { written = next; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.summarized.length, 1);
  assert.equal(result.summarized[0].summary, '基于字幕的中文总结');
  const defaultProvider = getProvider(DEFAULT_PROVIDER_NAME);
  assert.equal(requestedEndpoint, defaultProvider.protocol === AI_PROTOCOLS.MESSAGES ? defaultProvider.messagesEndpoint : defaultProvider.responsesEndpoint);
  assert.ok(written.candidates.find(c => c.id === 'yt-1').summary.includes('基于字幕'));
  assert.ok(written.candidates.find(c => c.id === 'yt-1').transcript_summarized_at);
  fs.rmSync(base, { recursive: true, force: true });
});

test('summarizeTranscripts 多条成功总结在一次 revision 门禁提交中全部写回', async () => {
  const store = approvedStore();
  const second = store.candidates.find(c => c.id === 'yt-2');
  second.review_status = 'approved';
  second.top_selected = true;
  store.candidates.find(c => c.id === 'yt-1').transcript = 'transcript one';
  second.transcript = 'transcript two';
  const revision = revisionOfMinStore(store);
  let written = null;
  let sequence = 0;
  const fetchImpl = async () => localResponse({ summary: `总结 ${++sequence}`, key_points: ['重点'] });
  const result = await summarizeTranscripts(['yt-1', 'yt-2'], {
    store,
    expectedRevision: revision,
    confirmCost: true,
    apiKey: 'test-key',
    fetchImpl,
    writeStore: next => { written = next; },
  });
  assert.equal(result.summarized.length, 2);
  assert.equal(result.failed.length, 0);
  assert.equal(written.candidates.find(c => c.id === 'yt-1').summary, '总结 1');
  assert.equal(written.candidates.find(c => c.id === 'yt-2').summary, '总结 2');
});

test('summarizeTranscripts 使用外部默认 provider 返回并限制为 2 并发', async () => {
  const store = approvedStore();
  const first = store.candidates.find(c => c.id === 'yt-1');
  first.transcript = 'transcript one';
  const second = store.candidates.find(c => c.id === 'yt-2');
  second.review_status = 'approved';
  second.transcript = 'transcript two';
  for (let index = 3; index <= 4; index++) {
    store.candidates.push({ id: `yt-${index}`, review_status: 'approved', platform: 'youtube', title: `Video ${index}`, transcript: `transcript ${index}` });
  }
  const revision = revisionOfMinStore(store);
  let active = 0;
  let maximum = 0;
  const result = await summarizeTranscripts(['yt-1', 'yt-2', 'yt-3', 'yt-4'], {
    store,
    expectedRevision: revision,
    confirmCost: true,
    apiKey: 'test-key',
    fetchImpl: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
      return localResponse({ summary: '外部总结', key_points: [] });
    },
    writeStore: () => {},
  });
  assert.equal(result.summarized.length, 4);
  assert.equal(maximum, 2);
});

test('summarizeTranscripts 初始 revision 过期时不调用外部 AI', async () => {
  const store = approvedStore();
  store.candidates.find(c => c.id === 'yt-1').transcript = 'text';
  let calls = 0;
  await assert.rejects(() => summarizeTranscripts(['yt-1'], {
    store,
    expectedRevision: 'stale-revision',
    confirmCost: true,
    apiKey: 'test-key',
    fetchImpl: async () => { calls += 1; return localResponse({ summary: '不应调用', key_points: [] }); },
  }), /revision 冲突/);
  assert.equal(calls, 0);
});

test('summarizeTranscripts 整批超时不写回已完成结果', async () => {
  const store = approvedStore();
  store.candidates.find(c => c.id === 'yt-1').transcript = 'text';
  let written = false;
  await assert.rejects(() => summarizeTranscripts(['yt-1'], {
    store,
    expectedRevision: revisionOfMinStore(store),
    confirmCost: true,
    apiKey: 'test-key',
    timeoutMs: 1000,
    batchTimeoutMs: 20,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
    writeStore: () => { written = true; },
  }), error => error.code === 'TRANSCRIPT_SUMMARY_TIMEOUT' && error.status === 504);
  assert.equal(written, false);
});

test('summarizeTranscripts 超过单批上限会 fail-closed', async () => {
  const store = approvedStore();
  const revision = revisionOfMinStore(store);
  const ids = Array.from({ length: 9 }, (_, index) => `yt-${index + 1}`);
  await assert.rejects(() => summarizeTranscripts(ids, {
    store,
    expectedRevision: revision,
    confirmCost: true,
    apiKey: 'test-key',
    fetchImpl: async () => localResponse({ summary: '不应调用', key_points: [] }),
    writeStore: () => {},
  }), /单次最多总结 8 条/);
});

test('字幕存储文本按上限截断', () => {
  const long = '字'.repeat(MAX_TRANSCRIPT_STORED_CHARS + 100);
  const saved = uploadTranscript('yt-1', 'long.srt', Buffer.from(long, 'utf8').toString('base64'), {
    baseDir: tmpBase(),
    store: approvedStore(),
    expectedRevision: revisionOfMinStore(approvedStore()),
    writeStore: () => {},
  });
  assert.equal(saved.transcript_chars, MAX_TRANSCRIPT_STORED_CHARS + 100);
});
