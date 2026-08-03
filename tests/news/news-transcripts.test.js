/**
 * news-transcripts.test.js — 视频字幕/文字稿处理测试（B16 决策 51/52/54/61/67）
 *
 * 测试原理：
 *   不请求真实网络，注入 mock fetchImpl 验证：
 *     1. 字幕获取的成功/缺失/过短/技术失败结果分类（决策 52）；
 *     2. 结果到候选双状态轴的映射（held / error）；
 *     3. 完整字幕写入内部运行时目录、候选只带元数据与证据片段（决策 61）；
 *     4. 管线钩子（enrich）按配置开关与候选条件过滤，并支持 held→pending 恢复。
 *
 * 运行方式：node --test tests/news/news-transcripts.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  transcriptFingerprint,
  transcriptPath,
  parseTimedTextJson3,
  transcriptSummary,
  fetchYouTubeTranscript,
  applyTranscriptOutcome,
  storeTranscript,
  enrichYouTubeTranscripts,
} = require('../../src/news/collectors/news-transcripts');

// 简短 json3 字幕（不足 80 字符，用于 too_short / 解析测试）
const JSON3_SHORT = JSON.stringify({
  events: [
    { tStart: 0, dDuration: 5000, segs: [{ utf8: '今天介绍一个' }, { utf8: ' 新的 AI 工具' }] },
  ],
});
// 较长的 json3 字幕（足够通过 minChars）
const JSON3_LONG = JSON.stringify({
  events: [
    { tStart: 0, dDuration: 5000, segs: [{ utf8: '今天介绍一个 ' }, { utf8: '新的 AI 工具，' }] },
    { tStart: 5000, dDuration: 4000, segs: [{ utf8: '它支持本地知识库问答，' }] },
    { tStart: 9000, dDuration: 3000, segs: [{ utf8: '可以把文档上传后直接提问，' }] },
    { tStart: 12000, dDuration: 3000, segs: [{ utf8: '这是本周最重要的更新。' }] },
  ],
});

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

/** 按 URL 返回响应的 mock fetchImpl */
function mockFetch(respond) {
  return async url => respond(String(url));
}

// ── 第 1 组：指纹 / 路径 / 解析 / 摘要 ───────────────────────

test('transcriptFingerprint 返回 64 位 hex 且确定性', () => {
  const fingerprint = transcriptFingerprint('你好');
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(transcriptFingerprint('你好'), fingerprint);
  assert.notEqual(transcriptFingerprint('你好'), transcriptFingerprint('世界'));
});

test('transcriptPath 使用候选 id 与目录', () => {
  const dir = path.join(os.tmpdir(), 'ic-transcripts-test');
  assert.equal(transcriptPath('youtube-abc', dir), path.join(dir, 'youtube-abc.json'));
});

test('parseTimedTextJson3 解析 json3 片段，同一事件合并为一行', () => {
  const segments = parseTimedTextJson3(JSON3_SHORT);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, '今天介绍一个 新的 AI 工具');
  assert.equal(segments[0].start, 0);
});

test('parseTimedTextJson3 非 JSON 响应退化为纯文本片段', () => {
  const segments = parseTimedTextJson3('第一行\n第二行\n第三行');
  assert.equal(segments.length, 3);
  assert.equal(segments[1].text, '第二行');
});

test('parseTimedTextJson3 空/纯空白输入返回空数组', () => {
  assert.deepEqual(parseTimedTextJson3(''), []);
  assert.deepEqual(parseTimedTextJson3('   '), []);
});

test('transcriptSummary 统计字符数与片段数并截断证据片段', () => {
  const summary = transcriptSummary([{ text: 'a' }, { text: 'b' }], 1);
  assert.equal(summary.chars, 3);              // 'a b' 含空格
  assert.equal(summary.segments_count, 2);
  assert.equal(summary.snippet, 'a');
});

// ── 第 2 组：fetchYouTubeTranscript 结果分类（决策 52）────────

