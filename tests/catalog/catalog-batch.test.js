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
  resolveBatchPlacements,
} = require('../../src/catalog/catalog-batch');
const { resolveOfficialSource } = require('../../src/catalog/ai/catalog-adapters');
const {
  lookupOfficialUrl,
  addUrlRegistryEntry,
  addProductUrlRegistryEntry,
  removeUrlRegistryEntry,
  loadProductUrlRegistry,
  updateSourcesForProduct,
  validateProductUrlRegistry,
} = require('../../src/catalog/official-url-registry');
const { CATALOG_GENERATOR_FILES } = require('../../src/shared/paths');

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

test('resolveBatchCandidates 将 detail_kind_hint 传入双表 lookup', async () => {
  const registry = require('../../data/manual/archive/official-url-registry.json');
  const productRegistry = loadProductUrlRegistry();
  const result = await resolveBatchCandidates(
    [{ name: 'Claude Code 2.1', detail_kind_hint: 'tool' }],
    {
      registry,
      productRegistry,
      resolveOfficialSource: async () => { throw new Error('双表命中时不应联网'); },
    },
  );
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.seeds.length, 1);
  assert.equal(result.seeds[0].vendor_name, 'Anthropic');
  assert.equal(result.seeds[0].official_url, 'https://code.claude.com/docs/en/overview');
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

test('runBatchFromCards 无 confirmCost → COST_CONFIRMATION_REQUIRED，零付费零解析', async () => {
  let resolved = false;
  const result = await runBatchFromCards([{ name: 'New Tool Beta' }], {
    generatorOptions: GEN_OPTIONS,
    resolveOfficialSource: async () => { resolved = true; return { ok: true, vendor_name: 'Beta', official_url: 'https://beta.example.com' }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COST_CONFIRMATION_REQUIRED');
  assert.equal(resolved, false, '未确认成本时不得调用付费 vendor 解析');
  assert.ok(result.cost_estimate);
  assert.ok(result.cost_estimate.total);
  assert.ok(result.cost_estimate.resolution, '三本账含 resolution');
  assert.ok(result.cost_estimate.placement, '三本账含 placement');
  assert.ok(result.cost_estimate.research, '三本账含 research');
  assert.equal(result.seeds.length, 0, '未确认成本时 seeds 为空（零付费）');
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

test('official-url-registry 产品前缀优先于模型前缀，并按词边界与最长前缀匹配', () => {
  const store = { schema_version: 1, entries: {} };
  addUrlRegistryEntry(
    { name: 'anthropic', vendor_name: 'Anthropic', official_url: 'https://docs.anthropic.com', model_prefixes: ['claude'] },
    { registry: store },
  );
  addUrlRegistryEntry(
    { name: 'claude-code', vendor_name: 'Anthropic', official_url: 'https://code.claude.com/docs', aliases: ['Claude Code'], product_prefixes: ['claude code'] },
    { registry: store },
  );
  addUrlRegistryEntry(
    { name: 'cursor', vendor_name: 'Anysphere', official_url: 'https://cursor.com/docs', product_prefixes: ['cursor'], model_prefixes: [''] },
    { registry: store },
  );

  assert.equal(lookupOfficialUrl('Claude Code 2.1', { registry: store }).official_url, 'https://code.claude.com/docs');
  assert.equal(lookupOfficialUrl('Claude Opus 5', { registry: store }).official_url, 'https://docs.anthropic.com/');
  assert.equal(lookupOfficialUrl('Cursor Pro', { registry: store }).vendor_name, 'Anysphere');
  assert.equal(lookupOfficialUrl('Cursorless', { registry: store }).ok, false);
  assert.equal(lookupOfficialUrl('anything', { registry: store }).ok, false);
});

test('official-url-registry 产品条目支持正式目录工具和主流 Agent 名称', () => {
  const registry = require('../../data/manual/archive/official-url-registry.json');
  const productRegistry = loadProductUrlRegistry();
  const names = [
    ['Cursor', 'Anysphere'],
    ['GitHub Copilot', 'GitHub'],
    ['Claude Code', 'Anthropic'],
    ['Trae', '字节跳动（豆包）'],
    ['Midjourney', 'Midjourney Inc.'],
    ['Nano Banana', 'Google'],
    ['即梦', '字节跳动（豆包）'],
    ['Suno', 'Suno Inc.'],
    ['Stable Diffusion', 'Stability AI'],
    ['DALL·E 3', 'OpenAI'],
    ['Ideogram', 'Ideogram AI'],
    ['Windsurf', 'Windsurf'],
    ['OpenAI Codex', 'OpenAI'],
    ['Gemini CLI', 'Google'],
    ['Replit Agent', 'Replit'],
    ['Devin', 'Cognition'],
    ['Augment Code', 'Augment Code'],
    ['Amazon Q Developer', 'Amazon Web Services'],
    ['Junie', 'JetBrains'],
    ['Kiro', 'Amazon'],
    ['Cline', 'Cline'],
    ['Aider', 'Aider'],
    ['Continue', 'Continue'],
    ['Qoder', 'Qoder'],
    ['CodeBuddy', '腾讯云 CodeBuddy'],
  ];
  for (const [name, vendor] of names) {
    const hit = lookupOfficialUrl(name, { registry, productRegistry });
    assert.equal(hit.ok, true, `${name} 应命中登记表`);
    assert.equal(hit.vendor_name, vendor, `${name} 厂商不符`);
    assert.equal(hit.matched_entry_kind, 'product', `${name} 应命中产品表`);
    assert.match(hit.official_url, /^https:\/\//, `${name} 官方 URL 无效`);
  }
});

test('official-url-registry detailKind 决定产品与厂商模型的优先级', () => {
  const registry = require('../../data/manual/archive/official-url-registry.json');
  const productRegistry = loadProductUrlRegistry();
  const toolHit = lookupOfficialUrl('Claude Code 2.1', { registry, productRegistry, detailKind: 'tool' });
  assert.equal(toolHit.ok, true);
  assert.equal(toolHit.matched_entry_kind, 'product');
  assert.equal(toolHit.vendor_name, 'Anthropic');

  const modelHit = lookupOfficialUrl('Claude Opus 5', { registry, productRegistry, detailKind: 'api_model' });
  assert.equal(modelHit.ok, true);
  assert.equal(modelHit.matched_entry_kind, 'vendor');
  assert.equal(modelHit.matched_key, 'anthropic');

  const imageModelHit = lookupOfficialUrl('DALL·E 3', { registry, productRegistry, detailKind: 'api_model' });
  assert.equal(imageModelHit.ok, true);
  assert.equal(imageModelHit.matched_entry_kind, 'product');
  assert.equal(imageModelHit.matched_key, 'dall-e-3');

  assert.equal(lookupOfficialUrl('Cursorless', { registry, productRegistry, detailKind: 'tool' }).ok, false);
});

test('official-product-url-registry 双表契约：产品引用厂商、生命周期和官方 URL 校验', () => {
  const registry = loadProductUrlRegistry();
  const validation = validateProductUrlRegistry(registry);
  assert.equal(validation.ok, true, validation.errors.join(', '));
  assert.equal(validation.count, Object.keys(registry.products).length);
  assert.ok(registry.products['claude-code']);
  assert.equal(registry.products['claude-code'].vendor_key, 'anthropic');
  assert.equal(registry.products['dall-e-3'].lifecycle, 'deprecated');

  const invalid = {
    schema_version: 1,
    products: {
      broken: {
        vendor_key: 'missing-vendor',
        official_urls: ['http://not-https.example'],
        product_prefixes: ['agent'],
        lifecycle: 'unknown-state',
        last_verified_at: '2026-99-99',
      },
    },
  };
  const invalidResult = validateProductUrlRegistry(invalid);
  assert.equal(invalidResult.ok, false);
  assert.match(invalidResult.errors.join(','), /VENDOR_KEY_INVALID/);
  assert.match(invalidResult.errors.join(','), /OFFICIAL_URL_INVALID/);
  assert.match(invalidResult.errors.join(','), /PRODUCT_PREFIX_INVALID/);
  assert.match(invalidResult.errors.join(','), /LIFECYCLE_INVALID/);
  assert.match(invalidResult.errors.join(','), /LAST_VERIFIED_AT_INVALID/);
});

test('update_sources 可选契约：合法 GitHub Release/File 与厂商 changelog/release notes', () => {
  const vendorRegistry = {
    schema_version: 1,
    entries: {
      acme: { vendor_name: 'Acme', official_urls: ['https://acme.example/docs'] },
    },
  };
  const registry = {
    schema_version: 1,
    kind: 'official_product_url_registry',
    products: {
      'sample-tool': {
        name: 'Sample Tool',
        vendor_key: 'acme',
        official_urls: ['https://acme.example/docs'],
        product_prefixes: ['sample tool'],
        lifecycle: 'active',
        update_sources: [
          {
            kind: 'github_releases',
            url: 'https://github.com/acme/sample-tool/releases',
            collector: 'github_web_release',
            product_surface: 'cli',
            repository: 'acme/sample-tool',
            tag_prefix: 'v',
            include_prerelease: false,
            review_mode: 'deterministic',
          },
          {
            kind: 'github_file',
            url: 'https://github.com/acme/sample-tool/blob/main/CHANGELOG.md',
            collector: 'github_web_file',
            review_mode: 'deterministic',
            product_surface: 'cli',
            repository: 'acme/sample-tool',
          },
          {
            kind: 'changelog',
            url: 'https://acme.example/changelog',
            collector: 'tavily_extract',
            review_mode: 'ai_fallback',
            product_surface: 'product',
          },
          {
            kind: 'release_notes',
            url: 'https://acme.example/release-notes',
            collector: 'tavily_extract',
            review_mode: 'ai_fallback',
            product_surface: 'desktop',
          },
        ],
      },
    },
  };
  const validation = validateProductUrlRegistry(registry, { vendorRegistry });
  assert.equal(validation.ok, true, validation.errors.join(', '));
  assert.equal(validation.count, 1);
  const sources = updateSourcesForProduct('sample-tool', { registry });
  assert.equal(sources.length, 4);
  sources[0].url = 'https://mutated.example';
  assert.equal(registry.products['sample-tool'].update_sources[0].url, 'https://github.com/acme/sample-tool/releases');

  const addedStore = { schema_version: 1, kind: 'official_product_url_registry', products: {} };
  const added = addProductUrlRegistryEntry({
    name: 'Sample Tool',
    vendor_key: 'acme',
    official_url: 'https://acme.example/docs',
    lifecycle: 'active',
    update_sources: [registry.products['sample-tool'].update_sources[0]],
  }, { registry: addedStore, vendorRegistry });
  assert.equal(added.ok, true);
  assert.equal(added.product.update_sources[0].repository, 'acme/sample-tool');
});

test('update_sources 严格拒绝错误来源边界、组合、重复和未知字段', () => {
  const vendorRegistry = {
    schema_version: 1,
    entries: { acme: { vendor_name: 'Acme', official_urls: ['https://acme.example/docs'] } },
  };
  const baseProduct = {
    name: 'Sample Tool',
    vendor_key: 'acme',
    official_urls: ['https://acme.example/docs'],
    lifecycle: 'active',
  };
  const validate = update_sources => validateProductUrlRegistry({
    schema_version: 1,
    products: { sample: { ...baseProduct, update_sources } },
  }, { vendorRegistry });
  const release = {
    kind: 'github_releases',
    url: 'https://github.com/acme/sample-tool/releases',
    collector: 'github_web_release',
    product_surface: 'cli',
    repository: 'acme/sample-tool',
    include_prerelease: false,
            review_mode: 'deterministic',
  };

  assert.match(validate([{ ...release, repository: 'acme' }]).errors.join(','), /REPOSITORY_INVALID/);
  assert.match(validate([{ ...release, url: 'https://github.com/other/sample-tool/releases' }]).errors.join(','), /GITHUB_URL_REPOSITORY_MISMATCH/);
  assert.match(validate([{ ...release, url: 'https://github.com/acme/sample-tool/tags' }]).errors.join(','), /GITHUB_URL_REPOSITORY_MISMATCH/);
  assert.match(validate([{ ...release, url: 'http://github.com/acme/sample-tool/releases' }]).errors.join(','), /HTTPS_REQUIRED/);
  assert.match(validate([{ ...release, url: 'https://acme.example/pricing' }]).errors.join(','), /PRICING_URL_FORBIDDEN/);
  assert.match(validate([{ ...release, collector: 'tavily_extract' }]).errors.join(','), /COLLECTOR_KIND_MISMATCH/);
  assert.match(validate([{ ...release, unexpected: true }]).errors.join(','), /UNKNOWN_FIELD/);
  assert.match(validate([{ ...release }, { ...release }]).errors.join(','), /DUPLICATE_URL/);
  assert.match(validate([{
    kind: 'github_file',
    url: 'https://github.com/acme/sample-tool/blob/main/CHANGELOG.md',
    collector: 'github_web_file',
            review_mode: 'deterministic',
    product_surface: 'cli',
    repository: 'acme/sample-tool',
    tag_prefix: 'v',
    include_prerelease: false,
            review_mode: 'deterministic',
  }]).errors.join(','), /TAG_PREFIX_FORBIDDEN/);
  assert.match(validate([{
    kind: 'changelog',
    url: 'https://github.com/acme/sample-tool/releases',
    collector: 'tavily_extract',
            review_mode: 'ai_fallback',
    product_surface: 'cli',
  }]).errors.join(','), /GITHUB_KIND_REQUIRED/);
  assert.equal(validate([{ ...release, date_mode: 'latest' }]).ok, true);
  assert.match(validate([{ ...release, date_mode: 'oldest' }]).errors.join(','), /DATE_MODE_INVALID/);
});

test('update_sources 不进入 lookupOfficialUrl 或 catalog batch 的 official_hint', async () => {
  const registry = {
    schema_version: 1,
    entries: {
      acme: { vendor_name: 'Acme', official_urls: ['https://acme.example/docs'] },
    },
  };
  const productRegistry = {
    schema_version: 1,
    products: {
      sample: {
        name: 'Sample Tool',
        vendor_key: 'acme',
        official_urls: ['https://acme.example/docs'],
        product_prefixes: ['sample tool'],
        lifecycle: 'active',
        update_sources: [{
          kind: 'github_releases',
          url: 'https://github.com/acme/sample/releases',
          collector: 'github_web_release',
          product_surface: 'cli',
          repository: 'acme/sample',
          include_prerelease: false,
            review_mode: 'deterministic',
        }],
      },
    },
  };
  const hit = lookupOfficialUrl('Sample Tool', { registry, productRegistry, detailKind: 'tool' });
  assert.deepEqual(hit.official_urls, ['https://acme.example/docs']);
  const resolved = await resolveBatchCandidates([{ name: 'Sample Tool', detail_kind_hint: 'tool' }], {
    registry,
    productRegistry,
    resolveOfficialSource: async () => { throw new Error('update source 不应触发 batch 解析'); },
  });
  assert.equal(resolved.unresolved.length, 0);
  assert.deepEqual(resolved.seeds[0].discovery_sources.map(source => source.url), ['https://acme.example/docs']);
});

test('tool-update-review 路径登记并生成独立审核队列', () => {
  assert.match(CATALOG_GENERATOR_FILES.toolUpdateReview, /data[\\/]manual[\\/]tools[\\/]tool-update-review\.json$/);
  assert.equal(fs.existsSync(CATALOG_GENERATOR_FILES.toolUpdateReview), true);
  const queue = JSON.parse(fs.readFileSync(CATALOG_GENERATOR_FILES.toolUpdateReview, 'utf8'));
  assert.equal(queue.kind, 'tool_update_review');
  assert.ok(Array.isArray(queue.items));
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

// ── 第 7 组：待补卡输入门禁与单卡失败隔离（阶段 1）────────────

test('readPendingCards：缺 name / 非字符串 detail_kind_hint 拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-gate-'));
  const file = path.join(dir, 'pending.json');

  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, cards: [{ name: '' }] }));
  assert.throws(() => readPendingCards(file), /PENDING_CARD_NAME_REQUIRED/);

  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, cards: [{ name: 'X', detail_kind_hint: 5 }] }));
  assert.throws(() => readPendingCards(file), /PENDING_CARD_DETAIL_KIND_TYPE_INVALID/);

  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, cards: ['not-an-object'] }));
  assert.throws(() => readPendingCards(file), /PENDING_CARD_INVALID/);
});

