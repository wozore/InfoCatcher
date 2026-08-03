/**
 * news-review-events.js —— 追加式审核事件日志（B16 决策 70 的另一半）
 *
 * 在热点管线中的位置：审核事件日志与候选主记录是同一审核流水线的两部分。
 * 候选主记录（news-candidates.js）只保存当前状态与最近一次流转信息；
 * 本模块维护**只追加、不改写历史**的审核事件日志，完整保留每次审核状态变化，
 * 供审计与追溯（决策 70：候选主记录只保存当前状态，历史状态从审核日志追溯）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 日志结构与决策 70 字段：
 * ═══════════════════════════════════════════════════════════════
 *   review-events.json = {
 *     schema_version: 1,
 *     updated_at: <最近一次事件时间>,
 *     events: [
 *       {
 *         candidate_id,      // 发生审核流转的候选 id
 *         action,            // 流转来源：review_set / review_batch / transcript_outcome 等
 *         from_status,       // 变更前状态（用于审计）
 *         review_status,     // 变更后状态（当前审核状态）
 *         review_reason,     // 审核依据（决策 70）
 *         reviewer,          // 审核者标识（决策 70）
 *         reviewed_at,       // 审核时间（决策 70）
 *         candidate_version, // 候选记录版本号，用于并发检测（决策 70）
 *         batch_id,          // 所属抓取批次（决策 70）
 *         logged_at,         // 事件写入日志的时间
 *       },
 *       ...
 *     ]
 *   }
 *
 * 不变量：
 *   - events 只追加：appendReviewEvent 绝不改写或删除既有事件；
 *   - 同一候选可有多条事件，构成完整状态流转历史；
 *   - 系统驱动的状态变化（如字幕 enrichment 自动 held）同样记录，reviewer 记 system。
 *
 * 本模块只提供日志读写与事件构造，不发起网络请求、不消费额度。
 */

'use strict';

const { readJson, writeJsonAtomic } = require('./news-storage');
const { NEWS_FILES } = require('../../shared/paths');

const REVIEW_EVENTS_PATH = NEWS_FILES.reviewEvents;

const REVIEW_EVENTS_SCHEMA_VERSION = 1;

/** 读取日志文件；文件不存在时返回空日志（append-only 起点）。 */
function createReviewEventLog(existing) {
  if (existing && Array.isArray(existing.events)) {
    return {
      schema_version: existing.schema_version || REVIEW_EVENTS_SCHEMA_VERSION,
      updated_at: existing.updated_at || null,
      events: [...existing.events],
    };
  }
  return { schema_version: REVIEW_EVENTS_SCHEMA_VERSION, updated_at: null, events: [] };
}

/**
 * 追加式写入一次审核事件（决策 70：只追加、不改写历史）。
 * 返回新的 log；不会修改传入的 log/event。
 * event 至少需要 candidate_id；其余字段按决策 70 由调用方或
 * reviewEventFromCandidate 填充。
 */
function appendReviewEvent(log, event) {
  if (!event || !event.candidate_id) throw new Error('审核事件缺少 candidate_id');
  const next = createReviewEventLog(log);
  const loggedAt = event.logged_at || new Date().toISOString();
  next.events.push({ ...event, logged_at: loggedAt });
  next.updated_at = loggedAt; // 始终指向最近一次事件时间
  return next;
}

/**
 * 从一次候选状态流转生成决策 70 完整字段的审核事件。
 * candidate 应为流转后的候选（含 from_status / reviewed_at / candidate_version /
 * batch_id）。reason/reviewer/now 显式传入时优先；否则回退到候选上的字段。
 */
function reviewEventFromCandidate(candidate, { action = 'review_set', reason, reviewer, now } = {}) {
  if (!candidate) throw new Error('候选不存在，无法生成审核事件');
  const timestamp = now || candidate.reviewed_at || new Date().toISOString();
  return {
    candidate_id: candidate.id,
    action,
    from_status: candidate.from_status ?? candidate.review_status,
    review_status: candidate.review_status,
    review_reason: reason || candidate.review_reason || null,
    reviewer: reviewer || candidate.reviewer || null,
    reviewed_at: timestamp,
    candidate_version: candidate.candidate_version || 1,
    batch_id: candidate.batch_id || null,
  };
}

function readReviewEventLog() {
  return createReviewEventLog(readJson(REVIEW_EVENTS_PATH, null));
}

function writeReviewEventLog(log, runId = 'review-event') {
  writeJsonAtomic(REVIEW_EVENTS_PATH, log, runId);
}

/**
 * 记录一次审核状态流转：读日志 → 追加 → 原子写回（决策 70）。
 * 只追加、不改写历史。返回 { log, event }。
 * 调用时机：候选主记录的状态流转已落库之后，保证日志与主记录一致。
 */
function recordReviewTransition(candidate, { action, reason, reviewer, now, runId } = {}) {
  const event = reviewEventFromCandidate(candidate, { action, reason, reviewer, now });
  const log = appendReviewEvent(readReviewEventLog(), event);
  writeReviewEventLog(log, runId || `review-event-${candidate.id}-${Date.now()}`);
  return { log, event };
}

module.exports = {
  REVIEW_EVENTS_PATH,
  REVIEW_EVENTS_SCHEMA_VERSION,
  createReviewEventLog,
  appendReviewEvent,
  reviewEventFromCandidate,
  readReviewEventLog,
  writeReviewEventLog,
  recordReviewTransition,
};
