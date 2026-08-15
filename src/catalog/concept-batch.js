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
 * 注入点（测试 mock 用，缺省回落真实实现）：
 *   options.store                                  min-store 注入（缺省 readMinStore）
 *   options.glossary / options.glossaryFile        glossary 数据/路径注入
 *   options.skipVibeHub                            true 跳过 vibe-hub 抓取（dry-run 零网络）
 *   options.synthesize                             概念合成函数注入（替换真实 DeepSeek）
 *   options.ledger                                 成本账本注入
 *   options.previewFile                            预览文件路径覆盖
 *   options.ttlMs / fetchImpl / throttleState...   透传 vibe-hub-evidence
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../news/core/news-storage');
const { readMinStore } = require('../news/min/min-store');
const { CATALOG_FILES, CONCEPT_FILES } = require('../shared/paths');
const { conceptExists } = require('../news/feedback/tool-feedback');
const { createCostLedger } = require('./catalog-research');
const { synthesizeConceptFields } = require('./ai/concept-synthesis-ai');
const { DEFAULT_CONCEPT_CATEGORIES } = require('./ai/concept-synthesis-prompt');
const { vibeHubSlugOf, fetchVibeHubDefinition } = require('./vibe-hub-evidence');

const DEFAULT_MAX_EVIDENCE_PER_TERM = 3;
const DEFAULT_MAX_EVIDENCE_CHARS = 1200;
const EMPTY_COST = { responses_calls: 0, synthesis_calls: 0 };

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
// 3. 证据收集（approved 摘要主证据 + vibe-hub 补充）
// ═══════════════════════════════════════════════════════════════

function summaryScoreOf(item) {
  return Number(item?.final_score ?? item?.hot_score ?? 0);
}

/**
 * 逐概念收集证据：从 min-store 的 approved 且有 summary 的条目按 term 子串匹配，
 * 每概念取前 K 条（按 final_score/hot_score 降序），每条 ≤maxChars 字作主证据；
 * 再尽力抓 vibe-hub 补充（term 为纯 ASCII 且 skipVibeHub !== true 时才尝试，失败静默跳过）。
 * @returns {Promise<Array<{ card: object, evidence: Array<{kind,title,text,url?}> }>>}
 */
async function collectConceptEvidence(cards, options = {}) {
  const store = options.store ?? readMinStore();
  const candidates = Array.isArray(store?.candidates) ? store.candidates : [];
  const approvedWithSummary = candidates
    .filter(item => item && item.review_status === 'approved' && item.summary)
    .sort((a, b) => summaryScoreOf(b) - summaryScoreOf(a));
  const maxPerTerm = options.maxEvidencePerTerm ?? DEFAULT_MAX_EVIDENCE_PER_TERM;
  const maxChars = options.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS;
  const results = [];
  for (const card of cards || []) {
    const term = String(card?.term || '').trim();
    const lower = termKeyOf(term);
    const summaries = lower
      ? approvedWithSummary
        .filter(item => String(item.summary || '').toLowerCase().includes(lower))
        .slice(0, maxPerTerm)
        .map(item => ({
          kind: 'summary',
          title: String(item.title || item.author_name || 'approved 摘要').trim(),
          text: String(item.summary || '').trim().slice(0, maxChars),
          ...(item.url ? { url: item.url } : {}),
        }))
      : [];
    const evidence = [...summaries];
    if (!options.skipVibeHub && term && /^[\x00-\x7F]+$/.test(term)) {
      const slug = vibeHubSlugOf(term);
      if (slug) {
        try {
          const fetched = await fetchVibeHubDefinition(slug, options);
          if (fetched && fetched.ok) {
            evidence.push({
              kind: 'vibe-hub',
              title: String(fetched.title || term).trim(),
              text: String(fetched.text || fetched.definition || '').trim().slice(0, maxChars),
              url: `https://vibe-hub.org/${slug}`,
            });
          }
        } catch { /* vibe-hub 失败静默跳过，不阻塞合成 */ }
      }
    }
    results.push({ card, evidence });
  }
  return results;
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

// ═══════════════════════════════════════════════════════════════
// 5. glossary 读取与分类枚举
// ═══════════════════════════════════════════════════════════════

function readGlossary(options = {}) {
  if (Array.isArray(options.glossary)) return options.glossary;
  return readJson(options.glossaryFile || CATALOG_FILES.glossary, []);
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

function writeConceptPreview(preview, options = {}) {
  const file = options.previewFile || CONCEPT_FILES.previews;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, preview, 'concept-batch');
  return file;
}

/**
 * 顶层编排：待补概念卡 → 查重 → 证据 → 成本 →（dry-run 停 / 确认后合成写预览）。
 * @param {Array<object>} cards 待补概念卡数组（来自 readPendingConcepts）
 * @param {object} [options]
 *   - dryRun: true            只查重 + 本地摘要证据 + 成本估算（零 AI 零网络）
 *   - confirmCost: true       通过成本确认：抓 vibe-hub 补充 + DeepSeek 合成，写预览文件停下
 * @returns {Promise<object>} 批量报告（skipped/evidence/estimate/cards/failed/cost）
 */
async function runConceptBatch(cards, options = {}) {
  const glossary = readGlossary(options);
  const dedup = dedupeConceptCandidates(cards, glossary);
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
        cardsOut.push({ ...result.value, evidence_count: concept.evidence.length, status: 'pending' });
      } else {
        failed.push({ term: card.term, reason: (result && (result.error || result.code)) || 'CONCEPT_SYNTHESIS_FAILED' });
      }
    } catch (error) {
      failed.push({ term: card.term, reason: error?.message || String(error) });
    }
  }
  const preview = {
    schema_version: 1,
    kind: 'concept_previews',
    generated_at: new Date().toISOString(),
    count: cardsOut.length,
    cards: cardsOut,
  };
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

