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

const crypto = require('crypto');
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
const MAX_TRANSCRIPT_STORED_CHARS = 60000;

/** 规范化为合法 store（浅拷贝 candidates 数组；空/非法输入回退空 store）。 */
function createMinStore(existing) {
  if (existing && Array.isArray(existing.candidates)) {
    return {
      schema_version: existing.schema_version || 1,
      updated_at: existing.updated_at || null,
      candidates: existing.candidates.map(candidate => (
        candidate && typeof candidate === 'object' ? { ...candidate } : candidate
      )),
    };
  }
  return { ...EMPTY_STORE, candidates: [] };
}

/** 对 JSON 值做确定性序列化，避免对象键顺序造成 revision 漂移。 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 候选层内容 revision；revision 不写回数据文件，供维护者 mutation 防陈旧写。 */
function revisionOfMinStore(store) {
  return crypto.createHash('sha256').update(stableStringify(createMinStore(store))).digest('hex');
}

function assertExpectedMinRevision(store, expectedRevision) {
  if (typeof expectedRevision !== 'string' || expectedRevision.length === 0) {
    throw new Error('候选层 mutation 必须提供 expected revision');
  }
  const actualRevision = revisionOfMinStore(store);
  if (actualRevision !== expectedRevision) {
    const error = new Error(`候选层 revision 冲突：expected=${expectedRevision}，actual=${actualRevision}`);
    error.code = 'REVISION_CONFLICT';
    error.expected_revision = expectedRevision;
    error.actual_revision = actualRevision;
    throw error;
  }
  return actualRevision;
}

/** 读候选层；文件不存在时返回空 store（{schema_version:1, updated_at:null, candidates:[]}）。 */
function readMinStore() {
  return createMinStore(readJson(MIN_CANDIDATES_PATH, null));
}

/** 原子写回候选层；提供 expectedRevision 时先核对磁盘当前版本。 */
function writeMinStore(store, runId = 'min', options = {}) {
  if (options.expectedRevision !== undefined) {
    assertExpectedMinRevision(readMinStore(), options.expectedRevision);
  }
  writeJsonAtomic(MIN_CANDIDATES_PATH, store, runId);
}

/**
 * 候选层 guarded commit：读取、校验 expected revision、执行一个纯 mutation，最后原子写回。
 * mutation 不负责 I/O；默认写者是 writeMinStore，也可注入 writeStore 做离线测试。
 * expectedRevision 是必填的，调用者若要接受当前版本必须显式先读取 revisionOfMinStore。
 */
function commitMinStoreMutation(mutation, options = {}) {
  if (typeof mutation !== 'function') throw new Error('候选层 mutation 必须是函数');
  const expectedRevision = options.expectedRevision;
  const current = options.store || readMinStore();
  assertExpectedMinRevision(current, expectedRevision);
  const result = mutation(current, { ...options, expectedRevision });
  if (!result || !result.store) throw new Error('候选层 mutation 必须返回 { store }');
  const changed = result.changed === undefined
    ? revisionOfMinStore(result.store) !== expectedRevision
    : result.changed > 0;
  if (changed) {
    if (options.writeStore) options.writeStore(result.store, options.runId || 'min-mutation', { expectedRevision });
    else writeMinStore(result.store, options.runId || 'min-mutation', { expectedRevision });
  }
  return {
    ...result,
    changed,
    before_revision: expectedRevision,
    revision: revisionOfMinStore(result.store),
  };
}

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
      // 人工/AI 加工结果：重新采集未提供时必须保留，避免丢失字幕、总结和本地化。
      // 含字幕付费总结的保护元数据（transcript_summarized_at 等），丢失会导致保护失效。
      for (const field of [
        'transcript', 'transcript_file', 'summary', 'summary_key_points',
        'transcript_summarized_at', 'transcript_summary_llm', 'transcript_summary_error',
        'localizations', 'localizations_meta', 'summarizer', 'summary_generated_at',
        'summary_input_chars', 'summary_llm_error',
      ]) {
        if (prev[field] !== undefined && incoming[field] === undefined) incoming[field] = prev[field];
      }
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
  MIN_CANDIDATES_PATH,
  MIN_REVIEW_STATUSES,
  DEFAULT_REVIEW_STATUS,
  MIN_INTERNAL_FIELDS,
  MIN_PUBLIC_FIELDS,
  createMinStore,
  revisionOfMinStore,
  assertExpectedMinRevision,
  readMinStore,
  writeMinStore,
  commitMinStoreMutation,
  assertValidReviewStatusMin,
  mergeCandidatesMin,
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
