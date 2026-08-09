/**
 * news-reviewer.test.js — AI 审核建议器测试（content-reviewer）
 *
 * 测试原理：
 *   不请求真实网络，注入 mock fetchImpl 验证：
 *     1. buildReviewPayload 输入裁剪（title/desc/transcript/summary）与占位符替换；
 *     2. normalizeReview 解析模型输出的 JSON 容错（中文 verdict / confidence 置 0）；
 *     3. reviewWithDeepSeek 成功/缺 key/网络失败/输出无法解析降级；
 *     4. reviewCandidate 成功（含字幕/总结）/失败降级/无素材；
 *     5. reviewCandidates 批量、跳过已有 ai_review；
 *     6. mergeCandidatesMin 保留既有审核结论（重新采集不重置人工结论）。
 *
 * 运行方式：node --test tests/news/news-reviewer.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildReviewPayload,
  normalizeReview,
  reviewWithDeepSeek,
} = require('../../src/news/classify/llm-provider');
const {
  collectReviewSource,
  reviewCandidate,
  reviewCandidates,
} = require('../../src/news/classify/content-reviewer');
const { mergeCandidatesMin } = require('../../src/news/min/min-store');
const { applyL1Verdicts } = require('../../src/news/min/review-v2');

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

// ── 第 1 组：buildReviewPayload / normalizeReview（llm-provider）────

test('buildReviewPayload 裁剪标题/描述/字幕/总结并替换占位符', () => {
  const payload = buildReviewPayload({
    title: 't'.repeat(300),
    description: 'd'.repeat(700),
    transcript: 'x'.repeat(5000),
    summary: 's'.repeat(900),
  });
  const user = payload.messages[1].content;
  assert.ok(user.includes('t'.repeat(200)));
  assert.ok(!user.includes('t'.repeat(300)));
  assert.ok(user.includes('d'.repeat(600)));
  assert.ok(user.includes('x'.repeat(3000)));   // 字幕截断前 3000 字符
  assert.ok(!user.includes('x'.repeat(5000)));
  assert.ok(user.includes('s'.repeat(800)));    // 总结截断前 800 字符
  assert.ok(!user.includes('s'.repeat(900)));
  assert.equal(payload.temperature, 0);
  assert.equal(payload.stream, false);
});

test('buildReviewPayload 缺素材时占位符填空（无总结）', () => {
  const user = buildReviewPayload({ title: '标题' }).messages[1].content;
  assert.ok(user.includes('标题'));
  assert.ok(user.includes('（无描述）'));
  assert.ok(user.includes('（无字幕）'));
  assert.ok(user.includes('（无总结）'));
});

test('normalizeReview 解析标准 JSON', () => {
  const parsed = normalizeReview('{"verdict":"discard","reasons":["非 AI 主题","广告内容"],"confidence":0.95}');
  assert.deepEqual(parsed, { verdict: 'discard', reasons: ['非 AI 主题', '广告内容'], confidence: 0.95 });
});

test('normalizeReview 容忍 markdown 代码块与前后多余文字', () => {
  const parsed = normalizeReview('```json\n{"verdict":"hold","reasons":["信息不全"]}\n```');
  assert.deepEqual(parsed, { verdict: 'hold', reasons: ['信息不全'], confidence: 0 });
  const parsed2 = normalizeReview('好的，这是审核结果：{"verdict":"approve","confidence":0.8}末尾');
  assert.deepEqual(parsed2, { verdict: 'approve', reasons: [], confidence: 0.8 });
});

test('normalizeReview 中文 verdict 映射、空 reasons 过滤、confidence 置 0', () => {
  assert.equal(normalizeReview('{"verdict":"丢弃","reasons":["a","","b"]}').verdict, 'discard');
  assert.deepEqual(normalizeReview('{"verdict":"挂起","reasons":["a"]}').verdict, 'hold');
  assert.deepEqual(normalizeReview('{"verdict":"通过"}').verdict, 'approve');
  const withEmpty = normalizeReview('{"verdict":"approve","reasons":["",null,"  "]}');
  assert.deepEqual(withEmpty.reasons, []);
  assert.equal(withEmpty.confidence, 0);        // confidence 缺省 → 0（安全默认）
});

test('normalizeReview 非法/越界 confidence 钳制到 0-1，非法 verdict 返回 null', () => {
  assert.equal(normalizeReview('{"verdict":"approve","confidence":1.5}').confidence, 1);
  assert.equal(normalizeReview('{"verdict":"approve","confidence":-0.2}').confidence, 0);
  assert.equal(normalizeReview('{"verdict":"approve","confidence":"high"}').confidence, 0);
  assert.equal(normalizeReview('{"verdict":"maybe","confidence":0.9}'), null);   // 非法 verdict
  assert.equal(normalizeReview('不是 JSON'), null);
  assert.equal(normalizeReview(''), null);
});

// ── 第 2 组：reviewWithDeepSeek 降级语义 ─────────────────

test('reviewWithDeepSeek 缺 key：resolve 降级不 reject', async () => {
  const result = await reviewWithDeepSeek({ title: 't' }, { apiKey: '' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_api_key');
});

test('reviewWithDeepSeek 网络失败：resolve 降级', async () => {
  const result = await reviewWithDeepSeek({ title: 't' }, {
    apiKey: 'key',
    fetchImpl: mockFetch(() => { throw new Error('network down'); }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'network_error');
});

test('reviewWithDeepSeek 输出无法解析：invalid_review', async () => {
  const result = await reviewWithDeepSeek({ title: 't' }, {
    apiKey: 'key',
    fetchImpl: mockFetch(() => deepSeekOk('我不懂你在说什么')),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_review');
});

test('reviewWithDeepSeek 成功：返回 verdict + reasons + confidence', async () => {
  const result = await reviewWithDeepSeek({ title: 't', summary: 's' }, {
    apiKey: 'key',
    fetchImpl: mockFetch(() => deepSeekOk('{"verdict":"discard","reasons":["广告"],"confidence":0.9}')),
  });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'discard');
  assert.deepEqual(result.reasons, ['广告']);
  assert.equal(result.confidence, 0.9);
});

// ── 第 3 组：collectReviewSource / reviewCandidate ──────

test('collectReviewSource 提取标题/描述/字幕/总结（字幕支持对象或字符串）', () => {
  assert.deepEqual(collectReviewSource({ title: 't', description: 'd', transcript: { text: '字幕' }, summary: '总结' }), {
    title: 't', description: 'd', transcript: '字幕', summary: '总结',
  });
  assert.deepEqual(collectReviewSource({ title: 't', transcript: '字幕文本' }), {
    title: 't', description: '', transcript: '字幕文本', summary: null,
  });
  assert.deepEqual(collectReviewSource({ title: 't' }), { title: 't', description: '', transcript: null, summary: null });
});

test('reviewCandidate 无素材：返回 no_source 不调 LLM', async () => {
  let calls = 0;
  const result = await reviewCandidate({}, {
    fetchImpl: mockFetch(() => { calls += 1; return deepSeekOk('{}'); }),
  });
  assert.equal(result.verdict, null);
  assert.equal(result.llm_error, 'no_source');
  assert.equal(calls, 0);
});

test('reviewCandidate 成功：含字幕/总结输入，记录 reviewer/input_chars', async () => {
  const result = await reviewCandidate({
    title: '标题', description: '描述', transcript: { text: '字幕' }, summary: '总结',
  }, {
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"verdict":"approve","reasons":["有实质信息"],"confidence":0.9}')),
  });
  assert.equal(result.verdict, 'approve');
  assert.deepEqual(result.reasons, ['有实质信息']);
  assert.equal(result.reviewer, 'llm_deepseek');
  assert.ok(result.generated_at);
  assert.equal(result.input_chars, '标题'.length + '描述'.length + '字幕'.length + '总结'.length);
  assert.equal(result.llm_error, null);
});

test('reviewCandidate 失败：verdict 置 null、reviewer=llm_failed、llm_error 有值', async () => {
  const result = await reviewCandidate({ title: '标题', description: '描述' }, {
    fetchImpl: mockFetch(() => deepSeekOk('无法解析')),
  });
  assert.equal(result.verdict, null);
  assert.equal(result.reviewer, 'llm_failed');
  assert.ok(result.llm_error);
});

// ── 第 4 组：reviewCandidates 批量 ───────────────────────

test('reviewCandidates：批量成功写入 ai_review 建议', async () => {
  const items = [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ];
  const result = await reviewCandidates(items, {
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"verdict":"approve","reasons":["相关"],"confidence":0.9}')),
  });
  assert.equal(result.reviewed, 2);
  assert.equal(result.skipped, 0);
  assert.equal(items[0].ai_review.verdict, 'approve');
  assert.equal(items[1].ai_review.verdict, 'approve');
  assert.equal(items[0].ai_review_llm_error, null);
});

test('reviewCandidates：跳过已有 ai_review 与无素材条目', async () => {
  const items = [
    { id: 'has', title: '已有', ai_review: { verdict: 'hold' } },
    { id: 'empty', title: '' },
    { id: 'new', title: '新条目' },
  ];
  const result = await reviewCandidates(items, {
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"verdict":"approve","confidence":0.9}')),
  });
  assert.equal(result.reviewed, 1);
  assert.equal(result.skipped, 2);
  assert.equal(items[0].ai_review.verdict, 'hold');       // 不覆盖已有
  assert.equal(items[1].ai_review, undefined);
  assert.equal(items[2].ai_review.verdict, 'approve');
});

test('reviewCandidates：LLM 全失败时 reviewed=0 且不写 ai_review（不误杀）', async () => {
  const items = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
  const result = await reviewCandidates(items, {
    fetchImpl: mockFetch(() => deepSeekOk('bad output')),
  });
  assert.equal(result.reviewed, 0);
  assert.equal(items[0].ai_review, undefined);            // 不写建议
  assert.ok(items[0].ai_review_llm_error);                // 留错误痕迹便于排查
});

test('L1 高置信 approve/discard 自动分流，自动项不调用 L2 且不保留 reasons', async () => {
  let calls = 0;
  const items = [
    { id: 'approve', title: 'AI 产品发布', url: 'https://example.com/a', published_at: '2026-08-09T00:00:00Z', description: 'AI tool release' },
    { id: 'discard', title: 'AI 内容', url: 'https://example.com/d', published_at: '2026-08-09T00:00:00Z', description: 'AI topic is unrelated to the product' },
    { id: 'hold', title: 'AI 存疑内容', url: 'https://example.com/h', published_at: '2026-08-09T00:00:00Z', description: 'AI topic unclear' },
  ];
  const verdicts = { approve: { verdict: 'approve', confidence: 0.9, reasons: ['不应保留'] }, discard: { verdict: 'discard', confidence: 0.95, reasons: ['不应保留'] }, hold: { verdict: 'hold', confidence: 0.6, reasons: ['需要人工确认'] } };
  const result = await applyL1Verdicts(items, {
    keywords: { ai_keywords: ['ai'] },
    collection: { concurrency: 1 },
    review: { l1_confidence_auto_approve: 0.85, l1_confidence_auto_discard: 0.9, l2_enabled: true },
  }, {
    reviewCandidate: async item => { calls += 1; return verdicts[item.id]; },
  });
  const byId = new Map([...result.kept, ...result.discarded].map(item => [item.id, item]));
  assert.equal(byId.get('approve').review_status, 'approved');
  assert.equal(byId.get('discard').review_status, 'discarded');
  assert.equal(byId.get('hold').review_status, 'pending');
  assert.deepEqual(byId.get('approve').l1_review.reasons, []);
  assert.deepEqual(byId.get('discard').l1_review.reasons, []);
  assert.equal(calls, 4, 'L1 3 次 + pending 的 L2 1 次');
});


test('mergeCandidatesMin 保留既有 review_status，重新采集不重置人工结论', () => {
  const prev = { schema_version: 1, updated_at: null, candidates: [
    { id: 'a', title: '旧', review_status: 'approved', top_selected: true, ai_advice: { verdict: 'approve', reasons: ['人工确认'] } },
  ] };
  // 下一轮 incoming 无 review_status（本轮未重新审核）→ 保留既有 approved
  const store1 = mergeCandidatesMin(prev, [{ id: 'a', title: '新标题' }]);
  assert.equal(store1.candidates[0].review_status, 'approved');
  assert.equal(store1.candidates[0].top_selected, true);
});
