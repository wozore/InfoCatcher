/**
 * cmd-min.js —— min-review 命令组编排（热点管线 v2 候选层运维）
 *
 * 操作 v2 单状态轴候选层（data/news/runtime/min-candidates.json，min-store）。
 * 本文件是纯编排：解析 flags → 调 v2 模块 → 返回结构化结果；人类可读输出
 * 由 scripts/news-cli.js 壳格式化打印。目录数据经 deps.catalogApi 注入
 * （{ listToolCards, readGlossary, createEntityLedger, resolveEntityModel }，
 * 组合根构造），本文件不直读任何 catalog 域模块。
 *
 * 命令与语义（维护者入口：维护者工作台、bat/after-first-review.bat、bat/archive-min.bat）：
 *   list        候选列表（--json 机器可读；--manual 生成待审清单；--top N 评分截取）
 *   set/batch   按明确 id 把 pending 候选置 approved/discarded（expected revision 门禁）
 *   enrich      本地 Bonsai 初审/摘要/本地化分批编排，完成后默认衔接双通道自愈修复
 *   repair      双通道自愈修复残缺数据
 *   transcripts 生成"待人工获取字幕"清单
 *   feedback    approved 摘要实体反哺待补卡（默认 LLM 提取，失败降级正则）
 *   refine      分批覆盖全部 approved 生成本地模型关键词提纯清单
 *   refine-apply 校验 adopted_keywords 后原子幂等追加配置
 *   ai-top      AI 从 approved 候选挑 top 待选项（last-run 判定 YouTube；失败一律抛错）
 *   top-selected/top-apply  维护者确认显示条目（仅更新候选层，不发布）
 *   apply       应用人工审核清单结论写回候选层
 *   archive     归档候选为轻量历史、清空候选层并重置当日人工清单
 *
 * --store min 为显式标注 v2 数据通道（缺省即 min）；其它值报错。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  readMinStore,
  writeMinStore,
  revisionOfMinStore,
  commitMinStoreMutation,
  MIN_REVIEW_STATUSES,
} = require('../min/min-store');
const { reviewPendingCandidates, setApprovedTopSelectedMin } = require('../min/min-review-actions');
const { readMinHistory, writeMinHistory, archiveMinStore } = require('../min/min-history');
const { notifyTranscripts } = require('../transcripts/transcript-notify');
const { feedbackFromSummaries, extractEntitiesDefault } = require('../feedback/tool-feedback');
const { extractEntitiesWithLlm } = require('../feedback/llm-entity-extract');
const { refineKeywords } = require('../min/keyword-refine');
const { commitKeywordActions, revisionOfConfig } = require('../min/keyword-actions');
const {
  buildReviewList,
  loadReviewList,
  applyReviewList,
  applyTopSelectedList,
  scoreOf,
} = require('../min/review-list');
const { runEnrichFlow, runRepairFlow } = require('./min-review-flows');
const {
  MAX_AI_TOP_INPUT,
  buildAiTopPayload,
  resolveAiTopConfig,
  selectTopCandidates,
  topCandidatesForAi,
} = require('../min/ai-top');
const { selectTopItems } = require('../classify/llm-provider');
const { readJson, writeJsonAtomic } = require('../../shared/json-store');
const { getProvider, apiKeyForProvider } = require('../../shared/providers');
const { NEWS_FILES } = require('../../shared/paths');

/** 读 news-config-v2.json；缺失时给最小兜底（manual_folder 等字段缺省值内置于各 v2 模块）。 */
function loadV2Config() {
  try {
    return readJson(NEWS_FILES.configV2, null) || {};
  } catch {
    return {};
  }
}

/**
 * 每日收尾归档后重置的 data/manual 新闻人工清单（文件名固定，去掉日期后缀）。
 * 注意：工具/概念待补卡已移入 data/manual/tools/、data/manual/concepts/（路径见 paths.js
 * CATALOG_GENERATOR_FILES.pendingTools / CONCEPT_FILES.pendingConcepts），由 batch/apply
 * 消费，不随归档清理，故不在此白名单内。
 */
