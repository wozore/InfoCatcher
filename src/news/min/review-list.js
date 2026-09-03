/**
 * review-list.js —— 人工审核清单（待审清单生成 + 审核结论应用）
 *
 * 在热点管线 v2 中的位置：
 *   - 候选层落地（pipeline-min runMin）后、维护者人工审核前 → buildReviewList 自动
 *     生成待审清单 review.json（**带 id**，只含 pending；文件已存在时追加新 pending，
 *     不覆盖已有人工结论），供维护者打开编辑 review_status；CLI 的
 *     `min-review list --manual` 也复用同一实现。
 *   - 维护者编辑完成后 → applyReviewList 把 approved/discarded 结论批量写回候选层
 *     （min-candidates.json），pending 跳过；approved 进入后续 ai-top/publish 流程。
 *     维护者入口：`min-review apply --file <清单>` 或bat/apply-review.bat。
 *
 * 程序正义（用户拍板）：
 *   - 清单是人工判断的载体与权威，候选层跟随清单；自动生成只列 pending
 *     （已审结论不重列），apply 只应用清单里的明确结论，不替维护者判断。
 *   - 只支持新格式：清单条目必须带 id（2026-08-08 前旧格式无 id），apply 对无 id
 *     条目直接抛错拒绝并提示重新生成（不静默错配）。
 *   - 追加合并：清单文件名固定 review.json（去掉日期后缀，便于每日多次采集追加）；
 *     buildReviewList 遇到清单已存在时把本次新 pending 追加到尾部（按 id 去重，
 *     保留已有人工结论，不覆盖）；本次无新 pending 时跳过不写盘；`--force` 强制重建。
 *
 * 本模块纯逻辑 + 文件读写，不发起网络请求、不消费额度。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../core/news-storage');
const { createMinStore, setBatchReviewStatusMin } = require('./min-store');
const { beijingDateKey } = require('../../shared/beijing-time');

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

/** 组装待审清单 JSON（kind='review_candidates'；human_lines 只列 pending 供人工扫描）。 */
function buildReviewPayload(candidates, now, dateKey) {
  const pending = (candidates || []).filter(c => c && c.review_status === 'pending');
  return {
    schema_version: 1,
    kind: 'review_candidates',
    generated_at: now.toISOString(),
    date: dateKey,
    total_pending: pending.length,
    note: '待人工审核清单：请逐条设置 review_status（pending/approved/discarded）。' +
          '应用结论：双击 bat/apply-review.bat（或 node scripts/news-cli.js min-review apply --file 本文件），' +
          '应用后自动生成 top 名单（ai-top）供二次审核；approved 才进后续 top-selected/publish。',
    candidates: candidates || [],
    // 人友好：每行一条，供人工扫描
    human_lines: pending.map(c =>
      `[${c.score === null ? '-' : c.score}] ${c.summary}\n    建议：${c.suggestion}`
    ),
  };
}

/**
 * 追加合并两份候选清单：保留已有条目（含人工结论与顺序），
 * 把 fresh 中不在已有集合的条目追加到尾部（按 id 去重）。
 * options.updateSummaries === true 时：对于已有条目，若其处于 pending 状态，
 * 同步更新其 summary、score、suggestion 为 fresh 的最新值，保留维护者已填写的非 pending 结论。
 * @param {Array} [existingCandidates]
 * @param {Array} [freshCandidates]
 * @param {object} [options]
 * @returns {{ merged: Array, appended: number, updated: number }}
 */
