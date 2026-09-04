/**
 * data-loader.js — 数据加载与骨架屏
 * 异步加载全站静态 JSON 数据与五模块目录。
 */

import { catalog } from './catalog-interface.js';
import { state, dataLoadFailures } from './state.js';
import { getToolCardItems } from './data-catalog.js';

export function renderSkeletons() {
  const skeleton = '<div class="skeleton-list">' +
    Array(4).fill('<div class="skeleton"><span></span><span></span><span></span></div>').join('') +
  '</div>';
  const vendorGrid = document.getElementById('vendorGrid');
  if (vendorGrid) vendorGrid.innerHTML = skeleton;
  const toolGrid = document.getElementById('toolGrid');
  if (toolGrid) toolGrid.innerHTML = skeleton;
  const sceneDetail = document.getElementById('sceneDetail');
  if (sceneDetail) sceneDetail.innerHTML = '<div class="skeleton skeleton-detail"></div>';
  const trendingGrid = document.getElementById('trendingGrid');
  if (trendingGrid) trendingGrid.innerHTML = skeleton;
  const glossaryIndex = document.getElementById('glossaryIndexList');
  if (glossaryIndex) glossaryIndex.innerHTML = skeleton;
}

export async function loadData() {
  const catalogResult = await catalog({ operation: 'load' });
  if (!catalogResult.ok) {
    dataLoadFailures.add('tools');
    dataLoadFailures.add('catalog');
    state.tools = [];
  } else {
    state.tools = getToolCardItems();
    const dateEl = document.getElementById('dataDate');
    if (dateEl) {
      dateEl.textContent = '数据更新: ' + new Date().toISOString().slice(0, 10);
    }
  }
  try {
    const gResp = await fetch('data/catalog/glossary.json');
    state.glossary = await gResp.json();
  } catch (e) {
    state.glossary = [];
    dataLoadFailures.add('glossary');
  }
  try {
    const sResp = await fetch('data/catalog/scenes.json');
    const sceneData = await sResp.json();
    state.scenes = Array.isArray(sceneData.scenes) ? sceneData.scenes : [];
  } catch (e) {
    state.scenes = [];
    dataLoadFailures.add('scenes');
  }
  try {
    const nResp = await fetch('data/news/output/hotspots.json');
    state.hotspots = await nResp.json();
  } catch (e) {
    state.hotspots = { items: [], coverage: null, generated_at: null };
    dataLoadFailures.add('hotspots');
  }
  try {
    const fResp = await fetch('data/catalog/featured.json');
    state.featuredPicks = await fResp.json();
  } catch (e) {
    state.featuredPicks = [];
    dataLoadFailures.add('featured');
  }
}
