/**
 * concept-batch.js —— 概念批量生成编排层（concept-cards-pending → 预览 → 人工 apply → glossary.json）
 *
 * 在热点反哺链中的位置：`min-review feedback` 产出的 concept-cards-pending.json 的唯一消费方。
 * 仿 catalog-batch.js 的工具批量链路，但轻量化、不套五层 Draft/事务：
 *   待补概念卡 → 查重（同批 + 正式 glossary）→ 回读 approved 摘要作主证据 +
 *   vibe-hub 自动补充证据 → 成本估算/确认 → 逐概念 DeepSeek 合成 → 写预览文件
 *   → 维护者查看 → 显式 `concept apply` → 原子写 glossary.json（writeJsonAtomic）。
 *
 * 设计决策（用户已拍板）：
 *   - 不自动 apply：batch 只合成出预览文件并停下，apply 等待人工显式确认。
 *   - 不调 Tavily：概念非工具，证据来自已人工 approved 摘要即可；vibe-hub 纯 HTTP 零 API 成本。
 *   - 证据主次：approved 摘要为主证据（可信、可溯源、不易幻觉）；vibe-hub 为补充
 *     （定义/别名/相关概念/权威出处，利于 source 字段）。vibe-hub 失败静默跳过，不阻塞合成。
 *   - 失败隔离：单概念合成失败跳过保留，不阻塞后续（对齐 pipeline-min 降级不抛错哲学）。
 *   - 写入走 writeJsonAtomic 轻量原子写；glossary 不在五层事务内。
 *
 * 注入点（测试 mock 用，缺省回落明确的上层注入）：
 *   options.newsEvidence / options.readNewsEvidence 维护者上层注入的 approved 新闻摘要只读证据
 *   options.glossary / options.glossaryFile        glossary 数据/路径注入
 *   options.skipVibeHub                            true 跳过 vibe-hub 抓取（dry-run 零网络）
 *   options.synthesize                             概念合成函数注入（替换真实 DeepSeek）
 *   options.ledger                                 成本账本注入
 *   options.previewFile                            预览文件路径覆盖
 *   options.ttlMs / fetchImpl / throttleState...   透传 vibe-hub-evidence
 */

'use strict';

const { readJson } = require('../../shared/json-store');
const { conceptExists, candidateKeyOf, revisionOfPending } = require('../../pending');
const { createCostLedger } = require('../core/catalog-research');
const { synthesizeConceptFields } = require('./concept-synthesis-ai');
const { DEFAULT_CONCEPT_CATEGORIES } = require('./concept-synthesis-prompt');
const { collectConceptEvidence } = require('./evidence');
const {
  readGlossary,
  writeConceptPreview,
  revisionOfGlossary,
  conceptPreviewHashOf,
  validateConceptPreview,
  readConceptPreviews,
  applyConceptPreviews,
} = require('./preview-store');


// ═══════════════════════════════════════════════════════════════
// 1. 读入
// ═══════════════════════════════════════════════════════════════

/** 读取待补概念卡文件（concept-cards-pending.json），返回 cards 数组。 */
function readPendingConcepts(filePath) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.cards)) {
    throw new Error('PENDING_CONCEPTS_INVALID: 待补概念卡文件缺少 cards 数组');
  }
  return payload.cards;
}

// ═══════════════════════════════════════════════════════════════
// 2. 查重（同批 + 正式 glossary）
// ═══════════════════════════════════════════════════════════════

function termKeyOf(term) {
  return String(term || '').trim().toLowerCase();
}

/**
 * 两层查重：同批重复（term 大小写不敏感）+ 正式 glossary 已存在
 * （复用 conceptExists 语义：term/full_name 双向子串匹配，避免近义重复）。
 * @param {Array<object>} cards 待补概念卡
 * @param {Array<object>} [glossary] 正式 glossary 条目
 * @returns {{ deduped: [], existing: [], duplicates: [] }}
 */
