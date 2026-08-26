'use strict';

/**
 * catalog-series-migration.test.js —— LLM 二级系列迁移规划器回归（阶段 2）
 *
 * 覆盖：
 *   - 同 id 目标就地改写成员（anthropic newest）
 *   - 全新目标创建（anthropic last）
 *   - 专用改名（openai realtime/image）
 *   - 多碎片合并（xai grok / minimax m / nvidia nemotron-3）
 *   - 同 id 基座的“多余成员”搬家（google gemini → gemini-last）
 *   - 专用/套餐/工具系列零漂移（h3 / imagine / coding-plan / gemini-cli / omni / image）
 *   - 碎片删除（cohere command-a / anthropic claude-opus-5）与 id_map / members_moved
 *   - L1 level2_refs 重写、孤儿为空、既有浮空详情写入 warnings
 *   - 非政策厂商完全不动
 *   - 集成：真实五模块快照迁移后 validateCatalogSnapshot 通过，关键目标系列成员符合政策
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { DIRS } = require('../../src/shared/paths');
const { emptySnapshot } = require('../../src/catalog/catalog-contract');
const { loadSeriesPolicy } = require('../../src/catalog/catalog-series-policy');
const { planSeriesMigration } = require('../../src/catalog/catalog-series-migration');
const { validateCatalogSnapshot } = require('../../src/catalog/catalog-snapshot-validator');

// ── 合成快照构造 helpers ────────────────────────────────────────

function l2(id, vendorKey, title, members, extra = {}) {
  const full = memberId => (memberId.startsWith('tool-level3:') ? memberId : `tool-level3:${memberId}`);
  return {
    id, level1_ref: { kind: 'vendor-level1', id: `vendor-level1:${vendorKey}` },
    vendor_key: vendorKey, title, official_url: 'https://example.com', summary: title, status: 'active',
    detail_refs: members.map(memberId => ({ kind: 'tool-level3', id: full(memberId) })), ...extra,
  };
}
function l1(id, vendorKey, refIds) {
  return { id, vendor_key: vendorKey, title: vendorKey, official_url: 'https://example.com', description: '', status: 'active', features: [], level2_refs: refIds.map(id => ({ kind: 'vendor-level2', id })) };
}
function vc(id, vendorKey) {
  return { id, vendor_key: vendorKey, title: vendorKey, icon: '', summary: '简介', feature_preview: [], access_level: '免费', price_badge: 'unknown', search_terms: [], level1_ref: { kind: 'vendor-level1', id: `vendor-level1:${vendorKey}` } };
}
function detail(id, vendorKey, detailKind = 'api_model', theme = 'general') {
  const record = {
    id, vendor_key: vendorKey, detail_kind: detailKind, theme, title: id, vendor_label: vendorKey, icon: '',
    official_url: 'https://example.com', status: 'active', summary: '', one_m_context: null, api_pricing: null,
    plan: null, applicable_scenarios: [], inapplicable_scenarios: [], sources: [],
  };
  if (detailKind !== 'subscription_plan') record.release_date = '2026-01-01';
  return record;
}
function card(id, vendorKey, detailKind = 'api_model', theme = 'general', detailRefId = id) {
  return {
    id, tool_key: id, vendor_key: vendorKey, title: id, vendor_label: vendorKey, icon: '', summary: '', theme,
    scenes: [], best_for_preview: '', not_for_preview: '', price_badge: 'unknown', access_level: '免费',
    search_terms: [], detail_ref: { kind: 'tool-level3', id: detailRefId }, detail_kind: detailKind,
  };
}

/** 为给定厂商添加完整最小五模块骨架。 */
function addVendor(snapshot, vendorKey, l2s) {
  const fullId = id => (id.startsWith('tool-level3:') ? id : `tool-level3:${id}`);
  const details = l2s.flatMap(x => (x.detail_refs || []).map(ref => fullId(ref.id)));
  const cardId = id => id.replace('tool-level3:', '');
  for (const id of details) {
    const real = detail(id, vendorKey);
    snapshot['tool-level3'].push(real);
    if (real.detail_kind !== 'subscription_plan') snapshot['tool-card'].push(card(cardId(id), vendorKey, 'api_model', 'general', id));
  }
  snapshot['vendor-level2'].push(...l2s);
  snapshot['vendor-level1'].push(l1(`vendor-level1:${vendorKey}`, vendorKey, l2s.map(x => x.id)));
  snapshot['vendor-card'].push(vc(`vendor-card:${vendorKey}`, vendorKey));
}

