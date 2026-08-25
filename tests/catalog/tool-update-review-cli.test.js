'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseArgs,
  main,
  runScan,
  runList,
  runApply,
} = require('../../scripts/tool-update-review');

function sampleRegistry(collector = 'tavily_extract') {
  return {
    schema_version: 1,
    kind: 'official_product_url_registry',
    products: {
      sample: {
        name: 'Sample Tool',
        vendor_key: 'sample',
        official_urls: ['https://example.com/product'],
        update_sources: [{
          kind: 'changelog',
          url: 'https://example.com/changelog',
          collector,
          product_surface: 'product',
        }],
        lifecycle: 'active',
      },
    },
  };
}

function sampleSnapshot() {
  return {
    snapshot: {
      'vendor-card': [],
      'tool-card': [],
      'vendor-level1': [],
      'vendor-level2': [],
      'tool-level3': [{
        id: 'tool-level3:sample',
        tool_key: 'sample',
        title: 'Sample Tool',
        detail_kind: 'tool',
        vendor_key: 'sample',
        last_updated_date: '2026-08-01',
      }],
    },
    revision: 'sha256:before',
  };
}

function scanDeps(overrides = {}) {
  const registry = sampleRegistry();
  let applyCalled = false;
  return {
    loadRegistry: () => registry,
    validateRegistry: () => ({ ok: true, errors: [] }),
    loadSnapshot: sampleSnapshot,
    collectProductUpdateEvidence: async () => ({
      evidence: [{
        product_key: 'sample',
        detail_id: 'tool-level3:sample',
        source_type: 'changelog',
        collector: 'tavily_extract',
        url: 'https://example.com/changelog',
        title: 'Official changelog',
        official_published_at: '2026-08-11T12:00:00Z',
        excerpt: 'Published stable update on 2026-08-11.',
        content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        status: 'ready',
      }],
      failed: [],
    }),
    suggestReview: async () => ({
      ok: true,
      suggestion: {
        verdict: 'approve',
        matched_surface: 'product',
        confidence: 0.95,
        reason: '明确产品更新',
        supporting_excerpt: 'Published stable update on 2026-08-11.',
      },
    }),
    createLedger: () => ({
      snapshot: () => ({ spent: { responses_calls: 1 } }),
      reserve: () => ({ ok: true }),
    }),
    mergeQueue: (candidates) => ({ file: 'test', appended: candidates.length, refreshed: 0, reopened: 0, queue: { items: candidates } }),
    applyBatch: () => { applyCalled = true; return { ok: true }; },
    get applyCalled() { return applyCalled; },
    print: false,
    ...overrides,
  };
}

test('tool update CLI parses positional command and kebab-case flags', () => {
  assert.deepEqual(parseArgs(['scan', '--tavily-access-mode', 'keyless', '--confirm-cost', '--products', 'gemini-cli,qoder']), {
    positional: ['scan'],
    flags: { tavily_access_mode: 'keyless', confirm_cost: true, products: 'gemini-cli,qoder' },
  });
});

test('scan requires explicit Tavily access mode and never calls Apply', async () => {
  const deps = scanDeps();
  await assert.rejects(() => runScan({ products: 'sample' }, deps), /TAVILY_ACCESS_MODE_REQUIRED/);
  const result = await runScan({ products: 'sample', tavily_access_mode: 'keyless', as_of: '2026-08-25' }, deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.catalog_apply, false);
  assert.equal(deps.applyCalled, false);
});

test('DeepSeek scan requires explicit cost confirmation', async () => {
  const result = await main(['scan', '--products', 'sample', '--provider', 'deepseek', '--tavily-access-mode', 'keyless'], scanDeps());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_UPDATE_REVIEW_COST_CONFIRM_REQUIRED');
});

test('list is read-only and filters review status', () => {
  let reads = 0;
  let writes = 0;
  const result = runList({ status: 'pending' }, {
    readQueue: () => {
      reads += 1;
      return { items: [{ candidate_key: 'a', product_key: 'sample', review_status: 'pending', status: 'candidate', blocked_reasons: [] }, { candidate_key: 'b', product_key: 'sample', review_status: 'approved', status: 'candidate', blocked_reasons: [] }] };
    },
    mergeQueue: () => { writes += 1; },
  });
  assert.equal(result.count, 1);
  assert.equal(reads, 1);
  assert.equal(writes, 0);
});

test('apply rejects missing revision, preview hash, and exact confirmation', async () => {
  const deps = scanDeps();
  assert.equal((await runApply({}, deps)).code, 'DATE_REPAIR_EXPECTED_REVISION_REQUIRED');
  assert.equal((await runApply({ expected_revision: 'sha256:before' }, deps)).code, 'DATE_REPAIR_PREVIEW_REQUIRED');
  assert.equal((await runApply({ expected_revision: 'sha256:before', preview_hash: 'sha256:preview', confirm: 'yes' }, deps)).code, 'TOOL_UPDATE_REVIEW_CONFIRMATION_REQUIRED');
  const applied = await runApply({ expected_revision: 'sha256:before', preview_hash: 'sha256:preview', confirm: 'APPLY TOOL-UPDATES sha256:preview' }, deps);
  assert.equal(applied.ok, true);
  assert.equal(deps.applyCalled, true);
});
