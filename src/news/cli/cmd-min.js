/**
 * cmd-min.js —— min-review 命令组（热点管线 v2 运维入口）
 *
 * 在热点管线 v2 中的位置：与 cmd-registry 的 review 命令平行，但操作的是
 * v2 单状态轴候选层（data/news/runtime/min-candidates.json，min-store）。
 *
 *   min-review list    [--status pending|approved|discarded] [--platform ...] [--limit N] [--store min]
 *   min-review set     --id <id> --status pending|approved|discarded [--store min]
 *   min-review batch   --ids <id1,id2,...> --status approved [--store min]
 *   min-review transcripts [--store min]
 *   min-review feedback     [--store min]
 *   min-review refine       [--store min]
 *
 *     - list：列出 v2 候选（含 review_status / final_score），人友好表格输出。
 *     - set/batch：单条/批量设置审核状态，写入 min-candidates.json（reviewed_at 由
 *       min-store 写入，不覆盖既有状态）；状态轴只允许 pending/approved/discarded。
 *     - transcripts：调 transcript-notify.notifyTranscripts 生成「待人工获取字幕」清单，
 *       写 config.manual_folder/transcript-requests-<YYYYMMDD>.json（固定格式）。
 *     - feedback：调 tool-feedback.feedbackFromSummaries，从 approved summary 提取
 *       疑似 AI 工具/概念名，与知识库比对 → 待补卡草案，写 manual_folder/
 *       tool-cards-pending-<YYYYMMDD>.json / concept-cards-pending-<YYYYMMDD>.json。
 *     - refine：调 keyword-refine.refineKeywords 生成关键词提纯候选清单（交人工确认，
 *       不直接改 ai_keywords），写 manual_folder/keyword-refine-<YYYYMMDD>.json。
 *
 * 本组不触碰旧版候选层（hotspot-candidates.json）与旧 review 命令。
 * --store min 为显式标注 v2 数据通道（缺省即 min）；其它值报错。
 */

'use strict';

const { readMinStore, writeMinStore, setReviewStatusMin, setBatchReviewStatusMin, MIN_REVIEW_STATUSES } = require('../min/min-store');
const { notifyTranscripts } = require('../transcripts/transcript-notify');
const { feedbackFromSummaries } = require('../feedback/tool-feedback');
const { refineKeywords } = require('../min/keyword-refine');
const { readJson } = require('../core/news-storage');
const { NEWS_FILES } = require('../../shared/paths');

/** 排序/展示分数：final_score 优先，其次 hot_score；皆无 → null。 */
function scoreOf(candidate) {
  if (candidate == null) return null;
  if (Number.isFinite(candidate.final_score)) return candidate.final_score;
  if (Number.isFinite(candidate.hot_score)) return candidate.hot_score;
  return null;
}

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

    const rows = candidates.map(candidate => ({
      id: candidate.id,
      platform: candidate.platform,
      content_type: candidate.content_type || 'unclassified',
      final_score: scoreOf(candidate),
      review_status: candidate.review_status,
      reviewed_at: candidate.reviewed_at || null,
      title: String(candidate.title || '(无标题)'),
    }));

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
    return { total: store.candidates.length, shown: rows.length, candidates: rows };
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
    console.log(`✅ 关键词提纯候选：高频 ${result.highFreqCandidates.length} 条、新兴 ${result.emergingCandidates.length} 条 → ${result.file}`);
    for (const candidate of result.highFreqCandidates) {
      console.log(`  [高频] ${candidate.word}（原文出现 ${candidate.frequency} 次 / ${candidate.source_count} 条候选）`);
    }
    for (const candidate of result.emergingCandidates) {
      console.log(`  [新兴] ${candidate.word}`);
    }
    return result;
  }

  throw new Error(`未知 min-review 命令: ${action}。支持：list | set | batch | transcripts | feedback | refine`);
}

module.exports = { minReviewCommand, scoreOf, loadV2Config, assertStoreFlag };
