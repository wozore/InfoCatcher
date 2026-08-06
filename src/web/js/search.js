/**
 * InfoCatcher MVP — AI 搜索视图 (search)：B16 静态搜索入口与结果主线（P1-A 接入）
 *
 * 固定静态搜索状态只在当前页面内存中存在，不写入 URL、localStorage 或后端。
 * 决策 9.8：搜索结果/来源/匹配、场景导语、概念详情正文统一接入“概念联动”
 * （markConceptsIn 也在场景与概念视图复用），点击概念词进入 AI 概念视图。
 * 架构概要、八个视图与扩展模式见 main.js 顶部维护文档。
 */
import {
  tools,
  glossary,
  scenes,
  hotspots,
  dataLoadFailures,
  getSearchConcepts,
  searchConceptKey,
  getToolSearchText,
  setActiveGlossaryCategory,
  escapeHtml,
  timeAgo,
  safeExternalUrl,
  announceStatus,
} from './data.js';
import { switchView } from './main.js';
import { openDetail } from './tools.js';
import { openHotspotDetail } from './trending.js';
import { openGlossaryConcept, setActiveGlossaryId } from './glossary.js';
import { renderScenes, setActiveSceneId } from './scenes.js';

// P1-A：固定静态搜索状态。只在当前页面内存中存在，不写入 URL、localStorage 或后端。
// 产品约束（MVP）：AI 搜索只支持 3 个固定示例查询（写论文/写代码/深度研究），
// 只有命中 SEARCH_DEMOS 的查询才产出结果，其余查询一律走「无对应示例」提示。
const SEARCH_DEMOS = Object.freeze([
  Object.freeze({ key: 'writing', query: '写论文', hint: '适合查找论文写作、资料整理和研究辅助工具。' }),
  Object.freeze({ key: 'coding', query: '写代码', hint: '适合查找编程开发、代码补全和命令行工具。' }),
  Object.freeze({ key: 'research', query: '深度研究', hint: '适合查找深度研究、搜索和长文档分析工具。' })
]);
const SEARCH_PROCESSING_STAGES = Object.freeze([
  '正在整理你的问题',
  '匹配已收录资料',
  '准备示例摘要'
]);
// 处理动画防竞态：每次提交/取消递增 runId，定时器与完成回调都校验归属，
// 避免旧一轮的定时器在新一轮开始后误改状态。
let searchProcessingRun = 0;
let searchProcessingTimer = null;
// 反向引用表：sourceId → 触发它的 [n] 引用按钮，支撑结果页「返回引用位置」与来源高亮联动。
const searchCitationOrigins = new Map();
let searchConceptTrigger = null;
let searchConceptHoverTimer = null;
let searchConceptCloseTimer = null;
// 决策 9.8.1：关闭解释框回焦时，抑制因 focus 事件触发的立即重新打开
let searchConceptRestoring = false;
// 搜索视图的唯一状态载体（当前页面内存）：mode 在 home/results 间切换，
// recent 为「继续探索」历史（最多 3 条），editing 控制结果页内联改写表单。
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

// ═══ P1-A：静态搜索匹配适配器 ═══════════════════════════════════
// 四个 getSearch*Matches 均为「归一化后子串包含（includes）」匹配，非语义匹配；
// 仅在命中 demo 查询时由 getSearchMatches 调用，非 demo 查询直接返回空数组。
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

// 匹配中枢：识别命中 demo、执行四路子串匹配、汇总数据加载失败项（unavailable）。
// demoKey 为 null 表示查询不在 3 个固定示例内，上游据此进入「无对应示例」分支。
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

// 结果可用性状态机：success / partial（部分静态资料未加载）/ no-match / error（所需资料全不可用）。
// 决定结果页是渲染完整投影，还是只显示对应提示块。
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

// 将命中的静态资料投影为「来源列表 + 摘要段落」：首场景 + 前 3 个工具作为来源，
// 段落按 场景描述/已收录任务/匹配工具 三块生成，每段携带 sourceIds 供 [n] 引用定位。
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
    setActiveSceneId(id);
    switchView('scenes');
    window.requestAnimationFrame(() => {
      document.querySelector('.scene-pick-chip[data-scene-pick="' + CSS.escape(id) + '"]')?.focus();
    });
    return;
  }
  if (type === 'hotspots') {
    // 决策 9.1/81：热点匹配项"查看资料"应打开对应热点详情对话框，不新增独立详情路由。
    // switchView('trending') 已同步渲染热点列表；若能定位到对应卡片则以卡片为回焦锚点，否则以 null 回焦到模态内容。
    switchView('trending');
    window.requestAnimationFrame(() => {
      const card = document.querySelector('#trendingGrid [data-hotspot-id="' + CSS.escape(id) + '"]');
      openHotspotDetail(id, card || null);
    });
    return;
  }
  if (type === 'concepts') {
    const input = document.getElementById('glossarySearch');
    if (input) input.value = id;
    setActiveGlossaryCategory('all');
    setActiveGlossaryId(id);
    switchView('glossary');
    window.requestAnimationFrame(() => document.querySelector('.glossary-index-item[data-glossary-pick="' + CSS.escape(id) + '"]')?.focus());
  }
}

function setSearchFeedback(value) {
  searchState.feedback = value;
  renderSearchFeedback(true);
}

// ═══════════════════════════════════════════════════════════════
// 决策 9.8：全站概念联动（搜索结果、场景详情、概念详情正文统一复用）
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// 概念解释弹层（popover）
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// 引用定位与高亮
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// 视图状态机：首页 / 处理中 / 结果页 / 编辑
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// 静态整理处理动画
// ═══════════════════════════════════════════════════════════════
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
    if (status) status.textContent = '请输入问题后再搜索。';
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

export {
  searchState,
  searchMatchExpanded,
  searchConceptTrigger,
  searchConceptHoverTimer,
  searchConceptCloseTimer,
  searchCitationOrigins,
  getSearchMatches,
  renderSearchHome,
  clearSearchHomeStates,
  selectSearchExample,
  renderSearchResults,
  renderSearchMatches,
  renderSearchView,
  renderSearchProcessing,
  renderSearchContinue,
  renderSearchFeedback,
  submitSearchHome,
  submitSearchEdit,
  clearSearchEditState,
  startSearchEditing,
  cancelSearchEditing,
  returnToSearchHome,
  cancelSearchProcessing,
  openSearchMatch,
  setSearchFeedback,
  openSearchConcept,
  closeSearchConcept,
  scheduleSearchConceptOpen,
  scheduleSearchConceptClose,
  focusSearchSource,
  focusSearchCitation,
  markConceptsIn,
  markSearchConcepts,
};
