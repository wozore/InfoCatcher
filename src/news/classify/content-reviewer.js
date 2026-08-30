/**
 * content-reviewer.js —— 热点 AI 审核建议器
 *
 * 在热点管线 v2 中的位置：候选层（min-candidates.json）落地后、公开投影前的
 * AI 加工步骤。与 content-classifier.js（内容类型分类）、content-summarizer.js
 * （内容总结）平级，同属 AI 加工层 src/news/classify/，复用 llm-provider.js 的
 * DeepSeek 封装。
 *
 * ═══════════════════════════════════════════════════════════════
 * 职责
 * ═══════════════════════════════════════════════════════════════
 *   对候选的 标题 + 描述 + 字幕 + 内容总结 做 LLM 初步审核，
 *   输出 ai_review 建议 { verdict: approve|hold|discard, reasons, confidence }。
 *   - 初筛：discard（明显无关）保留相关；approve（建议通过）待人工最终决定；
 *   - 任何 LLM 失败（缺 key/网络/超时/输出无法解析）resolve 降级对象、verdict 置 null，
 *     绝不 reject、绝不误杀 —— 候选保持 pending，人工照常审核；
 *   - 输入素材自适应：候选有 transcript / summary 才拼入，无则自动只用其余部分。
 *
 * 公开语义（用户拍板）：ai_review 是候选上的内部建议字段，**不进公开投影**
 * （min-store 的 MIN_INTERNAL_FIELDS 剔除），仅供审核侧使用，前端零改动。
 *
 * 自动化档位（用户拍板）：review_auto_apply=true 且 confidence ≥ autoMinConfidence
 * 时，discard/hold 由 AI 自动落 review_status（reviewer='ai_review'，审计可追溯、
 * 可恢复）；**approve 永不自动落**——通过必须由人 review set/batch。
 *
 * 成本控制：默认关闭（review_enabled）、每轮上限（review_max_items_per_run）、
 * 只审核没有 ai_review 的候选（不重复花钱）、并发池限流（复用采集 concurrency）。
 */

'use strict';

const { reviewWithDeepSeek } = require('./llm-provider');

// 合法判定集合（与 llm-provider.js 的 VALID_VERDICTS 一致）
const VERDICTS = Object.freeze(['approve', 'hold', 'discard']);

// 可自动应用的判定（永不包含 approve —— 通过必须由人）
const AUTO_APPLY_VERDICTS = Object.freeze(['discard', 'hold']);

// ═══════════════════════════════════════════════════════════════
// 固定并发池：按 concurrency 并行执行 worker，保持输入顺序。
// 与 content-classifier.js / content-summarizer.js 的 runPool 同构（本地实现，避免跨模块耦合）。
// ═══════════════════════════════════════════════════════════════

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// ═══════════════════════════════════════════════════════════════
// 单条审核建议
// ═══════════════════════════════════════════════════════════════

/**
 * 从候选/条目提取审核输入素材：标题 + 描述 + 字幕 + 总结（存在才拼入）。
 * @returns {{title: string, description: string, transcript: string|null, summary: string|null}}
 */
function collectReviewSource(item) {
  const title = String(item?.title || '').trim();
  const description = String(item?.description || '').trim();
  // transcript 可能是对象（news-transcripts 写入的元数据）或字符串
  let transcript = null;
  const rawTranscript = item?.transcript;
  if (typeof rawTranscript === 'string' && rawTranscript.trim()) {
    transcript = rawTranscript.trim();
  } else if (rawTranscript && typeof rawTranscript === 'object' && typeof rawTranscript.text === 'string' && rawTranscript.text.trim()) {
    transcript = rawTranscript.text.trim();
  }
  const summary = String(item?.summary || '').trim() || null;
  return { title, description, transcript, summary };
}

