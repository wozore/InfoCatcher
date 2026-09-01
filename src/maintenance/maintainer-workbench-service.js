'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson } = require('../news/core/news-storage');
const minStore = require('../news/min/min-store');
const toolReviewStore = require('../catalog/tool-update-review-store');
const pendingStore = require('../news/feedback/pending-review-store');
const { feedbackFromSummaries, toolExists, conceptExists } = require('../news/feedback/tool-feedback');
const conceptBatch = require('../catalog/concept-batch');
const { createCatalogWorkbench } = require('../catalog/catalog-workbench');
const { loadCatalogSnapshot } = require('../catalog/catalog-snapshot-store');
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

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}
function hash(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stableValue(value)) + '\\n', 'utf8').digest('hex')}`; }
function pendingProjection(kind, api, formal = { tools: [], glossary: [] }) {
  const payload = api.read(kind);
  const projected = pendingStore.projectPending(kind, payload);
  const exists = kind === 'tools'
    ? (item) => toolExists(item.name, formal.tools)
    : (item) => conceptExists(item.term, formal.glossary);
  return {
    ...projected,
    items: projected.items.map(item => {
      if (item.review_status === 'approved' && exists(item)) return { ...item, workflow_state: 'completed' };
      return item;
    }),
  };
}
function projectConceptPreview(preview) {
  const cards = Array.isArray(preview?.cards) ? preview.cards : [];
  return {
    schema_version: preview?.schema_version || 1,
    base_revision: preview?.base_revision || null,
    source_pending_revision: preview?.source_pending_revision || null,
    preview_hash: preview?.preview_hash || null,
    count: cards.length,
    items: cards.map(card => ({
      candidate_key: card.candidate_key || null,
      term: card.term || '',
      full_name: card.full_name || '',
      category: card.category || '',
      summary: card.summary || card.definition || '',
      related_terms: Array.isArray(card.related_terms) ? card.related_terms.slice() : [],
      source: card.source && typeof card.source === 'object' ? { name: card.source.name || '', ...(card.source.url ? { url: card.source.url } : {}) } : null,
      relevance: card.relevance || '',
      evidence_count: Number(card.evidence_count || 0),
      status: card.status || 'pending',
    })),
  };
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
    concepts: {
      readPreviews: () => conceptBatch.readConceptPreviews({ previewFile: options.conceptPreviewFile }),
      readPending: () => pendingStore.readPending('concepts', { conceptFile: options.pendingConceptFile }),
      readGlossary: () => conceptBatch.readGlossary({ glossaryFile: options.glossaryFile }),
      runBatch: (cards, batchOptions) => conceptBatch.runConceptBatch(cards, { ...batchOptions, previewFile: options.conceptPreviewFile, glossaryFile: options.glossaryFile }),
      apply: (preview, applyOptions) => conceptBatch.applyConceptPreviews(preview, { ...applyOptions, previewFile: options.conceptPreviewFile, glossaryFile: options.glossaryFile }),
    },
    pending: {
      read: kind => pendingStore.readPending(kind, { toolFile: options.pendingToolFile, conceptFile: options.pendingConceptFile }),
      review: (kind, key, decision, revision) => pendingStore.reviewPending(kind, key, decision, revision, { toolFile: options.pendingToolFile, conceptFile: options.pendingConceptFile }),
    },
    feedback: {
      extract: (store, config) => feedbackFromSummaries(store, config, { ...(options.feedbackOptions || {}), pendingToolFile: options.pendingToolFile, pendingConceptFile: options.pendingConceptFile }),
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
  const catalogWorkbench = options.catalogWorkbench || createCatalogWorkbench({
    ...(options.catalogWorkbenchOptions || {}),
    readPending: () => pending.read('tools'),
    ...(options.catalogApi || {}),
  });
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

  async function conceptPlan() {
    const pendingPayload = concepts.readPending();
    const glossary = concepts.readGlossary();
    const cards = (pendingPayload.cards || []).filter(card => card.review_status === 'approved');
    const glossaryRevision = conceptBatch.revisionOfGlossary(glossary);
    if (!cards.length) return { ok: false, code: 'PENDING_CANDIDATE_NOT_APPROVED', pending_revision: pendingPayload.revision, glossary_revision: glossaryRevision, candidate_keys: [] };
    const batch = await concepts.runBatch(cards, { store: store(), glossary, dryRun: true, skipVibeHub: true });
    const estimate = batch.estimate || conceptBatch.planConceptCost(cards);
    const plan = { pending_revision: pendingPayload.revision, glossary_revision: glossaryRevision, candidate_keys: cards.map(card => card.candidate_key), estimate, evidence_count: (batch.evidence || []).reduce((count, item) => count + (item.evidence || []).length, 0) };
    return { ok: true, status: 'cost_confirmation_required', ...plan, plan_hash: hash({ kind: 'concept-workbench-plan', ...plan }) };
  }
  async function assertConceptPlan(body) {
    const plan = await conceptPlan();
    if (!plan.ok) return plan;
    if (body.pending_revision !== plan.pending_revision || body.glossary_revision !== plan.glossary_revision) { const error = new Error('REVISION_CONFLICT'); error.code = 'REVISION_CONFLICT'; throw error; }
    if (body.plan_hash !== plan.plan_hash) { const error = new Error('PLAN_CHANGED'); error.code = 'PLAN_CHANGED'; throw error; }
    return plan;
  }

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
    pendingTools() {
      let formal = { tools: [], glossary: [] };
      try { const { snapshot } = loadCatalogSnapshot(); formal = { tools: snapshot['tool-card'] || [], glossary: [] }; } catch (_) { /* 测试或临时目录缺正式 catalog：视为无命中 */ }
      return pendingProjection('tools', pending, formal);
    },
    pendingConcepts() {
      let formal = { tools: [], glossary: [] };
      try { const { snapshot } = loadCatalogSnapshot(); formal = { tools: snapshot['tool-card'] || [], glossary: concepts.readGlossary() }; } catch (_) { /* 同上 */ }
      return pendingProjection('concepts', pending, formal);
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
      const revision = expectedRevision(body);
      const current = store();
      if (news.revisionOfStore(current) !== revision) throw Object.assign(new Error('REVISION_CONFLICT'), { code: 'REVISION_CONFLICT' });
      const result = await feedback.extract(current, news.readConfig());
      const toolPending = pending.read('tools');
      const conceptPending = pending.read('concepts');
      return {
        ok: true,
        tools_found: (result.toolsFound || []).length,
        concepts_found: (result.conceptsFound || []).length,
        tools_pending: (result.toolsPending || []).length,
        concepts_pending: (result.conceptsPending || []).length,
        pending_revisions: { tools: toolPending.revision, concepts: conceptPending.revision },
      };
    },
    catalogPlan() { return catalogWorkbench.plan(); },
    catalogPrepare(body) { return catalogWorkbench.prepare(body); },
    catalogDrafts() { return catalogWorkbench.list(); },
    catalogDraft(draftId) { return catalogWorkbench.read(draftId); },
    catalogReview(draftId) { return catalogWorkbench.review(draftId); },
    catalogResume(draftId, body) { return catalogWorkbench.resume(draftId, body); },
    catalogDiscard(draftId, body) { return catalogWorkbench.discard(draftId, body); },
    catalogApply(body) { return catalogWorkbench.apply(body); },
    conceptPlan() { return conceptPlan(); },
    async conceptPrepare(body) {
      if (body?.confirm_cost !== true) return { ok: false, code: 'COST_CONFIRMATION_REQUIRED' };
      const plan = await assertConceptPlan(body);
      if (!plan.ok) return plan;
      const pendingPayload = concepts.readPending();
      const cards = (pendingPayload.cards || []).filter(card => card.review_status === 'approved');
      const result = await concepts.runBatch(cards, {
        ...(options.conceptBatchOptions || {}),
        store: store(),
        glossary: concepts.readGlossary(),
        confirmCost: true,
        sourcePendingRevision: plan.pending_revision,
        baseGlossaryRevision: plan.glossary_revision,
        skipVibeHub: options.conceptBatchOptions?.skipVibeHub,
      });
      const preview = concepts.readPreviews();
      return {
        ok: result?.ok === true,
        status: result?.ok ? 'preview_ready' : 'blocked',
        code: result?.code || null,
        base_revision: plan.glossary_revision,
        source_pending_revision: plan.pending_revision,
        preview: preview?.schema_version === 2 ? projectConceptPreview(preview) : null,
        failed: Array.isArray(result?.failed) ? result.failed.map(item => ({ term: item.term, reason: String(item.reason || 'OPERATION_FAILED').split(':')[0] })) : [],
        cost: result?.cost || result?.estimate || null,
      };
    },
    conceptPreviews() {
      const preview = concepts.readPreviews();
      return preview?.schema_version === 2 ? projectConceptPreview(preview) : { items: Array.isArray(preview?.cards) ? preview.cards : [] };
    },
    conceptApply(body) {
      const preview = concepts.readPreviews();
      if (!preview || preview.schema_version !== 2) return { ok: false, code: 'PREVIEW_INVALID' };
      const pendingPayload = concepts.readPending();
      const previewHash = String(body?.preview_hash || '').trim();
      if (!previewHash || String(body?.confirm || '').trim() !== `APPLY CONCEPTS ${previewHash}`) return { ok: false, code: 'CONFIRMATION_INVALID' };
      const result = concepts.apply(preview, {
        strict: true,
        terms: body?.terms,
        expectedRevision: expectedRevision(body),
        previewHash,
        sourcePendingRevision: pendingPayload.revision,
      });
      return result;
    },
  });
}

module.exports = { createMaintainerWorkbenchService, createDefaultApis, idsOf, expectedRevision };
