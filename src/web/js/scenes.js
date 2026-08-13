/**
 * InfoCatcher MVP — 场景模式 (scenes)：12 个场景入口，可展开子任务并查看匹配工具卡片
 *
 * 场景数据来自 scenes.json；搜索匹配名称、简介、关联词和子任务名。
 * 每行展示场景图标、名称、去重后的工具数量和简介；点击后展开任务—工具映射。
 * 架构概要、八个视图与扩展模式见 main.js 顶部维护文档。
 */
import {
  tools,
  scenes,
  getToolCardItem,
  getToolLevel3Item,
  dataLoadFailures,
  getFilteredScenes,
  setRegionBusy,
  renderState,
  escapeHtml,
  getToolPublishedDate,
} from './data.js';
import { isComparableLeaf, isCompareSelected } from './compare.js';
import { markConceptsIn } from './search.js';

const scenePalette = {
  writing: { accent: '#d97706', border: '#92400e' },
  coding: { accent: '#047857', border: '#064e3b' },
  design: { accent: '#be185d', border: '#831843' },
  video: { accent: '#b91c1c', border: '#7f1d1d' },
  audio: { accent: '#6d28d9', border: '#4c1d95' },
  research: { accent: '#4338ca', border: '#312e81' },
  office: { accent: '#0e7490', border: '#164e63' },
  learning: { accent: '#1d4ed8', border: '#1e3a8a' },
};

let activeSceneId = null; // 决策 9.4：当前选中的场景

// 跨模块状态 setter（ESM：导入绑定只读，改值必须回到本模块）
function setActiveSceneId(value) { activeSceneId = value; }

function getSceneToolIds(scene) {
  return [...new Set((scene.tasks || []).flatMap(task => task.tools || []))];
}

function renderSceneToolCard(tool, selectedDetailRef = null) {
  const detailRef = selectedDetailRef || tool.detail_ref.id;
  const detail = getToolLevel3Item(tool.vendor_key, detailRef);
  const isComparable = detail ? isComparableLeaf(detail.id, detail.id) : false;
  const isSelected = isComparable && isCompareSelected(detail.id, detail.id);
  const specificLabel = selectedDetailRef ? detail?.title : null;
  const title = specificLabel || tool.title;
  const description = detail?.summary || tool.summary;
  const publishedDate = getToolPublishedDate(detail);
  const dateLabel = detail?.detail_kind === 'tool' ? '更新时间' : '发布时间';
  return '<div class="tool-card scene-tool-card" onclick="openDetail(\'' + escapeHtml(detailRef) + '\')">' +
    '<div class="tool-card-header">' +
      '<div><div class="tool-card-name">' + escapeHtml((tool.icon || '') + ' ' + title) + '</div>' +
      (specificLabel ? '<div class="scene-specific-recommendation">具体推荐：' + escapeHtml(specificLabel) + '</div>' : '') +
      '<div class="tool-card-vendor">' + escapeHtml(tool.vendor_label) + '</div></div>' +
      '' /* 决策 98：场景工具卡默认区不显示评分，评分保留在详情模态 */ +
    '</div>' +
    '<div class="tool-card-desc">' + escapeHtml(description) + '</div>' +
    '<div class="tool-card-tags">' +
      (tool.scenes || []).slice(0, 3).map(scene => '<span class="tag scene">' + escapeHtml(scene) + '</span>').join('') +
      (tool.price_badge === 'free' ? '<span class="tag free">免费可用</span>' : '<span class="tag paid">仅付费</span>') +
      '<span class="tag ' + (tool.access_level === '开放' ? 'open' : 'restricted') + '">' + (tool.access_level === '开放' ? '国内可用' : '需科学上网') + '</span>' +
    '</div>' +
    '<div class="tool-card-footer" onclick="event.stopPropagation()">' +
      '<span class="scene-tool-updated">' + (publishedDate ? dateLabel + ' ' + escapeHtml(publishedDate) : dateLabel + '待补充') + '</span>' +
      '<div class="tool-card-actions">' +
        '<button class="detail-button" type="button" onclick="openDetail(\'' + escapeHtml(detailRef) + '\',null,this)">查看详情</button>' +
        (isComparable ? '<button class="compare-toggle ' + (isSelected ? 'selected' : '') + '" aria-pressed="' + isSelected + '" onclick="toggleCompareRef(\'' + escapeHtml(detail.id) + '\',\'' + escapeHtml(detail.id) + '\',this)">' + (isSelected ? '已选' : '+对比') + '</button>' : '') +
      '</div>' +
    '</div>' +
  '</div>';
}

