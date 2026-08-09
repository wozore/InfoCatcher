/**
 * daily-projection.js —— 每日 top N 公开投影（v2 单状态轴）
 *
 * 在热点管线中的位置：v2 候选层（min-store）之后、公开出口之前。
 * 从 approved 候选中按 published_at 所在自然日分组，每组按评分倒序取 top N，
 * 输出当日公开投影 items。
 *
 * **纯逻辑模块**：只负责「approved 里按天取 top N」。公开契约补充
 * （enrichHotspotProjection 的 hot_score / evidence_excerpt / related_resources）
 * 与近期窗口过滤（filterProjectionByWindow）由编排层（pipeline-min）另行调用，
 * 本模块不调那两步。
 *
 * top N 取值（news-config-v2.json collection）：
 *   - 当天组内有 YouTube 视频（platform === 'youtube' 的候选）→ max_output_with_youtube（8）
 *   - 否则 → max_output_items_daily（5）
 *   组内不足 N 条时取实际数量，不强凑。
 *
 * 排序：组内按 final_score 倒序；条目缺 final_score 时按 hot_score；两者皆无
 * 排最末。同分以 published_at 更新者优先，再以 id 保证确定性。
 */

'use strict';

const { isMinDisplayEligible, toPublicItemMin } = require('./min-store');
const { beijingDayKey } = require('../../shared/beijing-time');

/** 组内排序分数：final_score 优先，其次 hot_score；皆无则排最末。 */
function sortScoreOf(item) {
  if (Number.isFinite(item && item.final_score)) return item.final_score;
  if (Number.isFinite(item && item.hot_score)) return item.hot_score;
  return -Infinity;
}

/** published_at 所在自然日键（北京时间 YYYY-MM-DD）；缺失/非法返回 null。 */
function dayKeyOf(publishedAt) {
  const d = new Date(publishedAt);
  if (!Number.isFinite(d.getTime())) return null;
  return beijingDayKey(d);
}

function resolveGeneratedAt(options) {
  if (options && options.now != null) {
    const d = options.now instanceof Date ? options.now : new Date(options.now);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/**
 * 构建每日公开投影：approved 候选按天分组 → 组内按分倒序 → 每组取 top N。
 *
 * @param {object} store  min-store 全文（读 store.candidates）
 * @param {object} config news-config-v2.json（读 collection.max_output_with_youtube /
 *                        collection.max_output_items_daily）
 * @param {object} [options] { now }：generated_at 用 now（Date 或 ISO 字符串），缺省当前时间
 * @returns {{ generated_at: string, items: Array<object> }}
 *   items 为 toPublicItemMin 输出的公开条目（已剔除内部审核字段）。
 */
function buildDailyProjection(store, config, options = {}) {
  const collection = (config && config.collection) || {};
  const maxWithYoutube = Number(collection.max_output_with_youtube) || 8;
  const maxDaily = Number(collection.max_output_items_daily) || 5;

  const approved = (store && Array.isArray(store.candidates) ? store.candidates : [])
    .filter(isMinDisplayEligible);

  // 按 published_at 所在自然日分组；发布时间缺失/非法 → 无法归属自然日，不进投影
  const byDay = new Map();
  for (const candidate of approved) {
    const key = dayKeyOf(candidate.published_at);
    if (!key) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(candidate);
  }

  const items = [];
  for (const group of byDay.values()) {
    group.sort((a, b) => {
      const diff = sortScoreOf(b) - sortScoreOf(a);
      if (diff !== 0) return diff;
      const aTime = new Date(a.published_at).getTime();
      const bTime = new Date(b.published_at).getTime();
      if (aTime !== bTime) return bTime - aTime; // 同分 → 更新者在前
      return String(a.id).localeCompare(String(b.id)); // 确定性兜底
    });
    // 当天组内有 YouTube 视频 → 放宽到 max_output_with_youtube；否则 max_output_items_daily
    const hasYouTube = group.some(candidate => candidate.platform === 'youtube');
    const cap = hasYouTube ? maxWithYoutube : maxDaily;
    for (const candidate of group.slice(0, cap)) items.push(toPublicItemMin(candidate));
  }

  return { generated_at: resolveGeneratedAt(options), items };
}

module.exports = { buildDailyProjection };
