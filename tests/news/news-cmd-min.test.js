/**
 * news-cmd-min.test.js — min-review 命令组（cmd-min.js）纯逻辑测试
 *
 * 覆盖：
 *   1. hasYouTubeInLastRun：按用户拍板语义「YouTube 实际采到内容 items>0 才算有」——
 *      not_run / failed / items=0 / 缺失 均视为无（分时采集下 X 日 top10、YouTube+X 日 top15）；
 *   2. resolveAiTopConfig：ai-top 的 YouTube 判定 + top N 解析——无 approved → no_approved、
 *      last-run 缺失 → no_last_run（命令层据此抛错，供 bat/apply-review.bat errorlevel
 *      判定）；last-run 有/无 YouTube 内容分别解析出 topN 15/10。
 *   3. applyTopSelectedList：读 top 清单应用 top_selected=true 写回候选层——false/未标跳过、
 *      无 id 旧产物抛错、未命中报告 missing（供 bat/apply-top.bat 第 1 步）。
 *
 * 纯函数测试，不写真实数据文件（min-candidates.json 由 news-pipeline-min.test.js 独占，
 * 避免 node --test 并行 worker 的 Windows rename 冲突）。
 *
 * 运行方式：node --test tests/news/news-cmd-min.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasYouTubeInLastRun,
  resolveAiTopConfig,
  applyTopSelectedList,
  applyRefineKeywords,
} = require('../../src/news/cli/cmd-min');

// 固定配置（不依赖真实配置文件，保证 topN 断言确定性）
const CONFIG = { collection: { review_top_with_youtube: 15, review_top_pure_x: 10 } };
const APPROVED = [{ id: 'x-1', platform: 'x', review_status: 'approved', final_score: 10 }];

// ── hasYouTubeInLastRun：YouTube 实际采到内容（items > 0）才算有 ──

test('hasYouTubeInLastRun：youtube items>0 → true', () => {
  assert.equal(hasYouTubeInLastRun({ collectors: { youtube: { status: 'success', items: 5 } } }), true);
  assert.equal(hasYouTubeInLastRun({ collectors: { youtube: { items: '8' } } }), true, '字符串数字也按数值判定');
});

test('hasYouTubeInLastRun：youtube 未采到内容 → false', () => {
  assert.equal(hasYouTubeInLastRun({ collectors: { youtube: { status: 'not_run', items: 0 } } }), false);
  assert.equal(hasYouTubeInLastRun({ collectors: { youtube: { status: 'failed', items: 0, error: 'timeout' } } }), false);
  assert.equal(hasYouTubeInLastRun({ collectors: { youtube: { status: 'success', items: 0 } } }), false);
});

test('hasYouTubeInLastRun：last-run 缺失/结构不完整 → false', () => {
  assert.equal(hasYouTubeInLastRun(null), false);
  assert.equal(hasYouTubeInLastRun(undefined), false);
  assert.equal(hasYouTubeInLastRun({}), false);
  assert.equal(hasYouTubeInLastRun({ collectors: {} }), false);
});

// ── resolveAiTopConfig：ai-top 的判定与 top N 解析 ──

test('resolveAiTopConfig：无 approved 候选 → no_approved', () => {
  assert.deepEqual(resolveAiTopConfig([], null, CONFIG), { ok: false, reason: 'no_approved' });
  assert.deepEqual(resolveAiTopConfig(undefined, null, CONFIG), { ok: false, reason: 'no_approved' });
});

test('resolveAiTopConfig：last-run 缺失 → no_last_run', () => {
  assert.deepEqual(resolveAiTopConfig(APPROVED, null, CONFIG), { ok: false, reason: 'no_last_run' });
  assert.deepEqual(resolveAiTopConfig(APPROVED, undefined, CONFIG), { ok: false, reason: 'no_last_run' });
});

test('resolveAiTopConfig：YouTube 实际采到内容 → topN 15', () => {
  const lastRun = { collectors: { youtube: { status: 'success', items: 3 }, x: { status: 'success', items: 20 } } };
  assert.deepEqual(resolveAiTopConfig(APPROVED, lastRun, CONFIG), { ok: true, hasYouTube: true, topN: 15 });
});

test('resolveAiTopConfig：无 YouTube 内容（X 日）→ topN 10', () => {
  // not_run / failed / items=0 三种无 YouTube 语义都落到 topN 10
  for (const youtube of [
    { status: 'not_run', items: 0 },
    { status: 'failed', items: 0, error: 'timeout' },
    { status: 'success', items: 0 },
  ]) {
    const lastRun = { collectors: { youtube, x: { status: 'success', items: 20 } } };
    assert.deepEqual(resolveAiTopConfig(APPROVED, lastRun, CONFIG), { ok: true, hasYouTube: false, topN: 10 }, `youtube=${youtube.status}`);
  }
});

test('resolveAiTopConfig：配置缺字段 → 回退默认 15/10', () => {
  const cfg = { collection: {} };
  const withYt = { collectors: { youtube: { items: 1 } } };
  const withoutYt = { collectors: { youtube: { items: 0 } } };
  assert.equal(resolveAiTopConfig(APPROVED, withYt, cfg).topN, 15);
  assert.equal(resolveAiTopConfig(APPROVED, withoutYt, cfg).topN, 10);
});

// ── applyTopSelectedList：top 清单 top_selected=true → 写回候选层 ──

test('applyTopSelectedList：top_selected=true 批量应用，false 跳过，幂等保留既有', () => {
  const store = {
    schema_version: 1, updated_at: null,
    candidates: [
      { id: 'x-1', top_selected: false },
      { id: 'x-2', top_selected: false },
      { id: 'x-3', top_selected: true },
    ],
  };
  const list = {
    kind: 'ai_top_candidates',
    candidates: [
      { id: 'x-1', top_selected: true },
      { id: 'x-2', top_selected: false },
    ],
  };
  const result = applyTopSelectedList(store, list);
  assert.equal(result.applied, 1);
  assert.deepEqual(result.selectedIds, ['x-1']);
  assert.equal(result.store.candidates.find(c => c.id === 'x-1').top_selected, true);
  assert.equal(result.store.candidates.find(c => c.id === 'x-2').top_selected, false, 'false 不动作');
  assert.equal(result.store.candidates.find(c => c.id === 'x-3').top_selected, true, '既有 true 保留');
});

test('applyTopSelectedList：top_selected=true 但无 id → 抛错拒绝旧产物', () => {
  const store = { schema_version: 1, updated_at: null, candidates: [] };
  const list = { kind: 'ai_top_candidates', candidates: [{ summary: '旧产物无 id', top_selected: true }] };
  assert.throws(() => applyTopSelectedList(store, list), /无 id 的条目/);
});

test('applyTopSelectedList：无 top_selected=true → changed 0；未命中 id 报告 missing', () => {
  const store = { schema_version: 1, updated_at: null, candidates: [{ id: 'x-1', top_selected: false }] };
  const listNone = { kind: 'ai_top_candidates', candidates: [{ id: 'x-1', top_selected: false }] };
  assert.equal(applyTopSelectedList(store, listNone).changed, 0, '无 true 条目不写回');
  const listGhost = { kind: 'ai_top_candidates', candidates: [{ id: 'x-ghost', top_selected: true }] };
  const r2 = applyTopSelectedList(store, listGhost);
  assert.equal(r2.applied, 0);
  assert.deepEqual(r2.missing, ['x-ghost']);
});

// ── applyRefineKeywords：纯内存配置更新，不触碰正式配置文件 ──

const KEYWORD_LIST = {
  kind: 'keyword_refine_candidates',
  candidates: [
    { word: 'DeepSeek', category: 'tool', candidate_type: 'repeated', count: 6 },
    { word: 'Multimodal', category: 'concept', candidate_type: 'emerging', count: 2 },
  ],
  adopted_keywords: ['DeepSeek', 'DeepSeek', 'Multimodal'],
};

test('applyRefineKeywords：去重采纳并跳过既有关键词', () => {
  const config = { keywords: { ai_keywords: ['deepseek', 'Claude'] } };
  const result = applyRefineKeywords(config, KEYWORD_LIST);
  assert.deepEqual(result.added, ['Multimodal']);
  assert.deepEqual(result.already_exists, ['DeepSeek']);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.config.keywords.ai_keywords, ['deepseek', 'Claude', 'Multimodal']);
  assert.deepEqual(config.keywords.ai_keywords, ['deepseek', 'Claude'], '不修改输入配置');
  assert.equal(applyRefineKeywords(result.config, KEYWORD_LIST).changed, false, '重复应用幂等');
});

test('applyRefineKeywords：未知采纳词或结构非法时整批拒绝', () => {
  const config = { keywords: { ai_keywords: [] } };
  assert.throws(() => applyRefineKeywords(config, { ...KEYWORD_LIST, adopted_keywords: ['Unknown'] }), /不在 candidates/);
  assert.throws(() => applyRefineKeywords(config, { ...KEYWORD_LIST, adopted_keywords: null }), /非法关键词清单/);
  assert.throws(() => applyRefineKeywords(config, {
    ...KEYWORD_LIST,
    candidates: [{ word: 'Broken', category: '', candidate_type: 'repeated', count: 1 }],
    adopted_keywords: [],
  }), /非法 candidates/);
  assert.deepEqual(config.keywords.ai_keywords, [], '拒绝不改变输入配置');
});

test('applyRefineKeywords：空采纳列表成功且不要求写回', () => {
  const result = applyRefineKeywords({ keywords: { ai_keywords: ['Claude'] } }, { ...KEYWORD_LIST, adopted_keywords: [] });
  assert.equal(result.changed, false);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.config.keywords.ai_keywords, ['Claude']);
});
