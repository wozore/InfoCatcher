/**
 * cmd-registry.js —— registry / review / legacy 命令组（自 news-cli.js 拆分，行为不变）
 *
 *   registry prune   [--apply] [--retention-days <n>]
 *     （默认 dry-run 只预览将裁剪的记录数；--apply 才实际裁剪并归档到
 *       news-registry-pruned.json（含 run_id/规则/时间 + 记录全文，可回滚）；
 *       裁剪依据 last_seen_at 超 retention_days 天（默认取 news-config.json
 *       的 registry_retention_days=270，与采集回溯窗口一致）；
 *       build-news 每轮结束也会自动执行同等裁剪）
 *
 *   review list    [--status pending|approved|held|discarded] [--ai-verdict approve|hold|discard] [--platform ...] [--limit N]
 *   review summary
 *   review set     --id <id> --status pending|approved|held|discarded [--reason ...] [--reviewer ...]
 *   review batch   --ids <id1,id2,...> --status approved [--reason ...] [--reviewer ...]
 *   review apply-ai [--verdicts discard,hold] [--min-confidence N] [--dry-run]
 *   review log     [--candidate-id <id>] [--action ...] [--limit N]
 *     （set 单条设置审核状态；batch 只处理显式列出的 ids，不支持隐式「全部」；
 *       ai_processing_status 未 completed 时禁止设为 approved；
 *       每次流转写入 reviewer / reviewed_at / from_status / candidate_version，决策 70；
 *       每次流转同时追加到追加式审核事件日志 review-events.json（决策 70：只追加、不改写历史），
 *       review log 用于查看历史流转记录；
 *       --reviewer 缺省回退到 GITHUB_ACTOR / USER / cli；
 *       --ai-verdict 按 AI 审核建议（content-reviewer 的 ai_review.verdict）筛选待审队列；
 *       apply-ai 把候选上已生成的 AI 建议应用到 review_status（discard/hold，永不 approve；
 *       confidence 低于 --min-confidence 或候选非 pending 的跳过），默认 dry-run 只预览；
 *       非 dry-run 才实际落盘并逐条写审核日志，reviewer='ai_review'）
 *
 *   legacy import   [--dry-run]
 *   legacy status
 *     （import 把旧 hotspots.json 导入内部候选层，标记 legacy 并以 pending
 *       进入待审核流程，不自动公开；只导入候选层中尚不存在的 id；
 *       --dry-run 只打印将导入的条数，不写文件；
 *       导入后通过 review set/batch --status approved 逐条/批量审核，
 *       再运行 publish-news.js 重建公开投影，决策 64/59）
 *
 * 完整 CLI 帮助见 news-cli.js 顶部。
 */

'use strict';

const { readJson } = require('../core/news-storage');
const { createRegistry, pruneRegistry } = require('../core/news-registry');
const {
  REVIEW_STATUSES,
  readCandidateStore,
  writeCandidateStore,
  setReviewStatus,
  setBatchReviewStatus,
  reviewSummary,
  importLegacyHotspots,
  legacySummary,
} = require('../core/news-candidates');
const {
  recordReviewTransition,
  readReviewEventLog,
  appendReviewEvent,
  reviewEventFromCandidate,
  writeReviewEventLog,
} = require('../core/news-review-events');
const { confirmContentType } = require('../classify/content-classifier');
const { applyAiReviewVerdicts } = require('../classify/content-reviewer');
const { NEWS_FILES } = require('../../shared/paths');
const { FILES, save } = require('./cmd-sources');
const { optionalNumber, resolveReviewer } = require('./cmd-ops');

// ── 命令实现 ──────────────────────────────────────────────

/**
 * registry prune —— N-P2 裁剪超期 Registry 记录（以 last_seen_at 起算，保留
 * registry_retention_days 天）。默认 --dry-run 只预览不修改；--apply 才实际裁剪并
 * 归档（归档批次先写，再写裁剪后的 registry，与 build 同顺序：归档失败则不落盘）。
 * --retention-days <n> 可临时覆盖阈值（默认取 news-config.json 配置，缺省 270）。
 */
function registryCommand(action, flags) {
  if (action !== 'prune') throw new Error(`未知 registry 命令: ${action}`);
  const registry = readJson(FILES.registry, null);
  if (!registry) return { status: 'no_registry', dry_run: true, retention_days: null };
  const config = readJson(FILES.config, null);
  const retentionDays = flags.retention_days !== undefined
    ? Number(flags.retention_days)
    : config?.collection?.registry_retention_days ?? 270;
  const dryRun = !flags.apply;
  const now = new Date().toISOString();
  const runId = `cli-prune-${Date.now()}`;
  const index = createRegistry(registry);
  const result = pruneRegistry(index, { now, retentionDays, dryRun, runId });
  if (!dryRun && result.pruned_count > 0) {
    const archive = readJson(FILES.registryPruned, { schema_version: 1, prunes: [] });
    archive.prunes ||= [];
    archive.prunes.push({
      run_id: runId,
      pruned_at: now,
      retention_days: retentionDays,
      count: result.pruned_count,
      records: result.pruned,
    });
    save(FILES.registryPruned, archive, 'registry-prune');
    save(FILES.registry, index.registry, 'registry-prune');
  }
  return {
    status: dryRun ? 'dry_run' : (result.pruned_count ? 'pruned' : 'nothing_to_prune'),
    dry_run: dryRun,
    pruned_count: result.pruned_count,
    retention_days: retentionDays,
    oldest_kept_last_seen_at: result.stats.oldest_kept_last_seen_at,
  };
}

