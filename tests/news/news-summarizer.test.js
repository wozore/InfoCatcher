/**
 * news-summarizer.test.js — 内容总结器测试（content-summarizer）
 *
 * 测试原理：
 *   不请求真实网络，注入 mock fetchImpl 验证：
 *     1. normalizeSummary 解析模型输出的 JSON 容错；
 *     2. summarizeWithDeepSeek 成功/缺 key/网络失败/输出无法解析降级；
 *     3. summarizeCandidate 成功（含字幕）/失败降级/无素材；
 *     4. summarizeCandidates 批量、跳过已有 summary、并发限流；
 *     5. enrichCandidateSummaries 管线钩子按开关与条件过滤；
 *     6. mergeCandidatesMin 保留既有审核结论（重新采集不重置人工结论）。
 *
 * 运行方式：node --test tests/news/news-summarizer.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSummaryPayload,
  normalizeSummary,
  summarizeWithDeepSeek,
  summarizeWithExternalDeepSeek,
} = require('../../src/news/classify/llm-provider');
const {
  collectSummarySource,
  summarizeCandidate,
  summarizeCandidates,
  enrichCandidateSummaries,
} = require('../../src/news/classify/content-summarizer');
const { mergeCandidatesMin } = require('../../src/news/min/min-store');

/** 构造一个 DeepSeek 成功响应（content 为模型输出文本）。 */
function deepSeekOk(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

/** 按 URL 返回响应的 mock fetchImpl。 */
function mockFetch(respond) {
  return async url => respond(String(url));
}

// ── 第 1 组：buildSummaryPayload / normalizeSummary（llm-provider）────

test('buildSummaryPayload 裁剪标题/描述/字幕', () => {
  const payload = buildSummaryPayload({
    title: 't'.repeat(300),
    description: 'd'.repeat(700),
    transcript: 'x'.repeat(5000),
  });
  const user = payload.messages[1].content;
  assert.ok(user.includes('t'.repeat(200)));
  assert.ok(!user.includes('t'.repeat(300)));
  assert.ok(user.includes('d'.repeat(600)));
  assert.ok(user.includes('x'.repeat(3000)));   // 字幕截断前 3000 字符
  assert.ok(!user.includes('x'.repeat(5000)));
  assert.equal(payload.temperature, 0);
  assert.equal(payload.stream, false);
});

test('normalizeSummary 解析标准 JSON', () => {
  const parsed = normalizeSummary('{"summary":"测试摘要","key_points":["要点1","要点2"]}');
  assert.deepEqual(parsed, { summary: '测试摘要', key_points: ['要点1', '要点2'] });
});

test('normalizeSummary 容忍 markdown 代码块与前后多余文字', () => {
  const parsed = normalizeSummary('```json\n{"summary":"摘要","key_points":["要点"]}\n```');
  assert.deepEqual(parsed, { summary: '摘要', key_points: ['要点'] });
  const parsed2 = normalizeSummary('好的，这是总结：{"summary":"摘要"}末尾');
  assert.deepEqual(parsed2, { summary: '摘要', key_points: [] });
});

test('normalizeSummary 过滤空要点，缺 summary 返回 null', () => {
  assert.deepEqual(normalizeSummary('{"summary":"摘要","key_points":["a","","b"]}'), {
    summary: '摘要', key_points: ['a', 'b'],
  });
  assert.equal(normalizeSummary('{"key_points":["a"]}'), null);       // 无 summary
  assert.equal(normalizeSummary('不是 JSON'), null);
  assert.equal(normalizeSummary(''), null);
});

// ── 第 2 组：summarizeWithDeepSeek 降级语义 ─────────────────

test('summarizeWithDeepSeek 缺 key：resolve 降级不 reject', async () => {
  const result = await summarizeWithDeepSeek({ title: 't' }, { apiKey: '' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_api_key');
});

test('summarizeWithDeepSeek 网络失败：resolve 降级', async () => {
  const result = await summarizeWithDeepSeek({ title: 't' }, {
    apiKey: 'key',
    fetchImpl: mockFetch(() => { throw new Error('network down'); }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'network_error');
});

test('summarizeWithDeepSeek 输出无法解析：invalid_summary', async () => {
  const result = await summarizeWithDeepSeek({ title: 't' }, {
    apiKey: 'key',
    fetchImpl: mockFetch(() => deepSeekOk('我不懂你在说什么')),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_summary');
});

test('summarizeWithExternalDeepSeek 使用外部 Responses endpoint，不经过本地模型门禁', async () => {
  let endpoint = '';
  let requestBody = null;
  const result = await summarizeWithExternalDeepSeek({ title: '字幕标题', description: '视频描述', transcript: '字幕内容' }, {
    apiKey: 'key',
    fetchImpl: async (url, options) => {
      endpoint = String(url);
      requestBody = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ output_text: '{"summary":"外部摘要","key_points":["外部要点"]}' }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary, '外部摘要');
  assert.equal(endpoint, 'https://api.deepseek.com/responses');
  assert.equal(requestBody.model, 'deepseek-chat');
  assert.equal(requestBody.reasoning.effort, 'none');
  assert.equal(requestBody.text.format.type, 'json_object');
  assert.equal(requestBody.input[0].role, 'user');
});

// ── 第 3 组：collectSummarySource / summarizeCandidate ──────

test('collectSummarySource 提取标题/描述/字幕（字幕支持对象或字符串）', () => {
  assert.deepEqual(collectSummarySource({ title: 't', description: 'd', transcript: { text: '字幕' } }), {
    title: 't', description: 'd', transcript: '字幕',
  });
  assert.deepEqual(collectSummarySource({ title: 't', transcript: '字幕文本' }), {
    title: 't', description: '', transcript: '字幕文本',
  });
  assert.deepEqual(collectSummarySource({ title: 't' }), { title: 't', description: '', transcript: null });
  assert.deepEqual(collectSummarySource({ transcript: { text: '' } }), { title: '', description: '', transcript: null });
});

test('summarizeCandidate 无素材：返回 no_source 不调 LLM', async () => {
  let calls = 0;
  const result = await summarizeCandidate({}, {
    fetchImpl: mockFetch(() => { calls += 1; return deepSeekOk('{}'); }),
  });
  assert.equal(result.summary, null);
  assert.equal(result.llm_error, 'no_source');
  assert.equal(calls, 0);
});

test('summarizeCandidate 成功：含字幕输入，记录 summarizer/input_chars', async () => {
  const result = await summarizeCandidate({
    title: '标题', description: '描述', transcript: { text: '这是视频字幕内容' },
  }, {
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"summary":"摘要","key_points":["要点"]}')),
  });
  assert.equal(result.summary, '摘要');
  assert.deepEqual(result.key_points, ['要点']);
  assert.equal(result.summarizer, 'llm_deepseek');
  assert.ok(result.generated_at);
  assert.equal(result.input_chars, '标题'.length + '描述'.length + '这是视频字幕内容'.length);
  assert.equal(result.llm_error, null);
});

test('summarizeCandidate 失败：summary 置 null、summarizer=llm_failed、llm_error 有值', async () => {
  const result = await summarizeCandidate({ title: '标题', description: '描述' }, {
    fetchImpl: mockFetch(() => deepSeekOk('无法解析')),
  });
  assert.equal(result.summary, null);
  assert.deepEqual(result.key_points, []);
  assert.equal(result.summarizer, 'llm_failed');
  assert.ok(result.llm_error);
});

// ── 第 4 组：summarizeCandidates 批量 ───────────────────────

test('summarizeCandidates：批量成功写入建议字段', async () => {
  const items = [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ];
  const result = await summarizeCandidates(items, {
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"summary":"摘要","key_points":["要点"]}')),
  });
  assert.equal(result.summarized, 2);
  assert.equal(result.skipped, 0);
  assert.equal(items[0].summary, '摘要');
  assert.equal(items[1].summary, '摘要');
  assert.equal(items[0].summarizer, 'llm_deepseek');
});

test('summarizeCandidates：跳过已有 summary 与无素材条目', async () => {
  const items = [
    { id: 'has', title: '已有', summary: '既有总结' },
    { id: 'empty', title: '' },
    { id: 'new', title: '新条目' },
  ];
  const result = await summarizeCandidates(items, {
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"summary":"新总结"}')),
  });
  assert.equal(result.summarized, 1);
  assert.equal(result.skipped, 2);
  assert.equal(items[0].summary, '既有总结');       // 不覆盖已有
  assert.equal(items[1].summary, undefined);
  assert.equal(items[2].summary, '新总结');
});

test('summarizeCandidates：LLM 全失败时 summarized=0 且不写 summary', async () => {
  const items = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
  const result = await summarizeCandidates(items, {
    fetchImpl: mockFetch(() => deepSeekOk('bad output')),
  });
  assert.equal(result.summarized, 0);
  assert.equal(items[0].summary, undefined);
  assert.equal(items[0].summarizer, 'llm_failed');
  assert.ok(items[0].summary_llm_error);
});

// ── 第 5 组：enrichCandidateSummaries 管线钩子 ───────────────

function enrichStore(candidates) {
  return { schema_version: 1, updated_at: null, candidates };
}

test('enrichCandidateSummaries 开关关闭：不调用 LLM', async () => {
  let calls = 0;
  const store = enrichStore([{ id: 'a', title: 'A' }]);
  const counts = await enrichCandidateSummaries(store, ['a'], {
    enabled: false,
    fetchImpl: mockFetch(() => { calls += 1; return deepSeekOk('{}'); }),
  });
  assert.deepEqual(counts, { enabled: false, summarized: 0, skipped: 0 });
  assert.equal(calls, 0);
});

test('enrichCandidateSummaries 开启：只处理 activeIds 内无 summary 的候选', async () => {
  const store = enrichStore([
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B', summary: '已有' },
    { id: 'outside', title: '不在本轮' },
  ]);
  const counts = await enrichCandidateSummaries(store, ['a', 'b'], {
    enabled: true,
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"summary":"总结A"}')),
  });
  // 只处理 a：b（已有 summary）与 outside（不在 activeIds）在 enrich 的 filter 层
  // 被排除，不进入 summarizeCandidates，因此不计入 skipped。
  assert.equal(counts.summarized, 1);
  assert.equal(counts.skipped, 0);
  assert.equal(store.candidates.find(item => item.id === 'a').summary, '总结A');
  assert.equal(store.candidates.find(item => item.id === 'b').summary, '已有');       // 保留
  assert.equal(store.candidates.find(item => item.id === 'outside').summary, undefined);
});

test('enrichCandidateSummaries 受 maxItems 截断', async () => {
  const store = enrichStore([
    { id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' },
  ]);
  const counts = await enrichCandidateSummaries(store, ['a', 'b', 'c'], {
    enabled: true,
    maxItems: 2,
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"summary":"总结"}')),
  });
  assert.equal(counts.summarized, 2);
  const summarizedCount = store.candidates.filter(item => item.summary).length;
  assert.equal(summarizedCount, 2);
});

// ── 第 6 组：mergeCandidatesMin 保留既有审核结论（重新采集不重置）──

test('mergeCandidatesMin 保留既有 review_status，重新采集不重置人工结论', () => {
  const prev = { schema_version: 1, updated_at: null, candidates: [
    { id: 'a', title: '旧', summary: '旧总结', review_status: 'approved', top_selected: true },
  ] };
  // 下一轮 incoming 无 review_status（本轮未重新审核）→ 保留既有 approved
  const store1 = mergeCandidatesMin(prev, [{ id: 'a', title: '新标题' }]);
  assert.equal(store1.candidates[0].review_status, 'approved');
  assert.equal(store1.candidates[0].top_selected, true);
});
