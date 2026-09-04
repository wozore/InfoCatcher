'use strict';

const fs = require('fs');
const { CATALOG_FILES } = require('../shared/paths');
const { planRecordRemoval, commitSnapshotChange, loadCatalogSnapshot } = require('./transaction');
const { revisionOf, previewHashOf } = require('./core/index');
const { readRetentionState } = require('../shared/retention');

/**
 * catalog-retention-prune.js — catalog 五模块 14 个月滚动级联删除
 *
 * 与对比栏模型共用共享段 `data/shared/retention.json` 的 cutoff（只读不写）。
 * 按 detail_kind 取时间字段（tool→last_updated_date，api_model/product_variant→release_date）
 * 早于 cutoff 月首日的三级详情视为过期，级联删除其 tool-card / vendor-level2 /
 * vendor-level1 / vendor-card（失去全部引用的父级）。subscription_plan 与无日期详情
 * 保守保留。scenes/featured/glossary 不触碰；featured 悬空项只报告不修改。
 * 复用 transaction 门面的 planRecordRemoval + commitSnapshotChange（事务/回滚/dist）。
 */

const DATE_FIELD_BY_KIND = Object.freeze({
  tool: 'last_updated_date',
  api_model: 'release_date',
  product_variant: 'release_date',
});

/** 从共享段读当前 cutoff（YYYY-MM-01）；缺失返回 null。 */
function currentCutoffDate() {
  return readRetentionState().cutoff_date;
}

/** 收集过期详情 + 级联父级删除目标。 */
function collectPruneTargets(snapshot, cutoffDate) {
  const details = snapshot['tool-level3'] || [];
  const expiredDetailIds = new Set(
    details
      .filter(detail => {
        const field = DATE_FIELD_BY_KIND[detail.detail_kind];
        return field && detail[field] && detail[field] < cutoffDate;
      })
      .map(detail => detail.id),
  );
  const toolCards = (snapshot['tool-card'] || [])
    .filter(card => expiredDetailIds.has(card.detail_ref && card.detail_ref.id))
    .map(card => card.id);
  const level2Targets = (snapshot['vendor-level2'] || [])
    .filter(level2 => level2.detail_refs && level2.detail_refs.length && level2.detail_refs.every(ref => expiredDetailIds.has(ref.id)))
    .map(level2 => ({ area: 'vendor-level2', id: level2.id }));
  const level2Ids = new Set(level2Targets.map(t => t.id));
  const level1Targets = (snapshot['vendor-level1'] || [])
    .filter(level1 => level1.level2_refs && level1.level2_refs.length && level1.level2_refs.every(ref => level2Ids.has(ref.id)))
    .map(level1 => ({ area: 'vendor-level1', id: level1.id }));
  const level1Ids = new Set(level1Targets.map(t => t.id));
  const vendorCards = (snapshot['vendor-card'] || [])
    .filter(vendorCard => level1Ids.has(vendorCard.level1_ref && vendorCard.level1_ref.id))
    .map(vendorCard => vendorCard.id);
  const targets = [
    ...[...expiredDetailIds].map(id => ({ area: 'tool-level3', id })),
    ...toolCards.map(id => ({ area: 'tool-card', id })),
    ...level2Targets,
    ...level1Targets,
    ...vendorCards.map(id => ({ area: 'vendor-card', id })),
  ];
  return {
    expired_details: [...expiredDetailIds],
    tool_cards: toolCards,
    vendor_level2s: level2Targets.map(t => t.id),
    vendor_level1s: level1Targets.map(t => t.id),
    vendor_cards: vendorCards,
    targets,
  };
}

/** featured.json 中指向被删详情的悬空项（只报不改；缺失/失败返回空）。 */
function featuredDangling(expiredDetailIds, featuredFile = CATALOG_FILES.featured) {
  try {
    if (!featuredFile || !fs.existsSync(featuredFile)) return [];
    const value = JSON.parse(fs.readFileSync(featuredFile, 'utf8'));
    const items = Array.isArray(value) ? value : (value.items || []);
    return items
      .filter(item => {
        const ref = item.detail_ref ? String(item.detail_ref) : null;
        return ref && expiredDetailIds.has(ref);
      })
      .map(item => item.tool_id || item.detail_ref || null)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 规划滚动删除（只读，产出 preview + preview_hash）。
 * @param {object} snapshot 五模块快照
 * @param {string|null} cutoffDate `YYYY-MM-01`
 * @param {{featuredFile?: string}} [options]
 */
function planRetentionPrune(snapshot, cutoffDate, options = {}) {
  if (!cutoffDate || !/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate)) {
    return { ok: false, code: 'RETENTION_CUTOFF_REQUIRED', error: '需要 cutoff_date（YYYY-MM-01）' };
  }
  const beforeRevision = revisionOf(snapshot);
  const collected = collectPruneTargets(snapshot, cutoffDate);
  if (!collected.targets.length) {
    return {
      ok: true, has_changes: false, cutoff_date: cutoffDate,
      expired_details: [], tool_cards: [], vendor_level2s: [], vendor_level1s: [], vendor_cards: [],
      featured_dangling: [], target_snapshot: snapshot,
      before_revision: beforeRevision, target_revision: beforeRevision,
      preview_hash: previewHashOf({ kind: 'catalog_retention_prune', cutoff_date: cutoffDate }),
    };
  }
  const planned = planRecordRemoval(snapshot, collected.targets);
  if (!planned.ok) return planned;
  const preview = {
    kind: 'catalog_retention_prune', cutoff_date: cutoffDate,
    expired_details: collected.expired_details,
    tool_cards: collected.tool_cards,
    vendor_level2s: collected.vendor_level2s,
    vendor_level1s: collected.vendor_level1s,
    vendor_cards: collected.vendor_cards,
    featured_dangling: featuredDangling(new Set(collected.expired_details.map(id => `tool-level3:${id}`)), options.featuredFile),
  };
  return {
    ok: true, has_changes: true, ...preview,
    target_snapshot: planned.snapshot,
    before_revision: beforeRevision, target_revision: revisionOf(planned.snapshot),
    preview_hash: previewHashOf(preview),
  };
}

/**
 * 事务化应用滚动删除。
 * @param {{cutoffDate: string, expectedRevision: string, previewHash?: string, options?: object}} params
 */
function applyRetentionPrune({ cutoffDate, expectedRevision, previewHash, options = {} }) {
  const current = loadCatalogSnapshot();
  if (!expectedRevision) return { ok: false, code: 'RETENTION_EXPECTED_REVISION_REQUIRED', error: '必须提供 expected-revision' };
  if (current.revision !== expectedRevision) return { ok: false, code: 'REVISION_CONFLICT', revision: current.revision };
  const planned = planRetentionPrune(current.snapshot, cutoffDate, options);
  if (!planned.ok) return planned;
  if (!planned.has_changes) return { ...planned, committed: false };
  if (previewHash && planned.preview_hash !== previewHash) {
    return { ok: false, code: 'RETENTION_PREVIEW_CONFLICT', preview_hash: planned.preview_hash, expected_preview_hash: previewHash };
  }
  const committed = commitSnapshotChange(planned.target_snapshot, { expectedRevision: current.revision, operation: 'catalog-retention-prune' });
  return committed.ok ? { ...committed, ...planned, committed: true } : committed;
}

module.exports = { DATE_FIELD_BY_KIND, currentCutoffDate, collectPruneTargets, featuredDangling, planRetentionPrune, applyRetentionPrune };