function syntheticSnapshot() {
  const snap = emptySnapshot();
  addVendor(snap, 'anthropic', [
    l2('vendor-level2:anthropic:claude', 'anthropic', 'Claude 模型', ['claude-fable-5', 'claude-opus-4.8', 'claude-sonnet-5', 'claude-haiku-4.5']),
    l2('vendor-level2:anthropic:claude-opus-5', 'anthropic', 'Claude Opus 5', ['claude-opus-5']),
    l2('vendor-level2:anthropic:claude-coding-plan', 'anthropic', '套餐', ['claude-pro', 'claude-max-5x']),
  ]);
  addVendor(snap, 'openai', [
    l2('vendor-level2:openai:gpt-realtime-2', 'openai', 'GPT-Realtime-2', ['gpt-realtime-2']),
    l2('vendor-level2:openai:gpt-image-2', 'openai', 'gpt-image-2', ['gpt-image-2']),
    l2('vendor-level2:openai:openai-codex', 'openai', 'OpenAI Codex', ['openai-codex']),
  ]);
  addVendor(snap, 'google', [
    l2('vendor-level2:google:gemini', 'google', 'Gemini 模型', ['gemini-3.5-flash', 'gemini-2.5-pro', 'gemini-3-7-flash', 'gemini-3-6-flash']),
    l2('vendor-level2:google:gemini-3-1-pro', 'google', 'Gemini 3.1 Pro', ['gemini-3-1-pro']),
    l2('vendor-level2:google:gemma-4', 'google', 'Gemma 4', ['gemma-4']),
    l2('vendor-level2:google:gemini-cli', 'google', 'Gemini CLI', ['gemini-cli']),
  ]);
  addVendor(snap, 'xai', [
    l2('vendor-level2:xai:grok-4-6', 'xai', 'Grok 4.6', ['grok-4-6']),
    l2('vendor-level2:xai:grok-4-5', 'xai', 'Grok 4.5', ['grok-4-5']),
    l2('vendor-level2:xai:grok-imagine', 'xai', 'Grok Imagine', ['grok-imagine-image-2-0']),
  ]);
  addVendor(snap, 'nvidia', [
    l2('vendor-level2:nvidia:nemotron-3-ultra', 'nvidia', 'Nemotron 3 Ultra', ['nemotron-3-ultra']),
    l2('vendor-level2:nvidia:nemotron-3-super', 'nvidia', 'Nemotron 3 Super', ['nemotron-3-super']),
    l2('vendor-level2:nvidia:nemotron-3-5', 'nvidia', 'Nemotron 3.5', ['nemotron-3-5']),
  ]);
  addVendor(snap, 'cohere', [
    l2('vendor-level2:cohere:command', 'cohere', 'Command 模型', ['command-a']),
    l2('vendor-level2:cohere:command-a', 'cohere', 'Command A+', ['command-a-plus']),
  ]);
  // 非政策厂商：可灵
  addVendor(snap, 'kuaishou', [
    l2('vendor-level2:kuaishou:kling', 'kuaishou', 'Kling', ['kling-3-0']),
  ]);
  return snap;
}

// ── 1. 同 id 就地改写 / 全新创建 / 专用改名 ─────────────────────

test('迁移：anthropic newest 就地改写、last 全新创建、coding-plan 零漂移', () => {
  const policy = loadSeriesPolicy();
  const plan = planSeriesMigration(policy, syntheticSnapshot());
  assert.equal(plan.validation.ok, true, JSON.stringify(plan.validation.errors));
  const byId = new Map(plan.snapshot['vendor-level2'].map(x => [x.id, x]));
  assert.deepEqual(byId.get('vendor-level2:anthropic:claude').detail_refs.map(r => r.id),
    ['tool-level3:claude-fable-5', 'tool-level3:claude-opus-5', 'tool-level3:claude-sonnet-5', 'tool-level3:claude-haiku-4.5']);
  assert.equal(byId.get('vendor-level2:anthropic:claude').title, 'newest claude generation');
  assert.deepEqual(byId.get('vendor-level2:anthropic:claude-opus-4-8').detail_refs.map(r => r.id), ['tool-level3:claude-opus-4.8']);
  assert.equal(byId.get('vendor-level2:anthropic:claude-opus-4-8').title, 'last claude generation');
  // claude-opus-5 碎片被删除，成员迁入 newest
  assert.equal(byId.has('vendor-level2:anthropic:claude-opus-5'), false);
  // coding-plan 零漂移
  assert.deepEqual(byId.get('vendor-level2:anthropic:claude-coding-plan').detail_refs.map(r => r.id), ['tool-level3:claude-pro', 'tool-level3:claude-max-5x']);
});

