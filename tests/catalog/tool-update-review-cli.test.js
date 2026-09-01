'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseArgs,
  main,
  runScan,
  runLocalize,
  localizeToolCandidate,
  runList,
  runApply,
} = require('../../scripts/tool-update-review');

function sampleRegistry(collector = 'tavily_extract', reviewMode = 'ai_fallback') {
  return {
    schema_version: 1,
    kind: 'official_product_url_registry',
    products: {
      sample: {
        name: 'Sample Tool',
        vendor_key: 'sample',
        official_urls: ['https://example.com/product'],
        update_sources: [{
          kind: 'changelog',
          url: 'https://example.com/changelog',
          collector,
          product_surface: 'product',
          review_mode: reviewMode,
        }],
        lifecycle: 'active',
      },
    },
  };
}

function sampleSnapshot() {
  return {
    snapshot: {
      'vendor-card': [],
      'tool-card': [],
      'vendor-level1': [],
      'vendor-level2': [],
      'tool-level3': [{
        id: 'tool-level3:sample',
        tool_key: 'sample',
        title: 'Sample Tool',
        detail_kind: 'tool',
        vendor_key: 'sample',
        last_updated_date: '2026-08-01',
      }],
    },
    revision: 'sha256:before',
  };
}

function scanDeps(overrides = {}) {
  const registry = overrides.registry || sampleRegistry();
  let applyCalled = false;
  return {
    loadRegistry: () => registry,
    validateRegistry: () => ({ ok: true, errors: [] }),
    loadSnapshot: sampleSnapshot,
    collectProductUpdateEvidence: async () => ({
      evidence: [{
        product_key: 'sample',
        detail_id: 'tool-level3:sample',
        source_type: 'changelog',
        collector: 'tavily_extract',
        url: 'https://example.com/changelog',
        title: 'Official changelog',
        official_published_at: '2026-08-11T12:00:00Z',
        excerpt: 'Published stable update on 2026-08-11.',
        content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        status: 'ready',
      }],
      failed: [],
    }),
    suggestReview: async () => ({
      ok: true,
      suggestion: {
        verdict: 'approve',
        matched_surface: 'product',
        confidence: 0.95,
        reason: '明确产品更新',
        supporting_excerpt: 'Published stable update on 2026-08-11.',
      },
    }),
    createLedger: () => ({
      snapshot: () => ({ spent: { responses_calls: 1 } }),
      reserve: () => ({ ok: true }),
    }),
    mergeQueue: (candidates) => ({ file: 'test', appended: candidates.length, refreshed: 0, reopened: 0, queue: { items: candidates } }),
    localizeToolCandidate: async candidate => {
      candidate.localizations = { zh: { title: '工具更新审核', description: '中文官方证据与审核理由。' } };
      candidate.localizations_meta = { zh: { localizer: 'llm_deepseek', generated_at: '2026-08-25', input_chars: 20, llm_error: null } };
      return candidate;
    },
    applyBatch: () => { applyCalled = true; return { ok: true }; },
    get applyCalled() { return applyCalled; },
    print: false,
    ...overrides,
  };
}

test('tool update CLI parses positional command and kebab-case flags', () => {
  assert.deepEqual(parseArgs(['scan', '--tavily-access-mode', 'keyless', '--confirm-cost', '--products', 'gemini-cli,qoder']), {
    positional: ['scan'],
    flags: { tavily_access_mode: 'keyless', confirm_cost: true, products: 'gemini-cli,qoder' },
  });
});

test('scan requires explicit Tavily access mode and never calls Apply', async () => {
  const deps = scanDeps();
  await assert.rejects(() => runScan({ products: 'sample' }, deps), /TAVILY_ACCESS_MODE_REQUIRED/);
  const result = await runScan({ products: 'sample', tavily_access_mode: 'keyless', as_of: '2026-08-25' }, deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.catalog_apply, false);
  assert.equal(deps.applyCalled, false);
});

