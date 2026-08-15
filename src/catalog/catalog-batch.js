/**
 * catalog-batch.js —— 批量生成编排层（热点待补卡 → 正式五模块目录）
 *
 * 在 ②→③ 链路中的位置：把 `min-review feedback` 产出的 tool-cards-pending.json
 * 自动转成正式目录卡片的唯一入口。串联：
 *   待补卡 → 查重（正式 tool-card / 进行中 draft / 同批）→ 厂商/官方源解析
 *   （人工登记表命中 | Tavily+DeepSeek 解析）→ 逐 seed 跑 v3 生成器
 *   （plan → prepare → review → apply，自动 apply）→ 批量报告。
 *
 * 设计决策（用户已拍板）：
 *   - 自动 Apply：全局确认一次成本（--confirm-cost）后，每个 seed readiness
 *     ready 即自动 commit，跳过 CLI 的 `APPLY <id>` 人工输入。
 *   - 单 seed 失败跳过、记录、继续（对齐 pipeline-min 降级不抛错哲学）。
 *   - 分组名：不设 seed.placement.new_group_title，deriveKeys 回退 seed.name
 *     作二级分组名（Q-A 决策）。
 *   - 成本账本 per-research-run（不跨 seed 共享）；本层先汇总 planCatalogDraft
 *     cost_plan 做总门禁，再逐 seed 传 confirmCost:true。
 *
 * 失败隔离：每 seed 独立 try/catch，失败记 report.failed（保留 draft 供现有
 * `catalog-generator resume` 续跑），不阻塞后续。
 *
 * 注入点（测试 mock 用，缺省回落真实实现）：
 *   options.tools / options.drafts / options.registry      查重与登记表数据注入
 *   options.resolveOfficialSource                          厂商解析注入（替换真实网络）
 *   options.resolveLedger / options.catalogAdapters        预算与生成 AI adapters 注入
 *   options.generatorOptions                               生成器配置注入（缺省 loadGeneratorConfig）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../news/core/news-storage');
const { CATALOG_GENERATOR_FILES } = require('../shared/paths');
const { catalog } = require('../catalog-interface');
const { toolExists } = require('../news/feedback/tool-feedback');
const { pendingCandidateToSeed } = require('../news/feedback/catalog-draft-adapter');
const { listDrafts } = require('./catalog-draft-store');
const {
  planCatalogDraft,
  prepareCatalogDraft,
  reviewCatalogDraft,
  applyCatalogDraft,
  loadGeneratorConfig,
  normalizeGeneratorOptions,
} = require('./catalog-assistant');
const { createCatalogAiAdapters, resolveOfficialSource } = require('./ai/catalog-adapters');
const { lookupOfficialUrl } = require('./official-url-registry');
const { createCostLedger } = require('./catalog-research');
const { slugify } = require('./catalog-record-builders');

const EMPTY_COST = { search_queries: 0, pages: 0, responses_calls: 0, synthesis_calls: 0 };

function generatorOptionsOf(options) {
  return options.generatorOptions || normalizeGeneratorOptions(loadGeneratorConfig());
}

/** 读取待补卡文件（tool-cards-pending.json），返回 cards 数组。 */
function readPendingCards(filePath) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.cards)) {
    throw new Error('PENDING_CARDS_INVALID: 待补卡文件缺少 cards 数组');
  }
  return payload.cards;
}

// ═══════════════════════════════════════════════════════════════
// 1. 查重（正式目录 / 进行中 draft / 同批）
// ═══════════════════════════════════════════════════════════════

function listCatalogTools(options) {
  if (options.tools) return options.tools;
  const result = catalog({ area: 'tool-card', operation: 'list' });
  return result.ok ? result.data : [];
}

function listCatalogDrafts(options) {
  if (options.drafts) return options.drafts;
  try { return listDrafts(); } catch { return []; }
}

/**
 * 三层查重：已存在正式 tool-card / 进行中 draft / 同批重复。
 * @param {Array<object>} cards 待补卡
 * @param {object} [options] { tools, drafts }
 * @returns {{ unique: [], skippedExisting: [], skippedDraft: [], duplicateInBatch: [] }}
 */
