/**
 * scripts/news-cli.js — 新闻采集管线 CLI 入口（薄包装）
 *
 * 双重角色：直接运行时为 CLI（node scripts/news-cli.js ...）；被 require 时
 * re-export src/news/cli/news-cli 的全部导出（含 min-review 命令组），供其它命令文件复用。
 *
 * 组装职责：加载 .env（密钥只经环境变量注入）、注入目录查询面（deps.catalogApi）、
 * 把 min-review 的结构化结果格式化为人友好输出。
 */
'use strict';

// 先加载 .env，再加载实现与装配。
const { loadDotEnv } = require('../src/shared/env');
loadDotEnv();

const implementation = require('../src/news/cli/news-cli');
const { createNewsCatalogApi } = require('../src/maintenance/workbench/news-domain');
const { CATALOG_GENERATOR_FILES, CONCEPT_FILES } = require('../src/shared/paths');

// ── min-review 人类可读输出（与既有 CLI 文案一致） ──────────────

function printMinReview(action, flags, result) {
  if (action === 'list' && !flags.manual && !flags.json) {
    console.log(`v2 候选层（min-candidates.json）：共 ${result.total} 条，列出 ${result.shown} 条`);
    if (result.candidates.length === 0) {
      console.log('  （空）');
    } else {
      for (const row of result.candidates) {
        const score = row.final_score === null ? '-' : row.final_score;
        console.log(`  [${row.review_status}] ${row.platform}  score=${score}  ${row.id}`);
        console.log(`      ${row.title}`);
      }
    }
    return;
  }
  if (action === 'list' && flags.manual) {
    if (result.skipped) {
      console.log(`ℹ️ 待审清单已存在且无新 pending（${result.file}），未覆盖。确需重建请加 --force。`);
      return;
    }
    console.log(`✅ 待审清单：${result.total_pending} 条 pending → ${result.file}`);
    for (const c of result.candidates) {
      console.log(`  [${c.score === null ? '-' : c.score}] ${c.summary}`);
    }
    return;
  }
  if (action === 'list' && flags.json) {
    // 机器可读 JSON：stdout 只输出 JSON（CI 重定向消费，见 collect-news.yml）
    console.log(JSON.stringify({
      total: result.total,
      shown: result.shown,
      by_review_status: result.by_review_status,
      candidates: result.candidates,
    }, null, 2));
    return;
  }
  if (action === 'set') {
    console.log(`✅ 已设置 ${result.id} → ${result.status}（reviewed_at=${result.reviewed_at || '未变更'}）`);
    return;
  }
  if (action === 'batch') {
    const missingNote = result.missing && result.missing.length
      ? `，未命中 ${result.missing.length} 条：${result.missing.join(',')}`
      : '';
    console.log(`✅ 批量设置 ${result.updated} 条 → ${result.status}${missingNote}`);
    return;
  }
  if (action === 'enrich') {
    if (result.enriched === null) {
      console.log('✅ 所有候选均已完成初审、摘要与本地化，无需处理。');
      return;
    }
    const stats = result.stats;
    console.log('🤖 本地 Bonsai 初审与翻译 (enrich)：');
    console.log(`   候选总数: ${stats.total} 条 | 待初审: ${stats.review} | 待摘要: ${stats.summary} | 待翻译: ${stats.localize}`);
    const flagNotes = `${flags.limit != null ? ` | 限制条数: ${Number(flags.limit)}` : ''}`;
    console.log(`   批次大小: ${flags.batch_size ? Number(flags.batch_size) : 30} | 并发: ${result.concurrency}${flagNotes}${flags.force ? ' | [强制重做]' : ''}${flags.dry_run ? ' | [dry-run 模拟]' : ''}`);
    for (const entry of result.batchLog || []) {
      console.log(`   [批次 ${entry.batchIndex}/${entry.totalBatches}] 完成 ${entry.batchSize} 条 (审核: ${entry.reviewed}, 摘要: ${entry.summarized}, 翻译: ${entry.localized})`);
    }
    const enriched = result.enriched;
    console.log(`✅ 本地 Enrich 完成：共处理 ${enriched.processed} 条，批次: ${enriched.batches}`);
    if (!flags.skip_review) {
      console.log(`   初审: ${enriched.reviewed} 条 (自动通过: ${enriched.autoApproved}, 自动丢弃: ${enriched.autoDiscarded}, 留待人工: ${enriched.pending})`);
    }
    if (!flags.skip_summary) {
      console.log(`   摘要: ${enriched.summarized} 条`);
    }
    if (!flags.skip_localize) {
      console.log(`   翻译: ${enriched.localized} 条`);
    }
    const repaired = result.repaired;
    if (repaired) {
      console.log(`🔧 检测到 ${result.repair_total} 条残缺项（待审/建议: ${result.stats.review}, 摘要: ${result.stats.summary}, 翻译: ${result.stats.localize}），自动衔接双通道自愈修复...`);
      console.log(`✅ 双通道自愈修复完成：修复审核 ${repaired.repairedReview} 条，摘要 ${repaired.repairedSummary} 条，翻译 ${repaired.repairedLocalize} 条，剩余残缺: ${repaired.remainingIncomplete}`);
    }
    if (result.review_list) {
      console.log(`✅ 已同步安全更新待审清单：${result.review_list.file}（待人工审核: ${result.review_list.total_pending} 条，保留人工已审状态）`);
    } else if (result.review_list_skipped) {
      console.log('   （已跳过刷新待审清单 --no-refresh-review-list）');
    }
    return;
  }
  if (action === 'repair') {
    console.log('🔧 热点候选双通道自愈修复 (repair)：');
    console.log(`   残缺总数: ${result.stats.total} 条 | 待修复审核: ${result.stats.review} | 待修复摘要: ${result.stats.summary} | 待修复翻译: ${result.stats.localize}`);
    if (result.repaired === null) {
      console.log('✅ 所有候选数据完整，无需修复。');
      return;
    }
    const repaired = result.repaired;
    console.log(`✅ 双通道自愈修复完成：修复审核 ${repaired.repairedReview} 条，摘要 ${repaired.repairedSummary} 条，翻译 ${repaired.repairedLocalize} 条，剩余残缺: ${repaired.remainingIncomplete}`);
    if (result.review_list) {
      console.log(`✅ 已同步安全更新待审清单：${result.review_list.file}（待人工审核: ${result.review_list.total_pending} 条，保留人工已审状态）`);
    } else if (result.review_list_skipped) {
      console.log('   （已跳过刷新待审清单 --no-refresh-review-list）');
    }
    return;
  }
  if (action === 'transcripts') {
    console.log(`✅ 字幕清单：${result.requested.length} 条待人工获取 → ${result.file}`);
    for (const entry of result.requested) {
      console.log(`  ${entry.title} | ${entry.url} | ${entry.score === null ? '-' : entry.score}`);
    }
    if (result.requested.length === 0) console.log('   （候选层无 YouTube 候选，返回空清单）');
    return;
  }
  if (action === 'feedback') {
    console.log(`✅ 反哺比对：工具已存在 ${result.toolsFound.length} / 待补 ${result.toolsPending.length}；概念已存在 ${result.conceptsFound.length} / 待补 ${result.conceptsPending.length}`);
    console.log(`   待补卡写 ${CATALOG_GENERATOR_FILES.pendingTools}、${CONCEPT_FILES.pendingConcepts}`);
    for (const card of result.toolsPending) console.log(`  [待补工具] ${card.name}（${card.mentioned_in_summaries} 次提及）`);
    for (const card of result.conceptsPending) console.log(`  [待补概念] ${card.term}`);
    if (result.toolsPending.length === 0 && result.conceptsPending.length === 0) {
      console.log('   （approved 候选无 summary 或提取结果均已在知识库，无待补卡）');
    }
    return;
  }
  if (action === 'refine') {
    console.log(`✅ 关键词提纯候选：覆盖全部 ${result.approvedCount} 条 approved（全局词频，规则候选 ${result.ruleCandidates} 个）→ AI 归并 ${result.candidates.length} 个关键词 → ${result.file}`);
    for (const candidate of result.candidates) {
      console.log(`  [${candidate.candidate_type}] ${candidate.word}（${candidate.category}，${candidate.count} 次）`);
    }
    return;
  }
  if (action === 'refine-apply') {
    console.log(`✅ 已应用关键词清单 → news-config-v2.json：新增 ${result.added.length} / 已存在 ${result.already_exists.length} / 重复采纳 ${result.duplicates}`);
    if (!result.changed) console.log('   （无新关键词需要写回；未执行配置写入）');
    return;
  }
  if (action === 'ai-top') {
    console.log(`✅ AI 从 ${result.approved_count} 条 approved 中选出 ${result.ai_selected_count} 条 top → ${result.file}`);
    console.log(`   输入范围：评分前 ${result.ai_top_input_max} 条 approved（共 ${result.approved_count} 条）`);
    for (const c of result.candidates) {
      console.log(`  [${c.score === null ? '-' : c.score}] ${c.summary.slice(0, 60)}（${c.author_name}）`);
    }
    return;
  }
  if (action === 'top-selected') {
    const missingNote = result.missing && result.missing.length
      ? `，未命中 ${result.missing.length} 条：${result.missing.join(',')}`
      : '';
    const notApprovedNote = result.not_approved && result.not_approved.length
      ? `，非 approved ${result.not_approved.length} 条：${result.not_approved.join(',')}`
      : '';
    console.log(`✅ 已${result.selected ? '标记' : '取消'} ${result.updated} 条（top_selected=${result.selected}）${missingNote}${notApprovedNote}`);
    console.log('   本操作仅更新候选层，不发布公开投影。');
    return;
  }
  if (action === 'top-apply') {
    console.log(`✅ 已应用 top 清单 → min-candidates.json：${result.applied} 条 top_selected=true`);
    if (result.missing && result.missing.length) {
      console.log(`   ⚠️ 未命中候选 ${result.missing.length} 条：${result.missing.join('、')}`);
    }
    if (result.changed === 0) {
      console.log('   （清单中无 top_selected=true 条目，无需写回）');
    }
    console.log('   下一步：node scripts/publish-news.js 重建公开投影（bat/apply-top.bat 已自动执行）');
    return;
  }
  if (action === 'apply') {
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
    return;
  }
  if (action === 'archive') {
    if (result.empty) {
      console.log('ℹ️ 当前候选层为空，无需归档。');
    } else if (!result.skipped) {
      console.log(`✅ 已归档 ${result.archived} 条候选：${result.batch_at}`);
      console.log('   当前候选层已清空。');
    }
    console.log(result.removed.length
      ? `   已重置当日人工清单 ${result.removed.length} 个：${result.removed.join('、')}`
      : '   无待重置的人工清单。');
    return;
  }
}

// require.main === module：仅作为主入口直接执行时才分发命令；被引用时不产生副作用。
if (require.main === module) {
  const parsed = implementation.parseArgs(process.argv.slice(2));
  implementation.main(process.argv.slice(2), { catalogApi: createNewsCatalogApi() })
    .then(result => {
      const [group, action] = parsed.positional;
      if (group === 'min-review') printMinReview(action, parsed.flags, result);
      else console.log(JSON.stringify(result, null, 2));
    })
    .catch(error => {
      console.error(`❌ ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = implementation;
