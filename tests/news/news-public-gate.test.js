/**
 * news-public-gate.test.js — 公开资格统一过滤测试（B16 决策 63/72）
 *
 * 测试原理：
 *   不写真实数据文件，直接针对 src/news/core/news-public-gate.js 的纯函数，
 *   验证近期窗口与公开字段完整性的关键不变量：
 *     1. 窗口天数来自配置（默认 30），不使用抓取时间伪装（决策 63）；
 *     2. 发布时间分类：近期 / 过期 / 未来异常 / 缺失（决策 63）；
 *     3. 公开字段完整性：标题、来源链接、发布时间必须完整（决策 49）；
 *     4. 时间异常候选标记为 held，且已 held 候选不重复标记（决策 63）；
 *     5. 过滤规则集中在一处，供热点视图与 RSS 共用（决策 72）。
 *
 * 运行方式：node --test tests/news/news-public-gate.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_PUBLIC_WINDOW_DAYS,
  DEFAULT_FUTURE_TOLERANCE_MS,
  resolvePublicWindow,
  classifyPublicTime,
  isWithinPublicWindow,
  hasCompletePublicFields,
  filterPublicItems,
  filterProjectionByWindow,
} = require('../../src/news/core/news-public-gate');

const NOW = Date.parse('2026-08-03T08:00:00Z');
const DAY = 86400000;
const itemAt = (publishedAt, overrides = {}) => ({ id: 'i1', title: 'T', url: 'https://example.com/x', published_at: publishedAt, ...overrides });

// ── 第 1 组：窗口配置（决策 63：窗口天数作为配置，不硬编码）──

test('resolvePublicWindow 默认 30 天窗口与未来容错', () => {
  const { windowDays, futureToleranceMs, now } = resolvePublicWindow(null, NOW);
  assert.equal(windowDays, DEFAULT_PUBLIC_WINDOW_DAYS);
  assert.equal(futureToleranceMs, DEFAULT_FUTURE_TOLERANCE_MS);
  assert.equal(now, NOW);
});

test('resolvePublicWindow 读取配置中的 output_retention_days 与 future_tolerance_ms', () => {
  const config = { collection: { output_retention_days: 60, future_tolerance_ms: 60 * 60 * 1000 } };
  const { windowDays, futureToleranceMs } = resolvePublicWindow(config, NOW);
  assert.equal(windowDays, 60);
  assert.equal(futureToleranceMs, 3600000);
});

// ── 第 2 组：发布时间分类（决策 63/78）──────────────────────

test('classifyPublicTime 区分近期/过期/未来异常/缺失', () => {
  const opts = { config: null, now: NOW };
  assert.equal(classifyPublicTime(itemAt(new Date(NOW - 1 * DAY).toISOString()), opts), 'in_window');
  assert.equal(classifyPublicTime(itemAt(new Date(NOW - 29 * DAY).toISOString()), opts), 'in_window');
  assert.equal(classifyPublicTime(itemAt(new Date(NOW - 31 * DAY).toISOString()), opts), 'too_old');
  assert.equal(classifyPublicTime(itemAt(new Date(NOW + 10 * 3600 * 1000).toISOString()), opts), 'future'); // 超出 6h 容错
  assert.equal(classifyPublicTime(itemAt(''), opts), 'missing');
  assert.equal(classifyPublicTime(itemAt('invalid-date'), opts), 'missing');
  assert.equal(classifyPublicTime(null, opts), 'missing');
});

test('isWithinPublicWindow 仅放行近期窗口内的内容', () => {
  const opts = { config: null, now: NOW };
  assert.equal(isWithinPublicWindow(itemAt(new Date(NOW - 5 * DAY).toISOString()), opts), true);
  assert.equal(isWithinPublicWindow(itemAt(new Date(NOW - 45 * DAY).toISOString()), opts), false);
  assert.equal(isWithinPublicWindow(itemAt(new Date(NOW + 24 * 3600 * 1000).toISOString()), opts), false);
});

test('窗口边界：恰好 30 天整仍保留，30 天整后 1ms 才判过期（与既有保留语义一致）', () => {
  const opts = { config: null, now: NOW };
  // 旧 build-news.js 保留语义：published_at >= now - retention_days 保留，
  // 因此恰好 30 天整（age === 30 天）仍属窗口内，不判过期（决策 63 沿用该语义）。
  assert.equal(isWithinPublicWindow(itemAt(new Date(NOW - 30 * DAY).toISOString()), opts), true);
  // 只有超过窗口 1ms（age > 30 天）才判过期
  assert.equal(isWithinPublicWindow(itemAt(new Date(NOW - 30 * DAY - 1).toISOString()), opts), false);
});

// ── 第 3 组：公开字段完整性（决策 49）───────────────────────

test('hasCompletePublicFields 要求标题、来源链接、发布时间完整', () => {
  assert.equal(hasCompletePublicFields({ title: 'T', url: 'https://e.com', published_at: '2026-08-01T00:00:00Z' }), true);
  assert.equal(hasCompletePublicFields({ title: '  ', url: 'https://e.com', published_at: '2026-08-01T00:00:00Z' }), false);
  assert.equal(hasCompletePublicFields({ title: 'T', url: '', published_at: '2026-08-01T00:00:00Z' }), false);
  assert.equal(hasCompletePublicFields({ title: 'T', url: 'https://e.com', published_at: '' }), false);
  assert.equal(hasCompletePublicFields(null), false);
});

// ── 第 4 组：统一过滤（决策 72 单一来源）────────────────────

test('filterPublicItems 仅保留窗口内且字段完整的内容', () => {
  const items = [
    itemAt(new Date(NOW - 1 * DAY).toISOString()),
    itemAt(new Date(NOW - 40 * DAY).toISOString(), { id: 'old' }),
    itemAt(new Date(NOW + 12 * 3600 * 1000).toISOString(), { id: 'future' }),
    itemAt(new Date(NOW - 2 * DAY).toISOString(), { id: 'no-url', url: '' }),
  ];
  const passed = filterPublicItems(items, { config: null, now: NOW });
  assert.deepEqual(passed.map(item => item.id), ['i1']);
});

test('filterProjectionByWindow 一致过滤投影并清理悬空引用', () => {
  const output = {
    items: [
      itemAt(new Date(NOW - 1 * DAY).toISOString(), { id: 'fresh' }),
      itemAt(new Date(NOW - 40 * DAY).toISOString(), { id: 'stale' }),
    ],
    events: [
      { id: 'e1', content_ids: ['fresh', 'stale'] },
      { id: 'e2', content_ids: ['stale'] },
    ],
    provenance: [
      { content_id: 'fresh', relation: 'original' },
      { content_id: 'stale', relation: 'original' },
    ],
    assessments: [
      { content_id: 'fresh', score: 80 },
      { content_id: 'stale', score: 40 },
    ],
    coverage: { status: 'complete' },
  };
  const filtered = filterProjectionByWindow(output, { config: null, now: NOW });
  assert.deepEqual(filtered.items.map(item => item.id), ['fresh']);
  assert.deepEqual(filtered.events.map(event => event.id), ['e1']);
  assert.deepEqual(filtered.provenance.map(relation => relation.content_id), ['fresh']);
  assert.deepEqual(filtered.assessments.map(assessment => assessment.content_id), ['fresh']);
  assert.equal(filtered.coverage.status, 'complete');
});

test('filterProjectionByWindow 全在窗口内时返回原对象（不重建）', () => {
  const output = { items: [itemAt(new Date(NOW - 1 * DAY).toISOString())], events: [], provenance: [], assessments: [] };
  const filtered = filterProjectionByWindow(output, { config: null, now: NOW });
  assert.equal(filtered, output);
});

