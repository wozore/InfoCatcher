'use strict';

const crypto = require('crypto');
const { canonicalizeUrl } = require('../shared/tavily-client');

const DEFAULT_LIMITS = Object.freeze({
  search_queries: 3,
  pages: 8,
  responses_calls: 8,
  synthesis_calls: 1,
});

function createCostLedger(limits = {}, initialSpent = {}) {
  const normalizedLimits = { ...DEFAULT_LIMITS, ...limits };
  const spent = Object.fromEntries(Object.keys(normalizedLimits).map(key => [key, Number(initialSpent[key] || 0)]));
  return {
    reserve(category, amount = 1) {
      if (!Object.prototype.hasOwnProperty.call(normalizedLimits, category)) return { ok: false, code: 'COST_CATEGORY_UNKNOWN', category };
      const count = Number(amount);
      if (!Number.isFinite(count) || count < 0) return { ok: false, code: 'COST_AMOUNT_INVALID', category };
      if (spent[category] + count > normalizedLimits[category]) return { ok: false, code: 'COST_BUDGET_EXHAUSTED', category, requested: count, remaining: normalizedLimits[category] - spent[category] };
      spent[category] += count;
      return { ok: true };
    },
    snapshot() {
      return {
        limits: { ...normalizedLimits },
        spent: { ...spent },
        remaining: Object.fromEntries(Object.keys(normalizedLimits).map(key => [key, Math.max(0, normalizedLimits[key] - spent[key])])),
      };
    },
  };
}

function hostOf(url) {
  const canonical = canonicalizeUrl(url);
  try { return new URL(canonical).hostname.toLowerCase(); } catch { return ''; }
}

function officialRootsOf(seed) {
  const urls = [seed.official_url, ...(seed.discovery_sources || []).filter(source => source?.kind === 'official_hint').map(source => source.url)].map(canonicalizeUrl).filter(Boolean);
  return [...new Set(urls.map(hostOf).filter(Boolean))];
}

function isTrustedOfficialUrl(url, roots) {
  const host = hostOf(url);
  return Boolean(host && roots.some(root => host === root || host.endsWith(`.${root}`)));
}

function sourceIdOf(url) {
  const canonical = canonicalizeUrl(url) || String(url || '').trim();
  return `source-${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
}

function dedupeBy(items, keyOf) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyOf(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function costFailure(reservation) {
  return { ok: false, code: reservation.code, error: `${reservation.category} 成本预算不足` };
}

function scopeKey(scope) {
  return `${scope.kind}:${scope.subject?.key || ''}`;
}

function scopeRefsOf(source) {
  if (Array.isArray(source?.discovered_for)) return source.discovered_for.filter(Boolean);
  if (source?.discovered_for) return [source.discovered_for];
  return [];
}

function normalizeSource(source, roots) {
  const url = canonicalizeUrl(source?.url);
  if (!url || !isTrustedOfficialUrl(url, roots)) return null;
  const normalized = {
    ...source,
    source_id: source.source_id || sourceIdOf(url),
    url,
    title: String(source.title || url).trim(),
    excerpt: String(source.excerpt || '').trim(),
    discovered_for: scopeRefsOf(source),
  };
  if (normalized.content && normalized.content_origin !== 'tavily_extract') normalized.content = '';
  return normalized;
}

function addSources(sources, candidates, scope, roots, warnings) {
  const ref = scopeKey(scope);
  for (const candidate of candidates) {
    const normalized = normalizeSource(candidate, roots);
    if (!normalized) {
      warnings.push(`${scope.kind}: 已忽略无效或非官方来源 URL`);
      continue;
    }
    const existing = sources.find(source => source.url === normalized.url);
    if (existing) {
      existing.discovered_for = [...new Set([...scopeRefsOf(existing), ref])];
      if (!existing.title || existing.title === existing.url) existing.title = normalized.title;
      if (!existing.excerpt) existing.excerpt = normalized.excerpt;
      continue;
    }
    sources.push({
      ...normalized,
      discovered_for: [ref],
    });
  }
}

function sourcesForScope(sources, scope) {
  const ref = scopeKey(scope);
  return sources.filter(source => scopeRefsOf(source).includes(ref));
}

function fieldScopeKind(field) {
  const dot = String(field || '').indexOf('.');
  return dot > 0 ? field.slice(0, dot) : null;
}

function scopeKindsOfFields(fields) {
  return [...new Set((fields || []).map(fieldScopeKind).filter(kind => ['vendor', 'group', 'detail'].includes(kind)))];
}

async function researchCatalog(plan, adapters, options = {}) {
  if (!plan || !Array.isArray(plan.research_scopes)) return { ok: false, code: 'RESEARCH_PLAN_INVALID', error: '缺少 ResearchPlan' };
  if (!adapters?.discover || !adapters?.acquire) return { ok: false, code: 'RESEARCH_ADAPTERS_REQUIRED', error: '缺少 discover/acquire adapter' };
  const existing = options.existingResearch || {};
  const ledger = createCostLedger(options.limits, existing.cost?.spent);
  const roots = officialRootsOf(plan.seed || {});
  let sources = dedupeBy([...(existing.official_sources || [])].map(source => normalizeSource(source, roots)).filter(Boolean), source => source.url);
  const warnings = [...(existing.warnings || [])];
  const missingFields = options.missingFields || existing.missing_fields || [];
  const neededKinds = missingFields.length
    ? scopeKindsOfFields(missingFields)
    : ['vendor', 'group', 'detail'];
  const failWithProgress = failure => ({
    ...failure,
    ok: false,
    official_sources: sources,
    warnings,
    cost: ledger.snapshot(),
  });

  for (const scope of plan.research_scopes) {
    if (!neededKinds.includes(scope.kind)) continue;

    let reservation = ledger.reserve('search_queries', 1);
    if (!reservation.ok) return failWithProgress(costFailure(reservation));
    const discovered = await adapters.discover({ plan, scope, missing_predicates: scope.predicates, ledger });
    if (discovered?.ok === false) return failWithProgress(discovered);
    addSources(sources, Array.isArray(discovered?.sources) ? discovered.sources : [], scope, roots, warnings);

    const toAcquire = sourcesForScope(sources, scope).filter(source => !source.content);
    if (toAcquire.length) {
      reservation = ledger.reserve('pages', toAcquire.length);
      if (!reservation.ok) return failWithProgress(costFailure(reservation));
      const acquired = await adapters.acquire({ plan, scope, sources: toAcquire, ledger });
      if (acquired?.ok === false) return failWithProgress(acquired);
      const byUrl = new Map((acquired?.contents || []).map(item => [canonicalizeUrl(item.url), item.content]).filter(([url, content]) => url && content));
      for (const source of toAcquire) {
        const content = byUrl.get(source.url);
        if (content) {
          source.content = String(content).trim();
          source.content_origin = 'tavily_extract';
        }
      }
      for (const failure of acquired?.failed || []) {
        if (failure?.url) warnings.push(`${failure.url}: ${failure.error || '正文提取失败'}`);
      }
    }
  }

  return {
    ok: true,
    official_sources: sources,
    warnings,
    cost: ledger.snapshot(),
    _cost_ledger: ledger,
  };
}

module.exports = {
  DEFAULT_LIMITS,
  createCostLedger,
  canonicalizeUrl,
  officialRootsOf,
  isTrustedOfficialUrl,
  sourceIdOf,
  sourcesForScope,
  scopeKindsOfFields,
  researchCatalog,
};
