/**
 * content-classifier.js —— 热点内容类型分类器（B16 路径 A）
 *
 * 在热点管线 v2 中的位置：候选层（min-candidates.json）→ 本模块 → 审核 → 公开 hotspots.json。
 *
 * ═══════════════════════════════════════════════════════════════
 * 两级分类（决策 65/66/79）：
 * ═══════════════════════════════════════════════════════════════
 *   L0 规则式基线 —— 零外部依赖、零成本、可离线。基于标题/描述关键词与
 *                     catalog 词典（tools/glossary）匹配内容类型六类。
 *   L1 AI 分类    —— 外部 provider（默认 zhipu，可切 deepseek；llm-provider.js），
 *                     对规则式不确定的候选做语义分类；
 *                     任何失败自动回退 L0。
 *
 * 内容类型状态机（路径 A：ai_suggested → reviewed）：
 *   content_type_status: unclassified → ai_suggested → reviewed
 *     - unclassified：未分类（路径 B 诚实占位）
 *     - ai_suggested：分类器给出建议，待人工审核
 *     - reviewed：人工审核确认，可进入公开投影
 *
 * 本模块的 L0 规则式分类为纯函数、零成本、可离线；L1 AI 分类（DeepSeek，
 * 见同目录 llm-provider.js）会发起网络请求并消费少量额度，但任何失败自动回退 L0，
 * 不阻塞采集管线。模型渠道与额度成本确认见 b16-task-status.md 第 4 项 /
 * b16-content-type-fix-plan.md §8。
 */

'use strict';

const fs = require('fs');
const { catalog } = require('../../catalog-interface');
const { classifyContent } = require('./llm-provider');

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

// B16 决策 65：内容类型六类 + unclassified（与 validate.js / build-news.js 保持一致）
const CONTENT_TYPES = Object.freeze([
  'ai_tool', 'ai_product', 'ai_concept', 'ai_technology', 'ai_industry', 'other', 'unclassified',
]);

// 路径 A 状态机：AI 分类建议 → 人工审核确认
const CONTENT_TYPE_STATUSES = Object.freeze([
  'unclassified', 'ai_suggested', 'reviewed',
]);

// 中文标签（供 CLI / 日志可读性）
const CONTENT_TYPE_LABELS = Object.freeze({
  ai_tool: 'AI 工具',
  ai_product: 'AI 产品',
  ai_concept: 'AI 概念',
  ai_technology: 'AI 技术/模型',
  ai_industry: 'AI 行业事件',
  other: '其他',
  unclassified: '未分类',
});

// ═══════════════════════════════════════════════════════════════
// 词典（catalog 数据 + 内置别名）
// ═══════════════════════════════════════════════════════════════

/** 工具名别名表：tool_id -> 匹配词（含 catalog 中的 name 与常见别名）。 */
function loadToolNames() {
  const names = new Map();
  const result = catalog({ area: 'tool-card', operation: 'list' });
  const tools = result.ok ? result.data : [];
  for (const tool of tools) {
    const key = tool.vendor_key || tool.tool_key;
    if (!names.has(key)) names.set(key, []);
    if (tool.title) names.get(key).push(tool.title);
    if (tool.vendor_label) names.get(key).push(tool.vendor_label);
  }
  return names;
}

/** 概念名集合：glossary 的 term（用于 ai_concept 命中）。 */
function loadConceptTerms() {
  const terms = [];
  try {
    const glossary = JSON.parse(fs.readFileSync(CATALOG_FILES.glossary, 'utf8'));
    for (const entry of glossary) if (entry.term) terms.push(entry.term);
  } catch {
    // catalog 缺失时退回内置最小概念表
  }
  return [...new Set(terms.concat([
    'RAG', 'Transformer', 'MoE', 'LoRA', 'RLHF', 'SFT', 'Agent', 'Token',
    'Embedding', '量化', '上下文窗口', '扩散模型', '微调', '提示工程', 'Tool Use',
  ]))];
}

