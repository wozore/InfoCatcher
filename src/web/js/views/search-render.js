/**
 * search-render.js — 搜索视图渲染与高亮标注
 * 负责搜索主区、工具卡 mini、热点与概念栏渲染，以及概念气泡弹层。
 */

import { state, navigateToConcept } from '../state.js';
import { escapeHtml, safeExternalUrl, timeAgo } from '../ui/ui-helpers.js';
import { getHotspotHeat } from '../data/data-filters.js';
import { brandIconHtml } from '../ui/brand-icons.js';
import {
  getSearchConceptPatterns,
  findSearchConcept,
  isSearchConceptTextNode,
  hotspotField,
  getSearchResultAvailability,
  getSearchResultProjection,
  getSearchHotspotRanking
} from './search-index.js';

const SEARCH_ANSWER_NAMES_LIMIT = 5;
const SEARCH_TOOL_MINIS_LIMIT = 6;

const searchCitationOrigins = new Map();
let searchConceptTrigger = null;
let searchConceptHoverTimer = null;
let searchConceptCloseTimer = null;
let searchConceptRestoring = false;

export function renderSearchHome() {
  const examples = document.getElementById('searchExampleList');
  if (!examples) return;
  const picks = (state.scenes || []).filter(s => s && typeof s.example === 'string' && s.example.trim()).slice(0, 4);
  examples.innerHTML = picks.map(scene =>
    '<button class="chip search-example" type="button" data-search-example="' + escapeHtml(scene.example) + '">' +
      '<span class="search-example-scene">' + escapeHtml(scene.name) + '</span>' +
      '<span class="search-example-query">' + escapeHtml(scene.example) + '</span>' +
    '</button>'
  ).join('');
}

function buildSearchAnswer(query, tools, matches = {}) {
  const keywordText = (matches.keywords || []).slice(0, 2).map(keyword => '「' + escapeHtml(keyword) + '」').join('、');
  const leadPrefix = matches.demoHint ? escapeHtml(matches.demoHint) + '。' : '';
  const lead = leadPrefix
    ? '为你梳理了以下场景与工具资料。'
    : (keywordText ? '为你找到与 ' + keywordText + ' 相关的工具资料。' : '为你找到以下工具资料。');
  const displayed = tools.slice(0, SEARCH_ANSWER_NAMES_LIMIT);
  const remainingCount = tools.length - displayed.length;
  const toolNames = displayed.map(t => escapeHtml(t.title)).join('、');
  const moreText = remainingCount > 0 ? ' 等 ' + tools.length + ' 个工具' : '';
  return [
    '<p id="search-summary-1" tabindex="-1" data-search-summary data-search-concept-text>' + leadPrefix + lead + '</p>',
    '<p id="search-summary-2" data-search-summary data-search-concept-text>' +
      '匹配工具包括 ' + toolNames + moreText + '。点击卡片可查看优势、限制、价格与国内访问门槛。' +
    '</p>'
  ];
}

function renderSearchToolMinis(tools) {
  const section = document.querySelector('.search-tool-minis');
  const title = document.getElementById('searchToolMinisTitle');
  const list = document.getElementById('searchToolMiniList');
  if (!list) return;
  if (title) title.textContent = '匹配的工具';
  const eyebrow = section && section.querySelector('.eyebrow');
  if (eyebrow) eyebrow.textContent = '工具列表';
  const faint = section && section.querySelector('.faint');
  if (faint) faint.hidden = false;

  list.innerHTML = tools.slice(0, SEARCH_TOOL_MINIS_LIMIT).map((tool, index) => {
    const cardIcon = brandIconHtml({ vendorKey: tool.vendor_key, toolKey: tool.tool_key, modelKey: tool.detail_kind === 'api_model' ? tool.tool_key : null, emoji: tool.icon });
    const scenes = (tool.scenes || []).slice(0, 2).map(scene => '<span class="tag">' + escapeHtml(scene) + '</span>').join('');
    return '<article class="search-tool-mini" data-search-tool="' + escapeHtml(tool.tool_key) + '" data-search-source="source-' + (index + 1) + '" tabindex="0" role="button" aria-label="查看工具详情：' + escapeHtml(tool.title) + '">' +
      '<div class="search-tool-mini-head">' +
        '<div class="search-tool-mini-brand">' +
          '<span class="search-tool-mini-icon" aria-hidden="true">' + cardIcon + '</span>' +
          '<div><h3 class="search-tool-mini-title">' + escapeHtml(tool.title) + '</h3>' +
            '<span class="search-tool-mini-vendor">' + escapeHtml(tool.vendor_label || '') + '</span></div>' +
        '</div>' +
        '<a class="search-tool-mini-ext" href="' + escapeHtml(safeExternalUrl(tool.official_url)) + '" target="_blank" rel="noopener noreferrer" aria-label="访问 ' + escapeHtml(tool.title) + ' 官网">↗</a>' +
      '</div>' +
      '<p class="search-tool-mini-summary" data-search-concept-text>' + escapeHtml(tool.summary || '') + '</p>' +
      (scenes ? '<div class="search-tool-mini-tags">' + scenes + '</div>' : '') +
    '</article>';
  }).join('');
}

