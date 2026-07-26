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
 * 六个视图：
 * ═══════════════════════════════════════════════════════════════
 *   工具库 (tools)     — 搜索 + 分类/访问/价格筛选 + 卡片网格 + 详情弹窗
 *   场景导航 (scenes)  — 12 个场景入口, 点击跳转到工具库筛选结果
 *   对比模式 (compare)  — 2-5 个工具并排比较 10+ 维度
 *   AI热点 (trending)  — 三平台内容 feed, 平台筛选, 按评分/时间排序
 *   AI概念 (glossary)  — 43 条术语, 分类筛选 + 搜索 + 可展开详情
 *   关于 (about)       — 评测方法论和项目介绍 (纯 HTML, 无专属渲染函数)
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
let compareList = [];         // 用户选中用于对比的工具 ID 列表 (最多 5 个)
let currentView = 'tools';    // 当前激活的视图
let activeFilters = {         // 工具库的筛选状态
  category: 'all',            //   分类 (大语言模型/编程开发/图像生成/...)
  access: 'all',              //   访问方式 (开放/受限)
  price: 'all'                //   价格 (免费/付费/均有)
};
let activeGlossaryCategory = 'all'; // 概念词典的分类筛选
let activeTrendingPlatform = 'all'; // 热点平台筛选 (youtube/x/bilibili/bilibili_dynamic)
let trendingSort = 'score';         // 热点排序方式 (score=评分/recent=最新)

