/**
 * min-store.js —— 热点管线 v2 候选层（单状态轴）存储与合并层
 *
 * 在热点管线中的位置：v2 审核（review-v2）落地后、每日公开投影
 * （daily-projection）之前。与 v2 审核/评分层同属独立数据通道，
 * 使用单状态轴：
 *   review_status = 'pending'（保留，待人工）| 'approved'（人工通过）| 'discarded'（剔除）
 *
 * 数据文件：data/news/runtime/min-candidates.json（不发布到 dist/）
 *   schema:
 *     { schema_version: 1, updated_at: <ISO>|null,
 *       candidates: [ { ...item, review_status, reviewed_at, ai_advice } ] }
 *
 * 合并语义：新条目按 id 覆盖内容字段；已存在条目**保留既有 review_status**，
 * 人工审核结论不因重新采集被重置（与决策 55/70 审计语义一致）；
 * reviewed_at 由人工审核写入，重新采集不携带 → 同样保留；ai_advice / l1_review
 * 本轮有新的（incoming 已生成）则保留新的，否则保留既有。
 *
 * 审核/top/字幕类 mutation 与公开门禁在 min-review-actions.js。
 * 本模块只提供纯函数与存储读写，不发起网络请求、不消费额度。
 */

'use strict';

const crypto = require('crypto');
const { readJson, writeJsonAtomic } = require('../../shared/json-store');
const { NEWS_FILES } = require('../../shared/paths');

const MIN_CANDIDATES_PATH = NEWS_FILES.minCandidates;

// 单状态轴合法取值
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
  mergeCandidatesMin,
};
