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
 *   1. tools.json       — 44 个工具的核心数据
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
 *   9. intel-sources.json — 工具情报采集来源配置
 *      结构校验委托至 acquisition/validate-intel.js
 *  10. index.html        — 页面结构契约
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
const { DIRS, CATALOG_FILES, NEWS_FILES, ACQUISITION_FILES } = require('../shared/paths');

const SRC_DIR = DIRS.src;
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
  'last_updated', 'source', 'card_kind', 'entity_kind'
];

function isHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

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

    // 访问与卡片类型
    if (t.access_level && !['开放', '受限'].includes(t.access_level))
      fail(`${tag}.access_level = "${t.access_level}"，应为"开放"或"受限"`);
    if (t.card_kind && !['collection', 'concrete'].includes(t.card_kind))
      fail(`${tag}.card_kind = "${t.card_kind}"，应为 collection 或 concrete`);
    if (t.entity_kind && !['product', 'model', 'service', 'open_source_project', 'other'].includes(t.entity_kind))
      fail(`${tag}.entity_kind = "${t.entity_kind}" 无效`);
    if (t.url && !isHttpUrl(t.url)) fail(`${tag}.url 仅允许 HTTP/HTTPS`);
    if (t.overview !== undefined) {
      if (t.card_kind !== 'collection') fail(`${tag}.overview 仅允许集合卡片使用`);
      else {
        checkRequired(t.overview, `${tag}.overview`, ['description', 'features', 'source_refs']);
        if (!Array.isArray(t.overview.features) || t.overview.features.length === 0) fail(`${tag}.overview.features 应为非空数组`);
        for (const [featureIndex, feature] of (t.overview.features || []).entries()) {
          const featureTag = `${tag}.overview.features[${featureIndex}]`;
          checkRequired(feature, featureTag, ['tone', 'text']);
          if (!['positive', 'negative'].includes(feature.tone)) fail(`${featureTag}.tone 应为 positive 或 negative`);
          if (typeof feature.text !== 'string' || !feature.text.trim()) fail(`${featureTag}.text 不能为空`);
        }
      }
    }

    // 日期格式 YYYY-MM-DD
    if (t.last_updated && !/^\d{4}-\d{2}-\d{2}$/.test(t.last_updated))
      fail(`${tag}.last_updated = "${t.last_updated}"，格式应为 YYYY-MM-DD`);
  }

  console.log(`  tools.json: ${data.length} 个工具，全部通过`);
}

