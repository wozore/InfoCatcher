'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { emptySnapshot } = require('../../src/catalog/core/index');
const { revisionOf } = require('../../src/catalog/core/index');
const { FILE_BY_AREA, planRecordRemoval, commitSnapshotChange, commitCatalogChange, replaceToolLevel3 } = require('../../src/catalog/transaction');

function fixture() {
  const snapshot = emptySnapshot();
  snapshot['vendor-card'].push({ id: 'vendor-card:spark', vendor_key: 'spark', title: 'Spark', icon: 'x', summary: 'Spark', level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:spark' } });
  snapshot['vendor-level1'].push({ id: 'vendor-level1:spark', vendor_key: 'spark', title: 'Spark', icon: 'x', official_url: 'https://example.com', description: 'Spark', status: 'active', features: [{ tone: 'positive', text: 'Spark' }], level2_refs: [{ kind: 'vendor-level2', id: 'vendor-level2:spark' }] });
  snapshot['vendor-level2'].push({ id: 'vendor-level2:spark', level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:spark' }, vendor_key: 'spark', title: 'Spark', official_url: 'https://example.com', summary: 'Spark', status: 'active', detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:spark' }] });
  snapshot['tool-level3'].push({ id: 'tool-level3:spark', vendor_key: 'spark', detail_kind: 'tool', theme: 'general', title: 'Spark', vendor_label: 'Spark', icon: 'x', official_url: 'https://example.com', status: 'active', summary: 'Spark', one_m_context: { status: 'not_applicable', reason: 'tool' }, api_pricing: { status: 'not_applicable', reason: 'tool' }, plan: { status: 'not_applicable', reason: 'tool' }, applicable_scenarios: [{ title: 'Spark', description: 'Spark' }], inapplicable_scenarios: [{ title: 'Other', description: 'Other' }], sources: [{ title: 'Official', url: 'https://example.com' }] });
  snapshot['tool-card'].push({ id: 'tool-card:spark', tool_key: 'spark', vendor_key: 'spark', title: 'Spark', vendor_label: 'Spark', icon: 'x', summary: 'Spark', theme: 'general', scenes: ['Spark'], best_for_preview: 'Spark', not_for_preview: 'Other', price_badge: 'free', access_level: '开放', search_terms: ['Spark'], detail_ref: { kind: 'tool-level3', id: 'tool-level3:spark' }, detail_kind: 'tool' });
  return snapshot;
}

function makeTransactionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowview-catalog-transaction-'));
  const catalogDir = path.join(root, 'data', 'catalog');
  const projectDir = root;
  const snapshot = fixture();
  fs.mkdirSync(catalogDir, { recursive: true });
  for (const [area, file] of Object.entries(FILE_BY_AREA)) {
    fs.writeFileSync(path.join(catalogDir, path.basename(file)), `${JSON.stringify({ schema_version: 1, items: snapshot[area] }, null, 2)}\n`);
  }
  const dist = path.join(projectDir, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'old.txt'), 'old-dist');
  const loadCatalogSnapshot = () => {
    const current = {};
    for (const [area, file] of Object.entries(FILE_BY_AREA)) {
      const payload = JSON.parse(fs.readFileSync(path.join(catalogDir, path.basename(file)), 'utf8'));
      current[area] = payload.items;
    }
    return { snapshot: current, revision: revisionOf(current) };
  };
  const options = { catalogDir, projectDir, loadCatalogSnapshot, publishCatalogReleaseDates: false };
  return { root, catalogDir, projectDir, snapshot, options, loadCatalogSnapshot };
}

function clean(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function builderFor(marker, calls, failure) {
  return ({ outputDir, catalogDir }) => {
    calls.push({ outputDir, catalogDir });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'built.txt'), marker);
    if (failure) throw new Error(failure);
  };
}

test('planRecordRemoval removes exact records and their references atomically', () => {
  const result = planRecordRemoval(fixture(), [
    { area: 'vendor-card', id: 'vendor-card:spark' },
    { area: 'vendor-level1', id: 'vendor-level1:spark' },
    { area: 'vendor-level2', id: 'vendor-level2:spark' },
    { area: 'tool-level3', id: 'tool-level3:spark' },
    { area: 'tool-card', id: 'tool-card:spark' },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  for (const items of Object.values(result.snapshot)) assert.equal(items.length, 0);
});

test('planRecordRemoval rejects an incomplete target set that would leave dangling refs', () => {
  const result = planRecordRemoval(fixture(), [{ area: 'tool-level3', id: 'tool-level3:spark' }]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SNAPSHOT_INVALID');
  assert.ok(result.errors.length > 0);
});

test('planRecordRemoval rejects missing exact IDs before writing', () => {
  const result = planRecordRemoval(fixture(), [{ area: 'tool-card', id: 'tool-card:not-spark' }]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REMOVE_TARGET_MISSING');
});

test('commitSnapshotChange injects the builder and atomically updates the fixture catalog and dist', () => {
  const context = makeTransactionFixture();
  const calls = [];
  try {
    const target = JSON.parse(JSON.stringify(context.snapshot));
    target['tool-card'][0].summary = 'Updated';
    const result = commitSnapshotChange(target, {
      ...context.options,
      expectedRevision: revisionOf(context.snapshot),
      runId: 'fixture-success',
      buildStaticSite: builderFor('new-dist', calls),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls.length, 1);
    assert.equal(context.loadCatalogSnapshot().snapshot['tool-card'][0].summary, 'Updated');
    assert.equal(fs.readFileSync(path.join(context.projectDir, 'dist', 'built.txt'), 'utf8'), 'new-dist');
    assert.equal(fs.existsSync(path.join(context.catalogDir, '.transactions', 'journal.json')), false);
  } finally {
    clean(context.root);
  }
});

test('commitCatalogChange and replaceToolLevel3 use the same injected transaction builder', () => {
  const context = makeTransactionFixture();
  const calls = [];
  try {
    const first = commitCatalogChange(context.snapshot, {
      ...context.options,
      runId: 'fixture-catalog-change',
      layerPatches: [],
      buildStaticSite: builderFor('catalog-change', calls),
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = replaceToolLevel3(context.snapshot['tool-level3'], {
      ...context.options,
      runId: 'fixture-level3-replace',
      buildStaticSite: builderFor('level3-replace', calls),
    });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(calls.length, 2);
  } finally {
    clean(context.root);
  }
});

test('builder failure rolls back without changing catalog or leaving transaction artifacts', () => {
  const context = makeTransactionFixture();
  const before = fs.readFileSync(path.join(context.catalogDir, 'tool-cards.json'), 'utf8');
  const calls = [];
  try {
    const result = commitSnapshotChange(context.snapshot, {
      ...context.options,
      runId: 'fixture-builder-failure',
      buildStaticSite: builderFor('failed-dist', calls, 'fixture builder failed'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BUILD_FAILED');
    assert.equal(fs.readFileSync(path.join(context.catalogDir, 'tool-cards.json'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(context.projectDir, 'dist', 'old.txt'), 'utf8'), 'old-dist');
    assert.equal(fs.existsSync(path.join(context.catalogDir, '.transactions', 'journal.json')), false);
  } finally {
    clean(context.root);
  }
});

test('catalog replacement failure restores all five files from the backup', () => {
  const context = makeTransactionFixture();
  const before = Object.fromEntries(Object.entries(FILE_BY_AREA).map(([area, file]) => [
    area,
    fs.readFileSync(path.join(context.catalogDir, path.basename(file)), 'utf8'),
  ]));
  let failed = false;
  const io = Object.assign({}, fs, {
    renameSync(from, to) {
      if (!failed && to === path.join(context.catalogDir, path.basename(FILE_BY_AREA['tool-level3']))) {
        failed = true;
        const error = new Error('fixture catalog rename failed');
        error.code = 'EPERM';
        throw error;
      }
      return fs.renameSync(from, to);
    },
  });
  try {
    const result = commitSnapshotChange(context.snapshot, {
      ...context.options,
      runId: 'fixture-catalog-failure',
      fsImpl: io,
      buildDist: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EPERM');
    for (const [area, file] of Object.entries(FILE_BY_AREA)) {
      assert.equal(fs.readFileSync(path.join(context.catalogDir, path.basename(file)), 'utf8'), before[area]);
    }
  } finally {
    clean(context.root);
  }
});

test('EPERM while moving dist falls back to delete-and-rebuild', () => {
  const context = makeTransactionFixture();
  const calls = [];
  let failed = false;
  const dist = path.join(context.projectDir, 'dist');
  const io = Object.assign({}, fs, {
    renameSync(from, to) {
      if (!failed && from === dist) {
        failed = true;
        const error = new Error('fixture dist is busy');
        error.code = 'EPERM';
        throw error;
      }
      return fs.renameSync(from, to);
    },
  });
  try {
    const result = commitSnapshotChange(context.snapshot, {
      ...context.options,
      runId: 'fixture-dist-eperm',
      fsImpl: io,
      buildStaticSite: builderFor('rebuilt-dist', calls),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(failed, true);
    assert.equal(fs.readFileSync(path.join(dist, 'built.txt'), 'utf8'), 'rebuilt-dist');
    assert.equal(fs.existsSync(path.join(dist, 'old.txt')), false);
  } finally {
    clean(context.root);
  }
});
