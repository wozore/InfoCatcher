'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pendingCandidateToSeed } = require('../../src/news/feedback/catalog-draft-adapter');
const { parseArgs, tavilyAccessModeFromFlags, generatorOptionsFromFlags } = require('../../scripts/catalog-generator');
const { publicPreview } = require('../../scripts/catalog-date-repair');
const { probeCatalogCapabilities } = require('../../src/catalog/ai/catalog-adapters');
const { loadGeneratorConfig, normalizeGeneratorOptions } = require('../../src/catalog/catalog-assistant');
const { requestDeepSeek } = require('../../src/shared/deepseek-client');
const {
  addProductUrlRegistryEntry,
  removeProductUrlRegistryEntry,
  auditProductUrlRegistry,
} = require('../../src/catalog/official-url-registry');

test('pending hotspot candidate becomes a tool Seed without Apply capability', () => {
  const seed = pendingCandidateToSeed({ name: 'Example', description: 'Found in hotspot', source_hotspot: true, source_url: 'https://news.example/item' });
  assert.equal(seed.detail_kind, 'tool');
  assert.equal(seed.name, 'Example');
  assert.equal(seed.known_fields.source_hotspot, true);
  assert.equal(seed.discovery_sources[0].kind, 'hotspot');
});

test('catalog date repair CLI exposes only reviewable fields', () => {
  const preview = publicPreview({
    ok: true,
    detail_id: 'tool-level3:sample',
    target_field: 'last_updated_date',
    date: '2026-08-11',
    source: { title: 'Official changelog', url: 'https://example.com/changelog' },
    before_revision: 'sha256:before',
    target_revision: 'sha256:after',
    preview: { kind: 'catalog_date_repair' },
    preview_hash: 'sha256:preview',
    snapshot: { hidden: true },
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.detail_id, 'tool-level3:sample');
  assert.equal('snapshot' in preview, false);
});


test('catalog generator CLI parses cost confirmation and seed flags', () => {
  const parsed = parseArgs(['new', '--seed', 'seed.json', '--confirm-cost']);
  assert.deepEqual(parsed.positional, ['new']);
  assert.equal(parsed.flags.seed, 'seed.json');
  assert.equal(parsed.flags.confirm_cost, true);
});

test('catalog generator requires and propagates explicit Tavily access mode', () => {
  const parsed = parseArgs(['batch', '--file', 'cards.json', '--dry-run', '--tavily-access-mode', 'keyed']);
  assert.equal(parsed.flags.tavily_access_mode, 'keyed');
  assert.equal(tavilyAccessModeFromFlags(parsed.flags), 'keyed');
  assert.equal(generatorOptionsFromFlags(parsed.flags).accessMode, 'keyed');
  assert.throws(
    () => tavilyAccessModeFromFlags({}),
    /TAVILY_ACCESS_MODE_REQUIRED/,
  );
  assert.throws(
    () => tavilyAccessModeFromFlags({ tavily_access_mode: 'auto' }),
    /TAVILY_ACCESS_MODE_INVALID/,
  );
});

test('catalog generator CLI parses product registry flags and keeps legacy vendor syntax', () => {
  const product = parseArgs(['url-registry', 'product', 'add', '--name', 'Cursor', '--vendor-key', 'anysphere', '--url', 'https://cursor.com', '--product-prefix', 'cursor', '--lifecycle', 'active', '--verified-at', '2026-08-23']);
  assert.deepEqual(product.positional, ['url-registry', 'product', 'add']);
  assert.equal(product.flags.vendor_key, 'anysphere');
  assert.equal(product.flags.product_prefix, 'cursor');
  assert.equal(product.flags.verified_at, '2026-08-23');

  const legacy = parseArgs(['url-registry', 'list']);
  assert.deepEqual(legacy.positional, ['url-registry', 'list']);
});

test('product registry add/remove and audit stay local and validate vendor references', () => {
  const vendorRegistry = { schema_version: 1, entries: { acme: { vendor_name: 'Acme', official_urls: ['https://acme.example'] } } };
  const productRegistry = { schema_version: 1, products: {} };
  const added = addProductUrlRegistryEntry({
    name: 'Acme Agent',
    vendor_key: 'acme',
    official_url: 'https://acme.example/agent',
    product_prefixes: ['acme agent'],
    lifecycle: 'active',
    last_verified_at: '2026-08-23',
  }, { registry: productRegistry, vendorRegistry });
  assert.equal(added.ok, true);
  assert.equal(added.product.vendor_key, 'acme');
  assert.equal(productRegistry.products['acme agent'].lifecycle, 'active');

  const audit = auditProductUrlRegistry({ registry: productRegistry, vendorRegistry, staleDays: 183, now: '2026-08-23T00:00:00Z' });
  assert.equal(audit.ok, true);
  assert.equal(audit.needs_review, 1, '缺少官方更新时间应进入待核验');
  assert.ok(audit.products[0].reasons.includes('official_update_unverified'));

  const removed = removeProductUrlRegistryEntry('Acme Agent', { registry: productRegistry });
  assert.equal(removed.removed, 'acme agent');
  assert.equal(removed.count, 0);
});


test('catalog module config maps snake_case limits to internal options', () => {
  const options = normalizeGeneratorOptions(loadGeneratorConfig());
  assert.equal(options.provider, 'zhipu');
  assert.equal(options.retrievalProvider, 'tavily');
  assert.equal(options.model, 'glm-5.3-flash');
  assert.equal(options.protocol, 'messages');
  assert.equal(options.timeoutMs, 180000);
  assert.equal(options.maxSearchQueries, 4);
  assert.equal(options.maxRepairCalls, 1);
  assert.equal(normalizeGeneratorOptions({ access_mode: 'keyed' }).accessMode, 'keyed');
});

test('Tavily capability probe succeeds via keyless without a search key', async () => {
  const result = await probeCatalogCapabilities({
    apiKey: 'test-key',
    searchApiKey: '',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.retrieval_provider, 'tavily');
});

test('Tavily capability probe fails closed without the default provider key', async () => {
  const result = await probeCatalogCapabilities({
    apiKey: '',
    searchApiKey: '',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ZHIPU_AUTH_REQUIRED');
});

test('shared DeepSeek client classifies auth and rate limit errors', async () => {
  const auth = await requestDeepSeek({}, { apiKey: '', fetchImpl: async () => ({}) });
  assert.equal(auth.code, 'DEEPSEEK_AUTH_REQUIRED');
  const limited = await requestDeepSeek({}, { apiKey: 'test-key', fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'limited' }) });
  assert.equal(limited.code, 'DEEPSEEK_RATE_LIMITED');
});