test('deterministic scan 不调用 AI 且写入确定性 decision', async () => {
  let aiCalls = 0;
  const deps = scanDeps({
    registry: sampleRegistry('tavily_extract', 'deterministic'),
    suggestReview: async () => {
      aiCalls += 1;
      throw new Error('deterministic scan must not call AI');
    },
  });
  const result = await runScan({ products: 'sample', mode: 'deterministic', tavily_access_mode: 'keyless', as_of: '2026-08-25' }, deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(aiCalls, 0);
  assert.equal(result.deterministic_count, 1);
  assert.equal(result.needs_ai_count, 0);
  assert.equal(result.catalog_apply, false);
});

test('scan 通过本地模型汉化工具审核内容后写入候选', async () => {
  let localized = 0;
  const deps = scanDeps({
    localizeToolCandidate: async candidate => {
      localized += 1;
      candidate.localizations = { zh: { title: '示例工具更新审核', description: '中文证据摘要与审核理由。' } };
      candidate.localizations_meta = { zh: { localizer: 'llm_deepseek', generated_at: '2026-08-25', input_chars: 24, llm_error: null } };
      return candidate;
    },
    mergeQueue: candidates => ({ file: 'test', appended: candidates.length, refreshed: 0, reopened: 0, queue: { items: candidates } }),
  });
  const result = await runScan({ products: 'sample', tavily_access_mode: 'keyless', as_of: '2026-08-25' }, deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(localized, 1);
  assert.equal(result.queue.item_count, 1);
});

test('localizeToolCandidate 先走外部摘要再交给本地模型翻译', async () => {
  let localCalls = 0;
  let externalCalls = 0;
  const candidate = {
    product_name: 'Replit Agent',
    product_key: 'replit-agent',
    evidence: { title: 'Documentation Index', excerpt: 'A very long English official documentation index.' },
    ai_suggestion: { reason: '证据日期需要进一步核验' },
  };
  const result = await localizeToolCandidate(candidate, {
    externalSummary: true,
    confirmCost: true,
    ledger: { reserve: () => ({ ok: true }) },
    fetchImpl: async url => {
      localCalls += 1;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: localCalls === 1 ? 'bad output' : '{"title":"Replit Agent 更新审核","description":"中文摘要"}' } }] }) };
    },
    externalFetchImpl: async () => {
      externalCalls += 1;
      return { ok: true, status: 200, json: async () => ({ output_text: '{"summary":"Replit Agent 官方文档更新，日期证据仍需核验。"}' }) };
    },
    externalApiKey: 'test-key',
  });
  assert.equal(externalCalls, 1);
  assert.equal(localCalls, 2);
  assert.equal(result.localizations.zh.description, '中文摘要');
  assert.equal(result.localizations_meta.zh.fallback, 'external_summary');
});

test('DeepSeek scan requires explicit cost confirmation', async () => {
  const result = await main(['scan', '--products', 'sample', '--provider', 'deepseek', '--tavily-access-mode', 'keyless'], scanDeps());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_UPDATE_REVIEW_COST_CONFIRM_REQUIRED');
});

test('localize 仅汉化已有审核队列，不采集或 Apply', async () => {
  const queue = { items: [{ product_name: 'Sample Tool', product_key: 'sample', evidence: { title: 'Changelog', excerpt: 'Released a stable update.' }, ai_suggestion: null }] };
  let writes = 0;
  const result = await runLocalize({ as_of: '2026-08-25' }, {
    readQueue: () => queue,
    localizeToolCandidate: async item => {
      item.localizations = { zh: { title: '示例工具更新审核', description: '已发布稳定更新。' } };
      item.localizations_meta = { zh: { localizer: 'llm_deepseek', generated_at: '2026-08-25', input_chars: 12, llm_error: null } };
      return item;
    },
    writeQueue: value => { writes += 1; return { file: 'test', queue: value }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.localized, 1);
  assert.equal(result.catalog_apply, false);
  assert.equal(writes, 1);
});

test('localize 全部已有有效汉化时不产生无意义写回', async () => {
  const queue = {
    items: [{
      candidate_key: 'sample-current',
      product_name: 'Sample Tool',
      product_key: 'sample',
      localizations: { zh: { title: '示例工具', description: '这是中文更新摘要。' } },
    }],
  };
  let writes = 0;
  let localizerCalls = 0;
  const result = await runLocalize({}, {
    readQueue: () => queue,
    localizeToolCandidate: async item => {
      localizerCalls += 1;
      return item;
    },
    writeQueue: () => { writes += 1; return { file: 'test' }; },
  });
  assert.equal(result.skipped, 1);
  assert.equal(result.processed, 0);
  assert.equal(result.changed, false);
  assert.equal(result.cost.spent.responses_calls, 0);
  assert.equal(localizerCalls, 0);
  assert.equal(writes, 0);
});

test('localizeToolCandidate 使用本地链路并覆盖完整审核输入，保留原始字段', async () => {
  const candidate = {
    product_name: 'Replit Agent',
    product_key: 'replit-agent',
    evidence: { title: 'Documentation Index', excerpt: 'A stable update was released.' },
    ai_suggestion: {
      reason: 'The evidence describes a product update.',
      supporting_excerpt: 'A stable update was released.',
    },
  };
  const originalEvidence = JSON.parse(JSON.stringify(candidate.evidence));
  const originalSuggestion = JSON.parse(JSON.stringify(candidate.ai_suggestion));
  const authHeaders = [];
  const requestBodies = [];
  const result = await localizeToolCandidate(candidate, {
    externalSummary: false,
    fetchImpl: async (_url, options) => {
      authHeaders.push(options.headers.Authorization);
      requestBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"title":"Replit Agent 更新审核","description":"官方证据显示该工具发布了稳定更新，审核理由仍需人工核验。"}' } }] }),
      };
    },
  });
  assert.deepEqual(authHeaders, ['Bearer local']);
  const prompt = requestBodies[0].messages[1].content;
  assert.match(prompt, /AI 支持摘录：A stable update was released\./);
  assert.deepEqual(result.evidence, originalEvidence);
  assert.deepEqual(result.ai_suggestion, originalSuggestion);
  assert.equal(result.localizations.zh.title, 'Replit Agent 更新审核');
});

