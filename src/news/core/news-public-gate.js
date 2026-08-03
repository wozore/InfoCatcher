/**
 * news-public-gate.js —— 公开资格统一过滤（B16 决策 63/72）
 *
 * 在热点管线中的位置：作为「公开出口」共用的过滤规则单一来源。
 * hotspots.json 构建与 RSS feed.xml 生成都必须经过同一套规则，
 * 避免出现「热点视图有这条、RSS 却没有」或相反的口径漂移（决策 72）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 公开资格总规则（决策 49/63/69/72 的组合）：
 * ═══════════════════════════════════════════════════════════════
 *   1. 审核门禁（news-candidates.js 的 isPublicEligible）：
 *        ai_processing_status === completed 且 review_status === approved
 *   2. 近期时间窗口（本模块，决策 63）：
 *        以内容发布时间判断，默认 30 天；窗口天数来自配置
 *        （collection.output_retention_days），不使用抓取时间伪装；
 *        未来时间超出容错范围、或发布时间缺失的内容视为异常，进入
 *        held / error 处理路径，不进入公开数据。
 *   3. 公开字段完整（本模块，决策 49）：
 *        标题、来源链接、发布时间等公开字段必须完整。
 *
 * 出口使用方式：
 *   - build-news.js：旧内容保留、候选时间异常标记统一走 isWithinPublicWindow；
 *   - generate-rss.js：从 hotspots.json 读取后再按同一窗口过滤（第二道防线）。
 *
 * 本模块只提供纯函数与候选层时间异常标记，不发起网络请求、不消费额度。
 */

'use strict';

const { markHeld } = require('./news-candidates');

const DEFAULT_PUBLIC_WINDOW_DAYS = 30;               // 决策 63：默认 30 天近期窗口
const DEFAULT_FUTURE_TOLERANCE_MS = 6 * 3600 * 1000; // 未来时间容错（默认 6 小时，容忍时钟偏差）

/**
 * 解析公开时间窗口配置（决策 63：窗口天数作为配置，不硬编码）。
 * - windowDays：内容发布时间的近期窗口天数（默认 30）；
 * - futureToleranceMs：未来时间容错毫秒数（超出视为异常）；
 * - now：必须归一化为数字时间戳（classifyPublicTime 用 now - time 做算术）。
 *   兼容调用方传入 ISO 字符串（如 fetchedAt）：统一解析为毫秒；
 *   非法或缺失时回退当前时间，避免字符串参与减法得到 NaN 导致时间门禁静默失效。
 */
function resolvePublicWindow(config, now) {
  const collection = config?.collection || {};
  let nowMs = now;
  if (typeof nowMs === 'string') nowMs = new Date(nowMs).getTime();
  if (!Number.isFinite(nowMs)) nowMs = Date.now();
  return {
    windowDays: Number(collection.output_retention_days ?? DEFAULT_PUBLIC_WINDOW_DAYS),
    futureToleranceMs: Number(collection.future_tolerance_ms ?? DEFAULT_FUTURE_TOLERANCE_MS),
    now: nowMs,
  };
}

/**
 * 内容发布时间相对公开窗口的分类（决策 63/78）：
 *   - in_window：位于 [now - windowDays, now + futureToleranceMs]；
 *   - too_old   ：早于窗口，超过近期窗口；
 *   - future    ：晚于 now + futureToleranceMs，时间异常；
 *   - missing   ：发布时间缺失或无效。
 */
function classifyPublicTime(item, opts = {}) {
  const { windowDays, futureToleranceMs, now } = resolvePublicWindow(opts.config, opts.now);
  const time = item && item.published_at ? new Date(item.published_at).getTime() : NaN;
  if (!Number.isFinite(time)) return 'missing';
  const age = now - time;
  if (age < -futureToleranceMs) return 'future';
  if (age > windowDays * 86400000) return 'too_old';
  return 'in_window';
}

/** 是否在公开近期窗口内（决策 63 的硬性时间条件）。 */
function isWithinPublicWindow(item, opts = {}) {
  return classifyPublicTime(item, opts) === 'in_window';
}

/** 公开字段完整性（决策 49）：标题、来源链接、发布时间必须完整。 */
function hasCompletePublicFields(item) {
  return Boolean(
    item &&
    String(item.title || '').trim() &&
    String(item.url || '').trim() &&
    String(item.published_at || '').trim()
  );
}

/**
 * 公开资格统一过滤：仅保留同时满足时间窗口与公开字段完整的条目。
 * 供公开出口复用（决策 72）；审核门禁由候选层/投影层另行保证。
 */
function filterPublicItems(items, opts = {}) {
  return (items || []).filter(item => isWithinPublicWindow(item, opts) && hasCompletePublicFields(item));
}

/**
 * 对已构建的公开投影按近期窗口做一致过滤（决策 63/72）：
 * items 按窗口过滤；events / provenance / assessments 只保留引用到存活条目的记录，
 * 避免出现「事件/溯源/评分引用已被过滤掉的条目」的悬空引用。
 * 供 build-news.js 与 publish-news.js 等公开出口复用，与 RSS 共用同一规则。
 */
function filterProjectionByWindow(output, opts = {}) {
  if (!output || !Array.isArray(output.items)) return output;
  const alive = new Set(filterPublicItems(output.items, opts).map(item => item.id));
  if (alive.size === output.items.length) return output;
  return {
    ...output,
    items: output.items.filter(item => alive.has(item.id)),
    events: (output.events || []).filter(event => (event.content_ids || []).some(id => alive.has(id))),
    provenance: (output.provenance || []).filter(relation => alive.has(relation.content_id)),
    assessments: (output.assessments || []).filter(assessment => alive.has(assessment.content_id)),
  };
}

/**
 * 决策 63：发布时间缺失或未来超容错的候选标记为 held（异常待复审），
 * 从而不会通过审核门禁进入公开数据。仅就地修改候选层，返回变更清单。
 * 调用方应把变更记录到追加式审核事件日志（决策 70）。
 */
function markAnomalousTimeCandidates(store, opts = {}) {
  if (!store) throw new Error('候选层不存在');
  const { now } = resolvePublicWindow(opts.config, opts.now);
  const changed = [];
  for (const candidate of store.candidates || []) {
    if (candidate.review_status === 'held') continue; // 已 held：已被审核门禁排除，不重复标记
    const status = classifyPublicTime(candidate, opts);
    if (status === 'future') {
      markHeld(candidate, {
        reason: '发布时间超出容错范围（未来时间），标记为异常待复审',
        now,
      });
      changed.push({ id: candidate.id, time_status: status });
    } else if (status === 'missing') {
      markHeld(candidate, {
        reason: '发布时间缺失，无法确认近期性，暂不公开',
        now,
      });
      changed.push({ id: candidate.id, time_status: status });
    }
  }
  return changed;
}

module.exports = {
  DEFAULT_PUBLIC_WINDOW_DAYS,
  DEFAULT_FUTURE_TOLERANCE_MS,
  resolvePublicWindow,
  classifyPublicTime,
  isWithinPublicWindow,
  hasCompletePublicFields,
  filterPublicItems,
  filterProjectionByWindow,
  markAnomalousTimeCandidates,
};