function dedupeConceptCandidates(cards, glossary = []) {
  const seenInBatch = new Set();
  const result = { deduped: [], existing: [], duplicates: [] };
  for (const card of cards || []) {
    const term = String(card?.term || '').trim();
    if (!term) continue;
    const key = termKeyOf(term);
    if (seenInBatch.has(key)) { result.duplicates.push({ term, reason: '同批重复' }); continue; }
    seenInBatch.add(key);
    if (conceptExists(term, glossary)) { result.existing.push({ term, reason: 'glossary 已存在' }); continue; }
    result.deduped.push(card);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// 4. 成本估算（纯函数，零副作用）
// ═══════════════════════════════════════════════════════════════

/**
 * 每概念 = 1 次合成（responses_calls + synthesis_calls）；vibe-hub 纯 HTTP 不计 ledger。
 * @returns {{ ok: true, concepts: number, cost: object, per_concept: object }}
 */
function planConceptCost(cards) {
  const count = Array.isArray(cards) ? cards.length : 0;
  return {
    ok: true,
    concepts: count,
    cost: { responses_calls: count, synthesis_calls: count },
    per_concept: { responses_calls: 1, synthesis_calls: 1 },
  };
}

function existingCategoriesOf(glossary) {
  const seen = new Set();
  const out = [];
  for (const entry of glossary || []) {
    const category = String(entry?.category || '').trim();
    if (category && !seen.has(category)) { seen.add(category); out.push(category); }
  }
  return out.length ? out : [...DEFAULT_CONCEPT_CATEGORIES];
}

// ═══════════════════════════════════════════════════════════════
// 6. 批量合成（写预览文件，不写正式库）
// ═══════════════════════════════════════════════════════════════

/**
 * 顶层编排：待补概念卡 → 查重 → 证据 → 成本 →（dry-run 停 / 确认后合成写预览）。
 * @param {Array<object>} cards 待补概念卡数组（来自 readPendingConcepts）
 * @param {object} [options]
 *   - dryRun: true            只查重 + 本地摘要证据 + 成本估算（零 AI 零网络）
 *   - confirmCost: true       通过成本确认：抓 vibe-hub 补充 + DeepSeek 合成，写预览文件停下
 * @returns {Promise<object>} 批量报告（skipped/evidence/estimate/cards/failed/cost）
 */
async function runConceptBatch(cards, options = {}) {
  const all = Array.isArray(cards) ? cards : [];
  const approved = all.filter(card => String(card?.review_status || 'pending').toLowerCase() === 'approved');
  const skippedNotApproved = all
    .filter(card => String(card?.review_status || 'pending').toLowerCase() !== 'approved')
    .map(card => ({ term: card?.term || '?', reason: '未经人工审核（需先在工作台批准）' }));
  const glossary = readGlossary(options);
  const dedup = dedupeConceptCandidates(approved, glossary);
  dedup.skippedNotApproved = skippedNotApproved;
  if (!dedup.deduped.length) {
    return {
      ok: true,
      dry_run: options.dryRun === true,
      skipped: dedup,
      concepts: [],
      evidence: [],
      estimate: planConceptCost([]),
    };
  }
  const evidence = await collectConceptEvidence(dedup.deduped, {
    ...options,
    skipVibeHub: options.dryRun ? true : options.skipVibeHub,
  });
  const estimate = planConceptCost(dedup.deduped);
  const conceptNames = dedup.deduped.map(card => card.term);
  const baseRevision = options.baseGlossaryRevision || revisionOfGlossary(glossary);
  const sourcePendingRevision = options.sourcePendingRevision || options.pendingRevision || revisionOfPending(
    dedup.deduped.map(card => ({ ...card, candidate_key: card.candidate_key || candidateKeyOf('concepts', card.term) })),
  );

  if (options.dryRun) {
    return { ok: true, dry_run: true, skipped: dedup, concepts: conceptNames, evidence, estimate };
  }
  if (options.confirmCost !== true) {
    return { ok: false, code: 'COST_CONFIRMATION_REQUIRED', cost_estimate: estimate, skipped: dedup, concepts: conceptNames, evidence };
  }

  const ledger = options.ledger ?? createCostLedger({
    responses_calls: estimate.cost.responses_calls,
    synthesis_calls: estimate.cost.synthesis_calls,
  });
  const synthesizeFn = options.synthesize || synthesizeConceptFields;
  const existingCategories = existingCategoriesOf(glossary);
  const cardsOut = [];
  const failed = [];
  for (const concept of evidence) {
    const card = concept.card;
    try {
      const result = await synthesizeFn({ card, evidence: concept.evidence, existingCategories, ledger }, options);
      if (result && result.ok) {
        cardsOut.push({ ...result.value, candidate_key: card.candidate_key || candidateKeyOf('concepts', card.term), evidence_count: concept.evidence.length, status: 'pending' });
      } else {
        failed.push({ term: card.term, reason: (result && (result.error || result.code)) || 'CONCEPT_SYNTHESIS_FAILED' });
      }
    } catch (error) {
      failed.push({ term: card.term, reason: error?.message || String(error) });
    }
  }
  const previewBody = {
    schema_version: 2,
    kind: 'concept_previews',
    generated_at: new Date().toISOString(),
    base_revision: baseRevision,
    source_pending_revision: sourcePendingRevision,
    candidate_keys: cardsOut.map(card => card.candidate_key),
    ...(options.planHash ? { plan_hash: options.planHash } : {}),
    count: cardsOut.length,
    cards: cardsOut,
  };
  const preview = { ...previewBody, preview_hash: conceptPreviewHashOf(previewBody) };
  const previewFile = writeConceptPreview(preview, options);
  return {
    ok: true,
    dry_run: false,
    skipped: dedup,
    concepts: conceptNames,
    evidence,
    estimate,
    preview_file: previewFile,
    cards: cardsOut,
    failed,
    cost: ledger.snapshot(),
  };
}

module.exports = {
  readPendingConcepts,
  dedupeConceptCandidates,
  collectConceptEvidence,
  planConceptCost,
  readGlossary,
  revisionOfGlossary,
  conceptPreviewHashOf,
  validateConceptPreview,
  existingCategoriesOf,
  runConceptBatch,
  readConceptPreviews,
  applyConceptPreviews,
};
