/**
 * cmd-min.js —— min-review 命令组（热点管线 v2 运维入口）
 *
 * 在热点管线 v2 中的位置：v2 唯一审核命令组（v1 review 命令已随 v1 删除），
 * 操作 v2 单状态轴候选层（data/news/runtime/min-candidates.json，min-store）。
 *
 *   min-review list    [--status pending|approved|discarded] [--platform ...] [--limit N] [--top N] [--store min] [--json] [--manual [--force]]
 *   min-review set     --id <id> --status pending|approved|discarded [--store min]
 *   min-review batch   --ids <id1,id2,...> --status approved [--store min]
 *   min-review transcripts [--store min]
 *   min-review feedback     [--store min]
 *   min-review refine       [--store min]
 *   min-review refine-apply --file <keyword-refine-清单.json> [--store min]
 *   min-review ai-top       [--store min]
 *   min-review top-selected --ids <id1,id2,...> [--store min]
 *   min-review top-apply    --file <top-清单.json> [--store min]
 *   min-review apply        --file <review-清单.json> [--store min]
 *
 *     - list：列出 v2 候选（含 review_status / final_score），人友好表格输出；
 *       --json 时改为输出机器可读 JSON（候选总数 / by_review_status 分布 /
 *       各候选 id/status/final_score/title），CI 审核 PR 正文聚合用。
 *       --manual 时生成"待人工审核清单"到 data/manual/review-<YYYYMMDD>.json
 *       （固定格式，供人工打开文件夹逐条审核；只含 pending、评分倒序、每条带 id）。
 *       管线 runMin 收尾也会自动生成同一清单；此处提供手动/强制入口，
 *       --force 覆盖已含人工结论的清单。
 *       --top N：按评分倒序取前 N 供人工审（R7 审核范围；缺省读 config.collection.
 *       review_top_pure_x / review_top_with_youtube，有 YouTube 候选时用后者）。
 *     - set/batch：单条/批量设置审核状态，写入 min-candidates.json（reviewed_at 由
 *       min-store 写入，不覆盖既有状态）；状态轴只允许 pending/approved/discarded。
 *     - transcripts：调 transcript-notify.notifyTranscripts 生成「待人工获取字幕」清单，
 *       写 config.manual_folder/transcript-requests-<YYYYMMDD>.json（固定格式）。
 *     - feedback：调 tool-feedback.feedbackFromSummaries，从 approved summary 提取
 *       疑似 AI 工具/概念名，与知识库比对 → 待补卡草案，写 manual_folder/
 *       tool-cards-pending-<YYYYMMDD>.json / concept-cards-pending-<YYYYMMDD>.json。
 *     - refine：调 keyword-refine.refineKeywords 生成经过 DeepSeek 跨语言归并的关键词提纯候选
 *       清单（仅 approved 原文，交人工填写 adopted_keywords，不直接改 ai_keywords），写
 *       manual_folder/keyword-refine-<YYYYMMDD>.json。
 *     - refine-apply：读取关键词清单中维护者确认的 adopted_keywords，校验必须属于
 *       candidates 后幂等追加到 news-config-v2.json 的 keywords.ai_keywords；不发布、不建 dist。
 *     - ai-top：第二阶段，AI 从 approved 候选提供 top 待选项（纯 X 10 / 有 YouTube 15，
 *       按**最后一次采集记录** last-run.json 判定是否"有 YouTube"：youtube 平台实际采到
 *       内容 items>0 → 15，否则 10），写 manual_folder/top-<YYYYMMDD>.json 供维护者筛选；
 *       每条 top_selected 默认 false。**失败一律抛错（exit 1）**：无 approved / last-run
 *       缺失 / AI 挑选失败——供 bat 一键入口用 errorlevel 判定，不静默成功。
 *     - top-selected：维护者从 ai-top 待选项确认最终显示 → top_selected 置 true；
 *       公开投影（publish）只取 approved && top_selected 的候选。
 *     - top-apply：读取 --file top 清单里 **top_selected=true** 的条目（ai-top 产物已带 id），
 *       批量置候选层 top_selected=true；false/未标不动作（对齐 pending 跳过语义），
 *       无 id 条目报错拒绝（旧产物格式）。维护者一键入口：bat/apply-top.bat
 *       （应用后自动接着跑 publish-news.js 重建前端）。
 *     - apply：读取 --file 待审清单里 approved/discarded 结论，批量写回候选层
 *       min-candidates.json（pending 跳过；条目无 id 报错拒绝旧格式）。
 *       维护者一键入口：bat/apply-review.bat（应用结论后自动接着跑 ai-top 生成 top 名单）。
 *
 * 本组不触碰旧版候选层（hotspot-candidates.json）与旧 review 命令。
 * --store min 为显式标注 v2 数据通道（缺省即 min）；其它值报错。
 */