function validateToolIntelligence(data, tools) {
  if (!data || data.schema_version !== 2 || !Array.isArray(data.collections)) {
    return fail('tool-intelligence.json 应包含 schema_version=2 和 collections 数组');
  }
  if (Number.isNaN(new Date(data.catalog_queried_at).getTime())) fail('tool-intelligence.json.catalog_queried_at 不是有效日期');

  const toolById = new Map(tools.map(tool => [tool.id, tool]));
  const toolIds = new Set(toolById.keys());
  const collectionToolIds = new Set(tools.filter(tool => tool.card_kind === 'collection').map(tool => tool.id));
  const seenCollections = new Set();

  for (const [collectionIndex, collection] of data.collections.entries()) {
    const tag = `tool-intelligence.json.collections[${collectionIndex}] (${collection.tool_id || '未知'})`;
    checkRequired(collection, tag, ['tool_id', 'status', 'items', 'sources', 'tree_mode']);
    if (!toolIds.has(collection.tool_id)) fail(`${tag}.tool_id 引用了不存在的工具`);
    if (seenCollections.has(collection.tool_id)) fail(`${tag}.tool_id 重复`);
    seenCollections.add(collection.tool_id);
    if (!['verified', 'partial', 'conflict', 'unavailable'].includes(collection.status)) fail(`${tag}.status 无效`);
    if (!['tree', 'flat'].includes(collection.tree_mode)) fail(`${tag}.tree_mode 应为 tree 或 flat`);
    if (!Array.isArray(collection.items) || collection.items.length === 0) fail(`${tag}.items 应为非空数组`);
    if (!Array.isArray(collection.sources) || collection.sources.length === 0) fail(`${tag}.sources 应为非空数组`);

    const sourceIds = new Set();
    for (const [sourceIndex, source] of (collection.sources || []).entries()) {
      const sourceTag = `${tag}.sources[${sourceIndex}]`;
      checkRequired(source, sourceTag, ['id', 'url', 'title', 'publisher', 'source_type', 'queried_at']);
      if (sourceIds.has(source.id)) fail(`${sourceTag}.id 重复`);
      sourceIds.add(source.id);
      if (!isHttpUrl(source.url)) fail(`${sourceTag}.url 仅允许 HTTP/HTTPS`);
      if (!['official', 'secondary'].includes(source.source_type)) fail(`${sourceTag}.source_type 无效`);
      if (Number.isNaN(new Date(source.queried_at).getTime())) fail(`${sourceTag}.queried_at 不是有效日期`);
    }

    if (collection.tree_mode === 'tree') {
      const overview = toolById.get(collection.tool_id)?.overview;
      if (!overview) fail(`${tag} 对应树形集合工具缺少 overview`);
      else {
        for (const ref of overview.source_refs || []) if (!sourceIds.has(ref)) fail(`${tag} 对应工具 overview.source_refs 引用了不存在的来源: ${ref}`);
      }
    }

    const nodeById = new Map();
    const childrenByParent = new Map();
    for (const [itemIndex, item] of (collection.items || []).entries()) {
      const itemTag = `${tag}.items[${itemIndex}] (${item.name || '未知'})`;
      checkRequired(item, itemTag, ['id', 'node_type', 'kind', 'name', 'status', 'official_url', 'source_refs', 'relation_source_refs']);
      if (!Object.hasOwn(item, 'parent_id')) fail(`${itemTag}.parent_id 缺失`);
      if (!Object.hasOwn(item, 'group_id')) fail(`${itemTag}.group_id 缺失`);
      if (nodeById.has(item.id)) fail(`${itemTag}.id 重复`);
      nodeById.set(item.id, item);
      if (!['group', 'leaf'].includes(item.node_type)) fail(`${itemTag}.node_type 应为 group 或 leaf`);
      if (!['api_model', 'product_variant', 'subscription_plan'].includes(item.kind)) fail(`${itemTag}.kind 无效`);
      if (!['active', 'legacy_supported', 'deprecated', 'retired', 'unknown', 'partial'].includes(item.status)) fail(`${itemTag}.status 无效`);
      if (!isHttpUrl(item.official_url)) fail(`${itemTag}.official_url 仅允许 HTTP/HTTPS`);
      for (const ref of item.source_refs || []) if (!sourceIds.has(ref)) fail(`${itemTag}.source_refs 引用了不存在的来源: ${ref}`);
      for (const ref of item.relation_source_refs || []) if (!sourceIds.has(ref)) fail(`${itemTag}.relation_source_refs 引用了不存在的来源: ${ref}`);
      if (item.parent_id === item.id) fail(`${itemTag}.parent_id 不可自指`);
      if (item.parent_id) childrenByParent.set(item.parent_id, [...(childrenByParent.get(item.parent_id) || []), item]);

      if (item.node_type === 'group') {
        if (item.parent_id !== null) fail(`${itemTag} 分类节点必须位于根层`);
        if (item.group_id !== item.id) fail(`${itemTag}.group_id 必须等于分类节点 id`);
        for (const field of ['one_m_context', 'api_pricing', 'cache_hit_rate', 'plan']) {
          if (item[field] !== undefined) fail(`${itemTag} 分类节点不得包含 ${field}`);
        }
        continue;
      }

      if (collection.tree_mode === 'tree' && item.display_in_tree !== false && !item.parent_id) fail(`${itemTag} 树形集合中的叶节点必须有 parent_id`);
      if (item.parent_id && !item.group_id) fail(`${itemTag} 有 parent_id 时必须有 group_id`);

      if (item.kind === 'api_model') {
        const context = item.one_m_context;
        if (!context || !['native', 'conditional', 'not_supported', 'unknown'].includes(context.status)) fail(`${itemTag}.one_m_context.status 无效`);
        if (context?.status !== 'unknown' && (!Number.isInteger(context.tokens) || context.tokens <= 0)) fail(`${itemTag}.one_m_context.tokens 应为正整数`);
        const pricing = item.api_pricing;
        if (!pricing || !['provided', 'not_provided', 'not_applicable', 'conflict'].includes(pricing.status)) fail(`${itemTag}.api_pricing.status 无效`);
        for (const [rateIndex, rate] of (pricing?.rate_cards || []).entries()) {
          const rateTag = `${itemTag}.api_pricing.rate_cards[${rateIndex}]`;
          checkRequired(rate, rateTag, ['label', 'currency', 'unit', 'input_cached', 'input_uncached', 'output', 'conditions', 'source_refs']);
          if (rate.unit !== 'per_1m_tokens') fail(`${rateTag}.unit 应为 per_1m_tokens`);
          for (const field of ['input_cached', 'input_uncached', 'output']) {
            if (rate[field] !== null && (typeof rate[field] !== 'number' || rate[field] < 0)) fail(`${rateTag}.${field} 应为非负数字或 null`);
          }
          for (const ref of rate.source_refs || []) if (!sourceIds.has(ref)) fail(`${rateTag}.source_refs 引用了不存在的来源: ${ref}`);
        }
        if (!item.cache_hit_rate || !['provided', 'not_provided', 'not_applicable', 'conflict'].includes(item.cache_hit_rate.status)) fail(`${itemTag}.cache_hit_rate.status 无效`);
        if (item.cache_hit_rate?.status === 'provided' && !(Number.isFinite(item.cache_hit_rate.min_percent) && Number.isFinite(item.cache_hit_rate.max_percent))) fail(`${itemTag}.cache_hit_rate 缺少可靠区间`);
      }

      if (item.kind === 'subscription_plan') {
        const plan = item.plan;
        if (!plan) fail(`${itemTag}.plan 缺失`);
        else {
          if (plan.amount !== null && (typeof plan.amount !== 'number' || plan.amount < 0)) fail(`${itemTag}.plan.amount 应为非负数字或 null`);
          if (!plan.currency) fail(`${itemTag}.plan.currency 缺失`);
          if (!['month', 'year', 'usage', 'custom', 'unknown'].includes(plan.billing_period)) fail(`${itemTag}.plan.billing_period 无效`);
          if (!Array.isArray(plan.included_models)) fail(`${itemTag}.plan.included_models 应为数组`);
          if (!['verified', 'partial', 'not_listed'].includes(plan.included_models_status)) fail(`${itemTag}.plan.included_models_status 无效`);
        }
      }
    }

    for (const [nodeId, node] of nodeById) {
      if (node.parent_id) {
        const parent = nodeById.get(node.parent_id);
        if (!parent) fail(`${tag}.items (${node.name}) 的 parent_id 不存在: ${node.parent_id}`);
        else if (parent.node_type !== 'group') fail(`${tag}.items (${node.name}) 的 parent_id 必须指向分类节点`);
      }
      const visited = new Set([nodeId]);
      let current = node;
      while (current.parent_id) {
        if (visited.has(current.parent_id)) {
          fail(`${tag}.items (${node.name}) 存在父节点循环`);
          break;
        }
        visited.add(current.parent_id);
        current = nodeById.get(current.parent_id) || {};
      }
      if (node.node_type === 'group' && collection.tree_mode === 'tree' && !childrenByParent.has(nodeId)) {
        if (node.status !== 'partial' && node.status !== 'unknown') fail(`${tag}.items (${node.name}) 分类节点没有可展示子项`);
      }
    }
  }

  for (const toolId of collectionToolIds) if (!seenCollections.has(toolId)) fail(`集合工具 ${toolId} 缺少 tool-intelligence 数据`);
  console.log(`  tool-intelligence.json: ${data.collections.length} 个集合，通过`);
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

function validateManualItems(data) {
  if (!data || !Array.isArray(data.items)) return fail('news-manual-items.json.items 应为数组');
  const sources = JSON.parse(fs.readFileSync(NEWS_FILES.sources, 'utf8')).sources;
  const { normalizeManualItem } = require('../content/news-manual');
  const keys = new Set();
  for (let index = 0; index < data.items.length; index++) {
    try {
      const item = normalizeManualItem(data.items[index], sources, data.items[index].fetched_at || new Date().toISOString());
      const key = `bilibili:${item.native_id}`;
      if (keys.has(key)) fail(`news-manual-items.json 内容重复: ${key}`);
      keys.add(key);
    } catch (error) { fail(`news-manual-items.json.items[${index}] ${error.message}`); }
  }
  console.log(`  news-manual-items.json: ${data.items.length} 条人工内容，通过`);
}

function validateNewsConfig(data) {
  const layers = data?.time_layers;
  if (!Array.isArray(layers) || layers.length !== 5) return fail('news-config.json.time_layers 应为五层');
  if (!['manual', 'rsshub'].includes(data?.collection?.bilibili_collection_mode)) fail('news-config.json collection.bilibili_collection_mode 应为 manual 或 rsshub');
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
    // B16 决策 74/77/85/88/89：公开热点数据契约补充字段（可选字段，存在才校验）
    if (item.hot_score !== undefined && item.hot_score !== null && !(typeof item.hot_score === 'number' && item.hot_score >= 0 && item.hot_score <= 100)) {
      fail(`${tag}.hot_score 应为 0–100 数值或 null`);
    }
    if (item.evidence_excerpt !== undefined && item.evidence_excerpt !== null && typeof item.evidence_excerpt !== 'string') {
      fail(`${tag}.evidence_excerpt 应为字符串或 null`);
    }
    if (item.related_resources !== undefined) {
      if (!Array.isArray(item.related_resources)) fail(`${tag}.related_resources 应为数组`);
      else for (const [resourceIndex, resource] of item.related_resources.entries()) {
        const resourceTag = `${tag}.related_resources[${resourceIndex}]`;
        if (!resource || typeof resource !== 'object') { fail(`${resourceTag} 应为对象`); continue; }
        if (!['tool', 'concept', 'scene'].includes(resource.type)) fail(`${resourceTag}.type 应为 tool/concept/scene`);
        if (!resource.id || typeof resource.id !== 'string') fail(`${resourceTag}.id 应为非空字符串`);
      }
    }
  }
  if (data.heat_definition !== undefined && typeof data.heat_definition !== 'string') {
    fail('hotspots.json.heat_definition 应为字符串');
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
function validateScenes(data) {
  if (!data || !Array.isArray(data.scenes)) return fail('scenes.json.scenes 应为数组');
  if (data.scenes.length < 8) fail(`scenes.json 仅有 ${data.scenes.length} 个场景，预期至少 8 个`);

  const toolData = JSON.parse(fs.readFileSync(CATALOG_FILES.tools, 'utf8'));
  const toolIds = new Set(toolData.map(tool => tool.id));
  const intelligence = JSON.parse(fs.readFileSync(CATALOG_FILES.toolIntelligence, 'utf8'));
  const collectionMap = new Map((intelligence.collections || []).map(collection => [collection.tool_id, collection]));
  const sceneIds = new Set();
  const categories = new Set(['writing', 'coding', 'design', 'video', 'audio', 'research', 'office', 'learning']);

  data.scenes.forEach((scene, index) => {
    const tag = `scenes.json.scenes[${index}] (${scene.name || '未知'})`;
    checkRequired(scene, tag, ['id', 'name', 'icon', 'category', 'description']);
    if (!/^[a-z0-9-]+$/.test(scene.id || '')) fail(`${tag} id 应为小写字母、数字或连字符`);
    if (sceneIds.has(scene.id)) fail(`${tag} id 重复: ${scene.id}`);
    sceneIds.add(scene.id);
    if (!categories.has(scene.category)) fail(`${tag} category 无效: ${scene.category}`);
    if (!Array.isArray(scene.search_terms) || scene.search_terms.length === 0) fail(`${tag} search_terms 应为非空数组`);
    if (!Array.isArray(scene.tasks) || scene.tasks.length === 0) fail(`${tag} tasks 应至少包含一个子任务`);

    const taskNames = new Set();
    for (const [taskIndex, task] of (scene.tasks || []).entries()) {
      const taskTag = `${tag}.tasks[${taskIndex}]`;
      if (typeof task.task !== 'string' || !task.task.trim()) fail(`${taskTag} 缺少 task`);
      if (taskNames.has(task.task)) fail(`${taskTag} task 重复: ${task.task}`);
      taskNames.add(task.task);
      if (!Array.isArray(task.tools) || task.tools.length === 0) {
        fail(`${taskTag} tools 应为非空数组`);
        continue;
      }
      if (new Set(task.tools).size !== task.tools.length) fail(`${taskTag} tools 存在重复 ID`);
      for (const toolId of task.tools) {
        if (!toolIds.has(toolId)) fail(`${taskTag} 引用了不存在的工具: ${toolId}`);
      }
      if (task.recommendations !== undefined && !Array.isArray(task.recommendations)) {
        fail(`${taskTag} recommendations 应为数组`);
      }
      for (const [recommendationIndex, recommendation] of (task.recommendations || []).entries()) {
        const recommendationTag = `${taskTag}.recommendations[${recommendationIndex}]`;
        checkRequired(recommendation, recommendationTag, ['tool_id', 'item_id', 'reason']);
        if (!task.tools.includes(recommendation.tool_id)) fail(`${recommendationTag}.tool_id 必须同时存在于 tools`);
        const collection = collectionMap.get(recommendation.tool_id);
        if (!collection) fail(`${recommendationTag}.tool_id 没有集合情报: ${recommendation.tool_id}`);
        else {
          const item = (collection.items || []).find(candidate => candidate.id === recommendation.item_id);
          if (!item) fail(`${recommendationTag}.item_id 不存在: ${recommendation.item_id}`);
          else if (item.node_type !== 'leaf') fail(`${recommendationTag}.item_id 必须引用可推荐的叶节点: ${recommendation.item_id}`);
        }
        if (typeof recommendation.reason !== 'string' || !recommendation.reason.trim()) fail(`${recommendationTag}.reason 不能为空`);
      }
    }
  });
  console.log(`  scenes.json: ${data.scenes.length} 个场景，通过`);
}

function validateHtml(html) {
  // 检查关键 ID 是否存在（至少检查视图容器）
  const expected = [
    'view-tools', 'view-scenes', 'view-compare', 'view-glossary', 'view-trending', 'view-featured', 'view-about',
    'searchInput', 'toolGrid', 'sceneSearch', 'scenePicker', 'sceneDetail', 'trendingGrid', 'modalOverlay'
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

let validatedTools = [];

// tools.json
try {
  const tools = JSON.parse(fs.readFileSync(CATALOG_FILES.tools, 'utf8'));
  if (!Array.isArray(tools)) fail('tools.json 应为数组');
  else if (tools.length < 20) fail(`tools.json 仅有 ${tools.length} 个工具，预期至少 20 个`);
  else {
    validatedTools = tools;
    validateTools(tools);
  }
} catch (e) {
  fail(`tools.json 解析失败：${e.message}`);
}

// tool-intelligence.json
try {
  validateToolIntelligence(JSON.parse(fs.readFileSync(CATALOG_FILES.toolIntelligence, 'utf8')), validatedTools);
} catch (e) {
  fail(`tool-intelligence.json 解析失败：${e.message}`);
}

// glossary.json
try {
  const glossary = JSON.parse(fs.readFileSync(CATALOG_FILES.glossary, 'utf8'));
  if (!Array.isArray(glossary)) fail('glossary.json 应为数组');
  else if (glossary.length < 10) fail(`glossary.json 仅有 ${glossary.length} 条术语，预期至少 10 条`);
  else validateGlossary(glossary);
} catch (e) {
  fail(`glossary.json 解析失败：${e.message}`);
}

// scenes.json
try {
  validateScenes(JSON.parse(fs.readFileSync(CATALOG_FILES.scenes, 'utf8')));
} catch (e) {
  fail(`scenes.json 解析失败：${e.message}`);
}

// featured.json
try {
  const featured = JSON.parse(fs.readFileSync(CATALOG_FILES.featured, 'utf8'));
  const intel = JSON.parse(fs.readFileSync(CATALOG_FILES.toolIntelligence, 'utf8'));
  if (!Array.isArray(featured)) fail('featured.json 应为数组');
  else {
    const VALID_CATS = new Set(['llm', 'coding', 'image', 'video', 'audio']);
    const toolIds = new Set(validatedTools.map(t => t.id));
    featured.forEach((pick, i) => {
      const tag = `featured.json[${i}]`;
      if (!pick.category) fail(`${tag} 缺少 category`);
      else if (!VALID_CATS.has(pick.category)) fail(`${tag} category "${pick.category}" 无效（应为 llm/coding/image/video/audio）`);
      if (!pick.tool_id) fail(`${tag} 缺少 tool_id`);
      else if (!toolIds.has(pick.tool_id)) fail(`${tag} tool_id "${pick.tool_id}" 不在 tools.json 中`);
      if (pick.item_id && pick.tool_id) {
        const col = intel.collections.find(c => c.tool_id === pick.tool_id);
        if (!col) fail(`${tag} tool_id "${pick.tool_id}" 不在 tool-intelligence.json 中`);
        else if (!col.items.find(item => item.id === pick.item_id)) fail(`${tag} item_id "${pick.item_id}" 不在 ${pick.tool_id} 集合中`);
      }
      if (!pick.reason) fail(`${tag} 缺少 reason`);
      if (pick.featured_until && isNaN(new Date(pick.featured_until).getTime())) fail(`${tag} featured_until 格式无效`);
    });
    const byCat = {};
    featured.forEach(p => { byCat[p.category] = (byCat[p.category] || 0) + 1; });
    console.log(`  featured.json: ${featured.length} 条精选（${Object.entries(byCat).map(([k,v]) => k+':'+v).join(', ')}），通过`);
  }
} catch (e) {
  fail(`featured.json 解析失败：${e.message}`);
}

// news-sources.json
try {
  validateNewsSources(JSON.parse(fs.readFileSync(NEWS_FILES.sources, 'utf8')));
} catch (e) {
  fail(`news-sources.json 解析失败：${e.message}`);
}

// 其余新闻配置、人工内容和运行时数据
for (const [name, file, validator] of [
  ['news-config.json', NEWS_FILES.config, validateNewsConfig],
  ['news-manual-items.json', NEWS_FILES.manualItems, validateManualItems],
  ['news-registry.json', NEWS_FILES.registry, validateNewsRegistry],
  ['news-quota.json', NEWS_FILES.quota, validateNewsQuota],
  ['pending-authorizations.json', NEWS_FILES.authorizations, validateAuthorizations],
]) {
  try {
    validator(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    fail(`${name} 解析失败：${e.message}`);
  }
}

// hotspots.json
try {
  validateHotspots(JSON.parse(fs.readFileSync(NEWS_FILES.hotspots, 'utf8')));
} catch (e) {
  fail(`hotspots.json 解析失败：${e.message}`);
}

// index.html
try {
  const html = fs.readFileSync(`${SRC_DIR}/web/index.html`, 'utf8');
  if (html.length < 1000) fail(`index.html 内容过短（${html.length} 字符）`);
  else validateHtml(html);
} catch (e) {
  fail(`index.html 读取失败：${e.message}`);
}

// intel-sources.json（委托至 acquisition/validate-intel.js）
try {
  const result = require('../acquisition/validate-intel').validate({ silent: true });
  result.errors.forEach(e => fail(`acquisition: ${e}`));
  result.warnings.forEach(w => console.warn('⚠️  acquisition:', w));
  console.log(`  intel-sources.json + tool-intelligence.json: ${result.valid ? '通过' : '失败'}`);
} catch (e) {
  fail(`acquisition 校验异常: ${e.message}`);
}

// ═══════════════════════════════════════════════════════════════
// 开发原则自动门禁（对应 CLAUDE.md 开发原则 1-5）
// ═══════════════════════════════════════════════════════════════
console.log('\n📋 开发原则合规检查\n');

// --- 原则 1: AI-Ready 结构 — data/ 根目录禁止 .json ---
try {
  const loose = fs.readdirSync(DIRS.data).filter(f => f.endsWith('.json'));
  if (loose.length) loose.forEach(f => fail(`原则1: data/ 根目录禁止 .json（${f} 应归属子目录）`));
  else console.log('  原则1 AI-Ready结构: 通过');
} catch (e) { fail(`原则1 检查异常: ${e.message}`); }

// --- 原则 2: 扩展点显式化 — 前端三文件下限 ---
try {
  const appJs = fs.readFileSync(`${DIRS.src}/web/js/app.js`, 'utf8');
  const appEp = (appJs.match(/EXTENSION POINT/g) || []).length;
  if (appEp < 5) fail(`原则2: app.js EXTENSION POINT 仅 ${appEp} 处（下限 5）`);

  const css = fs.readFileSync(`${DIRS.src}/web/css/style.css`, 'utf8');
  const cssEp = (css.match(/EXTENSION POINT/g) || []).length;
  if (cssEp < 1) fail(`原则2: style.css 缺少 EXTENSION POINT（下限 1）`);

  console.log(`  原则2 扩展点: index.html 3+ · app.js ${appEp} · style.css ${cssEp}，通过`);
} catch (e) { fail(`原则2 检查异常: ${e.message}`); }

// --- 原则 3: CLAUDE.md 同步 — 工具数 + 子目录登记 ---
try {
  const claudePath = path.resolve(DIRS.project, '.claude', 'CLAUDE.md');
  if (!fs.existsSync(claudePath)) {
    console.warn('  ⚠️  原则3: CLAUDE.md 不存在（非工程仓库），跳过同步检查');
  } else {
    const claudeMd = fs.readFileSync(claudePath, 'utf8');

    // 工具数一致
    const m = claudeMd.match(/tools\.json\s+#\s*(\d+)\s*个工具/);
    if (!m) fail('原则3: CLAUDE.md 缺少 "tools.json  # N 个工具" 数量声明');
    else {
      const declared = parseInt(m[1], 10);
      if (declared !== validatedTools.length) fail(`原则3: CLAUDE.md 声明 ${declared} 个工具，实际 ${validatedTools.length}`);
    }

    // scripts/ 子目录全覆盖（CLAUDE.md 用树形格式如 ├── acquisition/）
    const scriptDirs = fs.readdirSync(DIRS.scripts, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    for (const d of scriptDirs) {
      if (!claudeMd.includes(`${d}/`)) fail(`原则3: CLAUDE.md 缺少 scripts/${d}/ 目录`);
    }

    // data/ 子目录全覆盖
    const dataDirs = fs.readdirSync(DIRS.data, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    for (const d of dataDirs) {
      if (!claudeMd.includes(`${d}/`)) fail(`原则3: CLAUDE.md 缺少 data/${d}/ 目录`);
    }
  }
  console.log('  原则3 CLAUDE.md同步: 通过');
} catch (e) { fail(`原则3 检查异常: ${e.message}`); }

// --- 原则 4: 零外部依赖 — 无 package.json + 无 npm require ---
try {
  if (fs.existsSync(`${DIRS.src}/package.json`)) fail('原则4: src/ 禁止 package.json');
  if (fs.existsSync(`${DIRS.project}/package.json`)) fail('原则4: 项目根禁止 package.json');

  const NODE_BUILTINS = new Set(['fs', 'path', 'crypto', 'os', 'child_process', 'http', 'https', 'url', 'zlib', 'stream', 'assert', 'test', 'module']);
  const jsFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }))
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') && jsFiles.push(path.join(d, e.name));
  })(DIRS.scripts);

  for (const f of jsFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let mm;
    while ((mm = re.exec(src)) !== null) {
      const mod = mm[1];
      if (!mod.startsWith('.') && !mod.startsWith('/') && !mod.startsWith('node:') && !NODE_BUILTINS.has(mod))
        fail(`原则4: ${path.relative(DIRS.src, f)} 引用了外部模块 "${mod}"`);
    }
  }
  console.log('  原则4 零外部依赖: 通过');
} catch (e) { fail(`原则4 检查异常: ${e.message}`); }

// --- 原则 5: 先结构后逻辑 — paths.js 覆盖 data/ 所有 JSON ---
try {
  const exports = require('../shared/paths');
  const registered = new Set();
  (function collect(v) {
    if (typeof v === 'string' && v.includes(DIRS.data)) registered.add(path.resolve(v));
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  })({ DIRS: exports.DIRS, CATALOG_FILES: exports.CATALOG_FILES, NEWS_FILES: exports.NEWS_FILES, ACQUISITION_FILES: exports.ACQUISITION_FILES });

  const dataJson = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }))
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') && dataJson.push(path.resolve(path.join(d, e.name)));
  })(DIRS.data);

  for (const j of dataJson)
    if (!registered.has(j)) fail(`原则5: ${path.relative(DIRS.src, j)} 未在 paths.js 登记`);

  console.log(`  原则5 路径登记: ${dataJson.length} 个 JSON 全部覆盖，通过`);
} catch (e) { fail(`原则5 检查异常: ${e.message}`); }

console.log(failed ? '\n❌ 校验未通过，请修复上述错误后重试\n' : '\n✅ 全部通过\n');
process.exit(failed ? 1 : 0);
