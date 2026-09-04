/**
 * data-filters.js — 前端内存过滤与搜索管线
 * 处理各视图的前端内存过滤（AND 叠加），不发起网络请求。
 */

import { state } from './state.js';
import { getVendorCardItems, getToolCardItems, getToolSearchText } from './data-catalog.js';

export const searchAliases = {
  '免费': t => t.price_badge === 'free',
  '收费': t => t.price_badge !== 'free',
  '写论文': t => (t.scenes || []).includes('写论文'),
  '写代码': t => (t.scenes || []).includes('写代码') || t.theme === 'dev',
  '编程': t => t.theme === 'dev' || (t.scenes || []).some(scene => scene.includes('编程')),
  '写周报': t => (t.scenes || []).includes('写周报'),
  '画画': t => t.theme === 'vision',
  '画图': t => t.theme === 'vision',
  '图像': t => t.theme === 'vision',
  '视频': t => t.theme === 'media',
  'ppt': t => (t.scenes || []).some(s => s.includes('PPT') || s.includes('演示')),
  '演示': t => (t.scenes || []).some(s => s.includes('演示')),
  '搜索': t => (t.scenes || []).some(s => s.includes('搜索')),
  '国内': t => t.access_level === '开放',
  '可用': t => t.access_level === '开放',
  '科学上网': t => t.access_level === '受限',
  'vpn': t => t.access_level === '受限',
  '梯子': t => t.access_level === '受限',
  '开源': t => (t.search_terms || []).some(term => term.includes('开源')),
  '音乐': t => t.theme === 'media' && (t.scenes || []).some(scene => scene.includes('音乐') || scene.includes('音频')),
  '语音': t => (t.scenes || []).some(scene => scene.includes('语音')),
  '配音': t => (t.scenes || []).includes('配音'),
  '翻译': t => (t.scenes || []).includes('翻译文档'),
  '学习': t => (t.scenes || []).includes('学习辅导'),
  '研究': t => (t.scenes || []).some(scene => scene.includes('研究')),
  '设计': t => t.theme === 'vision' || (t.scenes || []).some(scene => scene.includes('设计')),
  '头脑风暴': t => (t.scenes || []).includes('头脑风暴'),
  '创意': t => (t.scenes || []).some(scene => scene.includes('头脑风暴') || scene.includes('创意')),
  '办公': t => (t.scenes || []).some(scene => scene.includes('办公')),
  '数据分析': t => (t.scenes || []).includes('数据分析'),
};

export function getFilteredVendorCardItems() {
  const query = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
  let filtered = getVendorCardItems();
  if (query) filtered = filtered.filter(item => (item.search_terms || []).some(term => String(term).toLowerCase().includes(query)));
  if (state.activeFilters.access !== 'all') filtered = filtered.filter(item => item.access_level === state.activeFilters.access);
  if (state.activeFilters.price === 'free') filtered = filtered.filter(item => item.price_badge === 'free');
  if (state.activeFilters.price === 'paid') filtered = filtered.filter(item => item.price_badge !== 'free');
  return filtered;
}

export function getFilteredToolCardItems() {
  const query = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
  let filtered = getToolCardItems();
  if (query) filtered = filtered.filter(item => (item.search_terms || []).some(term => String(term).toLowerCase().includes(query)));
  if (state.activeFilters.access !== 'all') filtered = filtered.filter(item => item.access_level === state.activeFilters.access);
  if (state.activeFilters.price === 'free') filtered = filtered.filter(item => item.price_badge === 'free');
  if (state.activeFilters.price === 'paid') filtered = filtered.filter(item => item.price_badge !== 'free');
  return filtered;
}

export function getFilteredTools() {
  const query = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
  let filtered = state.tools;

  if (query) {
    const keywords = query.split(/\s+/).filter(k => k.length > 0);
    filtered = filtered.filter(t => {
      const searchText = getToolSearchText(t);
      return keywords.some(kw => searchText.includes(kw.toLowerCase()));
    });
    for (const [kw, fn] of Object.entries(searchAliases)) {
      if (query.includes(kw)) filtered = filtered.filter(fn);
    }
  }

  // EXTENSION POINT: 新增筛选维度时在此追加过滤条件
  if (state.activeFilters.access !== 'all') filtered = filtered.filter(t => t.access_level === state.activeFilters.access);
  if (state.activeFilters.price === 'free') filtered = filtered.filter(t => t.price_badge === 'free');
  if (state.activeFilters.price === 'paid') filtered = filtered.filter(t => t.price_badge !== 'free');
  return filtered;
}

export function getFilteredGlossary() {
  const query = (document.getElementById('glossarySearch')?.value || '').toLowerCase().trim();
  let filtered = state.glossary;

  if (state.activeGlossaryCategory !== 'all') {
    filtered = filtered.filter(g => g.category === state.activeGlossaryCategory);
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

export function getFilteredScenes() {
  const query = (document.getElementById('sceneSearch')?.value || '').toLowerCase().trim();
  if (!query) return state.scenes;
  const keywords = query.split(/\s+/).filter(keyword => keyword.length > 0);
  return state.scenes.filter(scene => keywords.some(keyword =>
    scene.name.toLowerCase().includes(keyword) ||
    scene.description.toLowerCase().includes(keyword) ||
    (scene.search_terms || []).some(term => term.toLowerCase().includes(keyword)) ||
    (scene.tasks || []).some(task => task.task.toLowerCase().includes(keyword))
  ));
}

export function getHotspotHeat(item) {
  const value = item?.hot_score ?? item?.popularity ?? item?.heat;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function getFilteredTrending() {
  let items = [...(state.hotspots.items || [])];
  if (state.activeTrendingType !== 'all') {
    items = items.filter(item => item.content_type === state.activeTrendingType);
  }
  const timestamp = item => {
    const value = new Date(item.published_at).getTime();
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  };
  const byTimeDesc = (a, b) => timestamp(b) - timestamp(a);
  if (state.activeTrendingSort === 'hot' && items.some(item => getHotspotHeat(item) !== null)) {
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
