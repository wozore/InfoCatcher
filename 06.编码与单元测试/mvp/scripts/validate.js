/**
 * validate.js — InfoCatcher MVP 部署前数据与契约完整性校验
 *
 * 在热点管线中的位置：CI/CD 的最后一道门禁，被 deploy.yml 和
 * collect-news.yml 在执行部署或提交数据前调用。任何一项不通过
 * 都会以非零退出码终止流水线，阻止错误数据上线。
 *
 * ═══════════════════════════════════════════════════════════════
 * 校验范围（按执行顺序）：
 * ═══════════════════════════════════════════════════════════════
 *
 *   1. tools.json       — 43 个工具的核心数据
 *      必填字段、ID唯一、评分1-5范围、数组/字符串格式、日期ISO
 *   2. glossary.json    — 43 条 AI 概念
 *      术语唯一、分类非空、source 完整性
 *   3. news-sources.json — 96 个热点来源
 *      必填字段、ID 唯一、平台合法、启用来源必须有 ID 和标签
 *   4. news-config.json  — 热点运行配置
 *      五层时间窗口连续且 max=270
 *   5. news-registry.json — 视频持久记录
 *      键与平台一致性、发现/处理状态合法、stats.count 正确
 *   6. news-quota.json   — 平台额度账本
 *      consumed+remaining===limit、无负数、operations 为数组
 *   7. pending-authorizations.json — 待授权任务
 *      ID 唯一、状态合法、已处理任务必须有 decision
 *   8. hotspots.json     — 前端热点投影
 *      内容/事件/溯源/评分引用完整性、商业扣分和异常必须附证据
 *   9. index.html        — 页面结构契约
 *      六视图容器 ID 存在、EXTENSION POINT 注释未误删、导航按钮≥4
 *
 * ═══════════════════════════════════════════════════════════════
 * 设计原则：
 * ═══════════════════════════════════════════════════════════════
 *   - fail() 只收集错误不中断执行，确保一次运行报告所有问题
 *   - 每个 try/catch 独立包裹一个文件，一个文件损坏不阻止其他校验
 *   - 校验逻辑与数据分离：校验规则写在这里，数据阈值（如最少工具数）
 *     也是硬编码的防御值，与 tools.json 实际内容无关
 *
 * 用法：node scripts/validate.js
 * 无输出 + exit 0 = 全部通过；有报错 + exit 1 = 需要修复
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MVP_DIR = path.resolve(__dirname, '..');
let failed = false;

/** 记录一个校验失败项。不中断执行，确保一次运行能报告所有问题 */
function fail(msg) {
  console.error('❌', msg);
  failed = true;
}

