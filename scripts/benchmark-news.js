#!/usr/bin/env node
/**
 * benchmark-news.js —— N-P4 确定性基准：热点管线 CPU 热点测量（合成输入，不联网）
 *
 * 目的：为后续性能优化（N-P1/P2/P3/P5）提供 1k/10k/100k 基线（耗时 + heap）。
 * 直接 require build-news.js 导出的纯函数，用真实 news-config.json 参数，
 * 测量清单（开发计划 N-P4）：
 *   排序（new Date 比较）、日期解析（classifyTimeLayer）、MAD（applyAnomalyDetection）、
 *   关键词（matchesAi / detectLightExperience / detectCommercial）、
 *   评分组合（assessItem）、事件聚合（buildEvents/topicKey）、去重溯源（buildProvenance）、
 *   RSS 正则（parseFeed）。
 *
 * 合成输入场景（N-P4 验收要求）：
 *   high-cardinality  高离散主题（每条例目独立主题，事件分组最分散）
 *   single-source     单一大来源（MAD 样本集中、事件聚合收敛）
 *   duplicates        大量重复（去重/溯源观察路径）
 *   edge-time         边界时间（未来日期 / 超 270 天窗口 / 缺失发布日期）
 *
 * 运行：node scripts/benchmark-news.js [--sizes 1000,10000,100000] [--repeat 3]
 * 输出：控制台 markdown 表格（可粘贴到开发日志）。
 *
 * 注意：本脚本是测量工具，不做任何优化；基线记录后由开发计划 N-P4「确认后再优化」。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const {
  parseFeed,
  matchesAi,
  detectLightExperience,
  detectCommercial,
  assessItem,
  buildProvenance,
  buildEvents,
  applyAnomalyDetection,
  classifyTimeLayer,
} = require('../src/news/pipeline/build-news');

const CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../data/news/config/news-config.json'), 'utf8')
);

const SCENARIOS = [
  { id: 'high-cardinality', label: '高离散主题' },
  { id: 'single-source', label: '单一大来源' },
  { id: 'duplicates', label: '大量重复' },
  { id: 'edge-time', label: '边界时间' },
];

const DEFAULT_SIZES = [1000, 10000, 100000];

// ── 合成输入生成 ────────────────────────────────────────────────

function parseSizes(argv) {
  const flag = argv.find(arg => arg.startsWith('--sizes='));
  if (!flag) return DEFAULT_SIZES;
  return flag
    .split('=')[1]
    .split(',')
    .map(Number)
    .filter(Number.isFinite)
    .filter(n => n > 0);
}

function hashId(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
}

/**
 * 构造单条合成候选。scenario 影响标题/发布时间分布/来源分布。
 */
function makeItem({ i, scenario, now, sourceId }) {
  // 边界时间场景：混合 未来(-10天) / 超窗(400、500天) / 近期(1、2天)，考验时间层边界分支
  const publishedOffsetDays = scenario === 'edge-time'
    ? [-10, 400, 500, 1, 2][i % 5]
    : (i % 30);
  const publishedAt = new Date(now - publishedOffsetDays * 86400000).toISOString();
  const nativeId = scenario === 'duplicates'
    ? `dup-${i % 7}`            // 大量重复：native_id 周期复用，考验去重/溯源观察
    : `${sourceId}-${i}`;
  const isUniqueTopic = scenario === 'high-cardinality';
  return {
    id: `x-${hashId(i)}`,
    platform: 'x',
    native_id: nativeId,
    url: `https://x.com/user/status/${nativeId}`,
    title: isUniqueTopic
      ? `唯一主题词汇${i}ab${i}cd${i} 的 AI 讨论`
      : `DeepSeek 发布新版模型并完成融资，Claude 与 Gemini 更新跟进`,
    description: isUniqueTopic
      ? `第 ${i} 条独立主题内容，包含 AI、大模型、智能体等关键词，讨论独特议题 ${i}。`
      : `同一家公司（${sourceId}）的模型发布、融资与行业动态汇总，含价格与上手体验。`,
    published_at: publishedAt,
    fetched_at: new Date(now).toISOString(),
    source_id: sourceId,
    source_tags: ['即时资讯'],
    metrics: { views: i * 10, likes: i, comments: i % 50, reposts: i % 20, replies: i % 10 },
    explicit_links: [],
  };
}

function generateItems(scenario, count, now) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const sourceId = scenario === 'single-source' ? 'src-single' : `src-${i % 50}`;
    items.push(makeItem({ i, scenario, now, sourceId }));
  }
  return items;
}

// ── 测量 ────────────────────────────────────────────────────────

