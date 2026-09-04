'use strict';

const fs = require('fs');
const path = require('path');
const { readJson } = require('../../shared/json-store');
const { DIRS, NEWS_FILES, CATALOG_GENERATOR_FILES, CONCEPT_FILES } = require('../../shared/paths');
const { minReviewCommand } = require('../../news/cli/cmd-min');
const pendingStore = require('../../pending/index');
const { loadCatalogSnapshot } = require('../../catalog/core/index');
const { unresolvedKeywordCount } = require('./news-domain');
const { pendingProjection } = require('./catalog-domain');

function removeFile(file, removed) {
  if (!file || !fs.existsSync(file)) return;
  fs.unlinkSync(file);
  removed.push(file);
}

async function clearWorkspaceFiles(options = {}) {
  const config = readJson(NEWS_FILES.configV2, {}) || {};
  const archive = await minReviewCommand('archive', {});
  const removed = [];
  const manualFolder = path.resolve(DIRS.project, config.manual_folder || 'data/manual');
  for (const name of ['review.json', 'transcript-requests.json', 'keyword-refine.json', 'top.json']) {
    removeFile(path.join(manualFolder, name), removed);
  }
  const pendingFiles = [
    ['tools', options.pendingToolFile || CATALOG_GENERATOR_FILES.pendingTools],
    ['concepts', options.pendingConceptFile || CONCEPT_FILES.pendingConcepts],
  ];
  const clearedPending = {};
  for (const [kind, file] of pendingFiles) {
    if (!fs.existsSync(file)) continue;
    const current = pendingStore.readPending(kind, { toolFile: kind === 'tools' ? file : undefined, conceptFile: kind === 'concepts' ? file : undefined });
    pendingStore.writePending(kind, [], { toolFile: kind === 'tools' ? file : undefined, conceptFile: kind === 'concepts' ? file : undefined, runId: `maintainer-workbench-clear-${kind}` });
    clearedPending[kind] = current.cards.length;
  }
  removeFile(options.conceptPreviewFile || CONCEPT_FILES.previews, removed);
  removeFile(options.batchSeedsPreviewFile || CATALOG_GENERATOR_FILES.batchSeedsPreview, removed);
  return { archive, cleared_pending: clearedPending, removed_files: removed.map(file => path.relative(DIRS.project, file).split(path.sep).join('/')) };
}

function listItems(value, keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function checkWorkspaceStatus({ store, news, options, pending, concepts, catalogWorkbench, toolUpdatesProjection }) {
  const current = store();
  const blockers = [];
  const newsPending = current.candidates.filter(item => item.review_status === 'pending').length;
  if (newsPending) blockers.push({ code: 'NEWS_REVIEW_PENDING', count: newsPending, message: `还有 ${newsPending} 条新闻待首审` });
  const keywordPending = unresolvedKeywordCount(news);
  if (keywordPending) blockers.push({ code: 'KEYWORDS_PENDING', count: keywordPending, message: `还有 ${keywordPending} 个关键词待采纳或丢弃` });
  const topData = fs.existsSync(options.topFile || path.join(DIRS.manual, 'top.json'))
    ? readJson(options.topFile || path.join(DIRS.manual, 'top.json'), null)
    : null;
  const topItems = Array.isArray(topData?.candidates) ? topData.candidates : [];
  const topSelected = current.candidates.filter(item => item.top_selected === true).length;
  if (topItems.length && topSelected === 0) blockers.push({ code: 'TOP_SELECTION_PENDING', count: topItems.length, message: 'Top 待选池尚未完成最终选择' });
  const pendingTools = pendingProjection('tools', pending, (() => {
    try { const { snapshot } = loadCatalogSnapshot(); return { tools: [...(snapshot['tool-card'] || []), ...(snapshot['tool-level3'] || [])], glossary: [] }; } catch (_) { return { tools: [], glossary: [] }; }
  })()).items.filter(item => item.review_status === 'pending' || (item.review_status === 'approved' && item.workflow_state !== 'completed'));
  if (pendingTools.length) blockers.push({ code: 'TOOLS_PENDING', count: pendingTools.length, message: `还有 ${pendingTools.length} 个工具待补卡未完成` });
  const pendingConceptItems = pendingProjection('concepts', pending, (() => {
    try { const { snapshot } = loadCatalogSnapshot(); return { tools: [], glossary: concepts.readGlossary() }; } catch (_) { return { tools: [], glossary: [] }; }
  })()).items.filter(item => item.review_status === 'pending' || (item.review_status === 'approved' && item.workflow_state !== 'completed'));
  if (pendingConceptItems.length) blockers.push({ code: 'CONCEPTS_PENDING', count: pendingConceptItems.length, message: `还有 ${pendingConceptItems.length} 个概念待补卡未完成` });
  const drafts = listItems(catalogWorkbench.list(), ['items', 'drafts']);
  if (drafts.length) blockers.push({ code: 'CATALOG_DRAFTS_PENDING', count: drafts.length, message: `还有 ${drafts.length} 个 Catalog Draft 未完成` });
  const preview = concepts.readPreviews();
  const conceptPreviewPending = preview?.schema_version === 2 && Array.isArray(preview.cards) && preview.cards.length > 0;
  if (conceptPreviewPending) blockers.push({ code: 'CONCEPT_PREVIEW_PENDING', count: preview.cards.length, message: `还有 ${preview.cards.length} 个概念预览待 Apply` });
  const toolUpdateItems = toolUpdatesProjection().items;
  if (toolUpdateItems.length) blockers.push({ code: 'TOOL_UPDATES_PENDING', count: toolUpdateItems.length, message: `还有 ${toolUpdateItems.length} 个工具更新待审核` });
  return {
    status: blockers.length ? 'incomplete' : 'complete',
    clearable: blockers.length === 0,
    blockers,
    counts: { news_pending: newsPending, keywords_pending: keywordPending, top_candidates: topItems.length, top_selected: topSelected, tools_pending: pendingTools.length, concepts_pending: pendingConceptItems.length, catalog_drafts: drafts.length, concept_previews: conceptPreviewPending ? preview.cards.length : 0, tool_updates_pending: toolUpdateItems.length },
  };
}

module.exports = {
  clearWorkspaceFiles,
  checkWorkspaceStatus,
};