/** 批量检查对象是否缺少必填字段 */
function checkRequired(obj, path, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null) {
      fail(`${path}.${f} 缺失`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 第 1 组：tools.json — 工具库核心数据
//
// 校验项：21 个必填字段、ID 唯一且格式合法、四维评分 1-5 范围、
//   category/scenes/best_for/not_for 为数组、paid_tiers 为数组、
//   access_level 取值合法、last_updated 为 YYYY-MM-DD 格式
// ═══════════════════════════════════════════════════════════════
const TOOL_REQUIRED = [
  'id', 'name', 'vendor', 'category', 'scenes', 'url', 'icon',
  'free_tier', 'paid_tiers',
  'rating_overall', 'rating_chinese', 'rating_ease', 'rating_price',
  'access_level', 'access_barrier',
  'strengths', 'weaknesses', 'best_for', 'not_for',
  'last_updated', 'source'
];

function validateTools(data) {
  const ids = new Map();

  for (let i = 0; i < data.length; i++) {
    const t = data[i];
    const tag = `tools.json[${i}] (${t.name || '未知'})`;

    checkRequired(t, tag, TOOL_REQUIRED);

    // ID 唯一
    if (t.id) {
      if (ids.has(t.id)) fail(`重复的工具 ID: "${t.id}"（第 ${i + 1} 条与第 ${ids.get(t.id) + 1} 条重复）`);
      ids.set(t.id, i);
    }

    // ID 格式
    if (t.id && !/^[a-z0-9][a-z0-9_-]*$/.test(t.id))
      fail(`${tag}.id "${t.id}" 格式有误（仅限小写字母、数字、连字符、下划线）`);

    // 评分范围 1-5
    ['rating_overall', 'rating_chinese', 'rating_ease', 'rating_price'].forEach(k => {
      if (typeof t[k] === 'number' && (t[k] < 1 || t[k] > 5))
        fail(`${tag}.${k} = ${t[k]}，超出 1-5 范围`);
    });

    // category / scenes / best_for / not_for 必须为数组
    ['category', 'scenes', 'best_for', 'not_for'].forEach(k => {
      if (t[k] !== undefined && !Array.isArray(t[k]))
        fail(`${tag}.${k} 应为数组`);
    });

    // paid_tiers 必须为数组
    if (t.paid_tiers !== undefined && !Array.isArray(t.paid_tiers))
      fail(`${tag}.paid_tiers 应为数组`);

    // access_level 取值
    if (t.access_level && !['开放', '受限'].includes(t.access_level))
      fail(`${tag}.access_level = "${t.access_level}"，应为"开放"或"受限"`);

    // 日期格式 YYYY-MM-DD
    if (t.last_updated && !/^\d{4}-\d{2}-\d{2}$/.test(t.last_updated))
      fail(`${tag}.last_updated = "${t.last_updated}"，格式应为 YYYY-MM-DD`);
  }

  console.log(`  tools.json: ${data.length} 个工具，全部通过`);
}

// ═══════════════════════════════════════════════════════════════
// 第 2 组：glossary.json — AI 概念词典
//
// 校验项：4 个必填字段、术语名称唯一、分类非空、
//   source 对象包含 name 字段
// ═══════════════════════════════════════════════════════════════

const GLOSSARY_REQUIRED = ['term', 'category', 'summary', 'source'];

function validateGlossary(data) {
  const terms = new Set();

  for (let i = 0; i < data.length; i++) {
    const g = data[i];
    const tag = `glossary.json[${i}] (${g.term || '未知'})`;

    checkRequired(g, tag, GLOSSARY_REQUIRED);

    // 术语唯一
    if (g.term) {
      if (terms.has(g.term.toLowerCase())) fail(`${tag} 重复的术语名称`);
      terms.add(g.term.toLowerCase());
    }

    // 分类不能为空
    if (g.category && typeof g.category === 'string' && g.category.trim() === '')
      fail(`${tag}.category 为空`);

    // source 格式
    if (g.source && typeof g.source === 'object') {
      if (!g.source.name) fail(`${tag}.source.name 缺失`);
    }
  }

  console.log(`  glossary.json: ${data.length} 条术语，全部通过`);
}

// ═══════════════════════════════════════════════════════════════
// 第 3 组：热点配置、来源与持久状态
//
// 依次校验：news-sources → news-config → news-registry →
//   news-quota → pending-authorizations
// 每个文件独立 try/catch，一个文件损坏不阻止其他校验
// ═══════════════════════════════════════════════════════════════

const NEWS_PLATFORMS = ['youtube', 'x', 'bilibili'];
const CONTENT_TYPES = [
  'youtube_video', 'x_post', 'bilibili_video', 'bilibili_dynamic_video',
  'bilibili_dynamic_repost', 'bilibili_dynamic_text', 'bilibili_article', 'unknown'
];

function validateNewsSources(data) {
  if (!data || !Array.isArray(data.sources)) {
    fail('news-sources.json.sources 应为数组');
    return;
  }
  const ids = new Set();
  for (let i = 0; i < data.sources.length; i++) {
    const source = data.sources[i];
    const tag = `news-sources.json.sources[${i}] (${source.name || '未知'})`;
    checkRequired(source, tag, ['id', 'platform', 'name', 'profile_url', 'content_tags', 'enabled', 'collector']);
    if (ids.has(source.id)) fail(`${tag}.id 重复: ${source.id}`);
    ids.add(source.id);
    if (!NEWS_PLATFORMS.includes(source.platform)) fail(`${tag}.platform 不支持: ${source.platform}`);
    if (!Array.isArray(source.content_tags)) fail(`${tag}.content_tags 应为数组`);
    if (source.enabled && source.content_tags.length === 0) fail(`${tag} 已启用但没有内容类型标签`);
    if (source.enabled && !source.external_id) fail(`${tag} 已启用但 external_id 缺失`);
  }
  console.log(`  news-sources.json: ${data.sources.length} 个来源，全部通过`);
}

function validateNewsRegistry(data) {
  if (!data || typeof data.videos !== 'object' || Array.isArray(data.videos)) return fail('news-registry.json.videos 应为对象');
  const discovery = new Set(['discovered', 'backfill_candidate', 'filtered_non_ai', 'duplicate_observation', 'quota_paused', 'waiting_authorization', 'temporarily_failed', 'permanently_failed']);
  const processing = new Set(['pending', 'details_fetched', 'analysis_pending', 'assessed', 'published', 'failed']);
  for (const [key, record] of Object.entries(data.videos)) {
    if (record.key && record.key !== key) fail(`news-registry.json key 不一致: ${key}`);
    if (!key.startsWith(`${record.platform}:`)) fail(`news-registry.json key 平台前缀错误: ${key}`);
    if (!discovery.has(record.discovery_status)) fail(`news-registry.json ${key} discovery_status 无效`);
    if (!processing.has(record.processing_status)) fail(`news-registry.json ${key} processing_status 无效`);
  }
  if (data.stats?.count !== Object.keys(data.videos).length) fail('news-registry.json stats.count 与记录数不一致');
  console.log(`  news-registry.json: ${Object.keys(data.videos).length} 条记录，通过`);
}

function validateNewsQuota(data) {
  for (const platform of ['youtube', 'bilibili']) {
    const account = data?.platforms?.[platform];
    if (!account) { fail(`news-quota.json 缺少 ${platform}`); continue; }
    if (account.consumed + account.remaining !== account.limit) fail(`news-quota.json ${platform} 余额计算错误`);
    if (account.reserved < 0 || account.consumed < 0 || account.remaining < 0) fail(`news-quota.json ${platform} 存在负数`);
    if (!Array.isArray(account.operations)) fail(`news-quota.json ${platform}.operations 应为数组`);
  }
  console.log('  news-quota.json: 两个平台额度账本通过');
}

function validateAuthorizations(data) {
  if (!data || !Array.isArray(data.tasks)) return fail('pending-authorizations.json.tasks 应为数组');
  const ids = new Set();
  for (const task of data.tasks) {
    if (!task.id || ids.has(task.id)) fail(`pending-authorizations.json id 缺失或重复: ${task.id}`);
    ids.add(task.id);
    if (!['pending', 'authorized', 'skipped', 'stopped'].includes(task.status)) fail(`授权任务 ${task.id} 状态无效`);
    if (task.status !== 'pending' && !task.decision) fail(`授权任务 ${task.id} 已处理但缺少 decision`);
  }
  console.log(`  pending-authorizations.json: ${data.tasks.length} 个任务，通过`);
}

function validateNewsConfig(data) {
  const layers = data?.time_layers;
  if (!Array.isArray(layers) || layers.length !== 5) return fail('news-config.json.time_layers 应为五层');
  let boundary = 0;
  for (const layer of layers) {
    if (layer.min_age_days !== boundary || layer.max_age_days <= boundary) fail(`时间层不连续: ${layer.id}`);
    boundary = layer.max_age_days;
  }
  if (boundary !== 270) fail('时间层最远边界应为270天');
  console.log('  news-config.json: 五层时间边界连续，通过');
}

// ═══════════════════════════════════════════════════════════════
// 第 4 组：hotspots.json — 前端热点投影引用完整性
//
// 核心约束：
//   - items/events/provenance/assessments 均为数组
//   - 每条内容有完整的 id/platform/content_type/url/title/日期
//   - events 的 content_ids 必须引用存在的 items
//   - provenance 的 content_id 必须引用存在的 items
//   - 商业扣分(penalty>0)必须有 evidence 数组且至少一条证据
//   - 异常调整(adjustment≠0 且非insufficient_sample)必须有 evidence
// ═══════════════════════════════════════════════════════════════
function validateHotspots(data) {
  if (!data || !Array.isArray(data.items)) {
    fail('hotspots.json.items 应为数组');
    return;
  }
  for (const key of ['events', 'provenance', 'assessments']) {
    if (!Array.isArray(data[key])) fail(`hotspots.json.${key} 应为数组`);
  }
  const contentIds = new Set();
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    const tag = `hotspots.json.items[${i}] (${item.title || '未知'})`;
    checkRequired(item, tag, ['id', 'platform', 'native_id', 'content_type', 'url', 'title', 'published_at', 'source_id', 'metrics']);
    if (contentIds.has(item.id)) fail(`${tag}.id 重复: ${item.id}`);
    contentIds.add(item.id);
    if (!NEWS_PLATFORMS.includes(item.platform)) fail(`${tag}.platform 不支持: ${item.platform}`);
    if (!CONTENT_TYPES.includes(item.content_type)) fail(`${tag}.content_type 不支持: ${item.content_type}`);
    if (Number.isNaN(new Date(item.published_at).getTime())) fail(`${tag}.published_at 不是有效日期`);
    if (item.metrics && typeof item.metrics !== 'object') fail(`${tag}.metrics 应为对象`);
  }

  for (const event of data.events || []) {
    for (const contentId of event.content_ids || []) {
      if (!contentIds.has(contentId)) fail(`hotspots.json event ${event.id} 引用了不存在的 content_id: ${contentId}`);
    }
  }
  for (const relation of data.provenance || []) {
    if (!contentIds.has(relation.content_id)) fail(`hotspots.json provenance 引用了不存在的 content_id: ${relation.content_id}`);
  }
  for (const assessment of data.assessments || []) {
    if (!contentIds.has(assessment.content_id)) fail(`hotspots.json assessment 引用了不存在的 content_id: ${assessment.content_id}`);
    const commercial = assessment.commercial_assessment;
    if (commercial?.penalty > 0 && (!Array.isArray(commercial.evidence) || commercial.evidence.length === 0)) {
      fail(`hotspots.json assessment ${assessment.content_id} 商业扣分缺少证据`);
    }
    const anomaly = assessment.anomaly_assessment;
    if (anomaly?.status !== 'insufficient_sample' && anomaly?.adjustment !== 0 && (!anomaly.evidence || anomaly.evidence.length === 0)) {
      fail(`hotspots.json assessment ${assessment.content_id} 异常调整缺少依据`);
    }
  }
  if (!data.coverage || typeof data.coverage !== 'object') fail('hotspots.json.coverage 缺失');
  console.log(`  hotspots.json: ${data.items.length} 条内容 · ${(data.events || []).length} 个主题，通过`);
}

// ═══════════════════════════════════════════════════════════════
// 第 5 组：index.html — 页面 DOM 结构契约
//
// 校验项：
//   - 六个视图容器 ID 必须存在（view-tools/scenes/compare/trending/glossary/about）
//   - 关键交互元素 ID 必须存在（searchInput/toolGrid/sceneGrid/trendingGrid/modalOverlay）
//   - EXTENSION POINT 注释至少 3 处（防止误删扩展点标记）
//   - 导航按钮至少 4 个（确保基本导航可用）
// ═══════════════════════════════════════════════════════════════
function validateHtml(html) {
  // 检查关键 ID 是否存在（至少检查视图容器）
  const expected = [
    'view-tools', 'view-scenes', 'view-compare', 'view-glossary', 'view-trending', 'view-about',
    'searchInput', 'toolGrid', 'sceneGrid', 'trendingGrid', 'modalOverlay'
  ];
  for (const id of expected) {
    const regex = new RegExp(`id=["']${id}["']`);
    if (!regex.test(html)) fail(`index.html 缺少 id="${id}"`);
  }

  // 检查 EXTENSION POINT 注释是否还存在（意外删除会警告）
  const epCount = (html.match(/EXTENSION POINT/g) || []).length;
  if (epCount < 3) fail(`index.html 中 EXTENSION POINT 注释不足 ${epCount} 处（预期至少 3 处）`);

  // 检查 Nav 按钮数量
  const navBtns = (html.match(/class="nav-btn"/g) || []).length;
  if (navBtns < 4) fail(`index.html 导航按钮不足 ${navBtns} 个（预期至少 4 个）`);

  console.log(`  index.html: ${epCount} 处扩展点 · ${navBtns} 个导航按钮，通过`);
}

// ═══════════════════════════════════════════════════════════════
// 入口：按顺序校验所有数据文件 + HTML
//
// 每个文件独立 try/catch —— 一个文件的 JSON 解析失败
// 不会阻止后续文件的校验，确保一次运行暴露所有问题。
// failed 计数器在全部校验完成后统一判断退出码。
// ═══════════════════════════════════════════════════════════════
console.log('\n📋 InfoCatcher MVP 数据校验\n');

// tools.json
try {
  const raw = fs.readFileSync(path.join(MVP_DIR, 'data/tools.json'), 'utf8');
  const tools = JSON.parse(raw);
  if (!Array.isArray(tools)) fail('tools.json 应为数组');
  else if (tools.length < 20) fail(`tools.json 仅有 ${tools.length} 个工具，预期至少 20 个`);
  else validateTools(tools);
} catch (e) {
  fail(`tools.json 解析失败：${e.message}`);
}

// glossary.json
try {
  const raw = fs.readFileSync(path.join(MVP_DIR, 'data/glossary.json'), 'utf8');
  const glossary = JSON.parse(raw);
  if (!Array.isArray(glossary)) fail('glossary.json 应为数组');
  else if (glossary.length < 10) fail(`glossary.json 仅有 ${glossary.length} 条术语，预期至少 10 条`);
  else validateGlossary(glossary);
} catch (e) {
  fail(`glossary.json 解析失败：${e.message}`);
}

// news-sources.json
try {
  const raw = fs.readFileSync(path.join(MVP_DIR, 'data/news-sources.json'), 'utf8');
  validateNewsSources(JSON.parse(raw));
} catch (e) {
  fail(`news-sources.json 解析失败：${e.message}`);
}

  // news-config → news-registry → news-quota → pending-authorizations
  // 四个配置文件使用 [文件名, 校验函数] 配对批量执行
for (const [file, validator] of [
  ['news-config.json', validateNewsConfig],
  ['news-registry.json', validateNewsRegistry],
  ['news-quota.json', validateNewsQuota],
  ['pending-authorizations.json', validateAuthorizations],
]) {
  try {
    validator(JSON.parse(fs.readFileSync(path.join(MVP_DIR, 'data', file), 'utf8')));
  } catch (e) {
    fail(`${file} 解析失败：${e.message}`);
  }
}

// hotspots.json
try {
  const raw = fs.readFileSync(path.join(MVP_DIR, 'data/hotspots.json'), 'utf8');
  validateHotspots(JSON.parse(raw));
} catch (e) {
  fail(`hotspots.json 解析失败：${e.message}`);
}

// index.html
try {
  const html = fs.readFileSync(path.join(MVP_DIR, 'index.html'), 'utf8');
  if (html.length < 1000) fail(`index.html 内容过短（${html.length} 字符）`);
  else validateHtml(html);
} catch (e) {
  fail(`index.html 读取失败：${e.message}`);
}

console.log(failed ? '\n❌ 校验未通过，请修复上述错误后重试\n' : '\n✅ 全部通过\n');
process.exit(failed ? 1 : 0);
