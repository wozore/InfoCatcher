'use strict';

const path = require('path');
const fs = require('fs');
const minStore = require('../../news/min/min-store');
const minActions = require('../../news/min/min-review-actions');
const { buildDailyProjection } = require('../../news/min/daily-projection');
const { enrichHotspotProjection, buildProjectionInputs } = require('../../news/pipeline/projection');
const { filterProjectionByWindow } = require('../../news/core/news-public-gate');
const { minReviewCommand } = require('../../news/cli/cmd-min');
const { revisionOfConfig, commitKeywordActions, commitKeywordExclusions } = require('../../news/min/keyword-actions');
const { uploadTranscript, summarizeTranscripts } = require('../../news/min/transcript-workflow');
const { catalog } = require('../../catalog/interface');
const { createCostLedger } = require('../../catalog/core/index');
const { loadGeneratorConfig } = require('../../catalog/draft/index');
const { generateRss } = require('../../content/generate-rss');
const { readJson, writeJsonAtomic } = require('../../shared/json-store');
const { DIRS, NEWS_FILES, CATALOG_FILES } = require('../../shared/paths');
const { loadDotEnv } = require('../../shared/env');

function requireMutation(name, value) {
  if (typeof value !== 'function') throw new Error(`${name} mutation API 不可用`);
  return value;
}

/**
 * news 域目录查询适配器（maintenance 装配层拥有，组合根注入给 news 模块）。
 * news 域自身不 require catalog 域；本文件是唯一把目录数据翻译成 news 查询面的位置。
 * 形状：{ listToolCards, listVendorCards, readGlossary, readScenes, createEntityLedger, resolveEntityModel }
 */
function createNewsCatalogApi() {
  return {
    listToolCards: () => {
      const result = catalog({ area: 'tool-card', operation: 'list' });
      return result.ok ? result.data : [];
    },
    listVendorCards: () => {
      const result = catalog({ area: 'vendor-card', operation: 'list' });
      return result.ok ? result.data : [];
    },
    readGlossary: () => {
      try { return readJson(CATALOG_FILES.glossary, []); } catch { return []; }
    },
    readScenes: () => {
      try {
        const data = readJson(CATALOG_FILES.scenes, { scenes: [] });
        return Array.isArray(data) ? data : (data.scenes || []);
      } catch { return []; }
    },
    createEntityLedger: () => createCostLedger({ responses_calls: 1, synthesis_calls: 0 }),
    resolveEntityModel: () => {
      try { return loadGeneratorConfig().model; } catch { return undefined; }
    },
  };
}

// 公开投影的目录输入在进程内构建一次（与原 projection 模块级缓存同语义）。
let cachedProjectionInputs = null;

function publishNewsProjectionDirect(catalogApi = null) {
  if (cachedProjectionInputs === null || catalogApi) {
    cachedProjectionInputs = buildProjectionInputs(catalogApi || createNewsCatalogApi());
  }
  const config = readJson(NEWS_FILES.configV2, null);
  const store = minStore.readMinStore();
  const projection = buildDailyProjection(store, config, { now: new Date() });
  enrichHotspotProjection(projection.items, cachedProjectionInputs.toolUrlIndex, cachedProjectionInputs.relatedLexicon);
  const output = {
    schema_version: 1,
    generated_at: projection.generated_at,
    items: projection.items,
    coverage: { status: 'published_min', source: 'min-candidates.json', generated_at: projection.generated_at },
  };
  const filtered = filterProjectionByWindow(output, { config, now: Date.now() });
  if (filtered.items.length === 0) {
    return { dry_run: false, items: 0, skipped_empty: true };
  }
  writeJsonAtomic(NEWS_FILES.hotspots, filtered, `publish-min-${Date.now()}`);
  generateRss();
  return { dry_run: false, items: filtered.items.length };
}

function unresolvedKeywordCount(news) {
  const config = news.readConfig() || {};
  const list = news.readKeywords() || {};
  const adopted = new Set(Array.isArray(config?.keywords?.ai_keywords) ? config.keywords.ai_keywords.map(word => String(word).trim().toLowerCase()) : []);
  const discarded = new Set(Array.isArray(config?.keywords?.excluded_keywords) ? config.keywords.excluded_keywords.map(word => String(word).trim().toLowerCase()) : []);
  return (Array.isArray(list.candidates) ? list.candidates : []).filter(item => {
    const key = String(item?.word || '').trim().toLowerCase();
    return key && !adopted.has(key) && !discarded.has(key);
  }).length;
}

function createDefaultNewsApi(options = {}) {
  const keywordFile = options.keywordFile || path.join(DIRS.manual, 'keyword-refine.json');
  const catalogApi = options.catalogApi || createNewsCatalogApi();
  return {
    readStore: () => minStore.readMinStore(),
    revisionOfStore: store => requireMutation('revisionOfMinStore', minStore.revisionOfMinStore)(store),
    commit: (mutation, commitOptions) => requireMutation('commitMinStoreMutation', minStore.commitMinStoreMutation)(mutation, commitOptions),
    reviewMutation: (store, ids, decision, mutationOptions) => requireMutation('reviewPendingCandidates', minActions.reviewPendingCandidates)(store, ids, decision, mutationOptions),
    topMutation: (store, ids, selected, mutationOptions) => requireMutation('setApprovedTopSelectedMin', minActions.setApprovedTopSelectedMin)(store, ids, selected, mutationOptions),
    readKeywords: () => readJson(keywordFile, null),
    readConfig: () => readJson(NEWS_FILES.configV2, {}),
    revisionOfConfig: config => revisionOfConfig(config),
    commitKeywords: (list, commitOptions) => commitKeywordActions(list, commitOptions),
    commitKeywordExclusions: (words, commitOptions) => commitKeywordExclusions(words, commitOptions),
    uploadTranscript: (payload, commitOptions) => uploadTranscript(payload.candidate_id, payload.filename, payload.content_base64, commitOptions),
    summarizeTranscripts: (ids, commitOptions) => summarizeTranscripts(ids, commitOptions),
    generateKeywords: async () => {
      loadDotEnv();
      return minReviewCommand('refine', {});
    },
    generateTop: async () => {
      loadDotEnv();
      return minReviewCommand('ai-top', {});
    },
    repairNews: async (flags = {}) => {
      loadDotEnv();
      return minReviewCommand('repair', flags);
    },
    publish: () => publishNewsProjectionDirect(catalogApi),
  };
}

