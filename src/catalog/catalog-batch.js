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
const { resolveSeriesPlacement, applyPlacementToSeed } = require('./ai/catalog-series-placement-ai');
const { loadSharedReleaseIndex, buildIntegratedLookup, lookupReleaseDateForSeed } = require('./catalog-integrated-lookup');
const { loadSeriesPolicy } = require('./catalog-series-policy');
const { loadCatalogSnapshot } = require('./catalog-snapshot-store');
const { lookupOfficialUrl } = require('./official-url-registry');
const { createCostLedger } = require('./catalog-research');
const { slugify } = require('./catalog-record-builders');

const EMPTY_COST = { search_queries: 0, pages: 0, responses_calls: 0, synthesis_calls: 0 };
const MODEL_NAME_PATTERN = /(?:GPT|Claude|Gemini|Qwen|Llama|GLM|Mistral|DeepSeek|MiniMax|Grok|Kling)[\s-]?[A-Za-z]*\d/i;

function lookupRegistryForCard(card, options = {}) {
  const name = String(card?.name || card?.title || '').trim();
  const lookupOptions = {
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    ...(options.productRegistry !== undefined ? { productRegistry: options.productRegistry } : {}),
    ...(card?.detail_kind_hint ? { detailKind: card.detail_kind_hint } : {}),
  };
  const direct = lookupOfficialUrl(name, lookupOptions);
  if (direct.ok || card?.detail_kind_hint !== 'tool' || !MODEL_NAME_PATTERN.test(name)) return direct;
  const modelHit = lookupOfficialUrl(name, { ...lookupOptions, detailKind: 'api_model' });
  return modelHit.ok ? { ...modelHit, detail_kind_hint: 'api_model' } : direct;
}

/** 旧反馈数据可能把带版本号的模型标成 tool；模型登记表命中时按 api_model 继续处理。 */
function effectiveCardForResolution(card, resolution) {
  return resolution?.detail_kind_hint === 'api_model' && card?.detail_kind_hint !== 'api_model'
    ? { ...card, detail_kind_hint: 'api_model' }
    : card;
}


/** 预估待补卡中需要付费 vendor 解析的数量（registry 命中零成本）。 */
function estimateResolutionNeed(cards, options = {}) {
  let paid = 0;
  let free = 0;
  for (const card of cards || []) {
    const name = String(card.name || card.title || '').trim();
    if (!name) continue;
    const hit = lookupRegistryForCard(card, options);
    if (hit.ok) free += 1; else paid += 1;
  }
  return {
    cards_paid: paid,
    cards_free: free,
    vendor_search_upper_bound: paid,
    vendor_responses_upper_bound: paid,
  };
}

/** 浅深拷贝快照（供 placement 顺序投影，不改原始数据）。 */
function cloneSnapshot(snapshot) {
  const clone = {};
  for (const [area, items] of Object.entries(snapshot || {})) {
    clone[area] = (items || []).map(item => {
      const copy = { ...item };
      if (Array.isArray(item.level2_refs)) copy.level2_refs = [...item.level2_refs];
      if (Array.isArray(item.detail_refs)) copy.detail_refs = [...item.detail_refs];
      return copy;
    });
  }
  return clone;
}

/** 把一次 decision 的成员数累加进投影快照，使同批后续同厂商候选看到最新成员数。 */
function bumpProjectedSeries(projected, decision) {
  if (!decision || !decision.target_mode) return;
  const targetId = decision.target_level2_id;
  if (!targetId) return;
  let l2 = (projected['vendor-level2'] || []).find(x => x.id === targetId);
  if (!l2) {
    l2 = {
      id: targetId,
      level1_ref: { kind: 'vendor-level1', id: `vendor-level1:${decision.vendor}` },
      vendor_key: decision.vendor,
      title: decision.target_level2_title || '',
      official_url: '',
      summary: '',
      status: 'unknown',
      detail_refs: [],
    };
    projected['vendor-level2'].push(l2);
  }
  l2.detail_refs.push({ kind: 'tool-level3', id: 'tool-level3:__batch_placeholder__' });
}

/**
 * 批量前置：顺序解析 api_model seed 的二级系列归属（阶段 5）。
 * 顺序维护投影快照（每 decision 累加成员数），使同批多个同厂商候选基于最新成员数判定；
 * migration_required（第 4 个触发拆分）与 fail_closed 收进 blocked，由调用方阻断对应 seed。
 * 已持久化 placement_decision 的 seed（from-preview/resume）短路复用，不重复调 AI。
 * @returns {Promise<{ blocked: Array<{name,kind,code,reason}> }>}
 */
