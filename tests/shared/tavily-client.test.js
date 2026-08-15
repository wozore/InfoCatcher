'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalizeUrl,
  searchTavily,
  extractTavily,
} = require('../../src/shared/tavily-client');

function response(data, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

/** 全新 keyless 状态（隔离跨测试污染：冷却时间戳 / 计数 / 最小间隔）。 */
function freshState() {
  return {
    lastAtMs: 0,
    cooldownUntilMs: 0,
    stats: {
      keylessCalls: 0,
      keyedCalls: 0,
      keylessCapHits: 0,
      keylessFallbacks: 0,
      cooldownTriggers: 0,
    },
  };
}

/** 钉住时钟 + no-op sleep，避免测试真实等待。接受 keylessState（或别名 state）。 */
function isolated(options = {}) {
  return {
    keylessState: options.keylessState || options.state || freshState(),
    keylessNow: options.keylessNow || (() => 1000000),
    keylessSleep: options.keylessSleep || (async () => {}),
    ...options,
  };
}

test('canonicalizeUrl removes markdown and CJK trailing punctuation before parsing', () => {
  assert.equal(
    canonicalizeUrl('https://kling.ai/document-api/apiReference/model/imageToVideo`）'),
    'https://kling.ai/document-api/apiReference/model/imageToVideo',
  );
  assert.equal(canonicalizeUrl('https://example.com/page。'), 'https://example.com/page');
  assert.equal(canonicalizeUrl('not a url'), '');
});

test('searchTavily sends keyless header and normalizes sources', async () => {
  let request;
  const result = await searchTavily(isolated({
    query: 'Kling 2.6 official API',
    includeDomains: ['kling.ai'],
    fetchImpl: async (url, init) => {
      request = { url, init: JSON.parse(init.body), headers: init.headers };
      return response({ results: [
        { url: 'https://kling.ai/docs`）', title: 'Docs', content: 'Official excerpt', score: 0.9 },
        { url: 'https://kling.ai/docs`）', title: 'Duplicate', content: 'Duplicate' },
        { url: 'https://third-party.example/kling', title: 'Third party', content: 'Ignore locally' },
      ] });
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://api.tavily.com/search');
  // 铁律 1：keyless 只带 X-Tavily-Access-Mode，绝无 Authorization。
  assert.equal(request.headers['X-Tavily-Access-Mode'], 'keyless');
  assert.equal(request.headers.Authorization, undefined);
  assert.deepEqual(request.init.include_domains, ['kling.ai']);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].url, 'https://kling.ai/docs');
  assert.equal(result.sources[1].url, 'https://third-party.example/kling');
});

test('extractTavily returns cleaned markdown, preserves failed URLs, keyless header only', async () => {
  let request;
  const result = await extractTavily(isolated({
    urls: ['https://kling.ai/docs`）', 'https://kling.ai/pricing'],
    query: 'API access and pricing',
    fetchImpl: async (url, init) => {
      request = { url, init: JSON.parse(init.body), headers: init.headers };
      return response({
        results: [{ url: 'https://kling.ai/docs', raw_content: '# Official docs\nAPI available.' }],
        failed_results: [{ url: 'https://kling.ai/pricing', error: 'blocked' }],
      });
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://api.tavily.com/extract');
  assert.equal(request.headers['X-Tavily-Access-Mode'], 'keyless');
  assert.equal(request.headers.Authorization, undefined);
  assert.deepEqual(request.init.urls, ['https://kling.ai/docs', 'https://kling.ai/pricing']);
  assert.equal(result.contents[0].content, '# Official docs\nAPI available.');
  assert.deepEqual(result.failed, [{ url: 'https://kling.ai/pricing', error: 'blocked' }]);
});

test('search without a key works via keyless', async () => {
  let captured;
  const result = await searchTavily(isolated({
    query: 'test',
    fetchImpl: async (url, init) => {
      captured = init.headers;
      return response({ results: [] });
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(captured['X-Tavily-Access-Mode'], 'keyless');
  assert.equal(captured.Authorization, undefined);
});

test('search with accessMode keyed fails closed without a key', async () => {
  const result = await searchTavily({ query: 'test', accessMode: 'keyed' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TAVILY_SEARCH_AUTH_REQUIRED');
});

test('accessMode keyed sends only Bearer header', async () => {
  let request;
  const result = await searchTavily(isolated({
    query: 'test',
    apiKey: 'test-key',
    accessMode: 'keyed',
    fetchImpl: async (url, init) => {
      request = { url, headers: init.headers, init: JSON.parse(init.body) };
      return response({ results: [] });
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(request.headers.Authorization, 'Bearer test-key');
  assert.equal(request.headers['X-Tavily-Access-Mode'], undefined); // 铁律 1
});

test('keyless cap 429 auto-falls back to keyed and succeeds', async () => {
  const calls = [];
  const state = freshState();
  const result = await searchTavily(isolated({
    state,
    query: 'test',
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      calls.push(init.headers);
      if (calls.length === 1) {
        return { ok: false, status: 429, json: async () => ({ error: { code: 'hourly_cap_reached', message: 'You reached the hourly keyless Tavily limit.' } }), text: async () => 'cap' };
      }
      return response({ results: [{ url: 'https://example.com', title: 't', content: 'c' }] });
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2); // keyless 一次 + keyed 回退一次
  assert.equal(calls[0]['X-Tavily-Access-Mode'], 'keyless');
  assert.equal(calls[0].Authorization, undefined);
  assert.equal(calls[1].Authorization, 'Bearer test-key');
  assert.equal(calls[1]['X-Tavily-Access-Mode'], undefined);
  assert.equal(state.stats.keylessCapHits, 1);
  assert.equal(state.stats.keylessFallbacks, 1);
  assert.equal(state.cooldownUntilMs, 1000000 + 90000);
});

test('cap 429 recognized even with single-use response body (real fetch semantics)', async () => {
  // 模拟真实 fetch Response：body 只能消费一次（text 先行消费会使 json 抛错）。
  // 修复前该用例失败（text 先行 → json 抛 → cap 漏判成普通限流）；修复后 429 分支优先 json。
  let used = false;
  const singleUse = {
    ok: false, status: 429,
    json: async () => { if (used) throw new Error('Body has already been consumed'); used = true; return { error: { code: 'hourly_cap_reached' } }; },
    text: async () => { if (used) throw new Error('Body has already been consumed'); used = true; return 'cap'; },
  };
  const calls = [];
  const state = freshState();
  const result = await searchTavily(isolated({
    state,
    query: 'test',
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      calls.push(init.headers);
      if (calls.length === 1) return singleUse;
      return response({ results: [{ url: 'https://example.com', title: 't', content: 'c' }] });
    },
  }));
  assert.equal(result.ok, true); // 回退 keyed 成功
  assert.equal(state.stats.keylessCapHits, 1);
  assert.equal(state.stats.keylessFallbacks, 1);
});

test('keyless cap without a key returns RATE_LIMITED with keyless_cap', async () => {
  const state = freshState();
  const result = await searchTavily(isolated({
    state,
    query: 'test',
    apiKey: '',
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 'hourly_cap_reached' } }), text: async () => 'cap' }),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TAVILY_SEARCH_RATE_LIMITED');
  assert.equal(result.keyless_cap, true);
  assert.equal(state.cooldownUntilMs, 1000000 + 90000);
});

test('during keyless cooldown immediately falls back to keyed without keyless calls', async () => {
  const state = freshState();
  state.cooldownUntilMs = 1005000; // 未来
  let keylessHits = 0;
  const result = await searchTavily(isolated({
    state,
    query: 'test',
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      if (init.headers['X-Tavily-Access-Mode']) keylessHits += 1;
      return response({ results: [] });
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(keylessHits, 0); // 冷却期间 keyless 请求一次未发
  assert.equal(state.stats.cooldownTriggers, 1);
});

test('during cooldown without key returns immediately with retry_after_ms', async () => {
  const state = freshState();
  state.cooldownUntilMs = 1005000;
  let calls = 0;
  const result = await searchTavily(isolated({
    state,
    query: 'test',
    apiKey: '',
    fetchImpl: async () => { calls += 1; return response({ results: [] }); },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TAVILY_SEARCH_RATE_LIMITED');
  assert.equal(result.retry_after_ms, 5000);
  assert.equal(calls, 0); // 完全不发请求
});

test('keyless calls are rate-limited to the minimum interval', async () => {
  const state = freshState();
  const sleeps = [];
  const base = {
    keylessState: state,
    keylessNow: () => 1000000,
    keylessSleep: async ms => { sleeps.push(ms); },
  };
  const first = await searchTavily({ ...base, query: 'one', fetchImpl: async () => response({ results: [] }) });
  const second = await searchTavily({ ...base, query: 'two', fetchImpl: async () => response({ results: [] }) });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(sleeps.length, 1); // 第二次触发约 1000ms 节流
  assert.ok(sleeps[0] >= 900 && sleeps[0] <= 1100);
});

test('non-cap 429 returns RATE_LIMITED without cooldown or fallback', async () => {
  const state = freshState();
  const result = await searchTavily(isolated({
    state,
    query: 'test',
    apiKey: 'test-key',
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 'other_limit' } }), text: async () => 'limited' }),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TAVILY_SEARCH_RATE_LIMITED');
  assert.equal(state.cooldownUntilMs, 0); // 非 cap 不设冷却
  assert.equal(state.stats.keylessCapHits, 0);
  assert.equal(state.stats.keylessFallbacks, 0);
});
