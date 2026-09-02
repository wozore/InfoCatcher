'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createMaintainerWorkbenchServer } = require('../../src/maintenance/maintainer-workbench-server');

function request(port, method, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body == null ? null : JSON.stringify(options.body);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...(options.headers || {}) } }, res => {
      let response = ''; res.setEncoding('utf8'); res.on('data', part => { response += part; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: response }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

const service = Object.freeze({
  overview: () => ({ ok: 'overview' }), clearWorkspace: () => ({ ok: true, status: 'cleared' }), newsReview: () => ({ items: [] }), reviewNews: body => ({ body }),
  keywords: () => ({ list: null }), generateKeywords: async () => ({ generated: 'keywords' }), applyKeywords: body => ({ body }), top: () => ({ items: [] }), generateTop: async () => ({ generated: 'top' }), applyTop: body => ({ body }),
  publishNews: () => ({ published: true }), publishPreview: () => ({ items: [] }), toolUpdates: () => ({ items: [] }), previewToolUpdates: () => ({ ok: true, preview_hash: 'hash' }), applyToolUpdates: body => ({ ok: true, body }), reviewToolUpdate: (key, body) => ({ key, body }), uploadTranscript: body => ({ ok: true, candidate_id: body.candidate_id }), summarizeTranscripts: body => ({ ok: true, summarized: (body.ids || []).map(id => ({ id })) }), conceptPreviews: () => ({ preview: null }),
  pendingTools: () => ({ revision: 'p-r1', items: [] }), pendingConcepts: () => ({ revision: 'p-r1', items: [] }), reviewPendingTool: body => ({ ok: true, candidate_key: body.candidate_key, revision: 'p-r2' }), reviewPendingConcept: body => ({ ok: true, candidate_key: body.candidate_key, revision: 'p-r2' }), extractKnowledge: async () => ({ ok: true, tools_pending: 0, concepts_pending: 0 }), catalogPlan: () => ({ ok: true, plan_hash: 'plan-h', catalog_revision: 'c-r1', pending_revision: 'p-r1' }), catalogPrepare: async () => ({ ok: true, drafts: [] }), catalogDrafts: () => ({ items: [] }), catalogDraft: id => ({ draft_id: id }), catalogReview: id => ({ ok: true, draft_id: id, current_revision: 'c-r1', preview_hash: 'ph' }), catalogRecoveryPlan: (id, body) => ({ ok: true, draft_id: id, body }), catalogResume: async (id, body) => ({ ok: true, draft: { draft_id: id }, body }), catalogDiscard: (id, body) => ({ ok: true, draft_id: id, expected_revision: body?.expected_revision }), catalogApply: body => ({ ok: true, body }), conceptPlan: async () => ({ ok: true, plan_hash: 'cplan-h', glossary_revision: 'g-r1', pending_revision: 'p-r1' }), conceptPrepare: async () => ({ ok: true, preview: null }), conceptApply: body => ({ ok: true, added: (body.terms || []).map(term => ({ term })) }),
});

test('server binds localhost, provides GET API security headers, and protects mutations', async t => {
  const app = createMaintainerWorkbenchServer({ service, token: 'test-token', staticFiles: new Map([['/index.html', __filename]]) });
  t.after(() => app.close());
  const started = await app.start();
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=test-token$/);
  const get = await request(started.port, 'GET', '/api/workbench/v1/overview');
  assert.equal(get.status, 200); assert.equal(JSON.parse(get.body).ok, 'overview');
  assert.equal(get.headers['cache-control'], 'no-store'); assert.equal(get.headers['x-content-type-options'], 'nosniff');
  assert.match(get.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await request(started.port, 'POST', '/api/workbench/v1/news/review', { body: { ids: ['x'], decision: 'approved' } })).status, 403);
  const allowed = await request(started.port, 'POST', '/api/workbench/v1/news/review', { body: { ids: ['x'], decision: 'approved', expected_revision: 'news-r1' }, headers: { Authorization: 'Bearer test-token', Origin: `http://127.0.0.1:${started.port}` } });
  assert.equal(allowed.status, 200); assert.deepEqual(JSON.parse(allowed.body).body, { ids: ['x'], decision: 'approved', expected_revision: 'news-r1' });
});


test('工作台清空接口要求本机同源并透传完成态门禁', async t => {
  let calls = 0;
  const guarded = { ...service, clearWorkspace: () => { calls += 1; return { ok: false, code: 'WORKBENCH_NOT_COMPLETE', message: '仍有待处理项' }; } };
  const app = createMaintainerWorkbenchServer({ service: guarded, token: 'test-token' });
  t.after(() => app.close());
  const { port } = await app.start();
  const auth = { Authorization: 'Bearer test-token', Origin: `http://127.0.0.1:${port}` };
  const forbidden = await request(port, 'POST', '/api/workbench/v1/workbench/clear', { body: {}, headers: { Authorization: 'Bearer test-token', Origin: `http://127.0.0.1:${port + 1}` } });
  assert.equal(forbidden.status, 403);
  const blocked = await request(port, 'POST', '/api/workbench/v1/workbench/clear', { body: {}, headers: auth });
  assert.equal(blocked.status, 400);
  assert.equal(JSON.parse(blocked.body).code, 'WORKBENCH_NOT_COMPLETE');
  assert.equal(calls, 1);
});


