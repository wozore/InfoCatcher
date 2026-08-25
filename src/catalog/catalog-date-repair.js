'use strict';

const {
  canonicalizeUrl,
  officialRootsOf,
  isTrustedOfficialUrl,
} = require('./catalog-research');
const { revisionOf, previewHashOf, stableStringify } = require('./catalog-revision');
const { validateCatalogSnapshot } = require('./catalog-snapshot-validator');
const { loadCatalogSnapshot, commitSnapshotChange } = require('./catalog-transaction-store');
const { loadProductUrlRegistry, updateSourcesForProduct } = require('./official-url-registry');
const { readReviewQueue } = require('./tool-update-review-store');
const { explicitDates, planToolUpdateCandidate } = require('./tool-update-review-planner');

const TARGET_FIELD_BY_KIND = Object.freeze({
  tool: 'last_updated_date',
  api_model: 'release_date',
  product_variant: 'release_date',
});
const DATE_REPAIR_MODES = Object.freeze(['fill_missing', 'advance_update']);

const MONTHS = Object.freeze({
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
});

const MONTH_ABBREVIATIONS = Object.freeze({
  january: 'Jan', february: 'Feb', march: 'Mar', april: 'Apr', may: 'May', june: 'Jun',
  july: 'Jul', august: 'Aug', september: 'Sep', october: 'Oct', november: 'Nov', december: 'Dec',
});

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateFieldForDetail(detail) {
  return TARGET_FIELD_BY_KIND[detail?.detail_kind] || null;
}

function dateVariants(value) {
  if (!isIsoDate(value)) return [];
  const [year, month, day] = value.split('-');
  const monthName = Object.entries(MONTHS).find(([, number]) => number === month)?.[0];
  const monthAbbreviation = MONTH_ABBREVIATIONS[monthName];
  return [
    value,
    `${monthName} ${Number(day)}, ${year}`,
    `${monthAbbreviation} ${Number(day)}, ${year}`,
    `${Number(day)} ${monthName} ${year}`,
  ].filter(Boolean);
}

function officialDateOf(value) {
  const match = String(value || '').match(/(?:^|\b)(20\d{2})-(\d{2})-(\d{2})(?=\b|T)/);
  const date = match ? `${match[1]}-${match[2]}-${match[3]}` : null;
  return date && isIsoDate(date) ? date : null;
}

function evidenceSupportsDate(evidence, date) {
  if (officialDateOf(evidence?.official_published_at) === date) return true;
  const content = String(evidence?.content || '').toLowerCase();
  if (dateVariants(date).some(value => content.includes(value.toLowerCase()))) return true;
  // 与 planner 保持一致：explicitDates 支持月份缩写、点分隔与月份标题年份推断。
  return explicitDates(evidence?.content || '').includes(date);
}

function sourceKey(source) {
  return canonicalizeUrl(source?.url) || String(source?.url || '').trim();
}

function sourceProjection(evidence) {
  return {
    title: String(evidence.title || '').trim(),
    url: canonicalizeUrl(evidence.url),
  };
}

function trustedRootsForRepair(detail, repair) {
  return officialRootsOf({
    official_url: detail.official_url,
    discovery_sources: (repair.official_roots || []).map(url => ({ kind: 'official_hint', url })),
  });
}

function cloneSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

function invalid(code, error, details = {}) {
  return { ok: false, code, error, ...details };
}

function dateRepairPreview(before, after, detailId, targetField, evidence, mode = 'fill_missing') {
  return {
    kind: 'catalog_date_repair',
    mode,
    detail_id: detailId,
    target_field: targetField,
    before: { value: before[targetField] || null, sources: before.sources || [] },
    after: { value: after[targetField], sources: after.sources || [] },
    evidence: sourceProjection(evidence),
  };
}

