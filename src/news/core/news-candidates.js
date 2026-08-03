/**
 * news-candidates.js —— 内部候选层与公开资格门禁（B16 决策 49/69）
 *
 * 在热点管线中的位置：介于“采集/评分产物”与“公开 hotspots.json”之间。
 *
 * ═══════════════════════════════════════════════════════════════
 * 两层数据流程（决策 49）：
 * ═══════════════════════════════════════════════════════════════
 *
 *   采集 → 评分/溯源 → 内部候选层（data/news/runtime/hotspot-candidates.json）
 *                              ↓ 公开资格过滤（本模块）
 *                    公开 hotspots.json（data/news/output/hotspots.json）
 *
 * 内部候选层不发布到 dist/，浏览器不直接读取（见 scripts/build-dist.js：
 * 只拷贝 data/catalog 与 data/news/output，不拷贝 data/news/runtime）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 双状态轴（决策 16/48/57/69）：
 * ═══════════════════════════════════════════════════════════════
 *   ai_processing_status —— AI 处理流程是否成功完成（系统状态）
 *     not_requested / queued / processing / completed / error
 *   review_status        —— 人工审核结论（人的决定）
 *     pending / approved / held / discarded
 *
 * 系统失败（error）与人工决定（discarded）分属不同状态轴，互不混淆。
 * 公开资格门禁（决策 69）：仅当
 *     ai_processing_status === 'completed' 且 review_status === 'approved'
 * 时，候选才可进入公开 hotspots.json。
 *
 * 桥接默认：人工审核流程（决策 46–60）尚未落地，新候选暂以
 * completed / approved 写入，保留现有公开行为；审核流上线后改由
 * 管理者逐条设置 review_status。
 *
 * 本模块只提供纯函数与存储读写，不发起网络请求、不消费额度。
 */

'use strict';

const { readJson, writeJsonAtomic } = require('./news-storage');
const { NEWS_FILES } = require('../../shared/paths');

const CANDIDATES_PATH = NEWS_FILES.candidates;

// 决策 16/57：AI 处理状态轴
const AI_PROCESSING_STATUSES = Object.freeze([
  'not_requested', 'queued', 'processing', 'completed', 'error',
]);

// 决策 16/48：人工审核状态轴
const REVIEW_STATUSES = Object.freeze([
  'pending', 'approved', 'held', 'discarded',
]);

// 桥接默认（见文件头注释）：审核流上线后由 pipeline 改为 pending。
const DEFAULT_AI_PROCESSING_STATUS = 'completed';
const DEFAULT_REVIEW_STATUS = 'approved';

function createCandidateStore(existing) {
  if (existing && Array.isArray(existing.candidates)) {
    const store = {
      schema_version: existing.schema_version || 1,
      updated_at: existing.updated_at || null,
      candidates: [...existing.candidates],
    };
    // 决策 49/59：候选层保留重建公开投影所需的关联记录快照（可选，向后兼容）
    if (existing.events) store.events = existing.events;
    if (existing.provenance) store.provenance = existing.provenance;
    if (existing.assessments) store.assessments = existing.assessments;
    if (existing.coverage) store.coverage = existing.coverage;
    if (existing.heat_definition) store.heat_definition = existing.heat_definition;
    return store;
  }
  return { schema_version: 1, updated_at: null, candidates: [] };
}

/**
 * 为单条候选写入双状态轴默认值（新候选用）。
 * overrides 用于测试或审核流注入显式状态。
 */
function stampCandidateStatuses(item, overrides = {}) {
  return {
    ...item,
    ai_processing_status: overrides.ai_processing_status || DEFAULT_AI_PROCESSING_STATUS,
    review_status: overrides.review_status || DEFAULT_REVIEW_STATUS,
  };
}

/**
 * 合并候选到内部候选层：
 *   - 新候选按 id 覆盖内容字段；
 *   - 已存在的候选保留既有 review_status / ai_processing_status，
 *     避免重新采集时重置人工审核结论（决策 55/70 的审计语义）。
 * 候选层按 id 积累（决策 49：保留全部候选），公开窗口由公开资格门禁与
 * pipeline 的 retention 逻辑共同约束，历史候选不会因积累而回流公开。
 */
function mergeCandidates(existingStore, incomingCandidates, updatedAt) {
  const store = createCandidateStore(existingStore);
  const byId = new Map(store.candidates.map(candidate => [candidate.id, candidate]));
  for (const incoming of incomingCandidates || []) {
    if (!incoming || !incoming.id) continue;
    const prev = byId.get(incoming.id);
    if (prev) {
      if (prev.review_status !== undefined) incoming.review_status = prev.review_status;
      if (prev.ai_processing_status !== undefined) incoming.ai_processing_status = prev.ai_processing_status;
    }
    byId.set(incoming.id, incoming);
  }
  store.candidates = [...byId.values()];
  store.updated_at = updatedAt || store.updated_at;
  return store;
}

