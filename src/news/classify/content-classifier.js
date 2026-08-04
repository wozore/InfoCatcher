/**
 * content-classifier.js —— 热点内容类型分类器（B16 路径 A）
 *
 * 在热点管线中的位置：候选层（hotspot-candidates.json）→ 本模块 → 审核 → 公开 hotspots.json。
 *
 * ═══════════════════════════════════════════════════════════════
 * 两级分类（决策 65/66/79）：
 * ═══════════════════════════════════════════════════════════════
 *   L0 规则式基线 —— 零外部依赖、零成本、可离线。基于标题/描述关键词与
 *                     catalog 词典（tools/glossary）匹配内容类型六类。
 *   L1 AI 分类    —— 需要模型渠道（provider 配置）与额度。对规则式不确定
 *                     的候选做语义分类。本模块只提供接口占位，不发起请求。
 *
 * 内容类型状态机（路径 A：ai_suggested → reviewed）：
 *   content_type_status: unclassified → ai_suggested → reviewed
 *     - unclassified：未分类（路径 B 诚实占位）
 *     - ai_suggested：分类器给出建议，待人工审核
 *     - reviewed：人工审核确认，可进入公开投影
 *
 * 本模块只提供纯函数与词典读取，不发起网络请求、不消费额度。
 * AI 分类（L1）需先确认模型渠道与额度，见 b16-task-status.md 第 4 项成本提醒。
 */

'use strict';

const fs = require('fs');
const { CATALOG_FILES } = require('../../shared/paths');

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
  const names = new Map(); // tool_id -> 名称数组
  let tools = [];
  try {
    tools = JSON.parse(fs.readFileSync(CATALOG_FILES.tools, 'utf8'));
  } catch {
    tools = [];
  }
  for (const tool of tools) {
    const key = tool.id;
    if (!names.has(key)) names.set(key, []);
    if (tool.name) names.get(key).push(tool.name);
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
 * @param {object} item - 含 title / description（可选 source_type）
 * @param {{provider?: string, method?: string}} [options]
 * @returns {{ content_type: string, content_type_status: string, classifier: string,
 *             ai_confidence: number|null, reasons: string[], hit_tools: string[], hit_concepts: string[] }}
 */
function classifyCandidate(item, options = {}) {
  const provider = options.provider || process.env.INFOCATCHER_CLASSIFY_PROVIDER;
  if (provider) {
    // L1：AI 分类预留。需先确认模型渠道与额度，本模块不发起请求。
    return {
      content_type: 'unclassified',
      content_type_status: 'unclassified',
      classifier: 'ai_pending',
      ai_confidence: null,
      reasons: [`AI 分类（provider=${provider}）需先确认模型渠道与额度后启用（b16 成本提醒），当前保持 unclassified`],
      hit_tools: [],
      hit_concepts: [],
    };
  }
  const result = classifyRuleBased(item);
  return {
    content_type: result.content_type,
    content_type_status: 'ai_suggested',
    classifier: 'rule_based',
    ai_confidence: null, // 规则式不产出置信度；AI 分类（L1）才填
    reasons: result.reasons,
    hit_tools: result.hit_tools,
    hit_concepts: result.hit_concepts,
  };
}

/**
 * 批量分类候选：每条附加分类建议（ai_suggested），不改动既有审核状态。
 * @param {Array<object>} items
 * @param {{provider?: string}} [options]
 * @returns {{ classified: number, skipped: number, items: Array }}
 */
function classifyCandidates(items, options = {}) {
  let classified = 0;
  let skipped = 0;
  const out = (items || []).map(item => {
    if (!item || !item.title) { skipped++; return item; }
    const suggestion = classifyCandidate(item, options);
    // 只写建议，不覆盖已审核（reviewed）的确认结果
    if (item.content_type_status === 'reviewed') { skipped++; return item; }
    item.content_type = suggestion.content_type;
    item.content_type_status = suggestion.content_type_status;
    item.classifier = suggestion.classifier;
    item.classify_reasons = suggestion.reasons;
    item.ai_confidence = suggestion.ai_confidence;
    classified++;
    return item;
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
