'use strict';

const { readJson } = require('../../shared/json-store');
const { catalog } = require('../interface');
const { pendingCandidateToSeed } = require('../../pending');
const { listDrafts } = require('../draft/catalog-draft-store');
const { planCatalogDraft, normalizeGeneratorOptions, loadGeneratorConfig } = require('../draft');
const { resolveOfficialSource } = require('./catalog-adapters');
const { resolveSeriesPlacement, applyPlacementToSeed, loadSeriesPolicy } = require('../series');
const { loadSharedReleaseIndex, buildIntegratedLookup, lookupReleaseDateForSeed } = require('../catalog-integrated-lookup');
const { loadCatalogSnapshot, createCostLedger, slugify } = require('../core');
const { lookupOfficialUrl } = require('../url-registry');

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


module.exports = { lookupRegistryForCard, effectiveCardForResolution, estimateResolutionNeed, cloneSnapshot, bumpProjectedSeries, resolveBatchPlacements, generatorOptionsOf, readPendingCards, listCatalogTools, listCatalogDrafts, dedupeBatchCandidates, resolveBatchCandidates };
