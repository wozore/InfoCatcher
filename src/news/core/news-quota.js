/**
 * news-quota.js — 平台独立额度账本
 *
 * 在热点管线中的位置：被 build-news.js、news-youtube.js 和 news-bilibili.js
 * 使用，每次对外部平台发请求前必须经过额度检查。
 *
 * 职责：
 *   1. 两个独立账本：YouTube 按 quota units 计、Bilibili 按 HTTP attempts 计。
 *      每次构建的总预算由 news-config.json 的 collection 段定义：
 *        youtube_quota_units_per_run (默认 1000)
 *        bilibili_rsshub_requests_per_run (默认 300)
 *   2. 三步计费模型：
 *      a) reserve  —— 发请求前预留额度，返回 reservationId
 *      b) consume  —— 请求已发出（无论成功或失败），从 reserved 转入 consumed
 *      c) release  —— 预留后决定不发请求（极少发生），退回额度
 *   3. 失败和重试都会消耗额度：每次 HTTP attempt 单独计费，
 *      因为对平台来说失败请求同样消耗了服务器资源。
 *      只有 reserve 后尚未发出的请求才可 release。
 *   4. 状态自动切换：
 *      - remaining === 0 → exhausted
 *      - remaining > 0 但不足以支付当前 cost → quota_paused
 *      - remaining ≤ quota_low_watermark（N-P3 低水位早停）→ low_watermark
 *      - reserved !== 0 在 finishQuotaLedger 时 → incomplete_reservations（异常）
 *   5. withQuota() 便捷封装：reserve → 执行异步请求 → 成功/失败 consume，
 *      失败时自动在 error 上附加 quotaReservationId 供排查。
 *
 * 为什么不是全局额度而是"每次构建独立预算"：
 *   GitHub Actions 每次触发都是独立进程，无法跨运行持久化动态余额；
 *   每次构建分配固定预算上限，在单次构建内通过本模块实时跟踪。
 *   CLI 的 quota resume 只记录决策和理由，不修改余额。
 *
 * 使用示例：
 *   const ledger = createQuotaLedger(config.collection, runId);
 *   const result = await withQuota(ledger, 'youtube',
 *     { source_id: 'src', layer_id: 'L1', operation: 'videos.list', cost: 1 },
 *     async () => fetch(...)
 *   );
 *   if (!result.sent) { ... } // 额度不足
 */

'use strict';

/**
 * 创建本轮构建的额度账本。
 * 从 config.collection 读取每个平台的预算上限，
 * runId 用于关联到具体构建批次。
 */
function createQuotaLedger(config, runId, now = new Date().toISOString()) {
  return {
    schema_version: 1,
    run_id: runId,
    started_at: now,
    finished_at: null,
    platforms: {
      youtube: platformLedger(config.youtube_quota_units_per_run || 1000, 'quota_units', config.quota_low_watermark),
      bilibili: platformLedger(config.bilibili_rsshub_requests_per_run || 300, 'http_attempts', config.quota_low_watermark),
    },
  };
}

/** 创建单个平台的额度账本初始值；lowWatermark > 0 时启用低水位早停（N-P3）。 */
function platformLedger(limit, unit, lowWatermark = 0) {
  return { limit, unit, lowWatermark, reserved: 0, consumed: 0, remaining: limit, status: 'available', operations: [] };
}

/** 内部：获取平台账本，不存在时抛出明确错误 */
function getPlatform(ledger, platform) {
  const account = ledger.platforms[platform];
  if (!account) throw new Error(`不支持的平台额度: ${platform}`);
  return account;
}

/**
 * 检查是否有足够额度（考虑已预留但尚未消费的部分）。
 * remaining - reserved >= cost 表示有可用余额。
 */
function canReserve(ledger, platform, cost) {
  if (!Number.isInteger(cost) || cost <= 0) throw new Error('额度 cost 必须是正整数');
  const account = getPlatform(ledger, platform);
  return account.remaining - account.reserved >= cost;
}

/**
 * 预留额度。成功后记录 operation，状态为 'reserved'。
 * 余额不足以支付 cost 时：
 *   - remaining === 0 → status = 'exhausted'
 *   - remaining > 0   → status = 'quota_paused'（还有额度但不够这笔操作）
 * 返回 { accepted: boolean, reservation_id?, remaining? }
 */
