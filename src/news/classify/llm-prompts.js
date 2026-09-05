/**
 * llm-prompts.js —— news 内容加工的 prompt 常量、payload 构造与输出归一化（纯函数层）。
 *
 * 覆盖四个任务：L1 内容分类、内容总结、审核建议、本地化翻译。
 * 网络调用在 llm-provider.js；每日 top 挑选与关键词提纯的构造在 llm-selection.js。
 *
 * 输入裁剪（控 token 成本）：标题 ≤200 字符、描述 ≤600 字符、字幕截断前 3000 字符。
 * 归一化容忍模型输出的代码块围栏、首尾噪声与中文标签映射，无法映射时返回 null
 * 由调用方降级，绝不抛错。
 */

'use strict';

// ── 输入裁剪常量 ──
const TITLE_MAX = 200;
const DESC_MAX = 600;
// 字幕输入截断（字符）：控 token 成本，足够覆盖一条视频的核心内容。
const SUMMARY_MAX_TRANSCRIPT_CHARS = 3000;

// ── L1 分类常量 ──
// 六类合法集合（与 content-classifier.js 的 CONTENT_TYPES 一致，不含 unclassified）
const VALID_TYPES = new Set(['ai_tool', 'ai_product', 'ai_concept', 'ai_technology', 'ai_industry', 'other']);
// 系统提示：强制输出单一枚举，禁止解释/JSON/多余文字
const SYSTEM_PROMPT = '你是 AI 资讯编辑。把用户给出的热点资讯归类到六个内容类型之一。只输出一个枚举值，不要输出任何其他文字、标点或 JSON。';
const USER_PROMPT_TEMPLATE = `请把下面这条 AI 资讯归类（六选一）：
- ai_tool：AI 工具（使用/评测/上手/技巧）
- ai_product：AI 产品（发布/更新/新功能）
- ai_concept：AI 概念（术语/教育/科普/原理）
- ai_technology：AI 技术/模型动态（模型发布/研究/架构/基准）
- ai_industry：AI 行业事件（融资/监管/财务/安全/人事/会议）
- other：其他
标题：{title}
描述：{description}
只输出六类之一：`;
// 中文标签 → 枚举（模型偶尔输出中文或带多余文字时的兜底映射）
const LABEL_MAP = {
  'AI 工具': 'ai_tool', '工具': 'ai_tool',
  'AI 产品': 'ai_product', '产品': 'ai_product',
  'AI 概念': 'ai_concept', '概念': 'ai_concept',
  'AI 技术/模型': 'ai_technology', 'AI 技术': 'ai_technology', 'AI 技术动态': 'ai_technology', '技术': 'ai_technology',
  'AI 行业事件': 'ai_industry', '行业': 'ai_industry',
  '其他': 'other',
};

// ── 总结常量 ──
// 总结输出上限（token）：摘要 + 要点列表可能较长，给足空间；temperature 0 保证确定。
const SUMMARY_MAX_TOKENS = 800;
// 系统提示：强制输出 JSON，禁止解释/多余文字。
const SUMMARY_SYSTEM_PROMPT = '你是 AI 资讯编辑。根据给定的热点资讯内容（标题、描述、视频字幕）生成内容总结。只输出一个 JSON 对象，不要输出任何其他文字、代码块标记或 JSON 外的内容。';
const SUMMARY_USER_PROMPT_TEMPLATE = `请为下面这条 AI 资讯生成内容总结，严格输出 JSON：
{
  "summary": "一段中文摘要",
  "key_points": ["要点1", "要点2", ...]
}
要求：
1. 忠实于原文，只提炼原文确实提到的信息，不添加原文没有的内容，不推测作者动机。
2. summary 是连贯的一段中文摘要，概括内容核心与观点。
3. key_points 是精炼的中文要点列表。
4. 摘要与要点的长度和数量根据内容的信息量自主决定，不固定字数或条数——信息量大可以更长更多，信息量小可以更短更少。
5. 如果内容不完整或不足以总结，summary 输出原文能确定的部分即可，不要编造。
标题：{title}
描述：{description}
字幕：{transcript}
只输出 JSON：`;