function buildKnowledgeAnswer(matches) {
  const keywordText = (matches.keywords || []).slice(0, 2).map(keyword => '「' + escapeHtml(keyword) + '」').join('、');
  const conclusion = keywordText
    ? '没有直接匹配的工具，为你找到与 ' + keywordText + ' 相关的热点与概念资料。'
    : '没有直接匹配的工具，为你找到相关热点与概念资料。';
  return ['<p id="search-summary-1" tabindex="-1" data-search-summary data-search-concept-text>' + conclusion + '</p>'];
}

function renderSearchKnowledge(matches) {
  const section = document.querySelector('.search-tool-minis');
  const title = document.getElementById('searchToolMinisTitle');
  const list = document.getElementById('searchToolMiniList');
  if (!list) return;
  if (title) title.textContent = '相关热点与概念';
  const eyebrow = section && section.querySelector('.eyebrow');
  if (eyebrow) eyebrow.textContent = '资料索引';
  const faint = section && section.querySelector('.faint');
  if (faint) faint.hidden = true;

  const hotspotsHtml = (matches.hotspots || []).length
    ? '<div class="search-knowledge-block"><h3 class="search-knowledge-title">相关热点</h3>' +
      matches.hotspots.slice(0, 5).map(item => {
        const htitle = hotspotField(item, 'title');
        const heat = getHotspotHeat(item);
        return '<article class="search-hotspot-item search-knowledge-hotspot" data-hotspot-id="' + escapeHtml(item.id) + '" tabindex="0" role="button" aria-label="查看热点：' + escapeHtml(htitle) + '">' +
          '<h3 class="search-hotspot-title">' + escapeHtml(htitle) + '</h3>' +
          (heat !== null ? '<span class="search-hotspot-score">热度 ' + escapeHtml(String(heat)) + '</span>' : '') +
          '<p class="search-hotspot-summary">' + escapeHtml(hotspotField(item, 'summary') || hotspotField(item, 'description') || '') + '</p>' +
          '<span class="search-hotspot-time">' + escapeHtml(timeAgo(item.published_at)) + '</span>' +
        '</article>';
      }).join('') + '</div>'
    : '';

  const conceptsHtml = (matches.concepts || []).length
    ? '<div class="search-knowledge-block"><h3 class="search-knowledge-title">相关概念</h3>' +
      matches.concepts.slice(0, 8).map(concept =>
        '<button class="search-knowledge-concept" type="button" data-search-concept-rail="' + escapeHtml(concept.term) + '">' +
          '<b>' + escapeHtml(concept.term) + '</b>' +
          (concept.full_name && concept.full_name !== concept.term ? '<span class="search-knowledge-full">' + escapeHtml(concept.full_name) + '</span>' : '') +
          (concept.summary ? '<p class="search-knowledge-summary">' + escapeHtml(concept.summary) + '</p>' : '') +
        '</button>'
      ).join('') + '</div>'
    : '';

  list.innerHTML = hotspotsHtml + conceptsHtml;
}

function renderSearchHotspots(items) {
  const rail = document.getElementById('searchHotspotsRail');
  const list = document.getElementById('searchHotspotsList');
  const content = document.getElementById('searchResultContent');
  if (!rail || !list || !content) return;
  const hasItems = (items || []).length > 0;
  rail.hidden = !hasItems;
  content.classList.toggle('has-hotspots-rail', hasItems);
  if (!hasItems) { list.innerHTML = ''; return; }

  list.innerHTML = items.map(item => {
    const title = hotspotField(item, 'title');
    const summary = hotspotField(item, 'summary') || hotspotField(item, 'description');
    const heat = getHotspotHeat(item);
    return '<article class="search-hotspot-item" data-hotspot-id="' + escapeHtml(item.id) + '" tabindex="0" role="button" aria-label="查看热点：' + escapeHtml(title) + '">' +
      '<h4 class="search-hotspot-title">' + escapeHtml(title) + '</h4>' +
      (heat !== null ? '<span class="search-hotspot-score">热度 ' + escapeHtml(String(heat)) + '</span>' : '') +
      '<p class="search-hotspot-summary">' + escapeHtml(summary) + '</p>' +
      '<span class="search-hotspot-time">' + escapeHtml(timeAgo(item.published_at)) + '</span>' +
    '</article>';
  }).join('');
}

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
  rail.hidden = false;
  const byTerm = new Map((state.glossary || []).map(g => [g && g.term, g]));
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

