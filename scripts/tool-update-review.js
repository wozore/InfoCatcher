'use strict';

const { loadDotEnv } = require('../src/shared/env');
loadDotEnv();

const { CATALOG_GENERATOR_FILES } = require('../src/shared/paths');
const { loadCatalogSnapshot } = require('../src/catalog/catalog-snapshot-store');
const { createCostLedger } = require('../src/catalog/catalog-research');
const { loadProductUrlRegistry, updateSourcesForProduct, validateProductUrlRegistry } = require('../src/catalog/official-url-registry');
const { collectProductUpdateEvidence } = require('../src/catalog/tool-update-collector');
const { suggestToolUpdateReview } = require('../src/catalog/ai/tool-update-review-ai');
const {
  findToolDetail,
  sourceForEvidence,
  planToolUpdateCandidate,
} = require('../src/catalog/tool-update-review-planner');
const {
  readReviewQueue,
  mergeAndWriteReviewQueue,
} = require('../src/catalog/tool-update-review-store');
const {
  approvedRepairsFromReviewQueue,
  planDateRepairBatch,
  applyDateRepairBatch,
} = require('../src/catalog/catalog-date-repair');
const { probeLocal } = require('../src/shared/local-model');
const { probeTavily } = require('../src/shared/tavily-client');

const GITHUB_RATE_LIMIT_URL = 'https://api.github.com/rate_limit';
const PRODUCT_KEYS = Object.freeze([
  'cursor', 'github-copilot', 'claude-code', 'trae', 'windsurf', 'openai-codex',
  'gemini-cli', 'replit-agent', 'devin', 'augment-code', 'amazon-q-developer', 'junie',
  'kiro', 'cline', 'aider', 'continue', 'qoder', 'codebuddy',
]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2).replace(/-/g, '_');
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; index += 1; }
  }
  return { positional, flags };
}

function csvFlag(value) {
  if (value === undefined || value === true) return [];
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function providerOf(flags) {
  const provider = String(flags.provider || 'local').trim().toLowerCase();
  if (!['local', 'deepseek'].includes(provider)) throw new Error(`TOOL_UPDATE_REVIEW_PROVIDER_INVALID: ${provider}`);
  return provider;
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
      headers: { 'User-Agent': 'InfoCatcher-tool-update-review/0.1', Accept: 'application/vnd.github+json' },
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
  const provider = providerOf(flags);
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
  if (provider === 'local') {
    const localProbe = deps.probeLocal || probeLocal;
    checks.local = await localProbe(deps.fetchImpl);
    checks.local = typeof checks.local === 'boolean' ? { ok: checks.local } : checks.local;
  } else {
    checks.local = { ok: true, skipped: true };
    checks.deepseek = deps.deepseekProbe ? await deps.deepseekProbe() : { ok: true, requires_confirm_cost: true };
  }

  const ok = Object.values(checks).every(check => check?.ok !== false);
  return {
    ok,
    command: 'preflight',
    status: ok ? 'ready' : 'blocked',
    provider,
    access_mode: accessMode || null,
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
  const provider = providerOf(flags);
  if (provider === 'deepseek' && flags.confirm_cost !== true) {
    return { ok: false, command: 'scan', code: 'TOOL_UPDATE_REVIEW_COST_CONFIRM_REQUIRED', error: 'DeepSeek scan 必须显式提供 --confirm-cost' };
  }
  const current = deps.loadSnapshot ? deps.loadSnapshot() : loadCatalogSnapshot();
  const ledger = deps.createLedger
    ? deps.createLedger({ responses_calls: Number(flags.max_ai_calls || Math.max(1, sources.length)) })
    : createCostLedger({ responses_calls: Number(flags.max_ai_calls || Math.max(1, sources.length)) });
  const collect = deps.collectProductUpdateEvidence || collectProductUpdateEvidence;
  const suggest = deps.suggestReview || suggestToolUpdateReview;
  const candidates = [];
  const failures = [];

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
      if (!source || !detail) {
        failures.push({ product_key: productKey, source_url: evidence.url, code: !source ? 'SOURCE_NOT_IN_REGISTRY' : 'TOOL_DETAIL_NOT_FOUND' });
        continue;
      }
      const ai = await suggest({ product_key: productKey, evidence, product, source, detail }, {
        ledger,
        provider,
        confirmCost: flags.confirm_cost === true,
        model: flags.model,
        endpoint: deps.endpoint,
        fetchImpl: deps.aiFetchImpl,
      });
      if (!ai.ok) {
        failures.push({ product_key: productKey, source_url: evidence.url, code: ai.code, error: ai.error || null });
        continue;
      }
      const planned = planToolUpdateCandidate(productKey, evidence, ai.suggestion, {
        registry,
        detail,
        now: flags.as_of || new Date().toISOString(),
      });
      candidates.push(planned.candidate);
    }
  }

  const queue = candidates.length
    ? (deps.mergeQueue || mergeAndWriteReviewQueue)(candidates, {
      file: deps.reviewFile || CATALOG_GENERATOR_FILES.toolUpdateReview,
      now: flags.as_of || new Date().toISOString(),
      runId: 'tool-update-review-scan',
    })
    : null;
  return {
    ok: true,
    command: 'scan',
    status: failures.length ? 'partial' : 'ready',
    provider,
    access_mode: accessMode || null,
    products: keys,
    evidence_count: candidates.length,
    candidate_count: candidates.length,
    failures,
    queue: queue ? { file: queue.file, appended: queue.appended, refreshed: queue.refreshed, reopened: queue.reopened, item_count: queue.queue.items.length } : null,
    cost: ledger.snapshot(),
    catalog_apply: false,
  };
}