/** 公开资格门禁（决策 69）：AI 处理完成 + 人工审核通过。 */
function isPublicEligible(candidate) {
  return Boolean(
    candidate &&
    candidate.ai_processing_status === 'completed' &&
    candidate.review_status === 'approved'
  );
}

/** 从候选数组中筛出合格公开项。 */
function selectPublicEligible(candidates) {
  return (candidates || []).filter(isPublicEligible);
}

/**
 * 公开投影剔除内部状态字段（决策 77：不在公开卡片展示审核/处理状态、
 * AI 置信度、重试次数等内部信息）。
 */
function toPublicItem(candidate) {
  if (!candidate) return candidate;
  const { review_status, ai_processing_status, ...publicItem } = candidate;
  return publicItem;
}

/**
 * 过滤 events / provenance / assessments，只保留引用到合格候选的记录。
 * idKey 为数组时（events.content_ids）取任一命中，为标量时直接命中。
 */
function filterRelatedByIds(records, contentIds, idKey) {
  const ids = contentIds || new Set();
  return (records || []).filter(record => {
    const value = record ? record[idKey] : undefined;
    if (Array.isArray(value)) return value.some(id => ids.has(id));
    return ids.has(value);
  });
}

/**
 * 从候选构建公开投影（schema_version=2，与既有前端契约一致）。
 * candidates 应为“本轮 pipeline 的 items 加上状态轴”的候选集合；
 * 公开 items 仅包含通过门禁的候选，并剔除内部状态字段。
 * heatDefinition 由 pipeline 传入，与既有热点定义文案保持一致。
 */
function buildPublicProjection({
  candidates, events, provenance, assessments, coverage,
  generatedAt, heatDefinition,
}) {
  const eligible = selectPublicEligible(candidates);
  const ids = new Set(eligible.map(candidate => candidate.id));
  return {
    schema_version: 2,
    generated_at: generatedAt,
    heat_definition: heatDefinition,
    items: eligible.map(toPublicItem),
    events: filterRelatedByIds(events, ids, 'content_ids'),
    provenance: filterRelatedByIds(provenance, ids, 'content_id'),
    assessments: filterRelatedByIds(assessments, ids, 'content_id'),
    coverage,
  };
}

// ═══════════════════════════════════════════════════════════════
// 审核状态操作（决策 48/50/55/56/57/69）
//
// 说明：本模块只负责状态值与状态流转的合法性，不写完整审计字段
// （reviewer / reviewed_at / from_status / candidate_version / batch_id）
// 与追加式审核日志 —— 那些属决策 70 的后续实现范围。
// ═══════════════════════════════════════════════════════════════

/** 校验 review_status 为合法枚举（决策 48）。 */
function assertValidReviewStatus(status) {
  if (!REVIEW_STATUSES.includes(status)) {
    throw new Error(`非法审核状态：${status}。合法值：${REVIEW_STATUSES.join(' / ')}`);
  }
}

/**
 * 非法组合校验（决策 69）：AI 处理未完成时禁止标记为 approved。
 * 系统失败（error）与人工决定（discarded）分属不同状态轴，互不覆盖。
 */
function assertCanApprove(candidate) {
  if (!candidate) throw new Error('候选不存在，无法设置状态');
  if (candidate.ai_processing_status !== 'completed') {
    throw new Error(
      `候选 ${candidate.id} 的 ai_processing_status 为 ${candidate.ai_processing_status}，` +
      'AI 处理未完成，不能设为 approved（决策 69）'
    );
  }
}

/**
 * 单条设置审核状态（决策 55/48）。
 * 写入 review_status 与可选 review_reason；返回更新后的 store。
 * 未命中 id 或非法组合时抛错，不做部分写入。
 */
function setReviewStatus(store, id, status, { reason } = {}) {
  assertValidReviewStatus(status);
  const next = createCandidateStore(store);
  const candidate = next.candidates.find(item => item.id === id);
  if (!candidate) throw new Error(`候选不存在：${id}`);
  if (status === 'approved') assertCanApprove(candidate);
  candidate.review_status = status;
  if (reason) candidate.review_reason = reason;
  return next;
}

/**
 * 批量设置审核状态（决策 56）：只处理显式列出的 ids，不做隐式范围
 * （不支持「当前筛选结果全部通过」）。逐条报告未命中与被拒绝的候选，
 * 一条失败不覆盖其他候选的结果。
 */
