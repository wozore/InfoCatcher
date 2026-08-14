'use strict';

const { getProvider, resolveProvider, apiKeyForProvider } = require('../../shared/ai-provider-registry');
const { canonicalizeUrl, searchTavily, extractTavily, probeTavily } = require('../../shared/tavily-client');
const { synthesizeLayerFields } = require('./deepseek-catalog-ai');

function discoveryKeywords(predicates = []) {
  const keywords = [];
  if (predicates.some(predicate => ['api_available', 'access_conditions'].includes(predicate))) keywords.push('developer API OpenAPI API documentation authentication access availability');
  if (predicates.some(predicate => ['price_rate', 'pricing_model', 'billing_period'].includes(predicate))) keywords.push('official pricing credits cost billing price');
  if (predicates.some(predicate => ['release_date', 'availability_status'].includes(predicate))) keywords.push('official release notes announcement changelog');
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

function sourceScopeOf(scope) {
  return `${scope.kind}:${scope.subject?.key || ''}`;
}

async function discoverOfficialSources(input, options = {}) {
  const result = await searchTavily({
    apiKey: options.searchApiKey,
    fetchImpl: options.searchFetchImpl || options.fetchImpl,
    timeoutMs: options.searchTimeoutMs || options.timeoutMs,
    query: buildOfficialDiscoveryQuery(input),
    includeDomains: officialDomainsOf(input.plan),
    searchDepth: options.searchDepth || 'advanced',
    maxResults: options.maxSearchResults ?? 5,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    sources: result.sources.map(source => ({
      ...source,
      source_kind: 'official',
      discovered_for: sourceScopeOf(input.scope),
    })),
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
  });
  if (!retrieval.ok) return retrieval;
  return {
    ok: true,
    retrieval_provider: 'tavily',
    extraction_provider: provider.name,
    protocol: provider.protocol,
    model: options.model || provider.defaultModel,
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

module.exports = {
  buildOfficialDiscoveryQuery,
  discoverOfficialSources,
  acquireOfficialSources,
  probeCatalogCapabilities,
  createCatalogAiAdapters,
};
