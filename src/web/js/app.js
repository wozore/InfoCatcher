/**
 * InfoCatcher MVP — 浏览器端应用逻辑（纯前端、零依赖、无构建工具）
 *
 * ═══════════════════════════════════════════════════════════════
 * 架构概要：
 * ═══════════════════════════════════════════════════════════════
 *
 *   数据加载(loadData) → 全局状态(tools/glossary/hotspots/compareList)
 *     → 搜索/过滤(getFilteredTools/getFilteredGlossary/getFilteredTrending)
 *       → 视图渲染(renderTools/renderScenes/renderCompare/renderGlossary/renderTrending)
 *         → 用户交互(点击/搜索/筛选/快捷键)
 *           → 事件绑定(DOMContentLoaded)
 *
 * ═══════════════════════════════════════════════════════════════
 * 八个视图：
 * ═══════════════════════════════════════════════════════════════
 *   AI搜索 (search)     — B16 静态搜索入口与结果主线（P1-A 接入）
 *   工具库 (tools)      — 搜索 + 分类/访问/价格筛选 + 卡片网格 + 详情弹窗
 *   场景模式 (scenes)   — 12 个场景入口，可展开子任务并查看匹配工具卡片
 *   对比模式 (compare)  — 2-5 个工具并排比较 10+ 维度
 *   AI热点 (trending)   — 内容类型/平台筛选, 按唯一内容发布时间分组
 *   推荐 (featured)     — 编辑精选与热门模型分类视图
 *   AI概念 (glossary)   — 43 条术语, 分类筛选 + 搜索 + 可展开详情
 *   关于 (about)        — 评测方法论和项目介绍 (纯 HTML, 无专属渲染函数)
 *
 * ═══════════════════════════════════════════════════════════════
 * 安全约束：
 * ═══════════════════════════════════════════════════════════════
 *   - 所有渲染的外部文本通过 escapeHtml() 转义，防止 XSS
 *   - 所有外部链接通过 safeExternalUrl() 校验，只允许 http/https 协议
 *   - API Key 不存在于前端代码或静态 JSON 中，浏览器不直接调用平台 API
 *   - 用户偏好仅存储在浏览器 localStorage，不上传服务器
 *
 * ═══════════════════════════════════════════════════════════════
 * 扩展模式（新增功能时参考）：
 * ═══════════════════════════════════════════════════════════════
 *   新增视图：
 *     1. index.html → 加 nav-btn + section 容器
 *     2. 本文件 → 加 renderXxx() 函数
 *     3. switchView() → 加 if (view === 'xxx') 分支
 *     4. DOMContentLoaded → 加事件绑定
 *   新增筛选维度：
 *     1. index.html → 加 filter-chip
 *     2. getFilteredTools() → 加过滤分支 (AND 叠加)
 *   新增数据源：
 *     1. data/ 目录 → 加 JSON 文件
 *     2. loadData() → 加 fetch, 失败时降级为空状态
 *
 * ═══════════════════════════════════════════════════════════════
 * 渲染约束：
 * ═══════════════════════════════════════════════════════════════
 *   - 所有搜索/筛选为前端内存过滤, 不发起网络请求
 *   - 对比按钮状态变更后必须同步 updateCompareCount() + renderTools()
 *   - 数据文件日期统一使用 ISO 格式 (YYYY-MM-DD)
 *   - 视图切换靠 CSS class .view.active, 不使用前端路由库
 */

// ═══════════════════════════════════════════════════════════════
// 全局状态 —— 所有视图共享的数据和交互状态
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
let compareList = [];         // { toolId, itemId } 稳定比较引用；itemId 为 null 表示具体根工具
let featuredPicks = [];        // featured.json 编辑精选
let detailPanelState = new Map(); // collection toolId → 当前模型/工具节点路径
let currentView = 'search';   // 当前激活的视图
// B16 决策 84：移动端顶栏“当前页面名称”映射（同步到 #mobileCurrentPage）
const VIEW_TITLES = {
  search: 'AI 搜索',
  tools: '工具库',
  scenes: '场景',
  compare: '对比',
  trending: 'AI 热点',
  featured: '推荐',
  glossary: 'AI 概念',
  about: '关于'
};
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
let modalTrigger = null;           // 详情弹窗打开前的焦点，用于关闭后回焦
let modalScrollPosition = null;    // 热点等列表详情关闭时保持原列表滚动位置
const dataLoadFailures = new Set();

// P1-A：固定静态搜索状态。只在当前页面内存中存在，不写入 URL、localStorage 或后端。
const SEARCH_DEMOS = Object.freeze([
  Object.freeze({ key: 'writing', query: '写论文', hint: '适合查找论文写作、资料整理和研究辅助工具。' }),
  Object.freeze({ key: 'coding', query: '写代码', hint: '适合查找编程开发、代码补全和命令行工具。' }),
  Object.freeze({ key: 'research', query: '深度研究', hint: '适合查找深度研究、搜索和长文档分析工具。' })
]);
const SEARCH_PROCESSING_STAGES = Object.freeze([
  '整理问题',
  '匹配已收录资料',
  '准备静态摘要'
]);
let searchProcessingRun = 0;
let searchProcessingTimer = null;
const searchCitationOrigins = new Map();
let searchConceptTrigger = null;
let searchConceptHoverTimer = null;
let searchConceptCloseTimer = null;
// 决策 9.8.1：关闭解释框回焦时，抑制因 focus 事件触发的立即重新打开
let searchConceptRestoring = false;
let searchState = {
  mode: 'home',
  query: '',
  demoKey: null,
  processing: false,
  processingStage: null,
  recent: [],
  feedback: null,
  editing: false,
  lastQuery: null
};

function renderState({ icon, title, message, type = 'empty' }) {
  const role = type === 'error' ? 'alert' : 'status';
  return '<div class="empty-state state-' + type + '" role="' + role + '" data-state="' + type + '">' +
    '<div class="empty-icon" aria-hidden="true">' + icon + '</div>' +
    '<h3>' + title + '</h3><p>' + message + '</p></div>';
}

function announceStatus(message) {
  const status = document.getElementById('appStatus');
  if (!status) return;
  status.textContent = '';
  window.requestAnimationFrame(() => { status.textContent = message; });
}

function setRegionBusy(element, busy) {
  if (!element) return;
  element.setAttribute('aria-busy', String(busy));
}

function setPressedState(controls, activeControl) {
  controls.forEach(control => {
    const selected = control === activeControl;
    control.classList.toggle('active', selected);
    control.setAttribute('aria-pressed', String(selected));
  });
}

// ═══ P1-A：静态搜索只读适配器 ═══════════════════════════════════
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

function getSearchToolMatches(query) {
  const text = String(query || '').trim().toLocaleLowerCase('zh-CN');
  if (!text) return [];
  return tools.filter(tool => getToolSearchText(tool).toLocaleLowerCase('zh-CN').includes(text));
}

function getSearchSceneMatches(query) {
  const text = String(query || '').trim().toLocaleLowerCase('zh-CN');
  if (!text) return [];
  return scenes.filter(scene => [
    scene.name,
    scene.description,
    ...(scene.search_terms || []),
    ...(scene.tasks || []).map(task => task.task)
  ].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN').includes(text));
}

function getSearchHotspotMatches(query) {
  const text = String(query || '').trim().toLocaleLowerCase('zh-CN');
  if (!text) return [];
  return (hotspots.items || []).filter(item => [
    item.title,
    item.description,
    item.author_name,
    ...(item.source_tags || [])
  ].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN').includes(text));
}

function getSearchGlossaryMatches(query) {
  const text = String(query || '').trim().toLocaleLowerCase('zh-CN');
  if (!text) return [];
  return getSearchConcepts().filter(concept => [
    concept.term,
    concept.fullName,
    concept.summary,
    ...concept.relatedTerms
  ].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN').includes(text));
}

function getSearchMatches(query) {
  const normalizedQuery = String(query || '').trim();
  const demo = SEARCH_DEMOS.find(item => item.query === normalizedQuery) || null;
  return {
    query: normalizedQuery,
    demoKey: demo?.key || null,
    demoHint: demo?.hint || '',
    tools: demo ? getSearchToolMatches(normalizedQuery) : [],
    scenes: demo ? getSearchSceneMatches(normalizedQuery) : [],
    hotspots: demo ? getSearchHotspotMatches(normalizedQuery) : [],
    concepts: demo ? getSearchGlossaryMatches(normalizedQuery) : [],
    unavailable: [...dataLoadFailures].filter(key => ['tools', 'scenes', 'hotspots', 'glossary'].includes(key))
  };
}

function resetSearchState() {
  searchState = {
    mode: 'home',
    query: '',
    demoKey: null,
    processing: false,
    processingStage: null,
    recent: [],
    feedback: null,
    editing: false,
    lastQuery: null
  };
}

function renderSearchHome() {
  const examples = document.getElementById('searchExampleList');
  const recentSection = document.getElementById('searchRecentSection');
  const recentList = document.getElementById('searchRecentList');
  if (!examples || !recentSection || !recentList) return;

  examples.innerHTML = SEARCH_DEMOS.map(demo =>
    '<button class="chip" type="button" data-search-example="' + escapeHtml(demo.query) + '">' +
      escapeHtml(demo.query) +
    '</button>'
  ).join('');

  recentSection.hidden = searchState.recent.length === 0;
  recentList.innerHTML = searchState.recent.map(entry =>
    '<article class="list-item">' +
      '<div><h3>' + escapeHtml(entry.query) + '</h3><p>固定静态示例 · ' + escapeHtml(timeAgo(entry.ts)) + '</p></div>' +
      '<button class="btn btn-small" type="button" data-search-example="' + escapeHtml(entry.query) + '">恢复示例</button>' +
    '</article>'
  ).join('');
}

function clearSearchHomeStates() {
  const input = document.getElementById('aiSearchInput');
  const status = document.getElementById('searchFormStatus');
  const emptyState = document.getElementById('searchEmptyState');
  const unsupportedState = document.getElementById('searchUnsupportedState');
  if (input) input.setAttribute('aria-invalid', 'false');
  if (status) status.textContent = '';
  if (emptyState) emptyState.hidden = true;
  if (unsupportedState) unsupportedState.hidden = true;
}

function selectSearchExample(query) {
  const input = document.getElementById('aiSearchInput');
  if (!input) return;
  input.value = query;
  clearSearchHomeStates();
  input.focus();
}

function getSearchResultAvailability(matches) {
  if (!matches.demoKey) return { type: 'no-match', message: '当前问题没有对应的固定静态示例。' };
  const availableGroups = [matches.tools, matches.scenes, matches.hotspots, matches.concepts].filter(group => group.length > 0).length;
  if (matches.unavailable.length && availableGroups === 0) {
    return { type: 'error', message: '匹配所需的静态资料当前不可用，请刷新页面后重试。' };
  }
  if (availableGroups === 0) return { type: 'no-match', message: '当前固定示例没有匹配到可展示的静态资料。' };
  if (matches.unavailable.length) {
    const labels = { tools: '工具', scenes: '场景', hotspots: '热点', glossary: '概念' };
    return { type: 'partial', message: '部分静态资料当前不可用：' + matches.unavailable.map(key => labels[key] || key).join('、') + '。以下结果只包含已成功加载的资料。' };
  }
  return { type: 'success', message: '' };
}

function getSearchResultProjection(query) {
  const matches = getSearchMatches(query);
  if (!matches.demoKey) return { matches, sources: [], paragraphs: [] };

  const scene = matches.scenes[0] || null;
  const selectedTools = matches.tools.slice(0, 3);
  const sources = [];
  if (scene) {
    sources.push({
      id: 'scene-' + scene.id,
      type: '场景资料',
      title: scene.name,
      description: scene.description || '描述暂不可用',
      updatedAt: null,
      url: null
    });
  }
  selectedTools.forEach(tool => {
    sources.push({
      id: 'tool-' + tool.id,
      type: '工具资料',
      title: tool.name,
      description: tool.overview?.description || tool.strengths || '描述暂不可用',
      updatedAt: tool.last_updated || null,
      url: tool.url || null
    });
  });

  const paragraphs = [];
  if (scene) {
    paragraphs.push({
      text: scene.description || '该场景的描述暂不可用。',
      sourceIds: ['scene-' + scene.id]
    });
    const tasks = (scene.tasks || []).map(task => task.task).filter(Boolean);
    if (tasks.length) {
      paragraphs.push({
        text: '已收录任务包括：' + tasks.join('、') + '。',
        sourceIds: ['scene-' + scene.id]
      });
    }
  }
  if (selectedTools.length) {
    paragraphs.push({
      text: '当前资料中，与该问题直接匹配的工具包括：' + selectedTools.map(tool => tool.name).join('、') + '。',
      sourceIds: selectedTools.map(tool => 'tool-' + tool.id)
    });
  }
  return { matches, sources, paragraphs };
}

function renderSearchResults() {
  closeSearchConcept();
  const state = document.getElementById('searchResultState');
  const content = document.getElementById('searchResultContent');
  const summary = document.getElementById('searchSummaryContent');
  const sourceList = document.getElementById('searchSourceList');
  if (!state || !content || !summary || !sourceList) return;

  const projection = getSearchResultProjection(searchState.query);
  const availability = getSearchResultAvailability(projection.matches);
  if (availability.type === 'error' || availability.type === 'no-match' || !projection.sources.length || !projection.paragraphs.length) {
    state.hidden = false;
    state.className = 'state ' + (availability.type === 'error' ? 'error' : 'info') + ' search-result-state';
    state.innerHTML = '<strong>' + (availability.type === 'error' ? '静态资料处理失败' : '暂无可展示的静态整理结果') + '</strong><p>' + escapeHtml(availability.message || '当前问题没有足够的已收录资料，因此不会生成无依据摘要。') + '</p>';
    content.hidden = true;
    summary.innerHTML = '';
    sourceList.innerHTML = '';
    renderSearchMatches(projection.matches, false);
    renderSearchContinue();
    renderSearchFeedback(false);
    return;
  }

  if (availability.type === 'partial') {
    state.hidden = false;
    state.className = 'state warn search-result-state';
    state.innerHTML = '<strong>部分资料暂不可用</strong><p>' + escapeHtml(availability.message) + '</p>';
  } else {
    state.hidden = true;
  }
  content.hidden = false;
  searchCitationOrigins.clear();
  const sourceNumber = new Map(projection.sources.map((source, index) => [source.id, index + 1]));
  summary.innerHTML = projection.paragraphs.map((paragraph, index) =>
    '<p id="search-summary-' + (index + 1) + '" tabindex="-1" data-search-summary data-search-concept-text>' +
      escapeHtml(paragraph.text) +
      paragraph.sourceIds.map(sourceId => {
        const number = sourceNumber.get(sourceId);
        return '<button class="citation" type="button" data-search-citation="' + escapeHtml(sourceId) + '" aria-label="定位到来源 ' + number + '">[' + number + ']</button>';
      }).join('') +
    '</p>'
  ).join('') +
  // 决策 8.3：移动端“查看关键来源”快捷锚点（≤768px 显示）
  '<div class="search-mobile-anchors"><button class="btn-link" type="button" data-search-anchor="sources">查看关键来源</button></div>';

  // 决策 8.6：来源项内联展开“来源说明”（aria-expanded + aria-controls，同一时刻只展开一个）
  const sourceItemHtml = (source, index) => {
    const sourceUrl = source.url ? safeExternalUrl(source.url) : '#';
    const validUrl = sourceUrl !== '#';
    const relatedParagraph = projection.paragraphs.find(p => (p.sourceIds || []).includes(source.id));
    const detailId = 'search-source-detail-' + escapeHtml(source.id);
    return '<article class="search-source-item" id="search-source-' + escapeHtml(source.id) + '" tabindex="-1" data-search-source="' + escapeHtml(source.id) + '">' +
      '<div class="search-source-heading"><span class="search-source-number">[' + (index + 1) + ']</span><span class="tag">' + escapeHtml(source.type) + '</span></div>' +
      '<h3>' + escapeHtml(source.title) + '</h3>' +
      '<p data-search-concept-text>' + escapeHtml(source.description) + '</p>' +
      '<dl><div><dt>资料更新</dt><dd>' + escapeHtml(source.updatedAt || '待补充') + '</dd></div>' +
      '<div><dt>原始链接</dt><dd>' + (validUrl
        ? '<a href="' + escapeHtml(sourceUrl) + '" target="_blank" rel="noopener noreferrer">打开来源</a>'
        : '暂不可用') + '</dd></div></dl>' +
      '<button class="btn-link search-source-expand" type="button" aria-expanded="false" aria-controls="' + detailId + '" data-search-source-expand="' + escapeHtml(source.id) + '">来源说明</button>' +
      '<div class="search-source-detail" id="' + detailId + '" hidden>' +
        '<dl>' +
          '<div><dt>支持的摘要位置</dt><dd>' + (relatedParagraph ? escapeHtml(relatedParagraph.text) : '无直接关联段落') + '</dd></div>' +
          '<div><dt>资料更新</dt><dd>' + escapeHtml(source.updatedAt || '待补充') + '</dd></div>' +
          '<div><dt>完整资料</dt><dd>' + (validUrl ? '<a href="' + escapeHtml(sourceUrl) + '" target="_blank" rel="noopener noreferrer">查看完整资料</a>' : '暂不可用') + '</dd></div>' +
        '</dl>' +
      '</div>' +
      '<button class="btn-link search-source-back" type="button" data-search-source-back="' + escapeHtml(source.id) + '">返回引用位置</button>' +
    '</article>';
  };

  // 决策 8.2/8.4：默认展示前 3 条关键来源，更多经“查看全部来源”展开
  const sourceItems = projection.sources.map(sourceItemHtml);
  const visibleCount = 3;
  let sourceHtml = sourceItems.slice(0, visibleCount).join('');
  if (projection.sources.length > visibleCount) {
    sourceHtml += '<div class="search-more-sources" id="searchMoreSources" hidden>' + sourceItems.slice(visibleCount).join('') + '</div>' +
      '<button class="btn-link search-sources-toggle" type="button" data-search-sources-toggle data-count="' + projection.sources.length + '" aria-expanded="false" aria-controls="searchMoreSources">查看全部来源（' + projection.sources.length + '）</button>';
  }
  // 决策 8.3：移动端“返回摘要”锚点（≤768px 显示）
  sourceHtml += '<div class="search-mobile-anchors"><button class="btn-link" type="button" data-search-anchor="summary">返回摘要</button></div>';
  sourceList.innerHTML = sourceHtml;
  renderSearchMatches(projection.matches, true);
  renderSearchContinue();
  renderSearchFeedback(true);
  // 决策 9.8：在摘要、来源与匹配项全部渲染后再扫描概念词，避免遗漏后渲染区域
  markSearchConcepts();
}

function searchMatchDescription(item, type) {
  if (type === 'tools') return item.overview?.description || item.strengths || '描述暂不可用';
  if (type === 'scenes') return item.description || '描述暂不可用';
  if (type === 'hotspots') return item.description || '描述暂不可用';
  return item.summary || '描述暂不可用';
}

// 决策 9.1：每组“查看全部”的展开状态（当前页面内存）
const searchMatchExpanded = new Set();

function renderSearchMatches(matches, visible) {
  const section = document.getElementById('searchMatchesSection');
  const container = document.getElementById('searchMatchGroups');
  if (!section || !container) return;
  if (!visible) {
    section.hidden = true;
    container.innerHTML = '';
    return;
  }

  const groups = [
    { key: 'tools', label: '工具', items: matches.tools, limit: 3, id: item => item.id, title: item => item.name },
    { key: 'scenes', label: '场景', items: matches.scenes, limit: 2, id: item => item.id, title: item => item.name },
    { key: 'hotspots', label: '热点', items: matches.hotspots, limit: 2, id: item => item.id, title: item => item.title },
    { key: 'concepts', label: '概念', items: matches.concepts, limit: 2, id: item => item.term, title: item => item.term }
  ];

  // 决策 9.1：没有对应类型资料时隐藏该分组，不显示空容器；资料不可用时仍显示明确提示
  const visibleGroups = groups.filter(group => {
    const unavailable = matches.unavailable.includes(group.key === 'concepts' ? 'glossary' : group.key);
    return unavailable || group.items.length > 0;
  });
  if (!visibleGroups.length) {
    section.hidden = true;
    container.innerHTML = '';
    return;
  }
  section.hidden = false;
  container.innerHTML = visibleGroups.map(group => {
    const unavailable = matches.unavailable.includes(group.key === 'concepts' ? 'glossary' : group.key);
    const expanded = searchMatchExpanded.has(group.key);
    const shown = expanded ? group.items : group.items.slice(0, group.limit);
    const body = unavailable
      ? '<p class="search-match-empty">该类静态资料暂不可用。</p>'
      : shown.map(item => '<article class="search-match-item" data-search-match="' + group.key + '">' +
            '<div><h4>' + escapeHtml(group.title(item)) + '</h4><p data-search-concept-text>' + escapeHtml(searchMatchDescription(item, group.key)) + '</p></div>' +
            '<button class="btn btn-small" type="button" data-search-open="' + group.key + '" data-search-id="' + escapeHtml(group.id(item)) + '">查看资料</button>' +
          '</article>').join('');
    const expandControl = !unavailable && group.items.length > group.limit
      ? '<div class="search-match-expand"><button class="btn-link" type="button" data-search-match-expand="' + group.key + '" data-count="' + group.items.length + '">' + (expanded ? '收起' : '查看全部 ' + group.items.length + ' 条') + '</button></div>'
      : '';
    return '<section class="search-match-group" aria-labelledby="search-match-' + group.key + '"><h3 id="search-match-' + group.key + '">' + group.label + '</h3>' + body + expandControl + '</section>';
  }).join('');
}

function renderSearchFeedback(visible) {
  const section = document.getElementById('searchFeedbackSection');
  const status = document.getElementById('searchFeedbackStatus');
  if (!section || !status) return;
  section.hidden = !visible;
  section.querySelectorAll('[data-search-feedback]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.searchFeedback === searchState.feedback));
  });
  status.textContent = searchState.feedback ? '反馈已记录在当前页面内存中。' : '';
}

// 决策 8.7：结果页末尾“继续探索 · 示例历史”（当前页面内存，点击恢复示例查询）
function renderSearchContinue() {
  const section = document.getElementById('searchContinueSection');
  const list = document.getElementById('searchContinueList');
  if (!section || !list) return;
  const history = searchState.recent.filter(entry => entry.query !== searchState.query).slice(0, 3);
  section.hidden = history.length === 0;
  list.innerHTML = history.map(entry =>
    '<article class="list-item">' +
      '<div><h3>' + escapeHtml(entry.query) + '</h3><p>固定静态示例 · ' + escapeHtml(timeAgo(entry.ts)) + '</p></div>' +
      '<button class="btn btn-small" type="button" data-search-example="' + escapeHtml(entry.query) + '">恢复示例</button>' +
    '</article>'
  ).join('');
}

function openSearchMatch(type, id, trigger) {
  if (type === 'tools') {
    switchView('tools');
    const visibleTrigger = [...document.querySelectorAll('#toolGrid .detail-button')].find(button =>
      button.getAttribute('onclick')?.includes("openDetail('" + id + "'")
    ) || document.querySelector('#toolGrid .detail-button');
    openDetail(id, null, visibleTrigger || null);
    return;
  }
  if (type === 'scenes') {
    const scene = scenes.find(item => item.id === id);
    const input = document.getElementById('sceneSearch');
    if (input) input.value = scene?.name || '';
    activeSceneId = id;
    switchView('scenes');
    window.requestAnimationFrame(() => {
      document.querySelector('.scene-pick-chip[data-scene-pick="' + CSS.escape(id) + '"]')?.focus();
    });
    return;
  }
  if (type === 'hotspots') {
    switchView('trending');
    document.getElementById('view-trending')?.querySelector('h1')?.focus?.();
    return;
  }
  if (type === 'concepts') {
    const input = document.getElementById('glossarySearch');
    if (input) input.value = id;
    activeGlossaryCategory = 'all';
    activeGlossaryId = id;
    switchView('glossary');
    window.requestAnimationFrame(() => document.querySelector('.glossary-index-item[data-glossary-pick="' + CSS.escape(id) + '"]')?.focus());
  }
}

function setSearchFeedback(value) {
  searchState.feedback = value;
  renderSearchFeedback(true);
}

function isSearchConceptTextNode(node) {
  const parent = node.parentElement;
  if (!parent || !node.nodeValue?.trim()) return false;
  if (parent.closest('a, button, input, textarea, select, code, pre, time, [data-search-concept], #searchConceptPopover')) return false;
  // 决策 9.8：仅处理标注为可阅读正文的容器（搜索结果摘要/来源/匹配、场景导语、概念详情）
  return Boolean(parent.closest('[data-search-concept-text]'));
}

// 决策 9.8.2：普通多义词排除列表（搜索结果正文中不触发概念联动）
const CONCEPT_EXCLUSION = new Set(['API', 'Token', 'Temperature', 'A/B测试']);

function getSearchConceptPatterns() {
  return glossary.flatMap(concept => [
    { text: concept.term, concept },
    ...(concept.full_name && concept.full_name !== concept.term ? [{ text: concept.full_name, concept }] : [])
  ]).filter(item => item.text?.trim() && !CONCEPT_EXCLUSION.has(item.text)).sort((a, b) => b.text.length - a.text.length);
}

// 决策 9.8.2：拉丁/数字缩写要求词边界，避免在英文单词内部误匹配
function searchConceptHasBoundary(text, index, patternText) {
  if (!/[A-Za-z0-9]/.test(patternText)) return true; // 纯中文词不做字母边界
  const before = text[index - 1];
  const after = text[index + patternText.length];
  const isWordChar = ch => ch !== undefined && /[A-Za-z0-9]/.test(ch);
  return !isWordChar(before) && !isWordChar(after);
}

function findSearchConcept(text, patterns) {
  const lower = text.toLocaleLowerCase('zh-CN');
  let best = null;
  patterns.forEach(pattern => {
    const patternLower = pattern.text.toLocaleLowerCase('zh-CN');
    let index = lower.indexOf(patternLower);
    while (index >= 0) {
      if (searchConceptHasBoundary(text, index, pattern.text)) {
        if (!best || index < best.index || (index === best.index && pattern.text.length > best.pattern.text.length)) {
          best = { index, pattern };
        }
        break;
      }
      index = lower.indexOf(patternLower, index + 1);
    }
  });
  return best;
}

// 决策 9.8：在指定可阅读正文容器内识别概念词（全站复用）；excludeTerm 用于概念详情自身
function markConceptsIn(root, excludeTerm = null) {
  if (!root || !glossary.length) return;
  let patterns = getSearchConceptPatterns();
  if (excludeTerm) patterns = patterns.filter(pattern => pattern.concept.term !== excludeTerm);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => isSearchConceptTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  nodes.forEach(node => {
    let remaining = node.nodeValue;
    const fragment = document.createDocumentFragment();
    let matched = false;
    while (remaining) {
      const found = findSearchConcept(remaining, patterns);
      if (!found) {
        fragment.append(document.createTextNode(remaining));
        break;
      }
      if (found.index) fragment.append(document.createTextNode(remaining.slice(0, found.index)));
      const value = remaining.slice(found.index, found.index + found.pattern.text.length);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'concept-link';
      button.dataset.searchConcept = found.pattern.concept.term;
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', value + '，查看概念解释');
      button.textContent = value;
      button.addEventListener('focus', () => openSearchConcept(button));
      // 决策 9.8.1：键盘 Enter 直接进入 AI 概念视图
      button.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        openGlossaryConcept(button.dataset.searchConcept);
      });
      fragment.append(button);
      remaining = remaining.slice(found.index + found.pattern.text.length);
      matched = true;
    }
    if (matched) node.replaceWith(fragment);
  });
}