function mergeReviewCandidates(existingCandidates, freshCandidates, options = {}) {
  const merged = [];
  const existingMap = new Map();
  const freshMap = new Map();

  for (const f of Array.isArray(freshCandidates) ? freshCandidates : []) {
    if (f && f.id != null) freshMap.set(String(f.id), f);
  }

  let updated = 0;
  for (const c of Array.isArray(existingCandidates) ? existingCandidates : []) {
    if (c && c.id != null) {
      const idStr = String(c.id);
      existingMap.set(idStr, c);
      if (options.updateSummaries && freshMap.has(idStr)) {
        const fresh = freshMap.get(idStr);
        // 如果维护者已人工修改了状态（如填成了 approved 或 discarded），绝不覆盖人工结论！
        const manualStatus = c.review_status !== 'pending' ? c.review_status : fresh.review_status;
        merged.push({
          ...fresh,
          review_status: manualStatus,
        });
        updated++;
      } else {
        merged.push(c);
      }
    } else {
      merged.push(c);
    }
  }

  let appended = 0;
  for (const f of Array.isArray(freshCandidates) ? freshCandidates : []) {
    if (f && f.id != null && !existingMap.has(String(f.id))) {
      existingMap.set(String(f.id), f);
      merged.push(f);
      appended++;
    }
  }

  return { merged, appended, updated };
}

/**
 * 生成待审清单 review.json（带 id，只含 pending，评分倒序）。
 * 文件名固定 review.json（去掉日期后缀，便于每日多次采集追加）：
 *   - 文件不存在 → 全新生成；
 *   - 文件已存在 → 追加本次新 pending（按 id 去重、保留已有人工结论与顺序），
 *     无新 pending 时跳过不写盘；--force 强制重建为最新 pending 清单。
 * 供维护者打开编辑 review_status；与 `min-review list --manual` 同实现。
 *
 * @param {object} store - 候选层（min-candidates.json 的 store 结构）
 * @param {object} [config] - v2 配置（取 manual_folder，缺省 data/manual）
 * @param {{now?: Date, force?: boolean}} [options]
 *   - now：清单日期基准（缺省当前时间；注入便于测试确定性）
 *   - force：已存在时强制重建为最新 pending 清单（缺省 false = 追加合并）
 * @returns {{ file: string, total_pending: number, candidates: Array,
 *              skipped: boolean, reason?: string, appended?: number, replaced?: boolean }}
 *   - skipped=true 时未写盘（reason='no_new_pending'，清单已存在且本次无新 pending）
 */
function buildReviewList(store, config, options = {}) {
  const now = options.now || new Date();
  const dateKey = beijingDateKey(now);
  const manualFolder = (config && config.manual_folder) || 'data/manual';
  const file = path.join(manualFolder, 'review.json');

  // 待审候选：全部 pending（评分倒序，供维护者逐条审核）
  const reviewList = (store.candidates || [])
    .filter(c => c && c.review_status === 'pending')
    .sort((a, b) => (scoreOf(b) ?? -Infinity) - (scoreOf(a) ?? -Infinity))
    .map(c => {
      // 内容概要：优先 AI 中文摘要（c.summary），其次汉化标题（localizations.zh.title），
      // 再兜底原文标题——维护者要中文（汉化在前置阶段已完成）
      const zhTitle = (c.localizations && c.localizations.zh && c.localizations.zh.title) || '';
      const summaryText = String(c.summary || zhTitle || c.title || '(无标题)')
        .trim().replace(/\s+/g, ' ').slice(0, 80);
      return {
        id: c.id,   // 新格式：带 id，apply 直连定位，不做脆弱的 summary 文本匹配
        score: scoreOf(c),
        summary: summaryText,
        suggestion: suggestReview(c),
        review_status: c.review_status || 'pending',
      };
    });

  const existing = readJson(file, null);
  if (existing && Array.isArray(existing.candidates)) {
    if (options.force) {
      const payload = buildReviewPayload(reviewList, now, dateKey);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, payload, 'min-review-manual');
      return { file, total_pending: reviewList.length, candidates: reviewList, appended: 0, replaced: true, skipped: false };
    }
    const { merged, appended, updated } = mergeReviewCandidates(existing.candidates, reviewList, {
      updateSummaries: options.updateSummaries === true,
    });
    const totalPending = merged.filter(c => c && c.review_status === 'pending').length;
    if (appended === 0 && (!options.updateSummaries || updated === 0)) {
      return { skipped: true, file, total_pending: totalPending, reason: 'no_new_pending', candidates: merged };
    }
    const payload = buildReviewPayload(merged, now, dateKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, payload, 'min-review-manual');
    return { file, total_pending: totalPending, candidates: merged, appended, updated: updated || 0, replaced: false, skipped: false };
  }

  const payload = buildReviewPayload(reviewList, now, dateKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, payload, 'min-review-manual');
  return { file, total_pending: reviewList.length, candidates: reviewList, appended: reviewList.length, replaced: false, skipped: false };
}