test('迁移：openai realtime/image 专用改名、codex 不变', () => {
  const plan = planSeriesMigration(loadSeriesPolicy(), syntheticSnapshot());
  const byId = new Map(plan.snapshot['vendor-level2'].map(x => [x.id, x]));
  assert.equal(byId.get('vendor-level2:openai:gpt-realtime').title, 'GPT-Realtime');
  assert.deepEqual(byId.get('vendor-level2:openai:gpt-realtime').detail_refs.map(r => r.id), ['tool-level3:gpt-realtime-2']);
  assert.equal(byId.has('vendor-level2:openai:gpt-realtime-2'), false);
  assert.equal(byId.get('vendor-level2:openai:gpt-image').title, 'GPT-Image');
  assert.equal(byId.has('vendor-level2:openai:gpt-image-2'), false);
  assert.equal(byId.get('vendor-level2:openai:openai-codex').title, 'OpenAI Codex');
});

// ── 2. 合并与多余成员搬家 ──────────────────────────────────────

test('迁移：google gemini 拆 newest/last，多余成员搬家，gemma/cli 零漂移', () => {
  const plan = planSeriesMigration(loadSeriesPolicy(), syntheticSnapshot());
  const byId = new Map(plan.snapshot['vendor-level2'].map(x => [x.id, x]));
  assert.deepEqual(byId.get('vendor-level2:google:gemini').detail_refs.map(r => r.id), ['tool-level3:gemini-3-7-flash', 'tool-level3:gemini-3-6-flash']);
  assert.deepEqual(byId.get('vendor-level2:google:gemini-last').detail_refs.map(r => r.id),
    ['tool-level3:gemini-3.5-flash', 'tool-level3:gemini-3-1-pro', 'tool-level3:gemini-2.5-pro']);
  assert.equal(byId.has('vendor-level2:google:gemini-3-1-pro'), false);
  assert.equal(byId.get('vendor-level2:google:gemma-4').title, 'Gemma 4');
  assert.equal(byId.get('vendor-level2:google:gemini-cli').title, 'Gemini CLI');
  assert.ok(plan.members_moved.some(m => m.detail === 'tool-level3:gemini-2.5-pro' && m.from === 'vendor-level2:google:gemini' && m.to === 'vendor-level2:google:gemini-last'));
});

test('迁移：nvidia nemotron-3 合并，nemotron-3-5 独立', () => {
  const plan = planSeriesMigration(loadSeriesPolicy(), syntheticSnapshot());
  const byId = new Map(plan.snapshot['vendor-level2'].map(x => [x.id, x]));
  assert.deepEqual(byId.get('vendor-level2:nvidia:nemotron-3').detail_refs.map(r => r.id), ['tool-level3:nemotron-3-ultra', 'tool-level3:nemotron-3-super']);
  assert.deepEqual(byId.get('vendor-level2:nvidia:nemotron-3-5').detail_refs.map(r => r.id), ['tool-level3:nemotron-3-5']);
  assert.equal(byId.has('vendor-level2:nvidia:nemotron-3-ultra'), false);
  assert.equal(byId.has('vendor-level2:nvidia:nemotron-3-super'), false);
});

// ── 3. L1 引用重写 / id_map / 孤儿 / 非政策厂商 ────────────────

