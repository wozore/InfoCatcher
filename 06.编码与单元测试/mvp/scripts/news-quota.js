'use strict';

function createQuotaLedger(config, runId, now = new Date().toISOString()) {
  return {
    schema_version: 1,
    run_id: runId,
    started_at: now,
    finished_at: null,
    platforms: {
      youtube: platformLedger(config.youtube_quota_units_per_run || 1000, 'quota_units'),
      bilibili: platformLedger(config.bilibili_rsshub_requests_per_run || 300, 'http_attempts'),
    },
  };
}

function platformLedger(limit, unit) {
  return { limit, unit, reserved: 0, consumed: 0, remaining: limit, status: 'available', operations: [] };
}

function getPlatform(ledger, platform) {
  const account = ledger.platforms[platform];
  if (!account) throw new Error(`不支持的平台额度: ${platform}`);
  return account;
}

function canReserve(ledger, platform, cost) {
  if (!Number.isInteger(cost) || cost <= 0) throw new Error('额度 cost 必须是正整数');
  const account = getPlatform(ledger, platform);
  return account.remaining - account.reserved >= cost;
}

function reserveQuota(ledger, platform, operation) {
  const cost = operation.cost;
  const account = getPlatform(ledger, platform);
  if (!canReserve(ledger, platform, cost)) {
    account.status = account.remaining === 0 ? 'exhausted' : 'quota_paused';
    return { accepted: false, reason: 'insufficient_quota', remaining: account.remaining - account.reserved };
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

function releaseReservation(ledger, platform, reservationId, reason = 'request_not_sent') {
  const account = getPlatform(ledger, platform);
  const operation = account.operations.find(entry => entry.id === reservationId);
  if (!operation) throw new Error(`额度预留不存在: ${reservationId}`);
  if (operation.result !== 'reserved') throw new Error(`额度预留已结算: ${reservationId}`);
  account.reserved -= operation.cost;
  operation.result = reason;
  return operation;
}

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
