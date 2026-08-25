'use strict';

const { getProvider, resolveProvider, apiKeyForProvider } = require('../../shared/ai-provider-registry');
const { canonicalizeUrl, searchTavily, extractTavily, probeTavily } = require('../../shared/tavily-client');
const { LOCAL_API_BASE } = require('../../shared/llm-endpoints');
const { synthesizeLayerFields } = require('./deepseek-catalog-ai');
const { requestStructuredJson } = require('./deepseek-structured');

function discoveryKeywords(predicates = []) {
  const keywords = [];
  if (predicates.some(predicate => ['api_available', 'access_conditions'].includes(predicate))) keywords.push('developer API OpenAPI API documentation authentication access availability');
  if (predicates.some(predicate => ['price_rate', 'pricing_model', 'billing_period'].includes(predicate))) keywords.push('official pricing credits cost billing price');
  if (predicates.some(predicate => ['release_date', 'last_updated_date', 'availability_status'].includes(predicate))) keywords.push('official release notes announcement changelog');
  if (predicates.some(predicate => ['max_duration', 'output_resolution', 'audio_capability', 'supported_languages', 'capability', 'limitation'].includes(predicate))) keywords.push('official model guide specifications limits duration resolution audio languages');
  if (predicates.some(predicate => predicate.startsWith('vendor_'))) keywords.push('official company product platform about');
  return keywords.join(' ');
}

function officialDomainsOf(plan) {
  const urls = [plan?.seed?.official_url, ...(plan?.seed?.discovery_sources || []).map(source => source?.url)].map(canonicalizeUrl).filter(Boolean);
  return [...new Set(urls.map(url => new URL(url).hostname.toLowerCase().replace(/^www\./, '')))];
}

function buildOfficialDiscoveryQuery({ plan, scope, missing_predicates: missingPredicates = [] }) {
  const hints = [plan.seed.official_url, ...(plan.seed.discovery_sources || []).map(source => source?.url)].filter(Boolean).join(' ');
  return [
    plan.seed.name,
    plan.seed.vendor_name,
    hints,
    discoveryKeywords(missingPredicates),
    `official ${scope.kind}`,
  ].filter(Boolean).join(' ');
}

function explicitOfficialSourcesOf(plan, scope) {
  if (scope?.kind !== 'detail') return [];
  const urls = [
    plan?.seed?.official_url,
    ...(plan?.seed?.discovery_sources || [])
      .filter(source => source?.kind === 'official_hint')
      .map(source => source.url),
  ].map(canonicalizeUrl).filter(Boolean);
  return [...new Set(urls)].map(url => ({
    url,
    title: url,
    excerpt: '',
    source_kind: 'official_hint',
    source_role: 'seed_official_hint',
    discovered_for: sourceScopeOf(scope),
  }));
}

function sourceScopeOf(scope) {
  return `${scope.kind}:${scope.subject?.key || ''}`;
}

async function discoverOfficialSources(input, options = {}) {
  const result = await searchTavily({
    apiKey: options.searchApiKey,
    fetchImpl: options.searchFetchImpl || options.fetchImpl,
    timeoutMs: options.searchTimeoutMs || options.timeoutMs,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
    query: buildOfficialDiscoveryQuery(input),
    includeDomains: officialDomainsOf(input.plan),
    searchDepth: options.searchDepth || 'advanced',
    maxResults: options.maxSearchResults ?? 5,
  });
  if (!result.ok) return result;
  const discoveredSources = result.sources.map(source => ({
    ...source,
    source_kind: 'official',
    discovered_for: sourceScopeOf(input.scope),
  }));
  return {
    ok: true,
    sources: [...explicitOfficialSourcesOf(input.plan, input.scope), ...discoveredSources],
    usage: result.usage,
  };
}

function queryForScope(input) {
  return [
    input.plan.seed.name,
    input.plan.seed.vendor_name,
    discoveryKeywords(input.scope.predicates),
    input.scope.predicates.join(' '),
  ].filter(Boolean).join(' ');
}