// 内置别名（catalog 未覆盖的常见称呼）
const TOOL_ALIASES = {
  chatgpt: ['ChatGPT', 'GPT-5', 'GPT-Image', 'OpenAI'],
  claude: ['Claude', 'Anthropic', 'Opus', 'Fable', 'Sonnet', 'Haiku'],
  gemini: ['Gemini'],
  deepseek: ['DeepSeek'],
  tongyi: ['Qwen', '通义千问'],
  doubao: ['Doubao', '豆包'],
  kimi: ['Kimi', 'Moonshot'],
  zhipu: ['GLM', '智谱'],
  cursor: ['Cursor'],
  copilot: ['Copilot'],
  'claude-code': ['Claude Code'],
  trae: ['Trae'],
  windsurf: ['Windsurf'],
  midjourney: ['Midjourney'],
  'nano-banana': ['Nano Banana'],
  jimeng: ['Seedream', 'Seedance', '即梦'],
  runway: ['Runway'],
  kling: ['Kling', '可灵'],
  perplexity: ['Perplexity'],
  mishu: ['秘塔'],
  'notion-ai': ['Notion AI'],
  gamma: ['Gamma'],
  suno: ['Suno'],
  elevenlabs: ['ElevenLabs'],
  'stable-diffusion': ['Stable Diffusion'],
  wenxin: ['ERNIE', '文心一言'],
  xinghuo: ['星火', '讯飞'],
  hunyuan: ['混元', 'Hunyuan'],
  tiangong: ['天工', 'Skywork'],
  baichuan: ['Baichuan', '百川'],
  hailuo: ['MiniMax', '海螺'],
  grok: ['Grok'],
  poe: ['Poe'],
  dalle: ['DALL·E', 'DALL-E'],
  leonardo: ['Leonardo AI'],
  heygen: ['HeyGen'],
  notebooklm: ['NotebookLM'],
  bolt: ['Bolt.new'],
  v0: ['v0'],
  udio: ['Udio'],
  ideogram: ['Ideogram'],
  replit: ['Replit'],
  julius: ['Julius AI'],
  mistral: ['Mistral'],
  cohere: ['Cohere'],
};

// ═══════════════════════════════════════════════════════════════
// 规则式分类（L0）：关键词匹配六类
// ═══════════════════════════════════════════════════════════════

// ai_industry —— 行业事件（融资/监管/财务/安全/人事/会议等，词边界内匹配避免误伤）
const INDUSTRY_RE = /融资|funding|raises?\s\d|seed round|\bIPO\b|上市|收购|acquisition|merger|并购|监管|regulat|政策|禁令|听证|hearing|congress|政府|government|收入|revenue|财报|earnings|盈利|profit|股价|stock price|裁员|layoff|峰会|summit|breach|数据泄露|诉讼|lawsuit|incident|事故|amok|失控|泡沫|bubble|估值|valuation|conference|大会/i;

// ai_technology —— 模型/技术/研究（模型版本号、架构、研究、基准）
const TECHNOLOGY_RE = /research|paper|研究|benchmark|\bbench\b|评测|架构|architecture|训练|train|quantiz|量化|推理|inference|上下文|context window|模型|model|MoE|混合专家|参数|parameter|GPU|芯片|chip|开源|open-source|版本|version|NVFP|FP8/i;

// 模型名正则：识别明确的模型命名（GPT-5 / Gemini 3 / DeepSeek-V4 / Kimi K3 / GLM-5 / Qwen3 / Claude Opus 5 等）
const MODEL_NAME_RE = /\b(GPT-[0-9]|Gemini [0-9]|DeepSeek-V?[0-9]|Kimi K[0-9]|GLM-[0-9]|Qwen[0-9]|Claude (?:Opus|Fable|Sonnet|Haiku) ?[0-9]|Mistral (?:Large|Medium|Small) ?[0-9]|Doubao-Seed|MiniMax-M[0-9]|Command A\+|Grok [0-9]|ERNIE [0-9])\b/i;

// ai_concept —— 概念/术语/教育内容
const CONCEPT_EDU_RE = /lecture|课程|tutorial|101|crash course|讲解|解释|explain|概念|concept|原理|基础|introduction|overview|what is|how do|定义|知识点/i;

// ai_tool —— 工具使用/评测
const TOOL_USE_RE = /how to|tutorial|guide|教程|评测|试|体验|使用|tested|testing|try|tips|演示|demo|walkthrough|上手|crash course|实测|上手体验/i;

// ai_product —— 产品发布/更新/新功能
const PRODUCT_RE = /launch|release|announc|introduc|发布|上线|推出|更新|upgrade|新功能|免费|free|available|全新|is here|now live|shipping|coming soon/i;

/**
 * 从候选文本中识别命中的工具 id 列表（按工具表顺序）。
 */
function matchTools(text) {
  const toolNames = loadToolNames();
  const hits = [];
  for (const [id, names] of toolNames) {
    const aliases = TOOL_ALIASES[id] || [];
    const all = [...new Set([...(names || []), ...aliases])];
    for (const name of all) {
      if (!name || name.length < 2) continue;
      if (text.includes(name.toLowerCase())) { hits.push(id); break; }
    }
  }
  return hits;
}