/**
 * 对单条候选做 AI 审核建议（suggestion 模式，不改入参，返回建议对象）。
 * 无素材 / LLM 失败 → verdict 置 null（诚实不误杀，候选保持 pending）。
 *
 * @param {object} item - 含 title / description / 可选 transcript / summary
 * @param {{provider?: string, model?: string, apiKey?: string, fetchImpl?: Function,
 *          timeoutMs?: number, now?: string}} [options]
 * @returns {Promise<{ verdict: string|null, reasons: string[], confidence: number,
 *                     reviewer: string|null, generated_at: string|null,
 *                     input_chars: number, llm_error: string|null }>}
 */
async function reviewCandidate(item, options = {}) {
  const provider = options.provider || process.env.KNOWVIEW_REVIEW_PROVIDER || process.env.INFOCATCHER_REVIEW_PROVIDER || 'deepseek';
  const source = collectReviewSource(item);
  const inputChars = source.title.length + source.description.length
    + (source.transcript ? source.transcript.length : 0)
    + (source.summary ? source.summary.length : 0);
  const now = options.now || new Date().toISOString();

  if (!source.title && !source.description && !source.transcript && !source.summary) {
    return { verdict: null, reasons: [], confidence: 0, reviewer: null, generated_at: null, input_chars: 0, llm_error: 'no_source' };
  }

  if (provider === 'deepseek') {
    const llm = await reviewWithDeepSeek(source, options);
    if (llm.ok) {
      return {
        verdict: llm.verdict,
        reasons: llm.reasons,
        confidence: llm.confidence,
        reviewer: 'llm_deepseek',
        generated_at: now,
        input_chars: inputChars,
        llm_error: null,
      };
    }
    return {
      verdict: null,
      reasons: [],
      confidence: 0,
      reviewer: 'llm_failed',
      generated_at: null,
      input_chars: inputChars,
      llm_error: llm.error || llm.code || 'llm_failed',
    };
  }

  return { verdict: null, reasons: [], confidence: 0, reviewer: null, generated_at: null, input_chars: inputChars, llm_error: `未知审核 provider=${provider}` };
}

// ═══════════════════════════════════════════════════════════════
// 批量审核建议（纯逻辑，items 原地写入建议字段）
// ═══════════════════════════════════════════════════════════════

/**
 * 批量审核候选/条目：每条附加审核建议（item.ai_review + 内部痕迹）。
 * 跳过：无素材、已有 ai_review 的条目（控成本，不重复审核）。
 * 只写建议，不覆盖既有 ai_review。
 *
 * @param {Array<object>} items
 * @param {{provider?: string, model?: string, apiKey?: string, fetchImpl?: Function,
 *          concurrency?: number, now?: string}} [options]
 * @returns {Promise<{ reviewed: number, skipped: number, items: Array }>}
 */
async function reviewCandidates(items, options = {}) {
  const source = items || [];
  const out = new Array(source.length);
  let reviewed = 0;
  let skipped = 0;
  const pending = [];
  source.forEach((item, index) => {
    const src = item ? collectReviewSource(item) : null;
    const hasSource = Boolean(src && (src.title || src.description || src.transcript || src.summary));
    if (!item || !hasSource || item.ai_review) {
      skipped++;
      out[index] = item;
      return;
    }
    pending.push(index);
  });
  await runPool(pending, options.concurrency ?? 5, async index => {
    const item = source[index];
    const suggestion = await reviewCandidate(item, options);
    // 只写建议，不覆盖已有 ai_review（上方已跳过，双保险）；LLM 失败不写 ai_review（不误杀）
    if (suggestion.verdict) {
      item.ai_review = {
        verdict: suggestion.verdict,
        reasons: suggestion.reasons || [],
        confidence: suggestion.confidence || 0,
        reviewer: suggestion.reviewer,
        generated_at: suggestion.generated_at,
      };
      reviewed++;
    }
    item.ai_review_llm_error = suggestion.llm_error;
    out[index] = item;
  });
  return { reviewed, skipped, items: out };
}

module.exports = {
  VERDICTS,
  AUTO_APPLY_VERDICTS,
  runPool,
  collectReviewSource,
  reviewCandidate,
  reviewCandidates,
};
