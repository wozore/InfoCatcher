/**
 * 知览 KnowView MVP — 对比模式 (compare)：2-5 个工具并排比较 10+ 维度
 * 架构概要、八个视图与扩展模式见 main.js 顶部维护文档。
 */

import { state, switchView, getCurrentView, notifyCompareChange } from './state.js';
import { getToolCardItems, getToolLevel3Item, getVendorLevel2Item, getToolSearchText } from './data-catalog.js';
import { formatPrice, escapeHtml, renderState } from './ui-helpers.js';
import { ICON_CLOSE } from './ui-icons.js';
import { showModal, closeModal } from './modal.js';
import { getToolDateDisplay } from './date-display.mjs';
import {
  routeApiModelToCompare,
  canonicalForTool,
  modelCompareIsSelected,
  renderModelCompare,
} from './compare-models.js';
import { brandIconHtml } from './brand-icons.js';

export let compareList = state.compareList;

export function getCompareTab() {
  return state.compareTab;
}

export function setCompareTab(tab) {
  state.compareTab = tab === 'tool' ? 'tool' : 'model';
  const modelTabBtn = document.getElementById('compareTabModel');
  const toolTabBtn = document.getElementById('compareTabTool');
  const modelPanel = document.getElementById('compareModelPanel');
  const toolPanel = document.getElementById('compareToolPanel');
  if (modelTabBtn) {
    modelTabBtn.classList.toggle('active', state.compareTab === 'model');
    modelTabBtn.setAttribute('aria-selected', String(state.compareTab === 'model'));
  }
  if (toolTabBtn) {
    toolTabBtn.classList.toggle('active', state.compareTab === 'tool');
    toolTabBtn.setAttribute('aria-selected', String(state.compareTab === 'tool'));
  }
  if (modelPanel) modelPanel.hidden = state.compareTab !== 'model';
  if (toolPanel) toolPanel.hidden = state.compareTab !== 'tool';
  if (state.compareTab === 'model') renderModelCompare();
  else renderCompare();
}

export function renderCompareView() {
  if (state.compareTab === 'model') renderModelCompare();
  else renderCompare();
}

export function compareKey(ref) {
  return ref.toolId + '::' + (ref.itemId || 'root');
}

export function isComparableLeaf(toolId, itemId) {
  const item = getToolLevel3Item(toolId, itemId);
  return Boolean(item && ['tool', 'api_model', 'product_variant', 'subscription_plan'].includes(item.detail_kind));
}

export function isCompareSelected(toolId, itemId = null) {
  const canonical = canonicalForTool(toolId, itemId);
  if (canonical && modelCompareIsSelected(canonical)) return true;
  return state.compareList.some(ref => compareKey(ref) === compareKey({ toolId, itemId }));
}

let compareStatusTimer = null;
function setCompareStatus(message) {
  const el = document.getElementById('compareStatus');
  if (!el) return;
  el.textContent = message;
  clearTimeout(compareStatusTimer);
  compareStatusTimer = window.setTimeout(() => { el.textContent = ''; }, 4000);
}

function resolveCompareTarget(ref) {
  const detailId = ref.itemId || ref.toolId;
  const detail = String(detailId).startsWith('tool-level3:') ? getToolLevel3Item('', detailId) : getToolLevel3Item(ref.toolId, detailId);
  if (!detail) return null;
  const card = getToolCardItems().find(item => item.detail_ref?.id === detail.id) || null;
  if (!card && detail.detail_kind !== 'subscription_plan') return null;
  return {
    type: detail.detail_kind === 'tool' ? 'root' : 'leaf',
    kind: detail.detail_kind,
    tool: card,
    item: detail,
    name: detail.title,
    icon: detail.icon || card?.icon || '',
    iconContext: {
      vendorKey: detail.vendor_key || card?.vendor_key,
      toolKey: card?.tool_key,
      modelKey: detail.detail_kind === 'api_model' ? String(detail.id).split(':').pop() : null,
      emoji: detail.icon || card?.icon || '',
    },
  };
}