/**
 * 从候选文本中识别命中的概念术语列表。
 */
function matchConcepts(text) {
  const terms = loadConceptTerms();
  return terms.filter(term => term && term.length >= 2 && text.includes(term.toLowerCase()));
}

/**
 * 规则式基线分类（L0）。
 * @param {{title?: string, description?: string, source_type?: string}} item
 * @returns {{ content_type: string, reasons: string[], hit_tools: string[], hit_concepts: string[] }}
 */
function classifyRuleBased(item) {
  const text = ((item.title || '') + ' ' + (item.description || '')).toLowerCase();
  const reasons = [];
  const hitTools = matchTools(text);
  const hitConcepts = matchConcepts(text);

  // 1) 行业事件（最高优先级：明确的行业/监管/财务/安全/人事信号）
  if (INDUSTRY_RE.test(text)) {
    reasons.push('命中行业事件关键词（融资/监管/财务/安全等）');
    return { content_type: 'ai_industry', reasons, hit_tools: hitTools, hit_concepts: hitConcepts };
  }

  // 2) 模型/技术/研究（明确的模型名或技术/研究信号）
  if (MODEL_NAME_RE.test(text) || TECHNOLOGY_RE.test(text)) {
    reasons.push('命中模型名或技术/研究关键词');
    return { content_type: 'ai_technology', reasons, hit_tools: hitTools, hit_concepts: hitConcepts };
  }

  // 3) 工具使用/评测（命中工具名 + 使用/评测类关键词）
  if (hitTools.length > 0 && TOOL_USE_RE.test(text)) {
    reasons.push('命中工具名 + 使用/评测类关键词');
    return { content_type: 'ai_tool', reasons, hit_tools: hitTools, hit_concepts: hitConcepts };
  }

  // 4) 产品发布/更新（命中工具名 + 发布类关键词，或明确 AI 产品信号）
  const aiProductSignal = PRODUCT_RE.test(text) && (hitTools.length > 0 || /\bai\b|人工智能|AI\s+(feature|app|platform|service|agent)/i.test(text));
  if (aiProductSignal) {
    reasons.push('命中工具名或 AI 产品 + 发布/更新类关键词');
    return { content_type: 'ai_product', reasons, hit_tools: hitTools, hit_concepts: hitConcepts };
  }

  // 5) 概念/术语/教育（工具/产品信号未命中时才落到概念）
  if (hitConcepts.length > 0 || CONCEPT_EDU_RE.test(text)) {
    reasons.push('命中概念术语或教育/讲解类关键词');
    return { content_type: 'ai_concept', reasons, hit_tools: hitTools, hit_concepts: hitConcepts };
  }

  // 6) 兜底
  reasons.push('未命中明确类别，归为 other');
  return { content_type: 'other', reasons, hit_tools: hitTools, hit_concepts: hitConcepts };
}

// ═══════════════════════════════════════════════════════════════
// 分类入口 / 状态机
// ═══════════════════════════════════════════════════════════════

/**
 * 分类单个候选/条目，输出 ai_suggested 建议。
 *
 * 分级逻辑：
 *   - 未配置 provider：L0 规则式基线（classifier=rule_based）。
 *   - provider=deepseek/zhipu：先跑 L1 外部语义分类（provider 开关决定端点与密钥；
 *     标签 classifier=llm_{provider}），任何失败（缺 key/网络/超时/输出无法映射）
 *     自动回退 L0（classifier=rule_based_fallback），并保留 L0 的 reasons 供审核
 *     回溯，保证不阻塞采集管线。
 *   - provider 为其他未知值：回退 L0 并标注（不产出 unclassified 占位）。
 *
 * @param {object} item - 含 title / description（可选 source_type）
 * @param {{provider?: string, model?: string, apiKey?: string, fetchImpl?: Function, concurrency?: number}} [options]
 * @returns {Promise<{ content_type: string, content_type_status: string, classifier: string,
 *                     ai_confidence: number|null, reasons: string[], hit_tools: string[], hit_concepts: string[] }>}
 */
// 支持 L1 语义分类的外部 provider 白名单（开关见 shared/providers）。
const L1_PROVIDERS = new Set(['deepseek', 'zhipu']);

