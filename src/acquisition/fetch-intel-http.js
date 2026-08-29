/**
 * fetch-intel-http.js — 网络抓取层
 *
 * 职责：负责工具情报采集中的 HTTP 请求与每个来源的抓取调度。
 *   - requestText：带简单重试与超时的文本抓取
 *   - fetchToolIntel：遍历单个工具的全部来源，完成「抓取 → 按解析器分派」的编排
 *
 * 从 fetch-tool-intel.js 拆分而来，仅移动代码、不重写逻辑。
 * 不发起除 fetchImpl 之外的任何真实网络请求（本层依赖调用方注入 fetch）。
 */
'use strict';

const {
  extractDeepSeekPricing,
  extractFromPricingMarkdown,
  extractFromHtmlTable,
} = require('./normalize-intel');

// ═══════════════════════════════════════════════════════════════
// 类型定义（JSDoc 注释）
// ═══════════════════════════════════════════════════════════════

/**
 * @typedef {{ id: string, url: string, type: string, method: string, publisher: string, interval_days: number, selector?: string, table_index?: number, locale?: string }} IntelSource
 * @typedef {{ tool_id: string, name: string, intel_sources: IntelSource[] }} ToolIntelConfig
 * @typedef {{ results: object[], warnings: string[], errors: string[] }} ExtractResult
 */

// ═══════════════════════════════════════════════════════════════
// HTTP 请求（复用 requestText 模式，简单重试 + 超时）
// ═══════════════════════════════════════════════════════════════

const DEFAULT_TIMEOUT = 15000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;

/**
 * 带重试与超时的文本抓取（fetch 注入模式，便于测试）。
 * 重试语义：forbidden/not_found 属确定性失败，立即抛出不重试；
 * 其余错误（含 429 rate_limited）按指数退避重试到 MAX_RETRIES 次。
 */
async function requestText(url, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  const fetchImpl = options.fetchImpl || fetch;
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': 'KnowView/1.0', ...(options.headers || {}) },
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        const code = response.status === 429 ? 'rate_limited'
          : response.status === 403 ? 'forbidden'
          : response.status === 404 ? 'not_found'
          : `http_${response.status}`;
        throw Object.assign(new Error(`HTTP ${response.status}`), { code, status: response.status });
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (error.code === 'forbidden' || error.code === 'not_found') throw error;
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_BASE_MS * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════
// 主编排函数（单工具）
// ═══════════════════════════════════════════════════════════════

/**
 * 采集单个工具的情报。
 */
async function fetchToolIntel(toolConfig, fetchImpl) {
  const log = [];
  const allResults = [];

  for (const source of toolConfig.intel_sources) {
    const entry = { source: source.id, status: 'not_attempted', result: null, warnings: [], errors: [] };

    try {
      const raw = await requestText(source.url, { fetchImpl, timeout: DEFAULT_TIMEOUT });
      log.push(`[${source.id}] 获取成功 (${raw.length} bytes)`);

      let extractResult;
      if (source.parser === 'deepseek_pricing') {
        extractResult = extractDeepSeekPricing(raw);
        entry.status = 'extracted_deepseek';
      } else if (source.method === 'pricing_markdown' || source.method === 'llms_txt') {
        extractResult = extractFromPricingMarkdown(raw, source.table_index || 0);
        entry.status = 'extracted_l1';
      } else if (source.method === 'html_table') {
        extractResult = extractFromHtmlTable(raw, source.selector);
        entry.status = extractResult.results.length > 0 ? 'extracted_l2' : 'extracted_l2_empty';
      } else if (source.method === 'llms_full_html') {
        extractResult = extractFromHtmlTable(raw);
        entry.status = extractResult.results.length > 0 ? 'extracted_l2' : 'extracted_l2_empty';
      } else {
        extractResult = { results: [], warnings: [`未知方法: ${source.method}`], errors: [] };
        entry.status = 'skipped_unsupported_method';
      }

      entry.result = extractResult.results;
      entry.warnings = extractResult.warnings;
      entry.errors = extractResult.errors;
      allResults.push(...extractResult.results.map(r => ({ ...r, _sourceId: source.id })));
    } catch (error) {
      entry.status = 'failed';
      entry.errors.push(error.message);
      log.push(`[${source.id}] 失败: ${error.message}`);
    }
  }

  return { results: allResults, log };
}

module.exports = { requestText, fetchToolIntel };