// ═══════════════════════════════════════════════════════════════
// 第 1 部分：通用工具函数
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// 第 2 部分：数据加载
// ═══════════════════════════════════════════════════════════════

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
    document.getElementById('toolGrid').innerHTML =
      '<div class="empty-state"><div class="empty-icon">⚠️</div><h3>数据加载失败</h3><p>请检查 data/catalog/tools.json 是否存在</p></div>';
  }
  try {
    const gResp = await fetch('data/catalog/glossary.json');
    glossary = await gResp.json();
  } catch (e) {
    glossary = [];
  }
  try {
    const sResp = await fetch('data/catalog/scenes.json');
    const sceneData = await sResp.json();
    scenes = Array.isArray(sceneData.scenes) ? sceneData.scenes : [];
  } catch (e) {
    scenes = [];
  }
  try {
    const nResp = await fetch('data/news/output/hotspots.json');
    hotspots = await nResp.json();
  } catch (e) {
    hotspots = { items: [], events: [], provenance: [], assessments: [], coverage: null, generated_at: null };
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
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const target = document.getElementById('view-' + view);
  if (target) target.classList.add('active');
  const btn = document.querySelector('[data-view="' + view + '"]');
  if (btn) btn.classList.add('active');

  if (view === 'scenes') renderScenes();
  if (view === 'compare') renderCompare();
  if (view === 'tools') renderTools();
  if (view === 'glossary') renderGlossary();
  if (view === 'trending') renderTrending();
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
function getFilteredTools() {
  const query = (document.getElementById('searchInput').value || '').toLowerCase().trim();
  let filtered = tools;

  // 文本搜索 — 将查询拆分为关键词，OR 匹配
  if (query) {
    const keywords = query.split(/\s+/).filter(k => k.length > 0);
    const hasAliasMatch = keywords.some(kw => kw in searchAliases);

    filtered = filtered.filter(t => {
      // 对每个关键词，检查是否命中任何字段(搜索关键词)
      return keywords.some(kw => {
        const q = kw.toLowerCase();
        return (
          t.name.toLowerCase().includes(q) ||
          t.vendor.toLowerCase().includes(q) ||
          t.category.some(c => c.includes(q)) ||
          t.scenes.some(s => s.includes(q)) ||
          t.strengths.toLowerCase().includes(q) ||
          t.weaknesses.toLowerCase().includes(q) ||
          (t.free_tier && t.free_tier.toLowerCase().includes(q)) ||
          (t.access_barrier && t.access_barrier.toLowerCase().includes(q))
        );
      });
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
function renderTools() {
  const filtered = getFilteredTools();
  const grid = document.getElementById('toolGrid');
  document.getElementById('toolCount').textContent = filtered.length;
  document.getElementById('filteredInfo').style.display =
    (activeFilters.category !== 'all' || activeFilters.access !== 'all' || activeFilters.price !== 'all' || document.getElementById('searchInput').value)
    ? 'inline' : 'none';

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><h3>没有匹配的工具</h3><p>试试调整筛选条件或搜索关键词</p></div>';
    return;
  }

  grid.innerHTML = filtered.map(t => {
    const isSelected = compareList.some(c => c.id === t.id);
    return `
    <div class="tool-card" onclick="openDetail('${t.id}')">
      <div class="tool-card-header">
        <div>
          <div class="tool-card-name">${t.icon} ${t.name}</div>
          <div class="tool-card-vendor">${t.vendor}</div>
        </div>
        
        <div style="text-align:right">
          <div class="rating-stars">${stars(t.rating_overall)}</div>
          <div class="rating-num">${t.rating_overall.toFixed(1)}</div>
        </div>
      </div>

      <div class="tool-card-desc">${t.strengths}</div>
      <div class="tool-card-tags">
        ${t.scenes.slice(0,3).map(s => '<span class="tag scene">' + s + '</span>').join('')}
        ${hasFree(t) ? '<span class="tag free">免费可用</span>' : '<span class="tag paid">仅付费</span>'}
        <span class="tag ${t.access_level === '开放' ? 'open' : 'restricted'}">${t.access_level === '开放' ? '国内可用' : '需科学上网'}</span>
      </div>

      <div class="tool-card-footer" onclick="event.stopPropagation()">
        <span style="font-size:12px;color:var(--text-hint)">更新: ${t.last_updated}</span>
        <button class="compare-toggle ${isSelected ? 'selected' : ''}" onclick="toggleCompare('${t.id}', this)">${isSelected ? '已选' : '+对比'}</button>
      </div>
    </div>`;
  }).join('');
}

/**
 * 打开工具详情弹窗。
 * 渲染完整的工具信息：评分、价格层级、优势/不足、最适/不适合场景、
 * 信息来源和更新日期。支持点击遮罩层关闭。
 */
function openDetail(id) {
  const t = tools.find(x => x.id === id);
  if (!t) return;

  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
  content.innerHTML = `
    <button class="modal-close" onclick="closeModal()">✕</button>
    <h2>${t.icon} ${t.name}</h2>
    <div class="vendor">${t.vendor} · <a href="${t.url}" target="_blank" rel="noopener">官网 ↗</a></div>

    <div class="scores">
      <div class="score-item"><div class="score-val ${scoreClass(t.rating_overall)}">${t.rating_overall.toFixed(1)}</div><div class="score-label">综合</div></div>
      <div class="score-item"><div class="score-val ${scoreClass(t.rating_chinese)}">${t.rating_chinese.toFixed(1)}</div><div class="score-label">中文支持</div></div>
      <div class="score-item"><div class="score-val ${scoreClass(t.rating_ease)}">${t.rating_ease.toFixed(1)}</div><div class="score-label">易用性</div></div>
      <div class="score-item"><div class="score-val ${scoreClass(t.rating_price)}">${t.rating_price.toFixed(1)}</div><div class="score-label">性价比</div></div>
    </div>

    <div class="section">
      <h4>适用场景</h4>
      <div class="tool-card-tags">${t.scenes.map(s => '<span class="tag scene">' + s + '</span>').join(' ')}</div>
    </div>

    <div class="section">
      <h4>价格</h4>
      <p><b>免费层：</b>${t.free_tier || '无'}</p>
      ${t.paid_tiers.map((p,i) => '<p style="margin-top:4px"><b>' + p.name + '：</b>' + p.price + ' — ' + p.features + '</p>').join('')}
    </div>

    <div class="section">
      <h4>优势</h4>
      <p>${t.strengths}</p>
    </div>

    <div class="section">
      <h4>不足</h4>
      <p>${t.weaknesses}</p>
    </div>

    <div class="section">
      <h4>最适合</h4>
      <ul>${t.best_for.map(b => '<li>' + b + '</li>').join('')}</ul>
    </div>

    <div class="section">
      <h4>不适合</h4>
      <ul>${t.not_for.map(n => '<li>' + n + '</li>').join('')}</ul>
    </div>

    <div class="section">
      <h4>访问门槛</h4>
      <p>${t.access_barrier}</p>
      ${t.chinese_note ? '<p style="margin-top:4px"><b>中文支持：</b>' + t.chinese_note + '</p>' : ''}
    </div>

    <div class="meta">最后更新: ${t.last_updated} · 信息来源: ${t.source} · 利益声明: 不接收厂商赞助</div>
    <div class="meta" style="margin-top:8px">
      <a href="https://github.com/wozore/infocatcher/issues/new?template=data-correction.yml&title=%5B%E6%95%B0%E6%8D%AE%E7%BA%A0%E9%94%99%5D+${encodeURIComponent(t.name)}" target="_blank" rel="noopener" style="color:var(--text-hint);font-size:12px">📢 信息有误？点此反馈</a>
    </div>
  `;
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modalOverlay').style.display = 'none';
  document.body.style.overflow = '';
}

document.getElementById('modalOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeModal();
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
function toggleCompare(id, btn) {
  const idx = compareList.findIndex(c => c.id === id);
  // 如果工具已在清单
  if (idx >= 0) {
    compareList.splice(idx, 1);
    if (btn) { btn.classList.remove('selected'); btn.textContent = '+对比'; }
  } else {
    // 如果工具数量达到上限
    if (compareList.length >= 5) {
      alert('最多对比 5 个工具');
      return;
    }
    const t = tools.find(x => x.id === id);
    if (t) compareList.push(t);
    if (btn) { btn.classList.add('selected'); btn.textContent = '已选'; }
  }
  updateCompareCount();
  renderTools();
  // 如果当前页面为compare页面，那么重渲染
  if (currentView === 'compare') renderCompare();
}

// 更新对比工具模型的数量
function updateCompareCount() {
  document.getElementById('compareCount').textContent = compareList.length;
}

function renderCompare() {
  const wrap = document.getElementById('compareTable');
  const sel = document.getElementById('compareSelection');

  sel.innerHTML = compareList.length === 0
    ? '<p class="hint">在<b>工具库</b>中点击 <b>+对比</b> 按钮添加，或点击下方快捷选择：</p>'
    : '<div class="selected-tools">' + compareList.map(t =>
        '<span class="selected-tool-chip">' + t.icon + ' ' + t.name +
        ' <button class="remove-chip" onclick="removeCompare(\'' + t.id + '\')">✕</button></span>'
      ).join('') + '</div>';

  // 快捷推荐
  if (compareList.length === 0) {
    const quickPicks = [
      { ids: ['chatgpt', 'claude', 'gemini', 'deepseek'], label: '对话AI四强对比' },
      { ids: ['cursor', 'copilot', 'claude-code', 'trae'], label: 'AI编程工具对比' },
      { ids: ['deepseek', 'tongyi', 'doubao', 'kimi'], label: '国产AI对比' },
    ];
    sel.innerHTML += '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
      quickPicks.map(q => '<button class="compare-toggle" onclick=\'quickCompare(' + JSON.stringify(q.ids) + ')\'>' + q.label + '</button>').join('') +
      '</div>';
  }

  if (compareList.length < 2) {
    wrap.innerHTML = compareList.length === 0
      ? '<p style="text-align:center;padding:40px;color:var(--text-hint)">选择 2-5 个工具开始对比</p>'
      : '<p style="text-align:center;padding:40px;color:var(--text-hint)">再选至少 1 个工具</p>';
    return;
  }

  // 对比维度定义 —— 每个维度含 key（工具对象字段名或特殊值）、label、format
  // has_free 为特殊 key：通过 hasFree() 函数判定而非直接取字段值
  // EXTENSION POINT: 新增对比维度时在 dims[] 中追加 {key, label, format} 条目
  const dims = [
    { key: 'rating_overall', label: '综合评分', format: v => v.toFixed(1) },
    { key: 'rating_chinese', label: '中文支持', format: v => v.toFixed(1) },
    { key: 'rating_ease', label: '易用性', format: v => v.toFixed(1) },
    { key: 'rating_price', label: '性价比', format: v => v.toFixed(1) },
    { key: 'access_level', label: '国内访问', format: v => v === '开放' ? '✅ 可访问' : '⚠️ 需科学上网' },
    { key: 'has_free', label: '免费层', format: v => v ? '✅ 有' : '❌ 无' },
  ];

  wrap.innerHTML = '<table class="compare-table"><thead><tr><th>维度</th>' +
    compareList.map(t => '<th>' + t.icon + ' ' + t.name + '</th>').join('') +
    '</tr></thead><tbody>' +
    dims.map(d => '<tr><td class="dim">' + d.label + '</td>' +
      compareList.map(t => {
        let val;
        if (d.key === 'has_free') val = hasFree(t);
        else val = t[d.key];
        const cls = typeof val === 'number' ? scoreClass(val) : '';
        return '<td class="' + cls + '">' + d.format(val) + '</td>';
      }).join('') +
    '</tr>').join('') +
    '<tr><td class="dim">适用场景</td>' +
      compareList.map(t => '<td>' + t.scenes.slice(0,5).join('、') + '</td>').join('') +
    '</tr>' +
    '<tr><td class="dim">免费层说明</td>' +
      compareList.map(t => '<td style="font-size:12px">' + (t.free_tier || '无') + '</td>').join('') +
    '</tr>' +
    '<tr><td class="dim">最适合</td>' +
      compareList.map(t => '<td style="font-size:12px">' + t.best_for.join('；') + '</td>').join('') +
    '</tr>' +
    '<tr><td class="dim">不适合/限制</td>' +
      compareList.map(t => '<td style="font-size:12px">' + (t.not_for || []).join('；') + '</td>').join('') +
    '</tr>' +
    '</tbody></table>';
}

function removeCompare(id) {
  compareList = compareList.filter(c => c.id !== id);
  updateCompareCount();
  renderTools();
  renderCompare();
}

// 快捷组合比较
function quickCompare(ids) {
  compareList = ids.map(id => tools.find(t => t.id === id)).filter(Boolean).slice(0, 5);
  updateCompareCount();
  renderTools();
  renderCompare();
}

// ═══════════════════════════════════════════════════════════════
// 第 6 部分：概念词典 —— 术语搜索、分类筛选和可展开卡片
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

function renderGlossary() {
  const categories = [...new Set(glossary.map(g => g.category))];
  const catEl = document.getElementById('glossaryCategories');
  catEl.innerHTML =
    '<button class="filter-chip' + (activeGlossaryCategory === 'all' ? ' active' : '') + '" data-cat="all">全部</button>' +
    categories.map(c =>
      '<button class="filter-chip' + (activeGlossaryCategory === c ? ' active' : '') + '" data-cat="' + c + '">' + c + '</button>'
    ).join('');

  catEl.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', function() {
      activeGlossaryCategory = this.dataset.cat;
      renderGlossary();
    });
  });

  const filtered = getFilteredGlossary();
  const list = document.getElementById('glossaryList');

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📖</div><h3>没有匹配的概念</h3><p>试试调整筛选条件或搜索关键词</p></div>';
    return;
  }

  list.innerHTML = filtered.map(g => `
    <div class="glossary-card" onclick="this.classList.toggle('expanded')">
      <div class="glossary-card-head">
        <span class="glossary-term">${g.term}</span>
        ${g.full_name ? '<span class="glossary-fullname">' + g.full_name + '</span>' : ''}
        <span class="glossary-cat">${g.category}</span>
      </div>
      <div class="glossary-card-body">
        <p class="glossary-summary">${g.summary}</p>
        ${g.related_terms && g.related_terms.length ? '<div class="glossary-related"><b>关联术语：</b>' + g.related_terms.join('、') + '</div>' : ''}
        ${g.relevance ? '<div class="glossary-relevance"><b>实用意义：</b>' + g.relevance + '</div>' : ''}
        <div class="glossary-source">
          来源：${g.source.url ? '<a href="' + g.source.url + '" target="_blank" rel="noopener">' + g.source.name + '</a>' : g.source.name}
        </div>
      </div>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════════════════════════
// 第 7 部分：AI 热点视图 —— 安全输出 + 筛选 + 排序 + 状态 + 评分
//
// 安全设计：
//   所有来自外部平台（YouTube/X/Bilibili）的文本字段（标题、描述、
//   作者名、来源名）在渲染前都通过 escapeHtml() 转义，防止 XSS。
//   所有外部链接通过 safeExternalUrl() 校验协议，只允许 http/https。
//   这两个函数是安全边界——如果去掉，恶意内容可注入 <script> 或
//   javascript: 链接。
//
// 数据查找：
//   getAssessment() — 从评分数组中查找内容对应的评分详情
//   getProvenance() — 查找溯源关系（转载/重复/评论）
//   getEvent()      — 查找内容归属的主题/事件
//
// 筛选与排序：
//   getFilteredTrending() — 按平台筛选，按评分(recent)或时间(score)排序
//   renderTrendingStatus() — 渲染采集覆盖状态（降级/轮转/未运行）
//   renderTrending() — 渲染热点 feed 卡片（评分/商业证据/溯源/关联事件）
// ═══════════════════════════════════════════════════════════════

/** 平台元数据：标签名、图标、CSS class */
const platformMeta = {
  youtube: { label: 'YouTube', icon: '▶️', cls: 'platform-youtube' },
  x: { label: 'X', icon: '𝕏', cls: 'platform-x' },
  bilibili: { label: 'B站', icon: '📺', cls: 'platform-bilibili' },
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

function getAssessment(contentId) {
  return (hotspots.assessments || []).find(item => item.content_id === contentId);
}

function getProvenance(contentId) {
  return (hotspots.provenance || []).find(item => item.content_id === contentId);
}

function getEvent(contentId) {
  return (hotspots.events || []).find(event => (event.content_ids || []).includes(contentId));
}

function getFilteredTrending() {
  let items = [...(hotspots.items || [])];
  if (activeTrendingPlatform === 'bilibili_dynamic') {
    items = items.filter(item => item.platform === 'bilibili' && item.content_type.startsWith('bilibili_dynamic'));
  } else if (activeTrendingPlatform !== 'all') {
    items = items.filter(item => item.platform === activeTrendingPlatform);
  }
  return items.sort((a, b) => {
    if (trendingSort === 'recent') return new Date(b.published_at) - new Date(a.published_at);
    return (getAssessment(b.id)?.final_score || 0) - (getAssessment(a.id)?.final_score || 0) || new Date(b.published_at) - new Date(a.published_at);
  });
}

function renderTrendingStatus() {
  const status = document.getElementById('trendingStatus');
  const coverage = hotspots.coverage;
  if (!coverage || coverage.status === 'not_run') {
    status.innerHTML = '<div class="status-note status-neutral">数据流水线尚未运行。当前页面只展示已生成的静态内容。</div>';
    return;
  }
  const notes = [];
  const bilibili = coverage.platforms?.bilibili;
  if (bilibili?.status === 'manual_curated') {
    notes.push('<div class="status-note status-neutral">B站当前采用人工精选收录，自动订阅已暂停；已有内容仍保留原始链接，未收录不代表来源近期没有更新。</div>');
  } else if (bilibili?.reason === 'rsshub_provider_blocked') {
    notes.push('<div class="status-note status-warn">B站自动订阅入口被服务提供方拦截，本轮已快速停止后续请求；页面继续展示上一版及人工精选内容。</div>');
  }
  const degraded = [];
  for (const [platform, info] of Object.entries(coverage.platforms || {})) {
    if (info.status === 'degraded' || info.status === 'partial') degraded.push(platform);
  }
  if (coverage.platforms?.bilibili?.dynamic?.status === 'degraded') degraded.push('B站动态');
  if (degraded.length) {
    notes.push('<div class="status-note status-warn">部分数据降级：' + escapeHtml([...new Set(degraded)].join('、')) + '。缺失会降低判断置信度，不代表来源质量下降。</div>');
  }
  status.innerHTML = notes.length
    ? notes.join('')
    : '<div class="status-note status-ok">本轮自动来源采集已完成。</div>';
}

function renderTrending() {
  renderTrendingStatus();
  const items = getFilteredTrending();
  const grid = document.getElementById('trendingGrid');
  document.getElementById('trendingCount').textContent = items.length;
  document.getElementById('trendingGenerated').textContent = hotspots.generated_at
    ? '生成于 ' + timeAgo(hotspots.generated_at)
    : '尚未采集';

  if (!items.length) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">🔥</div><h3>暂无热点数据</h3><p>等待每日构建任务生成内容；采集失败不会用空结果覆盖上一版数据。</p></div>';
    return;
  }

  grid.innerHTML = items.map(item => {
    const meta = platformMeta[item.platform] || { label: item.platform, icon: '📰', cls: '' };
    const assessment = getAssessment(item.id);
    const provenance = getProvenance(item.id);
    const event = getEvent(item.id);
    const metrics = [];
    if (item.metrics) {
      [['views', '👁'], ['likes', '👍'], ['comments', '💬'], ['reposts', '🔄'], ['replies', '↩']].forEach(([key, icon]) => {
        const value = formatMetric(item.metrics[key]);
        if (value) metrics.push(icon + ' ' + value);
      });
    }
    const commercial = assessment?.commercial_assessment;
    const evidenceBadges = [];
    if (provenance?.origin_status === 'confirmed') evidenceBadges.push('来源已确认');
    else if (provenance?.origin_status === 'candidate') evidenceBadges.push('候选溯源');
    if (event?.content_ids?.length > 1) evidenceBadges.push(event.content_ids.length + ' 个相关观点');
    if (commercial && commercial.label !== 'none_confirmed') evidenceBadges.push('已披露商业关系');
    if (item.content_type.startsWith('bilibili_dynamic')) evidenceBadges.push('B站动态');

    const scoreDetails = assessment ? Object.entries(assessment.score_breakdown).map(([key, value]) =>
      '<span>' + escapeHtml({ long_term_quality: '长期', recent_timeliness: '时效', light_user_experience: '真实体验', source_reliability: '来源', interaction_quality: '互动' }[key] || key) + ' ' + Math.round(value) + '</span>'
    ).join('') : '';

    return '<article class="trending-card ' + meta.cls + '">' +
      '<div class="trending-card-head"><span>' + meta.icon + ' ' + meta.label + '</span><span>' + timeAgo(item.published_at) + '</span></div>' +
      '<h3><a href="' + escapeHtml(safeExternalUrl(item.url)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(item.title) + '</a></h3>' +
      (item.description ? '<p class="trending-description">' + escapeHtml(item.description) + '</p>' : '') +
      '<div class="trending-tags">' + (item.source_tags || []).map(tag => '<span class="tag scene">' + escapeHtml(tag) + '</span>').join('') + evidenceBadges.map(tag => '<span class="tag evidence">' + escapeHtml(tag) + '</span>').join('') + '</div>' +
      '<div class="trending-meta"><span>👤 ' + escapeHtml(item.author_name) + '</span>' + (metrics.length ? '<span>' + metrics.join(' · ') + '</span>' : '<span>互动数据不可用</span>') + '</div>' +
      (assessment ? '<details class="score-explain"><summary>价值分 ' + assessment.final_score.toFixed(1) + ' · 置信度 ' + Math.round(assessment.confidence * 100) + '%</summary><div class="score-breakdown">' + scoreDetails + '</div><p>异常：' + escapeHtml(assessment.anomaly_assessment.status) + '；商业标识：' + escapeHtml(commercial.label) + '（仅有证据时扣分）</p></details>' : '') +
      '</article>';
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
// 第 8 部分：场景导航 —— 可搜索场景列表 + 子任务/工具映射
//
// 场景数据来自 scenes.json；搜索匹配名称、简介、关联词和子任务名。
// 每行展示场景图标、名称、去重后的工具数量和简介；点击后展开任务—工具映射。
// ═══════════════════════════════════════════════════════════════

const scenePalette = {
  writing: { accent: '#d97706', light: '#fffbeb' },
  coding: { accent: '#047857', light: '#ecfdf5' },
  design: { accent: '#be185d', light: '#fdf2f8' },
  video: { accent: '#b91c1c', light: '#fef2f2' },
  audio: { accent: '#6d28d9', light: '#faf5ff' },
  research: { accent: '#4338ca', light: '#eef2ff' },
  office: { accent: '#0e7490', light: '#ecfeff' },
  learning: { accent: '#1d4ed8', light: '#eff6ff' },
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

function renderScenes() {
  const filtered = getFilteredScenes();
  const list = document.getElementById('sceneList');
  if (!list) return;

  if (!scenes.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><h3>场景数据加载失败</h3><p>请稍后刷新页面，或检查 data/catalog/scenes.json 是否存在。</p></div>';
    return;
  }

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🧭</div><h3>没有匹配的场景</h3><p>试试“论文”“代码”“配图”“视频”或其他需求关键词。</p></div>';
    return;
  }

  list.innerHTML = filtered.map(scene => {
    const palette = scenePalette[scene.category] || scenePalette.learning;
    const toolIds = getSceneToolIds(scene);
    const taskRows = (scene.tasks || []).map(task => {
      const matchedTools = (task.tools || []).map(toolId => tools.find(tool => tool.id === toolId)).filter(Boolean);
      return '<div class="scene-task-item">' +
        '<span class="scene-task-name">' + escapeHtml(task.task) + '</span>' +
        '<span class="scene-task-tools">' + matchedTools.map(tool => escapeHtml(tool.icon + ' ' + tool.name)).join('、') + '</span>' +
      '</div>';
    }).join('');

    return '<div class="scene-group" style="--scene-accent:' + palette.accent + ';--scene-accent-light:' + palette.light + '">' +
      '<button class="scene-row" type="button" data-scene-id="' + escapeHtml(scene.id) + '" aria-expanded="false" onclick="toggleSceneTasks(\'' + escapeHtml(scene.id) + '\')">' +
        '<span class="scene-row-left">' +
          '<span class="scene-row-icon" aria-hidden="true">' + escapeHtml(scene.icon) + '</span>' +
          '<span class="scene-row-info">' +
            '<span class="scene-row-name">' + escapeHtml(scene.name) + '</span>' +
            '<span class="scene-row-count">' + toolIds.length + ' 个匹配工具</span>' +
          '</span>' +
        '</span>' +
        '<span class="scene-row-desc">' + escapeHtml(scene.description) + '</span>' +
        '<span class="scene-row-arrow" aria-hidden="true">⌄</span>' +
      '</button>' +
      '<div class="scene-tasks" id="scene-tasks-' + escapeHtml(scene.id) + '" hidden>' + taskRows + '</div>' +
    '</div>';
  }).join('');
}

function toggleSceneTasks(sceneId) {
  const selectedRow = document.querySelector('.scene-row[data-scene-id="' + sceneId + '"]');
  const selectedTasks = document.getElementById('scene-tasks-' + sceneId);
  if (!selectedRow || !selectedTasks) return;
  const shouldOpen = selectedTasks.hidden;

  document.querySelectorAll('.scene-row.expanded').forEach(row => {
    row.classList.remove('expanded');
    row.setAttribute('aria-expanded', 'false');
  });
  document.querySelectorAll('.scene-tasks').forEach(tasks => { tasks.hidden = true; });

  if (shouldOpen) {
    selectedRow.classList.add('expanded');
    selectedRow.setAttribute('aria-expanded', 'true');
    selectedTasks.hidden = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// 第 9 部分：搜索别名映射
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
// 第 10 部分：页面初始化与事件绑定
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
  await loadData();
  renderTools();
  renderScenes();
  updateCompareCount();
  renderTrending();

  // 搜索
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
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

  // 导航按钮
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  document.getElementById('homeBtn').addEventListener('click', (e) => {
    e.preventDefault();
    switchView('tools');
  });

  // 分类筛选
  document.querySelectorAll('.filter-chip[data-category]').forEach(chip => {
    chip.addEventListener('click', function() {
      document.querySelectorAll('.filter-chip[data-category]').forEach(c => c.classList.remove('active'));
      this.classList.add('active');
      activeFilters.category = this.dataset.category;
      if (currentView !== 'tools') switchView('tools');
      else renderTools();
    });
  });

  // 访问筛选
  document.querySelectorAll('.filter-chip[data-access]').forEach(chip => {
    chip.addEventListener('click', function() {
      document.querySelectorAll('.filter-chip[data-access]').forEach(c => c.classList.remove('active'));
      this.classList.add('active');
      activeFilters.access = this.dataset.access;
      if (currentView !== 'tools') switchView('tools');
      else renderTools();
    });
  });

  // 价格筛选
  document.querySelectorAll('.filter-chip[data-price]').forEach(chip => {
    chip.addEventListener('click', function() {
      document.querySelectorAll('.filter-chip[data-price]').forEach(c => c.classList.remove('active'));
      this.classList.add('active');
      activeFilters.price = this.dataset.price;
      if (currentView !== 'tools') switchView('tools');
      else renderTools();
    });
  });

  // 热点平台筛选与排序
  document.querySelectorAll('#trendingTabs [data-platform]').forEach(chip => {
    chip.addEventListener('click', function() {
      document.querySelectorAll('#trendingTabs [data-platform]').forEach(item => item.classList.remove('active'));
      this.classList.add('active');
      activeTrendingPlatform = this.dataset.platform;
      renderTrending();
    });
  });
  const trendingSortEl = document.getElementById('trendingSort');
  if (trendingSortEl) {
    trendingSortEl.addEventListener('change', function() {
      trendingSort = this.value;
      renderTrending();
    });
  }

  // 键盘快捷键
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      document.getElementById('searchInput').focus();
    }
  });

  // 概念词典搜索
  const glossarySearch = document.getElementById('glossarySearch');
  const glossarySearchClear = document.getElementById('glossarySearchClear');
  let glossaryTimer;
  if (glossarySearch) {
    glossarySearch.addEventListener('input', () => {
      clearTimeout(glossaryTimer);
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
});