// ── 审核建议常量 ──
// 审核输出上限（token）：verdict + reasons + confidence，短于总结。
const REVIEW_MAX_TOKENS = 200;
// 总结输入截断（字符）：作为审核输入素材之一，控 token 成本。
const REVIEW_MAX_SUMMARY_CHARS = 800;
// 合法判定集合（与 content-reviewer.js 的 VERDICTS 一致）
const VALID_VERDICTS = new Set(['approve', 'hold', 'discard']);
const CONFIDENCE_RANGES = Object.freeze({
  '0-20%': [0, 0.2],
  '20-40%': [0.2, 0.4],
  '40-60%': [0.4, 0.6],
  '60-80%': [0.6, 0.8],
  '80-90%': [0.8, 0.9],
  '90-100%': [0.9, 1],
});
function normalizeConfidenceRange(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[–—]/g, '-').replace(/\s+/g, '');
  return Object.prototype.hasOwnProperty.call(CONFIDENCE_RANGES, normalized) ? normalized : null;
}
// 中文判定 → 枚举（模型偶尔输出中文时的兜底映射）
const VERDICT_LABEL_MAP = {
  '通过': 'approve', '建议通过': 'approve',
  '挂起': 'hold', '暂缓': 'hold', '需人工审核': 'hold',
  '丢弃': 'discard', '排除': 'discard', '无关': 'discard',
};
// 系统提示：强制输出 JSON，禁止解释/多余文字。
const REVIEW_SYSTEM_PROMPT = '你是 AI 资讯内容审核编辑。根据给定的热点资讯（标题、描述、字幕、内容总结）做初步审核。只输出一个 JSON 对象，不要输出任何其他文字、代码块标记或 JSON 外的内容。';
const REVIEW_USER_PROMPT_TEMPLATE = `请为下面这条 AI 资讯做初步审核，严格输出 JSON：
{
  "verdict": "discard | hold | approve",
  "confidence_range": "0-20% | 20-40% | 40-60% | 60-80% | 80-90% | 90-100%",
  "confidence": 0.0,
  "reasons": ["理由1", "理由2"]
}
判定标准：
- discard：明显无关的内容（非 AI 主题、广告/垃圾、纯标题党、低质量搬运等）。
- hold：存疑或信息不足（信息不全、疑似搬运、无法判断相关性等），需要人工细看，并给出 1~2 条具体理由。
- approve：与 AI 主题明确相关且有实质信息量，建议通过。
- confidence_range：按证据充分程度选择一个区间，不要把它当作统计概率：
  - 0-20%：几乎没有可核验信息，或审核请求失败。
  - 20-40%：只有极少线索，相关性或内容实质很不确定。
  - 40-60%：有部分线索，但关键信息缺失，仍明显需要人工确认。
  - 60-80%：主题和内容大致明确，但证据、来源或实质信息仍不完整。
  - 80-90%：证据较充分，只有少量边界问题，尚不足以自动处理。
  - 90-100%：有充分、直接且一致的证据，可以进入自动分流候选。
- confidence：填写所选区间的下界（例如 60-80% 填 0.60），不得填写区间外的数值。区间比单个数值更重要。
- 自动分流阈值：approve 达到 0.85、discard 达到 0.90 才会自动处理；只有选择 90-100% 区间时才允许触发自动分流。
- 如果 approve 的区间为 90-100% 或 discard 的区间为 90-100%，只输出 verdict、confidence_range 和 confidence，不要输出 reasons。
- 其他情况必须输出 1~2 条简短、具体的 reasons。
标题：{title}
描述：{description}
字幕：{transcript}
内容总结：{summary}
只输出 JSON：`;