export function toggleCompareRef(toolId, itemId = null, btn) {
  const ref = { toolId, itemId };
  const target = resolveCompareTarget(ref);
  if (!target) return;
  if (target.kind === 'api_model') {
    const card = getToolCardItems().find(cardItem => cardItem.detail_ref?.id === target.item.id);
    if (card) {
      routeApiModelToCompare(card).then(canonical => {
        if (canonical) {
          const nowSelected = modelCompareIsSelected(canonical);
          if (btn) {
            btn.classList.toggle('selected', nowSelected);
            btn.setAttribute('aria-pressed', String(nowSelected));
            btn.textContent = nowSelected ? '已选' : '+对比';
          }
          closeModal();
          setCompareTab('model');
          if (getCurrentView() !== 'compare') switchView('compare');
          notifyCompareChange();
        } else {
          addToToolCompare(ref, target, btn);
        }
      });
      return;
    }
  }
  addToToolCompare(ref, target, btn);
}

function addToToolCompare(ref, target, btn) {
  const key = compareKey(ref);
  const idx = state.compareList.findIndex(candidate => compareKey(candidate) === key);
  if (idx >= 0) {
    state.compareList.splice(idx, 1);
    if (btn) { btn.classList.remove('selected'); btn.setAttribute('aria-pressed', 'false'); btn.textContent = '+对比'; }
  } else {
    if (state.compareList.length >= 5) {
      setCompareStatus('最多对比 5 项');
      return;
    }
    const existingKinds = state.compareList.map(resolveCompareTarget).filter(Boolean).map(candidate => candidate.kind);
    if (existingKinds.length && existingKinds.some(kind => kind !== target.kind)) {
      setCompareStatus('模型、套餐与具体工具不能混合对比，请先移除不同类型的项目。');
      return;
    }
    state.compareList.push(ref);
    if (btn) { btn.classList.add('selected'); btn.setAttribute('aria-pressed', 'true'); btn.textContent = '已选'; }
  }
  compareList = state.compareList;
  updateCompareCount();
  notifyCompareChange();
  if (getCurrentView() === 'compare') renderCompareView();
}

export function compareGroupLeaves(toolId, groupId) {
  const level2 = getVendorLevel2Item(toolId, groupId);
  const leaves = (level2?.detail_refs || []).map(ref => getToolLevel3Item(toolId, ref.id)).filter(Boolean).filter(item => isComparableLeaf(toolId, item.id));
  if (leaves.length < 2) return;
  if (leaves.length > 5) {
    setCompareStatus('该分类超过 5 个可比较项目，请在下方逐项选择最多 5 个后再进入对比。');
    return;
  }
  const kind = leaves[0].detail_kind;
  if (!leaves.every(item => item.detail_kind === kind)) {
    setCompareStatus('该分类包含不同类型的项目，不能混合对比。');
    return;
  }
  state.compareList = leaves.map(item => ({ toolId: item.id, itemId: item.id }));
  compareList = state.compareList;
  updateCompareCount();
  notifyCompareChange();
  closeModal();
  setCompareTab('tool');
  switchView('compare');
}

export function updateCompareCount() {
  const el = document.getElementById('compareCount');
  if (el) el.textContent = state.compareList.length;
}

function compareTargetLabel(target) {
  return target.icon + ' ' + target.name;
}

function compareTargetLabelHtml(target) {
  return brandIconHtml(target.iconContext) + ' ' + escapeHtml(target.name);
}

function renderCompareProvenance(targets) {
  const rows = targets.map(target => {
    const titles = (target.item?.sources || []).map(source => source.title).filter(Boolean);
    const dateDisplay = getToolDateDisplay(target.item);
    const date = dateDisplay ? ' · ' + dateDisplay.label + ' ' + dateDisplay.value : '';
    return { nameHtml: compareTargetLabelHtml(target), text: '资料来源：' + (titles.length ? titles.join('、') : '来源待补充') + date };
  });
  return '<div class="compare-provenance" aria-label="对比数据来源与日期">' +
    rows.map(row => '<div class="compare-provenance-row"><span class="compare-provenance-name">' + row.nameHtml + '</span><span class="compare-provenance-text">' + escapeHtml(row.text) + '</span></div>').join('') +
  '</div>';
}