test('resolveBatchCandidates 登记表命中但同时种转换抛错（非法 kind）→ 进入 unresolved，不中断整批', async () => {
  // 登记表命中给正规卡 vendor；但该卡带非法 detail_kind_hint，pendingCandidateToSeed 会抛错 -> 应收进 unresolved。
  const registry = { schema_version: 1, entries: { 'Bad Kind Model': { vendor_name: 'OpenAI', official_url: 'https://openai.com' } } };
  const result = await resolveBatchCandidates(
    [{ name: 'Bad Kind Model', detail_kind_hint: 'bogus_kind' }, { name: 'Good Tool', detail_kind_hint: 'tool' }],
    { registry, resolveOfficialSource: async () => ({ ok: true, vendor_name: 'Alpha', official_url: 'https://alpha.example.com' }) },
  );
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].name, 'Bad Kind Model');
  assert.match(result.unresolved[0].reason, /PENDING_DETAIL_KIND_INVALID/);
  assert.equal(result.seeds.length, 1);
  assert.equal(result.seeds[0].name, 'Good Tool');
});

// ── 第 8 组：批量 placement 集成（阶段 4）──────────────────────

test('runCatalogBatch：GLM 第 4 个成员 → migration_required 阻断，不进入 prepare', async () => {
  const seen = [];
  const report = await runCatalogBatch(
    [{ detail_kind: 'api_model', name: 'GLM-5.4', vendor_name: '智谱', vendor_key: 'zhipu' }],
    {
      generatorOptions: GEN_OPTIONS,
      prepareCatalogDraft: async seed => { seen.push(seed.name); return { ok: true, draft_id: 'draft-x', draft: { readiness: { status: 'ready' } } }; },
      reviewCatalogDraft: () => ({ ok: true }),
      applyCatalogDraft: () => ({ ok: true }),
    },
  );
  assert.equal(seen.length, 0, 'migration_required 不应进入 prepare');
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].name, 'GLM-5.4');
  assert.equal(report.failed[0].reason, 'PLACEMENT_MIGRATION_REQUIRED');
});

