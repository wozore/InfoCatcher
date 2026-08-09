/**
 * transcript-notify.js —— 每日"待人工获取字幕"清单（热点管线 v2 收尾环节）
 *
 * 在热点管线 v2 中的位置：收尾环节之一，与 tool-feedback / keyword-refine 并列，
 * **独立于主链、互相不依赖**。只做一件事：
 *   从 min 候选层挑评分最高的若干 YouTube 视频，输出一份人友好的
 *   "待人工获取字幕"清单文件，交由维护者人工抓取字幕后回填候选层。
 *
 * 完全分离（决策约束）：本模块只读 min-store（JSON）并写一份清单文件，
 * 不触碰主链状态、不发起任何采集/总结请求、不消费额度、不改候选层。
 *
 * 配置（news-config-v2.json）：
 *   - transcripts.notify_count   "3to5" 这类区间 → 解析为 3~5 之间的数量（默认取低值 3）
 *   - manual_folder              清单输出目录（缺省 data/manual）
 *
 * 数据文件（manual_folder/）：
 *   transcript-requests.json      待人工获取字幕清单（文件名固定，去掉日期后缀）
 *     含结构化 requested（title/url/score）+ 每行一条的 human_lines（人友好扫描用）
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { writeJsonAtomic } = require('../core/news-storage');
const { readMinStore, toPublicItemMin } = require('../min/min-store');

/**
 * 解析 notify_count：数值原样取；"3to5"/"3~5"/"3-5" 区间取低值（保守）；
 * 非法/缺失回退默认 3。
 * @param {number|string} [raw]
 * @param {number} [fallback=3]
 * @returns {number} 不小于 1 的整数
 */
function parseNotifyCount(raw, fallback = 3) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  if (typeof raw === 'string') {
    const range = raw.trim().match(/^(\d+)\s*(?:to|~|-|–|到)\s*(\d+)\s*$/i);
    if (range) {
      const low = Math.max(1, Number(range[1]));
      const high = Math.max(low, Number(range[2]));
      // 区间 "3to5"：取低值，避免超出采集人力
      return Math.min(Math.max(1, low), high);
    }
    const num = Number(raw.trim());
    if (Number.isFinite(num) && num >= 1) return Math.floor(num);
  }
  return fallback;
}

/** 排序分数：final_score 优先，其次 hot_score；皆无排最末。 */
function scoreOf(item) {
  if (Number.isFinite(item && item.final_score)) return item.final_score;
  if (Number.isFinite(item && item.hot_score)) return item.hot_score;
  return -Infinity;
}

/** 清单文件名日期键（本地时区 YYYYMMDD），来自 options.now 或当天。 */
function dateKeyOf(input) {
  const d = input == null || !Number.isFinite(new Date(input).getTime()) ? new Date() : new Date(input);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * 生成每日"待人工获取字幕"清单。
 *
 * @param {object} [store]  min-store 全文（读 store.candidates）；options.store 优先
 * @param {object} [config] news-config-v2.json（读 transcripts / manual_folder）
 * @param {object} [options] { store?, now? }
 *   - store  候选层覆盖（缺省 store 入参 → 缺省 readMinStore()）
 *   - now    清单日期参考（Date 或可解析字符串，缺省当天）
 * @returns {{ requested: Array<{title,url,score}>, file: string }}
 *   只写清单文件；不改候选层、不调任何采集/总结。
 */
function notifyTranscripts(store, config, options = {}) {
  const source = options.store ?? store ?? readMinStore();
  const candidates = source && Array.isArray(source.candidates) ? source.candidates : [];

  const youtube = candidates
    .filter(item => item && item.platform === 'youtube')
    .slice()
    .sort((a, b) => {
      const diff = scoreOf(b) - scoreOf(a);
      if (diff !== 0) return diff;
      return String(a.id || '').localeCompare(String(b.id || '')); // 确定性兜底
    });

  const notifyCount = parseNotifyCount(config && config.transcripts && config.transcripts.notify_count, 3);
  const top = youtube.slice(0, notifyCount);

  const requested = top.map(item => {
    const pub = toPublicItemMin(item); // 只保留公开契约字段
    const score = scoreOf(item);
    return {
      title: String(pub.title || '(无标题)').trim(),
      url: String(pub.url || '').trim(),
      score: Number.isFinite(score) ? score : null,
    };
  });

  const dateKey = dateKeyOf(options && options.now);
  const manualFolder = (config && config.manual_folder) || 'data/manual';
  const file = path.join(manualFolder, 'transcript-requests.json');

  const payload = {
    schema_version: 1,
    kind: 'transcript_requests',
    generated_at: new Date().toISOString(),
    date: dateKey,
    notify_count: requested.length,
    requested,
    // 人友好：每行一个视频，供人工扫描
    human_lines: requested.map(item =>
      `${item.title} | ${item.url} | ${item.score === null ? '-' : item.score}`
    ),
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, payload, 'transcript-notify');

  return { requested, file };
}

module.exports = { notifyTranscripts, parseNotifyCount, scoreOf, dateKeyOf };