/**
 * 读取并校验待审清单（kind='review_candidates' 且含 candidates 数组）。
 * @param {string} filePath - 清单路径（如 data/manual/review.json）
 * @returns {object} 解析后的清单对象（含 candidates 数组）
 */
function loadReviewList(filePath) {
  const list = readJson(filePath, null);
  if (!list || list.kind !== 'review_candidates' || !Array.isArray(list.candidates)) {
    throw new Error(`非法待审清单：${filePath}（需要 kind='review_candidates' 且含 candidates 数组）`);
  }
  return list;
}

/**
 * 应用人工审核结论：读待审清单的 review_status，把 approved/discarded 批量写回候选层。
 * 纯逻辑，返回新 store；是否写盘（writeMinStore）由调用方决定。
 *
 * 规则（用户拍板）：
 *   - pending → 跳过（维护者未定论，不动候选层）；
 *   - approved / discarded → 按 id 直连候选写回（reviewed_at 由 min-store 刷新）；
 *   - 目标状态与候选当前状态相同 → 跳过（幂等，不刷新 reviewed_at）；
 *   - 条目无 id → 抛错（旧格式清单，提示重新生成，整批不写盘——调用方未落盘前无部分写入）；
 *   - 非法 review_status → 计入 invalid（防御维护者手误）。
 *
 * @param {object} store - 候选层 store（将被浅拷贝，不改入参）
 * @param {object} list - loadReviewList 返回的清单对象
 * @returns {{ store: object, applied: {approved: number, discarded: number},
 *              skipped: number, noop: number, invalid: number, invalidIds: string[],
 *              missing: string[], changed: number }}
 *   - changed = 实际写回数（applied.approved + applied.discarded）
 */
function applyReviewList(store, list) {
  const next = createMinStore(store);
  const byId = new Map(next.candidates.map(candidate => [candidate.id, candidate]));
  const approvedIds = [];
  const discardedIds = [];
  const invalidIds = [];
  const missing = [];
  let skipped = 0;
  let noop = 0;
  let invalid = 0;

  const entries = (list && Array.isArray(list.candidates)) ? list.candidates : [];
  for (const entry of entries) {
    const status = entry && entry.review_status;
    if (status === 'pending') { skipped++; continue; }
    if (status !== 'approved' && status !== 'discarded') {
      invalid++;
      invalidIds.push(String((entry && entry.id) || (entry && entry.summary) || '(无 id)'));
      continue;
    }
    // approved/discarded 必须有 id（只支持新格式）
    if (entry == null || entry.id == null || String(entry.id).trim() === '') {
      throw new Error(
        `待审清单含无 id 条目（review_status=${status}）——旧格式清单，` +
        `请用 min-review list --manual 重新生成带 id 的清单`
      );
    }
    const id = String(entry.id);
    const candidate = byId.get(id);
    if (!candidate) { missing.push(id); continue; }
    if (candidate.review_status === status) { noop++; continue; }
    if (status === 'approved') approvedIds.push(id);
    else discardedIds.push(id);
  }

  let storeOut = next;
  if (approvedIds.length) storeOut = setBatchReviewStatusMin(storeOut, approvedIds, 'approved').store;
  if (discardedIds.length) storeOut = setBatchReviewStatusMin(storeOut, discardedIds, 'discarded').store;

  return {
    store: storeOut,
    applied: { approved: approvedIds.length, discarded: discardedIds.length },
    skipped,
    noop,
    invalid,
    invalidIds,
    missing,
    changed: approvedIds.length + discardedIds.length,
  };
}

module.exports = {
  scoreOf,
  suggestReview,
  buildReviewPayload,
  mergeReviewCandidates,
  buildReviewList,
  loadReviewList,
  applyReviewList,
};
