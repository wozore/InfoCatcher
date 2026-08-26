'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isIsoDate,
  isoFromUnixSeconds,
  buildReleaseLookup,
  resolveReleaseDate,
  filterByReleaseCutoff,
} = require('../../src/comparison/release-date');

function record(canonical, identity, sources = {}) {
  return { canonical, identity, sources };
}

test('release-date：llm-stats release_date 优先', () => {
  const rec = record('openai--gpt-5.5', 'gpt-5.5', {
    llm_stats: { release_date: '2026-04-23', model_id: 'gpt-5.5' },
    openrouter: { created: 1787336476 },
  });
  assert.deepEqual(resolveReleaseDate(rec), { date: '2026-04-23', provenance: 'llm_stats' });
});

test('release-date：无 llm-stats 时 openrouter created 兜底', () => {
  const rec = record('xai--grok-4-heavy', 'grok-4-heavy', { openrouter: { created: 1787336476 } });
  const res = resolveReleaseDate(rec);
  assert.equal(res.provenance, 'openrouter');
  assert.equal(isIsoDate(res.date), true);
  assert.equal(res.date.slice(0, 4), '2026');
});

test('release-date：openrouter created 非法则 null', () => {
  const rec = record('openai--gpt-5.5', 'gpt-5.5', { openrouter: { created: null } });
  assert.deepEqual(resolveReleaseDate(rec), { date: null, provenance: null });
});

test('release-date：catalog 反查 Path A（canonical 的 catalog_aliases 命中详情）', () => {
  const catalogDates = [
    { detail_id: 'tool-level3:glm-5-3', detail_kind: 'api_model', title: 'GLM-5.3', tool_key: 'glm-5-3', release_date: '2026-05-30' },
    { detail_id: 'tool-level3:gemini-3-5-flash', detail_kind: 'api_model', title: 'Gemini 3.5 Flash', tool_key: 'gemini-3.5-flash', release_date: '2026-05-19' },
    { detail_id: 'tool-level3:cursor', detail_kind: 'tool', title: 'Cursor', release_date: '2026-08-19' },
  ];
  const modelsAlias = {
    entries: [
      { model_key: 'zai--glm-5.3', catalog_aliases: ['glm-5-3', 'GLM-5.3'] },
    ],
  };
  const lookup = buildReleaseLookup({ catalogDates, modelsAlias });
  const rec = record('zai--glm-5.3', 'glm-5.3', { openrouter: { created: 1787336476 } });
  assert.deepEqual(resolveReleaseDate(rec, lookup), { date: '2026-05-30', provenance: 'catalog' });
});

test('release-date：catalog 反查 Path B（identity-slug 命中）', () => {
  const catalogDates = [
    { detail_id: 'tool-level3:gemini-3-5-flash', detail_kind: 'api_model', title: 'Gemini 3.5 Flash', tool_key: 'gemini-3.5-flash', release_date: '2026-05-19' },
  ];
  const lookup = buildReleaseLookup({ catalogDates, modelsAlias: { entries: [] } });
  const rec = record('google--gemini-3.5-flash', 'gemini-3.5-flash', { openrouter: { created: 1787336476 } });
  assert.deepEqual(resolveReleaseDate(rec, lookup), { date: '2026-05-19', provenance: 'catalog' });
});

test('release-date：tool 详情不进 lookup，subscription_plan 不进', () => {
  const catalogDates = [
    { detail_id: 't1', detail_kind: 'tool', title: 'Cursor', release_date: '2026-08-19' },
    { detail_id: 't2', detail_kind: 'subscription_plan', title: 'Pro Plan', release_date: '2026-01-01' },
  ];
  const lookup = buildReleaseLookup({ catalogDates, modelsAlias: { entries: [] } });
  assert.equal(lookup.catalogByAlias.size, 0);
});

test('release-date：filterByReleaseCutoff 排除过期、无日期保守保留', () => {
  const records = {
    'a': record('openai--gpt-4', 'gpt-4', { llm_stats: { release_date: '2024-05-13' } }),
    'b': record('openai--gpt-5.5', 'gpt-5.5', { llm_stats: { release_date: '2026-04-23' } }),
    'c': record('xai--grok-4-heavy', 'grok-4-heavy', { openrouter: {} }),
    'd': record('xai--grok-4-heavy', 'grok-4-heavy', { llm_stats: { release_date: '2025-06-01' } }),
  };
  const result = filterByReleaseCutoff(records, '2025-06-01', {});
  assert.deepEqual(Object.keys(result.records), ['b', 'c', 'd']);
  assert.equal(result.filtered.length, 1);
  assert.equal(result.filtered[0].canonical, 'openai--gpt-4');
  assert.equal(result.filtered[0].release_date, '2024-05-13');
  assert.equal(result.retained_null.length, 1);
  assert.equal(result.retained_null[0].canonical, 'xai--grok-4-heavy');
  // 恰好等于 cutoff 月首日保留
  assert.ok(result.records.d, '2025-06-01 等于 cutoff 保留');
  // 投影到 record
  assert.equal(records.b.release_date, '2026-04-23');
  assert.equal(records.b.release_date_provenance, 'llm_stats');
});

test('release-date：cutoffDate 为 null 时不过滤只投影', () => {
  const records = { 'a': record('openai--gpt-4', 'gpt-4', { llm_stats: { release_date: '2024-05-13' } }) };
  const result = filterByReleaseCutoff(records, null, {});
  assert.equal(result.filtered.length, 0);
  assert.equal(Object.keys(result.records).length, 1);
});

test('release-date：isoFromUnixSeconds 转换', () => {
  assert.equal(isoFromUnixSeconds(0), null);
  assert.equal(isoFromUnixSeconds(null), null);
  assert.equal(isoFromUnixSeconds(1787336476), '2026-08-21');
});
