/**
 * cmd-min.js —— min-review 命令组（热点管线 v2 运维入口）
 *
 * 在热点管线 v2 中的位置：v2 唯一审核命令组（v1 review 命令已随 v1 删除），
 * 操作 v2 单状态轴候选层（data/news/runtime/min-candidates.json，min-store）。
 *
 *   min-review list    [--status pending|approved|discarded] [--platform ...] [--limit N] [--top N] [--store min] [--json] [--manual]
 *   min-review set     --id <id> --status pending|approved|discarded [--store min]
 *   min-review batch   --ids <id1,id2,...> --status approved [--store min]
 *   min-review transcripts [--store min]
 *   min-review feedback     [--store min]
 *   min-review refine       [--store min]
 *   min-review ai-top       [--store min]
 *   min-review top-selected --ids <id1,id2,...> [--store min]
 *
 *     - list：列出 v2 候选（含 review_status / final_score），人友好表格输出；
 *       --json 时改为输出机器可读 JSON（候选总数 / by_review_status 分布 /
 *       各候选 id/status/final_score/title），CI 审核 PR 正文聚合用。
 *       --manual 时生成"待人工审核 top 清单"到 data/manual/review-<YYYYMMDD>.json
 *       （固定格式，供人工打开文件夹逐条审核；pending 按评分倒序取 top N，缺省
 *       读 review_top_pure_x / review_top_with_youtube）。
 *       --top N：按评分倒序取前 N 供人工审（R7 审核范围；缺省读 config.collection.
 *       review_top_pure_x / review_top_with_youtube，有 YouTube 候选时用后者）。
 *     - set/batch：单条/批量设置审核状态，写入 min-candidates.json（reviewed_at 由
 *       min-store 写入，不覆盖既有状态）；状态轴只允许 pending/approved/discarded。
 *     - transcripts：调 transcript-notify.notifyTranscripts 生成「待人工获取字幕」清单，
 *       写 config.manual_folder/transcript-requests-<YYYYMMDD>.json（固定格式）。
 *     - feedback：调 tool-feedback.feedbackFromSummaries，从 approved summary 提取
 *       疑似 AI 工具/概念名，与知识库比对 → 待补卡草案，写 manual_folder/
 *       tool-cards-pending-<YYYYMMDD>.json / concept-cards-pending-<YYYYMMDD>.json。
 *     - refine：调 keyword-refine.refineKeywords 生成关键词提纯候选清单（交人工确认，
 *       不直接改 ai_keywords），写 manual_folder/keyword-refine-<YYYYMMDD>.json。
 *     - ai-top：第二阶段，AI 从 approved 候选提供 top 待选项（纯 X 10 / 有 YouTube 15），
 *       写 manual_folder/top-<YYYYMMDD>.json 供维护者筛选；每条 top_selected 默认 false。
 *     - top-selected：维护者从 ai-top 待选项确认最终显示 → top_selected 置 true；
 *       公开投影（publish）只取 approved && top_selected 的候选。
 *
 * 本组不触碰旧版候选层（hotspot-candidates.json）与旧 review 命令。
 * --store min 为显式标注 v2 数据通道（缺省即 min）；其它值报错。
 */

'use strict';

const { readMinStore, writeMinStore, setReviewStatusMin, setBatchReviewStatusMin, setTopSelectedMin, MIN_REVIEW_STATUSES } = require('../min/min-store');
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

/**
 * 给维护者的审核建议（每条具体判断，参考性质，不替代人工确认）。
 * 基于 content_type + 标题特征规则：学习打卡/个人日志 → discarded；
 * AI 产品发布/工具评测 → approved；内容截断的「/1」「Folks」开头的推文线程
 * 需展开看（标记 see_more）；其余给中性建议。用于 --manual 待审清单。
 * @param {object} candidate 统一内容模型条目
 * @returns {string} 建议文案
 */