test('runCatalogBatch：政策覆盖通用 LLM → 确定性 decision 写入 seed 后再 prepare', async () => {
  const captured = [];
  const report = await runCatalogBatch(
    [{ detail_kind: 'api_model', name: 'Command B', vendor_name: 'Cohere', vendor_key: 'cohere' }],
    {
      generatorOptions: GEN_OPTIONS,
      prepareCatalogDraft: async seed => { captured.push(seed); return { ok: true, draft_id: 'draft-y', draft: { readiness: { status: 'ready' } } }; },
      reviewCatalogDraft: () => ({ ok: true }),
      applyCatalogDraft: () => ({ ok: true }),
    },
  );
  assert.equal(report.applied.length, 1, 'decision 应正常通过 prepare→review→apply');
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].placement.existing_level2_ref, { kind: 'vendor-level2', id: 'vendor-level2:cohere:command' });
  assert.equal(captured[0].placement.new_group_title, undefined, 'existing 目标不设 new_group_title');
});

test('runCatalogBatch：人工 placement 无效 → fail_closed，不进入 prepare', async () => {
  const seen = [];
  const report = await runCatalogBatch(
    [{ detail_kind: 'api_model', name: 'Something', vendor_name: 'Google', vendor_key: 'google', placement: { existing_level2_ref: { kind: 'vendor-level2', id: 'vendor-level2:openai:gpt-5.6' } } }],
    {
      generatorOptions: GEN_OPTIONS,
      prepareCatalogDraft: async seed => { seen.push(seed.name); return { ok: true, draft_id: 'draft-z', draft: { readiness: { status: 'ready' } } }; },
      reviewCatalogDraft: () => ({ ok: true }),
      applyCatalogDraft: () => ({ ok: true }),
    },
  );
  assert.equal(seen.length, 0);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].reason, /PLACEMENT_REF_INVALID/);
});

