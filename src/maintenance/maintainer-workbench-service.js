'use strict';

const fs = require('fs');
const path = require('path');
const { readJson } = require('../news/core/news-storage');
const minStore = require('../news/min/min-store');
const toolReviewStore = require('../catalog/tool-update-review-store');
const { readConceptPreviews } = require('../catalog/concept-batch');
const { DIRS } = require('../shared/paths');
const { loadProductUrlRegistry } = require('../catalog/official-url-registry');
const { loadDotEnv } = require('../shared/env');
const { minReviewCommand } = require('../news/cli/cmd-min');
const { mainMin: publishNewsProjection } = require('../../scripts/publish-news');
const { runPreview: previewToolUpdates, runApply: applyToolUpdates } = require('../../scripts/tool-update-review');

function idsOf(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || !id.trim())) throw new Error('ids 必须是非空字符串数组');
  return [...new Set(value.map(id => id.trim()))];
}
function expectedRevision(body) {
  const value = body?.expected_revision;
  if (typeof value !== 'string' || !value.trim()) throw new Error('expected_revision 必填');
  return value;
}
function requireMutation(name, value) {
  if (typeof value !== 'function') throw new Error(`${name} mutation API 不可用`);
  return value;
}

function createDefaultApis(options = {}) {
  const keywordFile = options.keywordFile || path.join(DIRS.manual, 'keyword-refine.json');
  return {
    news: {
      readStore: () => minStore.readMinStore(),
      revisionOfStore: store => requireMutation('revisionOfMinStore', minStore.revisionOfMinStore)(store),
      commit: (mutation, commitOptions) => requireMutation('commitMinStoreMutation', minStore.commitMinStoreMutation)(mutation, commitOptions),
      reviewMutation: (store, ids, decision, mutationOptions) => requireMutation('reviewPendingCandidates', minStore.reviewPendingCandidates)(store, ids, decision, mutationOptions),
      topMutation: (store, ids, selected, mutationOptions) => requireMutation('setApprovedTopSelectedMin', minStore.setApprovedTopSelectedMin)(store, ids, selected, mutationOptions),
      readKeywords: () => readJson(keywordFile, null),
      readConfig: () => readJson(require('../shared/paths').NEWS_FILES.configV2, {}),
      revisionOfConfig: config => require('../news/min/keyword-actions').revisionOfConfig(config),
      commitKeywords: (list, commitOptions) => require('../news/min/keyword-actions').commitKeywordActions(list, commitOptions),
      commitKeywordExclusions: (words, commitOptions) => require('../news/min/keyword-actions').commitKeywordExclusions(words, commitOptions),
      uploadTranscript: (payload, commitOptions) => require('../news/min/transcript-workflow').uploadTranscript(payload.candidate_id, payload.filename, payload.content_base64, commitOptions),
      summarizeTranscripts: (ids, commitOptions) => require('../news/min/transcript-workflow').summarizeTranscripts(ids, commitOptions),
      generateKeywords: async () => {
        loadDotEnv();
        return minReviewCommand('refine', {});
      },
      generateTop: async () => {
        loadDotEnv();
        return minReviewCommand('ai-top', {});
      },
      publish: () => publishNewsProjection(),
    },
    tools: {
      readQueue: () => requireMutation('readReviewQueueProjection', toolReviewStore.readReviewQueueProjection)(),
      readRegistry: () => loadProductUrlRegistry(),
      review: request => requireMutation('setReviewStatusReviewQueue', toolReviewStore.setReviewStatusReviewQueue)(request),
      preview: () => previewToolUpdates({}, {}),
      apply: flags => applyToolUpdates(flags, {}),
    },
    concepts: { readPreviews: () => readConceptPreviews() },
  };
}