function renderCompareBars(targets) {
  if (targets[0].kind !== 'api_model' && targets[0].kind !== 'subscription_plan') return '';
  const priced = targets.map(target => {
    let price = null, currency = null;
    if (target.kind === 'api_model') {
      const rate = target.item.api_pricing?.rate_cards?.[0];
      if (rate && Number.isFinite(Number(rate.output))) { price = Number(rate.output); currency = rate.currency; }
    } else {
      const plan = target.item.plan;
      if (plan && plan.amount != null && plan.currency) { price = Number(plan.amount); currency = plan.currency; }
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
      return '<div class="compare-bar-item"><span class="compare-bar-name">' + compareTargetLabelHtml(p.target) + '</span>' +
        '<div class="compare-bar-track" role="img" aria-label="' + escapeHtml(compareTargetLabel(p.target) + (valid ? ' ' + symbol + Number(p.price).toLocaleString('zh-CN') + unit : ' 暂无可比数据')) + '">' +
          (valid ? '<span class="compare-bar-fill" style="width:' + pct + '%"></span>' : '<span class="compare-bar-empty">暂无可比数据</span>') +
        '</div><span class="compare-bar-value">' + (valid ? symbol + Number(p.price).toLocaleString('zh-CN') + unit : '—') + '</span></div>';
    }).join('');
    return '<section class="compare-bars" aria-labelledby="compareBarsTitle"><div class="compare-bars-heading"><h3 id="compareBarsTitle">关键数据对比</h3>' +
      '<span class="compare-bars-note">横向条仅在同一口径下比较；单位与数值以下方表格为准，数据来源与查询时间见下。</span></div>' +
      '<div class="compare-bar-row"><div class="compare-bar-label">' + (targets[0].kind === 'api_model' ? '输出价' : '套餐价格') + '</div><div class="compare-bar-group">' + rows + '</div></div>' +
      renderCompareProvenance(targets) + '</section>';
  }
  if (!withPrice.length) return '';
  return '<section class="compare-bars"><div class="compare-bars-gate"><strong>口径不同，不直接比较。</strong>各项目价格币种或口径不一致，仅保留下方表格逐项查看。</div></section>';
}

function renderRootToolCompare(targets) {
  const dims = [
    { key: 'access_level', label: '国内访问', format: v => ({ '开放': '可访问', '受限': '访问受限', '区域限制': '区域限制' }[v] || '访问待核验') },
    { key: 'price_badge', label: '价格状态', format: v => ({ free: '免费', paid: '仅付费', freemium: '含免费额度', usage_based: '按量计费' }[v] || '价格待核验') }
  ];
  return '<table class="compare-table"><thead><tr><th>维度</th>' + targets.map(t => '<th>' + compareTargetLabelHtml(t) + '</th>').join('') + '</tr></thead><tbody>' +
    dims.map(d => '<tr><td class="dim">' + d.label + '</td>' + targets.map(t => '<td>' + escapeHtml(d.format(t.tool?.[d.key])) + '</td>').join('') + '</tr>').join('') +
    '<tr><td class="dim">适用场景</td>' + targets.map(t => '<td>' + escapeHtml((t.tool?.scenes || []).slice(0, 5).join('、')) + '</td>').join('') + '</tr>' +
    '<tr><td class="dim">适合场景</td>' + targets.map(t => '<td>' + escapeHtml(t.tool?.best_for_preview || '') + '</td>').join('') + '</tr>' +
    '<tr><td class="dim">不适合/限制</td>' + targets.map(t => '<td>' + escapeHtml(t.tool?.not_for_preview || '') + '</td>').join('') + '</tr>' +
    '<tr><td class="dim">资料来源 / 日期</td>' + targets.map(t => {
      const titles = (t.item?.sources || []).map(s => s.title).filter(Boolean).join('、') || '来源待补充';
      const d = getToolDateDisplay(t.item);
      return '<td>' + escapeHtml(titles + (d ? ' · ' + d.label + ' ' + d.value : ' · 日期待核验')) + '</td>';
    }).join('') + '</tr></tbody></table>';
}

function formatApiPricing(item) {
  if (item.api_pricing?.status === 'not_applicable') return '不适用：' + (item.api_pricing.reason || '未说明原因');
  const rate = item.api_pricing?.rate_cards?.[0];
  if (!rate) return '暂无可比数据';
  if (Array.isArray(rate.metrics) && rate.metrics.length) {
    return rate.metrics.map(m => escapeHtml(m.label) + ' ' + formatPrice(m.amount, rate.currency) + ' / ' + escapeHtml(m.unit)).join('<br>') + '<br><small>' + escapeHtml(rate.pricing_basis || '') + '</small>';
  }
  const parts = [];
  if (Number.isFinite(Number(rate.input))) parts.push('输入 ' + formatPrice(rate.input, rate.currency));
  if (Number.isFinite(Number(rate.output))) parts.push('输出 ' + formatPrice(rate.output, rate.currency));
  return parts.length ? parts.join(' · ') + ' / 百万 tokens<br><small>' + escapeHtml(rate.pricing_basis || '') + '</small>' : '暂无可比数据';
}

