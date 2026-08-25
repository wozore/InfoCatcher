/**
 * catalog-series-policy.test.js — LLM 二级系列政策契约回归（阶段 1）
 *
 * 覆盖面：
 *   - 16 厂商政策矩阵完整：每厂商至少有 general_llm 家族、目标系列集合、evidence 状态合法；
 *   - validateSeriesPolicy 对缺 top 字段 / 重复 vendor / 重复 series id / 非法 usage /
 *     capacity 区间 / evidence 非法等 fail-closed；
 *   - usageKindOf 正确区分 general_llm / 专用 / 未覆盖（含无 modality 的 pending）；
 *   - normalizeVendorKey 别名规范化与未命中；
 *   - validatePlacementRef 的 kind / 存在性 / vendor 归属 / 无 vendorKey 分支；
 *   - 稳定 ID 与 slugify 点号冲突：detailKeyOf / detailRefIdOf。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emptySnapshot } = require('../../src/catalog/catalog-contract');
const {
  loadSeriesPolicy,
  validateSeriesPolicy,
  normalizeVendorKey,
  policyForVendor,
  matchFamily,
  usageKindOf,
  allowedTargetSeries,
  validatePlacementRef,
  detailKeyOf,
  detailRefIdOf,
} = require('../../src/catalog/catalog-series-policy');

function policy() {
  return loadSeriesPolicy();
}

// ── 第 1 组：政策文件完整性与厂商矩阵 ──────────────────────────

test('政策文件加载合法，无校验错误', () => {
  const p = policy();
  assert.equal(validateSeriesPolicy(p).length, 0);
});

test('厂商矩阵：16 个厂商，每家至少有 general_llm 家族且目标系列非空', () => {
  const p = policy();
  const vendors = p.vendors.map(v => v.vendor_key);
  assert.deepEqual(vendors, ['openai', 'anthropic', 'google', 'deepseek', 'zhipu', 'baidu', 'mistral', 'cohere', 'xai', 'minimax', 'moonshot', 'alibaba', 'tencent', 'stepfun', 'xiaomi', 'nvidia']);
  for (const vendor of p.vendors) {
    const generalIdx = vendor.families.findIndex(f => f.usage_kind === 'general_llm');
    assert.ok(generalIdx >= 0, `${vendor.vendor_key} 缺 general_llm 家族`);
    const series = allowedTargetSeries(p, vendor, vendor.families[generalIdx].family);
    assert.ok(series.length > 0, `${vendor.vendor_key} 的 general_llm 家族缺目标系列`);
    for (const s of series) {
      assert.match(s.id, /^vendor-level2:/, `${vendor.vendor_key} 系列 id 前缀非法`);
      assert.ok(['newest', 'previous'].includes(s.cohort), `${vendor.vendor_key} 系列 cohort 非法`);
      assert.ok(Array.isArray(s.expected_members), `${vendor.vendor_key} 系列缺 expected_members`);
    }
  }
});

// ── 第 2 组：validator fail-closed ─────────────────────────────

function basePolicy() {
  return {
    schema_version: 1,
    verified_at: '2026-08-25',
    capacity: { merge_up_to: 3, split_when_member_count_exceeds: 3 },
    defaults: { unknown_vendor_policy: 'fail_closed' },
    vendor_aliases: { openai: ['openai', 'open ai'] },
    vendors: [
      {
        vendor_key: 'openai', families: [
          {
            family: 'gpt', usage_kind: 'general_llm', version_axis: 'dot',
            series: [{ id: 'vendor-level2:openai:gpt', title: 'GPT', cohort: 'newest', expected_members: ['gpt-5.6-sol'] }],
            evidence: { url: 'https://example.com', status: 'verified' },
          },
        ],
      },
    ],
  };
}

test('validateSeriesPolicy：缺 top 字段 / 根节点非法', () => {
  assert.deepEqual(validateSeriesPolicy(null), ['SERIES_POLICY_ROOT_INVALID']);
  assert.deepEqual(validateSeriesPolicy([1]), ['SERIES_POLICY_ROOT_INVALID']);
  const missing = basePolicy();
  delete missing.vendors;
  assert.ok(validateSeriesPolicy(missing).some(e => e === 'SERIES_POLICY_MISSING_TOP:vendors'));
});

test('validateSeriesPolicy：capacity 区间非法拒绝（merge 须小于 split 阈值）', () => {
  const bad = basePolicy();
  bad.capacity = { merge_up_to: 3, split_when_member_count_exceeds: 2 };
  assert.ok(validateSeriesPolicy(bad).includes('SERIES_POLICY_CAPACITY_RANGE_INVALID'));
});

test('validateSeriesPolicy：vendor 重复 / series id 重复拒绝', () => {
  const dupVendor = basePolicy();
  dupVendor.vendors.push(dupVendor.vendors[0]);
  assert.ok(validateSeriesPolicy(dupVendor).includes('SERIES_POLICY_VENDOR_DUPLICATE:openai'));

  const dupSeries = basePolicy();
  dupSeries.vendors[0].families[0].series.push(dupSeries.vendors[0].families[0].series[0]);
  assert.ok(validateSeriesPolicy(dupSeries).includes('SERIES_POLICY_SERIES_DUPLICATE:vendor-level2:openai:gpt'));
});

test('validateSeriesPolicy：非法 usage / evidence 状态拒绝', () => {
  const badUsage = basePolicy();
  badUsage.vendors[0].families[0].usage_kind = 'nonsense';
  assert.ok(validateSeriesPolicy(badUsage).includes('SERIES_POLICY_USAGE_INVALID:openai:gpt:nonsense'));

  const badEvid = basePolicy();
  badEvid.vendors[0].families[0].evidence.status = 'guessed';
  assert.ok(validateSeriesPolicy(badEvid).includes('SERIES_POLICY_EVIDENCE_INVALID:openai:gpt'));
});

test('validateSeriesPolicy：expected_members 空字符串拒绝', () => {
  const bad = basePolicy();
  bad.vendors[0].families[0].series[0].expected_members = ['   '];
  assert.ok(validateSeriesPolicy(bad).includes('SERIES_POLICY_SERIES_MEMBER_KEY_INVALID:vendor-level2:openai:gpt:   '));
});

// ── 第 3 组：vendor 别名规范化 ─────────────────────────────────

test('normalizeVendorKey：别名/大小写/未命中', () => {
  const p = policy();
  assert.equal(normalizeVendorKey(p, '智谱'), 'zhipu');
  assert.equal(normalizeVendorKey(p, 'Google'), 'google');
  assert.equal(normalizeVendorKey(p, 'google'), 'google');
  assert.equal(normalizeVendorKey(p, 'z.ai'), 'zhipu');
  assert.equal(normalizeVendorKey(p, 'unknown vendor'), null);
  assert.equal(normalizeVendorKey(p, '   '), null);
});

test('policyForVendor：命中与未命中', () => {
  const p = policy();
  assert.equal(policyForVendor(p, 'openai').vendor_key, 'openai');
  assert.equal(policyForVendor(p, 'kuaishou'), null);
});

// ── 第 4 组：用途判定 ──────────────────────────────────────────

function seed(overrides) {
  return {
    detail_kind: 'api_model',
    name: 'GPT-5.6 Sol',
    vendor_name: 'OpenAI',
    vendor_key: 'openai',
    ...overrides,
  };
}

test('usageKindOf：按 family pattern 识别无 modality 的专用模型', () => {
  const p = policy();
  assert.equal(usageKindOf(p, policyForVendor(p, 'openai'), seed({ name: 'GPT-Realtime-2' })), 'audio_realtime');
  assert.equal(usageKindOf(p, policyForVendor(p, 'openai'), seed({ name: 'gpt-image-2' })), 'image');
  assert.equal(usageKindOf(p, policyForVendor(p, 'minimax'), seed({ vendor_key: 'minimax', name: 'MiniMax H3' })), 'video');
});

test('usageKindOf：无 pattern 命中的通用缺省 → general_llm', () => {
  const p = policy();
  assert.equal(usageKindOf(p, policyForVendor(p, 'openai'), seed({ name: 'GPT-5.6 Sol' })), 'general_llm');
  assert.equal(usageKindOf(p, policyForVendor(p, 'cohere'), seed({ vendor_key: 'cohere', name: 'Command A+' })), 'general_llm');
});

test('usageKindOf：厂商未覆盖（可灵 Kling）→ uncovered，不当作通用 LLM', () => {
  const p = policy();
  assert.equal(usageKindOf(p, policyForVendor(p, 'kuaishou'), seed({ vendor_key: 'kuaishou', name: 'Kling 3.0' })), 'uncovered');
});

test('usageKindOf：subscription / tool 归入专用，不进入 general_llm', () => {
  const p = policy();
  assert.equal(usageKindOf(p, policyForVendor(p, 'anthropic'), { detail_kind: 'subscription_plan', name: 'Claude Max' }), 'subscription');
  assert.equal(usageKindOf(p, policyForVendor(p, 'openai'), { detail_kind: 'tool', name: 'OpenAI Codex' }), 'tool');
});

test('usageKindOf：显式 modality 兜底映射', () => {
  const p = policy();
  assert.equal(usageKindOf(p, policyForVendor(p, 'google'), seed({ name: 'Something', vendor_key: 'google', modality: 'image' })), 'image');
});

// ── 第 5 组：目标系列集合 ──────────────────────────────────────

test('allowedTargetSeries：zhipu GLM 当前仅一个系列（GLM 5）且成员数 = merge_up_to 上限', () => {
  const p = policy();
  const zhipu = policyForVendor(p, 'zhipu');
  const series = allowedTargetSeries(p, zhipu, 'glm');
  assert.equal(series.length, 1);
  assert.equal(series[0].id, 'vendor-level2:zhipu:glm');
  assert.equal(series[0].title, 'GLM 5');
  assert.equal(series[0].expected_members.length, 3);
  assert.equal(p.capacity.merge_up_to, 3);
  assert.equal(p.capacity.split_when_member_count_exceeds, 3, 'GLM 第 4 个成员才触发拆分阈值');
  assert.equal(zhipu.families[0].split_rule, 'auto_after_4');
});

test('allowedTargetSeries：OpenAI/Anthropic 有 manual_split_exception 且保留双系列', () => {
  const p = policy();
  const gpt = policyForVendor(p, 'openai').families.find(f => f.family === 'gpt');
  assert.equal(gpt.manual_split_exception, true);
  assert.equal(gpt.series.length, 2);

  const claude = policyForVendor(p, 'anthropic').families.find(f => f.family === 'claude');
  assert.equal(claude.manual_split_exception, true);
  assert.deepEqual(claude.series.map(s => s.cohort), ['newest', 'previous']);
});

// ── 第 6 组：人工 placement 引用校验 ───────────────────────────

function snapshot() {
  const snap = emptySnapshot();
  snap['vendor-level1'].push({ id: 'vendor-level1:google', vendor_key: 'google', level2_refs: [] });
  snap['vendor-level2'].push({ id: 'vendor-level2:google:gemini', vendor_key: 'google', detail_refs: [] });
  return snap;
}

test('validatePlacementRef：合法人工 ref 通过', () => {
  const p = policy();
  const res = validatePlacementRef(p, snapshot(), {
    existing_level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:google' },
    existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:google:gemini' },
  }, 'google');
  assert.equal(res.ok, true);
  assert.deepEqual(res.violations, []);
});

test('validatePlacementRef：kind 错误 / 不存在 / vendor 不匹配均拒绝', () => {
  const p = policy();
  const snap = snapshot();

  const badKind = validatePlacementRef(p, snap, { existing_level2_ref: { kind: 'tool-level3', id: 'vendor-level2:google:gemini' } }, 'google');
  assert.ok(badKind.violations.some(v => v.startsWith('PLACEMENT_L2_KIND_INVALID')));

  const notFound = validatePlacementRef(p, snap, { existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:openai:gpt' } }, 'google');
  assert.ok(notFound.violations.some(v => v === 'PLACEMENT_L2_NOT_FOUND:vendor-level2:openai:gpt'));

  const mismatch = validatePlacementRef(p, snap, { existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:google:gemini' } }, 'openai');
  assert.ok(mismatch.violations.some(v => v === 'PLACEMENT_L2_VENDOR_MISMATCH:vendor-level2:google:gemini'));
});

test('validatePlacementRef：无 vendorKey 时只校验存在性', () => {
  const p = policy();
  const res = validatePlacementRef(p, snapshot(), { existing_level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:google' } }, null);
  assert.equal(res.ok, true);
});

// ── 第 7 组：稳定 ID 与 slugify 点号冲突 ────────────────────────

test('detailKeyOf / detailRefIdOf：点号 id 不被改写', () => {
  assert.equal(detailKeyOf('gpt-5.6'), 'gpt-5.6');
  assert.equal(detailKeyOf('tool-level3:gpt-5.6'), 'gpt-5.6');
  assert.equal(detailKeyOf('claude-opus-4.8'), 'claude-opus-4.8');
  assert.equal(detailRefIdOf('gpt-5.6'), 'tool-level3:gpt-5.6');
  assert.equal(detailRefIdOf('tool-level3:gpt-5.6'), 'tool-level3:gpt-5.6');
  assert.equal(detailKeyOf('   '), null);
  assert.equal(detailRefIdOf(''), null);
});
