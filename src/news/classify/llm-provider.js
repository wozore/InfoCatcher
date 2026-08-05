/**
 * llm-provider.js —— L1 AI 内容分类的模型提供方封装（B16 路径 A）
 *
 * 当前实现：DeepSeek API（OpenAI 兼容 chat completions）。
 * 与项目采集器一致使用 fetch 注入模式（options.fetchImpl 可在测试中替换为 mock），
 * 运行环境无 fetch 时通过 process.env.DEEPSEEK_API_KEY 读取密钥。
 *
 * 失败语义：任何错误（缺 key / 无 fetch / 网络超时 / 非 200 / 输出无法映射到六类）
 * 都 resolve 一个 { ok: false } 降级对象，绝不 reject、不抛错 —— 调用方（content-classifier）
 * 据此回退 L0 规则式基线，保证采集管线不被 LLM 故障阻塞（b16-task-status.md 第 4 项成本/可靠性提醒）。
 *
 * 成本控制：单条输入裁剪（标题 ≤200 字符、描述 ≤600 字符，复用采集链路截断量级），
 * 批量并发由调用方（classifyCandidates）用并发池限制。
 */

'use strict';

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

// 默认模型：deepseek-chat（DeepSeek-V3.x，价格最低；每百万输入 token 约 ¥0.5-1）
const DEFAULT_MODEL = 'deepseek-chat';
const API_BASE = 'https://api.deepseek.com/chat/completions';

// 输入裁剪（与采集链路描述截断 ≤600 字符量级一致，控制单条 token 成本）
const TITLE_MAX = 200;
const DESC_MAX = 600;

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

// ═══════════════════════════════════════════════════════════════
// 纯函数
// ═══════════════════════════════════════════════════════════════

/**
 * 构建 DeepSeek chat 请求体（纯函数，便于测试）。
 * @param {{title?: string, description?: string}} item
 * @param {string} [model]
 * @returns {object} chat completions payload
 */
function buildDeepSeekPayload(item, model = DEFAULT_MODEL) {
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
 * @param {string} raw
 * @returns {string|null} 合法枚举或 null（无法映射）
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

// ═══════════════════════════════════════════════════════════════
// DeepSeek 调用
// ═══════════════════════════════════════════════════════════════

/**
 * 对单条候选做 DeepSeek 语义分类。
 * @param {{title?: string, description?: string}} item
 * @param {{apiKey?: string, model?: string, fetchImpl?: Function, timeoutMs?: number}} [options]
 * @returns {Promise<{ ok: true, content_type: string, ai_confidence: number, raw: string } |
 *                    { ok: false, error: string, code: string }>}
 *   失败时 resolve 降级对象（不 reject）。
 */
async function classifyWithDeepSeek(item, options = {}) {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const timeoutMs = options.timeoutMs ?? 15_000;

  if (!apiKey) {
    return { ok: false, error: '缺少 DEEPSEEK_API_KEY', code: 'missing_api_key' };
  }
  if (!fetchImpl) {
    return { ok: false, error: '当前运行环境无 fetch', code: 'no_fetch' };
  }

  let payload;
  try {
    payload = buildDeepSeekPayload(item, options.model);
  } catch (err) {
    return { ok: false, error: err.message, code: 'payload_error' };
  }

  try {
    const response = await fetchImpl(API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      let detail = '';
      try {
        const text = await response.text();
        detail = (text || '').slice(0, 200);
      } catch { /* 读取错误体失败不影响降级返回 */ }
      return { ok: false, error: `DeepSeek HTTP ${response.status}${detail ? `: ${detail}` : ''}`, code: `http_${response.status}` };
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, error: 'DeepSeek 返回空内容', code: 'empty_content' };
    }
    const label = normalizeLabel(content);
    if (!label) {
      return { ok: false, error: `DeepSeek 输出无法映射到六类：${content.slice(0, 60)}`, code: 'invalid_label' };
    }
    // ai_confidence：DeepSeek 不返回 token 概率，此固定经验值仅表示"调用成功"，
    // 供建议排序参考，不作为审核依据（审核以人工确认 reviewed 为准）。
    return { ok: true, content_type: label, ai_confidence: 0.85, raw: content };
  } catch (err) {
    const code = err?.name === 'TimeoutError' || err?.code === 'ETIMEDOUT' ? 'timeout' : 'network_error';
    return { ok: false, error: err?.message || String(err), code };
  }
}

module.exports = {
  DEFAULT_MODEL,
  API_BASE,
  buildDeepSeekPayload,
  normalizeLabel,
  classifyWithDeepSeek,
  VALID_TYPES,
};