test('获取成功：首个可用语言胜出并返回元数据', async () => {
  const result = await fetchYouTubeTranscript('vid1', {
    minChars: 10,
    fetchImpl: mockFetch(() => response(JSON3_LONG)),
  });
  assert.equal(result.ok, true);
  assert.equal(result.source_type, 'youtube_timedtext');
  assert.equal(result.language, 'zh-Hans');
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(result.chars >= 10);
  assert.ok(Array.isArray(result.segments));
});

test('全语言 404：判定字幕缺失 not_found', async () => {
  const result = await fetchYouTubeTranscript('vid2', {
    fetchImpl: mockFetch(() => response('', 404)),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
});

test('403 阻止访问：blocked 且不可重试', async () => {
  const result = await fetchYouTubeTranscript('vid3', {
    fetchImpl: mockFetch(() => response('', 403)),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'blocked');
  assert.equal(result.retryable, false);
});

test('网络/5xx 错误：fetch_failed 且可重试', async () => {
  const result = await fetchYouTubeTranscript('vid4', {
    fetchImpl: mockFetch(() => { throw new Error('network down'); }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fetch_failed');
  assert.equal(result.retryable, true);
});

test('字幕过短：too_short 并报告字符数', async () => {
  const result = await fetchYouTubeTranscript('vid5', {
    minChars: 80,
    fetchImpl: mockFetch(() => response(JSON3_SHORT)),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too_short');
  assert.ok(result.chars < 80);
});

// ── 第 3 组：applyTranscriptOutcome 状态映射（决策 52/57）────

function candidate(overrides = {}) {
  return {
    id: 'youtube-test-video', platform: 'youtube', native_id: 'vidX',
    title: '测试视频', ai_processing_status: 'completed', review_status: 'approved',
    ...overrides,
  };
}

test('成功：写入 transcript 元数据与证据片段，不改状态轴', () => {
  const item = candidate();
  const result = {
    ok: true, source_type: 'youtube_timedtext', language: 'zh-Hans',
    fetched_at: '2026-08-03T00:00:00Z', fingerprint: 'f'.repeat(64),
    chars: 200, segments_count: 4, text: 'x'.repeat(200), snippet: '证据片段',
  };
  const mapped = applyTranscriptOutcome(item, result);
  assert.equal(mapped.transcript_status, 'ok');
  assert.equal(mapped.transcript.fingerprint, 'f'.repeat(64));
  assert.equal(mapped.transcript_evidence, '证据片段');
  assert.equal(mapped.review_status, 'approved');          // 状态轴不变
  assert.equal(mapped.ai_processing_status, 'completed');
});

test('字幕缺失：置为 held + hold_reason + transcript_status=missing', () => {
  const item = applyTranscriptOutcome(candidate(), { ok: false, reason: 'not_found' });
  assert.equal(item.review_status, 'held');
  assert.match(item.hold_reason, /字幕缺失/);
  assert.equal(item.transcript_status, 'missing');
  assert.equal(item.ai_processing_status, 'completed');     // 不污染 AI 状态轴
});

test('字幕过短：置为 held + hold_reason 提及字符数', () => {
  const item = applyTranscriptOutcome(candidate(), { ok: false, reason: 'too_short', chars: 30, min_chars: 80 });
  assert.equal(item.review_status, 'held');
  assert.match(item.hold_reason, /字幕过短.*30/);
  assert.equal(item.transcript_status, 'too_short');
});

test('技术失败：置为 ai_processing_status=error + error_type + retryable', () => {
  const item = applyTranscriptOutcome(candidate({ review_status: 'pending' }), {
    ok: false, reason: 'fetch_failed', error_type: 'transcript_fetch_failed', retryable: true,
  });
  assert.equal(item.ai_processing_status, 'error');
  assert.equal(item.error_type, 'transcript_fetch_failed');
  assert.equal(item.retryable, true);
  assert.equal(item.review_status, 'pending');              // 不覆盖人工决定
  assert.equal(item.transcript_status, 'fetch_failed');
});

// ── 第 4 组：storeTranscript 内部存储（决策 61）──────────────

test('storeTranscript 把完整字幕写入指定目录并保留片段', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-transcript-store-'));
  try {
    const item = candidate();
    const result = {
      ok: true, source_type: 'youtube_timedtext', language: 'en',
      fetched_at: '2026-08-03T00:00:00Z', fingerprint: 'f'.repeat(64),
      chars: 10, segments_count: 1, segments: [{ start: 0, dur: 5, text: 'hello world' }],
    };
    const file = storeTranscript(item, result, { transcriptsDir: dir });
    assert.equal(file, transcriptPath(item.id, dir));
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.id, item.id);
    assert.equal(stored.segments.length, 1);
    assert.equal(stored.fingerprint, 'f'.repeat(64));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 第 5 组：enrichYouTubeTranscripts 管线钩子 ───────────────

function enrichStore(candidates) {
  return { schema_version: 1, updated_at: null, candidates };
}

test('开关关闭：不发起任何获取，返回零计数', async () => {
  let calls = 0;
  const store = enrichStore([candidate()]);
  const counts = await enrichYouTubeTranscripts(store, ['youtube-test-video'], {
    enabled: false,
    fetchImpl: mockFetch(() => { calls += 1; return response(JSON3_LONG); }),
  });
  assert.deepEqual(counts, { processed: 0, ok: 0, held: 0, failed: 0, recovered: 0 });
  assert.equal(calls, 0);
});

test('开关开启：处理 YouTube 候选，成功写入字幕并存储', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-transcript-enrich-'));
  try {
    const store = enrichStore([
      candidate({ id: 'youtube-a', native_id: 'vidA' }),
      candidate({ id: 'youtube-b', native_id: 'vidB' }),
      { id: 'x-post', platform: 'x', native_id: 'tid', ai_processing_status: 'completed', review_status: 'approved' },
      { id: 'youtube-discarded', platform: 'youtube', native_id: 'vidC', review_status: 'discarded' },
      { id: 'youtube-human-approved', platform: 'youtube', native_id: 'vidD', review_status: 'approved', reviewed_at: '2026-08-01T00:00:00Z' },
    ]);
    const counts = await enrichYouTubeTranscripts(store, ['youtube-a', 'youtube-b', 'x-post', 'youtube-discarded', 'youtube-human-approved'], {
      enabled: true,
      fetchImpl: mockFetch(() => response(JSON3_LONG)),
      minChars: 10,
      transcriptsDir: dir,
    });
    assert.equal(counts.processed, 2);       // 只处理 youtube 未决候选
    assert.equal(counts.ok, 2);
    assert.equal(counts.held, 0);
    assert.equal(counts.failed, 0);
    const a = store.candidates.find(item => item.id === 'youtube-a');
    assert.equal(a.transcript_status, 'ok');
    assert.ok(a.transcript.fingerprint);
    assert.ok(fs.existsSync(transcriptPath('youtube-a', dir)));
    const x = store.candidates.find(item => item.id === 'x-post');
    assert.equal(x.transcript_status, undefined);   // 非 youtube 不处理
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('恢复路径：此前因字幕 held 的候选，成功获取后重置为 pending', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-transcript-recover-'));
  try {
    const store = enrichStore([
      candidate({ id: 'youtube-held', native_id: 'vidE', review_status: 'held', transcript_status: 'missing', hold_reason: '字幕缺失' }),
    ]);
    const counts = await enrichYouTubeTranscripts(store, ['youtube-held'], {
      enabled: true, fetchImpl: mockFetch(() => response(JSON3_LONG)), minChars: 10, transcriptsDir: dir,
    });
    assert.equal(counts.recovered, 1);
    const item = store.candidates[0];
    assert.equal(item.review_status, 'pending');   // 决策 52：补充字幕后重新置为 pending 再审核
    assert.equal(item.transcript_status, 'ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('技术失败：计数 failed，候选进入 ai_processing_status=error', async () => {
  const store = enrichStore([candidate({ id: 'youtube-fail', native_id: 'vidF', review_status: 'pending' })]);
  const counts = await enrichYouTubeTranscripts(store, ['youtube-fail'], {
    enabled: true,
    fetchImpl: mockFetch(() => { throw new Error('timeout'); }),
  });
  assert.equal(counts.failed, 1);
  assert.equal(store.candidates[0].ai_processing_status, 'error');
  assert.equal(store.candidates[0].transcript_status, 'fetch_failed');
});
