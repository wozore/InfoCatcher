'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emptySnapshot } = require('../../src/catalog/catalog-contract');
const { planRetentionPrune, collectPruneTargets, DATE_FIELD_BY_KIND } = require('../../src/catalog/catalog-retention-prune');

const CUTOFF = '2025-06-01';

/** 构造一条 vendor-card → level1 → level2 → tool-level3 + tool-card 完整链路。 */
function link(vendorKey, title, detailKind, dateValue) {
  const theme = 'general';
  const detail = {
    id: `tool-level3:${vendorKey}`, vendor_key: vendorKey, detail_kind: detailKind, theme,
    title, vendor_label: title, icon: 'x', official_url: 'https://example.com', status: 'active',
    summary: title, applicable_scenarios: [{ title: 'x', description: 'x' }],
    inapplicable_scenarios: [{ title: 'x', description: 'x' }],
    sources: [{ title: 'Official', url: 'https://example.com' }],
  };
  if (dateValue) detail[DATE_FIELD_BY_KIND[detailKind]] = dateValue;
  const snapshot = emptySnapshot();
  snapshot['vendor-card'].push({ id: `vendor-card:${vendorKey}`, vendor_key: vendorKey, title, icon: 'x', summary: title, level1_ref: { kind: 'vendor-level1', id: `vendor-level1:${vendorKey}` } });
  snapshot['vendor-level1'].push({ id: `vendor-level1:${vendorKey}`, vendor_key: vendorKey, title, icon: 'x', official_url: 'https://example.com', description: title, status: 'active', features: [{ tone: 'positive', text: title }], level2_refs: [{ kind: 'vendor-level2', id: `vendor-level2:${vendorKey}` }] });
  snapshot['vendor-level2'].push({ id: `vendor-level2:${vendorKey}`, level1_ref: { kind: 'vendor-level1', id: `vendor-level1:${vendorKey}` }, vendor_key: vendorKey, title, official_url: 'https://example.com', summary: title, status: 'active', detail_refs: [{ kind: 'tool-level3', id: `tool-level3:${vendorKey}` }] });
  snapshot['tool-level3'].push(detail);
  snapshot['tool-card'].push({ id: `tool-card:${vendorKey}`, tool_key: vendorKey, vendor_key: vendorKey, title, vendor_label: title, icon: 'x', summary: title, theme, detail_ref: { kind: 'tool-level3', id: `tool-level3:${vendorKey}` }, detail_kind: detailKind });
  return snapshot;
}

function mergeSnapshots(...snapshots) {
  const result = emptySnapshot();
  for (const snapshot of snapshots) {
    for (const area of Object.keys(result)) result[area].push(...snapshot[area]);
  }
  return result;
}

test('catalog prune：过期 tool（last_updated_date < cutoff）级联删除整条 vendor 链', () => {
  const snapshot = mergeSnapshots(
    link('old-tool', 'Old Tool', 'tool', '2024-08-19'),
    link('new-tool', 'New Tool', 'tool', '2026-08-19'),
  );
  const result = planRetentionPrune(snapshot, CUTOFF);
  assert.equal(result.ok, true);
  assert.equal(result.has_changes, true);
  assert.deepEqual(result.expired_details, ['tool-level3:old-tool']);
  assert.deepEqual(result.tool_cards, ['tool-card:old-tool']);
  assert.deepEqual(result.vendor_level2s, ['vendor-level2:old-tool']);
  assert.deepEqual(result.vendor_level1s, ['vendor-level1:old-tool']);
  assert.deepEqual(result.vendor_cards, ['vendor-card:old-tool']);
  // 目标快照：旧链路消失，新链路保留
  assert.ok(!result.target_snapshot['tool-level3'].some(item => item.id === 'tool-level3:old-tool'));
  assert.ok(!result.target_snapshot['tool-card'].some(item => item.id === 'tool-card:old-tool'));
  assert.ok(result.target_snapshot['tool-level3'].some(item => item.id === 'tool-level3:new-tool'));
  assert.ok(result.target_snapshot['tool-card'].some(item => item.id === 'tool-card:new-tool'));
});

test('catalog prune：api_model 用 release_date 判据，过期级联删除', () => {
  const snapshot = mergeSnapshots(
    link('old-model', 'Old Model', 'api_model', '2025-05-30'),
    link('new-model', 'New Model', 'api_model', '2026-05-19'),
  );
  const result = planRetentionPrune(snapshot, CUTOFF);
  assert.deepEqual(result.expired_details, ['tool-level3:old-model']);
  assert.ok(!result.target_snapshot['tool-level3'].some(item => item.id === 'tool-level3:old-model'));
  assert.ok(result.target_snapshot['tool-level3'].some(item => item.id === 'tool-level3:new-model'));
});

