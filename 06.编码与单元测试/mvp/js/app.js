/* ===== InfoCatcher MVP — 应用逻辑 =====
 *
 * 架构概要：
 *   数据加载(loadData) → 全局状态(tools/glossary/compareList)
 *   → 搜索过滤(getFilteredTools) → 视图渲染(render*)
 *   → 用户交互 → 事件绑定(DOMContentLoaded)
 *
 * 扩展模式：
 *   新增视图：1) index.html 加 nav+section  2) 本文件加 renderXxx()
 *             3) switchView() 加分支  4) DOMContentLoaded 加事件绑定
 *   新增筛选维度：1) index.html 加 filter-chip  2) getFilteredTools() 加过滤分支
 *   新增数据源：1) data/ 加 JSON  2) loadData() 加 fetch
 *
 * 约束：
 *   - 所有搜索/筛选为前端内存过滤，不发起网络请求
 *   - 对比按钮状态变更后须同步 updateCompareCount() + renderTools()
 *   - 数据文件中日期统一使用 ISO 格式 (YYYY-MM-DD)
 */

// ===== 全局状态 =====
let tools = [];
let glossary = [];
let compareList = [];
let currentView = 'tools';
let activeFilters = { category: 'all', access: 'all', price: 'all' };
let activeGlossaryCategory = 'all';

// ===== 工具函数 =====
function stars(rating) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5 ? 1 : 0;
  return '★'.repeat(full) + (half ? '☆' : '') + '☆'.repeat(5 - full - half);
}

function scoreClass(val) {
  if (val >= 4) return 'score-high';
  if (val >= 3) return 'score-mid';
  return 'score-low';
}

function hasFree(t) {
  return t.free_tier && !t.free_tier.includes('无免费') && !t.free_tier.startsWith('无(');
}

// 负责：异步加载 tools.json 和 glossary.json，存入全局状态
// 失败时降级为空数组，由各渲染函数处理空状态 UI
// EXTENSION POINT: 新增数据源时在此添加 fetch，并入全局状态
async function loadData() {
  try {
    const resp = await fetch('data/tools.json');
    tools = await resp.json();
    document.getElementById('dataDate').textContent =
      '数据更新: ' + new Date().toISOString().slice(0, 10);
  } catch (e) {
    tools = [];
    document.getElementById('toolGrid').innerHTML =
      '<div class="empty-state"><div class="empty-icon">⚠️</div><h3>数据加载失败</h3><p>请检查 data/tools.json 是否存在</p></div>';
  }
  try {
    const gResp = await fetch('data/glossary.json');
    glossary = await gResp.json();
  } catch (e) {
    glossary = [];
  }
}

// 负责：切换顶部导航活跃态 + 视图区显隐，触发对应渲染函数
// 视图匹配方式：view 参数 → id="view-{view}" 容器 + data-view="{view}" 按钮
// EXTENSION POINT: 新增视图时在末尾加 if (view === 'xxx') renderXxx();
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
}