'use strict';

const { readMinStore, writeMinStore, setReviewStatusMin, setBatchReviewStatusMin, setTopSelectedMin, MIN_REVIEW_STATUSES } = require('../min/min-store');
const { notifyTranscripts } = require('../transcripts/transcript-notify');
const { feedbackFromSummaries } = require('../feedback/tool-feedback');
const { refineKeywords } = require('../min/keyword-refine');
const { buildReviewList, loadReviewList, applyReviewList, scoreOf, suggestReview } = require('../min/review-list');
const { readJson, writeJsonAtomic } = require('../core/news-storage');
const { NEWS_FILES } = require('../../shared/paths');

/** 读 news-config-v2.json；缺失时给最小兜底（manual_folder 等字段缺省值内置于各 v2 模块）。 */
function loadV2Config() {
  try {
    return readJson(NEWS_FILES.configV2, null) || {};
  } catch {
    return {};
  }
}

/** --store 只接受 min（v2 候选层）；缺省即 min。 */
function assertStoreFlag(flags) {
  if (flags.store !== undefined && flags.store !== 'min') {
    throw new Error(`未知 --store：${flags.store}。min-review 只支持 --store min（v2 候选层 min-candidates.json）`);
  }
}

/**
 * 判定"最后一次采集是否有 YouTube 内容"（ai-top 选 top N 用）。
 * 依据采集运行记录 last-run.json（pipeline-min runMin 末尾写）的 youtube 平台
 * 实际采到内容数（items > 0）。用户拍板语义：**YouTube 实际采到内容才算有**；
 * not_run / failed / items=0 均视为无。分时采集下 X 日 top10、YouTube+X 日 top15，
 * 避免 approved 层残留的历史 YouTube 候选误触发 top15。
 * @param {object|null} lastRun readJson(NEWS_FILES.lastRun, null) 的结果
 * @returns {boolean} youtube 实际采到内容 → true
 */
function hasYouTubeInLastRun(lastRun) {
  if (!lastRun || !lastRun.collectors || !lastRun.collectors.youtube) return false;
  return Number(lastRun.collectors.youtube.items) > 0;
}

/**
 * 解析 ai-top 的 YouTube 判定与 top 数量（纯逻辑，无 I/O，便于测试）。
 * 命令层在 no_approved / no_last_run 时抛错拒绝（供 bat/apply-review.bat errorlevel
 * 判定），本函数只返回判定结果，不 throw。
 * @param {Array} approved 候选层中 review_status==='approved' 的候选
 * @param {object|null} lastRun readJson(NEWS_FILES.lastRun, null) 的结果
 * @param {object} config v2 配置（读 collection.review_top_with_youtube / review_top_pure_x）
 * @returns {{ ok: true, hasYouTube: boolean, topN: number } |
 *            { ok: false, reason: 'no_approved'|'no_last_run' }}
 */
function resolveAiTopConfig(approved, lastRun, config) {
  if (!Array.isArray(approved) || approved.length === 0) {
    return { ok: false, reason: 'no_approved' };
  }
  if (!lastRun) {
    return { ok: false, reason: 'no_last_run' };
  }
  const hasYouTube = hasYouTubeInLastRun(lastRun);
  const collection = (config && config.collection) || {};
  const topN = hasYouTube
    ? Number(collection.review_top_with_youtube) || 15
    : Number(collection.review_top_pure_x) || 10;
  return { ok: true, hasYouTube, topN };
}