// ── 第 9 组：阶段 5 成本门禁与顺序状态 ─────────────────────────

test('runCatalogBatch：同厂商候选顺序投影，第 3 个 existing、第 4 个 migration_required', async () => {
  const snap = require('../../src/catalog/catalog-contract').emptySnapshot();
  snap['vendor-level2'].push({
    id: 'vendor-level2:zhipu:glm', vendor_key: 'zhipu', title: 'GLM 5', status: 'active',
    detail_refs: [{ kind: 'tool-level3', id: 'tool-level3:glm-5.1' }, { kind: 'tool-level3', id: 'tool-level3:glm-5.2' }],
  });
  const prepared = [];
  const report = await runCatalogBatch(
    [
      { detail_kind: 'api_model', name: 'GLM-5.3', vendor_key: 'zhipu', vendor_name: '智谱' },
      { detail_kind: 'api_model', name: 'GLM-5.4', vendor_key: 'zhipu', vendor_name: '智谱' },
    ],
    {
      generatorOptions: GEN_OPTIONS,
      snapshotOf: () => snap,
      prepareCatalogDraft: async seed => { prepared.push(seed); return { ok: true, draft_id: `draft-${seed.name}`, draft: { readiness: { status: 'ready' } } }; },
      reviewCatalogDraft: () => ({ ok: true }),
      applyCatalogDraft: () => ({ ok: true }),
    },
  );
  assert.equal(report.applied.length, 1);
  assert.equal(report.applied[0].name, 'GLM-5.3', '第 3 个成员应正常加入已有系列');
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].name, 'GLM-5.4', '第 4 个成员应触发拆分迁移');
  assert.equal(report.failed[0].reason, 'PLACEMENT_MIGRATION_REQUIRED');
  assert.deepEqual(prepared[0].placement.existing_level2_ref, { kind: 'vendor-level2', id: 'vendor-level2:zhipu:glm' });
});

