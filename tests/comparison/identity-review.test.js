'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectReviewCandidates,
  shouldEscalate,
  reviewCandidates,
} = require('../../src/comparison/identity-review');
const { suggestIdentityReview } = require('../../src/comparison/identity-review-ai');

const registry = { schema_version: 2, entries: [] };

test('identity review：只收集确定性解析无法分类的名称 token', () => {
  const candidates = collectReviewCandidates({
    openrouter: { data: [] },
    lmarena: {
      configs: {
        webdev: [
          { model_name: 'gpt-5.5-high (codex-harness)', organization: 'openai' },
          { model_name: 'gemini-3-pro (future-harness)', organization: 'google' },
        ],
      },
    },
    livebench: { groups: [] },
    llm_stats: { models: [] },
  }, registry);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].raw_name, 'gemini-3-pro (future-harness)');
  assert.equal(candidates[0].deterministic_parse.model_key, 'google--gemini-3-pro-future-harness');
  assert.deepEqual(candidates[0].deterministic_parse.ambiguous_tokens, ['future-harness']);
});

test('identity review：本地低置信或会变更 canonical 时升级，结果必须人工确认', async () => {
  const candidate = {
    source: 'lmarena', raw_name: 'model (unknown-harness)',
    deterministic_parse: { model_key: 'vendor--model-unknown-harness', ambiguous_tokens: ['unknown-harness'] },
    requires_human_approval: true,
  };
  const weakLocal = { ok: true, value: { model_key: 'vendor--model', degree: 'high', evaluation_profile: 'unknown-harness', confidence: 0.6, reason: '候选' } };
  assert.equal(shouldEscalate(candidate, weakLocal, []), true);

  const rows = await reviewCandidates([candidate], {
    localSuggest: async () => weakLocal,
    deepseekSuggest: async () => ({ ok: true, value: { model_key: 'vendor--model', degree: 'high', evaluation_profile: 'unknown-harness', confidence: 0.99, reason: '复核建议' } }),
  });
  assert.equal(rows[0].adapter, 'deepseek');
  assert.equal(rows[0].status, 'pending_human_review');
  assert.equal(rows[0].requires_human_approval, true);
  assert.equal(rows[0].suggestion.model_key, 'vendor--model');
});

test('identity review AI：本地 Bonsai 是默认 Adapter，输出仍须通过结构契约', async () => {
  const ledger = { reserve: () => ({ ok: true }) };
  const result = await suggestIdentityReview({
    source: 'lmarena', raw_name: 'model (future-harness)',
    deterministic_parse: { model_key: 'vendor--model-future-harness', ambiguous_tokens: ['future-harness'] },
  }, {
    ledger,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        model_key: 'vendor--model', degree: 'high', evaluation_profile: 'future-harness', confidence: 0.95, reason: '测试建议',
      }) } }] }),
    }),
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.model_key, 'vendor--model');
});
