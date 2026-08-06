/**
 * InfoCatcher MVP — 数据层：数据加载、共享状态、过滤与通用工具
 *
 * 本模块是全站的“地基”，只被其他模块 import，不依赖任何视图模块：
 *   - 共享数据状态（tools/glossary/scenes/hotspots/featuredPicks/compareList/...）
 *   - 数据加载（loadData / renderSkeletons）
 *   - 过滤管线（getFilteredTools / getFilteredGlossary / getFilteredTrending / getFilteredScenes）
 *   - 通用工具与安全边界（escapeHtml / safeExternalUrl / timeAgo / formatMetric / scoreClass 等）
 *   - 平台元数据与系统图标常量
 *
 * 架构概要、八个视图、安全约束与扩展模式维护文档见 main.js 顶部。
 *
 * ES module 注意：本模块导出的 `let` 状态为实时绑定，导入方只能读取，
 * 不可整体重新赋值；需要跨模块改值的状态（activeTrendingType 等）统一通过
 * 本模块导出的 setter 修改，避免在导入方赋值（ESM 会抛 TypeError）。
 */

// ═══════════════════════════════════════════════════════════════
// 共享数据状态 —— tools.json / tool-intelligence / glossary / scenes / hotspots / featured
// ═══════════════════════════════════════════════════════════════
let tools = [];               // tools.json 的完整内容
let toolIntelligence = { collections: [] }; // 具体模型、变体、套餐与可追溯来源
let toolIntelligenceById = new Map();        // tool_id → 集合情报
let glossary = [];            // glossary.json 的完整内容
let scenes = [];              // scenes.json 的场景、子任务和工具映射
let hotspots = {              // hotspots.json 的前端投影
  items: [],                  //   热点内容条目
  events: [],                 //   主题/事件聚合
  provenance: [],             //   溯源关系 (转载/评论/引用)
  assessments: [],            //   每条内容的评分详情
  coverage: null,             //   采集覆盖状态
  generated_at: null          //   构建时间
};
let featuredPicks = [];        // featured.json 编辑精选
let activeFilters = {         // 工具库的筛选状态
  category: 'all',            //   分类 (大语言模型/编程开发/图像生成/...)
  access: 'all',              //   访问方式 (开放/受限)
  price: 'all'                //   价格 (免费/付费/均有)
};
let activeGlossaryCategory = 'all'; // 概念词典的分类筛选
// B16 决策 74/79：平台不属于列表级筛选维度，只保留在来源核验信息中，故不再维护 activeTrendingPlatform。
let activeTrendingType = 'all';     // 公开 content_type 筛选
// B16 决策 78/85：热度作为主动选择的可选排序；默认“最近”，按唯一内容发布时间倒序。
let activeTrendingSort = 'recent';  // 'recent' | 'hot'
const dataLoadFailures = new Set();

// 跨模块状态 setter（ESM：导入绑定只读，改值必须回到本模块）
function setActiveGlossaryCategory(value) { activeGlossaryCategory = value; }
function setActiveTrendingType(value) { activeTrendingType = value; }
function setActiveTrendingSort(value) { activeTrendingSort = value; }
function setHotspots(value) { hotspots = value; }

// ═══════════════════════════════════════════════════════════════
// 通用工具函数
// ═══════════════════════════════════════════════════════════════

// B16 决策 4.5：系统控件统一内联 SVG 图标。雪碧图定义在 index.html <body> 开头；
// 图标仅作装饰，必须配合可见文字或 aria-label，不使用第三方图标库。
const ICON_SEARCH = '<svg class="icon" aria-hidden="true"><use href="#icon-search"/></svg>';
const ICON_CLOSE = '<svg class="icon" aria-hidden="true"><use href="#icon-close"/></svg>';
const ICON_CHEVRON = '<svg class="icon" aria-hidden="true"><use href="#icon-chevron-down"/></svg>';
const ICON_ARROW_LEFT = '<svg class="icon" aria-hidden="true"><use href="#icon-arrow-left"/></svg>';
const ICON_EXTERNAL = '<svg class="icon" aria-hidden="true"><use href="#icon-external"/></svg>';

/** 1-5 分转换为 ★☆☆☆☆ 格式的星级显示，EXTENSION POINT：MVP完成后实现非完整填充的☆ */
function stars(rating) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5 ? 1 : 0;
  return '★'.repeat(full) + (half ? '☆' : '') + '☆'.repeat(5 - full - half);
}

