/**
 * compare-models.js — 模型对比对外统一门面
 * 编排选择器、已选 chips、评测维度图表与表格视图。
 */

import { t } from './i18n.js';
import { renderState } from './ui-helpers.js';
import {
  ensureComparisonData,
  bridgeToCanonical,
  canonicalForTool,
  getModelData,
  getComparisonState,
  modelCap,
  comparisonLoadingPromise
} from './data-comparison.js';
import {
  bindCmpSplitter,
  renderWithTreeAnchor,
  renderFilterCats,
  renderModelList,
  expandSearchMatches
} from './compare-selector.js';
import {
  renderChips,
  renderVariantPopover,
  setActiveVariants,
  variantNoteFor
} from './compare-chips.js';
import {
  ALL_DIMS,
  availableDims,
  renderDimPicker,
  renderBars,
  renderRadar,
  renderBrowse,
  recomputeValues
} from './compare-dimensions.js';
import { renderTable } from './compare-table.js';

let selected = [];
let activeDims = [];
let viewMode = 'chart';
let chartMode = 'bar';
let activeVariants = {};
let variantOpenFor = null;
let searchQuery = '';
let filterTheme = 'general';
const expandedVendors = new Set();
const expandedSeries = new Set();

export const loadingPromise = comparisonLoadingPromise.then(() => {
  const { viewConfig } = getComparisonState();
  activeDims = Array.isArray(viewConfig?.default_dimensions) && viewConfig.default_dimensions.length
    ? [...viewConfig.default_dimensions]
    : [...ALL_DIMS];
  if (typeof document !== 'undefined' && document.getElementById('view-compare')?.classList.contains('active')) {
    renderModelCompare();
  }
});

export { bridgeToCanonical, canonicalForTool, modelCap };

export function modelCompareIsSelected(canonical) {
  return selected.includes(canonical);
}

function syncChartClass() {
  const panel = document.getElementById('compareModelPanel');
  if (!panel) return;
  const layout = panel.querySelector('.cmp-layout');
  if (layout) layout.classList.toggle('cmp-layout-table', viewMode === 'table');
  const out = document.getElementById('cmpChartOutput');
  if (out) out.classList.toggle('cmp-radar-mode', viewMode === 'chart' && chartMode === 'radar');
}

function syncModeButtons() {
  document.querySelectorAll('[data-cmp-view]').forEach(btn => {
    const isAct = btn.dataset.cmpView === viewMode;
    btn.classList.toggle('active', isAct);
    btn.setAttribute('aria-pressed', String(isAct));
  });
  document.querySelectorAll('[data-cmp-chart]').forEach(btn => {
    const isAct = btn.dataset.cmpChart === chartMode;
    btn.classList.toggle('active', isAct);
    btn.setAttribute('aria-pressed', String(isAct));
    btn.disabled = viewMode !== 'chart';
  });
}

function renderResults() {
  const out = document.getElementById('cmpChartOutput');
  if (!out) return;
  const { indexMap, dataMap, indexData } = getComparisonState();
  if (!selected.length) {
    ensureComparisonData().then(() => { out.innerHTML = renderBrowse(activeDims, dataMap); });
    return;
  }
  ensureComparisonData().then(() => {
    const models = selected.map(getModelData).filter(Boolean);
    if (!models.length || models.length !== selected.length) {
      out.innerHTML = renderState({ icon: '⏳', title: t('compare.loadingDetail'), message: t('compare.viewLead'), type: 'empty' });
      return;
    }
    recomputeValues(models, activeVariants, dataMap);
    if (viewMode === 'table') {
      out.innerHTML = renderTable(models, indexData?.generated_at);
      return;
    }
    if (chartMode === 'radar') {
      const radar = renderRadar(models, activeDims);
      out.innerHTML = radar || renderState({ icon: '↔', title: t('compare.radarLimitExceeded'), message: t('compare.radarLimitLead'), type: 'empty' });
      return;
    }
    const bars = renderBars(models, activeDims);
    out.innerHTML = bars || renderState({ icon: '↔', title: t('compare.noSharedDims'), message: t('compare.viewLead'), type: 'empty' });
  });
}

