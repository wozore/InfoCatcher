'use strict';

/**
 * review-scan.js — 工具更新审核的 preflight 环境检查与 scan 采集命令实现
 *
 * 职责：preflight 只读探测（GitHub / Tavily / 本地模型 / 外部 provider 成本提示）；
 * scan 按产品登记表采集官方更新证据 → 确定性规划 → 歧义项按 hybrid 模式请求
 * AI 建议 → 汉化 → 合并写入独立审核队列。任何路径都不写五模块目录、不 Apply。
 *
 * 依赖注入：`deps.localizeToolCandidate` 由调用方提供（脚本壳绑定 news 域汉化器），
 * 本模块属 catalog 域，禁止直接 require news 域模块。
 */

const { CATALOG_GENERATOR_FILES } = require('../../shared/paths');
const { loadCatalogSnapshot, createCostLedger } = require('../core/index');
const {
  loadProductUrlRegistry,
  updateSourcesForProduct,
  validateProductUrlRegistry,
} = require('../url-registry/index');
const {
  collectProductUpdateEvidence,
  suggestToolUpdateReview,
  findToolDetail,
  sourceForEvidence,
  planToolUpdateCandidate,
  mergeAndWriteReviewQueue,
} = require('./index');
const { probeLocal } = require('../../shared/local-model');
const { probeTavily } = require('../../shared/tavily-client');
const { localizeEnabled, externalSummaryEnabled } = require('./review-localize');

const GITHUB_RATE_LIMIT_URL = 'https://api.github.com/rate_limit';
const PRODUCT_KEYS = Object.freeze([
  'cursor', 'github-copilot', 'claude-code', 'trae', 'openai-codex',
  'gemini-cli', 'replit-agent', 'devin', 'augment-code', 'amazon-q-developer', 'junie',
  'kiro', 'cline', 'aider', 'continue', 'qoder', 'codebuddy',
]);

function csvFlag(value) {
  if (value === undefined || value === true) return [];
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function providerOf(flags) {
  const provider = String(flags.provider || 'local').trim().toLowerCase();
  if (!['local', 'deepseek', 'zhipu'].includes(provider)) throw new Error(`TOOL_UPDATE_REVIEW_PROVIDER_INVALID: ${provider}`);
  return provider;
}

function modeOf(flags) {
  const mode = String(flags.mode || 'hybrid').trim().toLowerCase();
  if (!['deterministic', 'hybrid'].includes(mode)) throw new Error(`TOOL_UPDATE_REVIEW_MODE_INVALID: ${mode}`);
  return mode;
}

function accessModeOf(flags, required) {
  if (!required && flags.tavily_access_mode === undefined) return undefined;
  const value = flags.tavily_access_mode;
  if (value === undefined || value === true) throw new Error('TAVILY_ACCESS_MODE_REQUIRED: 含 Tavily 来源的命令必须显式提供 --tavily-access-mode keyed|keyless');
  const mode = String(value).trim().toLowerCase();
  if (!['keyed', 'keyless'].includes(mode)) throw new Error(`TAVILY_ACCESS_MODE_INVALID: ${value}`);
  return mode;
}

function registryValidation(registry, deps = {}) {
  if (deps.validateRegistry) return deps.validateRegistry(registry);
  return validateProductUrlRegistry(registry);
}

function selectedProductKeys(flags, registry) {
  const requested = csvFlag(flags.products);
  const keys = requested.length ? requested : PRODUCT_KEYS.filter(key => registry.products?.[key]);
  if (!keys.length) throw new Error('TOOL_UPDATE_REVIEW_PRODUCTS_EMPTY: registry 没有可扫描产品');
  const unknown = keys.filter(key => !registry.products?.[key]);
  if (unknown.length) throw new Error(`TOOL_UPDATE_REVIEW_PRODUCT_NOT_FOUND: ${unknown.join(',')}`);
  return keys;
}

function sourceListForProducts(keys, registry) {
  return keys.flatMap(productKey => updateSourcesForProduct(productKey, { registry }));
}

function sourceNeedsTavily(sources) {
  return sources.some(source => source.collector === 'tavily_extract');
}

function sourceCount(sources) {
  return {
    total: sources.length,
    github: sources.filter(source => source.collector !== 'tavily_extract').length,
    tavily: sources.filter(source => source.collector === 'tavily_extract').length,
  };
}

function detailFor(productKey, product, snapshot) {
  return findToolDetail(productKey, product, { toolDetails: snapshot?.['tool-level3'] || [] });
}

function failureSummary(productKey, failure) {
  return {
    product_key: productKey,
    source_url: failure?.source?.url || failure?.url || null,
    code: failure?.code || 'UPDATE_SOURCE_FAILED',
    error: failure?.error || null,
  };
}

async function defaultGithubProbe(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, code: 'GITHUB_FETCH_UNAVAILABLE' };
  try {
    const response = await fetchImpl(GITHUB_RATE_LIMIT_URL, {
      method: 'GET',
      headers: { 'User-Agent': 'KnowView-tool-update-review/0.1', Accept: 'application/vnd.github+json' },
    });
    return { ok: Boolean(response?.ok), status: Number(response?.status || 0) };
  } catch (error) {
    return { ok: false, code: 'GITHUB_NETWORK_ERROR', error: String(error?.message || error) };
  }
}

