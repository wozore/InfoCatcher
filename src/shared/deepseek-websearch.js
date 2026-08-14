'use strict';

const { requestResponses } = require('./deepseek-client');
const { AI_PROTOCOLS, resolveProvider } = require('./ai-provider-registry');

/**
 * DeepSeek Responses API 联网搜索（两段式工具循环）——可复用模块。
 *
 * 背景：DeepSeek 的 web_search 工具是两段式的（无状态 API）：
 *   1. 第一段：tools=[web_search] + tool_choice=web_search，服务端执行搜索，
 *      但响应中只返回 web_search_call（含真实 queries / open_page 动作）；
 *   2. 第二段：把第一段的 output（含 reasoning_text 与 web_search_call）**原样回传**，
 *      服务端才"恢复搜索结果"，模型基于结果输出带可审计 URL 的结论。
 *
 * 本模块封装整条链路：第一段强制搜索 → 提取 web_search_call → 全量回传 →
 * 循环直到模型不再调用搜索（maxRounds 兜底）→ 从最终文本提取来源 URL。
 *
 * 任何需要"DeepSeek API 联网搜索"的模块只需接入 webSearchDeepSeek 即可。
 */

const DEFAULT_SEARCH_MODEL = 'deepseek-v4-flash';
const MAX_ROUNDS = 3;
const DEFAULT_MAX_OUTPUT_TOKENS = 5000;
const MAX_URLS = 20;

/** 提取响应中全部 message 文本（可跨轮累积使用） */
function messageTextOf(data) {
  return (data.output || [])
    .filter(item => item.type === 'message')
    .map(item => (item.content || []).map(block => block.text || '').join(''))
    .join('\n')
    .trim();
}

/** 从文本提取去重后的 URL 列表（排除中文文本与中英文标点） */
function extractUrls(text) {
  if (!text) return [];
  const seen = new Set();
  const urls = [];
  // URL 字符集外显式中断：空白、引号、尖括号、中文字符、中文标点
  for (const match of String(text).matchAll(/https?:\/\/[^\s<>"'一-鿿，。；：！？、]+/g)) {
    const url = match[0].replace(/[.,;:!?)]+$/, ''); // 尾部清理英文标点与 markdown 链接闭合括号
    if (!seen.has(url) && /^https?:\/\/[\w-]/.test(url)) {
      seen.add(url);
      urls.push(url);
      if (urls.length >= MAX_URLS) break;
    }
  }
  return urls;
}

/** 从文本构建来源列表：URL + markdown 链接标题 + 所在行作为 excerpt */
function buildSourcesFromText(text) {
  return extractUrls(text).map(url => {
    const line = String(text).split(/\r?\n/).find(l => l.includes(url)) || '';
    const titleMatch = line.match(/\[([^\]]+)\]\(/);
    const title = (titleMatch && titleMatch[1].trim()) || url;
    let excerpt = line.replace(url, '').replace(/^[-*\d.\s]+/, '').replace(/^\[.*?\]\(.*\)/, '').trim();
    if (!excerpt) excerpt = url;
    return { title: title.slice(0, 240), url, excerpt: excerpt.slice(0, 1200) };
  });
}

/**
 * 发起一次联网搜索（自动两段式工具循环）。
 *
 * @param {object} options
 * @param {string} options.query          待研究主题（第一段 input）
 * @param {string} [options.instructions] 附加指令（如要求输出 JSON evidence 数组）
 * @param {string} [options.model]        缺省 deepseek-v4-flash（Responses 唯一模型）
 * @param {boolean} [options.twoStage]    是否启用两段式工具循环。缺省 true —— 这是
 *   DeepSeek Responses API 的特有行为（无状态 API，web_search 必须回传 web_search_call
 *   才恢复搜索结果）；接入其他工具（如 OpenAI 单段 web_search）时传 false 即可绕过
 *   回传循环，只发一次请求。
 * @param {number} [options.maxRounds]    回传轮次上限，缺省 3
 * @param {number} [options.timeoutMs]    单次请求超时，缺省透传 requestDeepSeek 默认
 * @param {string} [options.apiKey]       缺省 process.env.DEEPSEEK_API_KEY
 * @param {function} [options.fetchImpl]  测试注入
 * @returns {Promise<{ok:true,text:string,sources:Array<{title,url,excerpt}>,usage:Array<object>,rounds:number}|{ok:false,code:string,error:string}>}
 */
async function webSearchDeepSeek(options = {}) {
  const providerName = options.provider || 'deepseek';
  const resolved = resolveProvider(providerName);
  if (!resolved.ok) return resolved;
  const provider = resolved.provider;
  if (provider.protocol !== AI_PROTOCOLS.RESPONSES) {
    return { ok: false, code: 'AI_PROTOCOL_UNSUPPORTED', error: `provider=${providerName} 使用 ${provider.protocol}，当前只实现 Responses API` };
  }

  const {
    query,
    instructions = '',
    model = provider.defaultModel,
    maxRounds = MAX_ROUNDS,
  } = options;
  if (!query) return { ok: false, code: 'SEARCH_QUERY_REQUIRED', error: '缺少搜索主题 query' };
  if (!model) return { ok: false, code: 'AI_MODEL_REQUIRED', error: `provider=${providerName} 必须配置 model` };
  const twoStage = options.twoStage ?? provider.deepseekWebSearchTwoStage;
  const tool = provider.webSearchTool || { type: 'web_search' };
  const toolChoice = provider.webSearchToolChoice || 'auto';

  const roundOptions = {
    provider: providerName,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    endpoint: options.endpoint,
  };

  // 第一段：请求服务端执行 web_search。DeepSeek 会在这里返回 web_search_call，
  // 其他 Responses provider 按自身协议完成单段调用。
  const first = await requestResponses({
    model,
    instructions: [instructions, '你必须使用 web_search 工具搜索官方资料，不要跳过搜索。'].filter(Boolean).join('\n'),
    input: query,
    tools: [tool],
    tool_choice: twoStage ? toolChoice : 'auto',
    max_output_tokens: options.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
    stream: false,
  }, roundOptions);
  if (!first.ok) return first;

  let data = first.data;
  const usage = first.usage ? [first.usage] : [];
  const hasSearchCall = () => (data.output || []).some(item => item.type === 'web_search_call');

  // DeepSeek 的无状态 Responses API 需要把上一轮全部 output（含 reasoning_text
  // 与 web_search_call）原样回传，服务端才会恢复搜索结果。
  let rounds = 0;
  while (twoStage && hasSearchCall() && rounds < maxRounds) {
    rounds += 1;
    const next = await requestResponses({
      model,
      instructions: instructions || '你是资料研究器。根据搜索结果输出研究结论，并逐条列出可审计的来源 URL。',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: query }] },
        ...(data.output || []),
      ],
      tools: [tool],
      tool_choice: 'auto',
      max_output_tokens: options.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
      stream: false,
    }, roundOptions);
    if (!next.ok) return next;
    if (next.usage) usage.push(next.usage);
    data = next.data;
  }

  const text = messageTextOf(data);
  const sources = buildSourcesFromText(text);
  return { ok: true, text, sources, usage, rounds };
}

module.exports = {
  DEFAULT_SEARCH_MODEL,
  messageTextOf,
  extractUrls,
  buildSourcesFromText,
  webSearchDeepSeek,
  webSearchResponses: webSearchDeepSeek,
};