function suggestReview(candidate) {
  const title = String(candidate.title || '').trim().replace(/\s+/g, ' ');
  const ct = candidate.content_type || 'unclassified';
  // 学习打卡 / 个人开发日志 / 进度记录（价值低，建议 discarded）
  if (/#(100DaysOfCode|100daysofcode|LearnInPublic|BuildInPublic)/i.test(title)
      || /Day\s*\d+\/100|Day\s*\d+\s*of|day\d+/i.test(title)) {
    return '学习打卡/个人日志，建议 discarded';
  }
  // 个人使用体验/成本心得（价值低，建议 discarded）
  if (/cost me|costs? me|only cost|\$|dollars?|试了|试过|体验心得|my setup|setup better|here's my/i.test(title)) {
    return '个人使用/成本体验，建议 discarded';
  }
  // 非 AI 核心或明显偏离（NFT/股票/无关讨论）
  if (/nft|solana|crypto|bitcoin|price|股票|炒股/i.test(title)) {
    return '偏离 AI 核心（金融/NFT），建议 discarded';
  }
  // 推文线程（1/ ...）——内容可能被截断，建议展开看正文再定
  if (/^\d+\/\s/.test(title) || /^Folks,/.test(title)) {
    return '推文线程（内容可能截断），建议展开正文核验后定';
  }
  // 类型倾向
  if (ct === 'ai_product' || ct === 'ai_tool') {
    return 'AI 产品/工具，建议 approved';
  }
  if (ct === 'ai_technology') {
    return 'AI 技术/研究，建议 approved（如无重大争议）';
  }
  if (ct === 'ai_industry') {
    return 'AI 行业事件，建议 approved';
  }
  if (ct === 'ai_concept') {
    return 'AI 概念，建议看内容后定（学习类多为日志）';
  }
  return '人工判断：是否值得收录';
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

    // ── --manual：生成"待人工审核 top 清单"到 data/manual/review-<date>.json ──
    //    人友好接口（R6/R8）：不只在命令行滚动，落盘固定格式供人工打开文件夹审核。
    //    与 transcripts/refine 清单一致，含每条候选的审核建议入口。
    if (flags.manual) {
      const path = require('path');
      const fs = require('fs');
      const { writeJsonAtomic } = require('../core/news-storage');
      const { toPublicItemMin } = require('../min/min-store');
      const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const manualFolder = (config && config.manual_folder) || 'data/manual';
      const file = path.join(manualFolder, `review-${dateKey}.json`);
      // 待审候选：全部 pending（按评分倒序排列，供维护者逐条审核）
      // 第一阶段字段精简：只给评分 / 内容概要 / 建议三项（description/original 在第二阶段才有）
      const reviewList = store.candidates
        .filter(c => c && c.review_status === 'pending')
        .sort((a, b) => (scoreOf(b) ?? -Infinity) - (scoreOf(a) ?? -Infinity))
        .map(c => {
          // 内容概要：优先 AI 中文摘要（c.summary），其次汉化标题（localizations.zh.title），
          // 再兜底原文标题——维护者要中文（汉化在前置阶段已完成）
          const zhTitle = (c.localizations && c.localizations.zh && c.localizations.zh.title) || '';
          const summaryText = String(c.summary || zhTitle || c.title || '(无标题)')
            .trim().replace(/\s+/g, ' ').slice(0, 80);
          const suggestion = suggestReview(c);
          return {
            score: scoreOf(c),
            summary: summaryText,
            suggestion,
            // 当前审核状态（第一阶段：维护者据此判断 pending 待审 / approved 已通过）
            review_status: c.review_status || 'pending',
          };
        });
      const payload = {
        schema_version: 1,
        kind: 'review_candidates',
        generated_at: new Date().toISOString(),
        date: dateKey,
        total_pending: byReviewStatus.pending || 0,
        note: '待人工审核清单：请逐条设置 review_status（pending/approved/discarded）。' +
              '批准：node scripts/news-cli.js min-review batch --ids <id1,id2> --status approved；' +
              '剔除：--status discarded。approved 才进公开投影。',
        candidates: reviewList,
        // 人友好：每行一条，供人工扫描
        human_lines: reviewList.map(c =>
          `[${c.score === null ? '-' : c.score}] ${c.summary}\n    建议：${c.suggestion}`
        ),
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, payload, 'min-review-manual');
      console.log(`✅ 待审清单：${reviewList.length} 条 pending → ${file}`);
      for (const c of reviewList) {
        console.log(`  [${c.score === null ? '-' : c.score}] ${c.summary}`);
      }
      return { file, total_pending: payload.total_pending, candidates: reviewList };
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
    console.log(`✅ 关键词提纯候选：高频 ${result.highFreqCandidates.length} 条、新兴 ${result.emergingCandidates.length} 条 → ${result.file}`);
    for (const candidate of result.highFreqCandidates) {
      console.log(`  [高频] ${candidate.word}（原文出现 ${candidate.frequency} 次 / ${candidate.source_count} 条候选）`);
    }
    for (const candidate of result.emergingCandidates) {
      console.log(`  [新兴] ${candidate.word}`);
    }
    return result;
  }

  // ── ai-top：第二阶段，AI 从 approved 候选提供 top 待选项给维护者 ──
  //    人工审核（第一阶段）后，approved 候选喂给 DeepSeek 语义挑选最值得公开的
  //    top 10（纯 X）/ 15（有 YouTube）条作为**待选项**（R7 人工审 top 量），
  //    写 data/manual/top-<date>.json 供维护者从中选出最终公开的 3~5/3~8 条。
  //    AI 提供的是候选池，不是最终结论；最终条数由维护者从待选项中挑。
  if (action === 'ai-top') {
    const path = require('path');
    const fs = require('fs');
    const { writeJsonAtomic } = require('../core/news-storage');
    const { selectTopWithDeepSeek } = require('../classify/llm-provider');
    const store = readMinStore();
    const approved = store.candidates.filter(c => c && c.review_status === 'approved');
    if (!approved.length) {
      console.log('⚠️ 无 approved 候选（维护者尚未审核）。先运行 min-review list --manual 审核，用 min-review batch/set 标记 approved。');
      return { ok: false, reason: 'no_approved' };
    }
    // 待选项数量（R7 人工审 top 量）：纯 X → review_top_pure_x（10）；有 YouTube → review_top_with_youtube（15）
    const collection = config.collection || {};
    const hasYouTube = approved.some(c => c.platform === 'youtube');
    const topN = hasYouTube
      ? Number(collection.review_top_with_youtube) || 15
      : Number(collection.review_top_pure_x) || 10;
    // 喂给 AI 的输入：id + score + summary（精简，控制 token 成本）
    const aiInput = approved
      .map(c => ({ id: c.id, score: scoreOf(c), summary: String(c.summary || c.title || '(无标题)').trim().slice(0, 120) }))
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    const result = await selectTopWithDeepSeek(aiInput, { min: Math.min(topN, approved.length), max: Math.min(topN, approved.length) });
    if (!result.ok) {
      console.log(`⚠️ AI 挑选失败：${result.error}（${result.code}）。可稍后重试或改纯评分排序。`);
      return { ok: false, reason: result.code, error: result.error };
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
      note: 'AI 从人工 approved 候选中挑选的 top 待选项（纯 X 10 / 有 YouTube 15），供维护者筛选。' +
            '请从下面选出要显示在前端的 3~5（有 YouTube 日 3~8）条；' +
            '确认后这些条目 review_status 已为 approved，publish 即可重建公开投影。',
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

  throw new Error(`未知 min-review 命令: ${action}。支持：list | set | batch | transcripts | feedback | refine | ai-top | top-selected`);
}

module.exports = { minReviewCommand, scoreOf, suggestReview, loadV2Config, assertStoreFlag };
