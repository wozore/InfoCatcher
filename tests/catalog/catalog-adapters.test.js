'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  discoverOfficialSources,
  acquireOfficialSources,
  probeCatalogCapabilities,
  createCatalogAiAdapters,
} = require('../../src/catalog/ai/catalog-adapters');

function response(data, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

function plan() {
  return {
    seed: {
      name: 'Kling 2.6',
      vendor_name: '可灵',
      official_url: 'https://kling.ai',
      discovery_sources: [{ url: 'https://kling.ai/document-api', kind: 'official_hint' }],
    },
  };
}

test('catalog discovery delegates official-domain filtering to Tavily', async () => {
  let request;
  const result = await discoverOfficialSources({
    plan: plan(),
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-v2-6' } },
    missing_predicates: ['api_available', 'price_rate'],
  }, {
    searchApiKey: 'tavily-key',
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return response({ results: [{ url: 'https://kling.ai/document-api/api/video/2-6', title: '2.6 API', content: 'Kling 2.6 API' }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://api.tavily.com/search');
  assert.deepEqual(request.body.include_domains, ['kling.ai']);
  assert.equal(result.sources[0].discovered_for, 'detail:kling-v2-6');
});

test('catalog acquire uses Tavily cleaned content and canonical URLs', async () => {
  let request;
  const result = await acquireOfficialSources({
    plan: plan(),
    scope: { kind: 'detail', subject: { kind: 'detail', key: 'kling-v2-6' }, predicates: ['price_rate'] },
    sources: [{ url: 'https://kling.ai/document-api/api/video/2-6`）', title: '2.6 API', excerpt: 'Price excerpt' }],
  }, {
    searchApiKey: 'tavily-key',
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return response({ results: [{ url: 'https://kling.ai/document-api/api/video/2-6', raw_content: '# Pricing\n1 unit per second' }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://api.tavily.com/extract');
  assert.deepEqual(request.body.urls, ['https://kling.ai/document-api/api/video/2-6']);
  assert.equal(result.contents[0].content, '# Pricing\n1 unit per second');
});

test('catalog capability probe checks Tavily without invoking DeepSeek', async () => {
  let calls = 0;
  const result = await probeCatalogCapabilities({
    apiKey: 'deepseek-key',
    searchApiKey: 'tavily-key',
    fetchImpl: async () => { calls += 1; return response({ results: [{ url: 'https://docs.tavily.com', title: 'Docs', content: 'Tavily' }] }); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.retrieval_provider, 'tavily');
  assert.equal(result.extraction_provider, 'deepseek');
  assert.equal(calls, 1);
});

test('single-pass adapter composition exposes discover/acquire/synthesize but no extract', () => {
  const adapters = createCatalogAiAdapters({});
  assert.equal(typeof adapters.discover, 'function');
  assert.equal(typeof adapters.acquire, 'function');
  assert.equal(typeof adapters.synthesize, 'function');
  assert.equal(adapters.extract, undefined);
  assert.equal(adapters.manages_response_budget, undefined);
});
