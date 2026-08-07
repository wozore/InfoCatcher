/**
 * content-localizer.js —— 热点内容本地化（多语言翻译）器
 *
 * 在热点管线中的位置：候选层（hotspot-candidates.json）落地后、公开投影前的
 * AI 加工步骤。与 content-classifier.js（内容类型分类）、content-summarizer.js
 * （内容总结）、content-reviewer.js（AI 审核建议）平级，同属 AI 加工层
 * src/news/classify/，复用 llm-provider.js 的 DeepSeek 封装。
 *
 * ═══════════════════════════════════════════════════════════════
 * 职责
 * ═══════════════════════════════════════════════════════════════
 *   对候选的 标题 + 描述 做 LLM 翻译，输出 target locale（当前 zh）的
 *   localizations: { zh: { title, description } }。
 *   - 原文 title / description 保留在候选顶层（溯源核验基线 + 未来多语言翻译源）；
 *   - 任何 LLM 失败（缺 key/网络/超时/输出无法解析）resolve 降级对象、
 *     title/description 置 null，绝不 reject —— 前端回退显示原文，不阻塞采集管线；
 *   - 品牌名/专有名词/URL/代码保持原文不译（prompt 约束），忠实翻译不增删信息。
 *
 * 公开语义（用户拍板）：localizations 是候选上的公开字段，**进公开投影**
 * （不在 news-candidates.js 的 INTERNAL_FIELDS），前端按语言读取；中文是当前
 * 唯一语言（后续加语言即加 localizations 的 key）。localizations_meta 是内部
 * 翻译痕迹，不进公开投影（INTERNAL_FIELDS 剔除）。
 *
 * 成本控制：默认关闭（localize_enabled）、每轮上限（localize_max_items_per_run）、
 * 只翻译没有 localizations[locale] 的候选（不重复花钱）、并发池限流（复用采集 concurrency）。
 */

'use strict';

const { localizeWithDeepSeek } = require('./llm-provider');

// ═══════════════════════════════════════════════════════════════
// 固定并发池：按 concurrency 并行执行 worker，保持输入顺序。
// 与 content-classifier.js / content-summarizer.js / content-reviewer.js
// 的 runPool 同构（本地实现，避免跨模块耦合）。
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
// 单条本地化
// ═══════════════════════════════════════════════════════════════

/**
 * 从候选/条目提取翻译输入素材：标题 + 描述（原文）。
 * @returns {{title: string, description: string}}
 */
function collectLocalizeSource(item) {
  return {
    title: String(item?.title || '').trim(),
    description: String(item?.description || '').trim(),
  };
}

/**
 * 对单条候选做本地化翻译（suggestion 模式，不改入参，返回建议对象）。
 * 无素材 / LLM 失败 → title/description 置 null（诚实不误杀，前端回退原文）。
 *
 * @param {object} item - 含 title / description
 * @param {{provider?: string, locale?: string, model?: string, apiKey?: string,
 *          fetchImpl?: Function, timeoutMs?: number, now?: string}} [options]
 * @returns {Promise<{ locale: string, title: string|null, description: string|null,
 *                     localizer: string|null, generated_at: string|null,
 *                     input_chars: number, llm_error: string|null }>}
 */
async function localizeCandidate(item, options = {}) {
  const provider = options.provider || process.env.INFOCATCHER_LOCALIZE_PROVIDER || 'deepseek';
  const locale = options.locale || 'zh';
  const source = collectLocalizeSource(item);
  const inputChars = source.title.length + source.description.length;
  const now = options.now || new Date().toISOString();

  if (!source.title && !source.description) {
    return { locale, title: null, description: null, localizer: null, generated_at: null, input_chars: 0, llm_error: 'no_source' };
  }

  if (provider === 'deepseek') {
    const llm = await localizeWithDeepSeek(source, options);
    if (llm.ok) {
      return {
        locale,
        title: llm.title,
        description: llm.description,
        localizer: 'llm_deepseek',
        generated_at: now,
        input_chars: inputChars,
        llm_error: null,
      };
    }
    return {
      locale,
      title: null,
      description: null,
      localizer: 'llm_failed',
      generated_at: null,
      input_chars: inputChars,
      llm_error: llm.error || llm.code || 'llm_failed',
    };
  }

  return {
    locale, title: null, description: null, localizer: null, generated_at: null,
    input_chars: inputChars, llm_error: `未知本地化 provider=${provider}`,
  };
}

