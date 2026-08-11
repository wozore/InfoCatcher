/**
 * validate-news-config.test.js — 热点配置与 last-run credits 账本校验
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNewsConfig, validateLastRun } = require('../../src/maintenance/validate-news');

const VALID_CONFIG = {
  collection: {
    enabled: true,
    x_credits_per_run: 3750,
    x_credits_per_tweet: 15,
    x_credits_per_article: 100,
    x_tweets_per_request_max: 20,
  },
};

const VALID_LAST_RUN = {
  schema_version: 1,
  run_id: 'test-run',
  collected_at: '2026-08-12T02:00:00.000Z',
  platforms: ['x'],
  collectors: {
    youtube: { status: 'not_run', items: 0 },
    x: {
      status: 'partial',
      items: 5,
      credits: {
        used: 515,
        budget: 3750,
        tweets: 1,
        articles: 0,
        requests: { total: 4, tweet: 2, article: 2, retries: 2 },
      },
    },
  },
};

function collectErrors(validate, data) {
  const errors = [];
  const valid = validate(data, message => errors.push(message));
  return { valid, errors };
}

test('validateNewsConfig 接受安全的开关与 X 预算配置', () => {
  assert.deepEqual(collectErrors(validateNewsConfig, VALID_CONFIG), { valid: true, errors: [] });
});

test('validateNewsConfig 拒绝会削弱门禁或预算的配置', () => {
  const cases = [
    [{ ...VALID_CONFIG, collection: { ...VALID_CONFIG.collection, enabled: 'true' } }, 'enabled'],
    [{ ...VALID_CONFIG, collection: { ...VALID_CONFIG.collection, x_credits_per_run: -1 } }, 'x_credits_per_run'],
    [{ ...VALID_CONFIG, collection: { ...VALID_CONFIG.collection, x_credits_per_run: 3751 } }, 'x_credits_per_run'],
    [{ ...VALID_CONFIG, collection: { ...VALID_CONFIG.collection, x_credits_per_tweet: 14 } }, 'x_credits_per_tweet'],
    [{ ...VALID_CONFIG, collection: { ...VALID_CONFIG.collection, x_credits_per_article: 99 } }, 'x_credits_per_article'],
    [{ ...VALID_CONFIG, collection: { ...VALID_CONFIG.collection, x_tweets_per_request_max: 19 } }, 'x_tweets_per_request_max'],
  ];

  for (const [config, field] of cases) {
    const result = collectErrors(validateNewsConfig, config);
    assert.equal(result.valid, false, `${field} 非法时应失败`);
    assert.ok(result.errors.some(message => message.includes(field)));
  }
});

test('validateLastRun 接受完整且自洽的 X credits 账本', () => {
  assert.deepEqual(collectErrors(validateLastRun, VALID_LAST_RUN), { valid: true, errors: [] });
});

test('validateLastRun 拒绝超预算、负数和请求统计不自洽', () => {
  const cases = [
    [
      { ...VALID_LAST_RUN, collectors: { ...VALID_LAST_RUN.collectors, x: { ...VALID_LAST_RUN.collectors.x, credits: { ...VALID_LAST_RUN.collectors.x.credits, used: 4000 } } } },
      'used',
    ],
    [
      { ...VALID_LAST_RUN, collectors: { ...VALID_LAST_RUN.collectors, x: { ...VALID_LAST_RUN.collectors.x, credits: { ...VALID_LAST_RUN.collectors.x.credits, tweets: -1 } } } },
      'tweets',
    ],
    [
      { ...VALID_LAST_RUN, collectors: { ...VALID_LAST_RUN.collectors, x: { ...VALID_LAST_RUN.collectors.x, credits: { ...VALID_LAST_RUN.collectors.x.credits, requests: { total: 5, tweet: 2, article: 2, retries: 2 } } } } },
      'total',
    ],
    [
      { ...VALID_LAST_RUN, collectors: { ...VALID_LAST_RUN.collectors, x: { ...VALID_LAST_RUN.collectors.x, credits: { ...VALID_LAST_RUN.collectors.x.credits, requests: { total: 4, tweet: 2, article: 2, retries: 5 } } } } },
      'retries',
    ],
  ];

  for (const [lastRun, field] of cases) {
    const result = collectErrors(validateLastRun, lastRun);
    assert.equal(result.valid, false, `${field} 非法时应失败`);
    assert.ok(result.errors.some(message => message.includes(field)));
  }
});