/**
 * 应用 top 清单的人工选择结论（第二阶段收尾，纯逻辑，无 I/O）：
 * 读 top-<date>.json（ai-top 产物，candidates 带 id），把 **top_selected=true** 的条目
 * 批量置候选层 top_selected=true；false/未标不动作（对齐 review 清单 pending 跳过语义，
 * 幂等）。返回新 store，写盘由命令层决定。
 * @param {object} store 候选层 store（经 setTopSelectedMin 拷贝容器；候选对象浅拷贝共享，
 *                        与 review-list.applyReviewList 语义一致）
 * @param {object} list top 清单对象（kind='ai_top_candidates'，含 candidates 数组）
 * @returns {{ store, applied: number, selectedIds: string[], missing: string[], changed: number }}
 *   无 true 条目时 changed=0（不写回）；top_selected=true 但无 id → 抛错（旧产物格式）
 */
function applyTopSelectedList(store, list) {
  const candidates = (list && Array.isArray(list.candidates)) ? list.candidates : [];
  const selectedIds = [];
  const noIdSummaries = [];
  for (const entry of candidates) {
    if (!entry || entry.top_selected !== true) continue; // 只应用 true，未选中不动作
    if (entry.id == null || String(entry.id).trim() === '') {
      noIdSummaries.push(String(entry.summary || '(无摘要)').slice(0, 30));
      continue;
    }
    selectedIds.push(String(entry.id));
  }
  if (noIdSummaries.length) {
    throw new Error(`top 清单含 top_selected=true 但无 id 的条目：${noIdSummaries.join('、')}——旧产物格式，请用 min-review ai-top 重新生成带 id 的 top 清单`);
  }
  if (selectedIds.length === 0) {
    return { store, applied: 0, selectedIds, missing: [], changed: 0 };
  }
  const result = setTopSelectedMin(store, selectedIds, true);
  return { store: result.store, applied: result.updated, selectedIds, missing: result.missing, changed: result.updated };
}

/**
 * 验证关键词候选清单并把人工确认词幂等追加至内存配置（纯逻辑，无 I/O）。
 * 未知采纳词或清单结构异常均在返回新配置前抛错，调用层因此不会写盘。
 */
function applyRefineKeywords(config, list) {
  if (!list || list.kind !== 'keyword_refine_candidates' || !Array.isArray(list.candidates) || !Array.isArray(list.adopted_keywords)) {
    throw new Error('非法关键词清单：需要 kind=\'keyword_refine_candidates\'，且含 candidates 与 adopted_keywords 数组');
  }
  const candidateWords = new Set();
  for (const candidate of list.candidates) {
    if (!candidate || typeof candidate.word !== 'string' || !candidate.word.trim() || typeof candidate.category !== 'string' || !candidate.category.trim() || !['repeated', 'emerging'].includes(candidate.candidate_type) || !Number.isInteger(candidate.count) || candidate.count < 1) {
      throw new Error('关键词清单含非法 candidates 条目（需 word、category、candidate_type、count 四字段）');
    }
    const key = candidate.word.trim().toLowerCase();
    if (candidateWords.has(key)) throw new Error(`关键词清单含重复候选词：${candidate.word.trim()}`);
    candidateWords.add(key);
  }

  const adopted = [];
  const adoptedKeys = new Set();
  let duplicates = 0;
  for (const raw of list.adopted_keywords) {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('adopted_keywords 只能包含非空字符串');
    const word = raw.trim();
    const key = word.toLowerCase();
    if (!candidateWords.has(key)) throw new Error(`adopted_keywords 含不在 candidates 中的词：${word}`);
    if (adoptedKeys.has(key)) {
      duplicates += 1;
      continue;
    }
    adoptedKeys.add(key);
    adopted.push(word);
  }

  const nextConfig = { ...(config || {}), keywords: { ...((config && config.keywords) || {}) } };
  const existing = Array.isArray(nextConfig.keywords.ai_keywords) ? nextConfig.keywords.ai_keywords.slice() : [];
  const existingKeys = new Set(existing.map(word => String(word).trim().toLowerCase()));
  const added = [];
  const alreadyExists = [];
  for (const word of adopted) {
    if (existingKeys.has(word.toLowerCase())) {
      alreadyExists.push(word);
      continue;
    }
    existing.push(word);
    existingKeys.add(word.toLowerCase());
    added.push(word);
  }
  nextConfig.keywords.ai_keywords = existing;
  return { config: nextConfig, added, already_exists: alreadyExists, duplicates, changed: added.length > 0 };
}