async function acquireOfficialSources(input, options = {}) {
  const sources = (input.sources || []).map(source => ({ ...source, url: canonicalizeUrl(source.url) })).filter(source => source.url);
  if (!sources.length) return { ok: true, contents: [], failed: [] };
  const result = await extractTavily({
    apiKey: options.searchApiKey,
    fetchImpl: options.searchFetchImpl || options.fetchImpl,
    timeoutMs: options.searchTimeoutMs || options.timeoutMs,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
    urls: sources.map(source => source.url),
    query: queryForScope(input),
    extractDepth: options.extractDepth || 'advanced',
    format: options.extractFormat || 'markdown',
    chunksPerSource: options.chunksPerSource ?? 5,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    contents: result.contents,
    failed: result.failed,
    usage: result.usage,
  };
}

async function probeCatalogCapabilities(options = {}) {
  const resolved = resolveProvider(options.provider || 'deepseek');
  if (!resolved.ok) return resolved;
  const provider = resolved.provider;
  const extractionKey = apiKeyForProvider(provider, options.apiKey);
  if (!extractionKey) return { ok: false, code: `${provider.name.toUpperCase()}_AUTH_REQUIRED`, error: `缺少 ${provider.apiKeyEnv}` };
  const retrieval = await probeTavily({
    apiKey: options.searchApiKey,
    fetchImpl: options.searchFetchImpl || options.fetchImpl,
    timeoutMs: options.searchTimeoutMs || options.timeoutMs,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
  });
  if (!retrieval.ok) return retrieval;
  return {
    ok: true,
    retrieval_provider: 'tavily',
    extraction_provider: provider.name,
    protocol: provider.protocol,
    model: options.model || provider.defaultModel,
    access_mode: options.accessMode || null,
    source_count: retrieval.source_count,
  };
}

function createCatalogAiAdapters(options = {}) {
  return {
    discover: input => discoverOfficialSources(input, options),
    acquire: input => acquireOfficialSources(input, options),
    synthesize: input => synthesizeLayerFields(input, options),
  };
}

// ═══════════════════════════════════════════════════════════════
// 厂商/官方源解析（批量生成前置步骤）
//
// 背景（Q-A 决策）：researchCatalog 的信任根只收 seed.official_url +
// discovery_sources[kind='official_hint']，seed 无两者时 roots=[]，全部搜索
// 结果会被当非官方丢弃。因此批量链路在喂 seed 给生成器之前，必须先解析出
// 厂商名 + 官方域名，写进 seed.official_url 与 discovery_sources。
//
// 解析策略：Tavily 搜工具名 → DeepSeek 结构化提取 { vendor_name, official_url }。
// 缺 TAVILY key / DeepSeek key / ledger 一律 fail-closed，不硬猜（防假官方来源）。
// ═══════════════════════════════════════════════════════════════

/** 厂商解析指令（纯函数构建）。 */
function buildVendorResolutionInstructions() {
  return '你负责从工具名和搜索候选里判定官方厂商与官方域名。规则：' +
    '只选真实官网（公司/产品的官方站点），排除 GitHub、维基百科、第三方评测/聚合/下载站、社交媒体；' +
    '无法确定时 official_url 填空字符串，vendor_name 可留空由调用方回退工具名。' +
    '输出 JSON { "vendor_name": string, "official_url": string }，字段必须是字符串。';
}

/**
 * 用 Tavily 搜索 + DeepSeek 结构化提取，从工具名解析官方厂商与官方域名。
 * @param {string} name 工具名
 * @param {object} [options] { searchApiKey, searchFetchImpl, fetchImpl, searchTimeoutMs, timeoutMs,
 *                            searchDepth, maxSearchResults, provider, apiKey, model, ledger }
 *   ledger 必传（DeepSeek 结构化 fail-closed）；缺 → COST_LEDGER_REQUIRED。
 * @returns {Promise<{ok:true, vendor_name, official_url, usage} | {ok:false, code, error}>}
 */
async function resolveOfficialSource(name, options = {}) {
  const toolName = String(name || '').trim();
  if (!toolName) return { ok: false, code: 'VENDOR_RESOLUTION_NAME_REQUIRED', error: '缺少工具名' };

  const search = await searchTavily({
    apiKey: options.searchApiKey,
    fetchImpl: options.searchFetchImpl || options.fetchImpl,
    timeoutMs: options.searchTimeoutMs || options.timeoutMs,
    accessMode: options.accessMode,
    fallbackToKey: options.fallbackToKey,
    query: `${toolName} official site`,
    maxResults: options.maxSearchResults ?? 5,
    searchDepth: options.searchDepth || 'advanced',
  });
  if (!search.ok) return search;
  if (!search.sources || !search.sources.length) {
    return { ok: false, code: 'VENDOR_RESOLUTION_NO_RESULTS', error: `搜索无结果: ${toolName}` };
  }

  const providerResult = resolveProvider(options.provider || 'deepseek');
  if (!providerResult.ok) return providerResult;
  const extractionKey = apiKeyForProvider(providerResult.provider, options.apiKey);
  if (!extractionKey) return { ok: false, code: `${providerResult.provider.name.toUpperCase()}_AUTH_REQUIRED`, error: `缺少 ${providerResult.provider.apiKeyEnv}` };

  const extracted = await requestStructuredJson({
    kind: 'vendor_resolution',
    instructions: buildVendorResolutionInstructions(),
    input: JSON.stringify({
      tool_name: toolName,
      search_results: search.sources.map(source => ({ url: source.url, title: source.title })),
    }),
    maxOutputTokens: options.maxOutputTokens ?? 800,
    ledger: options.ledger,
    validate: value => value && typeof value === 'object'
      && typeof value.vendor_name === 'string' && typeof value.official_url === 'string',
  }, {
    model: options.model || getProvider('deepseek')?.defaultModel,
    apiKey: extractionKey,
    timeoutMs: options.timeoutMs,
    endpoint: options.endpoint || LOCAL_API_BASE,
  });
  if (!extracted.ok) return extracted;

  const officialUrl = canonicalizeUrl(extracted.value.official_url || '');
  if (!officialUrl) return { ok: false, code: 'VENDOR_RESOLUTION_INVALID_URL', error: `解析未得到有效官方域名: ${toolName}` };
  return {
    ok: true,
    vendor_name: String(extracted.value.vendor_name || '').trim() || toolName,
    official_url: officialUrl,
    usage: extracted.usage,
  };
}

module.exports = {
  buildOfficialDiscoveryQuery,
  discoverOfficialSources,
  acquireOfficialSources,
  probeCatalogCapabilities,
  createCatalogAiAdapters,
  buildVendorResolutionInstructions,
  resolveOfficialSource,
};
