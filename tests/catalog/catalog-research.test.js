'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emptySnapshot } = require('../../src/catalog/core/index');
const { planCatalogResearch } = require('../../src/catalog/core/index');
const { createCostLedger, researchCatalog, scopeKindsOfFields } = require('../../src/catalog/core/index');

function seed() {
  return {
    detail_kind: 'api_model', modality: 'video', name: 'Kling 2.6 Pro', vendor_name: '可灵', vendor_key: 'kuaishou', tool_key: 'kling-2-6-pro',
    placement: { new_group_title: 'Kling' }, known_fields: { theme: 'media' },
    discovery_sources: [{ url: 'https://kling.ai/official', kind: 'official_hint' }],
  };
}

function detailOnlyPlan() {
  const snapshot = emptySnapshot();
  snapshot['vendor-card'].push({ id: 'vendor-card:kuaishou', vendor_key: 'kuaishou' });
  snapshot['vendor-level1'].push({ id: 'vendor-level1:kuaishou', vendor_key: 'kuaishou' });
  snapshot['vendor-level2'].push({ id: 'vendor-level2:kuaishou:kling', vendor_key: 'kuaishou' });
  return planCatalogResearch(seed(), snapshot);
}

function adapters(overrides = {}) {
  return {
    discover: async ({ scope }) => ({ sources: [
      { url: 'https://kling.ai/official', title: 'Official', excerpt: 'Official facts' },
      { url: 'https://third-party.example/kling', title: 'Third party', excerpt: 'Untrusted' },
    ] }),
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: `Official page for ${source.url}: API available. Price is 1 credit. Maximum duration 10 seconds.` })) }),
    ...overrides,
  };
}

test('research keeps trusted official hosts, gathers sources, and tracks Tavily-only costs', async () => {
  const plan = detailOnlyPlan();
  const result = await researchCatalog(plan, adapters(), { limits: { search_queries: 2, pages: 4 } });
  assert.equal(result.ok, true);
  assert.equal(result.official_sources.length, 1);
  assert.equal(result.official_sources[0].url, 'https://kling.ai/official');
  assert.equal(result.cost.spent.search_queries, 1);
  assert.equal(result.cost.spent.pages, 1);
  assert.equal(result.cost.spent.extraction_calls, undefined);
});

test('canonicalizes discovered URLs before trust and page budgeting', async () => {
  const plan = detailOnlyPlan();
  let acquireCalls = 0;
  const result = await researchCatalog(plan, adapters({
    discover: async () => ({ sources: [
      { url: 'https://kling.ai/document-api/apiReference/model/imageToVideo`）', title: 'Official', excerpt: 'Official facts' },
      { url: 'not-a-url', title: 'Invalid', excerpt: 'Ignore' },
    ] }),
    acquire: async ({ sources }) => {
      acquireCalls += 1;
      return { contents: sources.map(source => ({ url: source.url, content: 'API available. Price is 1 credit. Maximum duration 10 seconds.' })) };
    },
  }), { limits: { search_queries: 2, pages: 2 } });
  assert.equal(result.ok, true);
  assert.equal(result.official_sources.length, 1);
  assert.equal(result.official_sources[0].url, 'https://kling.ai/document-api/apiReference/model/imageToVideo');
  assert.equal(result.cost.spent.pages, 1);
  assert.equal(acquireCalls, 1);
});

test('hard cost ledger stops before exceeding limits', async () => {
  let discoverCalls = 0;
  const plan = detailOnlyPlan();
  const result = await researchCatalog(plan, adapters({ discover: async () => { discoverCalls += 1; return { sources: [] }; } }), { limits: { search_queries: 0, pages: 0 } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COST_BUDGET_EXHAUSTED');
  assert.equal(discoverCalls, 0);
  assert.equal(result.cost.spent.search_queries, 0);
});

test('research without missingFields studies every active scope once', async () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const requested = [];
  const result = await researchCatalog(plan, adapters({
    discover: async ({ scope }) => { requested.push(scope.kind); return { sources: [{ url: `https://kling.ai/${scope.kind}`, title: scope.kind, excerpt: 'Exact official quote.' }] }; },
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: 'Exact official quote.' })) }),
  }), { limits: { search_queries: 4, pages: 8 } });
  assert.equal(result.ok, true);
  assert.deepEqual(requested, ['vendor', 'group', 'detail']);
  assert.equal(result.official_sources.length, 3);
});

test('resume researches only scopes whose fields are still missing', async () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const requested = [];
  const localAdapters = adapters({
    discover: async ({ scope, domain_scope }) => { requested.push(domain_scope === 'registrant' ? `${scope.kind}:registrant` : scope.kind); return { sources: [{ url: `https://kling.ai/${scope.kind}`, title: scope.kind, excerpt: 'Exact official quote.' }] }; },
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: 'Exact official quote.' })) }),
  });
  const first = await researchCatalog(plan, localAdapters, { limits: { search_queries: 4, pages: 8 } });
  assert.equal(first.ok, true);
  requested.length = 0;
  const resumed = await researchCatalog(plan, localAdapters, {
    existingResearch: first,
    missingFields: ['detail.api_pricing'],
    // 镜像 assistant.resumeResearchLimits：恢复预算 = 已花 + 全新增量，扩宽轮消耗增量份额
    limits: { search_queries: first.cost.spent.search_queries + 4, pages: 8 },
  });
  assert.equal(resumed.ok, true);
  assert.deepEqual(requested, ['detail', 'detail:registrant']);
});

