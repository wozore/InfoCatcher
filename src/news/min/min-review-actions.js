/**
 * min-review-actions.js —— v2 候选层的审核 / top / 字幕 mutation 与公开资格门禁。
 *
 * 全部为纯 mutation（返回 { store, ... }，不做 I/O），落盘经 min-store.commitMinStoreMutation。
 * 语义基线：只有 pending 候选可被审核流转；只有 approved 候选可被显式 set/unset
 * top_selected；字幕写入与字幕总结写回同样只面向 approved 候选。
 */

'use strict';

const {
  MIN_INTERNAL_FIELDS,
  MIN_PUBLIC_FIELDS,
  MIN_REVIEW_STATUSES,
  assertExpectedMinRevision,
  createMinStore,
  revisionOfMinStore,
} = require('./min-store');

/** 字幕存储上限（字符）：字幕文本截断入库（可提交、不发布）。 */
const MAX_TRANSCRIPT_STORED_CHARS = 60000;

/** 校验 review_status 为单状态轴合法枚举（pending/approved/discarded）。 */
function assertValidReviewStatusMin(status) {
  if (!MIN_REVIEW_STATUSES.includes(status)) {
    throw new Error(`非法审核状态：${status}。合法值：${MIN_REVIEW_STATUSES.join(' / ')}`);
  }
}

function normalizeMutationIds(ids) {
  if (!Array.isArray(ids)) throw new Error('mutation 的 ids 必须是明确 id 数组');
  return [...new Set(ids.map(id => String(id).trim()).filter(Boolean))];
}

/**
 * 第一期工作台审核 mutation：只允许 pending → approved/discarded，按显式 id 定位。
 * 非 pending 条目不回退、不改写，汇入 not_pending；缺失 id 汇入 missing。
 */
function reviewPendingCandidates(store, ids, status, options = {}) {
  if (status !== 'approved' && status !== 'discarded') {
    throw new Error(`审核 mutation 只允许 pending → approved/discarded，收到：${status}`);
  }
  assertExpectedMinRevision(store, options.expectedRevision);
  const next = createMinStore(store);
  const byId = new Map(next.candidates.map(candidate => [String(candidate && candidate.id), candidate]));
  const missing = [];
  const notPending = [];
  const targetIds = normalizeMutationIds(ids);
  let updated = 0;
  const reviewedAt = (options.now ? new Date(options.now) : new Date()).toISOString();
  for (const id of targetIds) {
    const candidate = byId.get(id);
    if (!candidate) { missing.push(id); continue; }
    if (candidate.review_status !== 'pending') { notPending.push(id); continue; }
    candidate.review_status = status;
    candidate.reviewed_at = reviewedAt;
    updated += 1;
  }
  if (updated > 0) next.updated_at = reviewedAt;
  return { store: next, updated, missing, not_pending: notPending, changed: updated };
}

/**
 * 单条设置审核状态：仅 pending/approved/discarded 合法，写入 reviewed_at。
 * 未命中 id 或非法枚举时抛错，不做部分写入。
 * @returns {{ store, updated }} updated 恒为 1（未命中已抛错）。
 */
function setReviewStatusMin(store, id, status, options = {}) {
  const expectedRevision = options.expectedRevision || revisionOfMinStore(store);
  const result = reviewPendingCandidates(store, [id], status, { ...options, expectedRevision });
  if (result.missing.length) throw new Error(`候选不存在：${id}`);
  if (result.not_pending.length) throw new Error(`候选不是 pending，拒绝审核：${id}`);
  return { store: result.store, updated: result.updated };
}

/**
 * 批量设置审核状态：只处理显式列出的 pending ids，不做隐式范围；
 * 未命中 id 汇入 missing，非 pending id 汇入 not_pending。
 * @returns {{ store, updated, missing, not_pending }}
 */
function setBatchReviewStatusMin(store, ids, status, options = {}) {
  const expectedRevision = options.expectedRevision || revisionOfMinStore(store);
  return reviewPendingCandidates(store, ids, status, { ...options, expectedRevision });
}

/** 公开资格门禁（单状态轴）：仅人工 approved 可进入公开投影。 */
function isMinPublicEligible(candidate) {
  return Boolean(candidate && candidate.review_status === 'approved');
}