async function minReviewCommand(action, flags = {}) {
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

    // ── --manual：生成"待人工审核清单"到 data/manual/review-<date>.json ──
    //    人友好接口（R6/R8）：不只在命令行滚动，落盘固定格式供人工打开文件夹审核。
    //    与管线 runMin 收尾自动生成同一实现（review-list.buildReviewList，带 id、
    //    只含 pending、评分倒序），这里保留手动/强制入口（--force 覆盖已含人工结论的清单）。
    if (flags.manual) {
      const result = buildReviewList(store, config, { force: Boolean(flags.force) });
      if (result.skipped) {
        console.log(`ℹ️ 待审清单已含人工审核结论（${result.file}），未覆盖。确需重新生成请加 --force。`);
        return result;
      }
      console.log(`✅ 待审清单：${result.total_pending} 条 pending → ${result.file}`);
      for (const c of result.candidates) {
        console.log(`  [${c.score === null ? '-' : c.score}] ${c.summary}`);
      }
      return result;
    }

    if (flags.json) {
      // 机器可读 JSON：main() 对 min-review 提前 return 不打印结果，这里直接输出。
      console.log(JSON.stringify({
        total: store.candidates.length,
        shown: rows.length,
        by_review_status: byReviewStatus,
        candidates: rows,
      }, null, 2));
      return { total: store.candidates.length, shown: rows.length, by_review_status: byReviewStatus, candidates: rows };
    }

    // 人友好表格
    console.log(`v2 候选层（min-candidates.json）：共 ${store.candidates.length} 条，列出 ${rows.length} 条`);
    if (rows.length === 0) {
      console.log('  （空）');
    } else {
      for (const row of rows) {
        const score = row.final_score === null ? '-' : row.final_score;
        console.log(`  [${row.review_status}] ${row.platform}  score=${score}  ${row.id}`);
        console.log(`      ${row.title}`);
      }
    }
    return { total: store.candidates.length, shown: rows.length, by_review_status: byReviewStatus, candidates: rows };
  }

  if (action === 'set') {
    if (!flags.id) throw new Error('min-review set 缺少 --id');
    if (!flags.status) throw new Error('min-review set 缺少 --status');
    const store = readMinStore();
    const result = setReviewStatusMin(store, flags.id, flags.status);
    writeMinStore(result.store, `min-review-set-${flags.id}-${Date.now()}`);
    const candidate = result.store.candidates.find(item => item.id === flags.id);
    console.log(`✅ 已设置 ${flags.id} → ${flags.status}（reviewed_at=${candidate.reviewed_at}）`);
    return { id: flags.id, status: flags.status, reviewed_at: candidate.reviewed_at, updated: result.updated };
  }

  if (action === 'batch') {
    if (!flags.ids) throw new Error('min-review batch 缺少 --ids（逗号分隔的明确 id 列表）');
    if (!flags.status) throw new Error('min-review batch 缺少 --status');
    const ids = String(flags.ids).split(',').map(id => id.trim()).filter(Boolean);
    if (!ids.length) throw new Error('min-review batch 的 --ids 为空');
    const store = readMinStore();
    const result = setBatchReviewStatusMin(store, ids, flags.status);
    if (result.updated > 0) writeMinStore(result.store, `min-review-batch-${Date.now()}`);
    const missingNote = result.missing && result.missing.length
      ? `，未命中 ${result.missing.length} 条：${result.missing.join(',')}`
      : '';
    console.log(`✅ 批量设置 ${result.updated} 条 → ${flags.status}${missingNote}`);
    return { status: flags.status, ...result, updated_at: result.store.updated_at };
  }

  if (action === 'transcripts') {
    const result = notifyTranscripts(undefined, config);
    console.log(`✅ 字幕清单：${result.requested.length} 条待人工获取 → ${result.file}`);
    for (const entry of result.requested) {
      console.log(`  ${entry.title} | ${entry.url} | ${entry.score === null ? '-' : entry.score}`);
    }
    if (result.requested.length === 0) console.log('   （候选层无 YouTube 候选，返回空清单）');
    return result;
  }

  if (action === 'feedback') {
    const result = await feedbackFromSummaries(undefined, config);
    const folder = config.manual_folder || 'data/manual';
    console.log(`✅ 反哺比对：工具已存在 ${result.toolsFound.length} / 待补 ${result.toolsPending.length}；概念已存在 ${result.conceptsFound.length} / 待补 ${result.conceptsPending.length}`);
    console.log(`   待补卡写 ${folder}/tool-cards-pending-<YYYYMMDD>.json、concept-cards-pending-<YYYYMMDD>.json`);
    for (const card of result.toolsPending) console.log(`  [待补工具] ${card.name}（${card.mentioned_in_summaries} 次提及）`);
    for (const card of result.conceptsPending) console.log(`  [待补概念] ${card.term}`);
    if (result.toolsPending.length === 0 && result.conceptsPending.length === 0) {
      console.log('   （approved 候选无 summary 或提取结果均已在知识库，无待补卡）');
    }
    return result;
  }

  if (action === 'refine') {
    const result = await refineKeywords(undefined, config);
    console.log(`✅ 关键词提纯候选：approved 原文 ${result.approvedCount} 条 → AI 归并 ${result.candidates.length} 个关键词 → ${result.file}`);
    for (const candidate of result.candidates) {
      console.log(`  [${candidate.candidate_type}] ${candidate.word}（${candidate.category}，${candidate.count} 次）`);
    }
    return result;
  }

  if (action === 'refine-apply') {
    if (!flags.file) throw new Error('min-review refine-apply 缺少 --file（关键词清单路径，如 data/manual/keyword-refine-20260808.json）');
    const list = readJson(flags.file, null);
    const result = applyRefineKeywords(config, list);
    if (result.changed) writeJsonAtomic(NEWS_FILES.configV2, result.config, `min-review-refine-apply-${Date.now()}`);
    console.log(`✅ 已应用关键词清单 → news-config-v2.json：新增 ${result.added.length} / 已存在 ${result.already_exists.length} / 重复采纳 ${result.duplicates}`);
    if (!result.changed) console.log('   （无新关键词需要写回；未执行配置写入）');
    return result;
  }

  // ── ai-top：第二阶段，AI 从 approved 候选提供 top 待选项给维护者 ──
  //    人工审核（第一阶段）后，approved 候选喂给 DeepSeek 语义挑选最值得公开的
  //    top 10（纯 X）/ 15（有 YouTube）条作为**待选项**（R7 人工审 top 量），
  //    写 data/manual/top-<date>.json 供维护者从中选出最终公开的 3~5/3~8 条。
  //    AI 提供的是候选池，不是最终结论；最终条数由维护者从待选项中挑。
  //    "有 YouTube"按**最后一次采集记录**（last-run.json）判定：youtube 平台实际
  //    采到内容（items > 0）→ top15；否则 top10（分时采集下 X 日 top10，避免
  //    approved 层残留的历史 YouTube 候选误触发 top15）。last-run 缺失报错拒绝、
  //    不静默回退——异常状态显式暴露（用户拍板）。
  if (action === 'ai-top') {
    const path = require('path');
    const fs = require('fs');
    const { writeJsonAtomic } = require('../core/news-storage');
    const { selectTopWithDeepSeek } = require('../classify/llm-provider');
    const store = readMinStore();
    const approved = store.candidates.filter(c => c && c.review_status === 'approved');
    // 判定"有 YouTube"：读最后一次采集记录（runMin 末尾写）。解析出 no_approved /
    // no_last_run 时抛错拒绝（不静默回退 approved 层判断，供 bat errorlevel 判定）。
    const lastRun = readJson(NEWS_FILES.lastRun, null);
    const resolved = resolveAiTopConfig(approved, lastRun, config);
    if (!resolved.ok) {
      throw new Error(resolved.reason === 'no_approved'
        ? '无 approved 候选（维护者尚未审核）。先运行 min-review list --manual 审核，用 min-review batch/set 标记 approved。'
        : '缺少 last-run.json（最后一次采集记录）。请先运行 node scripts/build-news.js 产生采集记录后再试。');
    }
    const { hasYouTube, topN } = resolved;
    // 喂给 AI 的输入：id + score + summary（精简，控制 token 成本）
    const aiInput = approved
      .map(c => ({ id: c.id, score: scoreOf(c), summary: String(c.summary || c.title || '(无标题)').trim().slice(0, 120) }))
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    const result = await selectTopWithDeepSeek(aiInput, { min: Math.min(topN, approved.length), max: Math.min(topN, approved.length) });
    if (!result.ok) {
      throw new Error(`AI 挑选失败：${result.error}（${result.code}）。可稍后重试。`);
    }
    // 按 AI 返回的 ids 提取完整 approved 候选，按 AI 顺序输出；
    // AI 可能少给（漏 id / 输出截断），不足 topN 时从剩余 approved 按评分倒序补齐到 topN，
    // 保证待选项数量固定（纯 X 10 / 有 YouTube 15），供维护者从中选最终公开的少数条。
    const byId = new Map(approved.map(c => [c.id, c]));
    const aiOrdered = (result.ids || []).map(id => byId.get(id)).filter(Boolean);
    const rest = approved
      .filter(c => !aiOrdered.some(chosen => chosen.id === c.id))
      .sort((a, b) => (scoreOf(b) ?? -Infinity) - (scoreOf(a) ?? -Infinity));
    const selected = aiOrdered.concat(rest).slice(0, topN).map(c => {
        const zh = c.localizations && c.localizations.zh;
        // 第二阶段：具体内容 = 完整写入（优先汉化完整描述，完整不截断）；
        // 原文参考 original 用 http 链接放最下面；若原文是中文则不需要 original。
        const localizedDescription = (zh && (zh.description || zh.title)) || '';
        const originalText = String(c.description || '').trim();
        const isChinese = /[一-鿿]/.test(originalText);
        return {
          id: c.id,   // 候选层 id：供 bat/apply-top.bat 用 top-apply 直连定位（对齐 review 清单带 id 模式）
          score: scoreOf(c),
          summary: String(c.summary || c.title || '(无标题)').trim(),
          suggestion: suggestReview(c),
          // 第二阶段：top_selected 默认 false（AI 提供待选项，维护者确认显示后置 true）
          top_selected: false,
          // 具体内容：完整写入（汉化完整描述，非 http 格式）
          description: localizedDescription || originalText,
          // 原文参考：http 链接放最下面；原文是中文则省略
          ...(isChinese ? {} : { original: c.url || '' }),
          author_name: c.author_name || '',
        };
      });
    const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const manualFolder = (config && config.manual_folder) || 'data/manual';
    const file = path.join(manualFolder, `top-${dateKey}.json`);
    const payload = {
      schema_version: 1,
      kind: 'ai_top_candidates',
      generated_at: new Date().toISOString(),
      date: dateKey,
      approved_count: approved.length,
      target_top_n: topN,
      ai_selected_count: selected.length,
      note: 'AI 从人工 approved 候选中挑选的 top 待选项（按最后一次采集记录判定：有 YouTube 内容 15 / 纯 X 10），供维护者筛选。' +
            '请把要显示在前端的 3~5（有 YouTube 日 3~8）条 top_selected 置为 true；' +
            '确认后双击 bat/apply-top.bat（应用选择 + 重建公开投影，显示到前端）。',
      candidates: selected,
      human_lines: selected.map(c =>
        `[${c.score === null ? '-' : c.score}] ${c.summary}\n` +
        `    作者：${c.author_name}\n` +
        `    内容：${c.description}\n` +
        `    建议：${c.suggestion}` +
        (c.original ? `\n    原文：${c.original}` : '')
      ),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, payload, 'min-review-ai-top');
    console.log(`✅ AI 从 ${approved.length} 条 approved 中选出 ${selected.length} 条 top → ${file}`);
    for (const c of selected) {
      console.log(`  [${c.score === null ? '-' : c.score}] ${c.summary.slice(0, 60)}（${c.author_name}）`);
    }
    return { ok: true, file, approved_count: approved.length, ai_selected_count: selected.length, candidates: selected };
  }

  // ── top-selected：第二阶段，维护者从 AI 待选项确认最终显示 → top_selected 置 true ──
  //    ai-top 提供 top 10/15 待选项后，维护者从中选 3~5/3~8 条标记 top_selected=true，
  //    公开投影（buildDailyProjection → publish）只取 approved && top_selected 的候选。
  if (action === 'top-selected') {
    if (!flags.ids) throw new Error('min-review top-selected 缺少 --ids（逗号分隔的待显示 id 列表）');
    const ids = String(flags.ids).split(',').map(id => id.trim()).filter(Boolean);
    if (!ids.length) throw new Error('min-review top-selected 的 --ids 为空');
    const store = readMinStore();
    const result = setTopSelectedMin(store, ids, true);
    if (result.updated > 0) writeMinStore(result.store, `min-review-top-selected-${Date.now()}`);
    const missingNote = result.missing && result.missing.length
      ? `，未命中 ${result.missing.length} 条：${result.missing.join(',')}`
      : '';
    console.log(`✅ 已标记 ${result.updated} 条为显示选中（top_selected=true）${missingNote}`);
    console.log(`   下一步：node scripts/publish-news.js 重建公开投影（只取 approved && top_selected）`);
    return { status: 'top_selected', ...result, updated_at: result.store.updated_at };
  }

  // ── top-apply：读 top 清单里 top_selected=true → 批量置候选层 top_selected=true ──
  //    第二阶段收尾：维护者在 ai-top 产物（top-<date>.json）标 top_selected=true 后，
  //    bat/apply-top.bat 调用本命令应用选择，接着跑 publish-news.js 重建前端。
  //    对齐 apply 语义：只应用 true（false/未标不动作，幂等）；无 id 条目报错拒绝旧产物。
  if (action === 'top-apply') {
    if (!flags.file) throw new Error('min-review top-apply 缺少 --file（top 清单路径，如 data/manual/top-20260808.json）');
    const store = readMinStore();
    const list = readJson(flags.file, null);
    if (!list || list.kind !== 'ai_top_candidates' || !Array.isArray(list.candidates)) {
      throw new Error(`非法 top 清单：${flags.file}（需要 kind='ai_top_candidates' 且含 candidates 数组）`);
    }
    const result = applyTopSelectedList(store, list);
    if (result.changed > 0) writeMinStore(result.store, `min-review-top-apply-${Date.now()}`);
    console.log(`✅ 已应用 top 清单 → min-candidates.json：${result.applied} 条 top_selected=true`);
    if (result.missing && result.missing.length) {
      console.log(`   ⚠️ 未命中候选 ${result.missing.length} 条：${result.missing.join('、')}`);
    }
    if (result.changed === 0) {
      console.log('   （清单中无 top_selected=true 条目，无需写回）');
    }
    console.log('   下一步：node scripts/publish-news.js 重建公开投影（bat/apply-top.bat 已自动执行）');
    return result;
  }

  // ── apply：应用人工审核结论（待审清单 → 候选层）──
  //    维护者编辑 review-<date>.json 的 review_status 后，读取 approved/discarded
  //    批量写回 min-candidates.json（pending 跳过；无 id 条目报错拒绝旧格式）。
  //    一键入口：bat/apply-review.bat（自动定位最新清单）。
  if (action === 'apply') {
    if (!flags.file) throw new Error('min-review apply 缺少 --file（待审清单路径，如 data/manual/review-20260808.json）');
    const store = readMinStore();
    const list = loadReviewList(flags.file);
    const result = applyReviewList(store, list);
    if (result.changed > 0) writeMinStore(result.store, `min-review-apply-${Date.now()}`);
    console.log(`✅ 已应用人工审核结论 → min-candidates.json：approved ${result.applied.approved} / discarded ${result.applied.discarded}`);
    console.log(`   跳过 pending ${result.skipped} 条${result.noop ? `，状态未变化 ${result.noop} 条` : ''}`);
    if (result.invalid) {
      console.log(`   ⚠️ 非法审核状态 ${result.invalid} 条：${result.invalidIds.join('、')}`);
    }
    if (result.missing.length) {
      console.log(`   ⚠️ 未命中候选 ${result.missing.length} 条：${result.missing.join('、')}`);
    }
    if (result.changed === 0) {
      console.log('   （无新结论需要写回）');
    }
    return result;
  }

  throw new Error(`未知 min-review 命令: ${action}。支持：list | set | batch | transcripts | feedback | refine | refine-apply | ai-top | top-selected | top-apply | apply`);
}

module.exports = {
  minReviewCommand,
  scoreOf,
  suggestReview,
  loadV2Config,
  assertStoreFlag,
  hasYouTubeInLastRun,
  resolveAiTopConfig,
  applyTopSelectedList,
  applyRefineKeywords,
};
