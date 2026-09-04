'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildIntegratedLookup, lookupReleaseDateForSeed, slugifyModelName } = require('../../src/catalog/catalog-integrated-lookup');
const { applyIntegratedReleaseDate } = require('../../src/catalog/core/index');
const { validateSynthesisOutput } = require('../../src/catalog/core/index');

const SHARED = {
  schema_version: 1,
  entries: [
    { model_key: 'openai--gpt-5.5', release_date: '2026-04-23', catalog_aliases: ['gpt-5-5', 'GPT-5.5'] },
    { model_key: 'zai--glm-5.3', release_date: '2026-05-30', catalog_aliases: ['glm-5-3'] },
    { model_key: 'google--gemini-3.5-flash', release_date: '2026-05-19', catalog_aliases: [] },
  ],
};

test('integrated lookup：按 tool_key / 标题 / slug 查找 release_date', () => {
  const lookup = buildIntegratedLookup(SHARED);
  assert.equal(lookupReleaseDateForSeed({ tool_key: 'gpt-5-5', name: 'GPT-5.5' }, lookup).date, '2026-04-23');
  assert.equal(lookupReleaseDateForSeed({ name: 'GLM-5.3' }, lookup).date, '2026-05-30');
  // identity slug（无 catalog_aliases 时按 canonical identity 匹配）
  assert.equal(lookupReleaseDateForSeed({ name: 'Gemini 3.5 Flash' }, lookup).date, '2026-05-19');
  assert.equal(lookupReleaseDateForSeed({ name: '未知模型' }, lookup), null);
});

test('integrated lookup：slugify 处理空格/点号', () => {
  assert.equal(slugifyModelName('GLM-5.3'), 'glm-5.3');
  assert.equal(slugifyModelName('Gemini 3.5 Flash'), 'gemini-3.5-flash');
  assert.equal(lookupReleaseDateForSeed({ name: 'Gemini 3.5 Flash' }, buildIntegratedLookup(SHARED)).date, '2026-05-19');
});

test('applyIntegratedReleaseDate：AI 无值时不填，已有值不覆盖，tool 不填', () => {
  const baseInput = (detailKind, known) => ({
    plan: { seed: { known_fields: { integrated_release_date: known } }, profile: { detail_kind: detailKind } },
  });
  // api_model 无 release_date → 机械填
  const filled = applyIntegratedReleaseDate(baseInput('api_model', '2026-04-23'), { layer_fields: { detail: {} }, provenance: {} });
  assert.equal(filled.layer_fields.detail.release_date, '2026-04-23');
  assert.equal(filled.provenance['detail.release_date'][0].kind, 'deterministic');
  // AI 已有值 → 不覆盖
  const existing = applyIntegratedReleaseDate(baseInput('api_model', '2026-04-23'), { layer_fields: { detail: { release_date: '2026-06-01' } }, provenance: {} });
  assert.equal(existing.layer_fields.detail.release_date, '2026-06-01');
  // tool → 不填（走 last_updated_date）
  const tool = applyIntegratedReleaseDate(baseInput('tool', '2026-04-23'), { layer_fields: { detail: {} }, provenance: {} });
  assert.equal(tool.layer_fields.detail.release_date, undefined);
  // 无 hint → 不填
  const noHint = applyIntegratedReleaseDate(baseInput('api_model', undefined), { layer_fields: { detail: {} }, provenance: {} });
  assert.equal(noHint.layer_fields.detail.release_date, undefined);
});

test('validateSynthesisOutput：deterministic 来源跳过官方来源校验', () => {
  const output = {
    layer_fields: { detail: { release_date: '2026-04-23' } },
    provenance: { 'detail.release_date': [{ kind: 'deterministic', basis: 'comparison_integrated', source_ids: [] }] },
  };
  const research = { official_sources: [] };
  const result = validateSynthesisOutput(output, research);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  // 普通字符串来源仍需存在
  const bad = { ...output, provenance: { 'detail.release_date': ['unknown-source-id'] } };
  assert.equal(validateSynthesisOutput(bad, research).ok, false);
});
