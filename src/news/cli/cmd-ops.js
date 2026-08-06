/**
 * cmd-ops.js —— authorization / quota / lock 命令组（自 news-cli.js 拆分，行为不变）
 *
 *   authorization list
 *   authorization continue    --id ... --until <days> [--max-quota ...] [--note ...]
 *   authorization until-first --id ... --earliest <days> --max-pages ... [--max-quota ...] [--note ...]
 *   authorization skip        --id ...
 *   authorization stop        --id ...
 *
 *   quota resume --platform youtube|bilibili --reason ...
 *   （记录决策和时间，不修改余额；下一次构建创建新预算后自动恢复）
 *
 *   lock status
 *   lock force-unlock --reason ...
 *   （status 只读；force-unlock 删除锁并写入审计，必须提供 reason）
 *
 * 本文件同时承载 CLI 通用工具 optionalNumber / resolveReviewer，供其他命令文件复用。
 * 完整 CLI 帮助见 news-cli.js 顶部。
 */

'use strict';

const { readJson, inspectLock, forceUnlock } = require('../core/news-storage');
const { createAuthorizationStore, decideAuthorization } = require('../core/news-authorization');
const { FILES, save, PLATFORMS } = require('./cmd-sources');

/**
 * 安全解析数值型 CLI 参数。
 * 使用 !== undefined 而非真值判断，确保 --max-quota 0 等显式零值
 * 能被正确传递到授权层，由授权层的正整数检查拒绝。
 */
function optionalNumber(flags, key, suffix = '') {
  return flags[key] !== undefined ? Number(String(flags[key]).replace(new RegExp(`${suffix}$`), '')) : undefined;
}

/** 审核者标识：--reviewer 优先，其次 GITHUB_ACTOR，再次本地用户，最后 fallback cli */
function resolveReviewer(flags) {
  return flags.reviewer || process.env.GITHUB_ACTOR || process.env.USER || process.env.USERNAME || 'cli';
}

// ── 命令实现 ──────────────────────────────────────────────

function authorizationCommand(action, flags) {
  const store = createAuthorizationStore(readJson(FILES.authorizations, null));
  if (action === 'list') return store.tasks.filter(task => task.status === 'pending');

  const mapping = { continue: 'continue', 'until-first': 'until-first', skip: 'skip', stop: 'stop' };
  if (!mapping[action]) throw new Error(`未知 authorization 命令: ${action}`);

  const task = decideAuthorization(store, flags.id, mapping[action], {
    until_days: optionalNumber(flags, 'until', 'd'),
    earliest_days: optionalNumber(flags, 'earliest', 'd'),
    max_pages: optionalNumber(flags, 'max_pages'),
    max_quota: optionalNumber(flags, 'max_quota'),
    operator_note: flags.note || '',
  });
  save(FILES.authorizations, store, 'authorization');
  return task;
}

function quotaCommand(action, flags) {
  if (action !== 'resume') throw new Error(`未知 quota 命令: ${action}`);
  if (!PLATFORMS.has(flags.platform) || !flags.reason) throw new Error('quota resume 需要有效 --platform 和 --reason');
  const quota = readJson(FILES.quota, { schema_version: 1, resume_events: [] });
  quota.resume_events ||= [];
  quota.resume_events.push({ platform: flags.platform, reason: flags.reason, at: new Date().toISOString() });
  save(FILES.quota, quota, 'quota-resume');
  return quota.resume_events.at(-1);
}

function lockCommand(action, flags) {
  if (action === 'status') return inspectLock(FILES.lock);
  if (action === 'force-unlock') return { removed: forceUnlock(FILES.lock, flags.reason, FILES.audit) };
  throw new Error(`未知 lock 命令: ${action}`);
}

module.exports = {
  authorizationCommand, quotaCommand, lockCommand,
  optionalNumber, resolveReviewer,
};
