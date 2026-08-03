/**
 * news-rss.test.js — RSS 公开过滤复用测试（B16 决策 72）
 *
 * 测试原理：
 *   RSS 与热点视图/发布出口必须共用同一套公开过滤规则（决策 72），
 *   避免出现「热点视图有这条、RSS 却没有」或相反的口径漂移。
 *   本文件直接验证 generate-rss.js 的 getFeedItems 纯函数：
 *     1. 复用 filterPublicItems（近期时间窗口 + 公开字段完整）；
 *     2. 按发布时间倒序排列并截断到 limit；
 *     3. 缺省配置回退到默认 30 天窗口。
 *
 * 运行方式：node --test tests/news/news-rss.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getFeedItems } = require('../../src/content/generate-rss');

const NOW = Date.parse('2026-08-03T08:00:00Z');
const DAY = 86400000;
const itemAt = (publishedAt, overrides = {}) => ({ id: 'i', title: 'T', url: 'https://example.com/x', published_at: publishedAt, ...overrides });
const feed = items => ({ items });

// ── 第 1 组：与热点视图共用统一公开过滤（决策 72）──────────

test('getFeedItems 只保留近期窗口内且公开字段完整的条目', () => {
  const items = [
    itemAt(new Date(NOW - 1 * DAY).toISOString(), { id: 'fresh' }),
    itemAt(new Date(NOW - 40 * DAY).toISOString(), { id: 'old' }),
    itemAt(new Date(NOW + 12 * 3600 * 1000).toISOString(), { id: 'future' }),
    itemAt(new Date(NOW - 2 * DAY).toISOString(), { id: 'no-url', url: '' }),
  ];
  const passed = getFeedItems(feed(items), { now: NOW });
  assert.deepEqual(passed.map(item => item.id), ['fresh']);
});

test('getFeedItems 按发布时间倒序排列', () => {
  const items = [
    itemAt(new Date(NOW - 3 * DAY).toISOString(), { id: 'older' }),
    itemAt(new Date(NOW - 1 * DAY).toISOString(), { id: 'newer' }),
  ];
  const passed = getFeedItems(feed(items), { now: NOW });
  assert.deepEqual(passed.map(item => item.id), ['newer', 'older']);
});

// ── 第 2 组：条数截断 ─────────────────────────────────────

test('getFeedItems 默认截断到 30 条', () => {
  const items = Array.from({ length: 40 }, (_, index) =>
    itemAt(new Date(NOW - (index + 1) * DAY).toISOString(), { id: 'i' + index }));
  const passed = getFeedItems(feed(items), { now: NOW });
  assert.equal(passed.length, 30);
});

test('getFeedItems 支持自定义 limit', () => {
  const items = Array.from({ length: 10 }, (_, index) =>
    itemAt(new Date(NOW - (index + 1) * DAY).toISOString(), { id: 'i' + index }));
  const passed = getFeedItems(feed(items), { now: NOW, limit: 3 });
  assert.equal(passed.length, 3);
});

// ── 第 3 组：边界输入 ─────────────────────────────────────

test('getFeedItems 空输入返回空数组', () => {
  assert.deepEqual(getFeedItems(null, { now: NOW }), []);
  assert.deepEqual(getFeedItems({}, { now: NOW }), []);
  assert.deepEqual(getFeedItems({ items: [] }, { now: NOW }), []);
});

test('getFeedItems 缺省 now 使用当前时间（不抛错）', () => {
  const items = [itemAt(new Date().toISOString(), { id: 'just-now' })];
  const passed = getFeedItems(feed(items));
  assert.equal(passed.length, 1);
});