// ═══════════════════════════════════════════════════════════════
// 批量本地化（纯逻辑，items 原地写入建议字段）
// ═══════════════════════════════════════════════════════════════

/**
 * 批量本地化候选/条目：每条附加 item.localizations[locale]（公开）+ localizations_meta（内部痕迹）。
 * 跳过：无素材、已有 localizations[locale] 的条目（控成本，不重复翻译）。
 * 只写建议，不覆盖既有 localizations[locale]。
 *
 * @param {Array<object>} items
 * @param {{provider?: string, locale?: string, model?: string, apiKey?: string,
 *          fetchImpl?: Function, concurrency?: number, now?: string}} [options]
 * @returns {Promise<{ localized: number, skipped: number, items: Array }>}
 */
async function localizeCandidates(items, options = {}) {
  const source = items || [];
  const locale = options.locale || 'zh';
  const out = new Array(source.length);
  let localized = 0;
  let skipped = 0;
  const pending = [];
  source.forEach((item, index) => {
    const src = item ? collectLocalizeSource(item) : null;
    const hasSource = Boolean(src && (src.title || src.description));
    if (!item || !hasSource || item.localizations?.[locale]) {
      skipped++;
      out[index] = item;
      return;
    }
    pending.push(index);
  });
  await runPool(pending, options.concurrency ?? 5, async index => {
    const item = source[index];
    const suggestion = await localizeCandidate(item, options);
    // 只写建议，不覆盖已有 localizations[locale]（上方已跳过，双保险）；失败不写翻译（回退原文）
    if (suggestion.title || suggestion.description) {
      item.localizations ||= {};
      item.localizations[suggestion.locale] = {
        title: suggestion.title || '',
        description: suggestion.description || '',
      };
      localized++;
    }
    item.localizations_meta ||= {};
    item.localizations_meta[suggestion.locale] = {
      localizer: suggestion.localizer,
      generated_at: suggestion.generated_at,
      input_chars: suggestion.input_chars,
      llm_error: suggestion.llm_error,
    };
    out[index] = item;
  });
  return { localized, skipped, items: out };
}

// ═══════════════════════════════════════════════════════════════
// 管线钩子：候选层本地化 enrichment（build-news.js Phase 4 用）
// ═══════════════════════════════════════════════════════════════

/**
 * 管线钩子：对本轮候选做本地化 enrichment。
 * 只处理 activeIds 内、还没有 localizations[locale] 的候选；逐条写建议字段。
 * 只消费原文 title/description，与总结/审核无依赖，放 review 之后、投影之前调用。
 *
 * @returns {{ enabled: boolean, localized: number, skipped: number }}
 */
async function enrichCandidateLocalizations(store, activeIds, options = {}) {
  const enabled = options.enabled === true;
  if (!enabled || !store) return { enabled: false, localized: 0, skipped: 0 };

  const locale = options.locale || 'zh';
  const ids = new Set(activeIds || []);
  const targets = (store.candidates || [])
    .filter(candidate => ids.has(candidate.id) && !candidate.localizations?.[locale])
    .slice(0, options.maxItems ?? 30);

  const result = await localizeCandidates(targets, {
    provider: options.provider || 'deepseek',
    model: options.model,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    concurrency: options.concurrency ?? 5,
    timeoutMs: options.timeoutMs,
    locale,
    now: options.now,
  });
  // localizeCandidates 原地修改了 targets 上的候选对象，store 同步生效
  return { enabled: true, localized: result.localized, skipped: result.skipped };
}

module.exports = {
  runPool,
  collectLocalizeSource,
  localizeCandidate,
  localizeCandidates,
  enrichCandidateLocalizations,
};
