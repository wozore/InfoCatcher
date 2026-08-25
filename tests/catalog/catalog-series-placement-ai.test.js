'use strict';

/**
 * catalog-series-placement-ai.test.js —— 二级系列 AI 分类 Adapter 回归（阶段 4）
 *
 * 覆盖：
 *   - prompt 构建不泄露密钥、输入字段白名单、指令禁止跨用途；
 *   - validateSeriesPlacementValue 结构校验；
 *   - suggestSeriesPlacement 缺 ledger fail-closed；
 *   - resolveSeriesPlacement 各分支：
 *       人工 placement 最高优先（合法 → manual；非法 → fail_closed）；
 *       政策覆盖的通用 LLM 确定性判定（existing / create，零 AI）；
 *       专用/无政策厂商 not_applicable（不改 seed）；
 *       第 4 个成员触发 migration_required；
 *       needs_ai 未放行 → fail_closed；放行 + AI hint → decision(ai)；
 *       AI 冲突/未确认 → fail_closed；
 *   - applyPlacementToSeed：existing → existing_level2_ref；create → group_key + new_group_title。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emptySnapshot } = require('../../src/catalog/catalog-contract');
const { loadSeriesPolicy } = require('../../src/catalog/catalog-series-policy');
const {
  buildSeriesPlacementInput,
  buildSeriesPlacementInstructions,
  validateSeriesPlacementValue,
  suggestSeriesPlacement,
  resolveSeriesPlacement,
  applyPlacementToSeed,
} = require('../../src/catalog/ai/catalog-series-placement-ai');

function candidate(overrides = {}) {
  return {
    detail_kind: 'api_model',
    name: 'GLM-5.4',
    vendor_name: '智谱',
    vendor_key: 'zhipu',
    official_url: 'https://docs.z.ai/guides/llm/glm-5',
    ...overrides,
  };
}

function snapshot() {
  const snap = emptySnapshot();
  snap['vendor-level1'].push({ id: 'vendor-level1:zhipu', vendor_key: 'zhipu', level2_refs: [] });
  snap['vendor-level2'].push({
    id: 'vendor-level2:zhipu:glm', vendor_key: 'zhipu', title: 'GLM 5', status: 'active',
    detail_refs: ['glm-5.1', 'glm-5.2', 'glm-5-3'].map(id => ({ kind: 'tool-level3', id: `tool-level3:${id}` })),
  });
  snap['tool-level3'].push(
    { id: 'tool-level3:glm-5.1', vendor_key: 'zhipu', detail_kind: 'api_model', theme: 'general' },
    { id: 'tool-level3:glm-5.2', vendor_key: 'zhipu', detail_kind: 'api_model', theme: 'general' },
    { id: 'tool-level3:glm-5-3', vendor_key: 'zhipu', detail_kind: 'api_model', theme: 'general' },
  );
  return snap;
}

// ── 1. prompt 构建 ──────────────────────────────────────────────

test('buildSeriesPlacementInput 字段白名单，不含密钥/正文', () => {
  const policy = loadSeriesPolicy();
  const input = buildSeriesPlacementInput({ candidate: candidate(), policy, currentSeries: [] });
  const raw = JSON.stringify(input);
  assert.match(raw, /GLM-5\.4/);
  assert.doesNotMatch(raw, /api[_-]?key|DEEPSEEK|TAVILY|sk-|Authorization/i);
  assert.ok(input.candidate && typeof input.candidate.name === 'string');
  assert.ok(input.policy_scope && Array.isArray(input.policy_scope.families));
  assert.ok(input.policy_scope.families.some(f => f.family === 'glm' && f.usage_kind === 'general_llm'));
});

test('buildSeriesPlacementInstructions 禁止把专用当通用、禁止编造 URL', () => {
  const instructions = buildSeriesPlacementInstructions();
  assert.match(instructions, /general_llm/);
  assert.match(instructions, /禁止把专用模型当 general_llm/);
  assert.match(instructions, /不许编造 URL/);
  assert.match(instructions, /canonical_family/);
});

test('validateSeriesPlacementValue 结构校验', () => {
  assert.equal(validateSeriesPlacementValue({ usage_kind: 'general_llm', modality: 'text', canonical_vendor_key: 'zhipu', canonical_family: 'glm', major_line: 'glm5', release_cohort: 'newest', confidence: 0.9, rationale: 'x' }), true);
  assert.equal(validateSeriesPlacementValue(null), false);
  assert.equal(validateSeriesPlacementValue({ usage_kind: 5 }), false);
  assert.equal(validateSeriesPlacementValue({ usage_kind: 'general_llm', confidence: 1.5 }), false);
});

// ── 2. suggestSeriesPlacement：缺 ledger fail-closed ────────────

test('suggestSeriesPlacement 缺 ledger → COST_LEDGER_REQUIRED（fail-closed）', async () => {
  const result = await suggestSeriesPlacement({}, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COST_LEDGER_REQUIRED');
});

// ── 3. resolveSeriesPlacement 各分支 ────────────────────────────

test('resolve：人工 placement 合法 → manual（最高优先，不触发 AI）', async () => {
  const policy = loadSeriesPolicy();
  const snap = snapshot();
  const c = candidate({ placement: { existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:zhipu:glm' } } });
  const result = await resolveSeriesPlacement(policy, snap, c, { allowAi: true });
  assert.equal(result.kind, 'manual');
  assert.equal(result.target_level2_id, 'vendor-level2:zhipu:glm');
});

test('resolve：人工 placement 非法（vendor 不匹配）→ fail_closed', async () => {
  const policy = loadSeriesPolicy();
  const snap = snapshot();
  const c = candidate({ placement: { existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:openai:gpt-5.6' } } });
  const result = await resolveSeriesPlacement(policy, snap, c, { allowAi: true });
  assert.equal(result.kind, 'fail_closed');
  assert.equal(result.code, 'PLACEMENT_REF_INVALID');
});

test('resolve：政策覆盖的通用 LLM 确定性判定（零 AI）→ decision', async () => {
  const policy = loadSeriesPolicy();
  const snap = snapshot();
  // 加入一个已有的 openai:gpt-5.6，让新 GPT 候选走 existing
  const cohereSnap = emptySnapshot();
  cohereSnap['vendor-level2'].push({
    id: 'vendor-level2:cohere:command', vendor_key: 'cohere', title: 'Command 模型', status: 'active',
    detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:command-a' }],
  });
  const c = candidate({ vendor_key: 'cohere', vendor_name: 'Cohere', name: 'Command B' });
  const result = await resolveSeriesPlacement(policy, cohereSnap, c, { allowAi: true });
  assert.equal(result.kind, 'decision');
  assert.equal(result.target_mode, 'existing');
  assert.equal(result.target_level2_id, 'vendor-level2:cohere:command');
  assert.equal(result.source, 'policy');
  assert.equal(result.target_level2_title, 'Command 模型');
});

test('resolve：目标系列未建 → decision create（组 key 取政策稳定段）', async () => {
  const policy = loadSeriesPolicy();
  const snap = emptySnapshot();
  const c = candidate({ vendor_key: 'mistral', vendor_name: 'Mistral', name: 'Mistral Large 4' });
  snap['vendor-level2'].push({ id: 'vendor-level2:mistral:mistral', vendor_key: 'mistral', title: 'Mistral 模型', detail_refs: [] });
  const result = await resolveSeriesPlacement(policy, snap, c, {});
  assert.equal(result.kind, 'decision');
  assert.equal(result.target_mode, 'existing');
});

test('resolve：专用模型（policy pattern 命中）→ not_applicable，不改 seed', async () => {
  const policy = loadSeriesPolicy();
  const result = await resolveSeriesPlacement(policy, emptySnapshot(),
    candidate({ vendor_key: 'openai', name: 'GPT-Realtime-3' }), { allowAi: true });
  assert.equal(result.kind, 'not_applicable');
});

test('resolve：无政策厂商（可灵 Kling）→ not_applicable', async () => {
  const policy = loadSeriesPolicy();
  const result = await resolveSeriesPlacement(policy, emptySnapshot(),
    candidate({ vendor_key: 'kuaishou', name: 'Kling 4.0' }), { allowAi: true });
  assert.equal(result.kind, 'not_applicable');
});

test('resolve：GLM 第 4 个成员 → migration_required（阻断普通 Draft）', async () => {
  const policy = loadSeriesPolicy();
  const result = await resolveSeriesPlacement(policy, snapshot(), candidate({ name: 'GLM-5.4' }), {});
  assert.equal(result.kind, 'migration_required');
  assert.equal(result.family, 'glm');
});

test('resolve：needs_ai 未放行 → fail_closed PLACEMENT_MANUAL_REQUIRED', async () => {
  const policy = loadSeriesPolicy();
  // 某政策厂商但名称完全无法判定用途 → needs_ai；allowAi=false → fail_closed
  const c = candidate({ vendor_key: 'alibaba', vendor_name: '阿里', name: 'X-Futuristic-Model-3000' });
  const snap = emptySnapshot();
  const result = await resolveSeriesPlacement(policy, snap, c, { allowAi: false });
  assert.equal(result.kind, 'fail_closed');
  assert.equal(result.code, 'PLACEMENT_MANUAL_REQUIRED');
});

test('resolve：needs_ai + 放行 + AI hint 正确 → decision(ai)', async () => {
  const policy = loadSeriesPolicy();
  const c = candidate({ vendor_key: 'alibaba', vendor_name: '阿里', name: 'X-Futuristic-Model-3000' });
  const snap = emptySnapshot();
  snap['vendor-level2'].push({ id: 'vendor-level2:alibaba:qwen', vendor_key: 'alibaba', title: 'Qwen 模型', detail_refs: [] });
  const mockSuggest = async () => ({
    ok: true, hint: { usage_kind: 'general_llm', canonical_family: 'qwen', release_cohort: 'newest', confidence: 0.8 },
    usage: {}, raw: {},
  });
  const result = await resolveSeriesPlacement(policy, snap, c, {
    allowAi: true, ledger: { reserve: () => ({ ok: true }) }, suggestPlacement: mockSuggest,
  });
  assert.equal(result.kind, 'decision');
  assert.equal(result.source, 'ai');
  assert.equal(result.target_level2_id, 'vendor-level2:alibaba:qwen');
  assert.equal(result.ai_confidence, 0.8);
});

test('resolve：needs_ai + AI 冲突（无法确认）→ fail_closed', async () => {
  const policy = loadSeriesPolicy();
  const c = candidate({ vendor_key: 'zhipu', vendor_name: '智谱', name: 'Z-Unknown-7' });
  const snap = snapshot(); // zhipu glm 已有 3 成员
  const mockSuggest = async () => ({
    ok: true, hint: { usage_kind: 'unknown', canonical_family: null, release_cohort: null, confidence: 0.3 },
    usage: {}, raw: {},
  });
  const result = await resolveSeriesPlacement(policy, snap, c, {
    allowAi: true, ledger: { reserve: () => ({ ok: true }) }, suggestPlacement: mockSuggest,
  });
  assert.equal(result.kind, 'fail_closed');
  assert.equal(result.code, 'PLACEMENT_AI_NOT_CONFIRMED');
});

test('resolve：AI 调用失败 → fail_closed PLACEMENT_AI_FAILED', async () => {
  const policy = loadSeriesPolicy();
  const c = candidate({ vendor_key: 'alibaba', vendor_name: '阿里', name: 'X-Futuristic-Model-3000' });
  const mockSuggest = async () => ({ ok: false, code: 'DEEPSEEK_ERROR', error: 'boom' });
  const result = await resolveSeriesPlacement(policy, emptySnapshot(), c, {
    allowAi: true, ledger: { reserve: () => ({ ok: true }) }, suggestPlacement: mockSuggest,
  });
  assert.equal(result.kind, 'fail_closed');
  assert.equal(result.code, 'PLACEMENT_AI_FAILED');
});

// ── 4. applyPlacementToSeed ─────────────────────────────────────

test('applyPlacementToSeed：existing → 写 existing_level2_ref；create → group_key + new_group_title', () => {
  const existingSeed = { detail_kind: 'api_model', name: 'X', placement: {} };
  applyPlacementToSeed(existingSeed, {
    kind: 'decision', vendor: 'cohere', target_mode: 'existing',
    target_level2_id: 'vendor-level2:cohere:command', target_level2_title: 'Command 模型',
  });
  assert.deepEqual(existingSeed.placement.existing_level2_ref, { kind: 'vendor-level2', id: 'vendor-level2:cohere:command' });

  const createSeed = { detail_kind: 'api_model', name: 'Y', placement: {} };
  applyPlacementToSeed(createSeed, {
    kind: 'decision', vendor: 'alibaba', target_mode: 'create',
    target_level2_id: 'vendor-level2:alibaba:qwen', target_level2_title: 'Qwen 模型', group_key: 'qwen',
  });
  assert.equal(createSeed.group_key, 'qwen');
  assert.equal(createSeed.placement.new_group_title, 'Qwen 模型');
  assert.equal(createSeed.placement.existing_level2_ref, null);
  assert.deepEqual(createSeed.placement.existing_level1_ref, { kind: 'vendor-level1', id: 'vendor-level1:alibaba' });
});