test('budget exhaustion preserves partial sources for a missing-field resume', async () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const requested = [];
  const localAdapters = adapters({
    discover: async ({ scope, domain_scope }) => { requested.push(domain_scope === 'registrant' ? `${scope.kind}:registrant` : scope.kind); return { sources: [{ url: `https://kling.ai/${scope.kind}`, title: scope.kind, excerpt: 'Exact official quote.' }] }; },
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: 'Exact official quote.' })) }),
  });
  const failed = await researchCatalog(plan, localAdapters, { limits: { search_queries: 2, pages: 1 } });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'COST_BUDGET_EXHAUSTED');
  assert.equal(failed.official_sources.length, 2);
  assert.deepEqual(requested, ['vendor', 'group']);

  requested.length = 0;
  const resumed = await researchCatalog(plan, localAdapters, {
    existingResearch: failed,
    missingFields: ['detail.api_pricing'],
    limits: { search_queries: failed.cost.spent.search_queries + 4, pages: 8 },
  });
  assert.equal(resumed.ok, true);
  assert.deepEqual(requested, ['detail', 'detail:registrant']);
});

test('discovery widens to registrant roots when the seed-scope pass finds nothing new', async () => {
  const subdomainSeed = {
    ...seed(),
    official_url: 'https://docs.kling.ai/model',
    discovery_sources: [{ url: 'https://docs.kling.ai/model', kind: 'official_hint' }],
  };
  const snapshot = emptySnapshot();
  snapshot['vendor-card'].push({ id: 'vendor-card:kuaishou', vendor_key: 'kuaishou' });
  snapshot['vendor-level1'].push({ id: 'vendor-level1:kuaishou', vendor_key: 'kuaishou' });
  snapshot['vendor-level2'].push({ id: 'vendor-level2:kuaishou:kling', vendor_key: 'kuaishou' });
  const plan = planCatalogResearch(subdomainSeed, snapshot);
  const scopes = [];
  const result = await researchCatalog(plan, {
    discover: async ({ domain_scope }) => {
      scopes.push(domain_scope || 'seed');
      if ((domain_scope || 'seed') === 'seed') return { sources: [{ url: 'https://third-party.example/kling', title: 'Third party', excerpt: 'Untrusted' }] };
      return { sources: [{ url: 'https://www.kling.ai/news/kling-2-6-pro-launch', title: 'Launch', excerpt: 'Official launch announcement.' }] };
    },
    acquire: async ({ sources }) => ({ contents: sources.map(source => ({ url: source.url, content: 'Official launch announcement. API available.' })) }),
  }, { limits: { search_queries: 4, pages: 4 } });
  assert.equal(result.ok, true);
  assert.deepEqual(scopes, ['seed', 'registrant']);
  assert.ok(result.official_sources.some(source => source.url === 'https://www.kling.ai/news/kling-2-6-pro-launch'), '同厂商主域来源应通过官方闸门');
  assert.equal(result.official_sources.some(source => source.url === 'https://third-party.example/kling'), false);
});

test('registrableHostOf widens vendor subdomains but not shared hosting roots', () => {
  const { registrableHostOf } = require('../../src/catalog/core/index');
  assert.equal(registrableHostOf('platform.openai.com'), 'openai.com');
  assert.equal(registrableHostOf('openai.com'), null);
  assert.equal(registrableHostOf('docs.kling.ai'), 'kling.ai');
  assert.equal(registrableHostOf('foo.github.io'), null);
  assert.equal(registrableHostOf(''), null);
});

test('official gate accepts vendor main domain once a subdomain hint exists', () => {
  const { officialRootsOf, isTrustedOfficialUrl } = require('../../src/catalog/core/index');
  const roots = officialRootsOf({
    official_url: 'https://platform.openai.com/docs',
    discovery_sources: [{ url: 'https://platform.openai.com/docs', kind: 'official_hint' }],
  });
  assert.ok(roots.includes('openai.com'));
  assert.equal(isTrustedOfficialUrl('https://openai.com/index/gpt-6-astra/', roots), true);
  assert.equal(isTrustedOfficialUrl('https://openai-competitor.example/index/gpt-6-astra/', roots), false);
});

test('scopeKindsOfFields maps fields to their owning layer scopes', () => {
  assert.deepEqual(scopeKindsOfFields(['detail.access_level', 'vendor.features', 'group.group_summary']).sort(), ['detail', 'group', 'vendor']);
  assert.deepEqual(scopeKindsOfFields(['detail.api_pricing']), ['detail']);
  assert.deepEqual(scopeKindsOfFields([]), []);
});

test('cost ledger reports deterministic remaining capacity', () => {
  const ledger = createCostLedger({ search_queries: 2, pages: 3 });
  assert.equal(ledger.reserve('search_queries', 1).ok, true);
  assert.equal(ledger.snapshot().remaining.search_queries, 1);
  assert.equal(ledger.reserve('search_queries', 2).ok, false);
  assert.equal(ledger.snapshot().spent.search_queries, 1);
});