test('recovery endpoints preserve strict two-phase payloads and map token changes to 409', async t => {
  const app = createMaintainerWorkbenchServer({ service, token: 'test-token' });
  t.after(() => app.close());
  const { port } = await app.start();
  const auth = { Authorization: 'Bearer test-token', Origin: `http://127.0.0.1:${port}` };
  const plan = await request(port, 'POST', '/api/workbench/v1/catalog/drafts/draft-blocked/recovery-plan', {
    body: { expected_revision: 'c-r1', generator_options: { model: 'deepseek-v4-flash' } },
    headers: auth,
  });
  assert.equal(plan.status, 200);
  assert.equal(JSON.parse(plan.body).body.generator_options.model, 'deepseek-v4-flash');
  const resumed = await request(port, 'POST', '/api/workbench/v1/catalog/drafts/draft-blocked/resume', {
    body: { expected_revision: 'c-r1', generator_options: { model: 'deepseek-v4-flash' }, recovery_token: 'token', confirm_cost: true },
    headers: auth,
  });
  assert.equal(resumed.status, 200);
  assert.equal(JSON.parse(resumed.body).body.confirm_cost, true);
  const changed = { ...service, catalogResume: () => ({ ok: false, code: 'RECOVERY_TOKEN_CHANGED' }) };
  const app2 = createMaintainerWorkbenchServer({ service: changed, token: 'test-token' });
  t.after(() => app2.close());
  const started2 = await app2.start();
  const conflict = await request(started2.port, 'POST', '/api/workbench/v1/catalog/drafts/draft-blocked/resume', {
    body: { expected_revision: 'c-r1', recovery_token: 'token', confirm_cost: true },
    headers: { Authorization: 'Bearer test-token', Origin: `http://127.0.0.1:${started2.port}` },
  });
  assert.equal(conflict.status, 409);
  assert.equal(JSON.parse(conflict.body).code, 'RECOVERY_TOKEN_CHANGED');
});


test('工作台后续动作保持同源鉴权并等待异步服务结果', async t => {
  const app = createMaintainerWorkbenchServer({ service, token: 'test-token' });
  t.after(() => app.close());
  const { port } = await app.start();
  const auth = { Authorization: 'Bearer test-token', Origin: `http://127.0.0.1:${port}` };
  assert.equal((await request(port, 'POST', '/api/workbench/v1/news/keywords/generate', { body: {}, headers: auth })).status, 200);
  assert.deepEqual(JSON.parse((await request(port, 'POST', '/api/workbench/v1/news/top/generate', { body: {}, headers: auth })).body), { generated: 'top' });
  assert.equal((await request(port, 'GET', '/api/workbench/v1/tool-updates/preview')).status, 200);
  const apply = await request(port, 'POST', '/api/workbench/v1/tool-updates/apply', { body: { expected_revision: 'r', preview_hash: 'h', confirm: 'APPLY TOOL-UPDATES h' }, headers: auth });
  assert.equal(apply.status, 200);
  assert.equal(JSON.parse(apply.body).body.confirm, 'APPLY TOOL-UPDATES h');
});

test('字幕上传接受更大请求体并保留外部 AI 成本确认', async t => {
  const app = createMaintainerWorkbenchServer({ service, token: 'test-token' });
  t.after(() => app.close());
  const { port } = await app.start();
  const auth = { Authorization: 'Bearer test-token', Origin: `http://127.0.0.1:${port}` };
  const bigBase64 = Buffer.from('字'.repeat(40000), 'utf8').toString('base64'); // ~53KiB，超过默认 32KiB
  const upload = await request(port, 'POST', '/api/workbench/v1/news/transcripts/upload', {
    body: { candidate_id: 'yt-1', filename: 'sub.srt', content_base64: bigBase64, expected_revision: 'r' },
    headers: auth,
  });
  assert.equal(upload.status, 200);
  assert.equal(JSON.parse(upload.body).candidate_id, 'yt-1');
  const summarize = await request(port, 'POST', '/api/workbench/v1/news/transcripts/summarize', {
    body: { ids: ['yt-1'], confirm_cost: true, expected_revision: 'r' },
    headers: auth,
  });
  assert.equal(summarize.status, 200);
  assert.equal(JSON.parse(summarize.body).summarized.length, 1);
});