async function runPreflight(flags = {}, deps = {}) {
  const registry = deps.loadRegistry ? deps.loadRegistry() : loadProductUrlRegistry();
  const validation = registryValidation(registry, deps);
  if (!validation.ok) return { ok: false, command: 'preflight', code: 'PRODUCT_URL_REGISTRY_INVALID', errors: validation.errors };
  const keys = selectedProductKeys(flags, registry);
  const sources = sourceListForProducts(keys, registry);
  const accessMode = accessModeOf(flags, sourceNeedsTavily(sources));
  const mode = modeOf(flags);
  const provider = providerOf(flags);
  const localizationsEnabled = localizeEnabled(flags);
  const aiFallbackSources = sources.some(source => source.review_mode !== 'deterministic');
  const checks = {};

  const githubProbe = deps.probeGithub || defaultGithubProbe;
  checks.github = sources.some(source => source.collector !== 'tavily_extract')
    ? await githubProbe({ fetchImpl: deps.fetchImpl })
    : { ok: true, skipped: true };
  if (sourceNeedsTavily(sources)) {
    const tavilyProbe = deps.probeTavily || probeTavily;
    checks.tavily = await tavilyProbe({
      accessMode,
      fallbackToKey: false,
      apiKey: deps.searchApiKey,
      fetchImpl: deps.fetchImpl,
    });
  } else checks.tavily = { ok: true, skipped: true };
  if (localizationsEnabled || (mode === 'hybrid' && aiFallbackSources && provider === 'local')) {
    const localProbe = deps.probeLocal || probeLocal;
    checks.local = await localProbe(deps.fetchImpl);
    checks.local = typeof checks.local === 'boolean' ? { ok: checks.local } : checks.local;
  } else {
    checks.local = { ok: true, skipped: true };
  }
  if (mode === 'hybrid' && aiFallbackSources && provider !== 'local') {
    checks.deepseek = deps.deepseekProbe ? await deps.deepseekProbe() : { ok: true, requires_confirm_cost: true };
  } else checks.deepseek = { ok: true, skipped: true };

  const ok = Object.values(checks).every(check => check?.ok !== false);
  return {
    ok,
    command: 'preflight',
    status: ok ? 'ready' : 'blocked',
    provider,
    access_mode: accessMode || null,
    mode,
    products: keys,
    source_count: sourceCount(sources),
    checks,
  };
}

