/**
 * content-classifier-llm.test.js —— L1 AI 内容分类（DeepSeek）测试（B16 路径 A）
 *
 * 覆盖：
 *   1. llm-provider 单元：请求体结构、输出规整（脏输出/中文标签）、缺 key / 网络 /
 *      非 200 / 空内容 / 无法映射等失败路径一律返回降级对象（不 reject）；
 *   2. classifyCandidate L1 集成：成功用 L1 结果、失败自动回退 L0、未知 provider 回退 L0；
 *   3. classifyCandidates：跳过已 reviewed（人工结论不覆盖）、并发保持输入顺序、跳过无标题项。
 *
 * 全部用 mock fetch（fetch 注入模式），不发真实网络请求、不消费额度。
 *
 * 运行方式：node --test tests/news/content-classifier-llm.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyCandidate,
  classifyCandidates,
  CONTENT_TYPES,
} = require('../../src/news/classify/content-classifier');
const { classifyContent } = require('../../src/news/classify/llm-provider');
const { buildClassifyPayload, normalizeLabel } = require('../../src/news/classify/llm-prompts');
const { getProvider } = require('../../src/shared/providers');

// ── mock fetch 工具 ─────────────────────────────────────────────

function okJsonResponse(content, extra = {}) {
  return {
    ok: true,
    status: 200,
    async json() { return { choices: [{ message: { content } }], ...extra }; },
    async text() { return ''; },
  };
}

function httpErrorResponse(status, body = 'error body') {
  return {
    ok: false,
    status,
    async json() { throw new Error('no json on error'); },
    async text() { return body; },
  };
}

// ── 第 1 组：llm-provider 单元 ─────────────────────────────────

test('buildClassifyPayload 构建 OpenAI 兼容 chat 请求体', () => {
  const payload = buildClassifyPayload(
    { title: '标题', description: '描述'.repeat(10) },
    'my-model'
  );
  assert.equal(payload.model, 'my-model');
  assert.equal(payload.temperature, 0);
  assert.equal(payload.max_tokens, 8);
  assert.equal(payload.stream, false);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[1].role, 'user');
  assert.ok(payload.messages[1].content.includes('标题'));
  assert.ok(payload.messages[1].content.includes('描述'));
});

test('buildClassifyPayload 裁剪超长标题/描述，控制单条 token 成本', () => {
  const payload = buildClassifyPayload({ title: 'T'.repeat(500), description: 'D'.repeat(2000) });
  const user = payload.messages[1].content;
  // 标题裁剪到 200 字符、描述裁剪到 600 字符（标题为 500 个 T 会被截断）
  assert.ok(user.includes('T'.repeat(200)));
  assert.ok(!user.includes('T'.repeat(201)));
});

test('normalizeLabel 规整合法枚举 / 中文标签 / 带解释的脏输出', () => {
  assert.equal(normalizeLabel('ai_tool'), 'ai_tool');
  assert.equal(normalizeLabel('ai_industry。'), 'ai_industry');   // 尾句号
  assert.equal(normalizeLabel('"ai_product"'), 'ai_product');     // 引号
  assert.equal(normalizeLabel('AI 产品'), 'ai_product');          // 中文标签
  assert.equal(normalizeLabel('其他'), 'other');
  assert.equal(normalizeLabel('ai_industry 该条为某公司融资事件'), 'ai_industry'); // 枚举+解释
  assert.equal(normalizeLabel('完全无法理解'), null);             // 无法映射
  assert.equal(normalizeLabel(null), null);
  assert.equal(normalizeLabel(''), null);
});

test('classifyContent(provider=deepseek) 经注册表路由到 chat 端点，成功返回 ok + 合法枚举', async () => {
  const deepseek = getProvider('deepseek');
  const fetchImpl = async (url, options) => {
    assert.equal(url, deepseek.chatEndpoint);
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, deepseek.defaultModel);
    return okJsonResponse('ai_tool');
  };
  const result = await classifyContent({ title: 'x', description: 'y' }, { provider: 'deepseek', apiKey: 'test-key', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.content_type, 'ai_tool');
  assert.equal(result.ai_confidence, 0.85);
});

test('classifyContent(默认 zhipu) 走智谱 Anthropic 端点 + glm-5.3-flash', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://open.bigmodel.cn/api/anthropic/v1/messages');
    assert.equal(options.headers['x-api-key'], 'test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'glm-5.3-flash');
    assert.ok(body.system);
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'ai_product' }] }),
      text: async () => '',
    };
  };
  const result = await classifyContent({ title: 'x', description: 'y' }, { apiKey: 'test-key', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.content_type, 'ai_product');
  assert.equal(result.ai_confidence, 0.85);
});

test('classifyContent 缺 key 返回降级对象（不抛错）', async () => {
  const result = await classifyContent({ title: 'x' }, { apiKey: '', fetchImpl: async () => okJsonResponse('other') });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_api_key');
});

test('classifyContent 网络失败返回降级对象（不抛错）', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const result = await classifyContent({ title: 'x' }, { apiKey: 'test-key', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'network_error');
  assert.ok(result.error.length > 0);
});

test('classifyContent 抛出同步异常时 resolve 降级而不 reject', async () => {
  const fetchImpl = () => { throw new TypeError('unexpected sync crash'); };
  const result = await classifyContent({ title: 'x' }, { apiKey: 'test-key', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'network_error');
  assert.ok(result.error.includes('unexpected sync crash'));
});

test('classifyContent 非 200 返回降级对象并带 HTTP 状态', async () => {
  const fetchImpl = async () => httpErrorResponse(500, 'internal error');
  const result = await classifyContent({ title: 'x' }, { apiKey: 'test-key', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'http_500');
  assert.ok(result.error.includes('500'));
});

test('classifyContent 输出无法映射返回降级对象', async () => {
  const fetchImpl = async () => okJsonResponse('随便说的内容');
  const result = await classifyContent({ title: 'x' }, { apiKey: 'test-key', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_label');
});

// ── 第 2 组：classifyCandidate L1 集成 ─────────────────────────

test('classifyCandidate(provider=deepseek) 成功时用 L1 结果', async () => {
  const fetchImpl = async () => okJsonResponse('ai_product');
  const result = await classifyCandidate(
    { title: '某公司发布新品', description: '上线了新的 AI 助手' },
    { provider: 'deepseek', apiKey: 'test-key', fetchImpl }
  );
  assert.equal(result.content_type, 'ai_product');
  assert.equal(result.content_type_status, 'ai_suggested');
  assert.equal(result.classifier, 'llm_deepseek');
  assert.equal(result.ai_confidence, 0.85);
});

test('classifyCandidate 脏输出经 normalizeLabel 规整为合法枚举', async () => {
  const fetchImpl = async () => okJsonResponse('AI 行业事件。');
  const result = await classifyCandidate({ title: 'x', description: 'y' }, { provider: 'deepseek', apiKey: 'test-key', fetchImpl });
  assert.equal(result.content_type, 'ai_industry');
  assert.equal(result.classifier, 'llm_deepseek');
});

test('classifyCandidate 模型可经 env 覆盖（options.model > KNOWVIEW_CLASSIFY_MODEL）', async () => {
  const original = process.env.KNOWVIEW_CLASSIFY_MODEL;
  process.env.KNOWVIEW_CLASSIFY_MODEL = 'glm-4-plus';
  const bodies = [];
  try {
    const fetchImpl = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return okJsonResponse('ai_tool');
    };
    const viaEnv = await classifyCandidate({ title: 'x' }, { provider: 'zhipu', apiKey: 'k', fetchImpl });
    assert.equal(viaEnv.ok !== false, true);
    assert.equal(bodies[0].model, 'glm-4-plus');
    await classifyCandidate({ title: 'x' }, { provider: 'zhipu', apiKey: 'k', model: 'explicit-model', fetchImpl });
    assert.equal(bodies[1].model, 'explicit-model');
  } finally {
    if (original === undefined) delete process.env.KNOWVIEW_CLASSIFY_MODEL;
    else process.env.KNOWVIEW_CLASSIFY_MODEL = original;
  }
});

test('classifyCandidate L1 网络失败自动回退 L0 并保留原因', async () => {
  const fetchImpl = async () => { throw new Error('timeout'); };
  const result = await classifyCandidate(
    { title: '某公司完成新一轮融资', description: '宣布完成数亿元融资，估值翻倍' },
    { provider: 'deepseek', apiKey: 'test-key', fetchImpl }
  );
  assert.equal(result.classifier, 'rule_based_fallback');
  assert.ok(CONTENT_TYPES.includes(result.content_type));
  assert.notEqual(result.content_type, 'unclassified');
  assert.ok(result.reasons[0].includes('回退 L0'));
  assert.equal(result.content_type_status, 'ai_suggested');
});

test('classifyCandidate 未配置 provider 时走纯 L0 规则式', async () => {
  const result = await classifyCandidate({ title: '某公司发布新品', description: '新功能上线' }, {});
  assert.equal(result.classifier, 'rule_based');
  assert.ok(CONTENT_TYPES.includes(result.content_type));
});

test('classifyCandidate 未知 provider 回退 L0 并标注', async () => {
  const result = await classifyCandidate({ title: 'x', description: 'y' }, { provider: 'unknown_provider' });
  assert.equal(result.classifier, 'rule_based_fallback');
  assert.ok(result.reasons[0].includes('未知分类 provider'));
});

// ── 第 3 组：classifyCandidates 批量语义 ────────────────────────

test('classifyCandidates 跳过已人工确认（reviewed）的候选，不覆盖结论', async () => {
  const reviewed = { title: '已确认', description: 'x', content_type: 'ai_industry', content_type_status: 'reviewed' };
  const fresh = { title: '新候选', description: 'y' };
  const fetchImpl = async () => okJsonResponse('ai_product');
  const result = await classifyCandidates([reviewed, fresh], { provider: 'deepseek', apiKey: 'test-key', fetchImpl });
  assert.equal(result.classified, 1);
  assert.equal(result.skipped, 1);
  assert.equal(reviewed.content_type, 'ai_industry');      // 未被 AI 建议覆盖
  assert.equal(reviewed.content_type_status, 'reviewed');
  assert.equal(fresh.content_type, 'ai_product');
  assert.equal(fresh.content_type_status, 'ai_suggested');
});

test('classifyCandidates 并发分类保持输入顺序，L1 失败项回退 L0', async () => {
  const items = [
    { title: 'A 工具使用教程', description: '如何用某工具提升效率' },
    { title: 'B 公司完成融资', description: '宣布完成亿元融资' },
  ];
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return okJsonResponse('ai_tool');
    throw new Error('network down'); // 第二条失败
  };
  const result = await classifyCandidates(items, { provider: 'deepseek', apiKey: 'test-key', fetchImpl, concurrency: 2 });
  assert.equal(result.classified, 2);
  assert.equal(result.skipped, 0);
  assert.equal(items[0].content_type, 'ai_tool');
  assert.equal(items[0].classifier, 'llm_deepseek');
  assert.equal(items[1].classifier, 'rule_based_fallback'); // 回退 L0
  assert.ok(CONTENT_TYPES.includes(items[1].content_type));
  assert.notEqual(items[1].content_type, 'unclassified');
});

test('classifyCandidates 跳过无标题项', async () => {
  const result = await classifyCandidates(
    [{ description: 'no title' }, { title: 'ok' }],
    { provider: 'deepseek', apiKey: 'test-key', fetchImpl: async () => okJsonResponse('other') }
  );
  assert.equal(result.skipped, 1);
  assert.equal(result.classified, 1);
});

test('classifyCandidates 空输入返回空结果', async () => {
  const result = await classifyCandidates(null, {});
  assert.equal(result.classified, 0);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.items, []);
});