function parseRepeat(argv) {
  const flag = argv.find(arg => arg.startsWith('--repeat='));
  const value = flag ? Number(flag.split('=')[1]) : 1;
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

// 每个测量重复取样次数（默认 1；--repeat 3 时取中位数耗时，小规模更稳）
const REPEAT = parseRepeat(process.argv.slice(2));

function measure(label, fn, repeat = REPEAT) {
  const heap0 = process.memoryUsage().heapUsed;
  const times = [];
  let peakHeap = heap0;
  for (let r = 0; r < repeat; r++) {
    const t0 = performance.now();
    fn();
    const t1 = performance.now();
    times.push(t1 - t0);
    const used = process.memoryUsage().heapUsed;
    if (used > peakHeap) peakHeap = used;
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  return {
    label,
    ms: +median.toFixed(1),
    // heap 增量取峰值 - 起始，仍受 GC 影响，仅作参考（主要看耗时随规模增长趋势）
    heapDeltaKB: Math.round((peakHeap - heap0) / 1024),
    repeats: repeat,
  };
}

const DEFAULT_SOURCE = { id: 'src', quality_prior: 70, reliability_prior: 60, content_tags: ['即时资讯'] };

function runItemMeasures(items, now) {
  const rows = [];
  rows.push(measure('排序（预解析时间戳·N-P1 优化）', () => {
    items.slice()
      .map(item => [item, new Date(item.published_at).getTime()])
      .sort((a, b) => b[1] - a[1]);
  }));
  rows.push(measure('日期解析 classifyTimeLayer ×N', () => {
    for (const item of items) classifyTimeLayer(item, CONFIG, now);
  }));
  rows.push(measure('关键词 matchesAi ×N', () => {
    for (const item of items) matchesAi(item, CONFIG);
  }));
  rows.push(measure('关键词 detectLightExperience ×N', () => {
    for (const item of items) detectLightExperience(item, CONFIG);
  }));
  rows.push(measure('关键词 detectCommercial ×N', () => {
    for (const item of items) detectCommercial(item, CONFIG);
  }));
  rows.push(measure('评分组合 assessItem ×N', () => {
    for (const item of items) assessItem(item, DEFAULT_SOURCE, CONFIG, now);
  }));
  // MAD：applyAnomalyDetection 只读 item.metrics/source_id/id 与 assessment.anomaly_assessment，
  // 用轻量合成评估记录反映其内核（median 排序 + MAD + robust Z）。
  rows.push(measure('MAD applyAnomalyDetection', () => {
    const assessments = items.map(item => ({
      content_id: item.id,
      anomaly_assessment: { status: 'insufficient_sample', sample_count: 0 },
    }));
    applyAnomalyDetection(items, assessments, CONFIG);
  }));
  rows.push(measure('事件聚合 buildEvents（topicKey）', () => {
    buildEvents(items, [], CONFIG);
  }));
  rows.push(measure('去重/溯源 buildProvenance', () => {
    buildProvenance(items);
  }));
  return rows;
}

function buildRssXml(count) {
  const blocks = [];
  for (let i = 0; i < count; i++) {
    blocks.push(
      `<entry><id>yt:video:${i}</id><title>AI 模型动态 ${i}：DeepSeek 新版本与融资事件</title>` +
      `<link href="https://www.youtube.com/watch?v=vid${i}"/><published>2026-07-${String(1 + i % 28).padStart(2, '0')}T00:00:00Z</published>` +
      `<media:thumbnail url="https://img.youtube.com/vi/vid${i}/hqdefault.jpg"/>` +
      `<summary>第 ${i} 条内容：讨论大模型、AI 智能体与推理模型</summary></entry>`
    );
  }
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Benchmark Feed</title>${blocks.join('')}</feed>`;
}

// ── 主流程 ──────────────────────────────────────────────────────

function main() {
  const sizes = parseSizes(process.argv.slice(2));
  console.log(`# N-P4 热点管线基准（合成输入，真实 config）`);
  console.log(`场景：${SCENARIOS.map(s => s.label).join(' / ')} · 规模：${sizes.join('/')} · 重复：${REPEAT}×`);
  console.log(`时间：${new Date().toISOString()}`);

  for (const size of sizes) {
    const now = Date.now();
    console.log(`\n## 规模 ${size.toLocaleString()}`);
    for (const scenario of SCENARIOS) {
      const items = generateItems(scenario.id, size, now);
      console.log(`\n### ${scenario.label}`);
      console.log(`| 热点 | 耗时(ms) | heapΔ(KB) |`);
      console.log(`|---|---:|---:|`);
      for (const row of runItemMeasures(items, now)) {
        console.log(`| ${row.label} | ${row.ms} | ${row.heapDeltaKB} |`);
      }
    }
    const rssRow = measure(`RSS 正则 parseFeed（${size} entry）`, () => parseFeed(buildRssXml(size)));
    console.log(`\n### RSS 正则解析\n| 热点 | 耗时(ms) | heapΔ(KB) |\n|---|---:|---:|`);
    console.log(`| ${rssRow.label} | ${rssRow.ms} | ${rssRow.heapDeltaKB} |`);
  }
}

if (require.main === module) {
  main();
}
