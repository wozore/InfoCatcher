/**
 * collector-x-v2.test.js — X 采集请求级 credits 硬预算回归测试
 *
 * 全部通过 fetchImpl 注入模拟 TwitterAPI.io，不发真实网络请求。
 * 运行：node --test tests/news/collector-x-v2.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectXV2 } = require('../../src/news/collectors/collector-x-v2');

const NOW = '2026-08-12T02:00:00.000Z';
const SINCE = '2026-08-12T00:00:00.000Z';
const UNTIL = '2026-08-12T03:00:00.000Z';

function configFor({ accounts = [], maxRetries = 0, collection: collectionOverrides = {} } = {}) {
  return {
    collection: {
      twitter_api_base_url: 'https://api.twitterapi.io',
      x_credits_per_run: 3750,
      x_credits_per_tweet: 15,
      x_credits_per_article: 100,
      x_tweets_per_request_max: 20,
      request_timeout_ms: 1000,
      max_retries: maxRetries,
      retry_base_ms: 0,
      ...collectionOverrides,
    },
    keywords: { ai_keywords: [] },
    x_accounts: accounts,
  };
}

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

function tweetsFor(account, count, { createdAt = '2026-08-12T01:00:00.000Z', article = false } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${account}-${index}`,
    text: article
      ? `AI article ${account}-${index} https://x.com/i/articles/${account}-${index}`
      : `AI update ${account}-${index}`,
    createdAt,
    author: { username: account, name: account },
  }));
}

test('窗外推文仍按全部返回条数计费，并在下一次请求前受 3750 硬预算阻断', async () => {
  const accounts = Array.from({ length: 30 }, (_, index) => `account-${index + 1}`);
  let fetchCount = 0;
  const fetchImpl = async url => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/twitter/user/last_tweets');
    fetchCount += 1;
    return response({
      tweets: tweetsFor(parsed.searchParams.get('userName'), 20, {
        createdAt: '2026-08-10T01:00:00.000Z',
      }),
    });
  };

  const result = await collectXV2({
    config: configFor({ accounts }),
    xApiKey: 'test-key',
    fetchImpl,
    now: NOW,
    sinceIso: SINCE,
    untilIso: UNTIL,
  });

  assert.equal(fetchCount, 12, '每次最多预占 300 credits，只允许发出 12 次请求');
  assert.equal(result.items.length, 0, '窗外推文不进入候选');
  assert.equal(result.credits.used, 3600);
  assert.equal(result.credits.budget, 3750);
  assert.equal(result.credits.tweets, 240, '平台返回的窗外推文仍属于计费条目');
  assert.deepEqual(result.credits.requests, { total: 12, tweet: 12, article: 0, retries: 0 });
});

test('空 article 响应也保留请求预占，不允许长文补读突破总预算', async () => {
  const accounts = Array.from({ length: 8 }, (_, index) => `article-account-${index + 1}`);
  let tweetRequests = 0;
  let articleRequests = 0;
  const fetchImpl = async url => {
    const parsed = new URL(url);
    if (parsed.pathname === '/twitter/user/last_tweets') {
      tweetRequests += 1;
      const account = parsed.searchParams.get('userName');
      return response({ tweets: tweetsFor(account, 20, { article: true }) });
    }
    if (parsed.pathname === '/twitter/article') {
      articleRequests += 1;
      return response({ article: null });
    }
    throw new Error(`unexpected endpoint: ${parsed.pathname}`);
  };

  const result = await collectXV2({
    config: configFor({ accounts }),
    xApiKey: 'test-key',
    fetchImpl,
    now: NOW,
    sinceIso: SINCE,
    untilIso: UNTIL,
  });

  assert.equal(tweetRequests, 8);
  assert.equal(articleRequests, 13, '2400 tweet credits 后只剩 13 次 article 预占空间');
  assert.equal(result.credits.used, 3700);
  assert.equal(result.credits.articles, 0, '空正文不算成功文章，但请求费用不能退回');
  assert.deepEqual(result.credits.requests, { total: 21, tweet: 8, article: 13, retries: 0 });
});

test('显式零预算时不发起任何请求', async () => {
  let fetchCount = 0;
  const result = await collectXV2({
    config: configFor({
      accounts: ['zero-budget'],
      collection: { x_credits_per_run: 0 },
    }),
    xApiKey: 'test-key',
    fetchImpl: async () => {
      fetchCount += 1;
      return response({ tweets: tweetsFor('zero-budget', 1) });
    },
    now: NOW,
    sinceIso: SINCE,
    untilIso: UNTIL,
  });

  assert.equal(fetchCount, 0);
  assert.equal(result.credits.budget, 0);
  assert.equal(result.credits.used, 0);
  assert.equal(result.coverage.reason, 'credits_exhausted');
});

test('高于硬上限的预算配置会被限制为 3750', async () => {
  const result = await collectXV2({
    config: configFor({
      accounts: [],
      collection: { x_credits_per_run: 10000 },
    }),
    xApiKey: 'test-key',
    fetchImpl: async () => { throw new Error('不应请求'); },
    now: NOW,
    sinceIso: SINCE,
    untilIso: UNTIL,
  });

  assert.equal(result.credits.budget, 3750);
  assert.equal(result.credits.used, 0);
});

test('过小的每请求条数配置不能削弱供应商安全预占', async () => {
  const result = await collectXV2({
    config: configFor({
      accounts: ['undersized-limit'],
      collection: { x_tweets_per_request_max: 1 },
    }),
    xApiKey: 'test-key',
    fetchImpl: async () => response({ tweets: tweetsFor('undersized-limit', 20) }),
    now: NOW,
    sinceIso: SINCE,
    untilIso: UNTIL,
  });

  assert.equal(result.credits.used, 300);
  assert.equal(result.credits.tweets, 20);
  assert.equal(result.credits.requests.total, 1);
});

test('超量 tweet 响应按完整条数结算并停止后续请求', async () => {
  let fetchCount = 0;
  const result = await collectXV2({
    config: configFor({ accounts: ['overflow-1', 'overflow-2'] }),
    xApiKey: 'test-key',
    fetchImpl: async url => {
      fetchCount += 1;
      const account = new URL(url).searchParams.get('userName');
      return response({ tweets: tweetsFor(account, 21, { article: true }) });
    },
    now: NOW,
    sinceIso: SINCE,
    untilIso: UNTIL,
  });

  assert.equal(fetchCount, 1);
  assert.equal(result.credits.used, 315);
  assert.equal(result.credits.tweets, 21);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.reason, 'tweet_response_exceeded_max');
});

test('collection.enabled=false 时直接调用采集器也保持零网络', async () => {
  let fetchCount = 0;
  const result = await collectXV2({
    config: configFor({
      accounts: ['disabled'],
      collection: { enabled: false },
    }),
    xApiKey: 'test-key',
    fetchImpl: async () => {
      fetchCount += 1;
      return response({ tweets: tweetsFor('disabled', 1) });
    },
    now: NOW,
    sinceIso: SINCE,
    untilIso: UNTIL,
  });

  assert.equal(fetchCount, 0);
  assert.equal(result.credits.used, 0);
  assert.equal(result.coverage.status, 'failed');
  assert.equal(result.coverage.reason, 'collection_disabled');
});

test('tweet 与 article 的每次重试都独立预占并记录', async () => {
  let tweetAttempts = 0;
  let articleAttempts = 0;
  const fetchImpl = async url => {
    const parsed = new URL(url);
    if (parsed.pathname === '/twitter/user/last_tweets') {
      tweetAttempts += 1;
      if (tweetAttempts === 1) return response('temporary tweet failure', { ok: false, status: 500 });
      return response({ tweets: tweetsFor('retry-account', 1, { article: true }) });
    }
    if (parsed.pathname === '/twitter/article') {
      articleAttempts += 1;
      if (articleAttempts === 1) return response('temporary article failure', { ok: false, status: 500 });
      return response({ article: null });
    }
    throw new Error(`unexpected endpoint: ${parsed.pathname}`);
  };

  const result = await collectXV2({
    config: configFor({ accounts: ['retry-account'], maxRetries: 1 }),
    xApiKey: 'test-key',
    fetchImpl,
    now: NOW,
    sinceIso: SINCE,
    untilIso: UNTIL,
  });

  assert.equal(tweetAttempts, 2);
  assert.equal(articleAttempts, 2);
  assert.equal(result.credits.used, 515, '失败 tweet 保守保留 300 + 成功 tweet 15 + 两次 article 各 100');
  assert.equal(result.credits.tweets, 1);
  assert.deepEqual(result.credits.requests, { total: 4, tweet: 2, article: 2, retries: 2 });
});