/** 根据分值返回对应的 CSS class */
function scoreClass(val) {
  if (val >= 4) return 'score-high';
  if (val >= 3) return 'score-mid';
  return 'score-low';
}

/** 判断工具是否有真正可用的免费层 */
function hasFree(t) {
  return t.free_tier && !t.free_tier.includes('无免费') && !t.free_tier.startsWith('无(');
}

/** B11 时效分级：根据 ISO 时间戳与当前时间差值返回新鲜度 */
function getTimelinessInfo(queriedAt) {
  if (!queriedAt) return null;
  const diff = Date.now() - new Date(queriedAt).getTime();
  if (!Number.isFinite(diff) || diff < 0) return null;
  const days = diff / 86400000;
  if (days < 7) return { level: 'green', emoji: '🟢', label: '一周内' };
  if (days < 30) return { level: 'yellow', emoji: '🟡', label: '一个月内' };
  if (days < 90) return { level: 'orange', emoji: '🟠', label: '三个月内' };
  return { level: 'red', emoji: '🔴', label: '三个月以上', stale: true };
}

/** 渲染时效标签 */
function renderTimelinessBadge(queriedAt) {
  const info = getTimelinessInfo(queriedAt);
  if (!info) return '';
  return '<span class="timeliness-badge ' + info.level + '">' + info.emoji + ' ' + info.label + '</span>';
}

/** 获取 item 的最新 sources queried_at */
function getItemLatestQueriedAt(collection, item) {
  if (!collection?.sources || !item?.source_refs?.length) return null;
  return item.source_refs
    .map(ref => collection.sources.find(s => s.id === ref))
    .filter(Boolean)
    .map(s => s.queried_at)
    .sort()
    .reverse()[0] || null;
}

// B16 决策 97/98：工具实体唯一发布时间。工具发布时间 ≠ 资料更新时间（last_updated）。
// 公开数据契约当前未提供该字段时返回 null，工具卡/场景卡以“发布时间待补充”诚实标注，不猜测补齐。
function getToolPublishedDate(tool) {
  if (!tool) return null;
  for (const key of ['published_at', 'release_date', 'released_at', 'publish_date']) {
    const value = tool[key];
    if (!value) continue;
    if (!Number.isFinite(new Date(value).getTime())) continue;
    return String(value).slice(0, 10);
  }
  return null;
}

/**
 * HTML 转义 —— 前端 XSS 防护的第一道防线。
 * 使用浏览器原生 textContent 赋值自动处理 & < > " ' 等特殊字符，
 * 比手写正则替换更可靠（浏览器会处理所有 HTML 实体边界情况）。
 * 所有来自外部数据源的文本内容在插入 innerHTML 前必须经过此函数。
 */
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

/**
 * 外部链接安全校验。
 * 只允许 http: 和 https: 协议，阻止 javascript:、data: 等危险协议。
 * 解析失败或协议不合法时返回 '#'（无害占位符）。
 */
function safeExternalUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
  } catch (e) { return '#'; }
}

/** 相对时间显示：X分钟前 / X小时前 / X天前 / 具体日期 */
function timeAgo(value) {
  if (!value) return '时间未知';
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return '时间未知';
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + '分钟前';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + '小时前';
  const days = Math.floor(hours / 24);
  return days < 30 ? days + '天前' : new Date(value).toLocaleDateString('zh-CN');
}

function formatMetric(value) {
  if (value == null) return null;
  if (value >= 10000) return (value / 10000).toFixed(1) + '万';
  if (value >= 1000) return (value / 1000).toFixed(1) + '千';
  return String(value);
}

function formatPrice(value, currency) {
  if (value === null || value === undefined) return '未提供';
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : currency + ' ';
  return symbol + Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
}

function renderState({ icon, title, message, type = 'empty', actions }) {
  const role = type === 'error' ? 'alert' : 'status';
  // 决策 80：空状态可携带“下一步操作”按钮组（其他视图不传 actions 时保持原样）
  const actionHtml = Array.isArray(actions) && actions.length
    ? '<div class="empty-state-actions">' + actions.map(action =>
        '<button class="btn btn-small' + (action.primary ? ' btn-primary' : '') + '" type="button" data-' + action.dataKey + '="' + escapeHtml(action.dataValue) + '">' + escapeHtml(action.label) + '</button>'
      ).join('') + '</div>'
    : '';
  return '<div class="empty-state state-' + type + '" role="' + role + '" data-state="' + type + '">' +
    '<div class="empty-icon" aria-hidden="true">' + icon + '</div>' +
    '<h3>' + title + '</h3><p>' + message + '</p>' + actionHtml + '</div>';
}