test('catalog prune：无日期详情与 subscription_plan 保守保留', () => {
  const snapshot = emptySnapshot();
  snapshot['tool-level3'].push({ id: 'tool-level3:no-date', vendor_key: 'nd', detail_kind: 'tool', theme: 'general', title: 'No Date', status: 'active', summary: 'x' });
  snapshot['tool-card'].push({ id: 'tool-card:no-date', tool_key: 'nd', vendor_key: 'nd', title: 'No Date', theme: 'general', detail_ref: { kind: 'tool-level3', id: 'tool-level3:no-date' }, detail_kind: 'tool' });
  snapshot['tool-level3'].push({ id: 'tool-level3:plan', vendor_key: 'nd', detail_kind: 'subscription_plan', theme: 'general', title: 'Plan', status: 'active', summary: 'x' });
  const result = planRetentionPrune(snapshot, CUTOFF);
  assert.equal(result.has_changes, false);
  assert.deepEqual(result.expired_details, []);
  // 无日期详情仍在目标快照
  assert.ok(result.target_snapshot['tool-level3'].some(item => item.id === 'tool-level3:no-date'));
  assert.ok(result.target_snapshot['tool-level3'].some(item => item.id === 'tool-level3:plan'));
});

test('catalog prune：部分过期时 vendor-level2 保留但清理过期 detail_refs', () => {
  const a = link('keep-a', 'Keep A', 'tool', '2026-01-01');
  const b = link('drop-b', 'Drop B', 'tool', '2024-01-01');
  // 合并 A 和 B 到同一个 vendor-level2（B 过期但 A 保留 → level2 不删）
  const snapshot = emptySnapshot();
  const level1 = { ...a['vendor-level1'][0], level2_refs: [{ kind: 'vendor-level2', id: 'vendor-level2:shared' }] };
  snapshot['vendor-card'].push(a['vendor-card'][0]);
  snapshot['vendor-level1'].push(level1);
  snapshot['vendor-level2'].push({ ...a['vendor-level2'][0], id: 'vendor-level2:shared', level1_ref: { kind: 'vendor-level1', id: level1.id }, detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:keep-a' }, { kind: 'tool-level3', id: 'tool-level3:drop-b' }] });
  snapshot['tool-level3'].push(a['tool-level3'][0], b['tool-level3'][0]);
  snapshot['tool-card'].push(a['tool-card'][0], b['tool-card'][0]);
  const result = planRetentionPrune(snapshot, CUTOFF);
  assert.equal(result.ok, true, result.error || '');
  assert.deepEqual(result.expired_details, ['tool-level3:drop-b']);
  // level2 保留（不是全部过期）
  assert.ok(result.target_snapshot['vendor-level2'].some(item => item.id === 'vendor-level2:shared'));
  // 引用清理：detail_refs 只剩 keep-a
  const shared = result.target_snapshot['vendor-level2'].find(item => item.id === 'vendor-level2:shared');
  assert.deepEqual(shared.detail_refs.map(ref => ref.id), ['tool-level3:keep-a']);
  // tool-card drop-b 被删
  assert.ok(!result.target_snapshot['tool-card'].some(item => item.id === 'tool-card:drop-b'));
});

test('catalog prune：无过期时 has_changes=false 且快照不变', () => {
  const snapshot = mergeSnapshots(link('new-tool', 'New Tool', 'tool', '2026-08-19'));
  const result = planRetentionPrune(snapshot, CUTOFF);
  assert.equal(result.ok, true);
  assert.equal(result.has_changes, false);
  assert.equal(result.target_snapshot, snapshot);
});

test('catalog prune：featured 悬空检测只报不改', () => {
  const snapshot = mergeSnapshots(link('old-tool', 'Old Tool', 'tool', '2024-08-19'));
  const result = planRetentionPrune(snapshot, CUTOFF, {
    featuredFile: null, // 传 null 跳过文件读取 → 空
  });
  // featuredFile null → 无 featured 读取，悬空为空
  assert.deepEqual(result.featured_dangling, []);
});

test('catalog prune：DATE_FIELD_BY_KIND 映射', () => {
  assert.equal(DATE_FIELD_BY_KIND.tool, 'last_updated_date');
  assert.equal(DATE_FIELD_BY_KIND.api_model, 'release_date');
  assert.equal(DATE_FIELD_BY_KIND.product_variant, 'release_date');
  assert.equal(DATE_FIELD_BY_KIND.subscription_plan, undefined);
});