function renderLeafCompareTable(targets) {
  const first = targets[0].item;
  const isApi = first.detail_kind === 'api_model';
  const isPlan = first.detail_kind === 'subscription_plan';
  return '<table class="compare-table"><thead><tr><th>维度</th>' + targets.map(t => '<th>' + compareTargetLabelHtml(t) + '</th>').join('') + '</tr></thead><tbody>' +
    '<tr><td class="dim">类型</td>' + targets.map(t => '<td>' + escapeHtml(t.item.detail_kind === 'api_model' ? 'API 模型' : t.item.detail_kind === 'subscription_plan' ? '订阅套餐' : '具体产品') + '</td>').join('') + '</tr>' +
    '<tr><td class="dim">简介</td>' + targets.map(t => '<td>' + escapeHtml(t.item.summary || '待补充') + '</td>').join('') + '</tr>' +
    (isApi ? '<tr><td class="dim">API 定价</td>' + targets.map(t => '<td>' + formatApiPricing(t.item) + '</td>').join('') + '</tr>' : '') +
    (isPlan ? '<tr><td class="dim">套餐价格</td>' + targets.map(t => '<td>' + (t.item.plan ? formatPrice(t.item.plan.amount, t.item.plan.currency) + ' / ' + escapeHtml(t.item.plan.interval === 'monthly' ? '月' : t.item.plan.interval === 'yearly' ? '年' : t.item.plan.interval || '期') : '未提供') + '</td>').join('') + '</tr>' : '') +
    '<tr><td class="dim">资料来源 / 日期</td>' + targets.map(t => {
      const titles = (t.item?.sources || []).map(s => s.title).filter(Boolean).join('、') || '来源待补充';
      const d = getToolDateDisplay(t.item);
      return '<td>' + escapeHtml(titles + (d ? ' · ' + d.label + ' ' + d.value : ' · 日期待核验')) + '</td>';
    }).join('') + '</tr></tbody></table>';
}

export function renderCompare() {
  const container = document.getElementById('compareContent');
  const countBadge = document.getElementById('toolCompareCount');
  if (!container) return;
  const targets = state.compareList.map(resolveCompareTarget).filter(Boolean);
  if (countBadge) countBadge.textContent = targets.length;

  if (targets.length < 2) {
    const remaining = 2 - targets.length;
    container.innerHTML = '<div class="compare-empty"><div class="compare-empty-icon" aria-hidden="true">⚖️</div>' +
      '<h3>还需添加 ' + remaining + ' 个项目</h3><p>请在下方选择项目加入对比，或在浏览工具/模型时点击「+对比」。</p>' +
      '<button class="btn btn-primary" type="button" onclick="openAddComparePanel()"><svg class="icon" aria-hidden="true"><use href="#icon-plus"/></svg> 添加对比项目</button></div>';
    return;
  }

  const firstKind = targets[0].kind;
  if (!targets.every(t => t.kind === firstKind)) {
    container.innerHTML = '<div class="compare-empty"><div class="compare-empty-icon" aria-hidden="true">⚠️</div>' +
      '<h3>已选项目类型不一致</h3><p>模型、套餐与具体工具不能混合对比，请先移除不同类型的项目。</p>' +
      '<div class="compare-chips">' + targets.map(t => '<span class="compare-chip">' + compareTargetLabelHtml(t) +
      '<button type="button" aria-label="移除 ' + escapeHtml(t.name) + '" onclick="removeCompare(\'' + escapeHtml(t.tool?.tool_key || t.item.id) + '\',\'' + escapeHtml(t.item.id) + '\')">×</button></span>').join('') + '</div></div>';
    return;
  }

  const chipsHtml = '<div class="compare-chips">' +
    targets.map(t => '<span class="compare-chip">' + compareTargetLabelHtml(t) +
      '<button type="button" aria-label="移除 ' + escapeHtml(t.name) + '" onclick="removeCompare(\'' + escapeHtml(t.tool?.tool_key || t.item.id) + '\',\'' + escapeHtml(t.item.id) + '\')">×</button></span>').join('') +
    (targets.length < 5 ? '<button class="btn btn-small compare-add-trigger" type="button" onclick="openAddComparePanel()"><svg class="icon" aria-hidden="true"><use href="#icon-plus"/></svg> 添加项目</button>' : '') +
  '</div>';
  const isAllRoot = targets.every(t => t.type === 'root');
  const isAllLeaf = targets.every(t => t.type === 'leaf');
  const tableHtml = isAllRoot ? renderRootToolCompare(targets) : isAllLeaf ? renderLeafCompareTable(targets) : '';
  container.innerHTML = chipsHtml + renderCompareBars(targets) + '<div class="compare-table-wrapper">' + tableHtml + '</div>';
}

