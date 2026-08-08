/**
 * review-list.js —— 人工审核清单（待审清单生成 + 审核结论应用）
 *
 * 在热点管线 v2 中的位置：
 *   - 候选层落地（pipeline-min runMin）后、维护者人工审核前 → buildReviewList 自动
 *     生成待审清单 review-<date>.json（**带 id**，只含 pending），供维护者打开编辑
 *     review_status；CLI 的 `min-review list --manual` 也复用同一实现。
 *   - 维护者编辑完成后 → applyReviewList 把 approved/discarded 结论批量写回候选层
 *     （min-candidates.json），pending 跳过；approved 进入后续 ai-top/publish 流程。
 *     维护者入口：`min-review apply --file <清单>` 或bat/apply-review.bat。
 *
 * 程序正义（用户拍板）：
 *   - 清单是人工判断的载体与权威，候选层跟随清单；自动生成只列 pending
 *     （已审结论不重列），apply 只应用清单里的明确结论，不替维护者判断。
 *   - 只支持新格式：清单条目必须带 id（2026-08-08 前旧格式无 id），apply 对无 id
 *     条目直接抛错拒绝并提示重新生成（不静默错配）。
 *   - 覆盖保护：buildReviewList 遇到目标清单已含非 pending 结论（维护者已编辑）
 *     时不覆盖，保留人工结论；`--force` 显式强制重新生成。
 *
 * 本模块纯逻辑 + 文件读写，不发起网络请求、不消费额度。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../core/news-storage');
const { createMinStore, setBatchReviewStatusMin } = require('./min-store');

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

/**
 * 生成待审清单 review-<date>.json（带 id，只含 pending，评分倒序）。
 * 供维护者打开编辑 review_status；与 `min-review list --manual` 同实现。
 *
 * @param {object} store - 候选层（min-candidates.json 的 store 结构）
 * @param {object} [config] - v2 配置（取 manual_folder，缺省 data/manual）
 * @param {{now?: Date, force?: boolean}} [options]
 *   - now：清单日期基准（缺省当前时间；注入便于测试确定性）
 *   - force：目标清单已含人工结论时仍强制重新生成（缺省 false = 覆盖保护）
 * @returns {{ file: string, total_pending: number, candidates: Array,
 *              skipped: boolean, reason?: string }}
 *   - skipped=true 时未写盘（reason='existing_reviewed'，目标清单已有非 pending 结论）
 */
function buildReviewList(store, config, options = {}) {
  const now = options.now || new Date();
  const dateKey = now.toISOString().slice(0, 10).replace(/-/g, '');
  const manualFolder = (config && config.manual_folder) || 'data/manual';
  const file = path.join(manualFolder, `review-${dateKey}.json`);

  // 覆盖保护：目标清单已含非 pending 结论（维护者已编辑）→ 不覆盖，保留人工结论。
  const existing = readJson(file, null);
  const hasReviewed = existing && Array.isArray(existing.candidates)
    && existing.candidates.some(c => c && c.review_status && c.review_status !== 'pending');
  if (hasReviewed && !options.force) {
    return { skipped: true, file, total_pending: existing.total_pending || 0, reason: 'existing_reviewed' };
  }

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

  const payload = {
    schema_version: 1,
    kind: 'review_candidates',
    generated_at: now.toISOString(),
    date: dateKey,
    total_pending: reviewList.length,
    note: '待人工审核清单：请逐条设置 review_status（pending/approved/discarded）。' +
          '应用结论：双击 bat/apply-review.bat（或 node scripts/news-cli.js min-review apply --file 本文件），' +
          '应用后自动生成 top 名单（ai-top）供二次审核；approved 才进后续 top-selected/publish。',
    candidates: reviewList,
    // 人友好：每行一条，供人工扫描
    human_lines: reviewList.map(c =>
      `[${c.score === null ? '-' : c.score}] ${c.summary}\n    建议：${c.suggestion}`
    ),
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, payload, 'min-review-manual');
  return { file, total_pending: reviewList.length, candidates: reviewList, skipped: false };
}

/**
 * 读取并校验待审清单（kind='review_candidates' 且含 candidates 数组）。
 * @param {string} filePath - 清单路径（如 data/manual/review-20260808.json）
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
  buildReviewList,
  loadReviewList,
  applyReviewList,
};
