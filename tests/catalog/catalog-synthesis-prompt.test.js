'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emptySnapshot } = require('../../src/catalog/catalog-contract');
const { planCatalogResearch } = require('../../src/catalog/catalog-profile-contract');
const { expectedLayerFields } = require('../../src/catalog/catalog-synthesis');
const { buildSynthesisInput, buildSynthesisInstructions, DEFAULT_MAX_SOURCES_PER_LAYER, DEFAULT_MAX_SOURCE_CHARS } = require('../../src/catalog/ai/catalog-synthesis-prompt');

function seed() {
  return {
    detail_kind: 'api_model', modality: 'video', name: 'Kling 2.6 Pro', vendor_name: '可灵', vendor_key: 'kuaishou', tool_key: 'kling-2-6-pro',
    placement: { new_group_title: 'Models' }, known_fields: { theme: 'media' }, discovery_sources: [{ url: 'https://kling.ai', kind: 'official_hint' }],
  };
}

function researchFor(plan) {
  const refs = plan.research_scopes.map(scope => `${scope.kind}:${scope.subject.key}`);
  const sources = refs.map((ref, index) => ({
    source_id: `source-${index}`,
    url: `https://kling.ai/${index}`,
    title: `Title ${index}`,
    excerpt: `excerpt ${index}`,
    content: `content ${index}`,
    discovered_for: [ref],
  }));
  return { official_sources: sources };
}

test('buildSynthesisInput groups sources by layer and maps expected fields', () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const expected = expectedLayerFields(plan);
  const input = buildSynthesisInput({ research: researchFor(plan), plan, expected_layer_fields: expected });
  assert.equal(input.profile.detail_kind, 'api_model');
  assert.deepEqual(Object.keys(input.layers).sort(), ['detail', 'group', 'vendor']);
  assert.equal(input.layers.vendor.sources.length, 1);
  assert.equal(input.layers.vendor.sources[0].source_id, 'source-0');
  assert.equal(input.expected_layer_fields.detail.includes('summary'), true);
});

test('synthesis input caps source count per layer and truncates long content', () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const refs = plan.research_scopes.map(scope => `${scope.kind}:${scope.subject.key}`);
  const detailRef = refs.find(ref => ref.startsWith('detail:'));
  const long = { source_id: 'source-long', url: 'https://kling.ai/long', title: 'Long', excerpt: 'e', content: 'x'.repeat(20000), discovered_for: [detailRef] };
  const many = Array.from({ length: 6 }, (_, index) => ({ source_id: `source-extra-${index}`, url: `https://kling.ai/extra-${index}`, title: `Extra ${index}`, excerpt: 'e', content: 'c', discovered_for: [detailRef] }));
  const research = { official_sources: [long, ...many] };
  const expected = { vendor: [], group: [], detail: ['summary'] };
  const input = buildSynthesisInput({ research, plan, expected_layer_fields: expected });
  assert.equal(input.layers.detail.sources.length, DEFAULT_MAX_SOURCES_PER_LAYER);
  assert.equal(input.layers.detail.sources[0].content.length, DEFAULT_MAX_SOURCE_CHARS);
  assert.ok(input.layers.detail.sources.every(source => source.content.length <= DEFAULT_MAX_SOURCE_CHARS));
});

test('synthesis input skips sources without content or excerpt', () => {
  const plan = planCatalogResearch(seed(), emptySnapshot());
  const refs = plan.research_scopes.map(scope => `${scope.kind}:${scope.subject.key}`);
  const vendorRef = refs.find(ref => ref.startsWith('vendor:'));
  const empty = { source_id: 'source-empty', url: 'https://kling.ai/empty', title: 'Empty', excerpt: '', discovered_for: [vendorRef] };
  const research = { official_sources: [empty] };
  const input = buildSynthesisInput({ research, plan, expected_layer_fields: { vendor: ['vendor_summary'], group: [], detail: [] } });
  assert.equal(input.layers.vendor.sources.length, 0);
});

test('synthesis instructions cover field rules, enums, and provenance requirements', () => {
  const instructions = buildSynthesisInstructions();
  assert.match(instructions, /expected_layer_fields/);
  assert.match(instructions, /provenance/);
  assert.match(instructions, /source_id/);
  assert.match(instructions, /missing/);
  assert.match(instructions, /api_pricing/);
  assert.match(instructions, /access_level/);
  assert.match(instructions, /unknown/);
  assert.match(instructions, /features 是数组/);
  assert.match(instructions, /字段名必须逐字复制/);
  assert.match(instructions, /禁止使用 vendor_features/);
  assert.match(instructions, /禁止用逗号、顿号或分号把多个特点拼接/);
  assert.match(instructions, /不得创建不存在的 source_id/);
});