function summaryOfItem(item) {
  return {
    candidate_key: item.candidate_key,
    product_key: item.product_key,
    detail_id: item.detail_id,
    status: item.status,
    review_status: item.review_status,
    previous_date: item.previous_date,
    proposed_date: item.proposed_date,
    source_url: item.source_url,
    blocked_reasons: item.blocked_reasons || [],
  };
}

function runList(flags = {}, deps = {}) {
  const queue = (deps.readQueue || readReviewQueue)(deps.reviewFile || CATALOG_GENERATOR_FILES.toolUpdateReview);
  const status = flags.status && String(flags.status).trim();
  if (status && !['pending', 'approved', 'rejected', 'candidate', 'blocked'].includes(status)) {
    return { ok: false, command: 'list', code: 'TOOL_UPDATE_REVIEW_STATUS_INVALID' };
  }
  const items = queue.items.filter(item => !status || item.review_status === status || item.status === status).map(summaryOfItem);
  return { ok: true, command: 'list', status_filter: status || null, count: items.length, items };
}

function runPreview(flags = {}, deps = {}) {
  const current = deps.loadSnapshot ? deps.loadSnapshot() : loadCatalogSnapshot();
  const registry = deps.loadRegistry ? deps.loadRegistry() : loadProductUrlRegistry();
  const queue = (deps.readQueue || readReviewQueue)(deps.reviewFile || CATALOG_GENERATOR_FILES.toolUpdateReview);
  const candidateKeys = csvFlag(flags.candidate_keys);
  const approved = approvedRepairsFromReviewQueue(current.snapshot, {
    registry,
    reviewQueue: queue,
    candidateKeys,
    asOf: flags.as_of,
  });
  if (!approved.ok) return { ...approved, command: 'preview' };
  const planned = planDateRepairBatch(current.snapshot, approved.repairs, { asOf: flags.as_of });
  if (!planned.ok) return { ...planned, command: 'preview' };
  return {
    ok: true,
    command: 'preview',
    expected_revision: planned.before_revision,
    preview_hash: planned.preview_hash,
    count: planned.count,
    changes: planned.changes,
    catalog_apply: false,
  };
}

async function ask(question, deps = {}) {
  if (deps.ask) return deps.ask(question);
  process.stdout.write(question);
  return new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', value => resolve(String(value).trim()));
  });
}

async function runApply(flags = {}, deps = {}) {
  if (!flags.expected_revision) return { ok: false, command: 'apply', code: 'DATE_REPAIR_EXPECTED_REVISION_REQUIRED' };
  if (!flags.preview_hash) return { ok: false, command: 'apply', code: 'DATE_REPAIR_PREVIEW_REQUIRED' };
  const confirmationValue = `APPLY TOOL-UPDATES ${flags.preview_hash}`;
  const confirmation = flags.confirm === true ? await ask(`输入 ${confirmationValue} 以确认正式写入：`, deps) : (flags.confirm || await ask(`输入 ${confirmationValue} 以确认正式写入：`, deps));
  if (confirmation !== confirmationValue) return { ok: false, command: 'apply', code: 'TOOL_UPDATE_REVIEW_CONFIRMATION_REQUIRED' };
  const result = (deps.applyBatch || applyDateRepairBatch)(undefined, {
    expectedRevision: String(flags.expected_revision),
    previewHash: String(flags.preview_hash),
    candidateKeys: csvFlag(flags.candidate_keys),
    asOf: flags.as_of,
    reviewFile: deps.reviewFile || CATALOG_GENERATOR_FILES.toolUpdateReview,
    ...(deps.reviewQueue ? { reviewQueue: deps.reviewQueue } : {}),
    ...(deps.registry ? { registry: deps.registry } : {}),
    ...(deps.snapshot ? { snapshot: deps.snapshot } : {}),
    ...(deps.commitSnapshotChange ? { commitSnapshotChange: deps.commitSnapshotChange } : {}),
  });
  return { ...result, command: 'apply' };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const { positional, flags } = parseArgs(argv);
  const [command] = positional;
  let result;
  if (command === 'preflight') result = await runPreflight(flags, deps);
  else if (command === 'scan') result = await runScan(flags, deps);
  else if (command === 'list') result = runList(flags, deps);
  else if (command === 'preview') result = runPreview(flags, deps);
  else if (command === 'apply') result = await runApply(flags, deps);
  else throw new Error('用法: tool-update-review preflight|scan|list|preview|apply [--products a,b] [--tavily-access-mode keyed|keyless] [--provider local|deepseek]');
  if (deps.print !== false) console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  main().then(result => { if (result?.ok === false) process.exitCode = 1; }).catch(error => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  PRODUCT_KEYS,
  parseArgs,
  accessModeOf,
  runPreflight,
  runScan,
  runList,
  runPreview,
  runApply,
  main,
};
