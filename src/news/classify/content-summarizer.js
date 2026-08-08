/**
 * content-summarizer.js —— 热点内容总结器
 *
 * 在热点管线 v2 中的位置：候选层（min-candidates.json）落地后、公开投影前的
 * AI 加工步骤。与 content-classifier.js（内容类型分类）平级，同属 AI 加工层
 * src/news/classify/，复用 llm-provider.js 的 DeepSeek 封装。
 *
 * ═══════════════════════════════════════════════════════════════
 * 职责
 * ═══════════════════════════════════════════════════════════════
 *   对候选的 标题 + 描述 + 字幕（存在时）做 LLM 内容总结，
 *   输出 { summary: 单段中文摘要, key_points: 要点列表 }。
 *   - 摘要/要点长度与数量由 LLM 根据内容信息量自主决定，不固定字数（视频质量/时长不同）；
 *   - 任何 LLM 失败（缺 key/网络/超时/输出无法解析）resolve 降级对象、summary 置 null，
 *     绝不 reject —— 前端回退显示 description，不阻塞采集管线（与分类器的失败语义一致）；
 *   - 字幕为可选增强：候选有 transcript 则拼入，无则只用 title+desc，天然自适应。
 *
 * 公开语义（用户拍板）：总结是候选上的一个 AI 建议字段，**不引入独立审核状态机**，
 * 随候选 review_status 门禁进公开 —— 候选 approved 时总结一起公开，pending 时不公开。
 * 前端有总结显示总结、无总结回退 description。
 *
 * 成本控制：默认关闭（summary_enabled）、每轮上限（summary_max_items_per_run）、
 * 只总结没有 summary 的候选（不重复花钱）、并发池限流（复用采集 concurrency）。
 */

'use strict';

const { summarizeWithDeepSeek, SUMMARY_MAX_TRANSCRIPT_CHARS } = require('./llm-provider');

// ═══════════════════════════════════════════════════════════════
// 固定并发池：按 concurrency 并行执行 worker，保持输入顺序。
// 与 content-classifier.js 的 runPool 同构（本地实现，避免跨模块耦合）。
// ═══════════════════════════════════════════════════════════════

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

// ═══════════════════════════════════════════════════════════════
// 单条总结
// ═══════════════════════════════════════════════════════════════

/**
 * 从候选/条目提取总结输入素材：标题 + 描述 + 字幕（存在才拼入）。
 * @returns {{title: string, description: string, transcript: string|null}}
 */
function collectSummarySource(item) {
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
  return { title, description, transcript };
}

/**
 * 对单条候选做内容总结（suggestion 模式，不改入参，返回建议对象）。
 *
 * 分级逻辑：
 *   - 未配置 provider（默认）：L0 规则式兜底 = 诚实置 null（不伪造总结，
 *     前端回退 description）——与分类器 L0 恒兜底不同，总结没有零成本规则基线。
 *   - provider=deepseek：先跑 L1 DeepSeek；成功返回总结建议；任何失败 resolve
 *     降级对象，调用方据此置 null。
 *
 * @param {object} item - 含 title / description / 可选 transcript
 * @param {{provider?: string, model?: string, apiKey?: string, fetchImpl?: Function,
 *          timeoutMs?: number, maxTranscriptChars?: number}} [options]
 * @returns {Promise<{ summary: string|null, key_points: string[],
 *                     summarizer: string|null, generated_at: string|null,
 *                     input_chars: number, llm_error: string|null }>}
 */
async function summarizeCandidate(item, options = {}) {
  const provider = options.provider || process.env.INFOCATCHER_SUMMARIZE_PROVIDER || 'deepseek';
  const source = collectSummarySource(item);
  const inputChars = source.title.length + source.description.length + (source.transcript ? source.transcript.length : 0);
  const now = options.now || new Date().toISOString();

  if (!source.title && !source.description && !source.transcript) {
    return { summary: null, key_points: [], summarizer: null, generated_at: null, input_chars: 0, llm_error: 'no_source' };
  }

  if (provider === 'deepseek') {
    const llm = await summarizeWithDeepSeek(
      { ...source, maxTranscriptChars: options.maxTranscriptChars ?? SUMMARY_MAX_TRANSCRIPT_CHARS },
      options
    );
    if (llm.ok) {
      return {
        summary: llm.summary,
        key_points: llm.key_points,
        summarizer: 'llm_deepseek',
        generated_at: now,
        input_chars: inputChars,
        llm_error: null,
      };
    }
    return {
      summary: null,
      key_points: [],
      summarizer: 'llm_failed',
      generated_at: null,
      input_chars: inputChars,
      llm_error: llm.error || llm.code || 'llm_failed',
    };
  }

  return { summary: null, key_points: [], summarizer: null, generated_at: null, input_chars: inputChars, llm_error: `未知总结 provider=${provider}` };
}