function markSearchConcepts() {
  markConceptsIn(document.getElementById('searchResultsPanel'));
}

function positionSearchConceptPopover(trigger) {
  const popover = document.getElementById('searchConceptPopover');
  if (!popover || !trigger) return;
  const rect = trigger.getBoundingClientRect();
  const margin = 14;
  const width = Math.min(320, window.innerWidth - margin * 2);
  popover.style.width = width + 'px';
  popover.style.maxHeight = Math.max(160, window.innerHeight - margin * 2) + 'px';
  popover.style.left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)) + 'px';
  const height = Math.min(popover.offsetHeight, window.innerHeight - margin * 2);
  const below = rect.bottom + 6;
  const preferredTop = below + height <= window.innerHeight - margin ? below : rect.top - height - 6;
  popover.style.top = Math.max(margin, Math.min(preferredTop, window.innerHeight - height - margin)) + 'px';
}

function openSearchConcept(trigger) {
  const concept = glossary.find(item => item.term === trigger?.dataset.searchConcept);
  const popover = document.getElementById('searchConceptPopover');
  if (!concept || !popover) return;
  if (searchConceptRestoring) return; // 关闭回焦的 focus 不立即重新打开
  clearTimeout(searchConceptCloseTimer);
  if (searchConceptTrigger && searchConceptTrigger !== trigger) searchConceptTrigger.setAttribute('aria-expanded', 'false');
  searchConceptTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  document.getElementById('searchConceptTitle').textContent = concept.term;
  document.getElementById('searchConceptSummary').textContent = concept.summary;
  document.getElementById('searchConceptOpen').dataset.term = concept.term;
  popover.hidden = false;
  window.requestAnimationFrame(() => positionSearchConceptPopover(trigger));
}

function closeSearchConcept({ restoreFocus = false } = {}) {
  clearTimeout(searchConceptHoverTimer);
  clearTimeout(searchConceptCloseTimer);
  const popover = document.getElementById('searchConceptPopover');
  const trigger = searchConceptTrigger;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (popover) popover.hidden = true;
  searchConceptTrigger = null;
  if (restoreFocus && trigger?.isConnected) {
    searchConceptRestoring = true;
    trigger.focus();
    window.setTimeout(() => { searchConceptRestoring = false; }, 0);
  }
}

function scheduleSearchConceptOpen(trigger) {
  clearTimeout(searchConceptCloseTimer);
  clearTimeout(searchConceptHoverTimer);
  // 决策 9.8：桌面鼠标悬停约 2 秒后预览；键盘聚焦仍立即预览（不走此定时器）
  searchConceptHoverTimer = window.setTimeout(() => openSearchConcept(trigger), 2000);
}

function scheduleSearchConceptClose() {
  clearTimeout(searchConceptHoverTimer);
  clearTimeout(searchConceptCloseTimer);
  // 决策 9.8.3：允许鼠标从概念词移入解释框，小间隙不立即消失
  searchConceptCloseTimer = window.setTimeout(() => closeSearchConcept(), 250);
}

function openGlossaryConcept(term) {
  closeSearchConcept();
  const input = document.getElementById('glossarySearch');
  if (input) input.value = term;
  activeGlossaryCategory = 'all';
  activeGlossaryId = term;
  switchView('glossary');
  window.requestAnimationFrame(() => {
    const item = document.querySelector('.glossary-index-item[data-glossary-pick="' + CSS.escape(term) + '"]');
    item?.focus();
    item?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  });
}

function highlightSearchReference(element) {
  if (!element) return;
  element.classList.remove('reference-highlight');
  window.requestAnimationFrame(() => element.classList.add('reference-highlight'));
  window.setTimeout(() => element.classList.remove('reference-highlight'), 1400);
}

function focusSearchSource(sourceId, citation = null) {
  const source = document.querySelector('[data-search-source="' + CSS.escape(sourceId) + '"]');
  if (!source) return;
  if (citation) searchCitationOrigins.set(sourceId, citation);
  source.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  source.focus({ preventScroll: true });
  highlightSearchReference(source);
}

function focusSearchCitation(sourceId) {
  const citation = searchCitationOrigins.get(sourceId) || document.querySelector('[data-search-citation="' + CSS.escape(sourceId) + '"]');
  if (!citation) return;
  citation.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  citation.focus({ preventScroll: true });
  highlightSearchReference(citation.closest('[data-search-summary]'));
}

function renderSearchView() {
  const home = document.getElementById('searchHomePanel');
  const results = document.getElementById('searchResultsPanel');
  const queryTitle = document.getElementById('searchResultQuery');
  const readonly = document.getElementById('searchQueryReadonly');
  const editForm = document.getElementById('searchEditForm');
  const editInput = document.getElementById('searchEditInput');
  if (!home || !results || !queryTitle || !readonly || !editForm || !editInput) return;

  const showingResults = searchState.mode === 'results';
  home.hidden = showingResults;
  results.hidden = !showingResults;
  queryTitle.textContent = searchState.query;
  readonly.hidden = searchState.editing;
  editForm.hidden = !searchState.editing;
  if (searchState.editing) editInput.value = searchState.query;
  if (showingResults) renderSearchResults();
}

function showSearchResults() {
  searchState.mode = 'results';
  searchState.editing = false;
  renderSearchView();
  document.getElementById('searchResultQuery')?.focus?.();
  announceStatus('静态资料整理完成，正在查看当前问题。');
}

function returnToSearchHome() {
  resetSearchProcessing();
  searchState.mode = 'home';
  searchState.editing = false;
  const input = document.getElementById('aiSearchInput');
  if (input) input.value = searchState.query;
  renderSearchView();
  clearSearchEditState();
  input?.focus();
}

function clearSearchEditState() {
  const input = document.getElementById('searchEditInput');
  const status = document.getElementById('searchEditStatus');
  if (input) input.setAttribute('aria-invalid', 'false');
  if (status) status.textContent = '';
}

function startSearchEditing() {
  searchState.editing = true;
  clearSearchEditState();
  renderSearchView();
  const input = document.getElementById('searchEditInput');
  input?.focus();
  input?.select();
}

function cancelSearchEditing() {
  searchState.editing = false;
  clearSearchEditState();
  renderSearchView();
  document.getElementById('searchEditButton')?.focus();
}

function submitSearchEdit(query) {
  const normalizedQuery = String(query || '').trim();
  const input = document.getElementById('searchEditInput');
  const status = document.getElementById('searchEditStatus');
  clearSearchEditState();

  if (!normalizedQuery) {
    input?.setAttribute('aria-invalid', 'true');
    if (status) status.textContent = '请输入问题后再重新整理。';
    input?.focus();
    return false;
  }

  const matches = getSearchMatches(normalizedQuery);
  if (!matches.demoKey) {
    input?.setAttribute('aria-invalid', 'true');
    if (status) status.textContent = '暂无对应静态示例，请改为“写论文”“写代码”或“深度研究”。';
    input?.focus();
    return false;
  }

  searchState.query = normalizedQuery;
  searchState.demoKey = matches.demoKey;
  searchState.mode = 'home';
  searchState.editing = false;
  searchState.feedback = null;
  searchState.recent = [{ query: normalizedQuery, ts: Date.now() }, ...searchState.recent.filter(item => item.query !== normalizedQuery)].slice(0, 3);
  const homeInput = document.getElementById('aiSearchInput');
  if (homeInput) homeInput.value = normalizedQuery;
  renderSearchHome();
  renderSearchView();
  startSearchProcessing();
  return true;
}

function renderSearchProcessing() {
  const region = document.getElementById('searchProcessing');
  const list = document.getElementById('searchStageList');
  const cancel = document.getElementById('searchCancelProcessing');
  const input = document.getElementById('aiSearchInput');
  const submit = document.getElementById('aiSearchSubmit');
  if (!region || !list || !cancel) return;

  const visible = searchState.processing || searchState.processingStage !== null;
  region.hidden = !visible;
  region.setAttribute('aria-busy', String(searchState.processing));
  cancel.hidden = !searchState.processing;
  if (input) input.disabled = searchState.processing;
  if (submit) submit.disabled = searchState.processing;
  document.querySelectorAll('[data-search-example]').forEach(button => {
    button.disabled = searchState.processing;
  });
  list.innerHTML = SEARCH_PROCESSING_STAGES.map((label, index) => {
    let status = 'pending';
    if (typeof searchState.processingStage === 'number') {
      if (index < searchState.processingStage) status = 'complete';
      else if (index === searchState.processingStage) status = searchState.processing ? 'current' : 'complete';
    }
    return '<li class="search-stage" data-status="' + status + '"><span>' + escapeHtml(label) + '</span></li>';
  }).join('');
}

function finishSearchProcessing(runId) {
  if (runId !== searchProcessingRun || !searchState.processing) return;
  searchState.processing = false;
  searchState.processingStage = SEARCH_PROCESSING_STAGES.length - 1;
  searchState.lastQuery = searchState.query;
  renderSearchProcessing();
  const status = document.getElementById('searchFormStatus');
  if (status) status.textContent = '静态资料已整理完成，正在打开当前问题。';
  window.setTimeout(() => {
    if (runId === searchProcessingRun && !searchState.processing) showSearchResults();
  }, 0);
}

function startSearchProcessing() {
  const runId = ++searchProcessingRun;
  clearTimeout(searchProcessingTimer);
  searchState.processing = true;
  searchState.processingStage = 0;
  searchMatchExpanded.clear();
  renderSearchProcessing();

  const status = document.getElementById('searchFormStatus');
  if (status) status.textContent = '正在整理固定静态示例。';

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) {
    searchState.processingStage = SEARCH_PROCESSING_STAGES.length - 1;
    finishSearchProcessing(runId);
    return;
  }

  // 决策 7.1：重复提交相同示例时不强制重复长等待
  if (searchState.lastQuery === searchState.query) {
    searchState.processingStage = SEARCH_PROCESSING_STAGES.length - 1;
    finishSearchProcessing(runId);
    return;
  }

  const advance = () => {
    if (runId !== searchProcessingRun || !searchState.processing) return;
    if (searchState.processingStage >= SEARCH_PROCESSING_STAGES.length - 1) {
      finishSearchProcessing(runId);
      return;
    }
    searchState.processingStage += 1;
    renderSearchProcessing();
    searchProcessingTimer = window.setTimeout(advance, 450);
  };
  searchProcessingTimer = window.setTimeout(advance, 450);
}

function resetSearchProcessing() {
  searchProcessingRun += 1;
  clearTimeout(searchProcessingTimer);
  searchProcessingTimer = null;
  searchState.processing = false;
  searchState.processingStage = null;
  renderSearchProcessing();
}

function cancelSearchProcessing() {
  if (!searchState.processing) return;
  resetSearchProcessing();
  const status = document.getElementById('searchFormStatus');
  if (status) status.textContent = '已中止静态资料整理，可以修改问题或重新开始。';
  document.getElementById('aiSearchInput')?.focus();
}