function planDateRepair(snapshot, repair = {}) {
  const detailId = String(repair.detail_id || '').trim();
  const date = String(repair.date || '').trim();
  const mode = repair.mode || 'fill_missing';
  const evidence = repair.evidence || {};
  if (!DATE_REPAIR_MODES.includes(mode)) return invalid('DATE_REPAIR_MODE_INVALID', '不支持的日期修补模式', { detail_id: detailId, mode });
  if (!detailId) return invalid('DATE_REPAIR_DETAIL_REQUIRED', '缺少 tool-level3 详情 ID');
  if (!isIsoDate(date)) return invalid('DATE_REPAIR_DATE_INVALID', '日期必须是有效 YYYY-MM-DD', { detail_id: detailId });

  const details = snapshot?.['tool-level3'];
  const index = Array.isArray(details) ? details.findIndex(item => item?.id === detailId) : -1;
  if (index < 0) return invalid('DATE_REPAIR_DETAIL_NOT_FOUND', '未找到三级详情', { detail_id: detailId });

  const before = details[index];
  const targetField = dateFieldForDetail(before);
  if (!targetField) return invalid('DATE_REPAIR_NOT_APPLICABLE', 'subscription_plan 不适用公开日期', { detail_id: detailId });
  if (mode === 'advance_update') {
    if (before.detail_kind !== 'tool' || targetField !== 'last_updated_date') {
      return invalid('DATE_REPAIR_ADVANCE_ONLY_TOOL', 'advance_update 只允许 tool.last_updated_date', { detail_id: detailId, target_field: targetField });
    }
    if (!isIsoDate(before[targetField])) {
      return invalid('DATE_REPAIR_ADVANCE_CURRENT_DATE_REQUIRED', 'advance_update 要求当前已有有效 last_updated_date', { detail_id: detailId });
    }
    if (date <= before[targetField]) {
      return invalid('DATE_REPAIR_DATE_NOT_FORWARD', '新日期必须严格晚于当前 last_updated_date', { detail_id: detailId, current_date: before[targetField], date });
    }
    const asOf = String(repair.as_of || repair.now || new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (isIsoDate(asOf) && date > asOf) {
      return invalid('DATE_REPAIR_DATE_IN_FUTURE', '新日期不能晚于 Apply/扫描日期', { detail_id: detailId, as_of: asOf, date });
    }
  } else if (before[targetField]) {
    return invalid('DATE_REPAIR_ALREADY_PRESENT', '目标日期字段已有值，拒绝覆盖', { detail_id: detailId, target_field: targetField });
  }
  if (repair.target_field && repair.target_field !== targetField) {
    return invalid('DATE_REPAIR_TARGET_MISMATCH', `该详情只允许修补 ${targetField}`, { detail_id: detailId, target_field: targetField });
  }

  const source = sourceProjection(evidence);
  if (!source.title || !source.url) return invalid('DATE_REPAIR_EVIDENCE_INVALID', '官方证据必须包含 title 和 URL', { detail_id: detailId });
  const roots = trustedRootsForRepair(before, repair);
  if (!isTrustedOfficialUrl(source.url, roots)) {
    return invalid('DATE_REPAIR_SOURCE_UNTRUSTED', '证据 URL 不属于该详情官方根域', { detail_id: detailId, url: source.url });
  }
  if (!evidenceSupportsDate(evidence, date)) {
    return invalid('DATE_REPAIR_DATE_NOT_IN_EVIDENCE', '官方正文或发布时间 metadata 未包含该完整日期', { detail_id: detailId, date });
  }

  const target = cloneSnapshot(snapshot);
  const after = { ...before, [targetField]: date };
  const existingSources = Array.isArray(before.sources) ? before.sources : [];
  after.sources = existingSources.some(item => sourceKey(item) === sourceKey(source))
    ? existingSources
    : [...existingSources, source];
  target['tool-level3'][index] = after;

  const validation = validateCatalogSnapshot(target);
  if (!validation.ok) return invalid('DATE_REPAIR_SNAPSHOT_INVALID', '日期修补后的目录不符合契约', { errors: validation.errors });

  const preview = dateRepairPreview(before, after, detailId, targetField, evidence, mode);
  return {
    ok: true,
    mode,
    detail_id: detailId,
    target_field: targetField,
    date,
    source,
    before_revision: revisionOf(snapshot),
    target_revision: revisionOf(target),
    preview,
    preview_hash: previewHashOf(preview),
    snapshot: target,
  };
}

function planDateRepairBatch(snapshot, repairs = [], options = {}) {
  if (!Array.isArray(repairs) || !repairs.length) return invalid('DATE_REPAIR_BATCH_EMPTY', '批量日期修补至少需要一条 repair');
  const beforeRevision = revisionOf(snapshot);
  const seen = new Set();
  let working = cloneSnapshot(snapshot);
  const plans = [];
  const asOf = options.asOf || options.now;

  for (let index = 0; index < repairs.length; index += 1) {
    const repair = repairs[index] || {};
    const detailId = String(repair.detail_id || '').trim();
    if (seen.has(detailId)) return invalid('DATE_REPAIR_BATCH_DUPLICATE_DETAIL', '同一批不能重复修补同一详情', { index, detail_id: detailId });
    seen.add(detailId);
    const planned = planDateRepair(working, {
      ...repair,
      mode: repair.mode || 'advance_update',
      ...(asOf ? { as_of: asOf } : {}),
    });
    if (!planned.ok) {
      return invalid('DATE_REPAIR_BATCH_ITEM_INVALID', '批量日期修补包含不合格条目', {
        index,
        detail_id: detailId,
        item_code: planned.code,
        item_error: planned.error,
      });
    }
    working = planned.snapshot;
    plans.push(planned);
  }

  const originalDetails = new Map((snapshot?.['tool-level3'] || []).map(item => [item.id, item]));
  const targetIds = new Set(plans.map(plan => plan.detail_id));
  for (const plan of plans) {
    const before = originalDetails.get(plan.detail_id);
    const after = working['tool-level3'].find(item => item.id === plan.detail_id);
    if (!before || !after || nonDateDetailFingerprint(before, plan.target_field) !== nonDateDetailFingerprint(after, plan.target_field)) {
      return invalid('DATE_REPAIR_BATCH_NON_DATE_DRIFT', '批量日期修补产生非日期字段漂移', { detail_id: plan.detail_id });
    }
  }
  for (const area of Object.keys(snapshot || {})) {
    if (area === 'tool-level3') continue;
    if (stableStringify(snapshot[area]) !== stableStringify(working[area])) {
      return invalid('DATE_REPAIR_BATCH_NON_DATE_DRIFT', '批量日期修补改变了非三级目录区域', { area });
    }
  }
  for (const item of snapshot?.['tool-level3'] || []) {
    if (!targetIds.has(item.id)) {
      const after = working['tool-level3'].find(candidate => candidate.id === item.id);
      if (stableStringify(item) !== stableStringify(after)) {
        return invalid('DATE_REPAIR_BATCH_NON_DATE_DRIFT', '批量日期修补改变了未目标详情', { detail_id: item.id });
      }
    }
  }

  const modes = new Set(plans.map(plan => plan.mode));
  const batchMode = modes.size === 1 ? [...modes][0] : 'advance_update';
  const preview = {
    kind: 'catalog_date_repair_batch',
    mode: batchMode,
    before_revision: beforeRevision,
    target_revision: revisionOf(working),
    changes: plans.map(plan => plan.preview),
  };
  return {
    ok: true,
    mode: batchMode,
    count: plans.length,
    before_revision: beforeRevision,
    target_revision: revisionOf(working),
    changes: plans.map(plan => ({
      detail_id: plan.detail_id,
      target_field: plan.target_field,
      date: plan.date,
      source: plan.source,
      preview: plan.preview,
    })),
    preview,
    preview_hash: previewHashOf(preview),
    snapshot: working,
  };
}

function reviewEvidenceOf(item) {
  return {
    product_key: item?.product_key || null,
    detail_id: item?.evidence_detail_id || item?.detail_id || null,
    source_type: item?.source_type || null,
    collector: item?.collector || null,
    title: item?.evidence?.title || item?.source_url || '',
    url: item?.source_url || '',
    content: item?.evidence?.excerpt || '',
    excerpt: item?.evidence?.excerpt || '',
    official_published_at: item?.evidence?.official_published_at || null,
    content_hash: item?.evidence?.content_hash || null,
    status: item?.evidence?.status || null,
  };
}

function reviewItemRepairOf(item, snapshot, registry, options = {}) {
  if (!item || item.review_status !== 'approved') return invalid('DATE_REPAIR_REVIEW_NOT_APPROVED', '审核条目不是 approved', { candidate_key: item?.candidate_key });
  if (item.status !== 'candidate' || (item.blocked_reasons || []).length) {
    return invalid('DATE_REPAIR_REVIEW_BLOCKED', '审核条目存在阻断理由，不能 Apply', { candidate_key: item.candidate_key });
  }
  const detail = (snapshot?.['tool-level3'] || []).find(detailItem => detailItem.id === item.detail_id);
  if (!detail) return invalid('DATE_REPAIR_DETAIL_NOT_FOUND', '审核条目对应详情不存在', { detail_id: item.detail_id });
  const evidence = reviewEvidenceOf(item);
  const revalidated = planToolUpdateCandidate(item.product_key, evidence, item.ai_suggestion, {
    registry,
    detail,
    now: options.asOf || options.now,
  });
  if (!revalidated.ok || revalidated.candidate.candidate_key !== item.candidate_key) {
    return invalid('DATE_REPAIR_REVIEW_CONFLICT', '审核条目与当前 registry/catalog 不一致', {
      candidate_key: item.candidate_key,
      blocked_reasons: revalidated.blocked_reasons,
      current_candidate_key: revalidated.candidate?.candidate_key || null,
    });
  }
  return {
    ok: true,
    repair: {
      detail_id: item.detail_id,
      date: item.proposed_date,
      mode: isIsoDate(detail.last_updated_date) ? 'advance_update' : 'fill_missing',
      target_field: 'last_updated_date',
      as_of: options.asOf || options.now,
      official_roots: [item.source_url],
      evidence,
      candidate_key: item.candidate_key,
    },
  };
}

function approvedRepairsFromReviewQueue(snapshot, options = {}) {
  const registry = options.registry || loadProductUrlRegistry();
  const queue = options.reviewQueue || readReviewQueue(options.reviewFile);
  const requestedKeys = Array.isArray(options.candidateKeys) && options.candidateKeys.length
    ? new Set(options.candidateKeys.map(String))
    : null;
  const items = (queue.items || []).filter(item => item.review_status === 'approved'
    && (!requestedKeys || requestedKeys.has(String(item.candidate_key))));
  if (!items.length) return invalid('DATE_REPAIR_NO_APPROVED_ITEMS', '审核队列没有可 Apply 的 approved 条目');
  const repairs = [];
  for (const item of items) {
    const result = reviewItemRepairOf(item, snapshot, registry, options);
    if (!result.ok) return result;
    repairs.push(result.repair);
  }
  return { ok: true, repairs, items };
}

function applyDateRepairBatch(repairs, options = {}) {
  const current = options.snapshot ? { snapshot: options.snapshot, revision: revisionOf(options.snapshot) } : loadCatalogSnapshot();
  if (!options.expectedRevision) return invalid('DATE_REPAIR_EXPECTED_REVISION_REQUIRED', 'Apply 必须提供 expected revision');
  if (current.revision !== options.expectedRevision) return invalid('REVISION_CONFLICT', '目录 revision 已变化', { revision: current.revision });
  if (!options.previewHash) return invalid('DATE_REPAIR_PREVIEW_REQUIRED', '批量 Apply 必须提供 preview hash');

  const approved = approvedRepairsFromReviewQueue(current.snapshot, {
    ...options,
    candidateKeys: Array.isArray(repairs) && repairs.length ? repairs.map(repair => repair.candidate_key).filter(Boolean) : options.candidateKeys,
  });
  if (!approved.ok) return approved;
  const planned = planDateRepairBatch(current.snapshot, approved.repairs, options);
  if (!planned.ok) return planned;
  if (planned.preview_hash !== options.previewHash) {
    return invalid('DATE_REPAIR_PREVIEW_CONFLICT', '批量预览内容已变化，需重新 Review', { preview_hash: planned.preview_hash });
  }
  const commit = options.commitSnapshotChange || commitSnapshotChange;
  const committed = commit(planned.snapshot, {
    expectedRevision: current.revision,
    operation: 'catalog-date-repair-batch',
    runId: options.runId,
  });
  return committed.ok
    ? { ...committed, count: planned.count, preview_hash: planned.preview_hash, changes: planned.changes }
    : committed;
}
function applyDateRepair(repair, options = {}) {
  const current = options.snapshot ? { snapshot: options.snapshot, revision: revisionOf(options.snapshot) } : loadCatalogSnapshot();
  if (!options.expectedRevision) return invalid('DATE_REPAIR_EXPECTED_REVISION_REQUIRED', 'Apply 必须提供 expected revision');
  if (current.revision !== options.expectedRevision) return invalid('REVISION_CONFLICT', '目录 revision 已变化', { revision: current.revision });
  const planned = planDateRepair(current.snapshot, repair);
  if (!planned.ok) return planned;
  if (options.previewHash && options.previewHash !== planned.preview_hash) {
    return invalid('DATE_REPAIR_PREVIEW_CONFLICT', '预览内容已变化，需重新 Review', { preview_hash: planned.preview_hash });
  }
  const commit = options.commitSnapshotChange || commitSnapshotChange;
  const committed = commit(planned.snapshot, {
    expectedRevision: current.revision,
    operation: 'catalog-date-repair',
  });
  return committed.ok
    ? { ...committed, detail_id: planned.detail_id, target_field: planned.target_field, date: planned.date, preview_hash: planned.preview_hash }
    : committed;
}

function nonDateDetailFingerprint(detail, targetField) {
  const copy = { ...detail };
  delete copy[targetField];
  delete copy.sources;
  return stableStringify(copy);
}

module.exports = {
  TARGET_FIELD_BY_KIND,
  DATE_REPAIR_MODES,
  isIsoDate,
  dateFieldForDetail,
  officialDateOf,
  evidenceSupportsDate,
  nonDateDetailFingerprint,
  planDateRepair,
  planDateRepairBatch,
  approvedRepairsFromReviewQueue,
  applyDateRepair,
  applyDateRepairBatch,
};