function getAddCompareTargets(query = '') {
  const currentKinds = state.compareList.map(resolveCompareTarget).filter(Boolean).map(c => c.kind);
  const targetKind = currentKinds[0] || null;
  const normalizedQuery = query.toLowerCase().trim();
  const results = [];
  const existingKeys = new Set(state.compareList.map(compareKey));

  for (const card of getToolCardItems()) {
    const detail = card.detail_ref ? getToolLevel3Item(card.vendor_key, card.detail_ref.id) : null;
    if (!detail || (targetKind && detail.detail_kind !== targetKind)) continue;
    const ref = { toolId: card.tool_key, itemId: detail.id };
    if (existingKeys.has(compareKey(ref))) continue;
    const searchText = (getToolSearchText(card) + ' ' + detail.title).toLowerCase();
    if (normalizedQuery && !searchText.includes(normalizedQuery)) continue;
    results.push({ ref, name: detail.title, kind: detail.detail_kind, vendor: card.vendor_label || '', iconContext: { vendorKey: detail.vendor_key, toolKey: card.tool_key, modelKey: detail.detail_kind === 'api_model' ? String(detail.id).split(':').pop() : null, emoji: card.icon } });
  }
  return results.slice(0, 20);
}

export function openAddComparePanel(trigger = null) {
  const content = document.getElementById('modalContent');
  if (!content) return;
  content.innerHTML = '<button class="modal-close" type="button" aria-label="关闭添加工具" onclick="closeModal()">' + ICON_CLOSE + '</button>' +
    '<div class="add-compare-panel"><h2>添加对比项目</h2>' +
      '<div class="search-box"><input type="text" id="addCompareSearch" placeholder="搜索工具或模型名称…" aria-label="搜索添加项目"></div>' +
      '<div id="addCompareList" class="add-compare-list"></div></div>';
  renderAddCompare();
  const searchInput = document.getElementById('addCompareSearch');
  searchInput?.addEventListener('input', () => renderAddCompare(searchInput.value));
  showModal(trigger);
}

export function renderAddCompare(query = '') {
  const listEl = document.getElementById('addCompareList');
  if (!listEl) return;
  const items = getAddCompareTargets(query);
  if (!items.length) {
    listEl.innerHTML = renderState({ icon: '⌕', title: '没有找到可添加的项目', message: '请尝试不同关键词，或确认已有项目类型是否与搜索目标一致。', type: 'no-match' });
    return;
  }
  listEl.innerHTML = items.map(item =>
    '<div class="add-compare-item">' +
      '<span class="add-compare-item-icon" aria-hidden="true">' + brandIconHtml(item.iconContext) + '</span>' +
      '<div class="add-compare-item-info"><strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml(item.vendor) + '</small></div>' +
      '<button class="btn btn-small" type="button" onclick="toggleCompareRef(\'' + escapeHtml(item.ref.toolId) + '\',\'' + escapeHtml(item.ref.itemId) + '\',this);closeModal();renderCompareView();">+对比</button>' +
    '</div>'
  ).join('');
}

export function removeCompare(toolId, itemId = null) {
  const key = compareKey({ toolId, itemId });
  state.compareList = state.compareList.filter(ref => compareKey(ref) !== key);
  compareList = state.compareList;
  updateCompareCount();
  notifyCompareChange();
  renderCompare();
}

export function quickCompare(ids) {
  state.compareList = ids.map(toolKey => {
    const card = getToolCardItems().find(item => item.tool_key === toolKey);
    return card ? { toolId: card.detail_ref.id, itemId: card.detail_ref.id } : null;
  }).filter(Boolean).slice(0, 5);
  compareList = state.compareList;
  updateCompareCount();
  notifyCompareChange();
  setCompareTab('tool');
  renderCompare();
}