function submitSearchHome(query) {
  const normalizedQuery = String(query || '').trim();
  const input = document.getElementById('aiSearchInput');
  const status = document.getElementById('searchFormStatus');
  const emptyState = document.getElementById('searchEmptyState');
  const unsupportedState = document.getElementById('searchUnsupportedState');
  clearSearchHomeStates();

  if (!normalizedQuery) {
    resetSearchProcessing();
    input?.setAttribute('aria-invalid', 'true');
    if (emptyState) emptyState.hidden = false;
    if (status) status.textContent = '请输入问题后再开始整理。';
    input?.focus();
    return false;
  }

  const matches = getSearchMatches(normalizedQuery);
  searchState.query = normalizedQuery;
  searchState.demoKey = matches.demoKey;
  searchState.mode = 'home';

  if (!matches.demoKey) {
    resetSearchProcessing();
    if (unsupportedState) unsupportedState.hidden = false;
    if (status) status.textContent = '暂无对应静态示例，请改写问题。';
    return false;
  }

  searchState.feedback = null;
  searchState.recent = [{ query: normalizedQuery, ts: Date.now() }, ...searchState.recent.filter(item => item.query !== normalizedQuery)].slice(0, 3);
  renderSearchHome();
  startSearchProcessing();
  return true;
}

// ═══════════════════════════════════════════════════════════════
// 第 1 部分：通用工具函数
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

// ═══════════════════════════════════════════════════════════════
// 第 2 部分：数据加载
// ═══════════════════════════════════════════════════════════════

// 决策 100：对比上限/类型冲突的页面内提示（aria-live，短暂显示后自动清除）
let compareStatusTimer = null;
function setCompareStatus(message) {
  const el = document.getElementById('compareStatus');
  if (!el) return;
  el.textContent = message;
  clearTimeout(compareStatusTimer);
  compareStatusTimer = window.setTimeout(() => { el.textContent = ''; }, 4000);
}

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
// 第 3 部分：视图切换
// ═══════════════════════════════════════════════════════════════

/**
 * 切换当前显示的视图。
 * 实现方式：通过 CSS class .view.active 控制显隐（非路由），
 * 切换后触发对应视图的渲染函数（首次渲染或重新渲染）。
 * 1. 先清 → 所有面板消失，按钮变灰
 * 2. 再加 → 新面板出现，新按钮高亮
 * 3. 再渲染 → 往面板里填数据
 *
 * EXTENSION POINT: 新增视图时在末尾加 if (view === 'xxx') renderXxx();
 */
function closeMobileNav({ restoreFocus = false } = {}) {
  const menuToggle = document.getElementById('menuToggle');
  const mobileNav = document.getElementById('mobileNav');
  if (!menuToggle || !mobileNav) return;
  mobileNav.hidden = true;
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', '打开导航菜单');
  if (restoreFocus) menuToggle.focus();
}

function openMobileNav() {
  const menuToggle = document.getElementById('menuToggle');
  const mobileNav = document.getElementById('mobileNav');
  if (!menuToggle || !mobileNav) return;
  mobileNav.hidden = false;
  menuToggle.setAttribute('aria-expanded', 'true');
  menuToggle.setAttribute('aria-label', '关闭导航菜单');
}

// B16 决策 83：桌面分组下拉菜单的视图归属映射（父级菜单联动当前状态）
const VIEW_GROUPS = {
  discover: ['tools', 'scenes', 'compare', 'featured'],
  knowledge: ['trending', 'glossary']
};

function closeAllNavDropdowns() {
  document.querySelectorAll('.nav-dropdown-menu').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll('.nav-dropdown .nav-trigger').forEach(trigger => trigger.setAttribute('aria-expanded', 'false'));
}

function syncNavigationState(view) {
  document.querySelectorAll('[data-view]').forEach(control => {
    const isActive = control.dataset.view === view;
    control.classList.toggle('active', isActive);
    if (isActive) control.setAttribute('aria-current', 'page');
    else control.removeAttribute('aria-current');
  });
  // 决策 83：当前位于子页面时，父级下拉菜单显示当前状态
  document.querySelectorAll('.nav-dropdown').forEach(dropdown => {
    const trigger = dropdown.querySelector('.nav-trigger');
    if (!trigger) return;
    const groupKey = dropdown.dataset.group;
    trigger.classList.toggle('active', Boolean(groupKey && VIEW_GROUPS[groupKey]?.includes(view)));
  });
}

function switchView(view) {
  const target = document.getElementById('view-' + view);
  if (!target) return;

  currentView = view;
  const mobilePageTitle = document.getElementById('mobileCurrentPage');
  if (mobilePageTitle && VIEW_TITLES[view]) mobilePageTitle.textContent = VIEW_TITLES[view];
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  target.classList.add('active');
  syncNavigationState(view);
  closeMobileNav();
  announceStatus((target.querySelector('h1')?.textContent || '页面') + '已显示');

  if (view === 'scenes') renderScenes();
  if (view === 'compare') renderCompare();
  if (view === 'tools') renderTools();
  if (view === 'glossary') renderGlossary();
  if (view === 'trending') renderTrending();
  if (view === 'featured') renderFeatured();
}

// ═══════════════════════════════════════════════════════════════
// 第 4 部分：工具库 —— 搜索、筛选、卡片和详情
// ═══════════════════════════════════════════════════════════════

/**
 * 工具搜索与筛选（两阶段过滤 + AND 叠加）。
 * 阶段 1: 文本搜索（标题/描述/标签/别名关键词 OR 匹配）
 * 阶段 2: 三维 chip 筛选叠加（分类 AND 访问 AND 价格）
 *
 * EXTENSION POINT: 新增筛选维度时在阶段 2 末尾按同样模式加 if (activeFilters.xxx !== 'all')
 * EXTENSION POINT: 方案一——>方案三变迁中时，设置特殊窗口显示的属性，在特殊窗口搜索时才会显示
 */
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

function compareKey(ref) {
  return ref.toolId + '::' + (ref.itemId || 'root');
}

function isComparableRootTool(tool) {
  return Boolean(tool && tool.card_kind === 'concrete');
}

function isComparableLeaf(toolId, itemId) {
  const item = getCollectionNode(toolId, itemId);
  return Boolean(item && item.node_type === 'leaf' && item.display_in_tree !== false);
}

function isCompareSelected(toolId, itemId = null) {
  return compareList.some(ref => compareKey(ref) === compareKey({ toolId, itemId }));
}

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

/**
 * 渲染工具卡片网格。
 * 1. 获取过滤后的工具列表
 * 2. 更新工具计数和筛选提示
 * 3. 空结果时显示空状态占位
 * 4. 正常结果时渲染卡片（名称/图标/评分/场景标签/价格/访问/对比按钮）
 *
 * 注意：对比按钮在卡片 DOM 字符串中使用了 onclick 属性;
 * event.stopPropagation() 防止点击对比按钮同时触发卡片的 openDetail。
 * EXTENSION POINT: 方案一——>方案三变迁中时，实现在对比页面也能自定义添加工具
 * EXTENSION POINT: 方案一——>方案三变迁中时，卡片实现动态效果-描述：默认显示工具大头照，悬停时工具照向左迁移，右边显示简略的信息，点击进入详情
 */
// 决策 94：工具库已选筛选条件的低权重标签与一键清除
function renderSelectedFilters() {
  const section = document.getElementById('toolsSelected');
  const tagEl = document.getElementById('toolsSelectedTags');
  if (!section || !tagEl) return;
  const tags = [];
  if (activeFilters.category !== 'all') tags.push('分类：' + activeFilters.category);
  if (activeFilters.access !== 'all') tags.push('访问：' + (activeFilters.access === '开放' ? '国内可访问' : '需科学上网'));
  if (activeFilters.price !== 'all') tags.push(activeFilters.price === 'free' ? '价格：有免费层' : '价格：仅付费');
  section.hidden = tags.length === 0;
  tagEl.innerHTML = tags.map(tag => '<span class="tag">' + escapeHtml(tag) + '</span>').join('');
}

function clearToolFilters() {
  activeFilters = { category: 'all', access: 'all', price: 'all' };
  document.querySelectorAll('.tools-filters .filter-chip').forEach(chip => {
    const isAll = (chip.dataset.category || chip.dataset.access || chip.dataset.price) === 'all';
    chip.classList.toggle('active', isAll);
    chip.setAttribute('aria-pressed', String(isAll));
  });
  renderSelectedFilters();
  renderTools();
}

