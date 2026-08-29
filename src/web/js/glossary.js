/**
 * 知览 KnowView MVP — AI 概念视图 (glossary)：43 条术语，分类筛选 + 搜索 + 可展开详情
 *
 * 数据驱动：分类 chip 从 glossary.json 的 category 字段动态提取，
 * 新增术语分类无需修改前端代码。
 * 分类 chip 点击由 main.js 在 #glossaryCategories 上委托监听。
 * 架构概要、八个视图与扩展模式见 main.js 顶部维护文档。
 */
import {
  glossary,
  activeGlossaryCategory,
  setActiveGlossaryCategory,
  getFilteredGlossary,
  escapeHtml,
  safeExternalUrl,
  renderState,
  setRegionBusy,
  dataLoadFailures,
} from './data.js';
import { markConceptsIn, closeSearchConcept } from './search.js';
import { switchView } from './main.js';

let activeGlossaryId = null; // 决策 9.7：当前选中的概念词条

// 跨模块状态 setter（ESM：导入绑定只读，改值必须回到本模块）
function setActiveGlossaryId(value) { activeGlossaryId = value; }

function openGlossaryConcept(term) {
  closeSearchConcept();
  const input = document.getElementById('glossarySearch');
  if (input) input.value = term;
  setActiveGlossaryCategory('all');
  setActiveGlossaryId(term);
  switchView('glossary');
  window.requestAnimationFrame(() => {
    const item = document.querySelector('.glossary-index-item[data-glossary-pick="' + CSS.escape(term) + '"]');
    item?.focus();
    item?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  });
}

function renderGlossary() {
  const categories = [...new Set(glossary.map(g => g.category))];
  const catEl = document.getElementById('glossaryCategories');
  catEl.innerHTML =
    '<button class="filter-chip' + (activeGlossaryCategory === 'all' ? ' active' : '') + '" type="button" data-cat="all" aria-pressed="' + (activeGlossaryCategory === 'all' ? 'true' : 'false') + '">全部</button>' +
    categories.map(c =>
      '<button class="filter-chip' + (activeGlossaryCategory === c ? ' active' : '') + '" type="button" data-cat="' + escapeHtml(c) + '" aria-pressed="' + (activeGlossaryCategory === c ? 'true' : 'false') + '">' + escapeHtml(c) + '</button>'
    ).join('');

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
    setActiveGlossaryId(filtered[0].term);
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

export {
  activeGlossaryId,
  setActiveGlossaryId,
  openGlossaryConcept,
  renderGlossary,
  renderGlossaryDetail,
};