function announceStatus(message) {
  const status = document.getElementById('appStatus');
  if (!status) return;
  status.textContent = '';
  window.requestAnimationFrame(() => { status.textContent = message; });
}

// B16 决策 10.3：局部刷新状态。只在受影响区域显示“正在更新”，原内容降强调、不遮挡页面。
// 同步重渲染会立即清除（busy→false），因此仅在存在真实等待（防抖/异步）时可见，不会闪烁。
function setRegionBusy(element, busy) {
  if (!element) return;
  element.setAttribute('aria-busy', String(busy));
  element.classList.toggle('is-updating', busy);
  const live = element.querySelector(':scope > .region-updating-sr');
  if (busy) {
    if (!live) {
      const el = document.createElement('span');
      el.className = 'region-updating-sr sr-only';
      el.setAttribute('role', 'status');
      el.textContent = '正在更新…';
      element.prepend(el);
    }
  } else if (live) {
    live.remove();
  }
}

function setPressedState(controls, activeControl) {
  controls.forEach(control => {
    const selected = control === activeControl;
    control.classList.toggle('active', selected);
    control.setAttribute('aria-pressed', String(selected));
  });
}

// B16 决策 10.2/100：复制查询 / 复制摘要（仅原型验证位置，不接入云端）。
// 优先 navigator.clipboard（localhost/https 安全上下文），失败时降级 execCommand；成功后按钮短暂显示“已复制”并 announceStatus。
function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (document.execCommand('copy')) resolve();
      else reject(new Error('copy failed'));
    } catch (error) {
      reject(error);
    } finally {
      document.body.removeChild(textarea);
    }
  });
}

function copyTextWithFeedback(button, text, label) {
  copyTextToClipboard(text)
    .then(() => {
      const original = button.textContent;
      button.textContent = '已复制';
      button.setAttribute('aria-label', label + '已复制');
      window.setTimeout(() => { button.textContent = original; }, 1600);
      announceStatus(label + '已复制');
    })
    .catch(() => {
      announceStatus(label + '复制失败，请手动选择复制');
    });
}

// ═══════════════════════════════════════════════════════════════
// 工具/概念数据域辅助 —— 供各视图读取
// ═══════════════════════════════════════════════════════════════
function getToolIntelligence(toolId) {
  return toolIntelligenceById.get(toolId) || null;
}

function getToolSearchText(tool) {
  const collection = getToolIntelligence(tool.id);
  const itemText = (collection?.items || []).flatMap(item => [
    item.name,
    item.summary,
    ...(item.applicable_scenarios || []).flatMap(scene => [scene.title, scene.description]),
    ...(item.inapplicable_scenarios || []).flatMap(scene => [scene.title, scene.description]),
  ]).filter(Boolean);
  const overviewText = tool.overview
    ? [tool.overview.description, ...(tool.overview.features || []).map(feature => feature.text)]
    : [];
  return [
    tool.name, tool.vendor, ...(tool.category || []), ...(tool.scenes || []),
    tool.strengths, tool.weaknesses, tool.free_tier, tool.access_barrier, ...overviewText, ...itemText,
  ].join(' ').toLowerCase();
}

function getCollectionNode(toolId, itemId) {
  return getToolIntelligence(toolId)?.items?.find(item => item.id === itemId) || null;
}

// ═══ P1-A：静态搜索只读适配器（概念词条投影，供搜索与热点关联复用） ═══
function searchConceptKey(term) {
  const normalizedTerm = String(term || '')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return normalizedTerm ? 'concept-' + normalizedTerm : 'concept-unknown';
}

function getSearchConcepts() {
  return glossary
    .filter(concept => concept && typeof concept.term === 'string')
    .map(concept => ({
      id: searchConceptKey(concept.term),
      term: concept.term,
      fullName: concept.full_name || '',
      category: concept.category || '',
      summary: concept.summary || '',
      relatedTerms: Array.isArray(concept.related_terms) ? [...concept.related_terms] : [],
      source: concept.source || null,
      relevance: concept.relevance || ''
    }));
}

// ═══════════════════════════════════════════════════════════════
// 过滤管线 —— 各视图的前端内存过滤（AND 叠加），不发起网络请求
// ═══════════════════════════════════════════════════════════════