const MANUAL_LIST_FILES = [
  'review.json',
  'transcript-requests.json',
  'keyword-refine.json',
  'top.json',
];

/** 删除当日人工清单（白名单内已存在的文件）。归档成功后才调用；任一删除失败整体抛错。 */
function removeManualLists(config) {
  const folder = (config && config.manual_folder) || 'data/manual';
  const removed = [];
  for (const name of MANUAL_LIST_FILES) {
    const file = path.join(folder, name);
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed.push(name);
      }
    } catch (err) {
      throw new Error(`删除人工清单失败：${file}（${err.message}）`);
    }
  }
  return removed;
}

/** --store 只接受 min（v2 候选层）；缺省即 min。 */
function assertStoreFlag(flags) {
  if (flags.store !== undefined && flags.store !== 'min') {
    throw new Error(`未知 --store：${flags.store}。min-review 只支持 --store min（v2 候选层 min-candidates.json）`);
  }
}

/** CLI 未显式传 revision 时，绑定本次读到的版本；显式值可拒绝陈旧人工清单。 */
function expectedMinRevision(flags, store) {
  return flags.expected_revision || revisionOfMinStore(store);
}

function expectedConfigRevision(flags, config) {
  return flags.expected_revision || revisionOfConfig(config);
}

/** 反哺 LLM 提取的启用判定：配置开关放行且 zhipu/deepseek 任一 provider 配置了密钥。 */
function hasExternalProviderKey() {
  return ['zhipu', 'deepseek'].some(name => Boolean(apiKeyForProvider(getProvider(name))));
}