function handleNewsReview({ store, news, options, newsProjection }) {
  const allPending = store().candidates.filter(item => item.review_status === 'pending');
  const unreviewed = allPending.filter(item => {
    const hasL1 = Boolean(item.l1_review && item.l1_review.verdict != null);
    const hasAdvice = Boolean(item.ai_advice?.verdict);
    return !hasL1 && !hasAdvice;
  });
  if (unreviewed.length > 0) {
    if (options.autoRepair !== false && typeof news.repairNews === 'function') {
      Promise.resolve().then(() => news.repairNews({ limit: unreviewed.length })).catch(() => {});
    }
    return {
      revision: news.revisionOfStore(store()),
      status: 'enriching',
      message: `本地 Bonsai 正在进行 AI 初审分流与汉化（已链接外部 API 双通道自愈兜底，请稍候... 待初审: ${unreviewed.length} / 待审总数: ${allPending.length}）`,
      unreviewed_count: unreviewed.length,
      items: [],
    };
  }
  return newsProjection(allPending);
}

function handleReviewNews(body, news, { idsOf, expectedRevision }) {
  const ids = idsOf(body?.ids);
  const revision = expectedRevision(body);
  const decision = body?.decision;
  if (!['approved', 'discarded'].includes(decision)) throw new Error('decision 必须是 approved 或 discarded');
  const result = news.commit(current => news.reviewMutation(current, ids, decision, { expectedRevision: revision }), { expectedRevision: revision, runId: 'maintainer-workbench-news-review' });
  return { updated: result.updated, missing: result.missing || [], not_pending: result.not_pending || [], revision: result.revision };
}

function handleKeywords(news) {
  const config = news.readConfig();
  const list = news.readKeywords();
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
}

function handleApplyKeywords(body, news, { idsOf, expectedRevision }) {
  const ids = idsOf(body?.ids);
  const revision = expectedRevision(body);
  const list = news.readKeywords();
  if (!list || !Array.isArray(list.candidates)) throw new Error('关键词候选清单不存在或无效');
  const selected = new Set(ids);
  const adopted_keywords = list.candidates.filter(item => selected.has(String(item.id || item.word || ''))).map(item => item.word);
  if (adopted_keywords.length !== selected.size) throw new Error('存在未知关键词 id');
  return news.commitKeywords({ ...list, adopted_keywords }, { expectedRevision: revision, runId: 'maintainer-workbench-keywords' });
}

function handleDiscardKeywords(body, news, { idsOf, expectedRevision }) {
  const words = idsOf(body?.ids);
  const revision = expectedRevision(body);
  return news.commitKeywordExclusions(words, { expectedRevision: revision, runId: 'maintainer-workbench-keywords-discard' });
}

function handleTop(store, news, options) {
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
    } else {
      note = 'Top 待选池结构无效，请重新运行 min-review ai-top';
    }
  } else {
    note = '尚未生成 Top 待选池：先运行 min-review ai-top（纯 X 10 / 有 YouTube 15），再从池中选 3~5/3~8 条。';
  }
  return { revision: news.revisionOfStore(current), items, note };
}

function handleApplyTop(body, news, { idsOf, expectedRevision }) {
  const ids = idsOf(body?.ids);
  const revision = expectedRevision(body);
  if (typeof body?.selected !== 'boolean') throw new Error('selected 必须显式为 boolean');
  const result = news.commit(current => news.topMutation(current, ids, body.selected, { expectedRevision: revision }), { expectedRevision: revision, runId: 'maintainer-workbench-top' });
  return { updated: result.updated, missing: result.missing || [], not_approved: result.not_approved || [], revision: result.revision };
}

function handleUploadTranscript(body, news, expectedRevision) {
  const revision = expectedRevision(body);
  if (typeof body?.candidate_id !== 'string' || !body.candidate_id.trim()) throw new Error('candidate_id 必填');
  if (typeof body?.filename !== 'string' || !body.filename.trim()) throw new Error('字幕文件名必填');
  if (typeof body?.content_base64 !== 'string' || !body.content_base64) throw new Error('字幕文件内容必填');
  return news.uploadTranscript(body, { expectedRevision: revision });
}

function handleSummarizeTranscripts(body, news, { idsOf, expectedRevision }, runtime = {}) {
  const ids = idsOf(body?.ids);
  const revision = expectedRevision(body);
  const confirmCost = body?.confirm_cost === true;
  return news.summarizeTranscripts(ids, {
    expectedRevision: revision,
    confirmCost,
    signal: runtime.signal,
  });
}

module.exports = {
  createNewsCatalogApi,
  publishNewsProjectionDirect,
  unresolvedKeywordCount,
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
};