// ── 本地化常量 ──
// 翻译输出上限（token）：标题 + 描述翻译。600 字符长描述的中文输出会超过 400 token
// 导致 JSON 截断解析失败（实测 19 条顽固缺翻译的根因），800 给足余量。
const LOCALIZE_MAX_TOKENS = 800;
// 系统提示：强制输出 JSON，禁止解释/多余文字。
const LOCALIZE_SYSTEM_PROMPT = '你是资深 AI 资讯翻译。把给定的热点资讯标题与描述翻译成简体中文。只输出一个 JSON 对象，不要输出任何其他文字、代码块标记或 JSON 外的内容。';
const LOCALIZE_USER_PROMPT_TEMPLATE = `请把下面这条 AI 资讯的标题与描述翻译成简体中文，严格输出 JSON：
{
  "title": "翻译后的标题",
  "description": "翻译后的描述"
}
要求：
1. 忠实翻译，不增删信息，不改变语义。
2. 品牌名、产品名、专有名词（如 DeepSeek、Ollama、Claude、OpenAI 等）保持原文不译。
3. URL、代码、命令、数字、版本号保持原文。
4. description 保留原文的换行结构。
5. 标题本身是专有名词时保持原文。
6. 若原文已是中文（含繁体）：标题不做逐字翻译，改为精炼为简洁新闻标题——
   去除 # 话题标签、emoji/表情符号、情绪化/夸张开场（如"👉""😱"）、个人口吻，
   提炼核心事实（谁/做了什么），控制在 20~40 字；描述保留核心信息并同样去除
   标签与表情符号噪声。
标题：{title}
描述：{description}
只输出 JSON：`;