test('迁移：L1 level2_refs 重写，删除消失引用并追加新目标', () => {
  const plan = planSeriesMigration(loadSeriesPolicy(), syntheticSnapshot());
  const l1ById = new Map(plan.snapshot['vendor-level1'].map(x => [x.id, x]));
  assert.deepEqual(l1ById.get('vendor-level1:openai').level2_refs.map(r => r.id),
    ['vendor-level2:openai:openai-codex', 'vendor-level2:openai:gpt-realtime', 'vendor-level2:openai:gpt-image']);
  assert.deepEqual(l1ById.get('vendor-level1:anthropic').level2_refs.map(r => r.id),
    ['vendor-level2:anthropic:claude', 'vendor-level2:anthropic:claude-coding-plan', 'vendor-level2:anthropic:claude-opus-4-8']);
});

test('迁移：id_map 覆盖被删除碎片，orphaned 为空，非政策厂商零漂移', () => {
  const plan = planSeriesMigration(loadSeriesPolicy(), syntheticSnapshot());
  assert.deepEqual(plan.orphaned, []);
  assert.equal(plan.removed_level2.length, 2);
  assert.deepEqual(plan.removed_level2.map(r => r.id).sort(), [
    'vendor-level2:anthropic:claude-opus-5', 'vendor-level2:cohere:command-a',
  ]);
  assert.deepEqual(plan.id_map['vendor-level2:anthropic:claude-opus-5'], ['vendor-level2:anthropic:claude']);
  const kling = plan.snapshot['vendor-level2'].find(x => x.id === 'vendor-level2:kuaishou:kling');
  assert.ok(kling, '非政策厂商 kuaishou 系列应保留');
  assert.deepEqual(kling.detail_refs.map(r => r.id), ['tool-level3:kling-3-0']);
});

test('迁移：通用厂商未纳入政策的工具系列保留', () => {
  const snap = syntheticSnapshot();
  snap['tool-level3'].push(detail('tool-level3:claude-code', 'anthropic', 'tool', 'dev'));
  snap['tool-card'].push(card('claude-code', 'anthropic', 'tool', 'dev'));
  const toolSeries = l2('vendor-level2:anthropic:claude-code', 'anthropic', 'Claude Code', ['claude-code']);
  snap['vendor-level2'].push(toolSeries);
  snap['vendor-level1'].find(item => item.id === 'vendor-level1:anthropic').level2_refs.push({ kind: 'vendor-level2', id: toolSeries.id });

  const plan = planSeriesMigration(loadSeriesPolicy(), snap);
  const byId = new Map(plan.snapshot['vendor-level2'].map(x => [x.id, x]));
  assert.ok(byId.has(toolSeries.id));
  assert.deepEqual(byId.get(toolSeries.id).detail_refs.map(r => r.id), ['tool-level3:claude-code']);
  assert.deepEqual(plan.orphaned, []);
});


test('迁移：OpenAI 订阅套餐孤儿被统一 coding plan 收养，既有浮空警告清空', () => {
  const snap = syntheticSnapshot();
  // 3 个无父级的 OpenAI 订阅套餐详情（无 tool-card，契约如此）
  for (const id of ['chatgpt-go', 'chatgpt-plus', 'chatgpt-pro']) {
    snap['tool-level3'].push(detail(`tool-level3:${id}`, 'openai', 'subscription_plan'));
  }
  const plan = planSeriesMigration(loadSeriesPolicy(), snap);
  const byId = new Map(plan.snapshot['vendor-level2'].map(x => [x.id, x]));
  assert.deepEqual(byId.get('vendor-level2:openai:openai-coding-plan').detail_refs.map(r => r.id),
    ['tool-level3:chatgpt-go', 'tool-level3:chatgpt-plus', 'tool-level3:chatgpt-pro']);
  assert.equal(byId.get('vendor-level2:openai:openai-coding-plan').title, '套餐（Coding Plan）');
  assert.deepEqual(plan.orphaned, []);
  assert.ok(!plan.warnings.some(w => w.code === 'PRE_EXISTING_UNPARENTED'), 'chatgpt 系列应被收养，不应再有浮空警告');
});

test('迁移：政策厂商真正未覆盖的既有浮空详情写入 warnings 而非孤儿', () => {
  const snap = syntheticSnapshot();
  snap['tool-level3'].push(detail('tool-level3:openai-floating-tool', 'openai', 'tool', 'general'));
  snap['tool-card'].push(card('openai-floating-tool', 'openai', 'tool'));
  const plan = planSeriesMigration(loadSeriesPolicy(), snap);
  assert.deepEqual(plan.orphaned, []);
  assert.ok(plan.warnings.some(w => w.code === 'PRE_EXISTING_UNPARENTED' && w.detail === 'tool-level3:openai-floating-tool'));
});