async function resolveBatchPlacements(seeds, options = {}) {
  const policy = loadSeriesPolicy();
  const base = options.snapshotOf ? options.snapshotOf() : loadCatalogSnapshot().snapshot;
  const projected = cloneSnapshot(base);
  const resolve = options.resolveSeriesPlacement || resolveSeriesPlacement;
  const blocked = [];
  for (const seed of seeds || []) {
    if (!seed || seed.detail_kind !== 'api_model') continue;
    const placement = await resolve(policy, projected, seed, {
      allowAi: options.allowAiPlacement === true,
      ledger: options.placementLedger,
      suggestPlacement: options.suggestSeriesPlacement,
    });
    if (placement.kind === 'decision') {
      applyPlacementToSeed(seed, placement);
      bumpProjectedSeries(projected, placement);
    } else if (placement.kind === 'migration_required' || placement.kind === 'fail_closed') {
      blocked.push({
        name: seed.name,
        kind: placement.kind,
        code: placement.code || 'PLACEMENT_MIGRATION_REQUIRED',
        reason: placement.reason || '',
      });
    }
  }
  return { blocked };
}

function generatorOptionsOf(options) {
  return options.generatorOptions || normalizeGeneratorOptions(loadGeneratorConfig());
}

/** 读取待补卡文件（tool-cards-pending.json），返回 cards 数组；容器/卡类型非法则 fail-closed。 */
function readPendingCards(filePath) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('PENDING_CARDS_INVALID: 待补卡文件根节点必须是对象');
  }
  if (!Array.isArray(payload.cards)) {
    throw new Error('PENDING_CARDS_INVALID: 待补卡文件缺少 cards 数组');
  }
  for (const card of payload.cards) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      throw new Error('PENDING_CARD_INVALID: 某张待补卡不是对象');
    }
    if (typeof card.name !== 'string' || !card.name.trim()) {
      throw new Error('PENDING_CARD_NAME_REQUIRED: 某张待补卡缺少 name');
    }
    if (card.detail_kind_hint !== undefined && typeof card.detail_kind_hint !== 'string') {
      throw new Error(`PENDING_CARD_DETAIL_KIND_TYPE_INVALID:${card.name}`);
    }
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
    // 精确匹配：title 或 tool_key 大小写不敏感相等（不用 toolExists 的双向子串，
    // 避免 "Command A+" 被 "Command A" 子串误判为已存在）
    const existsExact = (tools || []).some(tool =>
      (tool.title && String(tool.title).toLowerCase() === name.toLowerCase()) ||
      (tool.tool_key && String(tool.tool_key).toLowerCase() === name.toLowerCase())
    );
    if (existsExact) { result.skippedExisting.push({ name, reason: '目录已存在' }); continue; }
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
    const registryHit = lookupRegistryForCard(card, options);
    if (registryHit.ok) {
      // registry 命中零解析成本，但 seed 转换（vague/非法 kind）仍可能抛错，须收进 unresolved 而非中断整批。
      try {
        seeds.push(pendingCandidateToSeed(effectiveCardForResolution(card, registryHit), registryHit));
      } catch (error) {
        unresolved.push({ name: card.name, reason: error?.message || String(error) });
      }
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
  // 共享 release_date 索引（comparison 生成）：api_model/product_variant 缺失时机械补填
  const integratedLookup = options.integratedLookup || buildIntegratedLookup(loadSharedReleaseIndex());
  const report = { estimate, applied: [], failed: [], per_tool: [] };
  const { blocked } = await resolveBatchPlacements(seeds, options);
  const blockedByCode = new Map(blocked.map(b => [b.name, b.code]));

  for (const seed of seeds || []) {
    const entry = { name: seed.name, vendor_name: seed.vendor_name, official_url: seed.official_url, status: 'pending' };
    let draftId = null;
    try {
      // 阶段 5：迁移触发/校验失败的 seed 在批量前置阶段阻断，不进入 prepare。
      const blockCode = blockedByCode.get(seed.name);
      if (blockCode) {
        entry.status = 'failed';
        entry.reason = blockCode;
        report.failed.push({ name: seed.name, draft_id: null, reason: entry.reason });
        report.per_tool.push(entry);
        continue;
      }
      // 阶段 5.5：api_model/product_variant 从共享 release_date 索引机械补填（AI 无值时的兜底线索）
      if (integratedLookup && (seed.detail_kind === 'api_model' || seed.detail_kind === 'product_variant')) {
        const hit = lookupReleaseDateForSeed(seed, integratedLookup);
        if (hit) {
          seed.known_fields = { ...(seed.known_fields || {}), integrated_release_date: hit.date };
          entry.integrated_release_date = hit.date;
        }
      }
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
 *   - dryRun: true            查重+解析+确定性 placement，写 preview，不建 draft（付费解析预览）
 *   - fromPreview: true       跳过解析，复用 preview 文件的 seeds（含 placement_decision，不重复调 AI）
 *   - confirmCost: true       通过全局成本确认，执行自动 apply
 *   - previewFile/seedOut     预览文件路径覆盖（测试用）
 *   - allowAiPlacement        允许 ai_model 歧义候选走 AI 语义分类（阶段 4）
 * @returns {Promise<object>} 批量报告（含 skipped/unresolved/seeds/cost_estimate/report）
 *
 * 成本门禁（阶段 5）：无 confirmCost 且非 dry-run 时，零付费调用——先展示含
 * vendor_resolution / placement / research 三本账的成本估算，确认后才执行解析与生成。
 */
/** 是否已通过人工审核（review_status === 'approved'；缺失视为未审核，fail-closed）。 */
function isApprovedCard(card) {
  return String(card?.review_status || 'pending').toLowerCase() === 'approved';
}

async function runBatchFromCards(cards, options = {}) {
  const all = Array.isArray(cards) ? cards : [];
  const approvedCards = all.filter(isApprovedCard);
  const notApproved = all
    .filter(card => !isApprovedCard(card))
    .map(card => ({ name: card?.name || card?.title || '?', reason: '未经人工审核（需先在工作台批准）' }));
  const dedup = dedupeBatchCandidates(approvedCards, options);
  const skipped = {
    skippedExisting: dedup.skippedExisting,
    skippedDraft: dedup.skippedDraft,
    duplicateInBatch: dedup.duplicateInBatch,
    skippedNotApproved: notApproved,
  };
  if (!dedup.unique.length) {
    return {
      ok: true,
      dry_run: options.dryRun === true,
      skipped,
      unresolved: [],
      seeds: [],
      cost_estimate: { ok: true, resolution: { cards_paid: 0 }, placement: { ai_calls_upper_bound: 0 }, total: { ...EMPTY_COST }, per_seed: [] },
    };
  }

  let seeds = null;
  let unresolved = [];
  if (options.fromPreview) {
    const preview = readJson(options.previewFile || CATALOG_GENERATOR_FILES.batchSeedsPreview, null);
    if (!preview || !Array.isArray(preview.seeds)) throw new Error('PREVIEW_FILE_INVALID: 缺少 seeds');
    seeds = preview.seeds;
    unresolved = Array.isArray(preview.unresolved) ? preview.unresolved : [];
  }

  // 三本账成本估算（纯本地零付费）
  const resolutionNeed = options.fromPreview
    ? { cards_paid: 0, cards_free: 0, vendor_search_upper_bound: 0, vendor_responses_upper_bound: 0 }
    : estimateResolutionNeed(dedup.unique, options);
  const preSeeds = seeds || dedup.unique
    .map(card => { try { return pendingCandidateToSeed(card, {}); } catch { return null; } })
    .filter(Boolean);
  const researchEstimate = planBatchCost(preSeeds, options);
  const apiModelCount = (preSeeds || []).filter(s => s.detail_kind === 'api_model').length;
  const placementAiUpperBound = options.allowAiPlacement === true ? apiModelCount : 0;
  const cost_estimate = {
    ok: true,
    resolution: resolutionNeed,
    placement: { ai_calls_upper_bound: placementAiUpperBound },
    research: { ok: researchEstimate.ok, total: { ...researchEstimate.total }, per_seed: researchEstimate.per_seed },
    total: {
      ...researchEstimate.total,
      vendor_search_upper_bound: resolutionNeed.vendor_search_upper_bound,
      vendor_responses_upper_bound: resolutionNeed.vendor_responses_upper_bound,
      placement_ai_calls_upper_bound: placementAiUpperBound,
    },
    per_seed: researchEstimate.per_seed,
  };

  // 门禁：无确认且非 dry-run → 零付费返回估算（from-preview 也不例外）
  if (options.dryRun !== true && options.confirmCost !== true) {
    return { ok: false, code: 'COST_CONFIRMATION_REQUIRED', cost_estimate, skipped, unresolved: [], seeds: [] };
  }

  // 付费解析：仅 dry-run 预览或确认成本后执行
  if (!options.fromPreview) {
    const resolution = await resolveBatchCandidates(dedup.unique, options);
    seeds = resolution.seeds;
    unresolved = resolution.unresolved;
    cost_estimate.resolution = { ...resolutionNeed, actual: resolution.resolve_cost };
  }

  if (options.dryRun) {
    // dry-run 也做确定性 placement，把 decision 写入 preview seeds（from-preview 复用零 AI）
    const { blocked } = await resolveBatchPlacements(seeds, options);
    const preview = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      source_cards: dedup.unique.length,
      skipped,
      unresolved,
      seeds,
      estimate: cost_estimate,
      placement_blocked: blocked,
    };
    const previewFile = writeBatchPreview(preview, options);
    return { ok: true, dry_run: true, preview_file: previewFile, skipped, unresolved, seeds, estimate: cost_estimate, placement_blocked: blocked };
  }

  const report = await runCatalogBatch(seeds, options);
  return { ok: true, skipped, unresolved, seeds, estimate: cost_estimate, report };
}

module.exports = {
  readPendingCards,
  dedupeBatchCandidates,
  resolveBatchCandidates,
  estimateResolutionNeed,
  runCatalogBatch,
  runBatchFromCards,
  resolveBatchPlacements,
};
