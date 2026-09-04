'use strict';

const { getProvider, DEFAULT_PROVIDER_NAME } = require('../../shared/providers');
const { loadAiModuleConfig } = require('../ai-config');

function normalizeGeneratorOptions(options = {}) {
  const valueOf = (camel, snake, fallback) => {
    const value = options[camel] ?? options[snake];
    return value === undefined || value === null || value === '' ? fallback : value;
  };
  const defaultProvider = getProvider(DEFAULT_PROVIDER_NAME);
  return {
    provider: valueOf('provider', 'provider', DEFAULT_PROVIDER_NAME),
    model: valueOf('model', 'model', defaultProvider.defaultModel),
    protocol: valueOf('protocol', 'protocol', defaultProvider.protocol),
    retrievalProvider: valueOf('retrievalProvider', 'retrieval_provider', 'tavily'),
    accessMode: valueOf('accessMode', 'access_mode', undefined),
    timeoutMs: valueOf('timeoutMs', 'timeout_ms', undefined),
    maxSearchQueries: valueOf('maxSearchQueries', 'max_search_queries', undefined),
    maxPages: valueOf('maxPages', 'max_pages', undefined),
    maxResponsesCalls: valueOf('maxResponsesCalls', 'max_responses_calls', undefined),
    maxSynthesisCalls: valueOf('maxSynthesisCalls', 'max_synthesis_calls', undefined),
    maxRepairCalls: valueOf('maxRepairCalls', 'max_repair_calls', undefined),
    searchTimeoutMs: valueOf('searchTimeoutMs', 'search_timeout_ms', undefined),
    searchDepth: valueOf('searchDepth', 'search_depth', undefined),
    maxSearchResults: valueOf('maxSearchResults', 'max_search_results', undefined),
    extractDepth: valueOf('extractDepth', 'extract_depth', undefined),
    chunksPerSource: valueOf('chunksPerSource', 'chunks_per_source', undefined),
    ...(options.confirmCost !== undefined ? { confirmCost: options.confirmCost } : {}),
  };
}

function requireSeed(seed) {
  if (!seed || typeof seed !== 'object' || !seed.detail_kind || !seed.name || !seed.vendor_name) {
    return { ok: false, code: 'SEED_INVALID', error: 'Seed 必须包含 detail_kind/name/vendor_name' };
  }
  if (seed.operation && !['create', 'replace'].includes(seed.operation)) {
    return { ok: false, code: 'SEED_INVALID', error: 'operation 只允许 create 或 replace；新流程优先使用 repair_layers' };
  }
  return { ok: true };
}

function researchLimits(options = {}) {
  return {
    search_queries: options.maxSearchQueries ?? 4,
    pages: options.maxPages ?? 8,
    responses_calls: options.maxResponsesCalls ?? 12,
    synthesis_calls: options.maxSynthesisCalls ?? 1,
  };
}

function resumeResearchLimits(options = {}, previousCost = {}) {
  const incremental = researchLimits(options);
  const spent = previousCost?.spent || {};
  return Object.fromEntries(Object.entries(incremental).map(([category, limit]) => [category, Number(spent[category] || 0) + limit]));
}

function estimateResearchCost(plan, limits, options = {}) {
  const scopes = plan.research_scopes.length;
  const searchQueries = Math.min(scopes, limits.search_queries);
  return {
    hard_limits: { ...limits },
    planned_scopes: scopes,
    estimated_search_queries: searchQueries,
    estimated_synthesis_calls: scopes ? 1 : 0,
    worst_case_responses_calls: Math.min(limits.responses_calls, (scopes ? 1 : 0) + (options.maxRepairCalls ?? 1)),
  };
}

function loadGeneratorConfig() {
  return loadAiModuleConfig('catalog');
}

module.exports = {
  normalizeGeneratorOptions,
  requireSeed,
  researchLimits,
  resumeResearchLimits,
  estimateResearchCost,
  loadGeneratorConfig,
};