function createMaintainerWorkbenchService(options = {}) {
  const defaults = createDefaultApis(options);
  const news = { ...defaults.news, ...(options.newsApi || {}) };
  const tools = { ...defaults.tools, ...(options.toolsApi || {}) };
  const concepts = { ...defaults.concepts, ...(options.conceptsApi || {}) };
  const store = () => { const value = news.readStore(); return value && Array.isArray(value.candidates) ? value : { candidates: [] }; };
  const newsProjection = (items = store().candidates) => ({ revision: news.revisionOfStore(store()), items });
  const toolUpdatesProjection = () => {
    const queue = tools.readQueue();
    const registry = tools.readRegistry ? tools.readRegistry() : undefined;
    const views = toolReviewStore.reviewQueueViews(queue, { registry });
    const actionableKeys = new Set(views.actionable.map(item => item.candidate_key));
    const history = [
      ...views.history,
      ...views.current_items
        .filter(item => !actionableKeys.has(item.candidate_key))
        .map(item => ({ ...item, history_reason: item.review_status === 'pending' ? 'not_actionable' : 'completed' })),
    ];
    return {
      revision: queue.revision,
      items: views.actionable,
      history,
      history_count: history.length,
    };
  };

  return Object.freeze({
    overview() {
      const candidates = store().candidates;
      const toolQueue = toolUpdatesProjection();
      const previews = concepts.readPreviews();
      return { news: { revision: news.revisionOfStore(store()), total: candidates.length, pending: candidates.filter(item => item.review_status === 'pending').length, approved: candidates.filter(item => item.review_status === 'approved').length, selected: candidates.filter(item => item.top_selected === true).length }, tool_updates: { revision: toolQueue.revision, pending: toolQueue.items.length, history: toolQueue.history_count }, concepts: { previews: Array.isArray(previews?.cards) ? previews.cards.length : 0 } };
    },
    newsReview() { return newsProjection(store().candidates.filter(item => item.review_status === 'pending')); },
    reviewNews(body) {
      const ids = idsOf(body?.ids); const revision = expectedRevision(body);
      const decision = body?.decision;
      if (!['approved', 'discarded'].includes(decision)) throw new Error('decision 必须是 approved 或 discarded');
      const result = news.commit(current => news.reviewMutation(current, ids, decision, { expectedRevision: revision }), { expectedRevision: revision, runId: 'maintainer-workbench-news-review' });
      return { updated: result.updated, missing: result.missing || [], not_pending: result.not_pending || [], revision: result.revision };
    },
    keywords() {
      const config = news.readConfig(); const list = news.readKeywords();
      const adoptedSet = new Set(Array.isArray(config?.keywords?.ai_keywords) ? config.keywords.ai_keywords.map(word => String(word).trim().toLowerCase()) : []);
      const excludedSet = new Set(Array.isArray(config?.keywords?.excluded_keywords) ? config.keywords.excluded_keywords.map(word => String(word).trim().toLowerCase()) : []);
      const items = Array.isArray(list?.candidates) ? list.candidates.map(item => {
        const key = String(item?.word || '').trim().toLowerCase();
        return {
          ...item,
          adopted: adoptedSet.has(key),
          discarded: excludedSet.has(key),
        };
      }) : [];
      const hasSource = list && (list.source_count != null || list.input_count != null || list.source_basis != null);
      return {
        revision: news.revisionOfConfig(config),
        ...(hasSource ? { source: { source_count: list.source_count ?? null, input_count: list.input_count ?? null, source_basis: list.source_basis ?? null } } : {}),
        items,
      };
    },
    applyKeywords(body) {
      const ids = idsOf(body?.ids); const revision = expectedRevision(body); const list = news.readKeywords();
      if (!list || !Array.isArray(list.candidates)) throw new Error('关键词候选清单不存在或无效');
      const selected = new Set(ids);
      const adopted_keywords = list.candidates.filter(item => selected.has(String(item.id || item.word || ''))).map(item => item.word);
      if (adopted_keywords.length !== selected.size) throw new Error('存在未知关键词 id');
      return news.commitKeywords({ ...list, adopted_keywords }, { expectedRevision: revision, runId: 'maintainer-workbench-keywords' });
    },
    discardKeywords(body) {
      const words = idsOf(body?.ids); const revision = expectedRevision(body);
      return news.commitKeywordExclusions(words, { expectedRevision: revision, runId: 'maintainer-workbench-keywords-discard' });
    },
    async generateKeywords() {
      if (store().candidates.some(item => item.review_status === 'pending')) throw new Error('仍有待审核新闻，完成首审后才能生成关键词候选');
      return news.generateKeywords();
    },
    top() {
      const current = store();
      const approvedIds = new Set(current.candidates.filter(candidate => candidate.review_status === 'approved').map(candidate => candidate.id));
      const topFile = options.topFile || path.join(DIRS.manual, 'top.json');
      let items = [];
      let note = null;
      if (fs.existsSync(topFile)) {
        const list = readJson(topFile, null);
        if (list && Array.isArray(list.candidates)) {
          items = list.candidates
            .filter(entry => entry && entry.id != null && approvedIds.has(String(entry.id)))
            .map(entry => {
              const candidate = current.candidates.find(item => item.id === String(entry.id));
              const zh = candidate && candidate.localizations && candidate.localizations.zh;
              return {
                id: String(entry.id),
                url: candidate?.url || entry.url || null,
                title: zh && (zh.title || zh.summary) ? (zh.title || zh.summary) : String(entry.summary || candidate?.title || entry.description || ''),
                summary: zh && zh.description ? zh.description : String(entry.description || candidate?.description || entry.summary || ''),
                top_selected: Boolean(candidate && candidate.top_selected === true),
                score: entry.score ?? null,
                transcript_status: !candidate?.transcript ? 'none' : (candidate.transcript_summarized_at ? 'summarized' : 'uploaded'),
                transcript_file: candidate?.transcript_file || null,
                platform: candidate?.platform || entry.platform || null,
              };
            });
        } else note = 'Top 待选池结构无效，请重新运行 min-review ai-top';
      } else {
        note = '尚未生成 Top 待选池：先运行 min-review ai-top（纯 X 10 / 有 YouTube 15），再从池中选 3~5/3~8 条。';
      }
      return { revision: news.revisionOfStore(current), items, note };
    },
    applyTop(body) {
      const ids = idsOf(body?.ids); const revision = expectedRevision(body);
      if (typeof body?.selected !== 'boolean') throw new Error('selected 必须显式为 boolean');
      const result = news.commit(current => news.topMutation(current, ids, body.selected, { expectedRevision: revision }), { expectedRevision: revision, runId: 'maintainer-workbench-top' });
      return { updated: result.updated, missing: result.missing || [], not_approved: result.not_approved || [], revision: result.revision };
    },
    async generateTop() {
      if (store().candidates.some(item => item.review_status === 'pending')) throw new Error('仍有待审核新闻，完成首审后才能生成 Top 待选池');
      return news.generateTop();
    },
    publishNews() {
      if (!store().candidates.some(item => item.review_status === 'approved' && item.top_selected === true)) throw new Error('尚未选择 Top 项目，不能发布公开投影');
      return news.publish();
    },
    uploadTranscript(body) {
      const revision = expectedRevision(body);
      if (typeof body?.candidate_id !== 'string' || !body.candidate_id.trim()) throw new Error('candidate_id 必填');
      if (typeof body?.filename !== 'string' || !body.filename.trim()) throw new Error('字幕文件名必填');
      if (typeof body?.content_base64 !== 'string' || !body.content_base64) throw new Error('字幕文件内容必填');
      return news.uploadTranscript(body, { expectedRevision: revision });
    },
    summarizeTranscripts(body, runtime = {}) {
      const ids = idsOf(body?.ids); const revision = expectedRevision(body);
      const confirmCost = body?.confirm_cost === true;
      return news.summarizeTranscripts(ids, {
        expectedRevision: revision,
        confirmCost,
        signal: runtime.signal,
      });
    },
    publishPreview() { return newsProjection(store().candidates.filter(item => item.review_status === 'approved' && item.top_selected === true)); },
    toolUpdates() { return toolUpdatesProjection(); },
    reviewToolUpdate(key, body) {
      const request = { candidate_key: key, review_status: body?.decision, expected_revision: expectedRevision(body) };
      if (tools.readRegistry) request.registry = tools.readRegistry();
      return tools.review(request);
    },
    previewToolUpdates() {
      return tools.preview();
    },
    applyToolUpdates(body) {
      const expected_revision = String(body?.expected_revision || '').trim();
      const preview_hash = String(body?.preview_hash || '').trim();
      const confirm = String(body?.confirm || '').trim();
      if (!expected_revision || !preview_hash || !confirm) throw new Error('工具更新 Apply 缺少预览 revision、preview hash 或确认语句');
      return tools.apply({ expected_revision, preview_hash, confirm });
    },
    conceptPreviews() { const preview = concepts.readPreviews(); return { items: Array.isArray(preview?.cards) ? preview.cards : [] }; },
  });
}

module.exports = { createMaintainerWorkbenchService, createDefaultApis, idsOf, expectedRevision };