/**
 * 仅 approved 候选允许设置；只处理显式列出的 ids，未命中/非 approved 分别汇入 missing/not_approved。
 * selected 必须由工作台显式传入 boolean；top_selected 默认 false 由合并阶段初始化。
 * 维护者可 set=true 或 unset=false，公开投影仍由独立 publish 流程决定。
 */
function setTopSelectedMin(store, ids, selected, options = {}) {
  if (options.expectedRevision !== undefined) assertExpectedMinRevision(store, options.expectedRevision);
  const next = createMinStore(store);
  const missing = [];
  const notApproved = [];
  let updated = 0;
  const targetIds = normalizeMutationIds(ids);
  for (const id of targetIds) {
    const candidate = next.candidates.find(item => String(item && item.id) === id);
    if (!candidate) { missing.push(id); continue; }
    if (options.requireApproved !== false && candidate.review_status !== 'approved') {
      notApproved.push(id);
      continue;
    }
    candidate.top_selected = selected === true;
    updated += 1;
  }
  return { store: next, updated, missing, not_approved: notApproved, changed: updated };
}

/** 工作台 top mutation：只允许 approved 候选显式 set/unset top_selected。 */
function setApprovedTopSelectedMin(store, ids, selected, options = {}) {
  if (typeof selected !== 'boolean') throw new Error('top_selected mutation 必须显式提供 boolean set/unset');
  assertExpectedMinRevision(store, options.expectedRevision);
  return setTopSelectedMin(store, ids, selected, { ...options, requireApproved: true });
}

/**
 * 为 approved 候选写入字幕（工作台上传），revision 门禁。
 * transcript 为存储文本（截断到上限），transcript_file 为仓库内字幕文件相对路径；
 * 不改变审核/公开状态，字幕本身不进公开投影。
 */
function setCandidateTranscriptMin(store, id, payload, options = {}) {
  assertExpectedMinRevision(store, options.expectedRevision);
  const next = createMinStore(store);
  const target = next.candidates.find(item => String(item && item.id) === String(id));
  if (!target) return { store: next, updated: 0, missing: [String(id)], not_approved: [] };
  if (target.review_status !== 'approved') return { store: next, updated: 0, missing: [], not_approved: [String(id)] };
  const transcript = typeof payload?.transcript === 'string' ? payload.transcript.trim() : '';
  if (!transcript) throw new Error('字幕内容为空');
  target.transcript = transcript.slice(0, MAX_TRANSCRIPT_STORED_CHARS);
  if (payload?.transcript_file) target.transcript_file = String(payload.transcript_file);
  next.updated_at = new Date().toISOString();
  return { store: next, updated: 1, missing: [], not_approved: [] };
}

/**
 * 把外部 AI 对字幕生成的总结写回候选（覆盖既有 summary），revision 门禁。
 * 不改变审核/公开状态；summary 随候选进入公开投影。
 */
function setCandidateTranscriptSummaryMin(store, id, payload, options = {}) {
  assertExpectedMinRevision(store, options.expectedRevision);
  const next = createMinStore(store);
  const target = next.candidates.find(item => String(item && item.id) === String(id));
  if (!target) return { store: next, updated: 0, missing: [String(id)] };
  if (typeof payload?.summary === 'string' && payload.summary.trim()) target.summary = payload.summary.trim();
  if (Array.isArray(payload?.key_points)) target.summary_key_points = payload.key_points.map(String).slice(0, 12);
  target.transcript_summarized_at = new Date().toISOString();
  target.transcript_summary_llm = payload?.llm || 'deepseek';
  if (payload?.llm_error) target.transcript_summary_error = String(payload.llm_error);
  else delete target.transcript_summary_error;
  next.updated_at = new Date().toISOString();
  return { store: next, updated: 1, missing: [] };
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
  MAX_TRANSCRIPT_STORED_CHARS,
  assertValidReviewStatusMin,
  reviewPendingCandidates,
  setReviewStatusMin,
  setBatchReviewStatusMin,
  setTopSelectedMin,
  setApprovedTopSelectedMin,
  setCandidateTranscriptMin,
  setCandidateTranscriptSummaryMin,
  isMinPublicEligible,
  isMinDisplayEligible,
  toPublicItemMin,
};