// 负责：文本搜索(关键词 OR 匹配) + 三维筛选(分类/访问/价格)叠加过滤
// 两阶段过滤：先文本搜索缩小范围，再叠加 chip 筛选（AND 关系）
// EXTENSION POINT: 新增筛选维度时在末尾按同样模式添加过滤分支
function getFilteredTools() {
  const query = (document.getElementById('searchInput').value || '').toLowerCase().trim();
  let filtered = tools;

  // 文本搜索 — 将查询拆分为关键词，OR 匹配
  if (query) {
    const keywords = query.split(/\s+/).filter(k => k.length > 0);
    const hasAliasMatch = keywords.some(kw => kw in searchAliases);

    filtered = filtered.filter(t => {
      // 对每个关键词，检查是否命中任何字段
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

    // 中文别名过滤 — 在关键词匹配结果上叠加
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

// ===== 渲染工具卡片 =====
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

// ===== 详情弹窗 =====
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
      <a href="https://github.com/YOUR_USERNAME/infocatcher/issues/new?template=data-correction.yml&title=%5B%E6%95%B0%E6%8D%AE%E7%BA%A0%E9%94%99%5D+${encodeURIComponent(t.name)}" target="_blank" rel="noopener" style="color:var(--text-hint);font-size:12px">📢 信息有误？点此反馈</a>
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

// ===== 对比模式 =====
function toggleCompare(id, btn) {
  const idx = compareList.findIndex(c => c.id === id);
  if (idx >= 0) {
    compareList.splice(idx, 1);
    if (btn) { btn.classList.remove('selected'); btn.textContent = '+对比'; }
  } else {
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
  if (currentView === 'compare') renderCompare();
}

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

function quickCompare(ids) {
  compareList = ids.map(id => tools.find(t => t.id === id)).filter(Boolean).slice(0, 5);
  updateCompareCount();
  renderTools();
  renderCompare();
}

// 负责：从 glossary[] 中按分类 + 关键词过滤，渲染可展开的术语卡片
// 分类 chip 由数据中的 category 字段动态生成（不去重），点击切换筛选
// EXTENSION POINT: 新增术语分类在 glossary.json 中直接添加即可，无需改代码
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

// 预定义的 12 个场景卡片，每个含 id/图标/名称/描述/搜索关键词
// 匹配计数：统计 tools 中 scenes 字段与场景 q 数组有交集的工具数
// EXTENSION POINT: 新增场景时在 scenes[] 中追加 {id, icon, name, desc, q} 条目
function renderScenes() {
  const scenes = [
    { id: 'write-paper', icon: '📝', name: '写论文', desc: '学术写作、文献综述、论文润色', q: ['写论文'] },
    { id: 'write-report', icon: '📋', name: '写周报/报告', desc: '工作周报、项目报告、方案撰写', q: ['写周报', '办公文档处理'] },
    { id: 'write-code', icon: '💻', name: '写代码', desc: '编程辅助、代码审查、架构设计', q: ['写代码', '项目开发'] },
    { id: 'translate', icon: '🌍', name: '翻译文档', desc: '中英互译、多语言翻译、论文翻译', q: ['翻译文档'] },
    { id: 'research', icon: '🔬', name: '深度研究', desc: '文献调研、数据分析、长文档分析', q: ['深度研究', '长文档分析', '搜索研究'] },
    { id: 'design', icon: '🎨', name: '设计配图', desc: '海报设计、插画、概念艺术、营销素材', q: ['设计配图', '海报设计'] },
    { id: 'video', icon: '🎬', name: '视频制作', desc: '短视频生成、特效合成、后期处理', q: ['视频制作', '短视频创作'] },
    { id: 'brainstorm', icon: '💡', name: '头脑风暴', desc: '创意发散、问题讨论、思路整理', q: ['头脑风暴'] },
    { id: 'ppt', icon: '📊', name: 'PPT制作', desc: '演示文稿、方案汇报、课题展示', q: ['PPT制作', '演示文稿'] },
    { id: 'study', icon: '📚', name: '学习辅导', desc: '知识答疑、习题讲解、技能学习', q: ['学习辅导'] },
    { id: 'music', icon: '🎵', name: '音乐创作', desc: 'AI编曲、歌曲制作、背景配乐', q: ['音乐创作', '背景音乐'] },
    { id: 'voice', icon: '🎙️', name: '配音/语音', desc: 'AI配音、有声书、播客旁白', q: ['配音', '有声书'] },
  ];

  document.getElementById('sceneGrid').innerHTML = scenes.map(s => {
    const matched = tools.filter(t => t.scenes.some(ts => s.q.includes(ts))).length;
    return `
    <div class="scene-card" onclick="searchByScene('${s.q.join(' ')}')">
      <span class="scene-icon">${s.icon}</span>
      <h3>${s.name}</h3>
      <p>${s.desc}</p>
      <p style="margin-top:8px;font-size:13px;color:var(--text-hint)">${matched} 个匹配工具 →</p>
    </div>`;
  }).join('');
}

function searchByScene(query) {
  document.getElementById('searchInput').value = query;
  activeFilters = { category: 'all', access: 'all', price: 'all' };
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.filter-chip[data-category="all"]').forEach(c => c.classList.add('active'));
  document.querySelectorAll('.filter-chip[data-access="all"]').forEach(c => c.classList.add('active'));
  document.querySelectorAll('.filter-chip[data-price="all"]').forEach(c => c.classList.add('active'));
  switchView('tools');
  renderTools();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 中文搜索别名映射 —— 将自然语言关键词映射为过滤函数
// 在 getFilteredTools() 的文本搜索基础上叠加使用（AND 关系）
// EXTENSION POINT: 新增中文搜索别名时按 '关键词': t => 条件 格式追加
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

// 负责：页面加载完成后初始化所有事件监听器
// 执行顺序：loadData → 首次渲染(工具/场景/对比计数) → 绑定事件
// EXTENSION POINT: 新增视图的事件绑定（搜索/筛选/导航）在此添加
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  renderTools();
  renderScenes();
  updateCompareCount();

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
