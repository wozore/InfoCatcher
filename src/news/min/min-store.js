/**
 * min-store.js —— 热点管线 v2 候选层（单状态轴）
 *
 * 在热点管线中的位置：v2 审核（review-v2）落地后、每日公开投影
 * （daily-projection）之前。与 v2 审核/评分层同属独立数据通道，
 * **不依赖旧版候选层的双状态轴（ai_processing_status / review_status 双轴），
 * 只用单状态轴**：
 *   review_status = 'pending'（保留，待人工）| 'approved'（人工通过）| 'discarded'（剔除）
 *
 * 数据文件：data/news/runtime/min-candidates.json（不发布到 dist/）
 *   schema:
 *     { schema_version: 1, updated_at: <ISO>|null,
 *       candidates: [ { ...item, review_status, reviewed_at, ai_advice } ] }
 *
 * 合并语义：新条目按 id 覆盖内容字段；已存在条目**保留既有 review_status**，
 * 人工审核结论不因重新采集被重置（与 v1 mergeCandidates 的决策 55/70 审计语义一致）；
 * reviewed_at 由人工审核写入，重新采集不携带 → 同样保留；ai_advice / l1_review
 * 本轮有新的（incoming 已生成）则保留新的，否则保留既有。
 *
 * 本模块只提供纯函数与存储读写，不发起网络请求、不消费额度。
 */

'use strict';

const { readJson, writeJsonAtomic } = require('../core/news-storage');
const { NEWS_FILES } = require('../../shared/paths');

const MIN_CANDIDATES_PATH = NEWS_FILES.minCandidates;

// 单状态轴合法取值（决策：v2 不再有 ai_processing_status 轴）
const MIN_REVIEW_STATUSES = Object.freeze(['pending', 'approved', 'discarded']);

// 新候选缺省进入待审核
const DEFAULT_REVIEW_STATUS = 'pending';

// 候选层中绝不进入公开投影的内部字段（审核痕迹 / AI 建议 / 剔除原因）。
const MIN_INTERNAL_FIELDS = Object.freeze([
  'review_status', 'reviewed_at', 'ai_advice', 'l1_review', 'discard_stage', 'discard_reason',
  'localizations_meta',
]);

// 公开条目保留的字段（v2 公开契约）：final_score / score_breakdown 是内部评分
// 输入，不进公开；公开热分 hot_score / evidence_excerpt / related_resources 由
// 编排层后续 enrichHotspotProjection 补充，这里白名单保留已存在的值。
const MIN_PUBLIC_FIELDS = Object.freeze([
  'id', 'platform', 'native_id', 'content_type', 'url', 'title', 'description',
  'published_at', 'fetched_at', 'author_id', 'author_name', 'source_id',
  'language', 'source_tags', 'thumbnail', 'metrics', 'explicit_links',
  'hot_score', 'evidence_excerpt', 'related_resources', 'source_type', 'category', 'comments',
  'summary', 'summary_key_points', 'localizations',
]);

const EMPTY_STORE = Object.freeze({ schema_version: 1, updated_at: null, candidates: [] });

/** 规范化为合法 store（浅拷贝 candidates 数组；空/非法输入回退空 store）。 */
function createMinStore(existing) {
  if (existing && Array.isArray(existing.candidates)) {
    return {
      schema_version: existing.schema_version || 1,
      updated_at: existing.updated_at || null,
      candidates: [...existing.candidates],
    };
  }
  return { ...EMPTY_STORE, candidates: [] };
}

/** 读候选层；文件不存在时返回空 store（{schema_version:1, updated_at:null, candidates:[]}）。 */
function readMinStore() {
  return createMinStore(readJson(MIN_CANDIDATES_PATH, null));
}

/** 原子写回候选层。 */
function writeMinStore(store, runId = 'min') {
  writeJsonAtomic(MIN_CANDIDATES_PATH, store, runId);
}

/** 校验 review_status 为单状态轴合法枚举（pending/approved/discarded）。 */
function assertValidReviewStatusMin(status) {
  if (!MIN_REVIEW_STATUSES.includes(status)) {
    throw new Error(`非法审核状态：${status}。合法值：${MIN_REVIEW_STATUSES.join(' / ')}`);
  }
}

/**
 * 合并候选到 v2 候选层：
 *   - 新条目按 id 覆盖内容字段；缺 review_status 的以 pending 进入（等待人工审核）；
 *   - 已存在条目保留既有 review_status（不重置人工审核结论）；
 *   - 返回合并后的 store（有实际变更时刷新 updated_at）。
 */