test('resolveBatchPlacements：from-preview/resume 复用 placement_decision，不重复调用 AI', async () => {
  const snap = require('../../src/catalog/catalog-contract').emptySnapshot();
  snap['vendor-level2'].push({ id: 'vendor-level2:alibaba:qwen', vendor_key: 'alibaba', title: 'Qwen 模型', detail_refs: [] });
  const ledger = { reserve: () => ({ ok: true }) };
  const seed = { detail_kind: 'api_model', name: 'X-Futuristic-Model-3000', vendor_key: 'alibaba', vendor_name: '阿里' };
  const mockSuggest = async () => ({
    ok: true, hint: { usage_kind: 'general_llm', canonical_family: 'qwen', release_cohort: 'newest', confidence: 0.8 }, usage: {}, raw: {},
  });
  await resolveBatchPlacements([seed], {
    allowAiPlacement: true, snapshotOf: () => snap, placementLedger: ledger, suggestSeriesPlacement: mockSuggest,
  });
  assert.equal(seed.placement.existing_level2_ref?.id, 'vendor-level2:alibaba:qwen');
  assert.equal(seed.placement_decision.target_level2_id, 'vendor-level2:alibaba:qwen');
  assert.equal(seed.placement_decision.source, 'ai');

  let aiCalls = 0;
  await resolveBatchPlacements([seed], {
    allowAiPlacement: true, snapshotOf: () => snap, placementLedger: ledger,
    suggestSeriesPlacement: async () => { aiCalls += 1; throw new Error('resume 不应重复调用 AI'); },
  });
  assert.equal(aiCalls, 0, '已持久化 decision 的 seed 应短路，不重复调 AI');
});