function reserveQuota(ledger, platform, operation) {
  const cost = operation.cost;
  const account = getPlatform(ledger, platform);
  if (!canReserve(ledger, platform, cost)) {
    account.status = account.remaining === 0 ? 'exhausted' : 'quota_paused';
    return { accepted: false, reason: 'insufficient_quota', remaining: account.remaining - account.reserved };
  }
  // N-P3（2026-08-05）：低水位早停。remaining ≤ quota_low_watermark 时拒绝新预留，
  // 保护最后一点预算头寸，避免被廉价操作耗尽到 0 导致 run 中途无预算可重试。
  if (account.lowWatermark > 0 && account.remaining - account.reserved <= account.lowWatermark) {
    account.status = 'low_watermark';
    return { accepted: false, reason: 'low_watermark', remaining: account.remaining - account.reserved, watermark: account.lowWatermark };
  }
  const reservationId = `${platform}-${account.operations.length + 1}`;
  account.reserved += cost;
  account.operations.push({
    id: reservationId,
    source_id: operation.source_id || null,
    layer_id: operation.layer_id || null,
    operation: operation.operation,
    cost,
    attempt: operation.attempt || 1,
    reserved_at: operation.timestamp || new Date().toISOString(),
    consumed_at: null,
    result: 'reserved',
  });
  return { accepted: true, reservation_id: reservationId, remaining: account.remaining - account.reserved };
}

/**
 * 消费已预留的额度（请求已实际发出）。
 * 将 cost 从 reserved 转入 consumed，更新 remaining。
 * result 可以是 'success' 或 'failed'——失败请求同样消耗额度。
 */
function consumeQuota(ledger, platform, reservationId, result = 'sent', timestamp = new Date().toISOString()) {
  const account = getPlatform(ledger, platform);
  const operation = account.operations.find(entry => entry.id === reservationId);
  if (!operation) throw new Error(`额度预留不存在: ${reservationId}`);
  if (operation.result !== 'reserved') throw new Error(`额度预留已结算: ${reservationId}`);
  account.reserved -= operation.cost;
  account.consumed += operation.cost;
  account.remaining = Math.max(0, account.limit - account.consumed);
  operation.consumed_at = timestamp;
  operation.result = result;
  if (account.remaining === 0) account.status = 'exhausted';
  return operation;
}

/**
 * 释放未使用的预留（预留后决定不发送请求）。
 * 退回 reserved 额度，不进入 consumed。
 * 仅适用于 reserve 后尚未 consume 的情况。
 */
function releaseReservation(ledger, platform, reservationId, reason = 'request_not_sent') {
  const account = getPlatform(ledger, platform);
  const operation = account.operations.find(entry => entry.id === reservationId);
  if (!operation) throw new Error(`额度预留不存在: ${reservationId}`);
  if (operation.result !== 'reserved') throw new Error(`额度预留已结算: ${reservationId}`);
  account.reserved -= operation.cost;
  operation.result = reason;
  return operation;
}

/**
 * 便捷封装：预留额度 → 执行异步请求 → 按结果消费。
 * 请求成功时 consume 为 'success'，失败时 consume 为 'failed'，
 * 并在 error 上附加 quotaReservationId 供审计。
 *
 * @param {function} request 异步请求函数
 * @returns {{ sent: boolean, value?, reservation_id?, quota? }}
 */
async function withQuota(ledger, platform, operation, request) {
  const reservation = reserveQuota(ledger, platform, operation);
  if (!reservation.accepted) return { sent: false, quota: reservation };
  try {
    const value = await request();
    consumeQuota(ledger, platform, reservation.reservation_id, 'success');
    return { sent: true, value, reservation_id: reservation.reservation_id };
  } catch (error) {
    consumeQuota(ledger, platform, reservation.reservation_id, 'failed');
    error.quotaReservationId = reservation.reservation_id;
    throw error;
  }
}

/**
 * 完成额度账本审计。
 * 检查 reserved 是否清零：未清零说明有异常预留未结算。
 */
function finishQuotaLedger(ledger, now = new Date().toISOString()) {
  ledger.finished_at = now;
  for (const account of Object.values(ledger.platforms)) {
    if (account.reserved !== 0) account.status = 'incomplete_reservations';
    else if (account.status === 'available') account.status = 'complete';
  }
  return ledger;
}

module.exports = {
  createQuotaLedger, canReserve, reserveQuota, consumeQuota, releaseReservation,
  withQuota, finishQuotaLedger,
};