// ── review 命令组：热点审核状态管理（B16 决策 46/48/50/55/56/57/69）─────

function reviewCommand(action, flags) {
  const store = readCandidateStore();

  if (action === 'summary') return reviewSummary(store);

  if (action === 'list') {
    let candidates = store.candidates;
    if (flags.status) {
      if (!REVIEW_STATUSES.includes(flags.status)) throw new Error(`非法审核状态：${flags.status}`);
      candidates = candidates.filter(candidate => candidate.review_status === flags.status);
    }
    // content-reviewer：按 AI 审核建议（ai_review.verdict）筛选待审队列
    if (flags.ai_verdict) {
      if (!['approve', 'hold', 'discard'].includes(flags.ai_verdict)) {
        throw new Error(`非法 AI 审核建议：${flags.ai_verdict}。合法值：approve / hold / discard`);
      }
      candidates = candidates.filter(candidate => candidate.ai_review?.verdict === flags.ai_verdict);
    }
    if (flags.platform) candidates = candidates.filter(candidate => candidate.platform === flags.platform);
    const limit = optionalNumber(flags, 'limit');
    if (limit !== undefined && limit > 0) candidates = candidates.slice(0, limit);
    return {
      total: store.candidates.length,
      shown: candidates.length,
      candidates: candidates.map(candidate => ({
        id: candidate.id,
        platform: candidate.platform,
        source_type: candidate.source_type,
        content_type: candidate.content_type,
        title: candidate.title,
        published_at: candidate.published_at,
        ai_processing_status: candidate.ai_processing_status,
        review_status: candidate.review_status,
        hold_reason: candidate.hold_reason || null,
        error_type: candidate.error_type || null,
        reviewer: candidate.reviewer || null,
        reviewed_at: candidate.reviewed_at || null,
        candidate_version: candidate.candidate_version || 1,
        batch_id: candidate.batch_id || null,
        transcript_status: candidate.transcript_status || null,
        ai_review: candidate.ai_review || null,
      })),
    };
  }

  if (action === 'set') {
    if (!flags.id) throw new Error('review set 缺少 --id');
    if (!flags.status) throw new Error('review set 缺少 --status');
    const reviewer = resolveReviewer(flags);
    const next = setReviewStatus(store, flags.id, flags.status, { reason: flags.reason, reviewer });
    const candidate = next.candidates.find(item => item.id === flags.id);
    // B16 路径 A：审核时可同时确认内容类型（content_type_status → reviewed）
    if (flags.content_type && candidate) {
      confirmContentType(candidate, flags.content_type, { reviewer });
    }
    writeCandidateStore(next, `review-set-${flags.id}-${Date.now()}`);
    // 决策 70：每次审核流转追加到只追加审核事件日志，不改写历史
    recordReviewTransition(candidate, { action: 'review_set', reason: flags.reason, reviewer });
    return {
      id: candidate.id,
      review_status: candidate.review_status,
      content_type: candidate.content_type,
      content_type_status: candidate.content_type_status,
      review_reason: candidate.review_reason || null,
      reviewer: candidate.reviewer || null,
      reviewed_at: candidate.reviewed_at || null,
      from_status: candidate.from_status || null,
      candidate_version: candidate.candidate_version || 1,
      batch_id: candidate.batch_id || null,
      updated_at: next.updated_at,
    };
  }

  if (action === 'batch') {
    if (!flags.ids) throw new Error('review batch 缺少 --ids（逗号分隔的明确 id 列表，决策 56）');
    if (!flags.status) throw new Error('review batch 缺少 --status');
    const reviewer = resolveReviewer(flags);
    const ids = String(flags.ids).split(',').map(id => id.trim()).filter(Boolean);
    if (!ids.length) throw new Error('review batch 的 --ids 为空');
    const result = setBatchReviewStatus(store, ids, flags.status, { reason: flags.reason, reviewer });
    if (result.updated > 0) {
      // B16 路径 A：批量审核时可同时确认内容类型（content_type_status → reviewed）
      if (flags.content_type) {
        for (const id of ids) {
          const candidate = result.store.candidates.find(item => item.id === id);
          if (candidate && candidate.review_status === flags.status) confirmContentType(candidate, flags.content_type, { reviewer });
        }
      }
      writeCandidateStore(result.store, `review-batch-${Date.now()}`);
      // 决策 56/70：批量只记录实际流转成功的候选；每条独立追加到只追加审核事件日志
      const updatedCandidates = ids
        .map(id => result.store.candidates.find(candidate => candidate.id === id))
        .filter(candidate => candidate && candidate.review_status === flags.status);
      for (const candidate of updatedCandidates) {
        recordReviewTransition(candidate, { action: 'review_batch', reason: flags.reason, reviewer });
      }
    }
    return { status: flags.status, reviewer, ...result, updated_at: result.store.updated_at };
  }

  if (action === 'apply-ai') {
    // content-reviewer：把候选上已生成的 AI 建议应用到 review_status（discard/hold，永不 approve）。
    // 默认 dry-run 只预览；非 dry-run 才实际落盘并逐条写审核日志（reviewer='ai_review'）。
    const verdicts = flags.verdicts ? String(flags.verdicts).split(',').map(v => v.trim()).filter(Boolean) : undefined;
    const minConfidence = optionalNumber(flags, 'min_confidence');
    const dryRun = flags.dry_run === undefined ? true : Boolean(flags.dry_run);
    const result = applyAiReviewVerdicts(store, store.candidates.map(candidate => candidate.id), {
      minConfidence,
      verdicts,
      dryRun,
      reviewer: 'ai_review',
    });
    if (!dryRun && result.applied.length) {
      writeCandidateStore(result.store, `review-apply-ai-${Date.now()}`);
      // 决策 70：每条应用独立追加到只追加审核事件日志
      for (const applied of result.applied) {
        const candidate = result.store.candidates.find(item => item.id === applied.id);
        if (candidate) {
          recordReviewTransition(candidate, {
            action: applied.to === 'discarded' ? 'ai_review_discard' : 'ai_review_hold',
            reason: applied.reasons && applied.reasons.length ? applied.reasons.join('；') : null,
            reviewer: 'ai_review',
          });
        }
      }
    }
    return {
      dry_run: dryRun,
      verdicts: verdicts || ['discard', 'hold'],
      min_confidence: minConfidence ?? 0.9,
      applied: result.applied,
      skipped: result.skipped,
      updated_at: result.store?.updated_at || store.updated_at,
    };
  }

  if (action === 'log') {
    const log = readReviewEventLog();
    let events = log.events;
    if (flags.candidate_id) events = events.filter(event => event.candidate_id === flags.candidate_id);
    if (flags.action) events = events.filter(event => event.action === flags.action);
    const limit = optionalNumber(flags, 'limit');
    if (limit !== undefined && limit > 0) events = events.slice(-limit); // 最近 N 条（从日志末尾取，保持追加顺序）
    return { total: log.events.length, shown: events.length, events };
  }

  throw new Error(`未知 review 命令: ${action}`);
}

