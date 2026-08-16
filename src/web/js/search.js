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
  getToolLevel3Item,
  glossary,
  hotspots,
  dataLoadFailures,
  getToolSearchText,
  getHotspotHeat,
  escapeHtml,
  timeAgo,
  safeExternalUrl,
  announceStatus,
} from './data.js';
import { switchView } from './main.js';
import { openDetail, setToolsViewMode, clearToolFilters } from './tools.js';
import { openGlossaryConcept } from './glossary.js';
import { getLocalizedField } from './i18n.js';

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
// getSearchToolMatches 为「归一化后子串包含（includes）」匹配，非语义匹配；
// 仅在命中 demo 查询时由 getSearchMatches 调用，非 demo 查询直接返回空数组。
function getSearchToolMatches(query) {
  const text = String(query || '').trim().toLocaleLowerCase('zh-CN');
  if (!text) return [];
  return tools.filter(tool => getToolSearchText(tool).toLocaleLowerCase('zh-CN').includes(text));
}

// 匹配中枢：识别命中 demo、执行工具子串匹配、汇总数据加载失败项（unavailable）。
// demoKey 为 null 表示查询不在 3 个固定示例内，上游据此进入「无对应示例」分支。
function getSearchMatches(query) {
  const normalizedQuery = String(query || '').trim();
  const demo = SEARCH_DEMOS.find(item => item.query === normalizedQuery) || null;
  return {
    query: normalizedQuery,
    demoKey: demo?.key || null,
    demoHint: demo?.hint || '',
    tools: demo ? getSearchToolMatches(normalizedQuery) : [],
    unavailable: [...dataLoadFailures].filter(key => ['tools', 'hotspots', 'glossary'].includes(key))
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

// 结果可用性状态机：success / no-match / error（所需资料全不可用）。
// 决定结果页是渲染完整投影，还是只显示对应提示块。热点/概念数据缺失只隐藏对应栏，不算 partial。
function getSearchResultAvailability(matches) {
  if (!matches.demoKey) return { type: 'no-match', message: '当前问题没有对应的固定静态示例。' };
  if (matches.unavailable.includes('tools')) {
    return { type: 'error', message: '匹配所需的工具资料当前不可用，请刷新页面后重试。' };
  }
  if (!matches.tools.length) return { type: 'no-match', message: '当前固定示例没有匹配到可展示的工具资料。' };
  return { type: 'success', message: '' };
}

// 将命中的工具投影为「工具列表」，供答案与 mini 卡使用（mini 卡复用工具卡数据子集，不另建投影）。
function getSearchResultProjection(query) {
  const matches = getSearchMatches(query);
  return { matches, tools: matches.demoKey ? matches.tools : [] };
}

// 决策（搜索结果页 v2）：答案句列出的工具名与 mini 卡展示数量上限。
// 实测「写论文」匹配 11 个、「写代码」12 个，答案与卡片必须封顶，
// 超出部分经「了解更多」进入工具库完整列表。
const SEARCH_ANSWER_NAMES_LIMIT = 5;
const SEARCH_TOOL_MINIS_LIMIT = 6;

function renderSearchResults() {
  closeSearchConcept();
  const state = document.getElementById('searchResultState');
  const content = document.getElementById('searchResultContent');
  const summary = document.getElementById('searchSummaryContent');
  if (!state || !content || !summary) return;

  const projection = getSearchResultProjection(searchState.query);
  const availability = getSearchResultAvailability(projection.matches);
  if (availability.type === 'error' || availability.type === 'no-match') {
    state.hidden = false;
    state.className = 'state ' + (availability.type === 'error' ? 'error' : 'info') + ' search-result-state';
    state.innerHTML = '<strong>' + (availability.type === 'error' ? '工具资料处理失败' : '暂无可展示的静态整理结果') + '</strong><p>' + escapeHtml(availability.message || '当前问题没有足够的已收录资料，因此不会生成无依据摘要。') + '</p>';
    content.hidden = true;
    summary.innerHTML = '';
    renderSearchFeedback(false);
    return;
  }

  state.hidden = true;
  content.hidden = false;
  searchCitationOrigins.clear();

  const tools = projection.tools;
  summary.innerHTML = buildSearchAnswer(searchState.query, tools).join('');
  renderSearchToolMinis(tools);
  renderSearchHotspots(getSearchHotspotRanking(searchState.query, 5));
  // 决策 9.8：先包裹正文概念词，再收集左栏索引，保证与内嵌联动严格一致
  markSearchConcepts();
  renderSearchConceptsRail(collectSearchConcepts());
  renderSearchFeedback(true);
}

// 一句话答案：结论句 + 概览句，内嵌 [n] 引用按钮对应下方工具 mini 卡。
// 工具为空时返回空数组（由 availability 的 no-match 分支兜底）。
function buildSearchAnswer(query, tools) {
  const citation = (tool, index) =>
    '<button class="citation" type="button" data-search-citation="tool-' + escapeHtml(tool.id) +
    '" aria-label="定位到工具 ' + (index + 1) + '">[' + (index + 1) + ']</button>';

  const shown = tools.slice(0, SEARCH_ANSWER_NAMES_LIMIT);
  const list = shown.map((tool, i) => escapeHtml(tool.title) + citation(tool, i)).join('、');
  const extra = tools.length > shown.length ? '、…等 ' + tools.length + ' 个相关工具' : '';
  const conclusion = '针对「' + escapeHtml(query) + '」，已为你匹配到 ' + tools.length + ' 个相关工具：' + list + extra + '。';

  const best = tools[0];
  let overview = '';
  if (best) {
    const bestName = escapeHtml(best.title) + citation(best, 0);
    if (best.best_for_preview) {
      overview = '综合已收录资料，' + bestName + ' 最适合' + escapeHtml(best.best_for_preview) + '，是这类任务的优先选择。';
    } else if (best.summary) {
      overview = '综合已收录资料，' + bestName + '：' + escapeHtml(best.summary) + '。';
    } else {
      overview = '综合已收录资料，' + bestName + ' 与该任务直接相关，可点击下方卡片查看详情与对比。';
    }
  }

  return [
    '<p id="search-summary-1" tabindex="-1" data-search-summary data-search-concept-text>' + conclusion + '</p>',
    overview ? '<p id="search-summary-2" tabindex="-1" data-search-summary data-search-concept-text>' + overview + '</p>' : ''
  ].filter(Boolean);
}

// 相关工具 mini 卡行：复用工具卡数据子集（icon/title/summary），
// 点击卡弹详情（留在搜索页），卡角 ↗ 外链仅在三级详情有 official_url 时显示。
function renderSearchToolMinis(tools) {
  const list = document.getElementById('searchToolMiniList');
  if (!list) return;
  const shown = tools.slice(0, SEARCH_TOOL_MINIS_LIMIT);
  list.innerHTML = shown.map((tool, index) => {
    const detail = tool.detail_ref ? getToolLevel3Item(tool.vendor_key, tool.detail_ref.id) : null;
    const url = detail?.official_url ? safeExternalUrl(detail.official_url) : '#';
    return '<article class="search-tool-mini" id="search-tool-' + escapeHtml(String(tool.id).replace(/[^a-zA-Z0-9_-]/g, '-')) + '"' +
      ' data-search-tool="' + escapeHtml(tool.detail_ref?.id || '') + '"' +
      ' data-search-source="tool-' + escapeHtml(tool.id) + '"' +
      ' tabindex="0" role="button" aria-label="查看详情：' + escapeHtml(tool.title) + '">' +
      (tool.icon ? '<span class="search-tool-mini-icon" aria-hidden="true">' + escapeHtml(tool.icon) + '</span>' : '') +
      '<div class="search-tool-mini-body">' +
        '<h3>' + escapeHtml(tool.title) + '</h3>' +
        (tool.summary ? '<p data-search-concept-text>' + escapeHtml(tool.summary) + '</p>' : '') +
      '</div>' +
      (url !== '#' ? '<a class="search-tool-mini-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer" aria-label="打开官网：' + escapeHtml(tool.title) + '"><svg class="icon" aria-hidden="true"><use href="#icon-external"/></svg></a>' : '') +
    '</article>';
  }).join('') +
  (tools.length > SEARCH_TOOL_MINIS_LIMIT
    ? '<button class="btn btn-small search-more-tools" type="button" data-search-more-tools>了解更多 · 查看全部 ' + tools.length + ' 个</button>'
    : '');
}

// 右栏热点：最新、按相关度（query 子串在标题/描述/概要命中数）降序、再按发布时间降序，取前 limit。
// 命中数为 0 也保留（靠时间排序兜底，故右栏在热点数据存在时恒有内容）。
// 标题/描述/概要统一走本地化字段（zh）原文兜底，与热点视图 trending.js 一致，避免显示英文标题。
function hotspotField(item, field) {
  return getLocalizedField(item, field) || item[field] || '';
}

function getSearchHotspotRanking(query, limit = 5) {
  const needle = String(query || '').trim().toLocaleLowerCase('zh-CN');
  const ranked = (hotspots.items || []).map(item => {
    const haystack = [hotspotField(item, 'title'), hotspotField(item, 'description'), hotspotField(item, 'summary')].filter(Boolean).join('\n').toLocaleLowerCase('zh-CN');
    let score = 0;
    if (needle) {
      let idx = haystack.indexOf(needle);
      while (idx >= 0) { score += 1; idx = haystack.indexOf(needle, idx + needle.length); }
    }
    const ts = new Date(item.published_at).getTime();
    return { item, score, ts: Number.isFinite(ts) ? ts : 0 };
  });
  ranked.sort((a, b) => b.score - a.score || b.ts - a.ts);
  return ranked.slice(0, limit).map(entry => entry.item);
}

function renderSearchHotspots(items) {
  const rail = document.getElementById('searchHotspotsRail');
  const list = document.getElementById('searchHotspotsList');
  const content = document.getElementById('searchResultContent');
  if (!rail || !list || !content) return;
  const hasItems = (items || []).length > 0;
  rail.hidden = !hasItems;
  content.classList.toggle('without-hotspots', !hasItems);
  if (!hasItems) { list.innerHTML = ''; return; }
  list.innerHTML = items.map(item => {
    const heat = getHotspotHeat(item);
    const title = hotspotField(item, 'title');
    const summary = hotspotField(item, 'summary') || hotspotField(item, 'description');
    return '<article class="search-hotspot-item" id="search-hotspot-' + escapeHtml(String(item.id).replace(/[^a-zA-Z0-9_-]/g, '-')) + '"' +
      ' data-hotspot-id="' + escapeHtml(item.id) + '" tabindex="0" role="button" aria-label="查看热点：' + escapeHtml(title) + '">' +
      '<h3 class="search-hotspot-title">' + escapeHtml(title) + '</h3>' +
      (heat !== null ? '<span class="search-hotspot-score">热度 ' + escapeHtml(String(heat)) + '</span>' : '') +
      '<p class="search-hotspot-summary">' + escapeHtml(summary) + '</p>' +
      '<span class="search-hotspot-time">' + escapeHtml(timeAgo(item.published_at)) + '</span>' +
    '</article>';
  }).join('');
}

// 概念左栏：收集主列 markConceptsIn 已包裹出的概念词（DOM 序去重），上限 10。
// 必须在 markSearchConcepts() 之后调用。
function collectSearchConcepts() {
  const panel = document.getElementById('searchResultsPanel');
  if (!panel) return [];
  const seen = new Set();
  const terms = [];
  panel.querySelectorAll('.concept-link[data-search-concept]').forEach(button => {
    const term = button.dataset.searchConcept;
    if (term && !seen.has(term)) { seen.add(term); terms.push(term); }
  });
  return terms.slice(0, 10);
}

function renderSearchConceptsRail(terms) {
  const rail = document.getElementById('searchConceptsRail');
  const list = document.getElementById('searchConceptsList');
  if (!rail || !list) return;
  // 决策：无相关概念时仍保留该栏（避免主内容向左挤占），显示空态占位
  rail.hidden = false;
  // 概念词即 glossary.term，直接回查 summary 作为术语摘要；未收录的只显示术语名
  const byTerm = new Map((glossary || []).map(g => [g && g.term, g]));
  list.innerHTML = terms.length
    ? terms.map(term => {
        const entry = byTerm.get(term);
        const summary = entry && entry.summary ? escapeHtml(entry.summary) : '';
        return '<button class="search-concept-rail-item" type="button" data-search-concept-rail="' + escapeHtml(term) + '">' +
          '<span class="search-concept-rail-term">' + escapeHtml(term) + '</span>' +
          (summary ? '<span class="search-concept-rail-summary">' + summary + '</span>' : '') +
        '</button>';
      }).join('')
    : '<p class="search-concept-empty">暂无相关概念</p>';
}

// 工具 mini 卡点击：留在搜索页弹详情，不切视图；关闭后回焦由 showModal/closeModal 管理。
function openSearchToolDetail(id, trigger) {
  openDetail(id, null, trigger || null);
}

// 「了解更多」：跳工具库视图 + 预填本次 query + 强制工具 toggle + 清筛选。
function openSearchMoreTools() {
  const input = document.getElementById('searchInput');
  if (input) input.value = searchState.query;
  const clear = document.getElementById('searchClear');
  if (clear && searchState.query) clear.style.display = 'block'; // 程序赋值不触发 input 事件
  clearToolFilters();       // 重置访问/价格筛选，保证跳转后按 query 全量展示
  setToolsViewMode('tool'); // 强制工具目录视图（新增导出）
  switchView('tools');      // 内部 renderTools() 读取 #searchInput.value 过滤
  announceStatus('已跳转到工具库，并按「' + searchState.query + '」过滤');
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
  searchConceptTrigger,
  searchConceptHoverTimer,
  searchConceptCloseTimer,
  searchCitationOrigins,
  getSearchMatches,
  renderSearchHome,
  clearSearchHomeStates,
  selectSearchExample,
  renderSearchResults,
  renderSearchView,
  renderSearchProcessing,
  renderSearchFeedback,
  submitSearchHome,
  submitSearchEdit,
  clearSearchEditState,
  startSearchEditing,
  cancelSearchEditing,
  returnToSearchHome,
  cancelSearchProcessing,
  setSearchFeedback,
  openSearchConcept,
  closeSearchConcept,
  scheduleSearchConceptOpen,
  scheduleSearchConceptClose,
  focusSearchSource,
  markConceptsIn,
  markSearchConcepts,
  openSearchToolDetail,
  openSearchMoreTools,
};