function renderTools() {
  const filtered = getFilteredTools();
  const grid = document.getElementById('toolGrid');
  setRegionBusy(grid, false);
  renderSelectedFilters();
  document.getElementById('toolCount').textContent = filtered.length;
  document.getElementById('filteredInfo').style.display =
    (activeFilters.category !== 'all' || activeFilters.access !== 'all' || activeFilters.price !== 'all' || document.getElementById('searchInput').value)
    ? 'inline' : 'none';

  if (dataLoadFailures.has('tools')) {
    grid.innerHTML = renderState({ icon: '⚠️', title: '工具数据加载失败', message: '请刷新页面重试；若问题持续，请检查公开工具数据文件是否可访问。', type: 'error' });
    return;
  }

  if (filtered.length === 0) {
    grid.innerHTML = renderState({ icon: '⌕', title: '没有匹配的工具', message: '请调整筛选条件或更换搜索关键词。', type: 'no-match' });
    return;
  }

  grid.innerHTML = filtered.map(t => {
    const intelligence = getToolIntelligence(t.id);
    const collectionItems = (intelligence?.items || []).filter(item => item.node_type !== 'group' && item.display_in_tree !== false);
    const isCollection = t.card_kind === 'collection';
    const overview = t.overview;
    const title = isCollection ? t.vendor + '（' + t.name + '）' : t.name;
    const description = isCollection
      ? (overview?.description || t.strengths)
      : t.strengths;
    const collectionSummary = isCollection
      ? '<div class="collection-summary"><span class="collection-label">厂商模型与工具</span><span>' + collectionItems.length + ' 个可查看叶节点</span></div>' +
        '<div class="collection-quick-list">' + (intelligence?.tree_mode === 'tree'
          ? (intelligence.items || []).filter(item => item.node_type === 'group').slice(0, 3).map(item =>
              '<button type="button" onclick="event.stopPropagation();openDetail(\'' + escapeHtml(t.id) + '\',\'' + escapeHtml(item.id) + '\')">' + escapeHtml(item.name) + '</button>'
            ).join('')
          : collectionItems.slice(0, 5).map(item =>
              '<button type="button" onclick="event.stopPropagation();openDetail(\'' + escapeHtml(t.id) + '\',\'' + escapeHtml(item.id) + '\')">' + escapeHtml(item.name) + '</button>'
            ).join('')) + '</div>'
      : '';
    const featurePreview = isCollection && overview?.features?.length
      ? '<div class="vendor-feature-preview">' + overview.features.map(feature =>
          '<span class="vendor-feature ' + escapeHtml(feature.tone) + '">' + escapeHtml(feature.text) + '</span>'
        ).join('') + '</div>'
      : '';
    const isSelected = isCompareSelected(t.id, null);
    return `
    <div class="tool-card${isCollection ? ' collection-card' : ''}" onclick="openDetail('${t.id}',null,this)">
      <div class="tool-card-header">
        <div>
          <div class="tool-card-name">${t.icon} ${escapeHtml(title)}</div>
          <div class="tool-card-vendor">${isCollection ? '厂商总览' : escapeHtml(t.vendor)}</div>
        </div>
        ${isCollection ? '' : '' /* 决策 98：工具卡片默认区不显示评分，评分保留在详情模态 */}
      </div>

      <div class="tool-card-desc">${escapeHtml(description)}</div>
      ${featurePreview}
      ${collectionSummary}
      <div class="tool-card-tags">
        ${t.scenes.slice(0,3).map(s => '<span class="tag scene">' + escapeHtml(s) + '</span>').join('')}
        ${isCollection ? '' : (hasFree(t) ? '<span class="tag free">免费可用</span>' : '<span class="tag paid">仅付费</span>')}
        <span class="tag ${t.access_level === '开放' ? 'open' : 'restricted'}">${t.access_level === '开放' ? '国内可用' : '需科学上网'}</span>
      </div>

      <div class="tool-card-footer" onclick="event.stopPropagation()">
        <span style="font-size:12px;color:var(--text-hint)">资料更新于 ${escapeHtml(t.last_updated)}</span>
        <div class="tool-card-actions">
          <button class="detail-button" type="button" onclick="openDetail('${escapeHtml(t.id)}',null,this)">查看详情</button>
          ${isComparableRootTool(t) ? '<button class="compare-toggle ' + (isSelected ? 'selected' : '') + '" aria-pressed="' + isSelected + '" onclick="toggleCompareRef(\'' + escapeHtml(t.id) + '\',null,this)">' + (isSelected ? '已选' : '+对比') + '</button>' : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

/**
 * 打开工具详情弹窗。
 * 渲染完整的工具信息：评分、价格层级、优势/不足、最适/不适合场景、
 * 信息来源和更新日期。支持点击遮罩层关闭。
 */
function formatPrice(value, currency) {
  if (value === null || value === undefined) return '未提供';
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : currency + ' ';
  return symbol + Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
}

function renderScenarioExplanations(title, items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return '<div class="intelligence-scenarios"><h5>' + title + '</h5>' + items.map(item =>
    '<div><b>' + escapeHtml(item.title) + '：</b>' + escapeHtml(item.description) + '</div>'
  ).join('') + '</div>';
}

function renderIntelligenceItem(item, sourceMap, selectedItemId, toolId) {
  const latestQ = (item.source_refs || []).map(ref => sourceMap.get(ref)).filter(Boolean).map(s => s.queried_at).filter(Boolean).sort().reverse()[0] || null;
  const badge = renderTimelinessBadge(latestQ);
  return '<details class="intelligence-item"' + (item.id === selectedItemId ? ' open' : '') + '>' +
    '<summary><span><b>' + escapeHtml(item.name) + '</b><small>' + escapeHtml(item.kind === 'api_model' ? 'API 模型' : item.kind === 'subscription_plan' ? '订阅套餐' : '产品变体') + '</small>' + badge + '</span><span>查看详情</span></summary>' +
    '<div class="intelligence-item-body">' + renderLeafDetails(item, sourceMap, toolId ? { toolId } : false) + '</div></details>';
}

function renderLeafDetails(item, sourceMap, showCompare) {
  const contextLabels = { native: '原生支持 1M', conditional: '特定条件支持 1M', not_supported: '不支持 1M', unknown: '1M 支持情况未知' };
  const context = item.one_m_context;
  const contextHtml = context
    ? '<div class="intelligence-context"><b>1M 上下文：</b>' + escapeHtml(contextLabels[context.status] || '未知') +
      (context.tokens ? '（' + Number(context.tokens).toLocaleString('zh-CN') + ' tokens）' : '') +
      (context.conditions ? '<p>' + escapeHtml(context.conditions) + '</p>' : '') + '</div>'
    : '';
  const rateCards = item.api_pricing?.rate_cards || [];
  const pricingHtml = rateCards.length
    ? '<div class="intelligence-pricing"><h5>API 价格</h5>' + rateCards.map(rate =>
      '<div class="rate-card"><b>' + escapeHtml(rate.label) + '</b>' +
      '<div class="rate-grid"><span>输入（缓存命中）<strong>' + formatPrice(rate.input_cached, rate.currency) + '</strong></span>' +
      '<span>输入（缓存未命中）<strong>' + formatPrice(rate.input_uncached, rate.currency) + '</strong></span>' +
      '<span>输出<strong>' + formatPrice(rate.output, rate.currency) + '</strong></span></div>' +
      '<small>单位：每百万 tokens · ' + escapeHtml(rate.conditions) + '</small></div>'
    ).join('') + '</div>'
    : '';
  const cacheHtml = item.kind === 'api_model' && item.cache_hit_rate?.status === 'provided'
    ? '<div class="cache-status"><b>平均缓存命中率区间：</b>' +
      escapeHtml(item.cache_hit_rate.min_percent + '%–' + item.cache_hit_rate.max_percent + '%') + '</div>'
    : '';
  const plan = item.plan;
  const planHtml = plan
    ? '<div class="plan-card"><h5>套餐信息</h5><p><b>' + formatPrice(plan.amount, plan.currency) +
      ' / ' + escapeHtml({ month: '月', year: '年', usage: '按量', custom: '定制', unknown: '周期未知' }[plan.billing_period] || plan.billing_period) +
      '</b></p><p>' + escapeHtml(plan.conditions || '') + '</p><p><b>主要模型：</b>' +
      (plan.included_models.length ? plan.included_models.map(escapeHtml).join('、') : '官方未明确列出全部模型') + '</p></div>'
    : '';
  const sources = (item.source_refs || []).map(ref => sourceMap.get(ref)).filter(Boolean);
  const latestQueriedAt = sources.map(s => s.queried_at).filter(Boolean).sort().reverse()[0] || null;
  const sourcesHtml = '<div class="intelligence-sources"><b>资料来源：</b>' + sources.map(source =>
    '<a href="' + escapeHtml(safeExternalUrl(source.url)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(source.title) + '</a>'
  ).join(' · ') + (latestQueriedAt ? '<span>查询于 ' + escapeHtml(latestQueriedAt.slice(0, 10)) + '</span>' : '') + '</div>';
  const compareHtml = showCompare
    ? '<div class="leaf-actions"><button class="compare-toggle ' + (isCompareSelected(showCompare.toolId, item.id) ? 'selected' : '') + '" onclick="toggleCompareRef(\'' + escapeHtml(showCompare.toolId) + '\',\'' + escapeHtml(item.id) + '\',this)">' + (isCompareSelected(showCompare.toolId, item.id) ? '已选' : '+对比') + '</button></div>'
    : '';
  return '<p>' + escapeHtml(item.summary || '') + '</p>' + contextHtml + pricingHtml + cacheHtml + planHtml +
    renderScenarioExplanations('适用场景及说明', item.applicable_scenarios) +
    renderScenarioExplanations('不适用场景及说明', item.inapplicable_scenarios) + sourcesHtml + compareHtml;
}

function renderCollectionIntelligence(tool, selectedItemId) {
  const collection = getToolIntelligence(tool.id);
  if (!collection) {
    return tool.card_kind === 'collection'
      ? '<div class="intelligence-unavailable">具体型号资料暂不可用；不会根据品牌名称自动推测推荐。</div>'
      : '';
  }
  const sourceMap = new Map((collection.sources || []).map(source => [source.id, source]));
  const statusText = { verified: '已核实', partial: '部分核实', conflict: '资料冲突', unavailable: '资料不可用' }[collection.status] || collection.status;
  const displayItems = (collection.items || []).filter(item => item.node_type !== 'group');
  return '<div class="section intelligence-section"><div class="intelligence-heading"><h4>当前具体模型与套餐</h4><span class="intelligence-status status-' + escapeHtml(collection.status) + '">' + escapeHtml(statusText) + '</span></div>' +
    displayItems.map(item => renderIntelligenceItem(item, sourceMap, selectedItemId, tool.id)).join('') + '</div>';
}

function renderVendorFeatures(tool) {
  const features = tool.overview?.features?.length
    ? tool.overview.features
    : [
      { tone: 'positive', text: '优点：' + tool.strengths },
      { tone: 'negative', text: '限制：' + tool.weaknesses }
    ];
  return '<section class="vendor-features"><h4>特点</h4>' + features.map(feature =>
    '<p class="vendor-feature ' + (feature.tone === 'negative' ? 'negative' : 'positive') + '">' + escapeHtml(feature.text) + '</p>'
  ).join('') + '</section>';
}

function getTreeChildren(collection, parentId) {
  return (collection.items || []).filter(item => item.parent_id === parentId && item.display_in_tree !== false);
}

function getLeafDescendants(collection, parentId) {
  return getTreeChildren(collection, parentId).flatMap(node =>
    node.node_type === 'leaf' ? [node] : getLeafDescendants(collection, node.id)
  );
}

function getNodePath(collection, node) {
  const path = [];
  let current = node;
  while (current) {
    path.unshift(current);
    current = current.parent_id ? getCollectionNode(collection.tool_id, current.parent_id) : null;
  }
  return path;
}

function renderModelBreadcrumb(toolId, collection, node) {
  const nodes = node ? getNodePath(collection, node) : [];
  return '<div class="model-breadcrumb"><button type="button" onclick="navigateModelToolPanel(\'' + escapeHtml(toolId) + '\',null)">模型与工具</button>' +
    nodes.map((part, index) => '<span>›</span><button type="button"' + (index === nodes.length - 1 ? ' aria-current="page"' : '') + ' onclick="navigateModelToolPanel(\'' + escapeHtml(toolId) + '\',\'' + escapeHtml(part.id) + '\')">' + escapeHtml(part.name) + '</button>').join('') +
  '</div>';
}

function getNodeStatusLabel(status) {
  return { active: '已核实', partial: '部分核实', unknown: '官方资料待核验', legacy_supported: '仍受支持', deprecated: '已弃用', retired: '已停用' }[status] || '资料状态未知';
}

function renderTreeChildren(toolId, collection, parentId, options = {}) {
  const children = getTreeChildren(collection, parentId);
  const parent = parentId ? getCollectionNode(toolId, parentId) : null;
  const leaves = parent ? getLeafDescendants(collection, parent.id) : [];
  const comparableLeaves = leaves.filter(item => item.node_type === 'leaf' && ['api_model', 'subscription_plan'].includes(item.kind));
  const sameKind = comparableLeaves.length > 1 && comparableLeaves.every(item => item.kind === comparableLeaves[0].kind);
  const groupCompare = sameKind
    ? '<button class="model-bulk-compare" type="button" onclick="compareGroupLeaves(\'' + escapeHtml(toolId) + '\',\'' + escapeHtml(parent.id) + '\')">全部' + escapeHtml(comparableLeaves[0].kind === 'api_model' ? '模型' : '套餐') + '对比（' + comparableLeaves.length + '）</button>'
    : '';
  if (!children.length) {
    return '<div class="intelligence-unavailable"><b>' + escapeHtml(parent?.name || '当前分类') + '</b>：' +
      (parent?.status === 'unknown' ? '官方资料待核验，暂不展示未经证实的子项、价格或权益。' : '当前没有可展示的已核实子项。') + '</div>';
  }
  const heading = options.showHeading === false ? '' :
    '<div class="model-panel-heading"><div><h4>' + escapeHtml(parent?.name || '模型与工具') + '</h4><p>' + escapeHtml(parent?.summary || '选择分类继续查看，只有最终叶节点可比较。') + '</p></div>' + groupCompare + '</div>';
  const compareOnly = options.showHeading === false && groupCompare
    ? '<div class="model-tree-actions">' + groupCompare + '</div>'
    : '';
  return heading + compareOnly + '<div class="model-tree-grid">' + children.map(item => {
    const isLeaf = item.node_type === 'leaf';
    const treeBadge = isLeaf ? renderTimelinessBadge(getItemLatestQueriedAt(collection, item)) : '';
    return '<button class="model-tree-card' + (isLeaf ? ' leaf' : '') + '" type="button" onclick="navigateModelToolPanel(\'' + escapeHtml(toolId) + '\',\'' + escapeHtml(item.id) + '\')">' +
      '<span class="node-kind-badge ' + (isLeaf ? 'leaf' : 'group') + '">' + (isLeaf ? '具体' : '分类') + '</span>' +
      '<strong>' + escapeHtml(item.name) + '</strong>' + treeBadge + '<p>' + escapeHtml(item.summary || '') + '</p>' +
      '<small class="intelligence-status status-' + escapeHtml(item.status === 'unknown' ? 'partial' : item.status) + '">' + escapeHtml(getNodeStatusLabel(item.status)) + '</small>' +
      '<span class="model-tree-action">' + (isLeaf ? '查看数据面板' : '进入分类') + ' ›</span></button>';
  }).join('') + '</div>';
}

function renderNodeOverview(tool, node) {
  return '<section class="node-overview">' +
    '<h2>' + escapeHtml(tool.icon + ' ' + node.name) + '</h2>' +
    '<div class="vendor">' + escapeHtml(tool.vendor) + ' · <a href="' + escapeHtml(safeExternalUrl(node.official_url)) + '" target="_blank" rel="noopener noreferrer">官网 ' + ICON_EXTERNAL + '</a></div>' +
    '<p class="node-description">' + escapeHtml(node.summary || '暂无简短说明。') + '</p>' +
  '</section>';
}

function renderOpenAIDetailBody(toolId, nodeId = null) {
  const tool = tools.find(item => item.id === toolId);
  const collection = getToolIntelligence(toolId);
  const node = nodeId ? getCollectionNode(toolId, nodeId) : null;
  if (!tool || !collection || (nodeId && !node)) return '<div class="intelligence-unavailable">该模型或工具节点不存在。</div>';

  if (!node) {
    return '<section class="openai-root">' +
      '<h2>' + escapeHtml(tool.icon + ' ' + tool.vendor + '（' + tool.name + '）') + '</h2>' +
      '<div class="vendor">厂商总览 · <a href="' + escapeHtml(safeExternalUrl(tool.url)) + '" target="_blank" rel="noopener noreferrer">官网 ' + ICON_EXTERNAL + '</a></div>' +
      renderModelBreadcrumb(toolId, collection, null) +
      '<p class="vendor-description">' + escapeHtml(tool.overview?.description || tool.strengths) + '</p>' +
      renderVendorFeatures(tool) +
      '<section class="model-tool-panel"><div class="intelligence-heading"><h3>模型与工具</h3><span class="intelligence-status status-' + escapeHtml(collection.status) + '">' + escapeHtml({ verified: '已核实', partial: '部分核实', conflict: '资料冲突', unavailable: '资料不可用' }[collection.status] || collection.status) + '</span></div>' +
      renderTreeChildren(toolId, collection, null, { showHeading: false }) +
      '</section></section>';
  }

  const breadcrumbs = renderModelBreadcrumb(toolId, collection, node);
  if (node.node_type === 'leaf') {
    const sourceMap = new Map((collection.sources || []).map(source => [source.id, source]));
    const leafBadge = renderTimelinessBadge(getItemLatestQueriedAt(collection, node));
    return renderNodeOverview(tool, node) + breadcrumbs +
      '<div class="model-leaf-panel"><div class="model-panel-heading"><div><span class="node-kind-badge leaf">具体' + escapeHtml(node.kind === 'api_model' ? '模型' : node.kind === 'subscription_plan' ? '套餐' : '工具') + '</span><h4>' + escapeHtml(node.name) + '</h4>' + leafBadge + '</div><button class="back-panel-button" type="button" onclick="goBackModelToolPanel(\'' + escapeHtml(toolId) + '\')">' + ICON_ARROW_LEFT + ' 返回</button></div>' +
      '<div class="intelligence-item-body">' + renderLeafDetails(node, sourceMap, { toolId }) + '</div></div>';
  }

  return renderNodeOverview(tool, node) + breadcrumbs +
    '<section class="model-tool-panel"><div class="intelligence-heading"><h3>模型与工具</h3><span class="intelligence-status status-' + escapeHtml(node.status === 'unknown' ? 'partial' : node.status) + '">' + escapeHtml(getNodeStatusLabel(node.status)) + '</span></div>' +
    renderTreeChildren(toolId, collection, node.id, { showHeading: false }) +
    '</section>';
}

function renderLeafPanel(toolId, collection, leaf) {
  const sourceMap = new Map((collection.sources || []).map(source => [source.id, source]));
  const leafBadge = renderTimelinessBadge(getItemLatestQueriedAt(collection, leaf));
  return '<div class="model-leaf-panel"><div class="model-panel-heading"><div><span class="node-kind-badge leaf">具体' + escapeHtml(leaf.kind === 'api_model' ? '模型' : leaf.kind === 'subscription_plan' ? '套餐' : '工具') + '</span><h4>' + escapeHtml(leaf.name) + '</h4>' + leafBadge + '</div><button class="back-panel-button" type="button" onclick="goBackModelToolPanel(\'' + escapeHtml(toolId) + '\')">' + ICON_ARROW_LEFT + ' 返回</button></div>' +
    '<div class="intelligence-item-body">' + renderLeafDetails(leaf, sourceMap, { toolId }) + '</div></div>';
}

function navigateModelToolPanel(toolId, nodeId = null) {
  detailPanelState.set(toolId, nodeId);
  const body = document.getElementById('openaiDetailBody');
  if (body) {
    body.innerHTML = renderOpenAIDetailBody(toolId, nodeId);
    configureModalAccessibility();
  }
}

function goBackModelToolPanel(toolId) {
  const node = getCollectionNode(toolId, detailPanelState.get(toolId));
  navigateModelToolPanel(toolId, node?.parent_id || null);
}

function getModalFocusableElements() {
  const content = document.getElementById('modalContent');
  if (!content) return [];
  return [...content.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.hidden && element.getClientRects().length > 0);
}

function configureModalAccessibility() {
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
  const title = content?.querySelector('h2');
  const description = content?.querySelector('.vendor-description, .node-description, .vendor, .section p');
  if (!overlay || !content) return;
  if (title) title.id = 'modalTitle';
  if (description) {
    description.id = 'modalDescription';
    overlay.setAttribute('aria-describedby', 'modalDescription');
  } else {
    overlay.removeAttribute('aria-describedby');
  }
}

function showModal(trigger = null) {
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
  if (!overlay || !content) return;
  const explicitTrigger = trigger instanceof HTMLElement
    ? (trigger.matches('a[href], button, [tabindex]:not([tabindex="-1"])') ? trigger : trigger.querySelector('button, a[href], [tabindex]:not([tabindex="-1"])'))
    : null;
  modalTrigger = explicitTrigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  configureModalAccessibility();
  overlay.hidden = false;
  document.body.classList.add('modal-open');
  const focusTarget = content.querySelector('.modal-close') || content;
  focusTarget.focus();
}

function openDetail(id, selectedItemId = null, trigger = null) {
  const t = tools.find(tool => tool.id === id);
  if (!t) return;
  const collection = getToolIntelligence(id);
  const content = document.getElementById('modalContent');
  if (t.card_kind === 'collection' && collection?.tree_mode === 'tree') {
    content.innerHTML = '<button class="modal-close" type="button" aria-label="关闭详情" onclick="closeModal()">' + ICON_CLOSE + '</button>' +
      '<div id="openaiDetailBody" class="openai-detail"></div>';
    navigateModelToolPanel(id, selectedItemId);
    showModal(trigger);
    return;
  }

  // 决策 90：具体工具模态提供“加入对比”与“打开工具页面”
  const rootComparable = isComparableRootTool(t);
  const rootSelected = rootComparable && isCompareSelected(t.id, null);
  content.innerHTML = `
    <button class="modal-close" type="button" aria-label="关闭详情" onclick="closeModal()">${ICON_CLOSE}</button>
    <h2>${escapeHtml(t.icon + ' ' + t.name)}</h2>
    <div class="vendor">${escapeHtml(t.vendor)} · <a href="${escapeHtml(safeExternalUrl(t.url))}" target="_blank" rel="noopener noreferrer">官网 ${ICON_EXTERNAL}</a></div>
    ${renderCollectionIntelligence(t, selectedItemId)}
    <div class="scores">
      <div class="score-item"><div class="score-val ${scoreClass(t.rating_overall)}">${t.rating_overall.toFixed(1)}</div><div class="score-label">综合</div></div>
      <div class="score-item"><div class="score-val ${scoreClass(t.rating_chinese)}">${t.rating_chinese.toFixed(1)}</div><div class="score-label">中文支持</div></div>
      <div class="score-item"><div class="score-val ${scoreClass(t.rating_ease)}">${t.rating_ease.toFixed(1)}</div><div class="score-label">易用性</div></div>
      <div class="score-item"><div class="score-val ${scoreClass(t.rating_price)}">${t.rating_price.toFixed(1)}</div><div class="score-label">性价比</div></div>
    </div>
    <div class="section"><h4>适用场景</h4><div class="tool-card-tags">${t.scenes.map(s => '<span class="tag scene">' + escapeHtml(s) + '</span>').join(' ')}</div></div>
    <div class="section"><h4>价格</h4><p><b>免费层：</b>${escapeHtml(t.free_tier || '无')}</p>${t.paid_tiers.map(p => '<p style="margin-top:4px"><b>' + escapeHtml(p.name) + '：</b>' + escapeHtml(p.price) + ' — ' + escapeHtml(p.features) + '</p>').join('')}</div>
    <div class="section"><h4>优势</h4><p>${escapeHtml(t.strengths)}</p></div>
    <div class="section"><h4>不足</h4><p>${escapeHtml(t.weaknesses)}</p></div>
    <div class="section"><h4>适用场景及说明</h4><ul>${t.best_for.map(b => '<li>' + escapeHtml(b) + '</li>').join('')}</ul></div>
    <div class="section"><h4>不适用场景及说明</h4><ul>${t.not_for.map(n => '<li>' + escapeHtml(n) + '</li>').join('')}</ul></div>
    <div class="section"><h4>访问门槛</h4><p>${escapeHtml(t.access_barrier)}</p>${t.chinese_note ? '<p style="margin-top:4px"><b>中文支持：</b>' + escapeHtml(t.chinese_note) + '</p>' : ''}</div>
    ${rootComparable ? '<div class="modal-actions">' +
      '<button class="btn compare-toggle ' + (rootSelected ? 'selected' : '') + '" type="button" aria-pressed="' + rootSelected + '" onclick="toggleCompareRef(\'' + escapeHtml(t.id) + '\',null,this)">' + (rootSelected ? '已加入对比' : '加入对比') + '</button>' +
      '<a class="btn" href="' + escapeHtml(safeExternalUrl(t.url)) + '" target="_blank" rel="noopener noreferrer">打开工具页面</a>' +
    '</div>' : ''}
    <div class="meta">资料更新于 ${escapeHtml(t.last_updated)} · 信息来源: <a href="${escapeHtml(safeExternalUrl(t.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.source)}</a> · 利益声明: 不接收厂商赞助</div>
  `;
  showModal(trigger);
}

function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  document.body.classList.remove('modal-open');
  const returnTarget = modalTrigger;
  const scrollPosition = modalScrollPosition;
  modalTrigger = null;
  modalScrollPosition = null;
  if (scrollPosition !== null) window.scrollTo({ top: scrollPosition, behavior: 'auto' });
  if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
}

document.getElementById('modalOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

document.getElementById('modalOverlay').addEventListener('click', function(event) {
  const related = event.target.closest('[data-hotspot-related-type]');
  if (related) {
    const type = related.dataset.hotspotRelatedType;
    const id = related.dataset.hotspotRelatedId;
    const itemId = related.dataset.hotspotRelatedItem || null;
    closeModal();
    if (type === 'tools') {
      switchView('tools');
      window.requestAnimationFrame(() => openDetail(id, itemId));
    } else if (type === 'concepts') {
      openGlossaryConcept(id);
    } else if (type === 'scenes') {
      const input = document.getElementById('sceneSearch');
      if (input) input.value = '';
      activeSceneId = id;
      switchView('scenes');
      window.requestAnimationFrame(() => document.querySelector('.scene-pick-chip[data-scene-pick="' + CSS.escape(id) + '"]')?.focus());
    }
    return;
  }
  const toggle = event.target.closest('[data-hotspot-source-toggle]');
  if (!toggle) return;
  const detail = document.getElementById(toggle.getAttribute('aria-controls'));
  if (!detail) return;
  const expanded = detail.hidden;
  detail.hidden = !expanded;
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.textContent = expanded ? '收起来源' : '查看来源';
});

// 决策 92：对比页“添加工具”选择器（委托绑定在模块加载时，与模态监听并列）
document.getElementById('addCompareBtn')?.addEventListener('click', () => openAddComparePanel());
document.getElementById('modalOverlay').addEventListener('click', event => {
  const cat = event.target.closest('#addCompareCats [data-add-cat]');
  if (cat) {
    const panel = document.getElementById('modalContent');
    panel.dataset.compareCat = cat.dataset.addCat;
    document.querySelectorAll('#addCompareCats [data-add-cat]').forEach(c => {
      c.classList.toggle('active', c === cat);
      c.setAttribute('aria-pressed', String(c === cat));
    });
    renderAddCompare();
    return;
  }
  const pick = event.target.closest('[data-add-pick]');
  if (pick) {
    const before = compareList.length;
    toggleCompareRef(pick.dataset.addPick, pick.dataset.addItem || null);
    if (compareList.length !== before) {
      closeModal();
      if (currentView !== 'compare') switchView('compare');
      else renderCompare();
    } else {
      renderAddCompare();
    }
    return;
  }
});
document.getElementById('modalOverlay').addEventListener('input', event => {
  if (event.target.id === 'addCompareSearch') renderAddCompare();
});

document.addEventListener('keydown', function(e) {
  const overlay = document.getElementById('modalOverlay');
  if (!overlay || overlay.hidden) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusable = getModalFocusableElements();
  if (!focusable.length) {
    e.preventDefault();
    document.getElementById('modalContent').focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// ═══════════════════════════════════════════════════════════════
// 第 5 部分：对比模式 —— 2-5 个工具并排比较
//
// 核心函数：
//   toggleCompare()  — 添加/移除对比（上限 5 个，按钮状态同步）
//   renderCompare()  — 渲染 10+ 维度对比表
//   removeCompare()  — 从对比列表中移除单个工具
//   quickCompare()   — 一键加载预设对比方案
// EXTENSION POINT：方案一——>方案三时，将对比简略结果【renderCompare()】显示为柱状图
// ═══════════════════════════════════════════════════════════════
function resolveCompareTarget(ref) {
  const tool = tools.find(item => item.id === ref.toolId);
  if (!tool) return null;
  if (ref.itemId === null) {
    return isComparableRootTool(tool) ? { type: 'root', kind: 'tool', tool, name: tool.name, icon: tool.icon } : null;
  }
  const item = getCollectionNode(ref.toolId, ref.itemId);
  return isComparableLeaf(ref.toolId, ref.itemId)
    ? { type: 'leaf', kind: item.kind, tool, item, name: item.name, icon: tool.icon }
    : null;
}

function toggleCompareRef(toolId, itemId = null, btn) {
  const ref = { toolId, itemId };
  const target = resolveCompareTarget(ref);
  if (!target) return;
  const key = compareKey(ref);
  const idx = compareList.findIndex(candidate => compareKey(candidate) === key);
  if (idx >= 0) {
    compareList.splice(idx, 1);
    if (btn) { btn.classList.remove('selected'); btn.setAttribute('aria-pressed', 'false'); btn.textContent = '+对比'; }
  } else {
    if (compareList.length >= 5) {
      setCompareStatus('最多对比 5 项');
      return;
    }
    const existingKinds = compareList.map(resolveCompareTarget).filter(Boolean).map(candidate => candidate.kind);
    if (existingKinds.length && existingKinds.some(kind => kind !== target.kind)) {
      setCompareStatus('模型、套餐与具体工具不能混合对比，请先移除不同类型的项目。');
      return;
    }
    compareList.push(ref);
    if (btn) { btn.classList.add('selected'); btn.setAttribute('aria-pressed', 'true'); btn.textContent = '已选'; }
  }
  updateCompareCount();
  renderTools();
  if (currentView === 'compare') renderCompare();
}

function compareGroupLeaves(toolId, groupId) {
  const collection = getToolIntelligence(toolId);
  const leaves = getLeafDescendants(collection, groupId).filter(item => isComparableLeaf(toolId, item.id));
  if (leaves.length < 2) return;
  if (leaves.length > 5) {
    setCompareStatus('该分类超过 5 个可比较项目，请在下方逐项选择最多 5 个后再进入对比。');
    return;
  }
  const kind = leaves[0].kind;
  if (!leaves.every(item => item.kind === kind)) {
    setCompareStatus('该分类包含不同类型的项目，不能混合对比。');
    return;
  }
  compareList = leaves.map(item => ({ toolId, itemId: item.id }));
  updateCompareCount();
  renderTools();
  closeModal();
  switchView('compare');
}

function updateCompareCount() {
  document.getElementById('compareCount').textContent = compareList.length;
}

function compareTargetLabel(target) {
  return target.icon + ' ' + target.name;
}

// 决策 9.5/93：关键量化指标横向柱状图。只对真实、同口径数值绘制；
// 缺失不画 0 柱，币种/口径不一致时不直接比较。颜色不作为唯一区分，保留表格文本替代。
function renderCompareBars(targets) {
  if (targets[0].kind === 'tool') {
    const dims = [
      { key: 'rating_overall', label: '综合评分' },
      { key: 'rating_chinese', label: '中文支持' },
      { key: 'rating_ease', label: '易用性' },
      { key: 'rating_price', label: '性价比' }
    ];
    return '<section class="compare-bars" aria-labelledby="compareBarsTitle">' +
      '<div class="compare-bars-heading"><h3 id="compareBarsTitle">关键数据对比</h3>' +
      '<span class="compare-bars-note">InfoCatcher 自定义评分（满分 5），评分维度与计算方式见“关于”页；不代表第三方跑分。</span></div>' +
      dims.map(dim => {
        const row = targets.map(target => {
          const value = Number(target.tool[dim.key]);
          const valid = Number.isFinite(value);
          const pct = valid ? Math.max(0, Math.min(100, (value / 5) * 100)) : 0;
          return '<div class="compare-bar-item">' +
            '<span class="compare-bar-name">' + escapeHtml(compareTargetLabel(target)) + '</span>' +
            '<div class="compare-bar-track" role="img" aria-label="' + escapeHtml(compareTargetLabel(target) + ' ' + dim.label + (valid ? ' ' + value.toFixed(1) + ' 分' : ' 暂无可比数据')) + '">' +
              (valid ? '<span class="compare-bar-fill" style="width:' + pct + '%"></span>' : '<span class="compare-bar-empty">暂无可比数据</span>') +
            '</div>' +
            '<span class="compare-bar-value">' + (valid ? value.toFixed(1) : '—') + '</span>' +
          '</div>';
        }).join('');
        return '<div class="compare-bar-row"><div class="compare-bar-label">' + dim.label + '</div><div class="compare-bar-group">' + row + '</div></div>';
      }).join('') +
    '</section>';
  }

  if (targets[0].kind === 'api_model' || targets[0].kind === 'subscription_plan') {
    const priced = targets.map(target => {
      let price = null, currency = null;
      if (target.kind === 'api_model') {
        const rate = getPrimaryRate(target.item);
        if (rate && Number.isFinite(Number(rate.output))) { price = Number(rate.output); currency = rate.currency; }
      } else {
        const plan = target.item.plan;
        if (plan && plan.amount !== null && plan.amount !== undefined && plan.currency) { price = Number(plan.amount); currency = plan.currency; }
      }
      return { target, price, currency };
    });
    const withPrice = priced.filter(p => p.price !== null);
    const currencies = new Set(withPrice.map(p => p.currency));
    if (withPrice.length && currencies.size === 1) {
      const maxPrice = Math.max(...withPrice.map(p => p.price));
      const symbol = withPrice[0].currency === 'USD' ? '$' : withPrice[0].currency === 'CNY' ? '¥' : withPrice[0].currency + ' ';
      const unit = targets[0].kind === 'api_model' ? ' / 百万 tokens' : '';
      const rows = priced.map(p => {
        const valid = p.price !== null;
        const pct = valid ? Math.max(0, Math.min(100, p.price / maxPrice * 100)) : 0;
        return '<div class="compare-bar-item">' +
          '<span class="compare-bar-name">' + escapeHtml(compareTargetLabel(p.target)) + '</span>' +
          '<div class="compare-bar-track" role="img" aria-label="' + escapeHtml(compareTargetLabel(p.target) + (valid ? ' ' + symbol + Number(p.price).toLocaleString('zh-CN') + unit : ' 暂无可比数据')) + '">' +
            (valid ? '<span class="compare-bar-fill" style="width:' + pct + '%"></span>' : '<span class="compare-bar-empty">暂无可比数据</span>') +
          '</div>' +
          '<span class="compare-bar-value">' + (valid ? symbol + Number(p.price).toLocaleString('zh-CN') + unit : '—') + '</span>' +
        '</div>';
      }).join('');
      return '<section class="compare-bars" aria-labelledby="compareBarsTitle">' +
        '<div class="compare-bars-heading"><h3 id="compareBarsTitle">关键数据对比</h3>' +
        '<span class="compare-bars-note">横向条仅在同一口径下比较；单位与数值以下方表格为准。</span></div>' +
        '<div class="compare-bar-row"><div class="compare-bar-label">' + (targets[0].kind === 'api_model' ? '输出价' : '套餐价格') + '</div><div class="compare-bar-group">' + rows + '</div></div>' +
      '</section>';
    }
    return '<section class="compare-bars"><div class="compare-bars-gate"><strong>口径不同，不直接比较。</strong>各项目价格币种或口径不一致，仅保留下方表格逐项查看。</div></section>';
  }
  return '';
}

function renderRootToolCompare(targets) {
  const dims = [
    { key: 'rating_overall', label: '综合评分', format: value => value.toFixed(1) },
    { key: 'rating_chinese', label: '中文支持', format: value => value.toFixed(1) },
    { key: 'rating_ease', label: '易用性', format: value => value.toFixed(1) },
    { key: 'rating_price', label: '性价比', format: value => value.toFixed(1) },
    { key: 'access_level', label: '国内访问', format: value => value === '开放' ? '可访问' : '需科学上网' },
    { key: 'has_free', label: '免费层', format: value => value ? '有' : '无' }
  ];
  return '<table class="compare-table"><thead><tr><th>维度</th>' + targets.map(target => '<th>' + escapeHtml(compareTargetLabel(target)) + '</th>').join('') + '</tr></thead><tbody>' +
    dims.map(dimension => '<tr><td class="dim">' + dimension.label + '</td>' + targets.map(target => {
      const value = dimension.key === 'has_free' ? hasFree(target.tool) : target.tool[dimension.key];
      return '<td class="' + (typeof value === 'number' ? scoreClass(value) : '') + '">' + escapeHtml(dimension.format(value)) + '</td>';
    }).join('') + '</tr>').join('') +
    '<tr><td class="dim">适用场景</td>' + targets.map(target => '<td>' + escapeHtml(target.tool.scenes.slice(0, 5).join('、')) + '</td>').join('') + '</tr>' +
    '<tr><td class="dim">免费层说明</td>' + targets.map(target => '<td>' + escapeHtml(target.tool.free_tier || '无') + '</td>').join('') + '</tr>' +
    '<tr><td class="dim">最适合</td>' + targets.map(target => '<td>' + escapeHtml(target.tool.best_for.join('；')) + '</td>').join('') + '</tr>' +
    '<tr><td class="dim">不适合/限制</td>' + targets.map(target => '<td>' + escapeHtml((target.tool.not_for || []).join('；')) + '</td>').join('') + '</tr>' +
  '</tbody></table>';
}

function getPrimaryRate(item) {
  return item.api_pricing?.rate_cards?.[0] || null;
}

function renderApiModelCompare(targets) {
  const rows = [
    { label: '缓存命中输入价', format: item => { const rate = getPrimaryRate(item); return rate ? formatPrice(rate.input_cached, rate.currency) + ' / 百万 tokens' : '暂无可比数据'; } },
    { label: '缓存未命中输入价', format: item => { const rate = getPrimaryRate(item); return rate ? formatPrice(rate.input_uncached, rate.currency) + ' / 百万 tokens' : '暂无可比数据'; } },
    { label: '输出价', format: item => { const rate = getPrimaryRate(item); return rate ? formatPrice(rate.output, rate.currency) + ' / 百万 tokens' : '暂无可比数据'; } },
    { label: '1M 上下文', format: item => item.one_m_context?.status === 'native' ? '原生支持' : item.one_m_context?.status === 'conditional' ? '特定条件支持' : item.one_m_context?.status === 'not_supported' ? '不支持' : '未知' },
    { label: '适用说明', format: item => (item.applicable_scenarios || []).map(scene => scene.title + '：' + scene.description).join('；') || '暂无可比数据' },
    { label: '查询时间', format: item => { const collection = getToolIntelligence(targets.find(target => target.item === item).tool.id); const q = getItemLatestQueriedAt(collection, item); const info = getTimelinessInfo(q); return (q?.slice(0, 10) || '暂无可比数据') + (info ? ' ' + info.emoji : '') + (info?.stale ? ' · 数据较旧' : ''); } }
  ];
  return '<table class="compare-table"><thead><tr><th>维度</th>' + targets.map(target => '<th>' + escapeHtml(compareTargetLabel(target)) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(row => '<tr><td class="dim">' + row.label + '</td>' + targets.map(target => '<td>' + escapeHtml(row.format(target.item)) + '</td>').join('') + '</tr>').join('') +
  '</tbody></table>';
}

function renderPlanCompare(targets) {
  const rows = [
    { label: '价格', format: item => (item.plan?.amount == null ? '暂无可比数据' : formatPrice(item.plan.amount, item.plan.currency)) },
    { label: '周期', format: item => ({ month: '月', year: '年', usage: '按量', custom: '定制', unknown: '未知' }[item.plan?.billing_period] || '未知') },
    { label: '主要模型', format: item => item.plan?.included_models?.length ? item.plan.included_models.join('、') : '官方未明确列出全部模型' },
    { label: '条件/限制', format: item => item.plan?.conditions || '暂无可比数据' },
    { label: '查询时间', format: item => { const collection = getToolIntelligence(targets.find(target => target.item === item).tool.id); const q = getItemLatestQueriedAt(collection, item); const info = getTimelinessInfo(q); return (q?.slice(0, 10) || '暂无可比数据') + (info ? ' ' + info.emoji : '') + (info?.stale ? ' · 数据较旧' : ''); } }
  ];
  return '<table class="compare-table"><thead><tr><th>维度</th>' + targets.map(target => '<th>' + escapeHtml(compareTargetLabel(target)) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(row => '<tr><td class="dim">' + row.label + '</td>' + targets.map(target => '<td>' + escapeHtml(row.format(target.item)) + '</td>').join('') + '</tr>').join('') +
  '</tbody></table>';
}

function renderCompare() {
  const wrap = document.getElementById('compareTable');
  const sel = document.getElementById('compareSelection');
  const targets = compareList.map(resolveCompareTarget).filter(Boolean);
  if (targets.length !== compareList.length) compareList = compareList.filter(ref => resolveCompareTarget(ref));

  sel.innerHTML = targets.length === 0
    ? '<div class="compare-empty-copy"><strong>尚未选择对比项目</strong><p class="hint">在工具库中打开具体工具或模型后点击 <b>+对比</b>。</p></div>'
    : '<div class="selected-tools">' + targets.map(target => '<span class="selected-tool-chip">' + escapeHtml(compareTargetLabel(target)) +
        ' <button class="remove-chip" aria-label="移除 ' + escapeHtml(target.name) + '" onclick="removeCompare(\'' + escapeHtml(target.tool.id) + '\',' + (target.item ? '\'' + escapeHtml(target.item.id) + '\'' : 'null') + ')">' + ICON_CLOSE + '</button></span>').join('') + '</div>';

  if (targets.length === 0) {
    const quickPicks = [
      { ids: ['cursor', 'copilot', 'claude-code', 'trae'], label: 'AI编程工具对比' },
      { ids: ['midjourney', 'dalle', 'stable-diffusion'], label: '图像工具对比' },
      { ids: ['tongyi', 'doubao', 'kimi'], label: '国产AI对比' }
    ];
    sel.innerHTML += '<div class="compare-quick-picks" aria-label="快捷对比组合">' +
      quickPicks.map(pick => '<button class="compare-toggle" onclick=\'quickCompare(' + JSON.stringify(pick.ids) + ')\'>' + pick.label + '</button>').join('') + '</div>';
  }

  if (targets.length < 2) {
    wrap.innerHTML = targets.length === 0
      ? '<div class="compare-state empty-state"><div class="empty-icon">↔</div><h3>选择 2–5 个项目开始对比</h3><p>具体工具、API 模型和订阅套餐只能在同一类型内比较。</p></div>'
      : '<div class="compare-state empty-state"><div class="empty-icon">＋</div><h3>还需要 1 个同类型项目</h3><p>返回相同层级的工具、模型或套餐继续添加。</p></div>';
    return;
  }
  if (!targets.every(target => target.kind === targets[0].kind)) {
    wrap.innerHTML = '<div class="compare-state empty-state"><div class="empty-icon">⚠️</div><h3>这些项目不可混合比较</h3><p>模型、套餐与具体工具使用不同口径，请移除不同类型的项目。</p></div>';
    return;
  }
  const bars = renderCompareBars(targets);
  const table = targets[0].kind === 'api_model'
    ? renderApiModelCompare(targets)
    : targets[0].kind === 'subscription_plan'
      ? renderPlanCompare(targets)
      : renderRootToolCompare(targets);
  wrap.innerHTML = bars + '<div class="compare-table-wrap">' + table + '</div>';
}

// 决策 92：对比页“添加工具”轻量选择器。列出可比较目标（具体工具、API 模型、订阅套餐），
// 可搜索并按分类筛选；已选目标标记且不可重复添加；满 5 项/混类型由 toggleCompareRef 页面内提示。
function getAddCompareTargets() {
  const targets = [];
  tools.filter(isComparableRootTool).forEach(tool => {
    targets.push({ toolId: tool.id, itemId: null, kind: 'tool', tool, name: tool.name, searchText: (tool.name + ' ' + tool.vendor + ' ' + (tool.category || []).join(' ')).toLowerCase() });
  });
  const cols = Array.isArray(toolIntelligence.collections) ? toolIntelligence.collections : [];
  cols.forEach(col => {
    const tool = tools.find(t => t.id === col.tool_id);
    if (!tool) return;
    (col.items || []).forEach(item => {
      if (item.node_type !== 'leaf' || item.display_in_tree === false) return;
      if (!['api_model', 'subscription_plan'].includes(item.kind)) return;
      if (!isComparableLeaf(col.tool_id, item.id)) return;
      targets.push({ toolId: col.tool_id, itemId: item.id, kind: item.kind, tool, name: item.name, searchText: (item.name + ' ' + tool.name + ' ' + tool.vendor).toLowerCase() });
    });
  });
  return targets;
}

function openAddComparePanel(trigger = null) {
  const content = document.getElementById('modalContent');
  if (!content) return;
  content.innerHTML = '<button class="modal-close" type="button" aria-label="关闭添加工具" onclick="closeModal()">' + ICON_CLOSE + '</button>' +
    '<h2>添加对比工具</h2>' +
    '<p class="add-compare-hint">已选 <strong id="addCompareCount">0</strong> / 5 项 · 仅限同类型</p>' +
    '<div class="add-compare-panel">' +
      '<div class="search-box add-compare-search"><label class="sr-only" for="addCompareSearch">搜索工具或模型</label><input id="addCompareSearch" type="text" placeholder="搜索工具名或模型名" autocomplete="off"></div>' +
      '<div class="add-compare-cats" id="addCompareCats"></div>' +
      '<div class="add-compare-list" id="addCompareList"></div>' +
    '</div>';
  content.dataset.compareCat = 'all';
  renderAddCompare();
  showModal(trigger);
}

function renderAddCompare() {
  const panel = document.getElementById('modalContent');
  if (!panel) return;
  const input = document.getElementById('addCompareSearch');
  const catBox = document.getElementById('addCompareCats');
  const list = document.getElementById('addCompareList');
  const countEl = document.getElementById('addCompareCount');
  if (!input || !catBox || !list) return;

  const targets = getAddCompareTargets();
  const cats = [...new Set(targets.map(t => (t.tool.category || [])[0]).filter(Boolean))];
  const currentCat = panel.dataset.compareCat || 'all';
  catBox.innerHTML = '<button class="filter-chip' + (currentCat === 'all' ? ' active' : '') + '" type="button" data-add-cat="all" aria-pressed="' + (currentCat === 'all') + '">全部</button>' +
    cats.map(c => '<button class="filter-chip' + (currentCat === c ? ' active' : '') + '" type="button" data-add-cat="' + escapeHtml(c) + '" aria-pressed="' + (currentCat === c) + '">' + escapeHtml(c) + '</button>').join('');

  const query = (input.value || '').toLowerCase().trim();
  const cat = panel.dataset.compareCat || 'all';
  const filtered = targets.filter(t =>
    (cat === 'all' || (t.tool.category || []).includes(cat)) &&
    (!query || t.searchText.includes(query))
  );
  if (countEl) countEl.textContent = compareList.length;

  if (!filtered.length) {
    list.innerHTML = renderState({ icon: '⌕', title: '没有匹配的可比较项目', message: '请更换搜索或分类；只有具体工具、API 模型与订阅套餐可加入对比。', type: 'no-match' });
    return;
  }

  list.innerHTML = filtered.map(t => {
    const selected = isCompareSelected(t.toolId, t.itemId);
    const kindLabel = t.kind === 'tool' ? '具体工具' : t.kind === 'api_model' ? 'API 模型' : '订阅套餐';
    return '<div class="add-compare-item">' +
      '<div><div class="add-compare-name">' + escapeHtml(t.tool.icon + ' ' + t.name) + '</div>' +
      '<div class="add-compare-meta">' + escapeHtml(kindLabel + ' · ' + t.tool.vendor) + '</div></div>' +
      '<button class="btn btn-small compare-toggle ' + (selected ? 'selected' : '') + '" type="button" aria-pressed="' + selected + '" data-add-pick="' + escapeHtml(t.toolId) + '"' + (t.itemId ? ' data-add-item="' + escapeHtml(t.itemId) + '"' : '') + (selected ? ' disabled' : '') + '>' + (selected ? '已选' : '加入对比') + '</button>' +
    '</div>';
  }).join('');
}

function removeCompare(toolId, itemId = null) {
  const key = compareKey({ toolId, itemId });
  compareList = compareList.filter(ref => compareKey(ref) !== key);
  updateCompareCount();
  renderTools();
  renderCompare();
}

function quickCompare(ids) {
  compareList = ids.map(toolId => ({ toolId, itemId: null })).filter(ref => resolveCompareTarget(ref)).slice(0, 5);
  updateCompareCount();
  renderTools();
  renderCompare();
}

// ═══════════════════════════════════════════════════════════════
// 第 6 部分：推荐视图 —— 编辑精选 + 热门模型
//
// 五个分类（无"全部"），编辑精选和热门模型各带独立分类 tab。
// 编辑精选来自 featured.json（手动维护 tool_id + item_id）。
// 热门模型从 tool-intelligence.json 自动取 leaf 模型，按 active + 有定价排序取 top-3。
// ═══════════════════════════════════════════════════════════════

const FEATURED_CATEGORIES = [
  { key: 'llm', label: 'LLM 模型', toolCats: ['对话', '推理', '写作', '翻译', '搜索', '研究', '长文档', '长文档分析', '多模态', 'AI搜索', 'AI研究'] },
  { key: 'coding', label: 'AI 编程', toolCats: ['AI编程', '编程', 'IDE', 'IDE插件', '命令行'] },
  { key: 'image', label: '图像生成', toolCats: ['AI图像', 'AI绘画', '图像'] },
  { key: 'video', label: '视频生成', toolCats: ['AI视频'] },
  { key: 'audio', label: '音频与音乐', toolCats: ['AI音频', 'AI音乐', 'AI语音', '语音'] },
];

let activeEditorCat = 'llm';
let activeHotCat = 'llm';

function isToolInCat(tool, toolCats) {
  return (tool.category || []).some(c => toolCats.includes(c));
}

function getCategoryToolIds(catKey) {
  const cat = FEATURED_CATEGORIES.find(c => c.key === catKey);
  if (!cat) return [];
  let matched = tools.filter(t => isToolInCat(t, cat.toolCats)).map(t => t.id);
  // 非 LLM 分类排除已在 LLM 分类中的工具，避免模型列表重复
  if (catKey !== 'llm') {
    const llmCat = FEATURED_CATEGORIES.find(c => c.key === 'llm');
    const llmIds = new Set(tools.filter(t => isToolInCat(t, llmCat.toolCats)).map(t => t.id));
    matched = matched.filter(id => !llmIds.has(id));
  }
  return matched;
}

function getCategoryLeaves(catKey) {
  const toolIds = new Set(getCategoryToolIds(catKey));
  const leaves = [];
  const cols = Array.isArray(toolIntelligence.collections) ? toolIntelligence.collections : [];
  cols.forEach(col => {
    if (!col || !col.tool_id) return;
    if (!toolIds.has(col.tool_id)) return;
    (col.items || []).forEach(item => {
      if (item.node_type !== 'leaf' || item.display_in_tree === false) return;
      if (item.kind !== 'api_model') return;
      leaves.push({ ...item, _tool_id: col.tool_id, _tool: tools.find(t => t.id === col.tool_id) });
    });
  });
  // Sort: active first, then by pricing completeness
  leaves.sort((a, b) => {
    const scoreA = (a.status === 'active' ? 2 : a.status === 'partial' ? 1 : 0) + (a.api_pricing?.rate_cards?.length ? 1 : 0);
    const scoreB = (b.status === 'active' ? 2 : b.status === 'partial' ? 1 : 0) + (b.api_pricing?.rate_cards?.length ? 1 : 0);
    return scoreB - scoreA;
  });
  return leaves;
}

function getFeaturedDisplayName(toolId, itemId) {
  if (!itemId) {
    const tool = tools.find(t => t.id === toolId);
    return tool ? (tool.icon + ' ' + tool.name) : toolId;
  }
  const col = getToolIntelligence(toolId);
  const item = col?.items?.find(i => i.id === itemId);
  const tool = tools.find(t => t.id === toolId);
  if (item && tool) return tool.icon + ' ' + item.name;
  return toolId + '/' + itemId;
}

function getFeaturedVendor(toolId) {
  const tool = tools.find(t => t.id === toolId);
  return tool ? tool.vendor : '';
}

function getFeaturedSummary(toolId, itemId) {
  if (!itemId) {
    const tool = tools.find(t => t.id === toolId);
    return tool ? tool.strengths : '';
  }
  const col = getToolIntelligence(toolId);
  const item = col?.items?.find(i => i.id === itemId);
  return item?.summary || '';
}

function getFeaturedPricing(toolId, itemId) {
  if (!itemId) return '';
  const col = getToolIntelligence(toolId);
  const item = col?.items?.find(i => i.id === itemId);
  const rate = item?.api_pricing?.rate_cards?.[0];
  if (!rate) return '';
  const symbol = rate.currency === 'USD' ? '$' : rate.currency === 'CNY' ? '¥' : '';
  return symbol + rate.input_uncached + '/' + symbol + rate.output;
}

function getFeaturedDetailUrl(toolId, itemId) {
  if (itemId) return "openDetail('" + toolId + "','" + itemId + "')";
  return "openDetail('" + toolId + "')";
}

function renderFeatured() {
  renderFeaturedTabs('editorPicksTabs', activeEditorCat, 'editor');
  renderEditorPicksForCat();
  renderFeaturedTabs('hotRankingTabs', activeHotCat, 'hot');
  renderHotRankingForCat();
}

function renderFeaturedTabs(containerId, activeCat, section) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = FEATURED_CATEGORIES.map(cat =>
    '<button class="featured-tab' + (cat.key === activeCat ? ' active' : '') + '" type="button" data-cat="' + cat.key + '" aria-pressed="' + (cat.key === activeCat ? 'true' : 'false') + '">' + cat.label + '</button>'
  ).join('');
  container.querySelectorAll('.featured-tab').forEach(btn => {
    btn.addEventListener('click', function() {
      const cat = this.dataset.cat;
      if (cat === activeCat) return;
      if (section === 'editor') { activeEditorCat = cat; }
      else { activeHotCat = cat; }
      renderFeatured();
    });
  });
}

function renderEditorPicksForCat() {
  const grid = document.getElementById('featuredPicksGrid');
  if (!grid) return;
  const cat = FEATURED_CATEGORIES.find(c => c.key === activeEditorCat);
  const picks = featuredPicks
    .filter(p => p.category === activeEditorCat)
    .map(p => ({ ...p, tool: tools.find(t => t.id === p.tool_id) }))
    .filter(p => p.tool);
  if (dataLoadFailures.has('featured')) {
    grid.innerHTML = renderState({ icon: '⚠️', title: '精选数据加载失败', message: '请刷新页面重试；热门模型仍按已收录工具资料独立显示。', type: 'error' });
    return;
  }
  if (!picks.length) {
    grid.innerHTML = renderState({ icon: '○', title: '暂无精选推荐', message: escapeHtml(cat.label) + '分类的人工精选正在筹备中。', type: 'unavailable' });
    return;
  }
  grid.innerHTML = picks.map(pick => {
    const name = getFeaturedDisplayName(pick.tool_id, pick.item_id);
    const vendor = getFeaturedVendor(pick.tool_id);
    const pricing = getFeaturedPricing(pick.tool_id, pick.item_id);
    const summary = getFeaturedSummary(pick.tool_id, pick.item_id);
    const onclick = getFeaturedDetailUrl(pick.tool_id, pick.item_id);
    const latestQ = pick.item_id ? getItemLatestQueriedAt(getToolIntelligence(pick.tool_id), getCollectionNode(pick.tool_id, pick.item_id)) : null;
    const badge = renderTimelinessBadge(latestQ);
    return '<article class="featured-card featured-pick" tabindex="0" role="button" aria-label="查看 ' + escapeHtml(name) + ' 详情" onclick="' + onclick + '" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();' + onclick + '}">' +
      '<div class="featured-pick-badge">编辑精选</div>' +
      '<div class="featured-pick-header">' +
        '<div><h3>' + escapeHtml(name) + '</h3><span class="featured-pick-vendor">' + escapeHtml(vendor) + '</span>' + badge + '</div>' +
        (pricing ? '<div class="featured-pick-pricing">API ' + escapeHtml(pricing) + '</div>' : '') +
      '</div>' +
      '<p class="featured-pick-reason">' + escapeHtml(pick.reason) + '</p>' +
      '<div class="featured-pick-tags">' +
        (pick.tool.scenes || []).slice(0, 3).map(s => '<span class="tag scene">' + escapeHtml(s) + '</span>').join('') +
        '<span class="tag ' + (pick.tool.access_level === '开放' ? 'open' : 'restricted') + '">' + (pick.tool.access_level === '开放' ? '国内可用' : '需科学上网') + '</span>' +
      '</div>' +
    '</article>';
  }).join('');
}

function renderHotRankingForCat() {
  const grid = document.getElementById('featuredHotGrid');
  if (!grid) return;
  const cat = FEATURED_CATEGORIES.find(c => c.key === activeHotCat);
  const leaves = getCategoryLeaves(activeHotCat).slice(0, 3);
  if (!leaves.length) {
    grid.innerHTML = renderState({ icon: '○', title: '暂无排行数据', message: escapeHtml(cat.label) + '分类暂无已核实的模型资料。', type: 'unavailable' });
    return;
  }
  const rankEmoji = ['🥇', '🥈', '🥉'];
  grid.innerHTML = leaves.map((leaf, i) => {
    const tool = leaf._tool;
    const pricing = getFeaturedPricing(leaf._tool_id, leaf.id);
    const latestQ = getItemLatestQueriedAt(getToolIntelligence(leaf._tool_id), leaf);
    const badge = renderTimelinessBadge(latestQ);
    const onclick = getFeaturedDetailUrl(leaf._tool_id, leaf.id);
    return '<article class="featured-card featured-hot" tabindex="0" role="button" aria-label="查看 ' + escapeHtml(leaf.name) + ' 详情" onclick="' + onclick + '" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();' + onclick + '}">' +
      '<div class="featured-hot-rank">' + rankEmoji[i] + '</div>' +
      '<div class="featured-hot-body">' +
        '<div class="featured-hot-header"><h4>' + escapeHtml(tool.icon + ' ' + leaf.name) + '</h4>' + badge + '<span class="featured-hot-vendor">' + escapeHtml(tool.vendor) + '</span></div>' +
        '<p class="featured-hot-desc">' + escapeHtml(leaf.summary || '') + '</p>' +
        '<div class="featured-hot-meta">' +
          (pricing ? '<span>API ' + escapeHtml(pricing) + '</span>' : '') +
          '<span class="tag ' + (leaf.status === 'active' ? 'open' : 'restricted') + '">' + (leaf.status === 'active' ? '已核实' : '部分核实') + '</span>' +
        '</div>' +
      '</div>' +
    '</article>';
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
// 第 7 部分：概念词典 —— 术语搜索、分类筛选和可展开卡片
//
// 数据驱动：分类 chip 从 glossary.json 的 category 字段动态提取，
// 新增术语分类无需修改前端代码。
// ═══════════════════════════════════════════════════════════════

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

let activeGlossaryId = null; // 决策 9.7：当前选中的概念词条

function renderGlossary() {
  const categories = [...new Set(glossary.map(g => g.category))];
  const catEl = document.getElementById('glossaryCategories');
  catEl.innerHTML =
    '<button class="filter-chip' + (activeGlossaryCategory === 'all' ? ' active' : '') + '" type="button" data-cat="all" aria-pressed="' + (activeGlossaryCategory === 'all' ? 'true' : 'false') + '">全部</button>' +
    categories.map(c =>
      '<button class="filter-chip' + (activeGlossaryCategory === c ? ' active' : '') + '" type="button" data-cat="' + escapeHtml(c) + '" aria-pressed="' + (activeGlossaryCategory === c ? 'true' : 'false') + '">' + escapeHtml(c) + '</button>'
    ).join('');

  catEl.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', function() {
      activeGlossaryCategory = this.dataset.cat;
      renderGlossary();
    });
  });

  const filtered = getFilteredGlossary();
  const indexList = document.getElementById('glossaryIndexList');
  const detail = document.getElementById('glossaryDetail');
  if (!indexList || !detail) return;
  setRegionBusy(detail, false);

  if (dataLoadFailures.has('glossary')) {
    indexList.innerHTML = '';
    detail.innerHTML = renderState({ icon: '⚠️', title: '概念数据加载失败', message: '请刷新页面重试；其他视图仍可继续使用。', type: 'error' });
    return;
  }

  if (filtered.length === 0) {
    indexList.innerHTML = '';
    detail.innerHTML = renderState({ icon: '⌕', title: '没有匹配的概念', message: '请调整分类或更换搜索关键词。', type: 'no-match' });
    return;
  }

  if (!activeGlossaryId || !filtered.some(g => g.term === activeGlossaryId)) {
    activeGlossaryId = filtered[0].term;
  }

  indexList.innerHTML = filtered.map(g => {
    const isActive = g.term === activeGlossaryId;
    return '<button class="glossary-index-item' + (isActive ? ' active' : '') + '" type="button" data-glossary-pick="' + escapeHtml(g.term) + '" aria-pressed="' + isActive + '"' + (isActive ? ' aria-current="true"' : '') + '>' +
      '<span class="glossary-index-term">' + escapeHtml(g.term) + '</span>' +
      (g.category ? '<span class="glossary-index-cat">' + escapeHtml(g.category) + '</span>' : '') +
    '</button>';
  }).join('');

  renderGlossaryDetail();
}

function renderGlossaryDetail() {
  const detail = document.getElementById('glossaryDetail');
  if (!detail) return;
  const g = glossary.find(item => item.term === activeGlossaryId);
  if (!g) return;
  const sourceName = escapeHtml(g.source?.name || '来源待补充');
  const source = g.source?.url
    ? '<a href="' + escapeHtml(safeExternalUrl(g.source.url)) + '" target="_blank" rel="noopener noreferrer">' + sourceName + '</a>'
    : sourceName;
  detail.innerHTML = '<article class="glossary-article">' +
    '<span class="eyebrow">' + escapeHtml(g.category || 'AI 概念') + '</span>' +
    '<h2 class="glossary-article-title">' + escapeHtml(g.term) + '</h2>' +
    (g.full_name ? '<p class="glossary-article-fullname">' + escapeHtml(g.full_name) + '</p>' : '') +
    '<p class="glossary-article-summary" data-search-concept-text>' + escapeHtml(g.summary) + '</p>' +
    (g.relevance ? '<section class="glossary-article-section"><h3>实用意义</h3><p data-search-concept-text>' + escapeHtml(g.relevance) + '</p></section>' : '') +
    (g.related_terms && g.related_terms.length
      ? '<section class="glossary-article-section"><h3>关联术语</h3><ul>' + g.related_terms.map(escapeHtml).map(t => '<li data-search-concept-text>' + t + '</li>').join('') + '</ul></section>'
      : '') +
    '<div class="glossary-article-source">来源：' + source + '</div>' +
    '<div class="glossary-article-updated">词条更新：待补充（公开资料未提供）</div>' +
  '</article>';
  // 决策 9.8：概念详情正文接入全站概念联动（排除当前词条自身）
  markConceptsIn(detail, activeGlossaryId);
}

// ═══════════════════════════════════════════════════════════════
// 第 8 部分：AI 热点视图 —— 安全输出 + 内容类型/平台筛选 + 时间分组 + 状态
//
// 安全设计：
//   所有来自外部平台（YouTube/X/Bilibili）的文本字段（标题、描述、
//   作者名、来源名）在渲染前都通过 escapeHtml() 转义，防止 XSS。
//   所有外部链接通过 safeExternalUrl() 校验协议，只允许 http/https。
//   这两个函数是安全边界——如果去掉，恶意内容可注入 <script> 或
//   javascript: 链接。
//
// 筛选与展示：
//   getFilteredTrending() — 按内容类型筛选，按唯一内容发布时间倒序
//   renderTrendingStatus() — 渲染采集覆盖状态（降级/未运行/人工收录）
//   renderTrending() — 渲染热点卡片（公开字段，按“今天/昨天/近7天/更早”分组）
//   openHotspotDetail() — 热点详情对话框（摘要 + 来源核验 + 关联资料三段式；平台只在来源层展示）
// ═══════════════════════════════════════════════════════════════

/** 平台元数据：标签名、图标、CSS class */
const platformMeta = {
  youtube: { label: 'YouTube', icon: '▶️' },
  x: { label: 'X', icon: '𝕏' },
  bilibili: { label: 'B站', icon: '📺' },
};
const contentTypeLabels = {
  youtube_video: 'YouTube 视频',
  x_post: 'X 帖子',
  bilibili_video: 'B站视频',
  bilibili_dynamic: 'B站动态',
  bilibili_dynamic_repost: 'B站转发动态',
  bilibili_article: 'B站专栏'
};

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

function renderTrendingTypeFilters() {
  const container = document.getElementById('trendingTypeTabs');
  if (!container) return;
  const types = [...new Set((hotspots.items || []).map(item => item.content_type).filter(Boolean))];
  if (activeTrendingType !== 'all' && !types.includes(activeTrendingType)) activeTrendingType = 'all';
  container.innerHTML = '<button class="filter-chip' + (activeTrendingType === 'all' ? ' active' : '') + '" type="button" data-content-type="all" aria-pressed="' + (activeTrendingType === 'all') + '">全部类型</button>' +
    types.map(type => '<button class="filter-chip' + (activeTrendingType === type ? ' active' : '') + '" type="button" data-content-type="' + escapeHtml(type) + '" aria-pressed="' + (activeTrendingType === type) + '">' + escapeHtml(contentTypeLabels[type] || type) + '</button>').join('');
}

function renderTrendingStatus() {
  const status = document.getElementById('trendingStatus');
  const coverage = hotspots.coverage;
  if (dataLoadFailures.has('hotspots')) {
    status.innerHTML = '<div class="status-note status-error" role="alert"><strong>加载失败：</strong>公开热点数据暂时无法读取。请刷新页面重试；其他资料视图仍可使用。</div>';
    return;
  }
  if (!(hotspots.items || []).length && !hotspots.generated_at && (!coverage || coverage.status === 'not_run')) {
    status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>公开投影建设中：</strong>尚未生成可供浏览器读取的热点内容，请等待公开构建完成。</div>';
    return;
  }
  if (!(hotspots.items || []).length) {
    status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>暂无公开热点：</strong>公开投影已生成，但当前没有可展示内容。</div>';
    return;
  }
  if (!coverage || coverage.status === 'not_run') {
    status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>覆盖信息暂不可用：</strong>继续展示已生成的公开内容，不能据此推断全部来源的近期状态。</div>';
    return;
  }
  const notes = [];
  const bilibili = coverage.platforms?.bilibili;
  if (bilibili?.status === 'manual_curated') {
    notes.push('<div class="status-note status-neutral" role="status"><strong>人工收录：</strong>B站当前采用人工精选收录，自动订阅已暂停；已有内容仍保留原始链接，未收录不代表来源近期没有更新。</div>');
  } else if (bilibili?.reason === 'rsshub_provider_blocked') {
    notes.push('<div class="status-note status-warn" role="status"><strong>部分不可用：</strong>B站自动订阅入口被服务提供方拦截，本轮已快速停止后续请求；页面继续展示上一版及人工精选内容。</div>');
  }
  const degraded = [];
  for (const [platform, info] of Object.entries(coverage.platforms || {})) {
    if (info.status === 'degraded' || info.status === 'partial') degraded.push(platform);
  }
  if (coverage.platforms?.bilibili?.dynamic?.status === 'degraded') degraded.push('B站动态');
  if (degraded.length) {
    notes.push('<div class="status-note status-warn" role="status"><strong>部分数据降级：</strong>' + escapeHtml([...new Set(degraded)].join('、')) + '。缺失会降低判断置信度，不代表来源质量下降。</div>');
  }
  status.innerHTML = notes.length
    ? notes.join('')
    : '<div class="status-note status-ok" role="status"><strong>采集完成：</strong>本轮自动来源采集已完成。</div>';
}

function renderHotspotMetrics(item) {
  if (!item.metrics) return [];
  return [['views', '浏览'], ['likes', '点赞'], ['comments', '评论'], ['reposts', '转发'], ['replies', '回复']]
    .map(([key, label]) => {
      const value = formatMetric(item.metrics[key]);
      return value === null ? null : { label, value };
    })
    .filter(Boolean);
}

function formatHotspotDate(value, fallback = '时间未知') {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
    : fallback;
}

function getHotspotRelatedResources(item) {
  const resources = Array.isArray(item.related_resources) ? item.related_resources : [];
  return resources.map(resource => {
    if (!resource || typeof resource !== 'object') return null;
    const rawType = resource.type;
    const type = { tool: 'tools', concept: 'concepts', scene: 'scenes' }[rawType] || rawType;
    const id = resource.id || resource.tool_id || resource.concept_id || resource.scene_id;
    if (!id || !['tools', 'concepts', 'scenes'].includes(type)) return null;

    if (type === 'tools') {
      const tool = tools.find(entry => entry.id === id);
      const itemId = resource.item_id || null;
      const item = itemId ? getCollectionNode(id, itemId) : null;
      const available = Boolean(tool && (!itemId || item));
      return available
        ? { type, id: tool.id, itemId, label: resource.label || item?.name || tool.name, available: true }
        : { type, id, itemId, label: resource.label || id, available: false };
    }
    if (type === 'concepts') {
      const concept = glossary.find(entry => entry.term === id || searchConceptKey(entry.term) === id);
      return concept
        ? { type, id: concept.term, label: resource.label || concept.term, available: true }
        : { type, id, label: resource.label || id, available: false };
    }
    const scene = scenes.find(entry => entry.id === id);
    return scene
      ? { type, id: scene.id, label: resource.label || scene.name, available: true }
      : { type, id, label: resource.label || id, available: false };
  }).filter(Boolean);
}

function renderHotspotRelatedResources(item) {
  const resources = getHotspotRelatedResources(item);
  if (!resources.length) {
    return '<p class="hotspot-detail-unavailable"><strong>关联资料暂不可用。</strong>当前公开投影没有稳定的工具、概念或场景关联 ID。</p>';
  }

  const groups = [
    { key: 'tools', label: '工具' },
    { key: 'concepts', label: '概念' },
    { key: 'scenes', label: '场景' },
  ];
  const grouped = groups.map(group => ({
    ...group,
    items: resources.filter(resource => resource.type === group.key),
  })).filter(group => group.items.length);

  return grouped.map(group => '<div class="hotspot-related-group"><h4>' + escapeHtml(group.label) + '</h4>' +
    group.items.slice(0, 3).map(resource => resource.available
      ? '<button class="hotspot-related-item" type="button" data-hotspot-related-type="' + escapeHtml(resource.type) + '" data-hotspot-related-id="' + escapeHtml(resource.id) + '"' + (resource.itemId ? ' data-hotspot-related-item="' + escapeHtml(resource.itemId) + '"' : '') + '>' + escapeHtml(resource.label) + ' →</button>'
      : '<span class="hotspot-related-item hotspot-related-unavailable">' + escapeHtml(resource.label) + '：资料暂不可用</span>'
    ).join('') + '</div>').join('');
}

function openHotspotDetail(id, trigger = null) {
  const item = (hotspots.items || []).find(entry => entry.id === id);
  const content = document.getElementById('modalContent');
  if (!item || !content) return;
  const meta = platformMeta[item.platform] || { label: item.platform || '平台未知', icon: '📰' };
  const typeLabel = contentTypeLabels[item.content_type] || item.content_type || '类型未知';
  const url = safeExternalUrl(item.url);
  const hasUrl = url !== '#';
  const sourceDetailId = 'hotspot-source-detail-' + String(item.id).replace(/[^a-zA-Z0-9_-]/g, '-');
  modalScrollPosition = window.scrollY;
  content.innerHTML = '<button class="modal-close" type="button" aria-label="关闭热点详情" onclick="closeModal()">' + ICON_CLOSE + '</button>' +
    '<article class="hotspot-detail" data-hotspot-detail="' + escapeHtml(item.id) + '">' +
      '<span class="eyebrow">' + escapeHtml(typeLabel) + '</span>' +
      '<h2>' + escapeHtml(item.title || '标题暂不可用') + '</h2>' +
      '<section class="hotspot-detail-section hotspot-detail-summary" aria-labelledby="hotspotSummaryTitle">' +
        '<h3 id="hotspotSummaryTitle">内容摘要</h3>' +
        '<p class="hotspot-detail-description">' + escapeHtml(item.description || '内容摘要暂不可用。') + '</p>' +
        '<dl class="hotspot-detail-meta">' +
          '<div><dt>内容时间</dt><dd>' + escapeHtml(formatHotspotDate(item.published_at)) + '</dd></div>' +
          '<div><dt>来源作者</dt><dd>' + escapeHtml(item.author_name || '来源信息待补充') + '</dd></div>' +
        '</dl>' +
      '</section>' +
      '<section class="hotspot-detail-section hotspot-detail-sources" aria-labelledby="hotspotSourcesTitle">' +
        '<div class="hotspot-detail-section-heading"><h3 id="hotspotSourcesTitle">来源核验</h3>' +
          '<button class="btn-link hotspot-source-toggle" type="button" data-hotspot-source-toggle aria-expanded="false" aria-controls="' + escapeHtml(sourceDetailId) + '">查看来源</button>' +
        '</div>' +
        '<div class="hotspot-source-detail" id="' + escapeHtml(sourceDetailId) + '" hidden>' +
          '<dl class="hotspot-source-meta">' +
            '<div><dt>来源平台</dt><dd>' + escapeHtml(meta.label) + '</dd></div>' +
            '<div><dt>内容时间</dt><dd>' + escapeHtml(formatHotspotDate(item.published_at)) + '</dd></div>' +
            '<div><dt>数据更新于</dt><dd>' + escapeHtml(formatHotspotDate(item.fetched_at)) + '</dd></div>' +
            '<div><dt>来源名称</dt><dd>' + escapeHtml(item.author_name || item.source_id || '来源信息待补充') + '</dd></div>' +
          '</dl>' +
          '<p class="hotspot-source-evidence"><strong>依据片段：</strong>暂无可展示的直接依据。当前公开投影未提供可定位的审核依据片段。</p>' +
          (hasUrl
            ? '<a class="btn-link hotspot-source-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">打开原始来源（将离开当前页面） ' + ICON_EXTERNAL + '</a>'
            : '<p class="hotspot-detail-unavailable">原始来源链接暂不可用。</p>') +
        '</div>' +
      '</section>' +
      '<section class="hotspot-detail-section hotspot-detail-related" aria-labelledby="hotspotRelatedTitle">' +
        '<h3 id="hotspotRelatedTitle">关联资料</h3>' +
        renderHotspotRelatedResources(item) +
      '</section>' +
    '</article>';
  showModal(trigger);
}

// 决策 78：按热点实体唯一内容发布时间轻量分组（今天/昨天/近 7 天/更早；无效时间归“时间未知”）
function getTrendingGroupLabel(item) {
  const time = new Date(item.published_at).getTime();
  if (!Number.isFinite(time)) return '时间未知';
  const diff = Date.now() - time;
  const day = 86400000;
  if (diff < 0 || diff < day) return '今天';
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return '近 7 天';
  return '更早';
}

// 决策 74/77/87：卡片默认只显示内容类型、标题、短摘要、时间线索与低权重详情入口；
// 平台、作者、互动、来源标签移入详情对话框，不占卡片默认区。
function renderTrendingCard(item) {
  const typeLabel = contentTypeLabels[item.content_type] || item.content_type || '类型未知';
  const published = Number.isFinite(new Date(item.published_at).getTime()) ? timeAgo(item.published_at) : '发布时间未知';
  const preview = item.description || '来源描述暂不可用';
  const sourceDetailId = 'trending-source-detail-' + String(item.id).replace(/[^a-zA-Z0-9_-]/g, '-');
  const meta = platformMeta[item.platform] || { label: item.platform || '平台未知' };
  const sourceUrl = item.url ? safeExternalUrl(item.url) : '#';
  const sourceName = item.author_name || item.source_id || '来源信息待补充';
  const sourceEvidence = item.evidence_excerpt || item.source_excerpt || '暂无可展示的直接依据。当前公开投影未提供可定位的审核依据片段。';
  return '<article class="trending-card" data-hotspot-id="' + escapeHtml(item.id) + '" aria-labelledby="trending-title-' + escapeHtml(item.id) + '">' +
    '<div class="trending-card-head"><span class="tag scene">' + escapeHtml(typeLabel) + '</span><span>' + escapeHtml(published) + '</span></div>' +
    '<h3 id="trending-title-' + escapeHtml(item.id) + '"><span class="trending-title">' + escapeHtml(item.title || '标题暂不可用') + '</span></h3>' +
    '<div class="trending-preview-wrap">' +
      '<p class="trending-description' + (item.description ? '' : ' is-missing') + '">' + escapeHtml(preview) + '</p>' +
      (item.description
        ? '<div class="trending-secondary-preview" aria-hidden="true"><span>' + escapeHtml(item.description) + '</span></div>'
        : '') +
    '</div>' +
    '<div class="trending-card-actions">' +
      '<button class="btn-link trending-source-toggle" type="button" data-hotspot-card-source-toggle aria-expanded="false" aria-controls="' + escapeHtml(sourceDetailId) + '">查看来源</button>' +
      '<button class="btn-link trending-open-hint" type="button" data-hotspot-open>打开详情</button>' +
    '</div>' +
    '<div class="trending-card-source-detail" id="' + escapeHtml(sourceDetailId) + '" data-hotspot-card-source hidden>' +
      '<dl class="trending-source-meta">' +
        '<div><dt>来源平台</dt><dd>' + escapeHtml(meta.label) + '</dd></div>' +
        '<div><dt>来源名称</dt><dd>' + escapeHtml(sourceName) + '</dd></div>' +
        '<div><dt>内容时间</dt><dd>' + escapeHtml(formatHotspotDate(item.published_at)) + '</dd></div>' +
        '<div><dt>数据更新于</dt><dd>' + escapeHtml(formatHotspotDate(item.fetched_at)) + '</dd></div>' +
      '</dl>' +
      '<p class="trending-source-evidence"><strong>依据片段：</strong>' + escapeHtml(sourceEvidence) + '</p>' +
      (sourceUrl !== '#' ? '<a class="btn-link trending-source-link" href="' + escapeHtml(sourceUrl) + '" target="_blank" rel="noopener noreferrer">打开原始来源（将离开当前页面） ' + ICON_EXTERNAL + '</a>' : '<p class="trending-source-unavailable">原始来源链接暂不可用。</p>') +
    '</div>' +
  '</article>';
}

// B16 决策 85：热度说明通过低权重信息提示查看；默认不展示热度数值或排名。
function renderTrendingSortHelp() {
  const help = document.getElementById('trendingSortHelp');
  if (!help) return;
  const hasHeat = (hotspots.items || []).some(item => getHotspotHeat(item) !== null);
  help.textContent = hasHeat
    ? '热度排序按公开投影中的热度字段倒序，只改变阅读顺序，不改变内容类型、来源与审核状态；热度数值默认不展示。'
    : '当前公开投影暂未提供可比较的热度字段，选择“热度”时仍按最近时间倒序；该字段由数据契约补充后自动生效，不会伪造排序。';
}

function renderTrending() {
  renderTrendingTypeFilters();
  renderTrendingSortHelp();
  renderTrendingStatus();
  const items = getFilteredTrending();
  const grid = document.getElementById('trendingGrid');
  setRegionBusy(grid, false);
  document.getElementById('trendingCount').textContent = items.length;
  document.getElementById('trendingGenerated').textContent = hotspots.generated_at
    ? '生成于 ' + timeAgo(hotspots.generated_at)
    : '尚未采集';

  if (!items.length) {
    const hasPublicItems = (hotspots.items || []).length > 0;
    const state = dataLoadFailures.has('hotspots')
      ? renderState({ icon: '⚠️', title: '热点数据加载失败', message: '请刷新页面重试；采集失败不会用空结果覆盖上一版数据。', type: 'error' })
      : hasPublicItems
        ? renderState({ icon: '⌕', title: '当前筛选没有匹配内容', message: '请调整内容类型后继续浏览。', type: 'no-match' })
        : hotspots.generated_at
          ? renderState({ icon: '○', title: '暂无公开热点', message: '公开投影已生成，但当前没有可展示内容。', type: 'unavailable' })
          : renderState({ icon: '○', title: '公开投影建设中', message: '等待公开构建任务生成可供浏览器读取的内容。', type: 'unavailable' });
    grid.innerHTML = state;
    return;
  }

  // 决策 78：按唯一内容发布时间分组渲染（只显示有内容的分组）
  const groupOrder = ['今天', '昨天', '近 7 天', '更早', '时间未知'];
  const groups = new Map();
  items.forEach(item => {
    const label = getTrendingGroupLabel(item);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  });
  grid.innerHTML = [...groups.entries()]
    .sort((a, b) => groupOrder.indexOf(a[0]) - groupOrder.indexOf(b[0]))
    .map(([label, groupItems]) =>
      '<div class="trending-group">' +
        '<h3 class="trending-group-title">' + escapeHtml(label) + '</h3>' +
        groupItems.map(renderTrendingCard).join('') +
      '</div>'
    ).join('');
}

// ═══════════════════════════════════════════════════════════════
// 第 9 部分：场景导航 —— 可搜索场景列表 + 子任务/工具映射
//
// 场景数据来自 scenes.json；搜索匹配名称、简介、关联词和子任务名。
// 每行展示场景图标、名称、去重后的工具数量和简介；点击后展开任务—工具映射。
// ═══════════════════════════════════════════════════════════════

const scenePalette = {
  writing: { accent: '#d97706', border: '#92400e' },
  coding: { accent: '#047857', border: '#064e3b' },
  design: { accent: '#be185d', border: '#831843' },
  video: { accent: '#b91c1c', border: '#7f1d1d' },
  audio: { accent: '#6d28d9', border: '#4c1d95' },
  research: { accent: '#4338ca', border: '#312e81' },
  office: { accent: '#0e7490', border: '#164e63' },
  learning: { accent: '#1d4ed8', border: '#1e3a8a' },
};

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

function getSceneToolIds(scene) {
  return [...new Set((scene.tasks || []).flatMap(task => task.tools || []))];
}

function renderSceneToolCard(tool, selectedItemId = null) {
  const selectedLeaf = selectedItemId ? getCollectionNode(tool.id, selectedItemId) : null;
  const isComparable = selectedLeaf
    ? isComparableLeaf(tool.id, selectedItemId)
    : isComparableRootTool(tool);
  const isSelected = isComparable && isCompareSelected(tool.id, selectedLeaf ? selectedItemId : null);
  const specificLabel = selectedLeaf?.name || null;
  const title = tool.card_kind === 'collection' && specificLabel ? specificLabel : tool.name;
  const description = selectedLeaf?.summary || tool.strengths;
  return '<div class="tool-card scene-tool-card" onclick="openDetail(\'' + escapeHtml(tool.id) + '\',' + (selectedItemId ? '\'' + escapeHtml(selectedItemId) + '\'' : 'null') + ')">' +
    '<div class="tool-card-header">' +
      '<div><div class="tool-card-name">' + escapeHtml(tool.icon + ' ' + title) + '</div>' +
      (specificLabel ? '<div class="scene-specific-recommendation">具体推荐：' + escapeHtml(specificLabel) + '</div>' : '') +
      '<div class="tool-card-vendor">' + escapeHtml(tool.vendor) + '</div></div>' +
      '' /* 决策 98：场景工具卡默认区不显示评分，评分保留在详情模态 */ +
    '</div>' +
    '<div class="tool-card-desc">' + escapeHtml(description) + '</div>' +
    '<div class="tool-card-tags">' +
      tool.scenes.slice(0, 3).map(scene => '<span class="tag scene">' + escapeHtml(scene) + '</span>').join('') +
      (tool.card_kind === 'collection' ? '' : (hasFree(tool) ? '<span class="tag free">免费可用</span>' : '<span class="tag paid">仅付费</span>')) +
      '<span class="tag ' + (tool.access_level === '开放' ? 'open' : 'restricted') + '">' + (tool.access_level === '开放' ? '国内可用' : '需科学上网') + '</span>' +
    '</div>' +
    '<div class="tool-card-footer" onclick="event.stopPropagation()">' +
      '<span class="scene-tool-updated">资料更新于 ' + escapeHtml(tool.last_updated) + '</span>' +
      '<div class="tool-card-actions">' +
        '<button class="detail-button" type="button" onclick="openDetail(\'' + escapeHtml(tool.id) + '\',' + (selectedItemId ? '\'' + escapeHtml(selectedItemId) + '\'' : 'null') + ',this)">查看详情</button>' +
        (isComparable ? '<button class="compare-toggle ' + (isSelected ? 'selected' : '') + '" aria-pressed="' + isSelected + '" onclick="toggleCompareRef(\'' + escapeHtml(tool.id) + '\',' + (selectedLeaf ? '\'' + escapeHtml(selectedItemId) + '\'' : 'null') + ',this)">' + (isSelected ? '已选' : '+对比') + '</button>' : '') +
      '</div>' +
    '</div>' +
  '</div>';
}

let activeSceneId = null; // 决策 9.4：当前选中的场景

function renderScenes() {
  const filtered = getFilteredScenes();
  const picker = document.getElementById('scenePicker');
  const detail = document.getElementById('sceneDetail');
  if (!picker || !detail) return;
  setRegionBusy(detail, false);

  if (!scenes.length) {
    const sceneState = dataLoadFailures.has('scenes')
      ? renderState({ icon: '⚠️', title: '场景数据加载失败', message: '请刷新页面重试；其他资料视图仍可继续使用。', type: 'error' })
      : renderState({ icon: '○', title: '暂无场景数据', message: '当前公开资料中还没有可展示的场景。', type: 'unavailable' });
    picker.innerHTML = '';
    detail.innerHTML = sceneState;
    return;
  }

  if (!filtered.length) {
    picker.innerHTML = '';
    detail.innerHTML = renderState({ icon: '⌕', title: '没有匹配的场景', message: '请尝试“论文”“代码”“配图”“视频”或其他需求关键词。', type: 'no-match' });
    return;
  }

  if (!activeSceneId || !filtered.some(scene => scene.id === activeSceneId)) {
    activeSceneId = filtered[0].id;
  }

  picker.innerHTML = filtered.map(scene => {
    const isActive = scene.id === activeSceneId;
    return '<button class="scene-pick-chip' + (isActive ? ' active' : '') + '" type="button" data-scene-pick="' + escapeHtml(scene.id) + '" aria-pressed="' + isActive + '"' + (isActive ? ' aria-current="true"' : '') + '>' +
      '<span class="scene-pick-icon" aria-hidden="true">' + escapeHtml(scene.icon) + '</span>' +
      '<span>' + escapeHtml(scene.name) + '</span>' +
    '</button>';
  }).join('');

  renderSceneDetail();
}

function renderSceneDetail() {
  const detail = document.getElementById('sceneDetail');
  if (!detail) return;
  const scene = scenes.find(item => item.id === activeSceneId);
  if (!scene) return;
  const palette = scenePalette[scene.category] || scenePalette.learning;
  const toolIds = getSceneToolIds(scene);
  const taskRows = (scene.tasks || []).map((task, taskIndex) => {
    const matchedTools = (task.tools || []).map(toolId => tools.find(tool => tool.id === toolId)).filter(Boolean);
    const recommendationByTool = new Map((task.recommendations || []).map(item => [item.tool_id, item]));
    const toolButtons = matchedTools.map(tool => {
      const recommendation = recommendationByTool.get(tool.id);
      const label = recommendation ? getToolIntelligence(tool.id)?.items?.find(item => item.id === recommendation.item_id)?.name : null;
      return '<button class="scene-tool-button" type="button" aria-pressed="false" aria-controls="scene-tool-preview-' + escapeHtml(scene.id) + '-' + taskIndex + '" onclick="toggleSceneToolCard(\'' + escapeHtml(scene.id) + '\',' + taskIndex + ',\'' + escapeHtml(tool.id) + '\',' + (recommendation ? '\'' + escapeHtml(recommendation.item_id) + '\'' : 'null') + ',this)">' +
        '<span class="scene-tool-button-icon" aria-hidden="true">' + escapeHtml(tool.icon) + '</span>' +
        '<span>' + escapeHtml(label || tool.name) + '</span>' +
      '</button>';
    }).join('');
    const recommendationNotes = (task.recommendations || []).map(item => item.reason).filter(Boolean);
    return '<div class="scene-task-item">' +
      '<div class="scene-task-line">' +
        '<span class="scene-task-name">' + escapeHtml(task.task) + '</span>' +
        '<div class="scene-task-tools">' + toolButtons + '</div>' +
      '</div>' +
      (recommendationNotes.length ? '<div class="scene-recommendation-reason" data-search-concept-text>推荐依据：' + recommendationNotes.map(escapeHtml).join('；') + '</div>' : '') +
      '<div class="scene-tool-preview" id="scene-tool-preview-' + escapeHtml(scene.id) + '-' + taskIndex + '" hidden></div>' +
    '</div>';
  }).join('');

  detail.innerHTML = '<div class="scene-detail-card" style="--scene-accent:' + palette.accent + ';--scene-border:' + palette.border + '">' +
    '<div class="scene-detail-head">' +
      '<span class="scene-detail-icon" aria-hidden="true">' + escapeHtml(scene.icon) + '</span>' +
      '<div><h2 class="section-title">' + escapeHtml(scene.name) + '</h2>' +
      '<p class="scene-detail-desc" data-search-concept-text>' + escapeHtml(scene.description) + '</p></div>' +
    '</div>' +
    (toolIds.length
      ? '<div class="scene-task-list">' + taskRows + '</div>'
      : '<p class="scene-detail-empty">当前公开资料中没有匹配该场景的工具，可返回工具库浏览其他工具。</p>') +
    '<div class="scene-detail-actions"><button class="btn btn-small" type="button" data-scene-back-tools>返回工具库</button></div>' +
  '</div>';
  // 决策 9.8：场景正文接入全站概念联动
  markConceptsIn(detail);
}

function toggleSceneToolCard(sceneId, taskIndex, toolId, selectedItemId, button) {
  const preview = document.getElementById('scene-tool-preview-' + sceneId + '-' + taskIndex);
  const tool = tools.find(item => item.id === toolId);
  if (!preview || !tool) return;

  const isCurrent = button.classList.contains('active') && !preview.hidden;
  // 同一时刻只展开一个工具预览
  document.querySelectorAll('#sceneDetail .scene-tool-button.active').forEach(item => {
    item.classList.remove('active');
    item.setAttribute('aria-pressed', 'false');
  });
  document.querySelectorAll('#sceneDetail .scene-tool-preview').forEach(item => {
    item.hidden = true;
    item.innerHTML = '';
  });

  if (!isCurrent) {
    button.classList.add('active');
    button.setAttribute('aria-pressed', 'true');
    preview.innerHTML = renderSceneToolCard(tool, selectedItemId);
    preview.hidden = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// 第 10 部分：搜索别名映射
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

// ═══════════════════════════════════════════════════════════════
// 第 11 部分：页面初始化与事件绑定
// 注册事件，在DOM树被建立完时触发运行
//
// 执行顺序：
//   1. loadData() — 异步加载所有 JSON 数据
//   2. renderTools() + renderScenes() + renderTrending() — 首次渲染
//   3. 绑定事件监听器（搜索/导航/筛选/快捷键/对比/词典/热点）
//
// EXTENSION POINT: 新视图的事件监听在此区域追加
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  renderSkeletons();
  await loadData();
  renderTools();
  renderScenes();
  updateCompareCount();
  renderTrending();
  renderSearchHome();
  renderSearchProcessing();
  renderSearchView();
  document.getElementById('app').setAttribute('aria-busy', 'false');
  announceStatus('静态资料加载完成');

  // AI 静态搜索首页
  const aiSearchForm = document.getElementById('aiSearchShellForm');
  const aiSearchInput = document.getElementById('aiSearchInput');
  if (aiSearchForm && aiSearchInput) {
    aiSearchForm.addEventListener('submit', event => {
      event.preventDefault();
      submitSearchHome(aiSearchInput.value);
    });
    aiSearchInput.addEventListener('input', clearSearchHomeStates);
    document.getElementById('searchCancelProcessing')?.addEventListener('click', cancelSearchProcessing);
    document.getElementById('searchBackButton')?.addEventListener('click', returnToSearchHome);
    document.getElementById('searchEditButton')?.addEventListener('click', startSearchEditing);
    document.getElementById('searchEditCancel')?.addEventListener('click', cancelSearchEditing);
    const searchEditForm = document.getElementById('searchEditForm');
    const searchEditInput = document.getElementById('searchEditInput');
    searchEditForm?.addEventListener('submit', event => {
      event.preventDefault();
      submitSearchEdit(searchEditInput?.value);
    });
    searchEditInput?.addEventListener('input', clearSearchEditState);
    searchEditInput?.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancelSearchEditing();
    });
    document.getElementById('searchResultContent')?.addEventListener('click', event => {
      const citation = event.target.closest('[data-search-citation]');
      if (citation) {
        focusSearchSource(citation.dataset.searchCitation, citation);
        return;
      }
      const back = event.target.closest('[data-search-source-back]');
      if (back) {
        focusSearchCitation(back.dataset.searchSourceBack);
        return;
      }
      // 决策 8.2/8.4：查看全部来源折叠
      const moreToggle = event.target.closest('[data-search-sources-toggle]');
      if (moreToggle) {
        const panel = document.getElementById('searchMoreSources');
        if (panel) {
          panel.hidden = !panel.hidden;
          moreToggle.setAttribute('aria-expanded', String(!panel.hidden));
          moreToggle.textContent = panel.hidden ? '查看全部来源（' + (moreToggle.dataset.count || '') + '）' : '收起更多来源';
        }
        return;
      }
      // 决策 8.3：移动端“查看关键来源 / 返回摘要”锚点
      const anchor = event.target.closest('[data-search-anchor]');
      if (anchor) {
        const target = document.getElementById(anchor.dataset.searchAnchor === 'sources' ? 'searchSourceList' : 'searchSummaryContent');
        if (target) {
          target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        }
        return;
      }
      // 决策 8.6：来源项内联展开“来源说明”，同一时刻只展开一个
      const expand = event.target.closest('[data-search-source-expand]');
      if (expand) {
        const detail = document.getElementById('search-source-detail-' + expand.dataset.searchSourceExpand);
        if (!detail) return;
        const shouldOpen = detail.hidden;
        document.querySelectorAll('#searchSourceList .search-source-detail').forEach(item => { item.hidden = true; });
        document.querySelectorAll('#searchSourceList [data-search-source-expand]').forEach(item => item.setAttribute('aria-expanded', 'false'));
        if (shouldOpen) {
          detail.hidden = false;
          expand.setAttribute('aria-expanded', 'true');
        }
        return;
      }
    });
    document.getElementById('searchMatchesSection')?.addEventListener('click', event => {
      const open = event.target.closest('[data-search-open]');
      if (open) {
        openSearchMatch(open.dataset.searchOpen, open.dataset.searchId, open);
        return;
      }
      const expand = event.target.closest('[data-search-match-expand]');
      if (expand) {
        const key = expand.dataset.searchMatchExpand;
        if (searchMatchExpanded.has(key)) searchMatchExpanded.delete(key);
        else searchMatchExpanded.add(key);
        renderSearchMatches(getSearchMatches(searchState.query), true);
        markSearchConcepts();
      }
    });
    document.getElementById('searchFeedbackSection')?.addEventListener('click', event => {
      const feedback = event.target.closest('[data-search-feedback]');
      if (feedback) setSearchFeedback(feedback.dataset.searchFeedback);
    });
    // 决策 9.8：全站概念联动事件（搜索结果、场景详情、概念详情正文统一委托）
    document.addEventListener('pointerover', event => {
      if (event.pointerType === 'touch') return;
      const trigger = event.target.closest('[data-search-concept]');
      if (trigger) scheduleSearchConceptOpen(trigger);
    });
    document.addEventListener('pointerout', event => {
      const trigger = event.target.closest('[data-search-concept]');
      if (trigger && !trigger.contains(event.relatedTarget)) scheduleSearchConceptClose();
    });
    document.addEventListener('click', event => {
      const trigger = event.target.closest('[data-search-concept]');
      if (!trigger) return;
      event.preventDefault();
      const popover = document.getElementById('searchConceptPopover');
      // 决策 9.8.1：触屏/鼠标第二次点击同一概念词时进入 AI 概念视图
      if (searchConceptTrigger === trigger && popover && !popover.hidden) {
        openGlossaryConcept(trigger.dataset.searchConcept);
        return;
      }
      openSearchConcept(trigger);
    });
    const conceptPopover = document.getElementById('searchConceptPopover');
    conceptPopover?.addEventListener('pointerenter', () => clearTimeout(searchConceptCloseTimer));
    conceptPopover?.addEventListener('pointerleave', scheduleSearchConceptClose);
    document.getElementById('searchConceptClose')?.addEventListener('click', () => closeSearchConcept({ restoreFocus: true }));
    document.getElementById('searchConceptOpen')?.addEventListener('click', event => openGlossaryConcept(event.currentTarget.dataset.term));
    document.getElementById('view-search')?.addEventListener('click', event => {
      const example = event.target.closest('[data-search-example]');
      if (!example) return;
      selectSearchExample(example.dataset.searchExample);
      submitSearchHome(example.dataset.searchExample);
    });
  }

  // 搜索
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    setRegionBusy(document.getElementById('toolGrid'), true);
    searchTimer = setTimeout(renderTools, 150);
    searchClear.style.display = searchInput.value ? 'block' : 'none';
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    renderTools();
    searchInput.focus();
  });

  // 场景搜索
  const sceneSearch = document.getElementById('sceneSearch');
  const sceneSearchClear = document.getElementById('sceneSearchClear');
  let sceneTimer;
  if (sceneSearch) {
    sceneSearch.addEventListener('input', () => {
      clearTimeout(sceneTimer);
      setRegionBusy(document.getElementById('sceneDetail'), true);
      sceneTimer = setTimeout(renderScenes, 150);
      sceneSearchClear.style.display = sceneSearch.value ? 'flex' : 'none';
    });
    sceneSearchClear.addEventListener('click', () => {
      sceneSearch.value = '';
      sceneSearchClear.style.display = 'none';
      renderScenes();
      sceneSearch.focus();
    });
  }

  // 决策 9.4：场景选择器切换与“返回工具库”
  document.getElementById('scenePicker')?.addEventListener('click', event => {
    const chip = event.target.closest('[data-scene-pick]');
    if (!chip) return;
    activeSceneId = chip.dataset.scenePick;
    renderScenes();
  });
  document.getElementById('sceneDetail')?.addEventListener('click', event => {
    if (event.target.closest('[data-scene-back-tools]')) switchView('tools');
  });

  // 导航按钮（桌面下拉菜单、移动菜单与页脚）
  document.querySelectorAll('.nav-btn, .mobile-nav [data-view], .footer [data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!btn.dataset.view) return;
      switchView(btn.dataset.view);
    });
  });
  document.getElementById('homeBtn').addEventListener('click', (e) => {
    e.preventDefault();
    switchView('search');
  });

  // 决策 83：桌面分组下拉菜单（点击展开、点击菜单项后关闭、点击外部关闭、不悬停即开）
  document.querySelectorAll('.nav-dropdown').forEach(dropdown => {
    const trigger = dropdown.querySelector('.nav-trigger');
    if (!trigger) return;
    trigger.addEventListener('click', () => {
      const menu = document.getElementById(trigger.getAttribute('aria-controls'));
      if (!menu) return;
      const shouldOpen = menu.hidden;
      closeAllNavDropdowns();
      if (shouldOpen) {
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
    dropdown.addEventListener('click', event => {
      if (event.target.closest('[data-view]')) closeAllNavDropdowns();
    });
  });
  document.addEventListener('click', event => {
    if (event.target.closest('.nav-dropdown')) return;
    closeAllNavDropdowns();
  });

  const menuToggle = document.getElementById('menuToggle');
  const mobileNav = document.getElementById('mobileNav');
  if (menuToggle && mobileNav) {
    menuToggle.addEventListener('click', () => {
      if (mobileNav.hidden) openMobileNav();
      else closeMobileNav();
    });
    document.addEventListener('click', event => {
      if (mobileNav.hidden || mobileNav.contains(event.target) || menuToggle.contains(event.target)) return;
      closeMobileNav();
    });
  }
  syncNavigationState(currentView);

  // 分类筛选
  document.querySelectorAll('.filter-chip[data-category]').forEach(chip => {
    chip.addEventListener('click', function() {
      const controls = [...document.querySelectorAll('.filter-chip[data-category]')];
      setPressedState(controls, this);
      activeFilters.category = this.dataset.category;
      if (currentView !== 'tools') switchView('tools');
      else renderTools();
    });
  });

  // 访问筛选
  document.querySelectorAll('.filter-chip[data-access]').forEach(chip => {
    chip.addEventListener('click', function() {
      const controls = [...document.querySelectorAll('.filter-chip[data-access]')];
      setPressedState(controls, this);
      activeFilters.access = this.dataset.access;
      if (currentView !== 'tools') switchView('tools');
      else renderTools();
    });
  });

  // 价格筛选
  document.querySelectorAll('.filter-chip[data-price]').forEach(chip => {
    chip.addEventListener('click', function() {
      const controls = [...document.querySelectorAll('.filter-chip[data-price]')];
      setPressedState(controls, this);
      activeFilters.price = this.dataset.price;
      if (currentView !== 'tools') switchView('tools');
      else renderTools();
    });
  });

  // 决策 94：工具库筛选折叠（移动轻量面板）、已选标签一键清除
  document.getElementById('toolsFilterToggle')?.addEventListener('click', function() {
    const panel = document.getElementById('toolsFiltersPanel');
    const open = panel.classList.toggle('open');
    this.setAttribute('aria-expanded', String(open));
  });
  document.getElementById('toolsFilterDone')?.addEventListener('click', () => {
    document.getElementById('toolsFiltersPanel')?.classList.remove('open');
    const toggle = document.getElementById('toolsFilterToggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  });
  document.getElementById('toolsClearFilters')?.addEventListener('click', clearToolFilters);
  document.getElementById('toolsFilterClear')?.addEventListener('click', () => {
    clearToolFilters();
    document.getElementById('toolsFiltersPanel')?.classList.remove('open');
    const toggle = document.getElementById('toolsFilterToggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  });

  // 热点公开内容类型、平台筛选与排序
  const trendingTypeTabs = document.getElementById('trendingTypeTabs');
  trendingTypeTabs?.addEventListener('click', event => {
    const chip = event.target.closest('[data-content-type]');
    if (!chip) return;
    const controls = [...trendingTypeTabs.querySelectorAll('[data-content-type]')];
    setPressedState(controls, chip);
    setRegionBusy(document.getElementById('trendingGrid'), true);
    activeTrendingType = chip.dataset.contentType;
    renderTrending();
  });
  // B16 决策 78/85：热点排序（最近/热度）。热度仅在公开投影提供明确热度字段时生效。
  const trendingSortTabs = document.getElementById('trendingSortTabs');
  trendingSortTabs?.addEventListener('click', event => {
    const chip = event.target.closest('[data-trending-sort]');
    if (!chip) return;
    const controls = [...trendingSortTabs.querySelectorAll('[data-trending-sort]')];
    setPressedState(controls, chip);
    setRegionBusy(document.getElementById('trendingGrid'), true);
    activeTrendingSort = chip.dataset.trendingSort;
    renderTrending();
  });
  // B16 决策 85：热度定义的低权重信息提示（内联展开，aria-expanded + aria-controls）。
  document.getElementById('trendingSortHelpToggle')?.addEventListener('click', function() {
    const panel = document.getElementById('trendingSortHelp');
    if (!panel) return;
    renderTrendingSortHelp();
    const open = panel.hidden;
    panel.hidden = !open;
    this.setAttribute('aria-expanded', String(!open));
    this.textContent = open ? '收起热度说明' : '热度说明';
  });
  const trendingGrid = document.getElementById('trendingGrid');
  trendingGrid?.addEventListener('click', event => {
    const sourceToggle = event.target.closest('[data-hotspot-card-source-toggle]');
    if (sourceToggle) {
      const card = sourceToggle.closest('[data-hotspot-id]');
      const detail = card?.querySelector('[data-hotspot-card-source]');
      if (!card || !detail) return;
      const shouldOpen = detail.hidden;
      document.querySelectorAll('#trendingGrid [data-hotspot-card-source]').forEach(item => { item.hidden = true; });
      document.querySelectorAll('#trendingGrid [data-hotspot-card-source-toggle]').forEach(item => {
        item.setAttribute('aria-expanded', 'false');
        item.textContent = '查看来源';
      });
      detail.hidden = !shouldOpen;
      sourceToggle.setAttribute('aria-expanded', String(shouldOpen));
      sourceToggle.textContent = shouldOpen ? '收起来源' : '查看来源';
      return;
    }
    const openDetailButton = event.target.closest('[data-hotspot-open]');
    if (openDetailButton) {
      const card = openDetailButton.closest('[data-hotspot-id]');
      if (card) openHotspotDetail(card.dataset.hotspotId, card);
      return;
    }
    if (event.target.closest('a')) return;
    const card = event.target.closest('[data-hotspot-id]');
    if (card) openHotspotDetail(card.dataset.hotspotId, card);
  });
  trendingGrid?.addEventListener('keydown', event => {
    const card = event.target.closest('[data-hotspot-id]');
    if (!card || event.target.closest('button, a')) return;
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    openHotspotDetail(card.dataset.hotspotId, card);
  });

  // 键盘快捷键
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !document.getElementById('searchConceptPopover')?.hidden) {
      e.preventDefault();
      closeSearchConcept({ restoreFocus: true });
      return;
    }
    if (e.key === 'Escape' && mobileNav && !mobileNav.hidden) {
      e.preventDefault();
      closeMobileNav({ restoreFocus: true });
      return;
    }
    if (e.key === 'Escape' && document.querySelector('.nav-dropdown-menu:not([hidden])')) {
      e.preventDefault();
      const openTrigger = document.querySelector('.nav-dropdown .nav-trigger[aria-expanded="true"]');
      closeAllNavDropdowns();
      openTrigger?.focus();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      const targetInput = currentView === 'tools'
        ? document.getElementById('searchInput')
        : currentView === 'search'
          ? searchState.mode === 'results'
            ? searchState.editing
              ? document.getElementById('searchEditInput')
              : null
            : document.getElementById('aiSearchInput')
          : null;
      if (!targetInput || targetInput.disabled) return;
      e.preventDefault();
      targetInput.focus();
    }
  });

  // 概念词典搜索
  const glossarySearch = document.getElementById('glossarySearch');
  const glossarySearchClear = document.getElementById('glossarySearchClear');
  let glossaryTimer;
  if (glossarySearch) {
    glossarySearch.addEventListener('input', () => {
      clearTimeout(glossaryTimer);
      setRegionBusy(document.getElementById('glossaryDetail'), true);
      glossaryTimer = setTimeout(renderGlossary, 150);
      glossarySearchClear.style.display = glossarySearch.value ? 'block' : 'none';
    });
    glossarySearchClear.addEventListener('click', () => {
      glossarySearch.value = '';
      glossarySearchClear.style.display = 'none';
      renderGlossary();
      glossarySearch.focus();
    });
  }

  // 决策 9.7：概念索引点击切换详情
  document.getElementById('glossaryIndexList')?.addEventListener('click', event => {
    const item = event.target.closest('[data-glossary-pick]');
    if (!item) return;
    activeGlossaryId = item.dataset.glossaryPick;
    renderGlossary();
  });
});