async function runScan(flags = {}, deps = {}) {
  const registry = deps.loadRegistry ? deps.loadRegistry() : loadProductUrlRegistry();
  const validation = registryValidation(registry, deps);
  if (!validation.ok) return { ok: false, command: 'scan', code: 'PRODUCT_URL_REGISTRY_INVALID', errors: validation.errors };
  const keys = selectedProductKeys(flags, registry);
  const sources = sourceListForProducts(keys, registry);
  const accessMode = accessModeOf(flags, sourceNeedsTavily(sources));
  const mode = modeOf(flags);
  const provider = providerOf(flags);
  const mayUseAi = mode === 'hybrid' && sources.some(source => source.review_mode !== 'deterministic');
  if (mayUseAi && provider !== 'local' && flags.confirm_cost !== true) {
    return { ok: false, command: 'scan', code: 'TOOL_UPDATE_REVIEW_COST_CONFIRM_REQUIRED', error: `外部 provider=${provider} 的 scan 必须显式提供 --confirm-cost` };
  }
  const localize = deps.localizeToolCandidate;
  if (localizeEnabled(flags) && typeof localize !== 'function') {
    throw new Error('TOOL_UPDATE_REVIEW_LOCALIZER_REQUIRED: scan 需要经 deps 注入 localizeToolCandidate（catalog 域禁止直依赖 news 域汉化器）');
  }
  const current = deps.loadSnapshot ? deps.loadSnapshot() : loadCatalogSnapshot();
  const aiSourceCount = sources.filter(source => source.review_mode !== 'deterministic').length;
  const ledger = deps.createLedger
    ? deps.createLedger({ responses_calls: Number(flags.max_ai_calls || Math.max(0, aiSourceCount)) })
    : createCostLedger({ responses_calls: Number(flags.max_ai_calls || Math.max(0, aiSourceCount)) });
  const collect = deps.collectProductUpdateEvidence || collectProductUpdateEvidence;
  const suggest = deps.suggestReview || suggestToolUpdateReview;
  const candidates = [];
  const noOpCandidates = [];
  const failures = [];
  let deterministicCount = 0;
  let needsAiCount = 0;
  let blockedCount = 0;
  let ignoredCount = 0;

  for (const productKey of keys) {
    const product = registry.products[productKey];
    const collected = await collect(productKey, {
      registry,
      accessMode,
      fallbackToKey: false,
      fetchImpl: deps.fetchImpl,
    });
    for (const failure of collected.failed || []) failures.push(failureSummary(productKey, failure));
    const detail = detailFor(productKey, product, current.snapshot);
    for (const evidence of collected.evidence || []) {
      const source = sourceForEvidence(productKey, evidence, registry);
      let planned = planToolUpdateCandidate(productKey, evidence, null, {
        registry,
        detail,
        now: flags.as_of || new Date().toISOString(),
      });
      if (planned.ignored) {
        ignoredCount++;
        noOpCandidates.push(planned.candidate);
        continue;
      }
      const canFallback = mode === 'hybrid'
        && source?.review_mode !== 'deterministic'
        && planned.blocked_reasons.length === 1
        && (planned.blocked_reasons.includes('AI_REVIEW_REQUIRED') || planned.blocked_reasons.includes('AI_OUTPUT_INVALID'));
      if (canFallback) {
        needsAiCount++;
        const ai = await suggest({ product_key: productKey, evidence, product, source, detail }, {
          ledger,
          provider,
          confirmCost: flags.confirm_cost === true,
          model: flags.model,
          endpoint: deps.endpoint,
          fetchImpl: deps.aiFetchImpl,
          notify: deps.notify,
        });
        if (ai.ok) {
          planned = planToolUpdateCandidate(productKey, evidence, ai.suggestion, {
            registry,
            detail,
            now: flags.as_of || new Date().toISOString(),
          });
        } else {
          planned.candidate.blocked_reasons = [...new Set([...(planned.candidate.blocked_reasons || []), 'AI_FALLBACK_FAILED'])];
          failures.push({ product_key: productKey, source_url: evidence.url, code: ai.code, error: ai.error || null });
        }
      }
      if (localizeEnabled(flags)) {
        await localize(planned.candidate, {
          model: flags.model,
          fetchImpl: deps.localizeFetchImpl || deps.aiFetchImpl,
          timeoutMs: deps.localizeTimeoutMs,
          now: flags.as_of || new Date().toISOString(),
          externalSummary: externalSummaryEnabled(flags),
          confirmCost: flags.confirm_cost === true,
          externalApiKey: deps.externalApiKey,
          externalFetchImpl: deps.externalFetchImpl,
          notify: deps.notify,
          ledger,
        });
      }
      candidates.push(planned.candidate);
      if (planned.candidate.decision_source === 'deterministic') deterministicCount++;
      if (planned.candidate.status === 'blocked') blockedCount++;
    }
  }

  const queue = (candidates.length || noOpCandidates.length)
    ? (deps.mergeQueue || mergeAndWriteReviewQueue)([...candidates, ...noOpCandidates], {
      file: deps.reviewFile || CATALOG_GENERATOR_FILES.toolUpdateReview,
      now: flags.as_of || new Date().toISOString(),
      registry,
      runId: 'tool-update-review-scan',
    })
    : null;
  return {
    ok: true,
    command: 'scan',
    status: failures.length ? 'partial' : 'ready',
    provider,
    mode,
    access_mode: accessMode || null,
    products: keys,
    evidence_count: candidates.length,
    candidate_count: candidates.length,
    deterministic_count: deterministicCount,
    needs_ai_count: needsAiCount,
    blocked_count: blockedCount,
    ignored_count: ignoredCount,
    failures,
    queue: queue ? { file: queue.file, appended: queue.appended, refreshed: queue.refreshed, reopened: queue.reopened, superseded: queue.superseded || 0, unchanged: queue.unchanged || false, item_count: queue.queue.items.length } : null,
    cost: ledger.snapshot(),
    catalog_apply: false,
  };
}

module.exports = {
  PRODUCT_KEYS,
  csvFlag,
  providerOf,
  modeOf,
  accessModeOf,
  localizeEnabled,
  registryValidation,
  selectedProductKeys,
  sourceNeedsTavily,
  runPreflight,
  runScan,
};
