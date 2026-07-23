'use strict';

const crypto = require('crypto');

const DECISIONS = new Set(['continue', 'until-first', 'skip', 'stop']);

function createAuthorizationStore(data = null) {
  const store = data || { schema_version: 1, updated_at: null, tasks: [] };
  store.tasks ||= [];
  return store;
}

function authorizationTaskId(platform, sourceId, createdAt) {
  return `auth-${crypto.createHash('sha256').update(`${platform}:${sourceId}:${createdAt}`).digest('hex').slice(0, 16)}`;
}

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

function decideAuthorization(store, id, decision, options = {}, now = new Date().toISOString()) {
  if (!DECISIONS.has(decision)) throw new Error(`无效授权决定: ${decision}`);
  const task = store.tasks.find(item => item.id === id);
  if (!task) throw new Error(`授权任务不存在: ${id}`);
  if (task.status !== 'pending') throw new Error(`授权任务已处理: ${id}`);
  if ((decision === 'continue' || decision === 'until-first') && !Number.isFinite(options.until_days || options.earliest_days)) {
    throw new Error(`${decision} 必须提供时间边界`);
  }
  if (decision === 'until-first' && (!Number.isInteger(options.max_pages) || options.max_pages <= 0)) {
    throw new Error('until-first 必须提供正整数 max_pages');
  }
  const limit = options.until_days || options.earliest_days || null;
  if (limit !== null && (limit <= task.searched_range_days || limit > 3650)) throw new Error('授权时间边界必须大于已搜索范围且不超过3650天');
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
