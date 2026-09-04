'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  vibeHubSlugOf,
  extractVibeHubText,
  fetchVibeHubDefinition,
  refreshStaleVibeHubCache,
} = require('../../src/catalog/concept/index');

function response(body, ok = true, status = 200) {
  return { ok, status, text: async () => body };
}

/** 真实 vibe-hub 概念页结构的缩略样例（chat-ui）。 */
function sampleHtml() {
  return [
    '<!DOCTYPE html><html><head>',
    '<title>聊天界面（Chat UI）是什么｜前端术语图解 · VibeHub</title>',
    '<meta name="description" content="聊天界面是组织消息列表、输入区和对话反馈状态的交互界面。…"/>',
    '<script id="vibehub-page-jsonld" type="application/ld+json">',
    JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [{
        '@type': 'DefinedTerm',
        '@id': 'https://vibe-hub.org/chat-ui#term',
        name: '聊天界面 Chat UI',
        alternateName: ['聊天界面', 'Chat UI', '聊天 UI'],
        description: '聊天界面是组织消息列表、输入区和对话反馈状态的交互界面。…',
        termCode: 'chat-ui',
      }],
    }),
    '</script></head><body>',
    '<div class="prerequisite-links"><span class="prerequisite-label">先知道</span>',
    '<a class="c-ref c-link" href="/input" data-ref="input">输入框 <b>Input</b></a>',
    '<a class="c-ref c-link" href="/streaming-response" data-ref="streaming-response">流式响应 <b>Streaming Response</b></a></div>',
    '<div class="alias-row" aria-label="也常被叫作"><span>也常被叫作</span><em>聊天 UI</em><em>聊天窗口</em><em>Chat Interface</em></div>',
    '<a target="_blank" rel="noopener noreferrer" href="https://www.w3.org/TR/WCAG22/"><span class="reference-title">Web Content Accessibility Guidelines (WCAG) 2.2</span><span class="reference-source">W3C ↗</span></a>',
    '<p>聊天界面是组织消息列表、输入区和对话反馈状态的交互界面。</p>',
    '</body></html>',
  ].join('\n');
}

function cachelessOptions(overrides = {}) {
  return {
    readCache: () => null,
    writeCache: () => {},
    ...overrides,
  };
}

// ── 第 1 组：term → slug ───────────────────────────────────────

test('vibeHubSlugOf 英文转 kebab；含中文/空返回 null', () => {
  assert.equal(vibeHubSlugOf('Chat UI'), 'chat-ui');
  assert.equal(vibeHubSlugOf('  Context   Window  '), 'context-window');
  assert.equal(vibeHubSlugOf('RAG'), 'rag');
  assert.equal(vibeHubSlugOf('上下文窗口'), null);
  assert.equal(vibeHubSlugOf(''), null);
  assert.equal(vibeHubSlugOf(null), null);
});

// ── 第 2 组：HTML 提取 ─────────────────────────────────────────

test('extractVibeHubText 从 JSON-LD + 正文提取标题/别名/定义/相关概念/来源', () => {
  const result = extractVibeHubText(sampleHtml());
  assert.ok(result);
  assert.equal(result.title, '聊天界面 Chat UI');
  assert.equal(result.definition, '聊天界面是组织消息列表、输入区和对话反馈状态的交互界面。');
  assert.ok(result.aliases.includes('聊天 UI'));
  assert.ok(result.aliases.includes('Chat Interface'));
  assert.deepEqual(result.related_terms, ['输入框 Input', '流式响应 Streaming Response']);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].name, 'Web Content Accessibility Guidelines (WCAG) 2.2');
  assert.equal(result.sources[0].url, 'https://www.w3.org/TR/WCAG22/');
  assert.ok(result.text.includes('聊天界面是组织消息列表'));
});

test('extractVibeHubText 无 JSON-LD 时回退 <title> 与正文别名', () => {
  const html = sampleHtml().replace(/<script id="vibehub-page-jsonld"[^]*?<\/script>/, '');
  const result = extractVibeHubText(html);
  assert.ok(result);
  assert.equal(result.title, '聊天界面（Chat UI）是什么');
  assert.ok(result.aliases.includes('聊天窗口'));
});

test('extractVibeHubText 空/无用输入返回 null', () => {
  assert.equal(extractVibeHubText(''), null);
  assert.equal(extractVibeHubText('<html></html>'), null);
});

// ── 第 3 组：fetchVibeHubDefinition（缓存优先 + 失败静默） ─────

