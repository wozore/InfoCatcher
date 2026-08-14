'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pendingCandidateToSeed } = require('../../src/news/feedback/catalog-draft-adapter');
const { parseArgs } = require('../../scripts/catalog-generator');
const { probeCatalogCapabilities } = require('../../src/catalog/ai/catalog-adapters');
const { loadGeneratorConfig, normalizeGeneratorOptions } = require('../../src/catalog/catalog-assistant');
const { requestDeepSeek } = require('../../src/shared/deepseek-client');

test('pending hotspot candidate becomes a tool Seed without Apply capability', () => {
  const seed = pendingCandidateToSeed({ name: 'Example', description: 'Found in hotspot', source_hotspot: true, source_url: 'https://news.example/item' });
  assert.equal(seed.detail_kind, 'tool');
  assert.equal(seed.name, 'Example');
  assert.equal(seed.known_fields.source_hotspot, true);
  assert.equal(seed.discovery_sources[0].kind, 'hotspot');
});

test('catalog generator CLI parses cost confirmation and seed flags', () => {
  const parsed = parseArgs(['new', '--seed', 'seed.json', '--confirm-cost']);
  assert.deepEqual(parsed.positional, ['new']);
  assert.equal(parsed.flags.seed, 'seed.json');
  assert.equal(parsed.flags.confirm_cost, true);
});

test('catalog module config maps snake_case limits to internal options', () => {
  const options = normalizeGeneratorOptions(loadGeneratorConfig());
  assert.equal(options.provider, 'deepseek');
  assert.equal(options.retrievalProvider, 'tavily');
  assert.equal(options.model, 'deepseek-v4-flash');
  assert.equal(options.protocol, 'responses');
  assert.equal(options.timeoutMs, 180000);
  assert.equal(options.maxSearchQueries, 4);
  assert.equal(options.maxRepairCalls, 1);
});

test('Tavily capability probe fails closed without a search key', async () => {
  const result = await probeCatalogCapabilities({
    apiKey: 'test-key',
    searchApiKey: '',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TAVILY_SEARCH_AUTH_REQUIRED');
});

test('shared DeepSeek client classifies auth and rate limit errors', async () => {
  const auth = await requestDeepSeek({}, { apiKey: '', fetchImpl: async () => ({}) });
  assert.equal(auth.code, 'DEEPSEEK_AUTH_REQUIRED');
  const limited = await requestDeepSeek({}, { apiKey: 'test-key', fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'limited' }) });
  assert.equal(limited.code, 'DEEPSEEK_RATE_LIMITED');
});
