/**
 * InfoCatcher MVP — 对比模式 (compare)：2-5 个工具并排比较 10+ 维度
 *
 * 核心函数：
 *   toggleCompareRef() — 添加/移除对比（上限 5 个，按钮状态同步）
 *   renderCompare()    — 渲染 10+ 维度对比表
 *   removeCompare()    — 从对比列表中移除单个工具
 *   quickCompare()     — 一键加载预设对比方案
 * EXTENSION POINT：方案一——>方案三时，将对比简略结果【renderCompare()】显示为柱状图
 *
 * 本模块持有对比列表状态 compareList 及共享对比谓词
 * （compareKey / isComparableRootTool / isComparableLeaf / isCompareSelected），
 * 供工具库（tools.js）、场景（scenes.js）与搜索匹配复用。
 * 架构概要、八个视图与扩展模式见 main.js 顶部维护文档。
 */
import {
  tools,
  getToolCardItems,
  getToolLevel3Item,
  getVendorLevel2Item,
  getToolSearchText,
  formatPrice,
  escapeHtml,
  renderState,
  ICON_CLOSE,
} from './data.js';
import { renderTools, closeModal, showModal } from './tools.js';
import { currentView, switchView } from './main.js';

// ═══════════════════════════════════════════════════════════════
// 对比状态 —— 共享谓词与列表
// ═══════════════════════════════════════════════════════════════
let compareList = [];         // { toolId, itemId } 稳定比较引用；itemId 为 null 表示具体根工具

function compareKey(ref) {
  return ref.toolId + '::' + (ref.itemId || 'root');
}

function isComparableRootTool(tool) {
  return Boolean(tool && ['tool', 'api_model', 'product_variant'].includes(tool.detail_kind));
}

function isComparableLeaf(toolId, itemId) {
  const item = getToolLevel3Item(toolId, itemId);
  return Boolean(item && ['tool', 'api_model', 'product_variant', 'subscription_plan'].includes(item.detail_kind));
}

function isCompareSelected(toolId, itemId = null) {
  return compareList.some(ref => compareKey(ref) === compareKey({ toolId, itemId }));
}

// 决策 100：对比上限/类型冲突的页面内提示（aria-live，短暂显示后自动清除）
let compareStatusTimer = null;
function setCompareStatus(message) {
  const el = document.getElementById('compareStatus');
  if (!el) return;
  el.textContent = message;
  clearTimeout(compareStatusTimer);
  compareStatusTimer = window.setTimeout(() => { el.textContent = ''; }, 4000);
}

// ═══════════════════════════════════════════════════════════════
// 对比核心逻辑
// ═══════════════════════════════════════════════════════════════
function resolveCompareTarget(ref) {
  const detailId = ref.itemId || ref.toolId;
  const detail = String(detailId).startsWith('tool-level3:') ? getToolLevel3Item('', detailId) : getToolLevel3Item(ref.toolId, detailId);
  if (!detail) return null;
  const card = getToolCardItems().find(item => item.detail_ref?.id === detail.id) || null;
  // 套餐没有工具卡，只允许通过厂商二级详情的同类组入口加入。
  if (!card && detail.detail_kind !== 'subscription_plan') return null;
  return { type: detail.detail_kind === 'tool' ? 'root' : 'leaf', kind: detail.detail_kind, tool: card, item: detail, name: detail.title, icon: detail.icon || card?.icon || '' };
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
  compareList = leaves.map(item => ({ toolId: item.id, itemId: item.id }));
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

function renderCompareProvenance(targets) {
  const rows = targets.map(target => {
    const titles = (target.item?.sources || []).map(source => source.title).filter(Boolean);
    const dateLabel = target.kind === 'tool' ? '更新时间' : target.kind === 'subscription_plan' ? '' : '发布时间';
    const date = target.item?.official_date ? ' · ' + dateLabel + ' ' + target.item.official_date : '';
    return { name: compareTargetLabel(target), text: '资料来源：' + (titles.length ? titles.join('、') : '来源待补充') + date };
  });
  return '<div class="compare-provenance" aria-label="对比数据来源与官方日期">' +
    rows.map(row => '<div class="compare-provenance-row"><span class="compare-provenance-name">' + escapeHtml(row.name) + '</span><span class="compare-provenance-text">' + escapeHtml(row.text) + '</span></div>').join('') +
  '</div>';
}

// 决策 9.5/93：关键量化指标横向柱状图。只对真实、同口径数值绘制；
// 缺失不画 0 柱，币种/口径不一致时不直接比较。颜色不作为唯一区分，保留表格文本替代。
function renderCompareBars(targets) {
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
        '<span class="compare-bars-note">横向条仅在同一口径下比较；单位与数值以下方表格为准，数据来源与查询时间见下。</span></div>' +
        '<div class="compare-bar-row"><div class="compare-bar-label">' + (targets[0].kind === 'api_model' ? '输出价' : '套餐价格') + '</div><div class="compare-bar-group">' + rows + '</div></div>' +
        renderCompareProvenance(targets) +
      '</section>';
    }
    return '<section class="compare-bars"><div class="compare-bars-gate"><strong>口径不同，不直接比较。</strong>各项目价格币种或口径不一致，仅保留下方表格逐项查看。</div></section>';
  }
  return '';
}

