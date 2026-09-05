'use strict';

/**
 * review-commands.js — 工具更新审核队列的维护命令实现
 *
 * 职责：localize 只回填已有队列的中文展示字段（失败可重试、无变化不写回）；
 * list 只读过滤；preview 只读规划 approved 日期修补批次；apply 经三重确认
 * （expected_revision + preview_hash + 精确确认串）后复用日期批量事务写入。
 *
 * 依赖注入：交互确认（ask）与汉化实现（localizeToolCandidate）由调用方提供——
 * 人类 I/O 属脚本壳职责，news 域汉化器经 service-facade 注入。
 */

const { CATALOG_GENERATOR_FILES } = require('../../shared/paths');
const { loadCatalogSnapshot, createCostLedger } = require('../core/index');
const { loadProductUrlRegistry } = require('../url-registry/index');
const {
  readReviewQueue,
  writeReviewQueue,
  approvedRepairsFromReviewQueue,
  planDateRepairBatch,
  applyDateRepairBatch,
} = require('./index');
const { csvFlag } = require('./review-scan');
const { externalSummaryEnabled, usableToolLocalization } = require('./review-localize');

async function runLocalize(flags = {}, deps = {}) {
  const file = deps.reviewFile || CATALOG_GENERATOR_FILES.toolUpdateReview;
  const queue = (deps.readQueue || readReviewQueue)(file);
  const localize = deps.localizeToolCandidate;
  if (typeof localize !== 'function') {
    throw new Error('TOOL_UPDATE_REVIEW_LOCALIZER_REQUIRED: localize 需要经 deps 注入 localizeToolCandidate（catalog 域禁止直依赖 news 域汉化器）');
  }
  const ledger = deps.ledger || (deps.createLedger ? deps.createLedger({ responses_calls: Number(flags.max_ai_calls || 8) }) : createCostLedger({ responses_calls: Number(flags.max_ai_calls || 8) }));
  const candidateKey = flags.candidate_key ? String(flags.candidate_key) : null;
  let localized = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;
  let changed = false;
  for (const item of queue.items) {
    if (candidateKey && item.candidate_key !== candidateKey) {
      skipped++;
      continue;
    }
    if (!flags.refresh && usableToolLocalization(item)) {
      if (item.localizations_meta?.zh?.llm_error) {
        item.localizations_meta = { zh: { ...item.localizations_meta.zh, llm_error: null } };
        changed = true;
      }
      skipped++;
      continue;
    }
    processed++;
    const before = JSON.stringify({ localizations: item.localizations, localizations_meta: item.localizations_meta });
    await localize(item, {
      model: flags.model,
      fetchImpl: deps.localizeFetchImpl || deps.aiFetchImpl,
      timeoutMs: deps.localizeTimeoutMs,
      now: flags.as_of || new Date().toISOString(),
      externalSummary: externalSummaryEnabled(flags),
      confirmCost: flags.confirm_cost === true,
      externalApiKey: deps.externalApiKey,
      externalFetchImpl: deps.externalFetchImpl,
      notify: deps.notify,
      ledger,
    });
    const after = JSON.stringify({ localizations: item.localizations, localizations_meta: item.localizations_meta });
    if (before !== after) changed = true;
    if (usableToolLocalization(item)) localized++;
    else failed++;
  }
  const written = changed ? (deps.writeQueue || writeReviewQueue)(queue, {
    file,
    now: flags.as_of || new Date().toISOString(),
    runId: 'tool-update-review-localize',
  }) : null;
  return {
    ok: true,
    command: 'localize',
    localized,
    skipped,
    failed,
    processed,
    changed,
    external_summary_enabled: externalSummaryEnabled(flags),
    item_count: queue.items.length,
    file: written?.file || file,
    cost: ledger.snapshot(),
    catalog_apply: false,
  };
}

function summaryOfItem(item) {
  return {
    candidate_key: item.candidate_key,
    product_key: item.product_key,
    detail_id: item.detail_id,
    status: item.status,
    review_status: item.review_status,
    previous_date: item.previous_date,
    proposed_date: item.proposed_date,
    source_url: item.source_url,
    blocked_reasons: item.blocked_reasons || [],
  };
}