// ── 5. 集成：真实快照迁移后校验通过且关键终态符合政策 ──────────

function realSnapshot() {
  const files = {
    'vendor-card': 'vendor-cards.json', 'tool-card': 'tool-cards.json',
    'vendor-level1': 'vendor-preview-level1.json', 'vendor-level2': 'vendor-preview-level2.json',
    'tool-level3': 'tool-preview-level3.json',
  };
  const snap = emptySnapshot();
  for (const [area, name] of Object.entries(files)) {
    const payload = JSON.parse(fs.readFileSync(`${DIRS.catalog}/${name}`, 'utf8'));
    snap[area] = Array.isArray(payload) ? payload : payload.items;
  }
  return snap;
}

test('集成：真实五模块快照迁移后校验通过，关键目标系列成员符合政策，无新孤儿', () => {
  const policy = loadSeriesPolicy();
  const plan = planSeriesMigration(policy, realSnapshot());
  assert.equal(plan.validation.ok, true, JSON.stringify(plan.validation.errors));
  assert.deepEqual(plan.orphaned, []);
  const byId = new Map(plan.snapshot['vendor-level2'].map(x => [x.id, x]));
  const expect = (id, members) => assert.deepEqual(byId.get(id).detail_refs.map(r => r.id), members.map(m => `tool-level3:${m}`), id);
  expect('vendor-level2:openai:gpt-5.6', ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  expect('vendor-level2:openai:gpt-realtime', ['gpt-realtime-2']);
  expect('vendor-level2:openai:gpt-image', ['gpt-image-2']);
  expect('vendor-level2:anthropic:claude', ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4.5']);
  expect('vendor-level2:anthropic:claude-opus-4-8', ['claude-opus-4.8']);
  expect('vendor-level2:google:gemini', ['gemini-3-7-flash', 'gemini-3-6-flash']);
  expect('vendor-level2:google:gemini-last', ['gemini-3.5-flash', 'gemini-3-1-pro', 'gemini-2.5-pro']);
  expect('vendor-level2:zhipu:glm', ['glm-5.1', 'glm-5.2', 'glm-5-3']);
  expect('vendor-level2:cohere:command', ['command-a', 'command-a-plus']);
  expect('vendor-level2:xai:grok', ['grok-4-6', 'grok-4-5']);
  expect('vendor-level2:minimax:m', ['minimax-m3', 'minimax-m2-7']);
  expect('vendor-level2:moonshot:kimi', ['kimi-k3']);
  expect('vendor-level2:moonshot:kimi-code', ['kimi-k2-7-code']);
  expect('vendor-level2:alibaba:qwen', ['qwen3-8-max', 'qwen3-7-max', 'qwen3-7-plus']);
  expect('vendor-level2:stepfun:step', ['step-3-7-flash', 'step-3-5-flash']);
  expect('vendor-level2:xiaomi:mimo', ['mimo-v2-5', 'mimo-v2-5-pro']);
  expect('vendor-level2:nvidia:nemotron-3', ['nemotron-3-ultra', 'nemotron-3-super']);
  expect('vendor-level2:nvidia:nemotron-3-5', ['nemotron-3-5']);
});

test('集成：迁移后 tool-level3 与 tool-card 完全不变（只改二级关系）', () => {
  const policy = loadSeriesPolicy();
  const before = realSnapshot();
  const plan = planSeriesMigration(policy, before);
  const after = plan.snapshot;
  assert.deepEqual(after['tool-level3'].map(x => x.id).sort(), before['tool-level3'].map(x => x.id).sort());
  assert.deepEqual(after['tool-card'].map(x => x.id).sort(), before['tool-card'].map(x => x.id).sort());
  // 三级详情与工具卡内容逐条一致
  for (const d of before['tool-level3']) {
    const afterDetail = after['tool-level3'].find(x => x.id === d.id);
    assert.deepEqual(afterDetail, d, `tool-level3:${d.id} 不应被修改`);
  }
});