// ── legacy 命令组：旧热点数据迁移（B16 决策 64）─────

/**
 * legacy import —— 把旧 hotspots.json 数据导入内部候选层。
 * 旧数据标记 legacy 并以 pending 进入待审核流程，不自动公开（决策 64）；
 * 只导入候选层中尚不存在的 id，已存在候选保持原状（避免覆盖既有审核结论）。
 * --dry-run：只打印将导入的条数，不写候选层与审核事件日志。
 * 导入后管理者通过 `review set/batch --status approved` 逐条/批量审核，
 * 再运行 publish-news.js 重建公开热点投影（决策 64/59）。
 */
function legacyCommand(action, flags) {
  if (action === 'status') {
    return legacySummary(readCandidateStore());
  }

  if (action === 'import') {
    const dryRun = Boolean(flags.dry_run);
    const oldData = readJson(NEWS_FILES.hotspots, null);
    if (!oldData || !Array.isArray(oldData.items)) throw new Error('legacy import 无法读取旧 hotspots.json（缺少 items）');
    const result = importLegacyHotspots(readCandidateStore(), oldData.items, { now: new Date().toISOString() });
    if (!dryRun && result.imported.length) {
      writeCandidateStore(result.store, `legacy-import-${Date.now()}`);
      // 决策 70：legacy 导入的初始状态写入追加式审核事件日志（只追加、不改写历史），
      // 批量一次性写回，避免每条导入各写一次文件。
      const reviewer = resolveReviewer(flags);
      const now = new Date().toISOString();
      let log = readReviewEventLog();
      let added = 0;
      for (const id of result.imported) {
        const candidate = result.store.candidates.find(item => item.id === id);
        if (!candidate) continue;
        log = appendReviewEvent(log, reviewEventFromCandidate(candidate, {
          action: 'legacy_import',
          reason: '旧热点迁移至内部候选层，等待人工审核',
          reviewer,
          now,
        }));
        added += 1;
      }
      if (added) writeReviewEventLog(log, `legacy-import-events-${Date.now()}`);
    }
    return { ...result, dry_run: dryRun, total: result.store.candidates.length };
  }

  throw new Error(`未知 legacy 命令: ${action}`);
}

module.exports = {
  registryCommand, reviewCommand, legacyCommand,
};