async function minReviewCommand(action, flags = {}, deps = {}) {
  assertStoreFlag(flags);
  const config = loadV2Config();

  if (action === 'list') {
    const store = readMinStore();
    let candidates = store.candidates.slice();
    if (flags.status) {
      if (!MIN_REVIEW_STATUSES.includes(flags.status)) {
        throw new Error(`非法审核状态：${flags.status}。合法值：${MIN_REVIEW_STATUSES.join(' / ')}`);
      }
      candidates = candidates.filter(candidate => candidate.review_status === flags.status);
    }
    if (flags.platform) candidates = candidates.filter(candidate => candidate.platform === flags.platform);
    const limit = Number(flags.limit);
    if (Number.isFinite(limit) && limit > 0) candidates = candidates.slice(0, limit);

    // ── top 一批筛选（R7 人工审核范围）：按评分倒序取前 N 供人工审 ──
    //     `--top N` 显式指定；缺省读 config.collection.review_top_pure_x /
    //     review_top_with_youtube（有 YouTube 候选时用后者）。只对 pending 有意义。
    if (flags.top) {
      const topN = Number(flags.top);
      if (!Number.isFinite(topN) || topN <= 0) throw new Error(`min-review list --top 需为正整数，收到：${flags.top}`);
      const collection = config.collection || {};
      const hasYouTube = candidates.some(c => c.platform === 'youtube');
      const defaultTop = hasYouTube
        ? Number(collection.review_top_with_youtube) || 15
        : Number(collection.review_top_pure_x) || 10;
      const n = Math.min(topN, defaultTop);
      candidates = candidates
        .sort((a, b) => (scoreOf(b) ?? -Infinity) - (scoreOf(a) ?? -Infinity))
        .slice(0, n);
    }

    const rows = candidates.map(candidate => ({
      id: candidate.id,
      platform: candidate.platform,
      content_type: candidate.content_type || 'unclassified',
      final_score: scoreOf(candidate),
      review_status: candidate.review_status,
      reviewed_at: candidate.reviewed_at || null,
      title: String(candidate.title || '(无标题)'),
    }));

    // 候选层整体按 review_status 分布（CI 审核 PR 正文聚合用，不受 --status/--top 过滤影响）。
    const byReviewStatus = {};
    for (const candidate of store.candidates) {
      const status = candidate.review_status || 'pending';
      byReviewStatus[status] = (byReviewStatus[status] || 0) + 1;
    }

    // ── --manual：生成"待人工审核清单"到 data/manual/review.json ──
    //    人友好接口（R6/R8）：落盘固定格式供人工打开文件夹审核。
    //    与管线 runMin 收尾自动生成同一实现（review-list.buildReviewList，带 id、
    //    只含 pending、评分倒序），这里保留手动/强制入口（--force 覆盖已含人工结论的清单）。
    if (flags.manual) {
      const result = buildReviewList(store, config, { force: Boolean(flags.force) });
      return { ...result, manual: true };
    }

    return { total: store.candidates.length, shown: rows.length, by_review_status: byReviewStatus, candidates: rows };
  }

  if (action === 'set') {
    if (!flags.id) throw new Error('min-review set 缺少 --id');
    if (!flags.status) throw new Error('min-review set 缺少 --status');
    const store = readMinStore();
    const expectedRevision = expectedMinRevision(flags, store);
    const result = commitMinStoreMutation(
      current => reviewPendingCandidates(current, [flags.id], flags.status, { expectedRevision }),
      { expectedRevision, runId: `min-review-set-${flags.id}-${Date.now()}` },
    );
    if (result.missing.length) throw new Error(`候选不存在：${flags.id}`);
    if (result.not_pending.length) throw new Error(`候选不是 pending，拒绝审核：${flags.id}`);
    const candidate = result.store.candidates.find(item => item.id === flags.id);
    return { id: flags.id, status: flags.status, reviewed_at: candidate && candidate.reviewed_at, ...result };
  }

  if (action === 'batch') {
    if (!flags.ids) throw new Error('min-review batch 缺少 --ids（逗号分隔的明确 id 列表）');
    if (!flags.status) throw new Error('min-review batch 缺少 --status');
    const ids = String(flags.ids).split(',').map(id => id.trim()).filter(Boolean);
    if (!ids.length) throw new Error('min-review batch 的 --ids 为空');
    const store = readMinStore();
    const expectedRevision = expectedMinRevision(flags, store);
    const result = commitMinStoreMutation(
      current => reviewPendingCandidates(current, ids, flags.status, { expectedRevision }),
      { expectedRevision, runId: `min-review-batch-${Date.now()}` },
    );
    return { status: flags.status, ...result, updated_at: result.store.updated_at };
  }

  if (action === 'enrich') {
    assertStoreFlag(flags);
    const store = readMinStore();
    return runEnrichFlow(store, loadV2Config(), flags);
  }

  if (action === 'repair') {
    assertStoreFlag(flags);
    const store = readMinStore();
    return runRepairFlow(store, loadV2Config(), flags);
  }

  if (action === 'transcripts') {
    return notifyTranscripts(undefined, config);
  }

  if (action === 'feedback') {
    // LLM 提取：feedback.llm_extract !== false 且配置了外部 provider key（ZHIPU/DEEPSEEK）
    // 时接入（提取默认走本地 Bonsai，LLM 失败降级正则，宁多勿漏，不阻断反哺）。
    const feedback = (config && config.feedback) || {};
    const options = { catalogApi: deps.catalogApi };
    if (feedback.llm_extract !== false && hasExternalProviderKey()) {
      options.llmExtract = async text => {
        try {
          return await extractEntitiesWithLlm(text, { catalogApi: deps.catalogApi, model: feedback.llm_model });
        } catch {
          return extractEntitiesDefault(text);
        }
      };
    }
    return feedbackFromSummaries(undefined, config, options);
  }

  if (action === 'refine') {
    return refineKeywords(undefined, config, { timeoutMs: Number(flags.timeout_ms) || undefined });
  }

  if (action === 'refine-apply') {
    if (!flags.file) throw new Error('min-review refine-apply 缺少 --file（关键词清单路径，如 data/manual/keyword-refine.json）');
    const list = readJson(flags.file, null);
    const expectedRevision = expectedConfigRevision(flags, config);
    const result = commitKeywordActions(list, {
      config,
      expectedRevision,
      runId: `min-review-refine-apply-${Date.now()}`,
    });
    return { ...result, file: flags.file };
  }

  // ── ai-top：第二阶段，AI 从 approved 候选提供 top 待选项给维护者 ──
  //    人工审核（第一阶段）后，approved 候选喂给本地模型语义挑选最值得公开的
  //    top 10（纯 X）/ 15（有 YouTube）条作为**待选项**（R7 人工审 top 量），
  //    写 data/manual/top.json 供维护者从中选出最终公开的 3~5/3~8 条。
  //    AI 提供的是候选池，不是最终结论；最终条数由维护者从待选项中挑。
  //    "有 YouTube"按**最后一次采集记录**（last-run.json）判定：youtube 平台实际
  //    采到内容（items > 0）→ top15；否则 top10。last-run 缺失报错拒绝、
  //    不静默回退——异常状态显式暴露（用户拍板）。
  if (action === 'ai-top') {
    const store = readMinStore();
    const approved = store.candidates.filter(c => c && c.review_status === 'approved');
    const lastRun = readJson(NEWS_FILES.lastRun, null);
    const resolved = resolveAiTopConfig(approved, lastRun, config);
    if (!resolved.ok) {
      throw new Error(resolved.reason === 'no_approved'
        ? '无 approved 候选（维护者尚未审核）。先运行 min-review list --manual 审核，用 min-review batch/set 标记 approved。'
        : '缺少 last-run.json（最后一次采集记录）。请先运行 node scripts/build-news.js 产生采集记录后再试。');
    }
    const { topN } = resolved;
    const collection = config.collection || {};
    const aiTopInputMax = Number(collection.ai_top_input_max) || MAX_AI_TOP_INPUT;
    // 仅让 AI 读取按评分排序的有限候选池，避免历史 approved 大量累积时超出本地模型上下文。
    const aiInput = topCandidatesForAi(approved, aiTopInputMax);
    const result = await selectTopItems(aiInput, { min: Math.min(topN, approved.length), max: Math.min(topN, approved.length) });
    if (!result.ok) {
      throw new Error(`AI 挑选失败：${result.error}（${result.code}）。可稍后重试。`);
    }
    const selected = selectTopCandidates(approved, result.ids, topN);
    const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const manualFolder = (config && config.manual_folder) || 'data/manual';
    const file = path.join(manualFolder, 'top.json');
    const payload = buildAiTopPayload({ approved, selected, aiInput, aiTopInputMax, topN, manualFolderDateKey: dateKey });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, payload, 'min-review-ai-top');
    return { ok: true, file, approved_count: approved.length, ai_input_count: aiInput.length, ai_top_input_max: aiTopInputMax, target_top_n: topN, ai_selected_count: selected.length, candidates: selected };
  }

  // ── top-selected：第二阶段，维护者从 AI 待选项确认最终显示 → top_selected 置 true ──
  //    公开投影（buildDailyProjection → publish）只取 approved && top_selected 的候选。
  if (action === 'top-selected') {
    if (!flags.ids) throw new Error('min-review top-selected 缺少 --ids（逗号分隔的待显示 id 列表）');
    const ids = String(flags.ids).split(',').map(id => id.trim()).filter(Boolean);
    if (!ids.length) throw new Error('min-review top-selected 的 --ids 为空');
    let selected;
    if (flags.selected === undefined || flags.selected === true) selected = true;
    else if (flags.selected === false || flags.selected === 'false') selected = false;
    else if (flags.selected === 'true') selected = true;
    else throw new Error('min-review top-selected 的 --selected 需为 true 或 false');
    const store = readMinStore();
    const expectedRevision = expectedMinRevision(flags, store);
    const result = commitMinStoreMutation(
      current => setApprovedTopSelectedMin(current, ids, selected, { expectedRevision }),
      { expectedRevision, runId: `min-review-top-selected-${Date.now()}` },
    );
    return { status: 'top_selected', selected, ...result, updated_at: result.store.updated_at };
  }

  // ── top-apply：读 top 清单里 top_selected=true → 批量置候选层 top_selected=true ──
  //    第二阶段收尾：维护者在 ai-top 产物（top.json）标 top_selected=true 后，
  //    bat/apply-top.bat 调用本命令应用选择，接着跑 publish-news.js 重建前端。
  //    对齐 apply 语义：只应用 true（false/未标不动作，幂等）；无 id 条目报错拒绝。
  if (action === 'top-apply') {
    if (!flags.file) throw new Error('min-review top-apply 缺少 --file（top 清单路径，如 data/manual/top.json）');
    const store = readMinStore();
    const list = readJson(flags.file, null);
    if (!list || list.kind !== 'ai_top_candidates' || !Array.isArray(list.candidates)) {
      throw new Error(`非法 top 清单：${flags.file}（需要 kind='ai_top_candidates' 且含 candidates 数组）`);
    }
    const expectedRevision = expectedMinRevision(flags, store);
    const result = commitMinStoreMutation(
      current => applyTopSelectedList(current, list, { requireApproved: true, expectedRevision }),
      { expectedRevision, runId: `min-review-top-apply-${Date.now()}` },
    );
    return { ...result, file: flags.file };
  }

  // ── archive：维护者确认当日审核/收尾完成后，归档、清空候选并重置当日人工清单 ──
  //    唯一入口：bat/archive-min.bat（带人工确认）。执行顺序：先写轻量历史、再清空候选，
  //    都成功后才删除 data/manual/ 下的当日人工清单（每天收尾重置一次；候选为空时也重置清单）。
  if (action === 'archive') {
    const store = readMinStore();
    const candidates = Array.isArray(store.candidates) ? store.candidates : [];
    let archived = 0;
    let batchAt = null;
    if (candidates.length > 0) {
      const history = readMinHistory();
      const result = archiveMinStore(store, history, new Date());
      if (!result.skipped) {
        const runId = `min-review-archive-${Date.now()}`;
        writeMinHistory(result.history, runId);
        writeMinStore(result.store, runId);
        archived = result.archived;
        batchAt = result.batch_at;
      }
    }
    // 归档/清空成功后重置当日人工清单（历史写入或候选清空失败会抛错，不会走到这里）。
    const removed = removeManualLists(config);
    return { archived, batch_at: batchAt, cleared: archived > 0, removed, skipped: archived === 0, empty: candidates.length === 0 };
  }

  // ── apply：维护者编辑 review.json 的 review_status 后，读取 approved/discarded
  //    批量写回 min-candidates.json（pending 跳过；无 id 条目报错拒绝）。
  //    一键入口：bat/apply-review.bat（自动定位最新清单）。
  if (action === 'apply') {
    if (!flags.file) throw new Error('min-review apply 缺少 --file（待审清单路径，如 data/manual/review.json）');
    const store = readMinStore();
    const list = loadReviewList(flags.file);
    const expectedRevision = expectedMinRevision(flags, store);
    const result = commitMinStoreMutation(
      current => applyReviewList(current, list),
      { expectedRevision, runId: `min-review-apply-${Date.now()}` },
    );
    return { ...result, file: flags.file };
  }

  throw new Error(`未知 min-review 命令: ${action}。支持：list | set | batch | enrich | repair | transcripts | feedback | refine | refine-apply | ai-top | top-selected | top-apply | apply | archive`);
}

module.exports = {
  minReviewCommand,
  loadV2Config,
  removeManualLists,
  MANUAL_LIST_FILES,
};