function renderScenes() {
  const filtered = getFilteredScenes();
  const picker = document.getElementById('scenePicker');
  const detail = document.getElementById('sceneDetail');
  if (!picker || !detail) return;
  setRegionBusy(detail, false);

  if (!scenes.length) {
    const sceneState = dataLoadFailures.has('scenes')
      ? renderState({ icon: '⚠️', title: '场景数据加载失败', message: '请刷新页面重试；其他资料视图仍可继续使用。', type: 'error' })
      : renderState({ icon: '○', title: '暂无场景数据', message: '当前公开资料中还没有可展示的场景。', type: 'unavailable' });
    picker.innerHTML = '';
    detail.innerHTML = sceneState;
    return;
  }

  if (!filtered.length) {
    picker.innerHTML = '';
    detail.innerHTML = renderState({ icon: '⌕', title: '没有匹配的场景', message: '请尝试“论文”“代码”“配图”“视频”或其他需求关键词。', type: 'no-match' });
    return;
  }

  if (!activeSceneId || !filtered.some(scene => scene.id === activeSceneId)) {
    setActiveSceneId(filtered[0].id);
  }

  picker.innerHTML = filtered.map(scene => {
    const isActive = scene.id === activeSceneId;
    return '<button class="scene-pick-chip' + (isActive ? ' active' : '') + '" type="button" data-scene-pick="' + escapeHtml(scene.id) + '" aria-pressed="' + isActive + '"' + (isActive ? ' aria-current="true"' : '') + '>' +
      '<span class="scene-pick-icon" aria-hidden="true">' + escapeHtml(scene.icon) + '</span>' +
      '<span>' + escapeHtml(scene.name) + '</span>' +
    '</button>';
  }).join('');

  renderSceneDetail();
}

function renderSceneDetail() {
  const detail = document.getElementById('sceneDetail');
  if (!detail) return;
  const scene = scenes.find(item => item.id === activeSceneId);
  if (!scene) return;
  const palette = scenePalette[scene.category] || scenePalette.learning;
  const toolIds = getSceneToolIds(scene);
  const taskRows = (scene.tasks || []).map((task, taskIndex) => {
    const matchedTools = (task.tools || []).map(toolId => getToolCardItem(toolId)).filter(Boolean);
    const recommendationByTool = new Map((task.recommendations || []).map(item => [item.tool_id, item]));
    const toolButtons = matchedTools.map(tool => {
      const recommendation = recommendationByTool.get(tool.tool_key);
      const label = recommendation ? getToolLevel3Item(tool.vendor_key, recommendation.detail_ref)?.title : null;
      return '<button class="scene-tool-button" type="button" aria-pressed="false" aria-controls="scene-tool-preview-' + escapeHtml(scene.id) + '-' + taskIndex + '" onclick="toggleSceneToolCard(\'' + escapeHtml(scene.id) + '\',' + taskIndex + ',\'' + escapeHtml(tool.tool_key) + '\',' + (recommendation ? '\'' + escapeHtml(recommendation.detail_ref) + '\'' : 'null') + ',this)">' +
        '<span class="scene-tool-button-icon" aria-hidden="true">' + escapeHtml(tool.icon) + '</span>' +
        '<span>' + escapeHtml(label || tool.title) + '</span>' +
      '</button>';
    }).join('');
    const recommendationNotes = (task.recommendations || []).map(item => item.reason).filter(Boolean);
    return '<div class="scene-task-item">' +
      '<div class="scene-task-line">' +
        '<span class="scene-task-name">' + escapeHtml(task.task) + '</span>' +
        '<div class="scene-task-tools">' + toolButtons + '</div>' +
      '</div>' +
      (recommendationNotes.length ? '<div class="scene-recommendation-reason" data-search-concept-text>推荐依据：' + recommendationNotes.map(escapeHtml).join('；') + '</div>' : '') +
      '<div class="scene-tool-preview" id="scene-tool-preview-' + escapeHtml(scene.id) + '-' + taskIndex + '" hidden></div>' +
    '</div>';
  }).join('');

  detail.innerHTML = '<div class="scene-detail-card" style="--scene-accent:' + palette.accent + ';--scene-border:' + palette.border + '">' +
    '<div class="scene-detail-head">' +
      '<span class="scene-detail-icon" aria-hidden="true">' + escapeHtml(scene.icon) + '</span>' +
      '<div><h2 class="section-title">' + escapeHtml(scene.name) + '</h2>' +
      '<p class="scene-detail-desc" data-search-concept-text>' + escapeHtml(scene.description) + '</p></div>' +
    '</div>' +
    (toolIds.length
      ? '<div class="scene-task-list">' + taskRows + '</div>'
      : '<p class="scene-detail-empty">当前公开资料中没有匹配该场景的工具，可返回工具库浏览其他工具。</p>') +
    '<div class="scene-detail-actions"><button class="btn btn-small" type="button" data-scene-back-tools>返回工具库</button></div>' +
  '</div>';
  // 决策 9.8：场景正文接入全站概念联动
  markConceptsIn(detail);
}

function toggleSceneToolCard(sceneId, taskIndex, toolId, selectedItemId, button) {
  const preview = document.getElementById('scene-tool-preview-' + sceneId + '-' + taskIndex);
  const tool = getToolCardItem(toolId);
  if (!preview || !tool) return;

  const isCurrent = button.classList.contains('active') && !preview.hidden;
  // 同一时刻只展开一个工具预览
  document.querySelectorAll('#sceneDetail .scene-tool-button.active').forEach(item => {
    item.classList.remove('active');
    item.setAttribute('aria-pressed', 'false');
  });
  document.querySelectorAll('#sceneDetail .scene-tool-preview').forEach(item => {
    item.hidden = true;
    item.innerHTML = '';
  });

  if (!isCurrent) {
    button.classList.add('active');
    button.setAttribute('aria-pressed', 'true');
    preview.innerHTML = renderSceneToolCard(tool, selectedItemId);
    preview.hidden = false;
  }
}

export {
  activeSceneId,
  setActiveSceneId,
  getSceneToolIds,
  renderSceneToolCard,
  renderScenes,
  renderSceneDetail,
  toggleSceneToolCard,
};