function dedupeBatchCandidates(cards, options = {}) {
  const tools = listCatalogTools(options);
  const drafts = listCatalogDrafts(options);
  const seenInBatch = new Set();
  const result = { unique: [], skippedExisting: [], skippedDraft: [], duplicateInBatch: [] };
  for (const card of cards || []) {
    const name = String(card.name || card.title || '').trim();
    if (!name) continue;
    let key;
    try { key = slugify(name, 'tool_key'); } catch { key = name.toLowerCase(); }
    if (seenInBatch.has(key)) { result.duplicateInBatch.push({ name, reason: '同批重复' }); continue; }
    seenInBatch.add(key);
    if (toolExists(name, tools)) { result.skippedExisting.push({ name, reason: '目录已存在' }); continue; }
    const draftHit = (drafts || []).find(draft => {
      const seedName = draft?.seed && (draft.seed.name || draft.seed.title);
      return seedName && String(seedName).trim().toLowerCase() === name.toLowerCase();
    });
    if (draftHit) {
      result.skippedDraft.push({ name, draft_id: draftHit.draft_id, reason: '进行中 draft 已存在' });
      continue;
    }
    result.unique.push(card);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// 2. 厂商/官方源解析（登记表 → Tavily）
// ═══════════════════════════════════════════════════════════════

/**
 * 逐卡解析：先查人工登记表（命中零成本），未命中走 Tavily+DeepSeek。
 * 解析结果经 pendingCandidateToSeed 落成 seed（含 official_url + official_hint）。
 * @returns {Promise<{ seeds: [], unresolved: [], resolve_cost: object }>}
 */
async function resolveBatchCandidates(cards, options = {}) {
  const resolveFn = options.resolveOfficialSource || resolveOfficialSource;
  const ledger = options.resolveLedger || createCostLedger({ responses_calls: Math.max(1, cards.length) });
  const seeds = [];
  const unresolved = [];
  for (const card of cards || []) {
    const name = String(card.name || card.title || '').trim();
    if (!name) continue;
    const registryHit = lookupOfficialUrl(name, { registry: options.registry });
    if (registryHit.ok) {
      seeds.push(pendingCandidateToSeed(card, registryHit));
      continue;
    }
    try {
      const resolved = await resolveFn(name, { ...options, ledger });
      if (resolved && resolved.ok) {
        seeds.push(pendingCandidateToSeed(card, resolved));
      } else {
        unresolved.push({ name, reason: (resolved && (resolved.error || resolved.code)) || 'VENDOR_RESOLUTION_FAILED' });
      }
    } catch (error) {
      unresolved.push({ name, reason: error?.message || String(error) });
    }
  }
  return { seeds, unresolved, resolve_cost: ledger.snapshot() };
}

// ═══════════════════════════════════════════════════════════════
// 3. 批量成本估算（纯函数，零副作用）
// ═══════════════════════════════════════════════════════════════

/**
 * 汇总各 seed 的 planCatalogDraft cost_plan。
 * @returns {{ ok: true, total: object, per_seed: [] }}
 */
function planBatchCost(seeds, options = {}) {
  const generatorOptions = generatorOptionsOf(options);
  const per_seed = [];
  const total = { ...EMPTY_COST };
  for (const seed of seeds || []) {
    try {
      const planned = planCatalogDraft(seed, generatorOptions);
      if (!planned.ok) {
        per_seed.push({ name: seed.name, ok: false, code: planned.code, error: planned.error });
        continue;
      }
      const limits = planned.cost_plan?.hard_limits || {};
      for (const key of Object.keys(total)) total[key] += Number(limits[key] || 0);
      per_seed.push({ name: seed.name, ok: true, cost_plan: planned.cost_plan });
    } catch (error) {
      per_seed.push({ name: seed.name, ok: false, error: error?.message || String(error) });
    }
  }
  return { ok: true, total, per_seed };
}

// ═══════════════════════════════════════════════════════════════
// 4. 批量生成循环（逐 seed：prepare → review → apply，自动 apply）
// ═══════════════════════════════════════════════════════════════

/**
 * 逐 seed 跑生成器全流程并自动 apply。
 * @param {Array<object>} seeds 已解析完成的 seed 列表
 * @param {object} [options]
 *   - confirmCost / catalogAdapters / generatorOptions
 *   - prepareCatalogDraft / reviewCatalogDraft / applyCatalogDraft  生命周期注入（测试 stub 用，
 *     缺省回落真实实现；真实 applyCatalogDraft 会提交五模块目录与 dist）
 * @returns {Promise<{ estimate, applied: [], failed: [], per_tool: [] }>}
 */
async function runCatalogBatch(seeds, options = {}) {
  const generatorOptions = generatorOptionsOf(options);
  const estimate = planBatchCost(seeds, { generatorOptions });
  const adapters = options.catalogAdapters || createCatalogAiAdapters(generatorOptions);
  const prepareFn = options.prepareCatalogDraft || prepareCatalogDraft;
  const reviewFn = options.reviewCatalogDraft || reviewCatalogDraft;
  const applyFn = options.applyCatalogDraft || applyCatalogDraft;
  const report = { estimate, applied: [], failed: [], per_tool: [] };

  for (const seed of seeds || []) {
    const entry = { name: seed.name, vendor_name: seed.vendor_name, official_url: seed.official_url, status: 'pending' };
    let draftId = null;
    try {
      // prepareCatalogDraft 内部会重新 planCatalogDraft 并对照最新快照，
      // 顺序循环逐 seed 天然自洽（前序 apply 改 revision 不影响本 seed）。
      const prepared = await prepareFn(seed, { ...generatorOptions, confirmCost: true, catalogAdapters: adapters });
      if (!prepared.ok) {
        entry.status = 'failed';
        entry.reason = prepared.error || prepared.code || 'PREPARE_FAILED';
        entry.draft_id = prepared.draft_id || null;
        report.failed.push({ name: seed.name, draft_id: entry.draft_id, reason: entry.reason });
        report.per_tool.push(entry);
        continue;
      }
      draftId = prepared.draft_id;
      if (prepared.draft?.readiness?.status !== 'ready') {
        entry.status = 'failed';
        entry.reason = prepared.draft.readiness.blocking_reasons?.[0] || 'READINESS_BLOCKED';
        entry.draft_id = draftId;
        report.failed.push({ name: seed.name, draft_id: draftId, reason: entry.reason });
        report.per_tool.push(entry);
        continue;
      }
      const reviewResult = reviewFn(draftId);
      if (!reviewResult.ok) {
        entry.status = 'failed';
        entry.reason = reviewResult.error || reviewResult.code || 'REVIEW_FAILED';
        entry.draft_id = draftId;
        report.failed.push({ name: seed.name, draft_id: draftId, reason: entry.reason });
        report.per_tool.push(entry);
        continue;
      }
      const appliedResult = applyFn({ draftId, previewHash: reviewResult.previewHash, expectedRevision: reviewResult.currentRevision });
      if (appliedResult.ok) {
        entry.status = 'applied';
        entry.target_revision = appliedResult.targetRevision;
        entry.draft_id = draftId;
        report.applied.push({ name: seed.name, draft_id: draftId, target_revision: appliedResult.targetRevision });
      } else {
        entry.status = 'failed';
        entry.reason = appliedResult.error || appliedResult.code || 'APPLY_FAILED';
        entry.draft_id = draftId;
        report.failed.push({ name: seed.name, draft_id: draftId, reason: entry.reason });
      }
    } catch (error) {
      entry.status = 'failed';
      entry.reason = error?.message || String(error);
      entry.draft_id = draftId;
      report.failed.push({ name: seed.name, draft_id: draftId, reason: entry.reason });
    }
    report.per_tool.push(entry);
  }
  return report;
}

// ═══════════════════════════════════════════════════════════════
// 5. 顶层编排（查重 → 解析 → 预览/生成）
// ═══════════════════════════════════════════════════════════════

function writeBatchPreview(preview, options = {}) {
  const file = options.previewFile || CATALOG_GENERATOR_FILES.batchSeedsPreview;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, preview, 'catalog-batch-preview');
  return file;
}

/**
 * 待补卡 → 正式目录卡片的完整批量入口。
 * @param {Array<object>} cards 待补卡数组（来自 readPendingCards）
 * @param {object} [options]
 *   - dryRun: true            只做查重+解析+成本估算，写 preview，不建 draft
 *   - fromPreview: true       跳过解析，复用 preview 文件的 seeds
 *   - confirmCost: true       通过全局成本确认，执行自动 apply
 *   - previewFile/seedOut     预览文件路径覆盖（测试用）
 * @returns {Promise<object>} 批量报告（含 skipped/unresolved/seeds/estimate/report）
 */
async function runBatchFromCards(cards, options = {}) {
  const dedup = dedupeBatchCandidates(cards, options);
  const skipped = {
    skippedExisting: dedup.skippedExisting,
    skippedDraft: dedup.skippedDraft,
    duplicateInBatch: dedup.duplicateInBatch,
  };
  if (!dedup.unique.length) {
    return { ok: true, dry_run: options.dryRun === true, skipped, unresolved: [], seeds: [], estimate: { ok: true, total: { ...EMPTY_COST }, per_seed: [] } };
  }

  let seeds;
  let unresolved;
  if (options.fromPreview) {
    const preview = readJson(options.previewFile || CATALOG_GENERATOR_FILES.batchSeedsPreview, null);
    if (!preview || !Array.isArray(preview.seeds)) throw new Error('PREVIEW_FILE_INVALID: 缺少 seeds');
    seeds = preview.seeds;
    unresolved = Array.isArray(preview.unresolved) ? preview.unresolved : [];
  } else {
    const resolution = await resolveBatchCandidates(dedup.unique, options);
    seeds = resolution.seeds;
    unresolved = resolution.unresolved;
  }

  const estimate = planBatchCost(seeds, options);

  if (options.dryRun) {
    const preview = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      source_cards: dedup.unique.length,
      skipped,
      unresolved,
      seeds,
      estimate,
    };
    const previewFile = writeBatchPreview(preview, options);
    return { ok: true, dry_run: true, preview_file: previewFile, skipped, unresolved, seeds, estimate };
  }

  if (options.confirmCost !== true) {
    return { ok: false, code: 'COST_CONFIRMATION_REQUIRED', cost_estimate: estimate, skipped, unresolved, seeds };
  }

  const report = await runCatalogBatch(seeds, options);
  return { ok: true, skipped, unresolved, seeds, estimate, report };
}

module.exports = {
  readPendingCards,
  dedupeBatchCandidates,
  resolveBatchCandidates,
  planBatchCost,
  runCatalogBatch,
  runBatchFromCards,
};