export function renderSearchFeedback(visible, feedback = null) {
  const section = document.getElementById('searchFeedbackSection');
  if (!section) return;
  section.hidden = !visible;
  const note = document.getElementById('searchFeedbackNote');
  if (note) {
    note.hidden = !feedback;
    note.textContent = feedback ? '感谢反馈，我们会继续改进结果。' : '';
  }
}

export function setSearchFeedback(value, searchState) {
  if (searchState) searchState.feedback = value;
  renderSearchFeedback(true, value);
}

export function markConceptsIn(root, excludeTerm = null) {
  if (!root || !state.glossary.length) return;
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
      button.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        navigateToConcept(button.dataset.searchConcept);
      });
      fragment.append(button);
      remaining = remaining.slice(found.index + found.pattern.text.length);
      matched = true;
    }
    if (matched) node.replaceWith(fragment);
  });
}

export function markSearchConcepts() {
  markConceptsIn(document.getElementById('searchResultsPanel'));
}

export function positionSearchConceptPopover(trigger) {
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

export function openSearchConcept(trigger) {
  const concept = state.glossary.find(item => item.term === trigger?.dataset.searchConcept);
  const popover = document.getElementById('searchConceptPopover');
  if (!concept || !popover) return;
  if (searchConceptRestoring) return;
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

export function closeSearchConcept({ restoreFocus = false } = {}) {
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

export function scheduleSearchConceptOpen(trigger) {
  clearTimeout(searchConceptCloseTimer);
  clearTimeout(searchConceptHoverTimer);
  searchConceptHoverTimer = window.setTimeout(() => openSearchConcept(trigger), 2000);
}

export function scheduleSearchConceptClose() {
  clearTimeout(searchConceptHoverTimer);
  clearTimeout(searchConceptCloseTimer);
  searchConceptCloseTimer = window.setTimeout(() => closeSearchConcept(), 250);
}

function highlightSearchReference(element) {
  if (!element) return;
  element.classList.remove('reference-highlight');
  window.requestAnimationFrame(() => element.classList.add('reference-highlight'));
  window.setTimeout(() => element.classList.remove('reference-highlight'), 1400);
}

export function focusSearchSource(sourceId, citation = null) {
  const source = document.querySelector('[data-search-source="' + CSS.escape(sourceId) + '"]');
  if (!source) return;
  if (citation) searchCitationOrigins.set(sourceId, citation);
  source.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  source.focus({ preventScroll: true });
  highlightSearchReference(source);
}

export function renderSearchResults(query, searchState) {
  closeSearchConcept();
  const stateEl = document.getElementById('searchResultState');
  const content = document.getElementById('searchResultContent');
  const summary = document.getElementById('searchSummaryContent');
  const userQuery = document.getElementById('searchUserQueryText');
  if (!stateEl || !content || !summary) return;

  if (userQuery) userQuery.textContent = query;
  const { matches, tools } = getSearchResultProjection(query);
  const availability = getSearchResultAvailability(matches);

  if (availability.type !== 'success') {
    stateEl.hidden = false;
    content.hidden = true;
    stateEl.className = 'search-result-state ' + availability.type;
    stateEl.innerHTML = '<div class="empty-state"><h3>' + (availability.type === 'error' ? '资料加载异常' : '未找到直接匹配') + '</h3><p>' + escapeHtml(availability.message) + '</p></div>';
    renderSearchFeedback(false);
    renderSearchHotspots([]);
    renderSearchConceptsRail([]);
    return;
  }

  stateEl.hidden = true;
  content.hidden = false;
  searchCitationOrigins.clear();

  if (matches.layer === 'knowledge') {
    summary.innerHTML = buildKnowledgeAnswer(matches).join('');
    renderSearchKnowledge(matches);
  } else {
    summary.innerHTML = buildSearchAnswer(query, tools, matches).join('');
    renderSearchToolMinis(tools);
  }

  renderSearchFeedback(true, searchState?.feedback);
  const hotspotLimit = matches.layer === 'knowledge' ? 3 : 5;
  renderSearchHotspots(getSearchHotspotRanking(query, hotspotLimit));
  markSearchConcepts();
  renderSearchConceptsRail(collectSearchConcepts());
}

export function renderSearchProcessing(searchState) {
  const panel = document.getElementById('searchProcessingPanel');
  const stage = document.getElementById('searchProcessingStage');
  if (!panel || !stage) return;
  panel.hidden = !searchState?.processing;
  stage.textContent = searchState?.processingStage || '正在处理…';
}