function runList(flags = {}, deps = {}) {
  const queue = (deps.readQueue || readReviewQueue)(deps.reviewFile || CATALOG_GENERATOR_FILES.toolUpdateReview);
  const status = flags.status && String(flags.status).trim();
  if (status && !['pending', 'approved', 'rejected', 'candidate', 'blocked'].includes(status)) {
    return { ok: false, command: 'list', code: 'TOOL_UPDATE_REVIEW_STATUS_INVALID' };
  }
  const items = queue.items.filter(item => !status || item.review_status === status || item.status === status).map(summaryOfItem);
  return { ok: true, command: 'list', status_filter: status || null, count: items.length, items };
}

function runPreview(flags = {}, deps = {}) {
  const current = deps.loadSnapshot ? deps.loadSnapshot() : loadCatalogSnapshot();
  const registry = deps.loadRegistry ? deps.loadRegistry() : loadProductUrlRegistry();
  const queue = (deps.readQueue || readReviewQueue)(deps.reviewFile || CATALOG_GENERATOR_FILES.toolUpdateReview);
  const candidateKeys = csvFlag(flags.candidate_keys);
  const approved = approvedRepairsFromReviewQueue(current.snapshot, {
    registry,
    reviewQueue: queue,
    candidateKeys,
    asOf: flags.as_of,
  });
  if (!approved.ok) return { ...approved, command: 'preview' };
  const planned = planDateRepairBatch(current.snapshot, approved.repairs, { asOf: flags.as_of });
  if (!planned.ok) return { ...planned, command: 'preview' };
  return {
    ok: true,
    command: 'preview',
    expected_revision: planned.before_revision,
    preview_hash: planned.preview_hash,
    count: planned.count,
    changes: planned.changes,
    catalog_apply: false,
  };
}

async function runApply(flags = {}, deps = {}) {
  if (!flags.expected_revision) return { ok: false, command: 'apply', code: 'DATE_REPAIR_EXPECTED_REVISION_REQUIRED' };
  if (!flags.preview_hash) return { ok: false, command: 'apply', code: 'DATE_REPAIR_PREVIEW_REQUIRED' };
  const confirmationValue = `APPLY TOOL-UPDATES ${flags.preview_hash}`;
  const prompt = `输入 ${confirmationValue} 以确认正式写入：`;
  // 与原 CLI 语义一致：confirm 为 true 或缺省时才需要交互确认；显式字符串直接比对。
  const needsAsk = flags.confirm === true || !flags.confirm;
  if (needsAsk && typeof deps.ask !== 'function') {
    throw new Error('TOOL_UPDATE_REVIEW_ASK_REQUIRED: apply 的交互确认需要经 deps.ask 注入（人类 I/O 属脚本壳职责）');
  }
  const confirmation = needsAsk ? await deps.ask(prompt, deps) : flags.confirm;
  if (confirmation !== confirmationValue) return { ok: false, command: 'apply', code: 'TOOL_UPDATE_REVIEW_CONFIRMATION_REQUIRED' };
  const result = (deps.applyBatch || applyDateRepairBatch)(undefined, {
    expectedRevision: String(flags.expected_revision),
    previewHash: String(flags.preview_hash),
    candidateKeys: csvFlag(flags.candidate_keys),
    asOf: flags.as_of,
    reviewFile: deps.reviewFile || CATALOG_GENERATOR_FILES.toolUpdateReview,
    ...(deps.reviewQueue ? { reviewQueue: deps.reviewQueue } : {}),
    ...(deps.registry ? { registry: deps.registry } : {}),
    ...(deps.snapshot ? { snapshot: deps.snapshot } : {}),
    ...(deps.commitSnapshotChange ? { commitSnapshotChange: deps.commitSnapshotChange } : {}),
  });
  return { ...result, command: 'apply' };
}

module.exports = {
  runLocalize,
  runList,
  runPreview,
  runApply,
};