/**
 * 工具搜索与筛选（两阶段过滤 + AND 叠加）。
 * 阶段 1: 文本搜索（标题/描述/标签/别名关键词 OR 匹配）
 * 阶段 2: 三维 chip 筛选叠加（分类 AND 访问 AND 价格）
 *
 * EXTENSION POINT: 新增筛选维度时在阶段 2 末尾按同样模式加 if (activeFilters.xxx !== 'all')
 * EXTENSION POINT: 方案一——>方案三变迁中时，设置特殊窗口显示的属性，在特殊窗口搜索时才会显示
 */
function getFilteredTools() {
  const query = (document.getElementById('searchInput').value || '').toLowerCase().trim();
  let filtered = tools;

  // 文本搜索 — 将查询拆分为关键词，OR 匹配
  if (query) {
    const keywords = query.split(/\s+/).filter(k => k.length > 0);
    const hasAliasMatch = keywords.some(kw => kw in searchAliases);

    filtered = filtered.filter(t => {
      const searchText = getToolSearchText(t);
      return keywords.some(kw => searchText.includes(kw.toLowerCase()));
    });

    // 中文别名过滤 — 在关键词匹配结果上叠加(判断关键词是否为真)
    for (const [kw, fn] of Object.entries(searchAliases)) {
      if (query.includes(kw)) {
        filtered = filtered.filter(fn);
      }
    }
  }

  // 分类筛选
  if (activeFilters.category !== 'all') {
    filtered = filtered.filter(t => t.category.includes(activeFilters.category));
  }
  // 访问筛选
  if (activeFilters.access !== 'all') {
    filtered = filtered.filter(t => t.access_level === activeFilters.access);
  }
  // 价格筛选
  if (activeFilters.price === 'free') {
    filtered = filtered.filter(t => hasFree(t));
  } else if (activeFilters.price === 'paid') {
    filtered = filtered.filter(t => !hasFree(t));
  }

  return filtered;
}

/** 按分类 + 空格分隔关键词过滤术语（AND 关系） */
function getFilteredGlossary() {
  const query = (document.getElementById('glossarySearch')?.value || '').toLowerCase().trim();
  let filtered = glossary;

  if (activeGlossaryCategory !== 'all') {
    filtered = filtered.filter(g => g.category === activeGlossaryCategory);
  }

  if (query) {
    const keywords = query.split(/\s+/).filter(k => k.length > 0);
    filtered = filtered.filter(g =>
      keywords.some(kw =>
        g.term.toLowerCase().includes(kw) ||
        (g.full_name && g.full_name.toLowerCase().includes(kw)) ||
        g.summary.toLowerCase().includes(kw) ||
        (g.related_terms || []).some(r => r.toLowerCase().includes(kw))
      )
    );
  }

  return filtered;
}

function getFilteredScenes() {
  const query = (document.getElementById('sceneSearch')?.value || '').toLowerCase().trim();
  if (!query) return scenes;
  const keywords = query.split(/\s+/).filter(keyword => keyword.length > 0);
  return scenes.filter(scene => keywords.some(keyword =>
    scene.name.toLowerCase().includes(keyword) ||
    scene.description.toLowerCase().includes(keyword) ||
    (scene.search_terms || []).some(term => term.toLowerCase().includes(keyword)) ||
    (scene.tasks || []).some(task => task.task.toLowerCase().includes(keyword))
  ));
}