test('server returns client error for fail-closed mutation results', async t => {
  const guardedService = { ...service, reviewToolUpdate: () => ({ ok: false, code: 'TOOL_UPDATE_REVIEW_NOT_CURRENT' }) };
  const app = createMaintainerWorkbenchServer({ service: guardedService, token: 'token' });
  t.after(() => app.close());
  const { port } = await app.start();
  const response = await request(port, 'POST', '/api/workbench/v1/tool-updates/old/review', {
    body: { decision: 'approved', expected_revision: 'tool-r1' },
    headers: { Authorization: 'Bearer token', Origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(response.status, 400);
  assert.equal(JSON.parse(response.body).code, 'TOOL_UPDATE_REVIEW_NOT_CURRENT');
});
test('server returns revision conflicts as 409 without exposing revisions', async t => {
  const conflict = new Error('候选层 revision 冲突：expected=secret-old，actual=secret-new');
  conflict.code = 'REVISION_CONFLICT';
  const app = createMaintainerWorkbenchServer({ service: { ...service, reviewNews: () => { throw conflict; } }, token: 'token' });
  t.after(() => app.close());
  const { port } = await app.start();
  const response = await request(port, 'POST', '/api/workbench/v1/news/review', {
    body: { ids: ['x'], decision: 'approved', expected_revision: 'r' },
    headers: { Authorization: 'Bearer token', Origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.body), { error: 'REVISION_CONFLICT', message: '数据已变化，请刷新后重试。' });
});
test('server rejects non-whitelisted paths, traversal, bad content, and oversized bodies', async t => {
  const app = createMaintainerWorkbenchServer({ service, token: 'token' }); t.after(() => app.close());
  const { port } = await app.start(); const auth = { Authorization: 'Bearer token', Origin: `http://127.0.0.1:${port}` };
  assert.equal((await request(port, 'GET', '/../package.json')).status, 404);
  assert.equal((await request(port, 'GET', '/not-whitelisted.js')).status, 404);
  assert.equal((await request(port, 'POST', '/api/workbench/v1/news/top', { headers: auth })).status, 415);
  const response = await request(port, 'POST', '/api/workbench/v1/news/top', { body: { ids: ['x'.repeat(33000)] }, headers: auth });
  assert.equal(response.status, 413);
});

test('knowledge-loop mutations require Bearer and same-origin, and reject stale as 409', async t => {
  const app = createMaintainerWorkbenchServer({ service, token: 'token' }); t.after(() => app.close());
  const { port } = await app.start();
  const auth = { Authorization: 'Bearer token', Origin: `http://127.0.0.1:${port}` };
  const stale = { Authorization: 'Bearer token', Origin: `http://127.0.0.1:${port + 1}` };
  const mutations = [
    ['/feedback/tools/tool-key/review', { decision: 'approved', expected_revision: 'p-r1' }],
    ['/knowledge/extract', { expected_revision: 'news-r1' }],
    ['/catalog/prepare', { pending_revision: 'p-r1', catalog_revision: 'c-r1', plan_hash: 'plan-h', confirm_cost: true }],
    ['/catalog/drafts/draft-abc/discard', { expected_revision: 'c-r1' }],
    ['/catalog/apply', { draft_id: 'draft-abc', expected_revision: 'c-r1', preview_hash: 'ph', confirm: 'APPLY CATALOG DRAFT draft-abc' }],
    ['/concepts/prepare', { pending_revision: 'p-r1', glossary_revision: 'g-r1', plan_hash: 'cplan-h', confirm_cost: true }],
    ['/concepts/apply', { terms: ['RAG'], expected_revision: 'g-r1', preview_hash: 'ph', confirm: 'APPLY CONCEPTS ph' }],
  ];
  for (const [pathname, body] of mutations) {
    assert.equal((await request(port, 'POST', `/api/workbench/v1${pathname}`, { body, headers: stale })).status, 403, pathname);
    assert.equal((await request(port, 'POST', `/api/workbench/v1${pathname}`, { body, headers: auth })).status, 200, pathname);
  }
  const conflict = Object.assign(new Error('stale'), { code: 'REVISION_CONFLICT' });
  const guarded = { ...service, reviewPendingTool: () => { throw conflict; } };
  const app2 = createMaintainerWorkbenchServer({ service: guarded, token: 'token' }); t.after(() => app2.close());
  const started = await app2.start();
  const response = await request(started.port, 'POST', '/api/workbench/v1/feedback/tools/tool-key/review', {
    body: { decision: 'approved', expected_revision: 'p-r1' },
    headers: { Authorization: 'Bearer token', Origin: `http://127.0.0.1:${started.port}` },
  });
  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.body), { error: 'REVISION_CONFLICT', message: '数据已变化，请刷新后重试。' });
});