test('runBatchFromCards --dry-run：写 placement_decision 进 preview，from-preview 复用', async () => {
  const previewFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pp-')), 'preview.json');
  const snap = require('../../src/catalog/catalog-contract').emptySnapshot();
  snap['vendor-level2'].push({ id: 'vendor-level2:alibaba:qwen', vendor_key: 'alibaba', title: 'Qwen 模型', detail_refs: [] });
  const resolveFn = async () => ({ ok: true, vendor_name: '阿里', official_url: 'https://help.aliyun.com' });
  const mockSuggest = async () => ({
    ok: true, hint: { usage_kind: 'general_llm', canonical_family: 'qwen', release_cohort: 'newest', confidence: 0.8 }, usage: {}, raw: {},
  });
  const dry = await runBatchFromCards(
    [{ name: 'X-Futuristic-Model-3000', vendor_name: '阿里', vendor_key: 'alibaba', detail_kind_hint: 'api_model' }],
    {
      dryRun: true, previewFile, generatorOptions: GEN_OPTIONS, snapshotOf: () => snap,
      tools: [], drafts: [], // 隔离真实目录/草稿状态（查重仅针对本批）
      resolveOfficialSource: resolveFn, allowAiPlacement: true, placementLedger: { reserve: () => ({ ok: true }) },
      suggestSeriesPlacement: mockSuggest,
    },
  );
  assert.equal(dry.ok, true);
  assert.ok(dry.preview_file);
  const preview = JSON.parse(fs.readFileSync(previewFile, 'utf8'));
  assert.equal(preview.seeds[0].placement.existing_level2_ref?.id, 'vendor-level2:alibaba:qwen');
  assert.ok(preview.seeds[0].placement_decision, 'preview seed 应持久化 placement_decision');

  let aiCalls = 0;
  const rerun = await runBatchFromCards(
    [{ name: 'X-Futuristic-Model-3000', vendor_name: '阿里', vendor_key: 'alibaba', detail_kind_hint: 'api_model' }],
    {
      fromPreview: true, confirmCost: true, previewFile, generatorOptions: GEN_OPTIONS, snapshotOf: () => snap,
      tools: [], drafts: [],
      prepareCatalogDraft: async seed => ({ ok: true, draft_id: 'draft-reuse', draft: { readiness: { status: 'ready' } } }),
      reviewCatalogDraft: () => ({ ok: true }),
      applyCatalogDraft: () => ({ ok: true }),
      suggestSeriesPlacement: async () => { aiCalls += 1; throw new Error('from-preview 不应重复调 AI'); },
    },
  );
  assert.equal(rerun.ok, true);
  assert.equal(aiCalls, 0);
  assert.equal(rerun.seeds[0].placement.existing_level2_ref?.id, 'vendor-level2:alibaba:qwen');
});

test('runBatchFromCards from-preview 无 confirmCost → COST_CONFIRMATION_REQUIRED，零生成', async () => {
  const previewFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-fp-')), 'preview.json');
  fs.writeFileSync(previewFile, JSON.stringify({ schema_version: 1, seeds: [{ detail_kind: 'tool', name: 'Foo' }], unresolved: [] }));
  const result = await runBatchFromCards([{ name: 'Foo' }], {
    fromPreview: true, previewFile, generatorOptions: GEN_OPTIONS,
    prepareCatalogDraft: async () => { throw new Error('不应执行生成'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COST_CONFIRMATION_REQUIRED');
});