// 孤立代理对会让 JSON 序列化与模型输入出现乱码，统一剥除。
function sanitizeSurrogates(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

// 宽松 JSON 解析：容忍 ```json 围栏与前后噪声，取首个平衡 {...} 片段。
function parseJsonLoose(raw) {
  if (!raw) return null;
  let cleaned = String(raw).trim();
  const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 描述截断上限：数字直接当上限（兼容旧签名），对象取 maxDescChars。 */
function maxDescCharsOf(options) {
  return (typeof options === 'number' ? options : options?.maxDescChars) ?? DESC_MAX;
}

// ── L1 分类 payload / 归一化 ──
function buildClassifyPayload(item, model) {
  const title = String(item.title || '').slice(0, TITLE_MAX);
  const description = String(item.description || '').slice(0, DESC_MAX);
  const prompt = USER_PROMPT_TEMPLATE.replace('{title}', title).replace('{description}', description);
  return {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: 8,
    stream: false,
  };
}

/**
 * 把模型输出规整为合法枚举。
 * 容忍：首尾引号、句号/换行残留、多余解释文字、中文标签。
 */
function normalizeLabel(raw) {
  if (!raw) return null;
  const cleaned = String(raw)
    .trim()
    .replace(/^["'`\s]+|["'`\s]+$/g, '')
    .replace(/[。.\s]+$/g, '')
    .trim();
  if (VALID_TYPES.has(cleaned)) return cleaned;
  if (LABEL_MAP[cleaned]) return LABEL_MAP[cleaned];
  // 模型偶尔在枚举前后带解释文字：按包含关系从 LABEL_MAP / VALID_TYPES 匹配
  for (const [label, type] of Object.entries(LABEL_MAP)) {
    if (label.length >= 2 && cleaned.includes(label)) return type;
  }
  for (const type of VALID_TYPES) {
    if (cleaned.includes(type)) return type;
  }
  return null;
}

// ── 总结 payload / 归一化 ──
function buildSummaryPayload(item, model, options = {}) {
  const maxDesc = maxDescCharsOf(options);
  const title = sanitizeSurrogates(String(item.title || '')).slice(0, TITLE_MAX);
  const description = sanitizeSurrogates(String(item.description || '')).slice(0, maxDesc);
  const transcript = sanitizeSurrogates(String(item.transcript || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SUMMARY_MAX_TRANSCRIPT_CHARS);
  const prompt = SUMMARY_USER_PROMPT_TEMPLATE
    .replace('{title}', title || '（无标题）')
    .replace('{description}', description || '（无描述）')
    .replace('{transcript}', transcript || '（无字幕）');
  return {
    model,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: SUMMARY_MAX_TOKENS,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
}

function normalizeSummary(raw) {
  const data = parseJsonLoose(raw);
  if (!data) return null;
  const summary = typeof data?.summary === 'string' ? data.summary.trim() : '';
  if (!summary) return null;
  const keyPoints = Array.isArray(data?.key_points)
    ? data.key_points.filter(point => typeof point === 'string' && point.trim()).map(point => point.trim())
    : [];
  return { summary, key_points: keyPoints };
}

/** 本地/外部双通道 payload 差异：外部 provider 用 JSON response_format、去掉本地思维链开关。 */
function buildExternalJsonChatPayload(chatPayload) {
  const payload = { ...chatPayload };
  delete payload.chat_template_kwargs;
  payload.response_format = { type: 'json_object' };
  return payload;
}

// ── 审核建议 payload / 归一化 ──
function buildReviewPayload(item, model, options = {}) {
  const maxDesc = maxDescCharsOf(options);
  const title = sanitizeSurrogates(String(item.title || '')).slice(0, TITLE_MAX);
  const description = sanitizeSurrogates(String(item.description || '')).slice(0, maxDesc);
  const transcript = sanitizeSurrogates(String(item.transcript || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SUMMARY_MAX_TRANSCRIPT_CHARS);
  const summary = sanitizeSurrogates(String(item.summary || '')).trim().slice(0, REVIEW_MAX_SUMMARY_CHARS);
  const prompt = REVIEW_USER_PROMPT_TEMPLATE
    .replace('{title}', title || '（无标题）')
    .replace('{description}', description || '（无描述）')
    .replace('{transcript}', transcript || '（无字幕）')
    .replace('{summary}', summary || '（无总结）');
  return {
    model,
    messages: [
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: REVIEW_MAX_TOKENS,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
}

function normalizeReview(raw) {
  const data = parseJsonLoose(raw);
  if (!data) return null;
  const rawVerdict = typeof data?.verdict === 'string' ? data.verdict.trim().toLowerCase() : '';
  const verdict = VALID_VERDICTS.has(rawVerdict) ? rawVerdict : (VERDICT_LABEL_MAP[rawVerdict] || null);
  if (!verdict) return null;
  const reasons = Array.isArray(data?.reasons)
    ? data.reasons.filter(reason => typeof reason === 'string' && reason.trim()).map(reason => reason.trim())
    : [];
  const confidenceRange = normalizeConfidenceRange(data?.confidence_range);
  const parsedConfidence = Number(data?.confidence);
  const confidence = confidenceRange
    ? CONFIDENCE_RANGES[confidenceRange][0]
    : (Number.isFinite(parsedConfidence) ? Math.max(0, Math.min(1, parsedConfidence)) : 0);
  const result = { verdict, reasons, confidence };
  if (confidenceRange) result.confidence_range = confidenceRange;
  return result;
}

// ── 本地化 payload / 归一化 ──
function buildLocalizePayload(item, model, options = {}) {
  const maxDesc = maxDescCharsOf(options);
  const title = sanitizeSurrogates(String(item.title || '')).slice(0, TITLE_MAX);
  const description = sanitizeSurrogates(String(item.description || '')).slice(0, maxDesc);
  const prompt = LOCALIZE_USER_PROMPT_TEMPLATE
    .replace('{title}', title || '（无标题）')
    .replace('{description}', description || '（无描述）');
  return {
    model,
    messages: [
      { role: 'system', content: LOCALIZE_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: LOCALIZE_MAX_TOKENS,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
}

function normalizeLocalization(raw) {
  const data = parseJsonLoose(raw);
  if (!data) return null;
  const title = typeof data?.title === 'string' ? data.title.trim() : '';
  const description = typeof data?.description === 'string' ? data.description.trim() : '';
  if (!title && !description) return null;
  return { title, description };
}

module.exports = {
  buildClassifyPayload,
  normalizeLabel,
  SUMMARY_MAX_TRANSCRIPT_CHARS,
  buildSummaryPayload,
  normalizeSummary,
  buildExternalJsonChatPayload,
  buildReviewPayload,
  normalizeReview,
  buildLocalizePayload,
  normalizeLocalization,
};
