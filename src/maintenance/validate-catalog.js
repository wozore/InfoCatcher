/**
 * validate-catalog.js — InfoCatcher catalog 域数据校验
 *
 * 从 validate.js 拆分出的 catalog 域：tools.json / tool-intelligence.json /
 * glossary.json / scenes.json / featured.json / index.html 的校验函数与
 * 入口 validateCatalog()。失败通过本模块独立的 fail()/failed 状态记录，
 * 由 validate.js 聚合为最终退出码。错误文案与通过/失败输出与拆分前逐字一致。
 *
 * 用法：由 validate.js 调用 validateCatalog()，返回值是解析出的工具数组
 * （供 validate.js 原则 3 的工具数同步检查使用）。
 */

'use strict';

const fs = require('fs');
const { CATALOG_FILES } = require('../shared/paths');

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

function isHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
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
// catalog 域入口：按顺序校验 catalog 数据文件
//
// 每个文件独立 try/catch —— 一个文件的 JSON 解析失败
// 不会阻止后续文件的校验，确保一次运行暴露所有问题。
// 返回解析出的工具数组（供 validate.js 原则 3 使用）。
// ═══════════════════════════════════════════════════════════════
function validateCatalog() {
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

  return validatedTools;
}

module.exports = { validateCatalog, validateHtml, get failed() { return failed; } };