async function classifyCandidate(item, options = {}) {
  const provider = options.provider || process.env.KNOWVIEW_CLASSIFY_PROVIDER || process.env.INFOCATCHER_CLASSIFY_PROVIDER;
  const model = options.model || process.env.KNOWVIEW_CLASSIFY_MODEL || process.env.INFOCATCHER_CLASSIFY_MODEL;
  const ruleResult = classifyRuleBased(item);
  let classifier = 'rule_based';
  let aiConfidence = null;
  let extraReasons = [];

  if (provider) {
    if (L1_PROVIDERS.has(provider)) {
      const llm = await classifyContent(item, { ...options, provider, model });
      if (llm.ok) {
        return {
          content_type: llm.content_type,
          content_type_status: 'ai_suggested',
          classifier: `llm_${provider}`,
          ai_confidence: llm.ai_confidence,
          reasons: [`L1 ${provider} 语义分类（置信度 ${llm.ai_confidence}）`, ...ruleResult.reasons],
          hit_tools: ruleResult.hit_tools,
          hit_concepts: ruleResult.hit_concepts,
        };
      }
      classifier = 'rule_based_fallback';
      extraReasons = [`L1 ${provider} 分类失败（${llm.error}），回退 L0 规则式`];
    } else {
      classifier = 'rule_based_fallback';
      extraReasons = [`未知分类 provider=${provider}，回退 L0 规则式`];
    }
  }

  return {
    content_type: ruleResult.content_type,
    content_type_status: 'ai_suggested',
    classifier,
    ai_confidence: aiConfidence,
    reasons: [...extraReasons, ...ruleResult.reasons],
    hit_tools: ruleResult.hit_tools,
    hit_concepts: ruleResult.hit_concepts,
  };
}

/**
 * 固定并发池：按 concurrency 并行执行 worker，保持输入顺序。
 * @param {Array} items - 待处理项（可为索引数组）
 * @param {number} concurrency - 并发上限
 * @param {(item: any) => Promise<any>} worker
 * @returns {Promise<Array>} 与 items 顺序一致的完成数组
 */
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

/**
 * 批量分类候选：每条附加分类建议（ai_suggested），不改动既有审核状态。
 * 跳过：无标题项、已 reviewed（人工结论）项。L1 开启时用并发池限流（默认 5）。
 * @param {Array<object>} items
 * @param {{provider?: string, model?: string, apiKey?: string, fetchImpl?: Function, concurrency?: number}} [options]
 * @returns {Promise<{ classified: number, skipped: number, items: Array }>}
 */
async function classifyCandidates(items, options = {}) {
  const source = items || [];
  const out = new Array(source.length);
  let classified = 0;
  let skipped = 0;
  const pending = [];
  source.forEach((item, index) => {
    if (!item || !item.title || item.content_type_status === 'reviewed') {
      skipped++;
      out[index] = item;
      return;
    }
    pending.push(index);
  });
  await runPool(pending, options.concurrency ?? 5, async index => {
    const item = source[index];
    const suggestion = await classifyCandidate(item, options);
    // 只写建议，不覆盖已审核（reviewed）的确认结果（上方已跳过，双保险）
    item.content_type = suggestion.content_type;
    item.content_type_status = suggestion.content_type_status;
    item.classifier = suggestion.classifier;
    item.classify_reasons = suggestion.reasons;
    item.ai_confidence = suggestion.ai_confidence;
    classified++;
    out[index] = item;
  });
  return { classified, skipped, items: out };
}

/**
 * 审核确认内容类型：ai_suggested → reviewed。
 * @param {object} item - 候选/条目（原地修改）
 * @param {string} contentType - 确认的内容类型（六类之一）
 * @param {{reviewer?: string, now?: string}} [meta]
 * @returns {object} 更新后的 item
 */
function confirmContentType(item, contentType, meta = {}) {
  if (!CONTENT_TYPES.includes(contentType)) {
    throw new Error(`非法内容类型：${contentType}。合法值：${CONTENT_TYPES.filter(t => t !== 'unclassified').join(' / ')}`);
  }
  item.content_type = contentType;
  item.content_type_status = 'reviewed';
  item.reviewed_content_type_at = meta.now || new Date().toISOString();
  if (meta.reviewer) item.content_type_reviewer = meta.reviewer;
  return item;
}

module.exports = {
  CONTENT_TYPES,
  CONTENT_TYPE_STATUSES,
  CONTENT_TYPE_LABELS,
  loadToolNames,
  loadConceptTerms,
  matchTools,
  matchConcepts,
  classifyRuleBased,
  classifyCandidate,
  classifyCandidates,
  confirmContentType,
};