test('localizeToolCandidate 会重试旧失败并清除不合格旧汉化', async () => {
  const candidate = {
    product_name: 'Sample Tool',
    product_key: 'sample',
    evidence: { title: 'Changelog', excerpt: 'Released a stable update.' },
    localizations: { zh: { title: 'Sample Tool', description: 'Released a stable update.' } },
    localizations_meta: { zh: { llm_error: 'invalid_translation' } },
  };
  let calls = 0;
  const result = await localizeToolCandidate(candidate, {
    externalSummary: false,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: calls === 1
          ? '{"title":"Sample Tool 更新审核","description":"已发布稳定更新。"}'
          : '{"title":"Sample Tool","description":"Released a stable update."}' } }] }),
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.localizations.zh.description, '已发布稳定更新。');

  const invalid = await localizeToolCandidate({
    product_name: 'Sample Tool',
    product_key: 'sample',
    evidence: { title: 'Changelog', excerpt: 'Released a stable update.' },
    localizations: { zh: { title: '旧标题', description: 'Old English text.' } },
  }, {
    externalSummary: false,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"title":"Sample Tool","description":"Old English text."}' } }] }),
    }),
  });
  assert.equal(Object.hasOwn(invalid, 'localizations'), false);
  assert.equal(invalid.localizations_meta.zh.llm_error, 'LOCALIZATION_NOT_CHINESE');
});
test('list is read-only and filters review status', () => {
  let reads = 0;
  let writes = 0;
  const result = runList({ status: 'pending' }, {
    readQueue: () => {
      reads += 1;
      return { items: [{ candidate_key: 'a', product_key: 'sample', review_status: 'pending', status: 'candidate', blocked_reasons: [] }, { candidate_key: 'b', product_key: 'sample', review_status: 'approved', status: 'candidate', blocked_reasons: [] }] };
    },
    mergeQueue: () => { writes += 1; },
  });
  assert.equal(result.count, 1);
  assert.equal(reads, 1);
  assert.equal(writes, 0);
});

test('apply rejects missing revision, preview hash, and exact confirmation', async () => {
  const deps = scanDeps();
  assert.equal((await runApply({}, deps)).code, 'DATE_REPAIR_EXPECTED_REVISION_REQUIRED');
  assert.equal((await runApply({ expected_revision: 'sha256:before' }, deps)).code, 'DATE_REPAIR_PREVIEW_REQUIRED');
  assert.equal((await runApply({ expected_revision: 'sha256:before', preview_hash: 'sha256:preview', confirm: 'yes' }, deps)).code, 'TOOL_UPDATE_REVIEW_CONFIRMATION_REQUIRED');
  const applied = await runApply({ expected_revision: 'sha256:before', preview_hash: 'sha256:preview', confirm: 'APPLY TOOL-UPDATES sha256:preview' }, deps);
  assert.equal(applied.ok, true);
  assert.equal(deps.applyCalled, true);
});
