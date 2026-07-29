/**
 * news-authorization.js — 超出默认回溯范围的待授权任务
 *
 * 在热点管线中的位置：被 build-news.js 在五层全部完成后使用，
 * 判断是否需要生成待授权任务；被 news-cli.js 用于处理用户授权决定。
 *
 * 触发条件：
 *   五层时间窗口（0-270天）全部完成后，某个来源在所有层的新视频数均为 0
 *   且没有重复或过滤项可处理 → 说明默认范围内的内容已经穷尽。
 *   此时创建 pending-authorization 任务，由维护者决定是否继续向后回溯。
 *
 * 四种决策：
 *   continue   —— 继续回溯到指定天数（如 365 天），给定附加额度上限
 *   until-first —— 持续回溯直到发现第一条新视频，受最早日期、最大页数和额度约束
 *   skip       —— 跳过该来源，不回溯
 *   stop       —— 停止该来源的所有进一步回溯
 *
 * 安全约束：
 *   - until_days/earliest_days 必须 > searched_range_days（不能缩小范围）
 *   - until_days/earliest_days 必须 <= 3650 天（约 10 年，防止无限制）
 *   - max_quota 必须是正整数
 *   - until-first 模式必须提供 max_pages 正整数
 *   - 授权后状态变为 authorized/skipped/stopped，不能重复授权
 *
 * 扩展点：
 *   - 新增平台：createAuthorizationTask 的参数已包含 platform 字段，
 *     只需在 build-news.js 的授权生成循环中加入该平台即可。
 */

'use strict';

const crypto = require('crypto');

/** 合法决策集合（同时用于校验） */
const DECISIONS = new Set(['continue', 'until-first', 'skip', 'stop']);

/**
 * 创建或恢复待授权任务存储。
 * 从 pending-authorizations.json 反序列化后传入 data。
 */
function createAuthorizationStore(data = null) {
  const store = data || { schema_version: 1, updated_at: null, tasks: [] };
  store.tasks ||= [];
  return store;
}

/** 生成稳定的授权任务 ID */
function authorizationTaskId(platform, sourceId, createdAt) {
  return `auth-${crypto.createHash('sha256').update(`${platform}:${sourceId}:${createdAt}`).digest('hex').slice(0, 16)}`;
}

/**
 * 创建待授权任务。
 * 如果同一来源已有 pending 任务，不重复创建，直接返回已有任务。
 *
 * @param {object} store 授权存储
 * @param {object} input 任务参数：
 *   platform, source_id, source_name —— 来源标识
 *   searched_range_days —— 已搜索的天数范围
 *   duplicate_count, filtered_count —— 已处理的重复和过滤数量
 *   quota —— 当前平台的额度消耗情况
 *   capability_limit —— 平台能力限制说明（B站写 rsshub_visible_feed_only...）
 *   suggested_until_days —— 建议的下一次回溯天数
 *   estimated_cost —— 预估成本
 */
function createAuthorizationTask(store, input, now = new Date().toISOString()) {
  const existing = store.tasks.find(task => task.source_id === input.source_id && task.platform === input.platform && task.status === 'pending');
  if (existing) return existing;
  const task = {
    id: authorizationTaskId(input.platform, input.source_id, now),
    platform: input.platform,
    source_id: input.source_id,
    source_name: input.source_name,
    status: 'pending',
    created_at: now,
    decided_at: null,
    searched_range_days: input.searched_range_days || 270,
    duplicate_count: input.duplicate_count || 0,
    filtered_count: input.filtered_count || 0,
    quota: input.quota || null,
    capability_limit: input.capability_limit || null,
    suggested_until_days: input.suggested_until_days || 365,
    estimated_cost: input.estimated_cost || null,
    decision: null,
  };
  store.tasks.push(task);
  store.updated_at = now;
  return task;
}

/**
 * 处理授权决策。
 * 在修改任务状态前进行完整的安全校验，拒绝非法参数。
 *
 * @param {string} id 任务 ID
 * @param {string} decision 决策类型：'continue' | 'until-first' | 'skip' | 'stop'
 * @param {object} options 决策参数：
 *   until_days / earliest_days —— 继续搜索的天数
 *   max_pages —— until-first 模式的最大页数
 *   max_quota —— 附加额度上限
 *   operator_note —— 操作者备注
 */
function decideAuthorization(store, id, decision, options = {}, now = new Date().toISOString()) {
  if (!DECISIONS.has(decision)) throw new Error(`无效授权决定: ${decision}`);
  const task = store.tasks.find(item => item.id === id);
  if (!task) throw new Error(`授权任务不存在: ${id}`);
  if (task.status !== 'pending') throw new Error(`授权任务已处理: ${id}`);

  // continue/until-first 必须提供有效的时间边界
  if ((decision === 'continue' || decision === 'until-first') && !Number.isFinite(options.until_days || options.earliest_days)) {
    throw new Error(`${decision} 必须提供时间边界`);
  }
  // until-first 必须提供正整数 max_pages
  if (decision === 'until-first' && (!Number.isInteger(options.max_pages) || options.max_pages <= 0)) {
    throw new Error('until-first 必须提供正整数 max_pages');
  }

  const limit = options.until_days || options.earliest_days || null;
  // 时间边界必须大于已搜索范围，且不超过 3650 天（约 10 年安全上限）
  if (limit !== null && (limit <= task.searched_range_days || limit > 3650)) throw new Error('授权时间边界必须大于已搜索范围且不超过3650天');
  // max_quota 如果传入，必须是正整数
  if (options.max_quota !== undefined && (!Number.isInteger(options.max_quota) || options.max_quota <= 0)) throw new Error('max_quota 必须是正整数');

  task.status = decision === 'skip' ? 'skipped' : decision === 'stop' ? 'stopped' : 'authorized';
  task.decision = {
    action: decision,
    until_days: options.until_days || null,
    earliest_days: options.earliest_days || null,
    max_pages: options.max_pages || null,
    max_quota: options.max_quota || null,
    operator_note: options.operator_note || '',
  };
  task.decided_at = now;
  store.updated_at = now;
  return task;
}

module.exports = {
  DECISIONS, createAuthorizationStore, createAuthorizationTask, decideAuthorization,
};