// ═══════════════════════════════════════════════════════════════
// 7. 预览读取 / 人工 apply（只校验 + 原子写，不调 AI）
// ═══════════════════════════════════════════════════════════════

function readConceptPreviews(options = {}) {
  return readJson(options.previewFile || CONCEPT_FILES.previews, null);
}

/** 归一化为正式 glossary 条目（7 字段，与 validate-catalog 契约一致）。 */
function normalizeGlossaryEntry(card) {
  const term = String(card?.term || '').trim();
  return {
    term,
    full_name: String(card?.full_name || '').trim() || term,
    category: String(card?.category || '').trim(),
    summary: String(card?.summary || '').trim(),
    related_terms: Array.isArray(card?.related_terms)
      ? card.related_terms.map(String).map(s => s.trim()).filter(Boolean)
      : [],
    source: {
      name: String(card?.source?.name || '').trim(),
      ...(card?.source?.url ? { url: String(card.source.url).trim() } : {}),
    },
    relevance: String(card?.relevance || '').trim(),
  };
}

/**
 * 应用预览：校验必填字段 + term 唯一（对正式库大小写不敏感），合并写回 glossary.json。
 * 保留现有顺序、追加新条、去重；--terms 可指定子集。不调 AI。
 * @param {object|null} [preview] 预览内容（缺省读概念预览文件）
 * @param {object} [options] { terms: string[], glossary?, glossaryFile? }
 * @returns {{ ok: true, added: [], skipped: [], glossary_count: number }}
 */
function applyConceptPreviews(preview, options = {}) {
  const data = preview || readConceptPreviews(options);
  const cards = Array.isArray(data?.cards) ? data.cards : [];
  const terms = Array.isArray(options.terms) && options.terms.length
    ? new Set(options.terms.map(termKeyOf))
    : null;
  const glossary = readGlossary(options);
  const existing = new Set(glossary.map(entry => termKeyOf(entry.term)));
  const added = [];
  const skipped = [];
  const next = [...glossary];
  for (const card of cards) {
    const term = String(card?.term || '').trim();
    const key = termKeyOf(term);
    if (!term) { skipped.push({ term: card?.term || '(空)', reason: '缺少 term' }); continue; }
    if (terms && !terms.has(key)) continue; // 不在指定子集
    if (existing.has(key)) { skipped.push({ term, reason: 'glossary 已存在' }); continue; }
    if (!card.category || !card.summary || !card.source || !String(card.source.name || '').trim()) {
      skipped.push({ term, reason: '缺少必填字段 (category/summary/source.name)' });
      continue;
    }
    next.push(normalizeGlossaryEntry(card));
    existing.add(key);
    added.push({ term });
  }
  if (added.length) {
    writeJsonAtomic(options.glossaryFile || CATALOG_FILES.glossary, next, 'concept-apply');
  }
  return { ok: true, added, skipped, glossary_count: next.length };
}

module.exports = {
  readPendingConcepts,
  dedupeConceptCandidates,
  collectConceptEvidence,
  planConceptCost,
  readGlossary,
  existingCategoriesOf,
  runConceptBatch,
  readConceptPreviews,
  normalizeGlossaryEntry,
  applyConceptPreviews,
};
