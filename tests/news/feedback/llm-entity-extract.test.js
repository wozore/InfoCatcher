'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEntityExtractInstructions,
  validateExtractOutput,
  toNameList,
  extractEntitiesWithLlm,
} = require('../../../src/news/feedback/llm-entity-extract');
const { createCostLedger } = require('../../../src/catalog/catalog-research');

function response(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload, text: async () => JSON.stringify(payload) };
}

function ledger() {
  return createCostLedger({ responses_calls: 5, synthesis_calls: 0 });
}

test('buildEntityExtractInstructions 覆盖概念/工具/模型/套餐、完整名、检查遗漏', () => {
  const text = buildEntityExtractInstructions();
  assert.match(text, /概念/);
  assert.match(text, /工具/);
  assert.match(text, /模型/);
  assert.match(text, /套餐/);
  assert.match(text, /多词名不拆散/);
  assert.match(text, /检查一遍/);
  assert.match(text, /禁止编造/);
});

test('validateExtractOutput 接受裸数组 / {names} / {entities}，拒绝非法', () => {
  assert.equal(validateExtractOutput(['a', 'b']), true);
  assert.equal(validateExtractOutput({ names: ['a', 'b'] }), true);
  assert.equal(validateExtractOutput({ entities: ['a'] }), true);
  assert.equal(validateExtractOutput([1, 2]), false);
  assert.equal(validateExtractOutput({}), false);
  assert.equal(validateExtractOutput(null), false);
});

test('toNameList 归一化裸数组与对象、去空串', () => {
  assert.deepEqual(toNameList([' DeepSeek ', '']), ['DeepSeek']);
  assert.deepEqual(toNameList({ names: ['RAG', 'vibe coding'] }), ['RAG', 'vibe coding']);
  assert.deepEqual(toNameList({ entities: ['a'] }), ['a']);
  assert.deepEqual(toNameList(null), []);
});

test('extractEntitiesWithLlm 成功返回名称数组，请求带 Bearer', async () => {
  let captured;
  const names = await extractEntitiesWithLlm('Claude Code 和 Qwen3.8-Max 都很强。', {
    ledger: ledger(),
    apiKey: 'test-key',
    model: 'deepseek-v4-flash',
    fetchImpl: async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return response({ output_text: '["Claude Code","Qwen3.8-Max"]' });
    },
  });
  assert.deepEqual(names, ['Claude Code', 'Qwen3.8-Max']);
  assert.equal(captured.headers.Authorization, 'Bearer test-key');
  assert.equal(captured.body.model, 'deepseek-v4-flash');
  assert.match(captured.body.instructions, /订阅套餐/);
  assert.equal(captured.body.input, JSON.stringify({ text: 'Claude Code 和 Qwen3.8-Max 都很强。' }));
});

test('extractEntitiesWithLlm 模型输出对象 {names} 也能归一化', async () => {
  const names = await extractEntitiesWithLlm('文本', {
    ledger: ledger(),
    apiKey: 'test-key',
    model: 'm',
    fetchImpl: async () => response({ output_text: '{"names":["DeepSeek"]}' }),
  });
  assert.deepEqual(names, ['DeepSeek']);
});

test('extractEntitiesWithLlm 调用失败抛错（供注入层降级正则）', async () => {
  await assert.rejects(
    extractEntitiesWithLlm('文本', {
      ledger: ledger(),
      apiKey: 'test-key',
      model: 'm',
      fetchImpl: async () => response({ error: 'boom' }, false, 500),
    }),
    /boom/,
  );
});

test('extractEntitiesWithLlm 缺 ledger 时内部自建可用（feedback 场景零配置）', async () => {
  const names = await extractEntitiesWithLlm('RAG 技术。', {
    apiKey: 'test-key',
    model: 'm',
    fetchImpl: async () => response({ output_text: '["RAG"]' }),
  });
  assert.deepEqual(names, ['RAG']);
});