function renderAll() {
  const { indexSeries, indexMap, dataMap } = getComparisonState();
  renderFilterCats(filterTheme, indexSeries);
  renderModelList({ selected, indexSeries, indexMap, filterTheme, searchQuery, expandedVendors, expandedSeries });
  renderChips(selected, activeVariants, variantOpenFor, indexMap, modelCap());
  renderDimPicker(selected, activeDims, indexMap, dataMap);
  syncModeButtons();
  syncChartClass();
  renderResults();
}

function syncActiveDimsToSelection() {
  ensureComparisonData().then(() => {
    const { indexMap, dataMap } = getComparisonState();
    const available = availableDims(selected, indexMap, dataMap);
    activeDims = activeDims.filter(dim => available.includes(dim));
    renderDimPicker(selected, activeDims, indexMap, dataMap);
  });
}

export function renderModelCompare() {
  const panel = document.getElementById('compareModelPanel');
  if (!panel) return;
  const { comparisonReady, comparisonFailed } = getComparisonState();
  if (comparisonFailed) {
    panel.innerHTML = renderState({ icon: '⚠️', title: t('compare.failed.title'), message: t('compare.failed.lead'), type: 'error' });
    return;
  }
  if (!comparisonReady) {
    panel.innerHTML = renderState({ icon: '⏳', title: t('compare.loading.title'), message: t('compare.loading.lead'), type: 'empty' });
    return;
  }
  renderAll();
}

let statusTimer = null;
function setCompareModelStatus(message) {
  const el = document.getElementById('compareModelStatus');
  if (!el) return;
  el.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
}

function dispatchModelSelection() {
  window.dispatchEvent(new CustomEvent('compare-models:change', { detail: { selected: [...selected] } }));
}

function selectModel(canonical) {
  const { indexMap } = getComparisonState();
  const adding = !selected.includes(canonical);
  if (adding && selected.length >= modelCap()) {
    setCompareModelStatus(t('compare.modelCapReached', { n: modelCap() }));
    return;
  }
  if (adding) {
    selected.push(canonical);
    const index = indexMap.get(canonical);
    activeVariants[canonical] = { ...(index?.default_degree || {}) };
  } else {
    selected = selected.filter(item => item !== canonical);
    delete activeVariants[canonical];
    if (variantOpenFor === canonical) {
      variantOpenFor = null;
      document.getElementById('cmpVariantPopover')?.remove();
    }
  }
  renderAll();
  syncActiveDimsToSelection();
  dispatchModelSelection();
}

function selectSeriesVariant(memberKey, canonical) {
  const { indexSeries, indexMap } = getComparisonState();
  let found = null;
  for (const series of indexSeries) {
    const member = (series.members || []).find(item => item.member_key === memberKey);
    if (member) { found = member; break; }
  }
  if (!found) return;
  const oldCanonical = found.variants.find(variant => selected.includes(variant.canonical))?.canonical;
  if (!oldCanonical || oldCanonical === canonical) {
    found.default_canonical = canonical;
    renderAll();
    return;
  }
  selected = selected.map(item => item === oldCanonical ? canonical : item);
  delete activeVariants[oldCanonical];
  activeVariants[canonical] = { ...(indexMap.get(canonical)?.default_degree || {}) };
  found.default_canonical = canonical;
  renderAll();
  syncActiveDimsToSelection();
  dispatchModelSelection();
}