function setBatchReviewStatus(store, ids, status, { reason } = {}) {
  assertValidReviewStatus(status);
  const next = createCandidateStore(store);
  const missing = [];
  const blocked = [];
  let updated = 0;
  for (const id of ids || []) {
    const candidate = next.candidates.find(item => item.id === id);
    if (!candidate) { missing.push(id); continue; }
    if (status === 'approved') {
      try { assertCanApprove(candidate); }
      catch (error) { blocked.push({ id, reason: error.message }); continue; }
    }
    candidate.review_status = status;
    if (reason) candidate.review_reason = reason;
    updated += 1;
  }
  return { store: next, updated, missing, blocked };
}

/**
 * 决策 50：标记 held（保留 = 内部暂存、后续复审、不公开），记录 hold_reason。
 * 仅修改 review_status，不影响 ai_processing_status。
 */
function markHeld(candidate, { reason } = {}) {
  if (!candidate) throw new Error('候选不存在');
  candidate.review_status = 'held';
  if (reason) candidate.hold_reason = reason;
  return candidate;
}

/**
 * 决策 57：标记 AI 处理失败（ai_processing_status = error），
 * 记录 error_type / retryable / retry_count。不覆盖 review_status，
 * 系统失败与人工决定保持独立。
 */
function markAiError(candidate, { errorType, retryable = true, retryCount = 0 } = {}) {
  if (!candidate) throw new Error('候选不存在');
  candidate.ai_processing_status = 'error';
  if (errorType) candidate.error_type = errorType;
  candidate.retryable = Boolean(retryable);
  candidate.retry_count = Number(retryCount) || 0;
  return candidate;
}

/** 候选层状态分布统计（供 CLI list / 审核 PR body 使用）。 */
function reviewSummary(store) {
  const summary = {
    total: 0,
    by_review_status: {},
    by_ai_processing_status: {},
  };
  for (const candidate of store?.candidates || []) {
    summary.total += 1;
    summary.by_review_status[candidate.review_status] =
      (summary.by_review_status[candidate.review_status] || 0) + 1;
    summary.by_ai_processing_status[candidate.ai_processing_status] =
      (summary.by_ai_processing_status[candidate.ai_processing_status] || 0) + 1;
  }
  return summary;
}

// ═══════════════════════════════════════════════════════════════
// 候选层投影快照与重建（决策 49/59）
//
// 采集时把重建公开投影所需的关联记录（events/provenance/assessments/
// coverage）与热度定义存入候选层；PR 合并后由 Actions 从候选层重建
// 最终公开 hotspots.json，不再依赖采集时的输出快照。
// ═══════════════════════════════════════════════════════════════

/**
 * 采集时把重建公开投影所需的关联记录存入候选层。
 * 只设置、不清除，避免误删历史快照。
 */
function attachProjectionSnapshot(store, { events, provenance, assessments, coverage, heatDefinition } = {}) {
  if (!store) throw new Error('候选层不存在');
  if (events) store.events = events;
  if (provenance) store.provenance = provenance;
  if (assessments) store.assessments = assessments;
  if (coverage) store.coverage = coverage;
  if (heatDefinition) store.heat_definition = heatDefinition;
  return store;
}

/**
 * 从候选层快照重建公开投影（决策 59）。候选按公开资格门禁过滤，
 * 关联事件/溯源/评分只保留引用到合格候选的记录；公开项剔除内部状态字段。
 * generatedAt 缺省时回退到候选层 updated_at。
 */
function buildProjectionFromStore(store, { generatedAt } = {}) {
  const eligible = selectPublicEligible(store?.candidates || []);
  const ids = new Set(eligible.map(candidate => candidate.id));
  return {
    schema_version: 2,
    generated_at: generatedAt || store?.updated_at || null,
    heat_definition: store?.heat_definition || null,
    items: eligible.map(toPublicItem),
    events: filterRelatedByIds(store?.events, ids, 'content_ids'),
    provenance: filterRelatedByIds(store?.provenance, ids, 'content_id'),
    assessments: filterRelatedByIds(store?.assessments, ids, 'content_id'),
    coverage: store?.coverage || null,
  };
}

function readCandidateStore() {
  return createCandidateStore(readJson(CANDIDATES_PATH, null));
}

function writeCandidateStore(store, runId) {
  writeJsonAtomic(CANDIDATES_PATH, store, runId);
}

module.exports = {
  CANDIDATES_PATH,
  AI_PROCESSING_STATUSES,
  REVIEW_STATUSES,
  DEFAULT_AI_PROCESSING_STATUS,
  DEFAULT_REVIEW_STATUS,
  createCandidateStore,
  stampCandidateStatuses,
  mergeCandidates,
  isPublicEligible,
  selectPublicEligible,
  toPublicItem,
  buildPublicProjection,
  assertValidReviewStatus,
  assertCanApprove,
  setReviewStatus,
  setBatchReviewStatus,
  markHeld,
  markAiError,
  reviewSummary,
  attachProjectionSnapshot,
  buildProjectionFromStore,
  readCandidateStore,
  writeCandidateStore,
};