function renderRootToolCompare(targets) {
  const dims = [
    { key: 'access_level', label: '国内访问', format: value => value === '开放' ? '可访问' : '需科学上网' },
    { key: 'has_free', label: '免费层', format: value => value ? '有' : '无' }
  ];
  return '<table class="compare-table"><thead><tr><th>维度</th>' + targets.map(target => '<th>' + escapeHtml(compareTargetLabel(target)) + '</th>').join('') + '</tr></thead><tbody>' +
    dims.map(dimension => '<tr><td class="dim">' + dimension.label + '</td>' + targets.map(target => {
      const value = dimension.key === 'has_free' ? target.tool?.price_badge === 'free' : target.tool?.[dimension.key];
      return '<td>' + escapeHtml(dimension.format(value)) + '</td>';
    }).join('') + '</tr>').join('') +
    '<tr><td class="dim">适用场景</td>' + targets.map(target => '<td>' + escapeHtml((target.tool?.scenes || []).slice(0, 5).join('、')) + '</td>').join('') + '</tr>' +
    '<tr><td class="dim">最适合</td>' + targets.map(target => '<td>' + escapeHtml(target.tool?.best_for_preview || '') + '</td>').join('') + '</tr>' +
    '<tr><td class="dim">不适合/限制</td>' + targets.map(target => '<td>' + escapeHtml(target.tool?.not_for_preview || '') + '</td>').join('') + '</tr>' +
    '<tr><td class="dim">资料来源 / 更新时间</td>' + targets.map(target => {
      const detail = target.item;
      const titles = (detail.sources || []).map(source => source.title).filter(Boolean).join('、') || '来源待补充';
      return '<td>' + escapeHtml(titles + (detail.official_date ? ' · 更新时间 ' + detail.official_date : '')) + '</td>';
    }).join('') + '</tr>' +
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
    { label: '官方日期', format: item => item.official_date || '待补充' }
  ];
  return '<table class="compare-table"><thead><tr><th>维度</th>' + targets.map(target => '<th>' + escapeHtml(compareTargetLabel(target)) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(row => '<tr><td class="dim">' + row.label + '</td>' + targets.map(target => '<td>' + escapeHtml(row.format(target.item)) + '</td>').join('') + '</tr>').join('') +
  '</tbody></table>';
}

function renderPlanCompare(targets) {
  const rows = [
    { label: '价格', format: item => (item.plan?.amount == null ? '暂无可比数据' : formatPrice(item.plan.amount, item.plan.currency)) },
    { label: '周期', format: item => ({ month: '月', year: '年', usage: '按量', custom: '定制', unknown: '未知' }[item.plan?.billing_period] || '未知') },
    { label: '主要模型', format: item => item.plan?.included_models_status === 'not_listed' ? '官方未列出' : item.plan?.included_models?.length ? item.plan.included_models.join('、') : '官方未明确列出全部模型' },
    { label: '条件/限制', format: item => item.plan?.conditions || '暂无可比数据' }
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
        ' <button class="remove-chip" aria-label="移除 ' + escapeHtml(target.name) + '" onclick="removeCompare(\'' + escapeHtml(target.item.id) + '\',\'' + escapeHtml(target.item.id) + '\')">' + ICON_CLOSE + '</button></span>').join('') + '</div>';

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
  return tools.filter(isComparableRootTool).map(tool => ({
    toolId: tool.detail_ref.id,
    itemId: tool.detail_ref.id,
    kind: tool.detail_kind,
    tool,
    name: tool.title,
    searchText: getToolSearchText(tool),
  }));
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
  const cats = [...new Set(targets.map(t => t.tool.theme).filter(Boolean))];
  const currentCat = panel.dataset.compareCat || 'all';
  catBox.innerHTML = '<button class="filter-chip' + (currentCat === 'all' ? ' active' : '') + '" type="button" data-add-cat="all" aria-pressed="' + (currentCat === 'all') + '">全部</button>' +
    cats.map(c => '<button class="filter-chip' + (currentCat === c ? ' active' : '') + '" type="button" data-add-cat="' + escapeHtml(c) + '" aria-pressed="' + (currentCat === c) + '">' + escapeHtml(c) + '</button>').join('');

  const query = (input.value || '').toLowerCase().trim();
  const cat = panel.dataset.compareCat || 'all';
  const filtered = targets.filter(t =>
    (cat === 'all' || t.tool.theme === cat) &&
    (!query || t.searchText.includes(query))
  );
  if (countEl) countEl.textContent = compareList.length;

  if (!filtered.length) {
    list.innerHTML = renderState({ icon: '⌕', title: '没有匹配的可比较项目', message: '请更换搜索或分类；工具与 API 模型可从这里加入，订阅套餐可从厂商详情中按同类批量加入。', type: 'no-match' });
    return;
  }

  list.innerHTML = filtered.map(t => {
    const selected = isCompareSelected(t.toolId, t.itemId);
    const kindLabel = t.kind === 'tool' ? '具体工具' : t.kind === 'api_model' ? 'API 模型' : '产品变体';
    return '<div class="add-compare-item">' +
      '<div><div class="add-compare-name">' + escapeHtml(t.tool.icon + ' ' + t.name) + '</div>' +
      '<div class="add-compare-meta">' + escapeHtml(kindLabel + ' · ' + t.tool.vendor_label) + '</div></div>' +
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
  compareList = ids.map(toolKey => {
    const card = tools.find(item => item.tool_key === toolKey);
    return card ? { toolId: card.detail_ref.id, itemId: card.detail_ref.id } : null;
  }).filter(Boolean).slice(0, 5);
  updateCompareCount();
  renderTools();
  renderCompare();
}

export {
  compareList,
  compareKey,
  isComparableRootTool,
  isComparableLeaf,
  isCompareSelected,
  setCompareStatus,
  resolveCompareTarget,
  toggleCompareRef,
  compareGroupLeaves,
  updateCompareCount,
  renderCompare,
  getAddCompareTargets,
  openAddComparePanel,
  renderAddCompare,
  removeCompare,
  quickCompare,
};
