'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEntityExtractInstructions,
  validateExtractOutput,
  toEntityList,
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

test('buildEntityExtractInstructions 覆盖类型化输出与笼统名排除', () => {
  const text = buildEntityExtractInstructions();
  assert.match(text, /概念/);
  assert.match(text, /工具/);
  assert.match(text, /模型/);
  assert.match(text, /套餐/);
  assert.match(text, /多词名不拆散/);
  assert.match(text, /检查一遍/);
  assert.match(text, /禁止编造/);
  // 新要求：输出带类型 {name, type}，笼统名标 vague
  assert.match(text, /\{name, type\}/);
  assert.match(text, /"vague"/);
  assert.match(text, /可灵|通义千问|豆包/);
});

test('validateExtractOutput 接受类型数组与旧裸数组，拒绝非法', () => {
  // 类型数组 [{name, type}]
  assert.equal(validateExtractOutput([{ name: 'Cursor', type: 'tool' }]), true);
  assert.equal(validateExtractOutput([{ name: 'Qwen3.8-Max', type: 'model' }, { name: 'RAG', type: 'concept' }]), true);
  assert.equal(validateExtractOutput([]), true);
  assert.equal(validateExtractOutput([{ name: 'a' }]), false);          // 缺 type
  assert.equal(validateExtractOutput([{ name: 'a', type: 'bogus' }]), false); // 非法 type
  assert.equal(validateExtractOutput([{ name: 1, type: 'tool' }]), false);   // name 非字符串
  assert.equal(validateExtractOutput([{ name: 'a', type: 'tool' }, 2]), false); // 混合
  // 旧版裸字符串数组 / {names} / {entities} 兼容
  assert.equal(validateExtractOutput(['a', 'b']), true);
  assert.equal(validateExtractOutput({ names: ['a', 'b'] }), true);
  assert.equal(validateExtractOutput({ entities: ['a'] }), true);
  assert.equal(validateExtractOutput([1, 2]), false);
  assert.equal(validateExtractOutput({}), false);
  assert.equal(validateExtractOutput(null), false);
});

test('toEntityList 归一化类型数组与旧格式、去空串', () => {
  assert.deepEqual(toEntityList([{ name: ' DeepSeek ', type: 'tool' }, { name: '', type: 'tool' }]), [{ name: 'DeepSeek', type: 'tool' }]);
  assert.deepEqual(toEntityList({ names: ['RAG', 'vibe coding'] }), [{ name: 'RAG', type: 'tool' }, { name: 'vibe coding', type: 'tool' }]);
  assert.deepEqual(toEntityList({ entities: ['a'] }), [{ name: 'a', type: 'tool' }]);
  assert.deepEqual(toEntityList(null), []);
  assert.deepEqual(toEntityList([{ name: 'Kling 2.6 Pro', type: 'model' }, { name: '可灵', type: 'vague' }]),
    [{ name: 'Kling 2.6 Pro', type: 'model' }, { name: '可灵', type: 'vague' }]);
});

test('toNameList 仅取名称', () => {
  assert.deepEqual(toNameList([{ name: 'Cursor', type: 'tool' }, { name: 'RAG', type: 'concept' }]), ['Cursor', 'RAG']);
  assert.deepEqual(toNameList(['DeepSeek', '']), ['DeepSeek']);
});

test('extractEntitiesWithLlm 成功返回带类型实体，请求带 Bearer', async () => {
  let captured;
  const entities = await extractEntitiesWithLlm('Claude Code 和 Qwen3.8-Max 都很强。', {
    ledger: ledger(),
    apiKey: 'test-key',
    model: 'deepseek-v4-flash',
    fetchImpl: async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return response({ output_text: '[{"name":"Claude Code","type":"tool"},{"name":"Qwen3.8-Max","type":"model"}]' });
    },
  });
  assert.deepEqual(entities, [
    { name: 'Claude Code', type: 'tool' },
    { name: 'Qwen3.8-Max', type: 'model' },
  ]);
  assert.equal(captured.headers.Authorization, 'Bearer test-key');
  assert.equal(captured.body.model, 'deepseek-v4-flash');
  assert.match(captured.body.instructions, /订阅套餐/);
  assert.equal(captured.body.input, JSON.stringify({ text: 'Claude Code 和 Qwen3.8-Max 都很强。' }));
});

test('extractEntitiesWithLlm 模型输出 {names} 旧格式也能归一化', async () => {
  const entities = await extractEntitiesWithLlm('文本', {
    ledger: ledger(),
    apiKey: 'test-key',
    model: 'm',
    fetchImpl: async () => response({ output_text: '{"names":["Cursor"]}' }),
  });
  assert.deepEqual(entities, [{ name: 'Cursor', type: 'tool' }]);
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
  const entities = await extractEntitiesWithLlm('RAG 技术。', {
    apiKey: 'test-key',
    model: 'm',
    fetchImpl: async () => response({ output_text: '[{"name":"RAG","type":"concept"}]' }),
  });
  assert.deepEqual(entities, [{ name: 'RAG', type: 'concept' }]);
});