test('fetchVibeHubDefinition 命中新鲜缓存零网络', async () => {
  let fetches = 0;
  const nowMs = 1_000_000;
  const cached = {
    fetched_at: new Date(nowMs - 60_000).toISOString(), // 1 分钟内，未过 3 天 TTL
    slug: 'chat-ui',
    title: '聊天界面 Chat UI',
    aliases: ['聊天 UI'],
    definition: '缓存定义',
    related_terms: [],
    sources: [],
    text: '缓存正文',
  };
  const result = await fetchVibeHubDefinition('chat-ui', {
    now: () => nowMs,
    readCache: slug => (slug === 'chat-ui' ? cached : null),
    fetchImpl: async () => { fetches += 1; return response(sampleHtml()); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.from_cache, true);
  assert.equal(result.title, '聊天界面 Chat UI');
  assert.equal(fetches, 0, '命中缓存不应发请求');
});

test('fetchVibeHubDefinition 缓存未命中 → GET → 提取 → 写缓存', async () => {
  let fetches = 0;
  const written = [];
  const result = await fetchVibeHubDefinition('chat-ui', cachelessOptions({
    now: () => 1_000_000,
    fetchImpl: async () => { fetches += 1; return response(sampleHtml()); },
    writeCache: (slug, entry) => written.push({ slug, entry }),
  }));
  assert.equal(result.ok, true);
  assert.equal(result.from_cache, false);
  assert.equal(fetches, 1);
  assert.equal(written.length, 1);
  assert.equal(written[0].slug, 'chat-ui');
  assert.ok(written[0].entry.fetched_at);
  assert.equal(written[0].entry.ttl_ms, 3 * 24 * 60 * 60 * 1000);
  assert.equal(result.related_terms.length, 2);
});

test('fetchVibeHubDefinition 缓存过期 → 重新抓取', async () => {
  const nowMs = 1_000_000;
  const stale = {
    fetched_at: new Date(nowMs - 4 * 24 * 60 * 60 * 1000).toISOString(), // 4 天前 > 3 天 TTL
    slug: 'chat-ui',
    title: '旧定义',
    definition: '旧',
  };
  let fetches = 0;
  const result = await fetchVibeHubDefinition('chat-ui', {
    now: () => nowMs,
    readCache: slug => stale,
    writeCache: () => {}, // 测试隔离：禁止写真实缓存文件
    fetchImpl: async () => { fetches += 1; return response(sampleHtml()); },
  });
  assert.equal(fetches, 1);
  assert.equal(result.from_cache, false);
  assert.equal(result.title, '聊天界面 Chat UI');
});

test('fetchVibeHubDefinition 404 / 网络错误返回 null（静默跳过）', async () => {
  const notFound = await fetchVibeHubDefinition('missing-page', {
    ...cachelessOptions(),
    fetchImpl: async () => response('', false, 404),
  });
  assert.equal(notFound, null);
  const network = await fetchVibeHubDefinition('boom', {
    ...cachelessOptions(),
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(network, null);
});

test('fetchVibeHubDefinition 串行请求 ≥500ms 节流', async () => {
  const sleeps = [];
  const state = { lastAtMs: 0 };
  const base = {
    now: () => 1_000_000,
    sleep: async ms => { sleeps.push(ms); },
    throttleState: state,
    fetchImpl: async () => response(sampleHtml()),
  };
  await fetchVibeHubDefinition('chat-ui', { ...cachelessOptions(), ...base });
  await fetchVibeHubDefinition('input', { ...cachelessOptions(), ...base });
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 500 && sleeps[0] <= 510, `第二次请求应等待约 500ms，实际 ${sleeps[0]}`);
});

// ── 第 4 组：refreshStaleVibeHubCache ──────────────────────────

test('refreshStaleVibeHubCache 只刷新过期条目，全新鲜零网络', async () => {
  const nowMs = 1_000_000;
  let fetches = 0;
  const cache = {
    schema_version: 1,
    kind: 'vibe_hub_cache',
    updated_at: null,
    entries: {
      'chat-ui': { fetched_at: new Date(nowMs - 4 * 24 * 60 * 60 * 1000).toISOString(), slug: 'chat-ui' }, // 过期
      'input': { fetched_at: new Date(nowMs - 60_000).toISOString(), slug: 'input' }, // 新鲜
    },
  };
  const report = await refreshStaleVibeHubCache(cache, {
    now: () => nowMs,
    fetchImpl: async () => { fetches += 1; return response(sampleHtml()); },
  });
  assert.deepEqual(report.refreshed, ['chat-ui']);
  assert.equal(report.up_to_date, 1);
  assert.equal(report.failed.length, 0);
  assert.equal(fetches, 1, '只刷新过期的 1 条');
  assert.ok(cache.entries['chat-ui'].definition, '过期条目已更新');
  assert.equal(cache.entries['chat-ui'].fetched_at, new Date(nowMs).toISOString());
});

test('refreshStaleVibeHubCache 抓取失败计入 failed 且不更新条目', async () => {
  const nowMs = 1_000_000;
  const cache = {
    schema_version: 1,
    kind: 'vibe_hub_cache',
    updated_at: null,
    entries: { 'chat-ui': { fetched_at: new Date(nowMs - 4 * 24 * 60 * 60 * 1000).toISOString(), slug: 'chat-ui' } },
  };
  const report = await refreshStaleVibeHubCache(cache, {
    now: () => nowMs,
    fetchImpl: async () => response('', false, 404),
  });
  assert.equal(report.refreshed.length, 0);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].slug, 'chat-ui');
  assert.match(report.failed[0].reason, /404/);
  assert.equal(cache.entries['chat-ui'].fetched_at, new Date(nowMs - 4 * 24 * 60 * 60 * 1000).toISOString(), '失败不更新条目');
});
