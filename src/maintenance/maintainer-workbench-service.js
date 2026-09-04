'use strict';

const { createCatalogWorkbench } = require('../catalog/catalog-workbench');
const {
  createDefaultNewsApi,
  handleNewsReview,
  handleReviewNews,
  handleKeywords,
  handleApplyKeywords,
  handleDiscardKeywords,
  handleTop,
  handleApplyTop,
  handleUploadTranscript,
  handleSummarizeTranscripts,
} = require('./workbench/news-domain');
const {
  createDefaultToolsApi,
  toolUpdatesProjection,
  handleReviewToolUpdate,
  handleApplyToolUpdates,
} = require('./workbench/tool-update-domain');
const {
  createDefaultConceptsApi,
  createDefaultPendingApi,
  createDefaultFeedbackApi,
  conceptPlan,
  handleConceptPrepare,
  handleConceptPreviews,
  handleConceptApply,
  handleExtractKnowledge,
  getPendingTools,
  getPendingConcepts,
} = require('./workbench/catalog-domain');
const {
  clearWorkspaceFiles,
  checkWorkspaceStatus,
} = require('./workbench/workspace-domain');

function idsOf(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('ids 必须是非空字符串数组');
  }
  return [...new Set(value.map(id => id.trim()))];
}

function expectedRevision(body) {
  const value = body?.expected_revision;
  if (typeof value !== 'string' || !value.trim()) throw new Error('expected_revision 必填');
  return value;
}

function createDefaultApis(options = {}) {
  return {
    news: createDefaultNewsApi(options),
    tools: createDefaultToolsApi(),
    concepts: createDefaultConceptsApi(options),
    pending: createDefaultPendingApi(options),
    feedback: createDefaultFeedbackApi(options),
    workspace: {
      clear: () => clearWorkspaceFiles(options),
    },
  };
}