// B16 决策 78/85：默认按唯一内容发布时间倒序；“热度”作为主动选择的可选排序。
// 热度值只读取公开投影中的明确热度字段（hot_score / popularity / heat，由数据契约按统一语义写入），
// 前端不跨平台合成 metrics；缺失热度排末尾并保持稳定，不伪装为 0 或高热度。
function getHotspotHeat(item) {
  const value = item?.hot_score ?? item?.popularity ?? item?.heat;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// B16 决策 74/79：内容类型是热点视图的一级筛选，平台属于来源核验信息，不做列表级过滤。
function getFilteredTrending() {
  let items = [...(hotspots.items || [])];
  if (activeTrendingType !== 'all') {
    items = items.filter(item => item.content_type === activeTrendingType);
  }
  const timestamp = item => {
    const value = new Date(item.published_at).getTime();
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  };
  const byTimeDesc = (a, b) => timestamp(b) - timestamp(a);
  if (activeTrendingSort === 'hot' && items.some(item => getHotspotHeat(item) !== null)) {
    // 热度排序：明确热度值倒序；缺失值排末尾（稳定），不伪装为 0；同热度按时间倒序。
    items.sort((a, b) => {
      const heatA = getHotspotHeat(a);
      const heatB = getHotspotHeat(b);
      if (heatA === null && heatB === null) return byTimeDesc(a, b);
      if (heatA === null) return 1;
      if (heatB === null) return -1;
      if (heatB !== heatA) return heatB - heatA;
      return byTimeDesc(a, b);
    });
  } else {
    items.sort(byTimeDesc);
  }
  return items;
}

// ═══════════════════════════════════════════════════════════════
// 平台元数据 —— 标签名、图标、CSS class 与内容类型映射
// ═══════════════════════════════════════════════════════════════
const platformMeta = {
  youtube: { label: 'YouTube', icon: '▶️' },
  x: { label: 'X', icon: '𝕏' },
  bilibili: { label: 'B站', icon: '📺' },
};
// B16 决策 65/79：内容类型（热点视图主分类维度）。来源媒体类型由 source_type 表达，
// 只出现在来源核验层，不作为列表级筛选。unclassified 为 AI 分类+审核确认上线前的占位。
const contentTypeLabels = {
  ai_tool: 'AI 工具',
  ai_product: 'AI 产品',
  ai_concept: 'AI 概念',
  ai_technology: 'AI 技术动态',
  ai_industry: 'AI 行业事件',
  other: '其他',
  unclassified: '类型待确认'
};
const SOURCE_TYPE_LABELS = {
  youtube_video: 'YouTube 视频',
  x_post: 'X 帖子',
  bilibili_video: 'B站视频',
  bilibili_dynamic_video: 'B站视频',
  bilibili_dynamic_repost: 'B站转发动态',
  bilibili_dynamic_text: 'B站动态',
  bilibili_article: 'B站专栏',
  unknown: '来源类型未知'
};

// ═══════════════════════════════════════════════════════════════
// 数据加载
// ═══════════════════════════════════════════════════════════════

// 决策 10.3：首次加载结构占位骨架（静态、无闪烁动画），loadData 完成后被真实渲染替换
function renderSkeletons() {
  const skeleton = '<div class="skeleton-list">' +
    Array(4).fill('<div class="skeleton"><span></span><span></span><span></span></div>').join('') +
  '</div>';
  const toolGrid = document.getElementById('toolGrid');
  if (toolGrid) toolGrid.innerHTML = skeleton;
  const sceneDetail = document.getElementById('sceneDetail');
  if (sceneDetail) sceneDetail.innerHTML = '<div class="skeleton skeleton-detail"></div>';
  const trendingGrid = document.getElementById('trendingGrid');
  if (trendingGrid) trendingGrid.innerHTML = skeleton;
  const glossaryIndex = document.getElementById('glossaryIndexList');
  if (glossaryIndex) glossaryIndex.innerHTML = skeleton;
}

/**
 * 异步加载所有静态数据文件。
 * 使用独立的 try/catch 块确保一个文件失败不影响其他文件的加载。
 * 失败时赋空值/空状态，由各渲染函数负责显示对应的错误提示。
 *
 * EXTENSION POINT: 新增数据源时在此添加 fetch + try/catch，
 * 将加载结果存入一个全局变量。
 */
async function loadData() {
  try {
    const resp = await fetch('data/catalog/tools.json');
    tools = await resp.json();
    document.getElementById('dataDate').textContent =
      '数据更新: ' + new Date().toISOString().slice(0, 10);
  } catch (e) {
    tools = [];
    dataLoadFailures.add('tools');
  }
  try {
    const iResp = await fetch('data/catalog/tool-intelligence.json');
    toolIntelligence = await iResp.json();
    const collections = Array.isArray(toolIntelligence.collections) ? toolIntelligence.collections : [];
    toolIntelligenceById = new Map(collections.map(collection => [collection.tool_id, collection]));
  } catch (e) {
    toolIntelligence = { collections: [] };
    toolIntelligenceById = new Map();
  }
  try {
    const gResp = await fetch('data/catalog/glossary.json');
    glossary = await gResp.json();
  } catch (e) {
    glossary = [];
    dataLoadFailures.add('glossary');
  }
  try {
    const sResp = await fetch('data/catalog/scenes.json');
    const sceneData = await sResp.json();
    scenes = Array.isArray(sceneData.scenes) ? sceneData.scenes : [];
  } catch (e) {
    scenes = [];
    dataLoadFailures.add('scenes');
  }
  try {
    const nResp = await fetch('data/news/output/hotspots.json');
    hotspots = await nResp.json();
  } catch (e) {
    hotspots = { items: [], events: [], provenance: [], assessments: [], coverage: null, generated_at: null };
    dataLoadFailures.add('hotspots');
  }
  try {
    const fResp = await fetch('data/catalog/featured.json');
    featuredPicks = await fResp.json();
  } catch (e) {
    featuredPicks = [];
    dataLoadFailures.add('featured');
  }
}

// ═══════════════════════════════════════════════════════════════
// 搜索别名映射
//
// 将用户输入的自然语言关键词映射为过滤函数。
// 在 getFilteredTools() 的文本搜索基础上叠加使用（AND 关系）。
// 例如搜索"免费 写代码" → 先按文本匹配"免费""写代码"，
// 再叠加 hasFree() 和 scenes 包含 '写代码' 的过滤。
//
// 格式：'关键词': arrowFunction(t) → boolean
// EXTENSION POINT: 新增别名时按同样格式追加键值对，让英文字符区分大写小写
// ═══════════════════════════════════════════════════════════════
const searchAliases = {
  '免费': t => hasFree(t),
  '收费': t => !hasFree(t),
  '写论文': t => t.scenes.includes('写论文'),
  '写代码': t => t.scenes.includes('写代码') || t.category.includes('AI编程'),
  '编程': t => t.category.some(c => c.includes('编程')),
  '写周报': t => t.scenes.includes('写周报'),
  '画画': t => t.category.some(c => c.includes('图像') || c.includes('绘画')),
  '画图': t => t.category.some(c => c.includes('图像') || c.includes('绘画')),
  '图像': t => t.category.some(c => c.includes('图像')),
  '视频': t => t.category.some(c => c.includes('视频')),
  'ppt': t => t.scenes.some(s => s.includes('PPT') || s.includes('演示')),
  '演示': t => t.scenes.some(s => s.includes('演示')),
  '搜索': t => t.category.some(c => c.includes('搜索')),
  '国内': t => t.access_level === '开放',
  '可用': t => t.access_level === '开放',
  '科学上网': t => t.access_level === '受限',
  'vpn': t => t.access_level === '受限',
  '梯子': t => t.access_level === '受限',
  '开源': t => t.category.includes('开源'),
  '音乐': t => t.category.some(c => c.includes('音乐') || c.includes('音频')),
  '语音': t => t.category.some(c => c.includes('语音')),
  '配音': t => t.scenes.includes('配音'),
  '翻译': t => t.scenes.includes('翻译文档'),
  '学习': t => t.scenes.includes('学习辅导'),
  '研究': t => t.scenes.includes('深度研究') || t.scenes.includes('搜索研究'),
  '设计': t => t.scenes.includes('设计配图') || t.scenes.includes('海报设计'),
  '头脑风暴': t => t.scenes.includes('头脑风暴'),
  '创意': t => t.scenes.includes('头脑风暴') || t.scenes.includes('创意写作'),
  '办公': t => t.scenes.includes('办公文档处理') || t.category.includes('AI办公'),
  '数据分析': t => t.scenes.includes('数据分析'),
};

export {
  tools,
  toolIntelligence,
  toolIntelligenceById,
  glossary,
  scenes,
  hotspots,
  featuredPicks,
  activeFilters,
  activeGlossaryCategory,
  activeTrendingType,
  activeTrendingSort,
  dataLoadFailures,
  setActiveGlossaryCategory,
  setActiveTrendingType,
  setActiveTrendingSort,
  setHotspots,
  ICON_SEARCH,
  ICON_CLOSE,
  ICON_CHEVRON,
  ICON_ARROW_LEFT,
  ICON_EXTERNAL,
  platformMeta,
  contentTypeLabels,
  SOURCE_TYPE_LABELS,
  stars,
  scoreClass,
  hasFree,
  getTimelinessInfo,
  renderTimelinessBadge,
  getItemLatestQueriedAt,
  getToolPublishedDate,
  escapeHtml,
  safeExternalUrl,
  timeAgo,
  formatMetric,
  formatPrice,
  renderState,
  announceStatus,
  setRegionBusy,
  setPressedState,
  copyTextToClipboard,
  copyTextWithFeedback,
  getToolIntelligence,
  getToolSearchText,
  getCollectionNode,
  searchConceptKey,
  getSearchConcepts,
  getFilteredTools,
  getFilteredGlossary,
  getFilteredScenes,
  getFilteredTrending,
  getHotspotHeat,
  renderSkeletons,
  loadData,
  searchAliases,
};