function mergeCandidatesMin(store, items) {
  const next = createMinStore(store);
  const byId = new Map(next.candidates.map(candidate => [candidate.id, candidate]));
  let changed = 0;
  for (const incoming of items || []) {
    if (!incoming || !incoming.id) continue;
    const prev = byId.get(incoming.id);
    if (prev) {
      // 已存在条目：人工审核结论不被重新采集覆盖。
      if (prev.review_status !== undefined) incoming.review_status = prev.review_status;
      // top_selected（第二阶段：维护者从 AI 待选项确认显示）不被重新采集重置。
      if (prev.top_selected !== undefined) incoming.top_selected = prev.top_selected;
      // reviewed_at 由人工审核写入，重新采集不携带 → 保留既有值。
      if (prev.reviewed_at !== undefined && incoming.reviewed_at === undefined) {
        incoming.reviewed_at = prev.reviewed_at;
      }
      // ai_advice / l1_review：本轮已有新的（incoming 已生成）则保留新的，否则保留既有。
      if (prev.ai_advice && incoming.ai_advice === undefined) incoming.ai_advice = prev.ai_advice;
      if (prev.l1_review && incoming.l1_review === undefined) incoming.l1_review = prev.l1_review;
    } else {
      // 新条目缺省以 pending 进入待审核；top_selected 默认 false（尚未被选中显示）。
      if (incoming.review_status === undefined) incoming.review_status = DEFAULT_REVIEW_STATUS;
      if (incoming.top_selected === undefined) incoming.top_selected = false;
    }
    byId.set(incoming.id, incoming);
    changed += 1;
  }
  if (changed > 0) {
    next.candidates = [...byId.values()];
    next.updated_at = new Date().toISOString();
  }
  return next;
}

/**
 * 单条设置审核状态：仅 pending/approved/discarded 合法，写入 reviewed_at。
 * 未命中 id 或非法枚举时抛错，不做部分写入。
 * @returns {{ store, updated }} updated 恒为 1（未命中已抛错）。
 */
function setReviewStatusMin(store, id, status) {
  assertValidReviewStatusMin(status);
  const next = createMinStore(store);
  const candidate = next.candidates.find(item => item.id === id);
  if (!candidate) throw new Error(`候选不存在：${id}`);
  candidate.review_status = status;
  candidate.reviewed_at = new Date().toISOString();
  return { store: next, updated: 1 };
}

/**
 * 批量设置审核状态：只处理显式列出的 ids，不做隐式范围；
 * 未命中 id 汇入 missing（不抛错），命中则更新状态并记录 reviewed_at。
 * @returns {{ store, updated, missing }}
 */
function setBatchReviewStatusMin(store, ids, status) {
  assertValidReviewStatusMin(status);
  const next = createMinStore(store);
  const missing = [];
  let updated = 0;
  for (const id of ids || []) {
    const candidate = next.candidates.find(item => item.id === id);
    if (!candidate) { missing.push(id); continue; }
    candidate.review_status = status;
    candidate.reviewed_at = new Date().toISOString();
    updated += 1;
  }
  return { store: next, updated, missing };
}

/** 公开资格门禁（单状态轴）：仅人工 approved 可进入公开投影。 */
function isMinPublicEligible(candidate) {
  return Boolean(candidate && candidate.review_status === 'approved');
}

/**
 * 批量设置"被选中显示"标记（第二阶段：维护者从 AI 待选项里确认最终前端显示）。
 * 只处理显式列出的 ids；未命中 id 汇入 missing（不抛错）。top_selected 默认 false，
 * 维护者从 ai-top 待选项确认后置 true → 公开投影只取 approved && top_selected。
 * @returns {{ store, updated, missing }}
 */
function setTopSelectedMin(store, ids, selected) {
  const next = createMinStore(store);
  const missing = [];
  let updated = 0;
  for (const id of ids || []) {
    const candidate = next.candidates.find(item => item.id === id);
    if (!candidate) { missing.push(id); continue; }
    candidate.top_selected = selected === true;
    updated += 1;
  }
  return { store: next, updated, missing };
}

/**
 * 公开资格门禁（公开投影用）：仅 approved 且 top_selected（维护者最终选中显示）。
 * 第二阶段语义：review_status=approved 表示审核通过（进待选项池），
 * top_selected=true 表示被选中显示在前端（每日 3~5/3~8）。
 */
function isMinDisplayEligible(candidate) {
  return Boolean(candidate && candidate.review_status === 'approved' && candidate.top_selected === true);
}

/**
 * 公开投影剔除内部字段（审核痕迹 / AI 建议 / 剔除原因不进公开）。
 * 按 MIN_PUBLIC_FIELDS 白名单保留公开契约字段（final_score 等内部评分不进公开），
 * 并对 MIN_INTERNAL_FIELDS 做防御性二次剔除。
 */
function toPublicItemMin(candidate) {
  if (!candidate) return candidate;
  const publicItem = {};
  for (const key of MIN_PUBLIC_FIELDS) {
    if (candidate[key] !== undefined) publicItem[key] = candidate[key];
  }
  for (const key of MIN_INTERNAL_FIELDS) delete publicItem[key];
  return publicItem;
}

module.exports = {
  MIN_CANDIDATES_PATH,
  MIN_REVIEW_STATUSES,
  DEFAULT_REVIEW_STATUS,
  MIN_INTERNAL_FIELDS,
  MIN_PUBLIC_FIELDS,
  createMinStore,
  readMinStore,
  writeMinStore,
  assertValidReviewStatusMin,
  mergeCandidatesMin,
  setReviewStatusMin,
  setBatchReviewStatusMin,
  setTopSelectedMin,
  isMinPublicEligible,
  isMinDisplayEligible,
  toPublicItemMin,
};