// ═══════════════════════════════════════════════════════════════
// 批量总结（纯逻辑，items 原地写入建议字段）
// ═══════════════════════════════════════════════════════════════

/**
 * 批量总结候选/条目：每条附加总结建议（summary / summary_key_points + 内部痕迹）。
 * 跳过：无标题且无描述且无字幕、已有 summary 的条目（控成本，不重复总结）。
 * 只写建议，不覆盖已有 summary。
 *
 * @param {Array<object>} items
 * @param {{provider?: string, model?: string, apiKey?: string, fetchImpl?: Function,
 *          concurrency?: number, now?: string}} [options]
 * @returns {Promise<{ summarized: number, skipped: number, items: Array }>}
 */
async function summarizeCandidates(items, options = {}) {
  const source = items || [];
  const out = new Array(source.length);
  let summarized = 0;
  let skipped = 0;
  const pending = [];
  source.forEach((item, index) => {
    const hasSource = Boolean(
      item && (item.title || item.description || (typeof item.transcript === 'string' && item.transcript) || item.transcript?.text)
    );
    if (!item || !hasSource || item.summary) {
      skipped++;
      out[index] = item;
      return;
    }
    pending.push(index);
  });
  await runPool(pending, options.concurrency ?? 5, async index => {
    const item = source[index];
    const suggestion = await summarizeCandidate(item, options);
    // 只写建议，不覆盖已有 summary（上方已跳过，双保险）
    if (suggestion.summary) {
      item.summary = suggestion.summary;
      item.summary_key_points = suggestion.key_points || [];
    }
    item.summarizer = suggestion.summarizer;
    item.summary_generated_at = suggestion.generated_at;
    item.summary_input_chars = suggestion.input_chars;
    item.summary_llm_error = suggestion.llm_error;
    if (suggestion.summary) summarized++;
    out[index] = item;
  });
  return { summarized, skipped, items: out };
}

// ═══════════════════════════════════════════════════════════════
// 管线钩子：候选层总结 enrichment（build-news.js Phase 4 用）
// ═══════════════════════════════════════════════════════════════

/**
 * 管线钩子：对本轮候选做总结 enrichment。
 * 只处理 activeIds 内、且还没有 summary 的候选；逐条写建议字段。
 * 必须在字幕 enrichment（enrichYouTubeTranscripts）之后调用 —— 候选有 transcript
 * 时总结用字幕，无字幕时自动只用 title+desc。
 *
 * @returns {{ enabled: boolean, summarized: number, skipped: number }}
 */
async function enrichCandidateSummaries(store, activeIds, options = {}) {
  const enabled = options.enabled === true;
  if (!enabled || !store) return { enabled: false, summarized: 0, skipped: 0 };

  const ids = new Set(activeIds || []);
  const targets = (store.candidates || [])
    .filter(candidate => ids.has(candidate.id) && !candidate.summary)
    .slice(0, options.maxItems ?? 30);

  const result = await summarizeCandidates(targets, {
    provider: options.provider || 'deepseek',
    model: options.model,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    concurrency: options.concurrency ?? 5,
    timeoutMs: options.timeoutMs,
    maxTranscriptChars: options.maxTranscriptChars,
    now: options.now,
  });
  // summarizeCandidates 原地修改了 targets 上的候选对象，store 同步生效
  return { enabled: true, summarized: result.summarized, skipped: result.skipped };
}

module.exports = {
  runPool,
  collectSummarySource,
  summarizeCandidate,
  summarizeCandidates,
  enrichCandidateSummaries,
};