export async function routeApiModelToCompare(card) {
  await loadingPromise;
  const { comparisonFailed, indexMap, indexSeries } = getComparisonState();
  if (comparisonFailed || !card) return false;
  const canonical = bridgeToCanonical(card.title, card.tool_key);
  if (!canonical) return false;
  const adding = !selected.includes(canonical);
  if (adding && selected.length >= modelCap()) {
    setCompareModelStatus(t('compare.modelCapReached', { n: modelCap() }));
    return true;
  }
  if (adding) {
    selected.push(canonical);
    activeVariants[canonical] = { ...(indexMap.get(canonical)?.default_degree || {}) };
  } else {
    selected = selected.filter(item => item !== canonical);
    delete activeVariants[canonical];
    document.getElementById('cmpVariantPopover')?.remove();
  }
  const seriesKey = indexMap.get(canonical)?.series_key;
  const series = indexSeries.find(item => item.series_key === seriesKey);
  if (seriesKey) expandedSeries.add(seriesKey);
  if (series) expandedVendors.add(series.vendor || 'unknown');
  renderAll();
  dispatchModelSelection();
  return true;
}

export function bindModelCompareEvents() {
  const panel = document.getElementById('compareModelPanel');
  if (!panel) return;
  bindCmpSplitter();

  const cmpSearch = document.getElementById('cmpModelSearch');
  const cmpSearchClear = document.getElementById('cmpModelSearchClear');
  let timer;
  cmpSearch?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      searchQuery = cmpSearch.value;
      const { indexSeries, indexMap } = getComparisonState();
      expandSearchMatches(searchQuery, filterTheme, indexSeries, expandedVendors, expandedSeries);
      renderModelList({ selected, indexSeries, indexMap, filterTheme, searchQuery, expandedVendors, expandedSeries });
      renderResults();
    }, 150);
    cmpSearchClear.style.display = cmpSearch.value ? 'block' : 'none';
  });
  cmpSearchClear?.addEventListener('click', () => {
    cmpSearch.value = '';
    searchQuery = '';
    expandedVendors.clear();
    expandedSeries.clear();
    cmpSearchClear.style.display = 'none';
    const { indexSeries, indexMap } = getComparisonState();
    renderModelList({ selected, indexSeries, indexMap, filterTheme, searchQuery, expandedVendors, expandedSeries });
    renderResults();
    cmpSearch.focus();
  });

  panel.addEventListener('click', event => {
    const vToggle = event.target.closest('[data-cmp-vendor-toggle]');
    if (vToggle) {
      const k = vToggle.dataset.cmpVendorToggle;
      renderWithTreeAnchor(vToggle, () => {
        if (expandedVendors.has(k)) expandedVendors.delete(k); else expandedVendors.add(k);
        const { indexSeries, indexMap } = getComparisonState();
        renderModelList({ selected, indexSeries, indexMap, filterTheme, searchQuery, expandedVendors, expandedSeries });
      });
      return;
    }
    const sToggle = event.target.closest('[data-cmp-series-toggle]');
    if (sToggle) {
      const k = sToggle.dataset.cmpSeriesToggle;
      renderWithTreeAnchor(sToggle, () => {
        if (expandedSeries.has(k)) expandedSeries.delete(k); else expandedSeries.add(k);
        const { indexSeries, indexMap } = getComparisonState();
        renderModelList({ selected, indexSeries, indexMap, filterTheme, searchQuery, expandedVendors, expandedSeries });
      });
      return;
    }
    const pick = event.target.closest('[data-cmp-pick]');
    if (pick) { renderWithTreeAnchor(pick, () => selectModel(pick.dataset.cmpPick)); return; }
    const remove = event.target.closest('[data-cmp-remove]');
    if (remove) { selectModel(remove.dataset.cmpRemove); return; }
    const vTrigger = event.target.closest('[data-cmp-variant]');
    if (vTrigger) {
      const canonical = vTrigger.dataset.cmpVariant;
      const pop = document.getElementById('cmpVariantPopover');
      if (pop && pop.dataset.model === canonical) {
        pop.remove(); variantOpenFor = null;
      } else {
        variantOpenFor = canonical;
        const { indexMap } = getComparisonState();
        renderVariantPopover(vTrigger, canonical, activeVariants, indexMap);
        renderChips(selected, activeVariants, variantOpenFor, indexMap, modelCap());
      }
      return;
    }
    const slot = event.target.closest('[data-cmp-variant-slot]');
    if (slot) {
      const canonical = slot.dataset.cmpVariantModel;
      const degree = slot.dataset.cmpVariantSlot;
      const { indexMap, dataMap } = getComparisonState();
      const model = getModelData(canonical) || indexMap.get(canonical);
      let note = '';
      if (model) {
        const changes = setActiveVariants(model, degree, activeVariants);
        note = variantNoteFor(model, changes, activeVariants);
        if (dataMap.has(canonical)) recomputeValues([dataMap.get(canonical)], activeVariants, dataMap);
      }
      variantOpenFor = null;
      document.getElementById('cmpVariantPopover')?.remove();
      renderChips(selected, activeVariants, variantOpenFor, indexMap, modelCap());
      renderResults();
      if (note) setCompareModelStatus(note);
      return;
    }
    const close = event.target.closest('[data-cmp-variant-close]');
    if (close) {
      variantOpenFor = null;
      document.getElementById('cmpVariantPopover')?.remove();
      renderChips(selected, activeVariants, variantOpenFor, getComparisonState().indexMap, modelCap());
      return;
    }
    const dim = event.target.closest('[data-cmp-dim]');
    if (dim) {
      const key = dim.dataset.cmpDim;
      activeDims = activeDims.includes(key) ? activeDims.filter(item => item !== key) : [...activeDims, key];
      const { indexMap, dataMap } = getComparisonState();
      renderDimPicker(selected, activeDims, indexMap, dataMap);
      renderResults();
      return;
    }
    const viewBtn = event.target.closest('[data-cmp-view]');
    if (viewBtn) {
      viewMode = viewBtn.dataset.cmpView;
      syncChartClass(); syncModeButtons(); renderResults();
      return;
    }
    const chartBtn = event.target.closest('[data-cmp-chart]');
    if (chartBtn) {
      chartMode = chartBtn.dataset.cmpChart;
      syncChartClass(); syncModeButtons(); renderResults();
      return;
    }
    const cat = event.target.closest('[data-cmp-cat]');
    if (cat) {
      filterTheme = cat.dataset.cmpCat;
      const { indexMap, indexSeries } = getComparisonState();
      selected = selected.filter(c => !indexMap.get(c) || indexMap.get(c).theme === filterTheme);
      activeVariants = Object.fromEntries(Object.entries(activeVariants).filter(([c]) => selected.includes(c)));
      if (variantOpenFor && !selected.includes(variantOpenFor)) {
        variantOpenFor = null; document.getElementById('cmpVariantPopover')?.remove();
      }
      expandedVendors.clear(); expandedSeries.clear();
      expandSearchMatches(searchQuery, filterTheme, indexSeries, expandedVendors, expandedSeries);
      renderFilterCats(filterTheme, indexSeries);
      renderModelList({ selected, indexSeries, indexMap, filterTheme, searchQuery, expandedVendors, expandedSeries });
      renderResults();
    }
  });

  panel.addEventListener('change', event => {
    const revision = event.target.closest('[data-cmp-revision]');
    if (revision) renderWithTreeAnchor(revision, () => selectSeriesVariant(revision.dataset.cmpRevision, revision.value));
  });
  panel.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key)) return;
    const slot = event.target.closest('[data-cmp-variant-slot]');
    if (slot) { event.preventDefault(); slot.click(); }
  });
  document.addEventListener('click', event => {
    const pop = document.getElementById('cmpVariantPopover');
    if (!pop || event.target.closest('#cmpVariantPopover') || event.target.closest('[data-cmp-variant]')) return;
    variantOpenFor = null; pop.remove();
    renderChips(selected, activeVariants, variantOpenFor, getComparisonState().indexMap, modelCap());
  });
}
