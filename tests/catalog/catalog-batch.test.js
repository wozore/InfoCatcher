/**
 * catalog-batch.test.js — 批量生成编排层回归测试（②→③ 链路）
 *
 * 测试原理：
 *   不写真实 catalog 文件、不提交事务。生成生命周期（prepare/review/apply）用
 *   options 注入 stub（apply 真实实现会提交五模块目录与 dist，留给人工端到端验证）；
 *   厂商解析用 options.resolveOfficialSource 注入替换真实网络；登记表用内存注入。
 *   查重/解析/估算/批量循环/成本门禁 覆盖纯逻辑。
 *
 * 运行方式：node --test tests/catalog/catalog-batch.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { canonicalizeUrl } = require('../../src/shared/tavily-client');
const {
  readPendingCards,
  dedupeBatchCandidates,
  resolveBatchCandidates,
  runCatalogBatch,
  runBatchFromCards,
} = require('../../src/catalog/catalog-batch');
const { resolveOfficialSource } = require('../../src/catalog/ai/catalog-adapters');
const {
  lookupOfficialUrl,
  addUrlRegistryEntry,
  removeUrlRegistryEntry,
} = require('../../src/catalog/official-url-registry');

const GEN_OPTIONS = { maxSearchQueries: 2, maxPages: 2, maxResponsesCalls: 2, maxSynthesisCalls: 1 };

// ── 第 1 组：读入 ─────────────────────────────────────────────

test('readPendingCards 读取待补卡 cards 数组，缺 cards 拒绝', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-read-')), 'pending.json');
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, cards: [{ name: 'A' }, { name: 'B' }] }));
  assert.deepEqual(readPendingCards(file).map(card => card.name), ['A', 'B']);
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1 }));
  assert.throws(() => readPendingCards(file), /PENDING_CARDS_INVALID/);
});

// ── 第 2 组：查重三态 ──────────────────────────────────────────

test('dedupeBatchCandidates 三层查重：目录已存在 / 进行中 draft / 同批重复', () => {
  const cards = [
    { name: 'DeepSeek' },
    { name: 'Kling 2.6 Pro' },
    { name: 'Brand New Tool A' },
    { name: 'Brand New Tool A' },
    { name: 'Brand New Tool B' },
  ];
  const tools = [{ title: 'DeepSeek', tool_key: 'deepseek' }];
  const drafts = [{ draft_id: 'draft-x', seed: { name: 'Kling 2.6 Pro' } }];
  const result = dedupeBatchCandidates(cards, { tools, drafts });
  assert.deepEqual(result.skippedExisting.map(item => item.name), ['DeepSeek']);
  assert.equal(result.skippedDraft.length, 1);
  assert.equal(result.skippedDraft[0].draft_id, 'draft-x');
  assert.equal(result.duplicateInBatch.length, 1);
  assert.deepEqual(result.unique.map(card => card.name), ['Brand New Tool A', 'Brand New Tool B']);
});

// ── 第 3 组：厂商/官方源解析三路 ───────────────────────────────

test('resolveBatchCandidates 三路：登记表命中 / 解析成功 / unresolved', async () => {
  const registry = { schema_version: 1, entries: { 'Kling 2.6 Pro': { vendor_name: '快手可灵', official_url: 'https://klingai.com/' } } };
  const resolveFn = async name => (name === 'Unknown Tool')
    ? { ok: false, code: 'VENDOR_RESOLUTION_NO_RESULTS', error: 'no results' }
    : { ok: true, vendor_name: 'Alpha', official_url: 'https://official.example.com' };
  const result = await resolveBatchCandidates(
    [{ name: 'Kling 2.6 Pro' }, { name: 'Some Tool' }, { name: 'Unknown Tool' }],
    { registry, resolveOfficialSource: resolveFn },
  );
  assert.equal(result.seeds.length, 2);
  const kling = result.seeds[0];
  assert.equal(kling.name, 'Kling 2.6 Pro');
  assert.equal(kling.vendor_name, '快手可灵');
  assert.equal(kling.official_url, canonicalizeUrl('https://klingai.com/'));
  assert.ok(kling.discovery_sources.some(source => source.kind === 'official_hint'));
  assert.equal(kling.placement.existing_level2_ref, null);
  assert.equal(kling.placement.new_group_title, undefined, '不设 new_group_title，分组名由 deriveKeys 回退 seed.name');
  const resolved = result.seeds[1];
  assert.equal(resolved.vendor_name, 'Alpha');
  assert.equal(resolved.official_url, canonicalizeUrl('https://official.example.com'));
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].name, 'Unknown Tool');
});

test('resolveBatchCandidates 保留候选指定的稳定层级引用', async () => {
  const registry = { schema_version: 1, entries: { 'Gemini 3.7 Flash': { vendor_name: 'Google', official_url: 'https://ai.google.dev' } } };
  const result = await resolveBatchCandidates([{
    name: 'Gemini 3.7 Flash', vendor_key: 'google', detail_kind_hint: 'api_model',
    placement: {
      existing_level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:google' },
      existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:google:gemini' },
    },
  }], { registry });
  assert.deepEqual(result.seeds[0].placement, {
    existing_level1_ref: { kind: 'vendor-level1', id: 'vendor-level1:google' },
    existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:google:gemini' },
  });
});
test('resolveOfficialSource fail-closed：缺 name / 缺 TAVILY key 均不抛错', async () => {
  const noName = await resolveOfficialSource('   ');
  assert.equal(noName.ok, false);
  assert.equal(noName.code, 'VENDOR_RESOLUTION_NAME_REQUIRED');
  const noKey = await resolveOfficialSource('SomeTool', { searchApiKey: '', fetchImpl: async () => {} });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.code, 'TAVILY_SEARCH_FAILED'); // 缺 key 走 keyless，mock fetchImpl 返回非法响应 → FAILED
  const noKeyKeyed = await resolveOfficialSource('SomeTool', { searchApiKey: '', accessMode: 'keyed', fetchImpl: async () => {} });
  assert.equal(noKeyKeyed.ok, false);
  assert.match(noKeyKeyed.code, /TAVILY_.*_AUTH_REQUIRED/); // keyed 模式下缺 key 仍 fail-closed
});

// ── 第 4 组：批量顶层编排 ──────────────────────────────────────

test('runBatchFromCards --dry-run：查重+解析+成本估算，写 preview，不建 draft', async () => {
  const previewFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-dry-')), 'preview.json');
  const result = await runBatchFromCards([{ name: 'New Tool Alpha' }], {
    dryRun: true,
    previewFile,
    generatorOptions: GEN_OPTIONS,
    resolveOfficialSource: async () => ({ ok: true, vendor_name: 'Alpha', official_url: 'https://alpha.example.com' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.preview_file, previewFile);
  assert.equal(result.report, undefined, 'dry-run 不生成');
  const preview = JSON.parse(fs.readFileSync(previewFile, 'utf8'));
  assert.equal(preview.seeds.length, 1);
  assert.equal(preview.seeds[0].vendor_name, 'Alpha');
  assert.ok(preview.estimate && preview.estimate.per_seed.length === 1);
});

test('runBatchFromCards 无 confirmCost → COST_CONFIRMATION_REQUIRED，零生成', async () => {
  const result = await runBatchFromCards([{ name: 'New Tool Beta' }], {
    generatorOptions: GEN_OPTIONS,
    resolveOfficialSource: async () => ({ ok: true, vendor_name: 'Beta', official_url: 'https://beta.example.com' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COST_CONFIRMATION_REQUIRED');
  assert.ok(result.cost_estimate);
  assert.equal(result.seeds.length, 1);
});

// ── 第 5 组：批量生成循环 ──────────────────────────────────────

test('runCatalogBatch 混合：失败 seed 跳过继续，其余自动 apply（stub 生命周期）', async () => {
  const appliedCalls = [];
  const seeds = [
    { detail_kind: 'tool', name: 'Good Tool', vendor_name: 'Good', official_url: 'https://good.example.com' },
    { detail_kind: 'tool', name: 'Bad Tool', vendor_name: 'Bad', official_url: 'https://bad.example.com' },
  ];
  const report = await runCatalogBatch(seeds, {
    generatorOptions: GEN_OPTIONS,
    prepareCatalogDraft: async seed => (seed.name.startsWith('Good')
      ? { ok: true, draft_id: 'draft-good', draft: { readiness: { status: 'ready' } } }
      : { ok: false, code: 'PREPARE_FAILED', error: '合成失败', draft_id: 'draft-bad' }),
    reviewCatalogDraft: () => ({ ok: true, previewHash: 'hash', currentRevision: 'rev-1' }),
    applyCatalogDraft: args => { appliedCalls.push(args); return { ok: true, targetRevision: 'rev-2' }; },
  });
  assert.equal(report.applied.length, 1);
  assert.equal(report.applied[0].name, 'Good Tool');
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].name, 'Bad Tool');
  assert.equal(report.failed[0].draft_id, 'draft-bad');
  assert.equal(appliedCalls.length, 1);
  assert.deepEqual(appliedCalls[0], { draftId: 'draft-good', previewHash: 'hash', expectedRevision: 'rev-1' });
  assert.equal(report.per_tool.length, 2);
  assert.deepEqual(report.per_tool.map(item => item.status), ['applied', 'failed']);
});

test('runCatalogBatch readiness 未 ready（无 blocking_reasons）→ failed 记录', async () => {
  const report = await runCatalogBatch([{ detail_kind: 'tool', name: 'X', vendor_name: 'X', official_url: 'https://x.example.com' }], {
    generatorOptions: GEN_OPTIONS,
    prepareCatalogDraft: async () => ({ ok: true, draft_id: 'draft-x', draft: { readiness: { status: 'blocked', blocking_reasons: [] } } }),
    reviewCatalogDraft: () => ({ ok: true, previewHash: 'h', currentRevision: 'r' }),
    applyCatalogDraft: () => ({ ok: true, targetRevision: 'r2' }),
  });
  assert.equal(report.applied.length, 0);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].reason, 'READINESS_BLOCKED');
});

// ── 第 6 组：人工登记表维护（url-registry 子命令底层）────────

test('official-url-registry add/lookup/remove（内存注入，不落盘）', () => {
  const store = { schema_version: 1, entries: {} };
  const added = addUrlRegistryEntry(
    { name: '可灵', vendor_name: '快手可灵', official_url: 'https://klingai.com', aliases: ['Kling', 'kling-ai'] },
    { registry: store },
  );
  assert.equal(added.ok, true);
  assert.deepEqual(added.entry.official_urls, ['https://klingai.com/']);

  const byTool = lookupOfficialUrl('可灵', { registry: store });
  assert.equal(byTool.ok, true);
  assert.equal(byTool.vendor_name, '快手可灵');
  const byAlias = lookupOfficialUrl('Kling', { registry: store });
  assert.equal(byAlias.ok, true);
  assert.equal(byAlias.official_url, 'https://klingai.com/');

  const removed = removeUrlRegistryEntry('可灵', { registry: store });
  assert.equal(removed.ok, true);
  assert.equal(removed.count, 0);
  assert.equal(lookupOfficialUrl('Kling', { registry: store }).ok, false);
});

test('official-url-registry 厂商前缀匹配：变体模型名命中厂商（无视大小写），add 支持 model_prefixes', () => {
  const store = { schema_version: 1, entries: {} };
  addUrlRegistryEntry(
    { name: 'openai', vendor_name: 'OpenAI', official_url: 'https://platform.openai.com/docs', model_prefixes: ['gpt', 'o1', 'o3'] },
    { registry: store },
  );
  addUrlRegistryEntry(
    { name: 'anthropic', vendor_name: 'Anthropic', official_url: 'https://docs.anthropic.com', model_prefixes: ['claude'] },
    { registry: store },
  );
  addUrlRegistryEntry(
    { name: 'cohere', vendor_name: 'Cohere', official_url: 'https://docs.cohere.com', model_prefixes: ['command', 'embed', 'rerank'] },
    { registry: store },
  );

  // 变体/大小写/首尾空白均命中厂商前缀
  assert.equal(lookupOfficialUrl('GPT-5.5 Pro', { registry: store }).vendor_name, 'OpenAI');
  assert.equal(lookupOfficialUrl('gpt-5.5pro', { registry: store }).vendor_name, 'OpenAI');
  assert.equal(lookupOfficialUrl('  Gpt-image-2 ', { registry: store }).vendor_name, 'OpenAI');
  assert.equal(lookupOfficialUrl('Claude Opus 5', { registry: store }).vendor_name, 'Anthropic');
  assert.equal(lookupOfficialUrl('COMMAND A+', { registry: store }).vendor_name, 'Cohere');

  // 前缀未覆盖 → miss
  assert.equal(lookupOfficialUrl('LLaMA 4', { registry: store }).ok, false);
  assert.equal(lookupOfficialUrl('', { registry: store }).ok, false);

  // 防御：空前缀不误命中所有名字
  const emptyPrefix = { schema_version: 1, entries: { x: { vendor_name: 'X', official_url: 'https://x.example.com', model_prefixes: [''] } } };
  assert.equal(lookupOfficialUrl('anything', { registry: emptyPrefix }).ok, false);
});

test('official-url-registry 多官方 URL：official_urls 数组全作 official_hint 进 seed', async () => {
  const store = { schema_version: 1, entries: {} };
  addUrlRegistryEntry(
    { name: 'kuaishou', vendor_name: '可灵', official_urls: ['https://klingai.com/document-api', 'https://kling.ai'], model_prefixes: ['kling'] },
    { registry: store },
  );

  // lookup 返回主 URL + 全部 URL
  const hit = lookupOfficialUrl('Kling 3.0', { registry: store });
  assert.equal(hit.ok, true);
  assert.equal(hit.official_url, 'https://klingai.com/document-api');
  assert.deepEqual(hit.official_urls, ['https://klingai.com/document-api', 'https://kling.ai/']);

  // 批量解析命中登记表，两个官方 URL 都进 discovery_sources 作 official_hint
  const resolveFn = async () => { throw new Error('不应走到网络解析'); };
  const result = await resolveBatchCandidates(
    [{ name: 'Kling 3.0' }],
    { registry: store, resolveOfficialSource: resolveFn },
  );
  assert.equal(result.seeds.length, 1);
  const seed = result.seeds[0];
  assert.equal(seed.official_url, 'https://klingai.com/document-api');
  const hints = seed.discovery_sources.filter(source => source.kind === 'official_hint');
  assert.equal(hints.length, 2);
  assert.deepEqual(hints.map(h => h.url).sort(), ['https://kling.ai/', 'https://klingai.com/document-api'].sort());
});

test('official-url-registry 兼容 official_url 单数字段填数组（防手误）', () => {
  const store = { schema_version: 1, entries: {} };
  addUrlRegistryEntry(
    { name: 'anthropic', vendor_name: 'Anthropic', official_url: ['https://docs.anthropic.com', 'https://platform.claude.com/docs'], model_prefixes: ['claude'] },
    { registry: store },
  );
  const hit = lookupOfficialUrl('Claude Opus 5', { registry: store });
  assert.equal(hit.ok, true);
  assert.deepEqual(hit.official_urls, ['https://docs.anthropic.com/', 'https://platform.claude.com/docs']);
});
