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

// 多租户托管后缀不是任何厂商的"注册域根"：平台.openai.com 可以放宽到 openai.com，
// 但 foo.github.io 绝不能放宽到 github.io（否则所有托管项目都会被当成官方域）。
const SHARED_HOSTING_SUFFIXES = new Set([
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev',
  'web.app', 'firebaseapp.com', 'herokuapp.com', 'blogspot.com', 'gitee.io',
]);

/** 取主机名的注册域根（最后两段）；主机已是根域或根是多租户托管后缀时返回 null。 */
function registrableHostOf(host) {
  const labels = String(host || '').split('.').filter(Boolean);
  if (labels.length <= 2) return null;
  const candidate = labels.slice(-2).join('.');
  return SHARED_HOSTING_SUFFIXES.has(candidate) ? null : candidate;
}

// 公共代码托管/模型分享平台不作为官方根域名（否则该平台的所有项目、Spaces、同名文档都会被误当成官方文档）
const COMMUNITY_HOST_BLOCKLIST = new Set([
  'huggingface.co',
  'github.com',
  'github.io',
  'gitlab.com',
  'gitee.com',
]);

function officialRootsOf(seed) {
  const explicit = canonicalizeUrl(seed.official_url);
  const hinted = (seed.discovery_sources || [])
    .filter(source => source?.kind === 'official_hint')
    .map(source => canonicalizeUrl(source.url));
  const hosts = [...new Set([explicit, ...hinted]
    .filter(Boolean)
    .map((url, index) => ({ host: hostOf(url), explicit: index === 0 && Boolean(explicit) }))
    .filter(item => item.host && (item.explicit || !COMMUNITY_HOST_BLOCKLIST.has(item.host)))
    .map(item => item.host))];
  // 同厂商官方域按注册域根放行：platform.openai.com 的公告/帮助页常落在 openai.com 主域，
  // 闸门只认精确子域会把厂商主站的发布证据挡在门外（多租户托管后缀不放宽）。
  const roots = new Set(hosts);
  for (const host of hosts) {
    const root = registrableHostOf(host);
    if (root && !COMMUNITY_HOST_BLOCKLIST.has(root)) roots.add(root);
  }
  return [...roots];
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

async function callResearchAdapter(adapter, input, fallbackCode) {
  try { return await adapter(input); }
  catch (error) { return { ok: false, code: error?.code || fallbackCode, error: error?.message || fallbackCode, failed_scope: scopeKey(input.scope) }; }
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
  const completedScopes = new Set(existing.completed_scopes || existing.research_progress?.completed_scopes || []);
  const failWithProgress = failure => ({
    ...failure,
    ok: false,
    official_sources: sources,
    warnings,
    cost: ledger.snapshot(),
    research_progress: { completed_scopes: [...completedScopes], failed_scope: failure.failed_scope || null },
  });

  const pendingScopes = plan.research_scopes.filter(scope => {
    const key = scopeKey(scope);
    return neededKinds.includes(scope.kind) && !(completedScopes.has(key) && !missingFields.length);
  });
  for (const [scopeIndex, scope] of pendingScopes.entries()) {
    const key = scopeKey(scope);

    let reservation = ledger.reserve('search_queries', 1);
    if (!reservation.ok) return failWithProgress(costFailure(reservation));
    const discovered = await callResearchAdapter(adapters.discover, { plan, scope, missing_predicates: scope.predicates, ledger }, 'RESEARCH_DISCOVER_FAILED');
    if (discovered?.ok === false) return failWithProgress({ ...discovered, failed_scope: key });
    const sourceCountBefore = sources.length;
    addSources(sources, Array.isArray(discovered?.sources) ? discovered.sources : [], scope, roots, warnings);

    // 窄域（种子自带官方域名）没搜到任何新来源，或这是定向补字段的重跑（上一轮窄域已被
    // 证明拿不到该字段）→ 扩宽到同厂商注册域根再搜一次；扩宽轮失败只记警告，不中断本轮。
    // 但剩余预算必须先保住后续 scope 的窄域搜索，不允许扩宽把后续 scope 挤成 COST_BUDGET_EXHAUSTED。
    if (missingFields.length || sources.length === sourceCountBefore) {
      const remainingNarrow = pendingScopes.length - scopeIndex - 1;
      if (ledger.snapshot().remaining.search_queries >= 1 + remainingNarrow) {
        reservation = ledger.reserve('search_queries', 1);
        const widened = await callResearchAdapter(adapters.discover, { plan, scope, missing_predicates: scope.predicates, ledger, domain_scope: 'registrant' }, 'RESEARCH_DISCOVER_FAILED');
        if (widened?.ok === false) warnings.push(`${scope.kind}: 扩域搜索失败已忽略（${widened.code || 'RESEARCH_DISCOVER_FAILED'}）`);
        else addSources(sources, Array.isArray(widened?.sources) ? widened.sources : [], scope, roots, warnings);
      } else {
        warnings.push(`${scope.kind}: 搜索预算不足以安全扩域，跳过扩域搜索`);
      }
    }

    const toAcquireAll = sourcesForScope(sources, scope).filter(source => !source.content);
    const remainingPages = ledger.snapshot().remaining?.pages || 0;
    const toAcquire = toAcquireAll.slice(0, remainingPages);
    if (toAcquireAll.length > toAcquire.length) {
      warnings.push(`${scope.kind}: 待抓取页面数 (${toAcquireAll.length}) 超出剩余预算 (${remainingPages})，已自动截取前 ${toAcquire.length} 页`);
    }
    if (toAcquire.length) {
      reservation = ledger.reserve('pages', toAcquire.length);
      if (!reservation.ok) return failWithProgress(costFailure(reservation));
      const acquired = await callResearchAdapter(adapters.acquire, { plan, scope, sources: toAcquire, ledger }, 'RESEARCH_ACQUIRE_FAILED');
      if (acquired?.ok === false) return failWithProgress({ ...acquired, failed_scope: key });
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
    completedScopes.add(key);
  }

  return {
    ok: true,
    official_sources: sources,
    warnings,
    cost: ledger.snapshot(),
    research_progress: { completed_scopes: [...completedScopes], failed_scope: null },
    _cost_ledger: ledger,
  };
}

module.exports = {
  DEFAULT_LIMITS,
  createCostLedger,
  canonicalizeUrl,
  registrableHostOf,
  officialRootsOf,
  isTrustedOfficialUrl,
  sourceIdOf,
  sourcesForScope,
  scopeKindsOfFields,
  researchCatalog,
};