function createMaintainerWorkbenchService(options = {}) {
  const defaults = createDefaultApis(options);
  const news = { ...defaults.news, ...(options.newsApi || {}) };
  const tools = { ...defaults.tools, ...(options.toolsApi || {}) };
  const concepts = { ...defaults.concepts, ...(options.conceptsApi || {}) };
  const pending = { ...defaults.pending, ...(options.pendingApi || {}) };
  const feedback = { ...defaults.feedback, ...(options.feedbackApi || {}) };
  const workspace = { ...defaults.workspace, ...(options.workspaceApi || {}) };

  const catalogWorkbench = options.catalogWorkbench || createCatalogWorkbench({
    ...(options.catalogWorkbenchOptions || {}),
    readPending: () => pending.read('tools'),
    ...(options.catalogApi || {}),
  });

  const store = () => {
    const value = news.readStore();
    return value && Array.isArray(value.candidates) ? value : { candidates: [] };
  };
  const newsProjection = (items = store().candidates) => ({ revision: news.revisionOfStore(store()), items });
  const toolUpdates = () => toolUpdatesProjection(tools);
  const getWorkspaceStatus = () => checkWorkspaceStatus({
    store,
    news,
    options,
    pending,
    concepts,
    catalogWorkbench,
    toolUpdatesProjection: toolUpdates,
  });

  return Object.freeze({
    workspaceStatus: getWorkspaceStatus,
    async clearWorkspace() {
      const status = getWorkspaceStatus();
      if (!status.clearable) {
        return {
          ok: false,
          code: 'WORKBENCH_NOT_COMPLETE',
          message: status.blockers.map(item => item.message).join('；') || '所有审核工作完成后才能清空工作台。',
          status: status.status,
          blockers: status.blockers,
          counts: status.counts,
        };
      }
      const result = await workspace.clear();
      return { ok: true, status: 'cleared', ...result };
    },

    overview() {
      const candidates = store().candidates;
      const toolQueue = toolUpdates();
      const previews = concepts.readPreviews();
      const ws = getWorkspaceStatus();
      return {
        news: {
          revision: news.revisionOfStore(store()),
          total: candidates.length,
          pending: candidates.filter(item => item.review_status === 'pending').length,
          approved: candidates.filter(item => item.review_status === 'approved').length,
          selected: candidates.filter(item => item.top_selected === true).length,
        },
        tool_updates: { revision: toolQueue.revision, pending: toolQueue.items.length, history: toolQueue.history_count },
        concepts: { previews: Array.isArray(previews?.cards) ? previews.cards.length : 0 },
        workspace: ws,
      };
    },
    newsReview() {
      return handleNewsReview({ store, news, options, newsProjection });
    },
    async repairNews(body = {}) {
      return news.repairNews(body);
    },
    reviewNews(body) {
      return handleReviewNews(body, news, { idsOf, expectedRevision });
    },
    keywords() {
      return handleKeywords(news);
    },
    applyKeywords(body) {
      return handleApplyKeywords(body, news, { idsOf, expectedRevision });
    },
    discardKeywords(body) {
      return handleDiscardKeywords(body, news, { idsOf, expectedRevision });
    },
    async generateKeywords() {
      if (store().candidates.some(item => item.review_status === 'pending')) {
        throw new Error('仍有待审核新闻，完成首审后才能生成关键词候选');
      }
      return news.generateKeywords();
    },
    top() {
      return handleTop(store, news, options);
    },
    applyTop(body) {
      return handleApplyTop(body, news, { idsOf, expectedRevision });
    },
    async generateTop() {
      if (store().candidates.some(item => item.review_status === 'pending')) {
        throw new Error('仍有待审核新闻，完成首审后才能生成 Top 待选池');
      }
      return news.generateTop();
    },
    publishNews() {
      if (!store().candidates.some(item => item.review_status === 'approved' && item.top_selected === true)) {
        throw new Error('尚未选择 Top 项目，不能发布公开投影');
      }
      return news.publish();
    },
    uploadTranscript(body) {
      return handleUploadTranscript(body, news, expectedRevision);
    },
    summarizeTranscripts(body, runtime = {}) {
      return handleSummarizeTranscripts(body, news, { idsOf, expectedRevision }, runtime);
    },
    publishPreview() {
      return newsProjection(store().candidates.filter(item => item.review_status === 'approved' && item.top_selected === true));
    },
    toolUpdates() {
      return toolUpdates();
    },
    reviewToolUpdate(key, body) {
      return handleReviewToolUpdate(key, body, tools, expectedRevision);
    },
    previewToolUpdates() {
      return tools.preview();
    },
    applyToolUpdates(body) {
      return handleApplyToolUpdates(body, tools);
    },
    pendingTools() {
      return getPendingTools(pending);
    },
    pendingConcepts() {
      return getPendingConcepts(pending, concepts);
    },
    async reviewPendingTool(candidateKey, body) {
      const result = await pending.review('tools', candidateKey, body?.decision, expectedRevision(body));
      return { ok: true, candidate_key: candidateKey, revision: result.revision };
    },
    async reviewPendingConcept(candidateKey, body) {
      const result = await pending.review('concepts', candidateKey, body?.decision, expectedRevision(body));
      return { ok: true, candidate_key: candidateKey, revision: result.revision };
    },
    async extractKnowledge(body) {
      return handleExtractKnowledge(body, store, news, feedback, pending, expectedRevision);
    },
    catalogPlan() { return catalogWorkbench.plan(); },
    catalogPrepare(body) { return catalogWorkbench.prepare(body); },
    catalogDrafts() { return catalogWorkbench.list(); },
    catalogDraft(draftId) { return catalogWorkbench.read(draftId); },
    catalogReview(draftId) { return catalogWorkbench.review(draftId); },
    catalogRecoveryPlan(draftId, body = {}) {
      const allowed = new Set(['expected_revision', 'generator_options']);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.has(key))) {
        throw Object.assign(new Error('Catalog 恢复计划请求字段无效'), { code: 'RECOVERY_OPTIONS_INVALID' });
      }
      expectedRevision(body);
      return catalogWorkbench.recoveryPlan(draftId, body);
    },
    catalogResume(draftId, body = {}) {
      const allowed = new Set(['expected_revision', 'generator_options', 'recovery_token', 'confirm_cost']);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.has(key))) {
        throw Object.assign(new Error('Catalog 恢复请求字段无效'), { code: 'RECOVERY_OPTIONS_INVALID' });
      }
      expectedRevision(body);
      return catalogWorkbench.resume(draftId, body);
    },
    catalogDiscard(draftId, body) { return catalogWorkbench.discard(draftId, body); },
    catalogApply(body) { return catalogWorkbench.apply(body); },
    catalogBatchPreview() { return catalogWorkbench.batchPreview(); },
    catalogApplyBatch(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('批量 Catalog 请求无效');
      const allowed = new Set(['draft_ids', 'expected_revision', 'batch_token', 'confirm']);
      if (Object.keys(body).some(key => !allowed.has(key))) throw new Error('批量 Catalog 请求字段无效');
      return catalogWorkbench.applyBatch({
        draft_ids: body.draft_ids,
        expected_revision: body.expected_revision,
        batch_token: body.batch_token,
        confirm: body.confirm,
      });
    },
    conceptPlan() { return conceptPlan(concepts, store); },
    conceptPrepare(body) {
      return handleConceptPrepare(body, concepts, store, options);
    },
    conceptPreviews() {
      return handleConceptPreviews(concepts);
    },
    conceptApply(body) {
      return handleConceptApply(body, concepts, expectedRevision);
    },
  });
}

module.exports = {
  createMaintainerWorkbenchService,
  createDefaultApis,
  idsOf,
  expectedRevision,
};
