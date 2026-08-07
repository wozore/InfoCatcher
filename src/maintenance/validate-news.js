/**
 * validate-news.js — InfoCatcher news 域数据校验
 *
 * 从 validate.js 拆分出的 news 域：news-sources / news-config /
 * news-manual-items / news-registry / news-quota / pending-authorizations /
 * hotspot-candidates / review-events / hotspots 的校验函数与入口
 * validateNews()。失败通过本模块独立的 fail()/failed 状态记录，
 * 由 validate.js 聚合为最终退出码。错误文案与通过/失败输出与拆分前逐字一致。
 *
 * 用法：由 validate.js 调用 validateNews()。
 */

'use strict';

const fs = require('fs');
const { NEWS_FILES } = require('../shared/paths');
// 热点管线 v2 单状态轴候选层：只读其枚举常量，避免与 min-store 的状态轴语义漂移。
const { MIN_REVIEW_STATUSES } = require('../news/min/min-store');

let failed = false;

/** 记录一个校验失败项。不中断执行，确保一次运行能报告所有问题 */
function fail(msg) {
  console.error('❌', msg);
  failed = true;
}

/** 批量检查对象是否缺少必填字段 */
function checkRequired(obj, path, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null) {
      fail(`${path}.${f} 缺失`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 第 3 组：热点配置、来源与持久状态
//
// 依次校验：news-sources → news-config → news-registry →
//   news-quota → pending-authorizations
// 每个文件独立 try/catch，一个文件损坏不阻止其他校验
// ═══════════════════════════════════════════════════════════════

const NEWS_PLATFORMS = ['youtube', 'x', 'bilibili'];
// B16 决策 65：来源媒体类型（采集时的平台内容形态，仅作溯源元信息，不进前端筛选）。
const SOURCE_TYPES = [
  'youtube_video', 'x_post', 'bilibili_video', 'bilibili_dynamic_video',
  'bilibili_dynamic_repost', 'bilibili_dynamic_text', 'bilibili_article', 'unknown'
];
// B16 决策 65/66/79：内容类型（热点视图主分类维度）。unclassified 表示
// AI 分类 + 人工确认未上线前的诚实占位（路径 B）；路径 A 上线后由审核确认填充。
const CONTENT_TYPES = [
  'ai_tool', 'ai_product', 'ai_concept', 'ai_technology', 'ai_industry', 'other', 'unclassified'
];

function validateNewsSources(data) {
  if (!data || !Array.isArray(data.sources)) {
    fail('news-sources.json.sources 应为数组');
    return;
  }
  const ids = new Set();
  for (let i = 0; i < data.sources.length; i++) {
    const source = data.sources[i];
    const tag = `news-sources.json.sources[${i}] (${source.name || '未知'})`;
    checkRequired(source, tag, ['id', 'platform', 'name', 'profile_url', 'content_tags', 'enabled', 'collector']);
    if (ids.has(source.id)) fail(`${tag}.id 重复: ${source.id}`);
    ids.add(source.id);
    if (!NEWS_PLATFORMS.includes(source.platform)) fail(`${tag}.platform 不支持: ${source.platform}`);
    if (!Array.isArray(source.content_tags)) fail(`${tag}.content_tags 应为数组`);
    if (source.enabled && source.content_tags.length === 0) fail(`${tag} 已启用但没有内容类型标签`);
    if (source.enabled && !source.external_id) fail(`${tag} 已启用但 external_id 缺失`);
  }
  console.log(`  news-sources.json: ${data.sources.length} 个来源，全部通过`);
}

function validateNewsRegistry(data) {
  if (!data || typeof data.videos !== 'object' || Array.isArray(data.videos)) return fail('news-registry.json.videos 应为对象');
  const discovery = new Set(['discovered', 'backfill_candidate', 'filtered_non_ai', 'duplicate_observation', 'quota_paused', 'waiting_authorization', 'temporarily_failed', 'permanently_failed']);
  const processing = new Set(['pending', 'details_fetched', 'analysis_pending', 'assessed', 'published', 'failed']);
  for (const [key, record] of Object.entries(data.videos)) {
    if (record.key && record.key !== key) fail(`news-registry.json key 不一致: ${key}`);
    if (!key.startsWith(`${record.platform}:`)) fail(`news-registry.json key 平台前缀错误: ${key}`);
    if (!discovery.has(record.discovery_status)) fail(`news-registry.json ${key} discovery_status 无效`);
    if (!processing.has(record.processing_status)) fail(`news-registry.json ${key} processing_status 无效`);
  }
  if (data.stats?.count !== Object.keys(data.videos).length) fail('news-registry.json stats.count 与记录数不一致');
  console.log(`  news-registry.json: ${Object.keys(data.videos).length} 条记录，通过`);
}

function validateNewsQuota(data) {
  for (const platform of ['youtube', 'bilibili']) {
    const account = data?.platforms?.[platform];
    if (!account) { fail(`news-quota.json 缺少 ${platform}`); continue; }
    if (account.consumed + account.remaining !== account.limit) fail(`news-quota.json ${platform} 余额计算错误`);
    if (account.reserved < 0 || account.consumed < 0 || account.remaining < 0) fail(`news-quota.json ${platform} 存在负数`);
    if (!Array.isArray(account.operations)) fail(`news-quota.json ${platform}.operations 应为数组`);
  }
  console.log('  news-quota.json: 两个平台额度账本通过');
}

function validateAuthorizations(data) {
  if (!data || !Array.isArray(data.tasks)) return fail('pending-authorizations.json.tasks 应为数组');
  const ids = new Set();
  for (const task of data.tasks) {
    if (!task.id || ids.has(task.id)) fail(`pending-authorizations.json id 缺失或重复: ${task.id}`);
    ids.add(task.id);
    if (!['pending', 'authorized', 'skipped', 'stopped'].includes(task.status)) fail(`授权任务 ${task.id} 状态无效`);
    if (task.status !== 'pending' && !task.decision) fail(`授权任务 ${task.id} 已处理但缺少 decision`);
  }
  console.log(`  pending-authorizations.json: ${data.tasks.length} 个任务，通过`);
}

function validateNewsCandidates(data) {
  if (!data || !Array.isArray(data.candidates)) return fail('hotspot-candidates.json.candidates 应为数组');
  const ids = new Set();
  const aiStatuses = new Set(['not_requested', 'queued', 'processing', 'completed', 'error']);
  const reviewStatuses = new Set(['pending', 'approved', 'held', 'discarded']);
  const transcriptStatuses = new Set(['ok', 'missing', 'too_short', 'fetch_failed']);
  for (let i = 0; i < data.candidates.length; i++) {
    const candidate = data.candidates[i];
    const tag = `hotspot-candidates.json.candidates[${i}] (${candidate.title || '未知'})`;
    if (!candidate.id || ids.has(candidate.id)) fail(`${tag}.id 缺失或重复: ${candidate.id}`);
    ids.add(candidate.id);
    // B16 决策 16/69：每条候选必须带双状态轴，且取值为合法枚举
    if (!aiStatuses.has(candidate.ai_processing_status)) fail(`${tag}.ai_processing_status 无效`);
    if (!reviewStatuses.has(candidate.review_status)) fail(`${tag}.review_status 无效`);
    // B16 决策 70：审核审计字段（存在时校验格式）
    if (candidate.candidate_version !== undefined && (!Number.isInteger(candidate.candidate_version) || candidate.candidate_version < 1)) {
      fail(`${tag}.candidate_version 应为正整数`);
    }
    if (candidate.reviewed_at !== undefined && Number.isNaN(new Date(candidate.reviewed_at).getTime())) {
      fail(`${tag}.reviewed_at 不是有效时间`);
    }
    if (candidate.reviewer !== undefined && !String(candidate.reviewer).trim()) fail(`${tag}.reviewer 不能为空`);
    if (candidate.batch_id !== undefined && !String(candidate.batch_id).trim()) fail(`${tag}.batch_id 不能为空`);
    // B16 决策 52：字幕元数据（存在时校验格式）
    if (candidate.transcript_status !== undefined && !transcriptStatuses.has(candidate.transcript_status)) {
      fail(`${tag}.transcript_status 无效（合法值：${[...transcriptStatuses].join(' / ')}）`);
    }
    if (candidate.transcript) {
      if (!candidate.transcript.fingerprint || !/^[0-9a-f]{64}$/.test(candidate.transcript.fingerprint)) {
        fail(`${tag}.transcript.fingerprint 应为 64 位 hex 指纹`);
      }
      if (candidate.transcript.chars !== undefined && (!Number.isInteger(candidate.transcript.chars) || candidate.transcript.chars < 0)) {
        fail(`${tag}.transcript.chars 应为非负整数`);
      }
    }
    // content-summarizer：总结字段（存在时校验格式；summary_key_points 为字符串数组，
    // summarizer 为内部痕迹，summary_generated_at 应为有效时间）
    if (candidate.summary !== undefined && candidate.summary !== null && typeof candidate.summary !== 'string') {
      fail(`${tag}.summary 应为字符串或 null`);
    }
    if (candidate.summary_key_points !== undefined) {
      if (!Array.isArray(candidate.summary_key_points)) fail(`${tag}.summary_key_points 应为数组`);
      else for (const point of candidate.summary_key_points) {
        if (typeof point !== 'string') fail(`${tag}.summary_key_points 元素应为字符串`);
      }
    }
    if (candidate.summary_generated_at !== undefined && Number.isNaN(new Date(candidate.summary_generated_at).getTime())) {
      fail(`${tag}.summary_generated_at 不是有效时间`);
    }
    // content-reviewer：AI 审核建议（存在时校验形状；verdict 三枚举、reasons 字符串数组、
    // confidence 0-1、generated_at 有效时间。ai_review 是内部字段，不进公开投影）
    if (candidate.ai_review !== undefined) {
      if (!candidate.ai_review || typeof candidate.ai_review !== 'object') {
        fail(`${tag}.ai_review 应为对象`);
      } else {
        if (!['approve', 'hold', 'discard'].includes(candidate.ai_review.verdict)) {
          fail(`${tag}.ai_review.verdict 无效（合法值：approve / hold / discard）`);
        }
        if (candidate.ai_review.reasons !== undefined) {
          if (!Array.isArray(candidate.ai_review.reasons)) fail(`${tag}.ai_review.reasons 应为数组`);
          else for (const reason of candidate.ai_review.reasons) {
            if (typeof reason !== 'string') fail(`${tag}.ai_review.reasons 元素应为字符串`);
          }
        }
        if (candidate.ai_review.confidence !== undefined) {
          if (typeof candidate.ai_review.confidence !== 'number' || !Number.isFinite(candidate.ai_review.confidence)
            || candidate.ai_review.confidence < 0 || candidate.ai_review.confidence > 1) {
            fail(`${tag}.ai_review.confidence 应为 0-1 数字`);
          }
        }
        if (candidate.ai_review.generated_at !== undefined && Number.isNaN(new Date(candidate.ai_review.generated_at).getTime())) {
          fail(`${tag}.ai_review.generated_at 不是有效时间`);
        }
      }
    }
    // content-localizer：内容本地化（存在时校验形状；localizations[locale] 的 title/description
    // 为字符串。localizations 是公开字段进投影；localizations_meta 是内部痕迹）
    if (candidate.localizations !== undefined) {
      if (!candidate.localizations || typeof candidate.localizations !== 'object') {
        fail(`${tag}.localizations 应为对象`);
      } else {
        for (const [locale, localized] of Object.entries(candidate.localizations)) {
          if (!localized || typeof localized !== 'object') {
            fail(`${tag}.localizations.${locale} 应为对象`);
            continue;
          }
          if (localized.title !== undefined && typeof localized.title !== 'string') fail(`${tag}.localizations.${locale}.title 应为字符串`);
          if (localized.description !== undefined && typeof localized.description !== 'string') fail(`${tag}.localizations.${locale}.description 应为字符串`);
        }
      }
    }
  }
  console.log(`  hotspot-candidates.json: ${data.candidates.length} 条候选，通过`);
}

function validateReviewEvents(data) {
  if (!data || !Array.isArray(data.events)) return fail('review-events.json.events 应为数组');
  const reviewStatuses = new Set(['pending', 'approved', 'held', 'discarded']);
  for (let i = 0; i < data.events.length; i++) {
    const event = data.events[i];
    const tag = `review-events.json.events[${i}]`;
    // B16 决策 70：追加式审核事件必须包含候选 id 与决策 70 核心字段
    if (!event.candidate_id) fail(`${tag} 缺少 candidate_id`);
    if (!event.action) fail(`${tag} 缺少 action`);
    if (!reviewStatuses.has(event.review_status)) fail(`${tag}.review_status 无效（合法值：${[...reviewStatuses].join(' / ')}）`);
    if (event.reviewed_at !== undefined && Number.isNaN(new Date(event.reviewed_at).getTime())) fail(`${tag}.reviewed_at 不是有效时间`);
    if (event.candidate_version !== undefined && (!Number.isInteger(event.candidate_version) || event.candidate_version < 1)) {
      fail(`${tag}.candidate_version 应为正整数`);
    }
    if (event.batch_id !== undefined && !String(event.batch_id).trim()) fail(`${tag}.batch_id 不能为空`);
  }
  console.log(`  review-events.json: ${data.events.length} 条审核事件，通过`);
}

function validateManualItems(data) {
  if (!data || !Array.isArray(data.items)) return fail('news-manual-items.json.items 应为数组');
  const sources = JSON.parse(fs.readFileSync(NEWS_FILES.sources, 'utf8')).sources;
  const { normalizeManualItem } = require('../content/news-manual');
  const keys = new Set();
  for (let index = 0; index < data.items.length; index++) {
    try {
      const item = normalizeManualItem(data.items[index], sources, data.items[index].fetched_at || new Date().toISOString());
      const key = `bilibili:${item.native_id}`;
      if (keys.has(key)) fail(`news-manual-items.json 内容重复: ${key}`);
      keys.add(key);
    } catch (error) { fail(`news-manual-items.json.items[${index}] ${error.message}`); }
  }
  console.log(`  news-manual-items.json: ${data.items.length} 条人工内容，通过`);
}

function validateNewsConfig(data) {
  const layers = data?.time_layers;
  if (!Array.isArray(layers) || layers.length !== 5) return fail('news-config.json.time_layers 应为五层');
  if (!['manual', 'rsshub'].includes(data?.collection?.bilibili_collection_mode)) fail('news-config.json collection.bilibili_collection_mode 应为 manual 或 rsshub');
  let boundary = 0;
  for (const layer of layers) {
    if (layer.min_age_days !== boundary || layer.max_age_days <= boundary) fail(`时间层不连续: ${layer.id}`);
    boundary = layer.max_age_days;
  }
  if (boundary !== 270) fail('时间层最远边界应为270天');
  console.log('  news-config.json: 五层时间边界连续，通过');
}

// ═══════════════════════════════════════════════════════════════
// 第 4 组：hotspots.json — 前端热点投影引用完整性
//
// 核心约束：
//   - items/events/provenance/assessments 均为数组
//   - 每条内容有完整的 id/platform/content_type/url/title/日期
//   - events 的 content_ids 必须引用存在的 items
//   - provenance 的 content_id 必须引用存在的 items
//   - 商业扣分(penalty>0)必须有 evidence 数组且至少一条证据
//   - 异常调整(adjustment≠0 且非insufficient_sample)必须有 evidence
// ═══════════════════════════════════════════════════════════════
function validateHotspots(data) {
  if (!data || !Array.isArray(data.items)) {
    fail('hotspots.json.items 应为数组');
    return;
  }
  for (const key of ['events', 'provenance', 'assessments']) {
    if (!Array.isArray(data[key])) fail(`hotspots.json.${key} 应为数组`);
  }
  const contentIds = new Set();
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    const tag = `hotspots.json.items[${i}] (${item.title || '未知'})`;
    checkRequired(item, tag, ['id', 'platform', 'native_id', 'source_type', 'url', 'title', 'published_at', 'source_id', 'metrics']);
    if (contentIds.has(item.id)) fail(`${tag}.id 重复: ${item.id}`);
    contentIds.add(item.id);
    if (!NEWS_PLATFORMS.includes(item.platform)) fail(`${tag}.platform 不支持: ${item.platform}`);
    if (!SOURCE_TYPES.includes(item.source_type)) fail(`${tag}.source_type 不支持: ${item.source_type}`);
    if (item.content_type !== undefined && !CONTENT_TYPES.includes(item.content_type)) fail(`${tag}.content_type 不支持: ${item.content_type}`);
    if (Number.isNaN(new Date(item.published_at).getTime())) fail(`${tag}.published_at 不是有效日期`);
    if (item.metrics && typeof item.metrics !== 'object') fail(`${tag}.metrics 应为对象`);
    // B16 决策 74/77/85/88/89：公开热点数据契约补充字段（可选字段，存在才校验）
    if (item.hot_score !== undefined && item.hot_score !== null && !(typeof item.hot_score === 'number' && item.hot_score >= 0 && item.hot_score <= 100)) {
      fail(`${tag}.hot_score 应为 0–100 数值或 null`);
    }
    if (item.evidence_excerpt !== undefined && item.evidence_excerpt !== null && typeof item.evidence_excerpt !== 'string') {
      fail(`${tag}.evidence_excerpt 应为字符串或 null`);
    }
    // content-summarizer：公开 summary 字段（存在时校验格式；仅经人工审核 approved 的候选才会带）
    if (item.summary !== undefined && item.summary !== null && typeof item.summary !== 'string') {
      fail(`${tag}.summary 应为字符串或 null`);
    }
    if (item.summary_key_points !== undefined) {
      if (!Array.isArray(item.summary_key_points)) fail(`${tag}.summary_key_points 应为数组`);
      else for (const point of item.summary_key_points) {
        if (typeof point !== 'string') fail(`${tag}.summary_key_points 元素应为字符串`);
      }
    }
    if (item.related_resources !== undefined) {
      if (!Array.isArray(item.related_resources)) fail(`${tag}.related_resources 应为数组`);
      else for (const [resourceIndex, resource] of item.related_resources.entries()) {
        const resourceTag = `${tag}.related_resources[${resourceIndex}]`;
        if (!resource || typeof resource !== 'object') { fail(`${resourceTag} 应为对象`); continue; }
        if (!['tool', 'concept', 'scene'].includes(resource.type)) fail(`${resourceTag}.type 应为 tool/concept/scene`);
        if (!resource.id || typeof resource.id !== 'string') fail(`${resourceTag}.id 应为非空字符串`);
      }
    }
    // content-localizer：公开 localizations 字段（存在时校验形状；与候选层同规则。
    // 内部痕迹 localizations_meta 已由 INTERNAL_FIELDS 剔除，不应出现在公开投影）
    if (item.localizations !== undefined) {
      if (!item.localizations || typeof item.localizations !== 'object') {
        fail(`${tag}.localizations 应为对象`);
      } else {
        for (const [locale, localized] of Object.entries(item.localizations)) {
          if (!localized || typeof localized !== 'object') {
            fail(`${tag}.localizations.${locale} 应为对象`);
            continue;
          }
          if (localized.title !== undefined && typeof localized.title !== 'string') fail(`${tag}.localizations.${locale}.title 应为字符串`);
          if (localized.description !== undefined && typeof localized.description !== 'string') fail(`${tag}.localizations.${locale}.description 应为字符串`);
        }
      }
    }
    if (item.localizations_meta !== undefined) fail(`${tag}.localizations_meta 是内部字段，不应出现在公开投影`);
  }
  if (data.heat_definition !== undefined && typeof data.heat_definition !== 'string') {
    fail('hotspots.json.heat_definition 应为字符串');
  }

  for (const event of data.events || []) {
    for (const contentId of event.content_ids || []) {
      if (!contentIds.has(contentId)) fail(`hotspots.json event ${event.id} 引用了不存在的 content_id: ${contentId}`);
    }
  }
  for (const relation of data.provenance || []) {
    if (!contentIds.has(relation.content_id)) fail(`hotspots.json provenance 引用了不存在的 content_id: ${relation.content_id}`);
  }
  for (const assessment of data.assessments || []) {
    if (!contentIds.has(assessment.content_id)) fail(`hotspots.json assessment 引用了不存在的 content_id: ${assessment.content_id}`);
    const commercial = assessment.commercial_assessment;
    if (commercial?.penalty > 0 && (!Array.isArray(commercial.evidence) || commercial.evidence.length === 0)) {
      fail(`hotspots.json assessment ${assessment.content_id} 商业扣分缺少证据`);
    }
    const anomaly = assessment.anomaly_assessment;
    if (anomaly?.status !== 'insufficient_sample' && anomaly?.adjustment !== 0 && (!anomaly.evidence || anomaly.evidence.length === 0)) {
      fail(`hotspots.json assessment ${assessment.content_id} 异常调整缺少依据`);
    }
  }
  if (!data.coverage || typeof data.coverage !== 'object') fail('hotspots.json.coverage 缺失');
  console.log(`  hotspots.json: ${data.items.length} 条内容 · ${(data.events || []).length} 个主题，通过`);
}

// ═══════════════════════════════════════════════════════════════
// 热点管线 v2 候选层（min-candidates.json，单状态轴）校验
//
// v2 与旧候选层解耦：无 ai_processing_status 轴，review_status 只取
// pending/approved/discarded（MIN_REVIEW_STATUSES，读自 min-store）。
// 文件不存在 → 优雅跳过（v2 管线未首跑，不阻塞）；空候选 → 通过。
// 硬错误走 fail()（计入本模块 failed，由 validate.js 聚合退出码）；
// approved 缺公开字段（title/url/published_at）只告警不阻塞。
// ═══════════════════════════════════════════════════════════════
function validateMinNews() {
  const file = NEWS_FILES.minCandidates;
  const errors = [];
  const warnings = [];

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.log('  min-candidates.json: 文件不存在（v2 管线未首跑），优雅跳过');
      return { valid: true, errors, warnings };
    }
    const message = `min-candidates.json 解析失败：${error.message}`;
    errors.push(message);
    fail(message);
    return { valid: false, errors, warnings };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const message = 'min-candidates.json 顶层应为对象';
    errors.push(message);
    fail(message);
    return { valid: false, errors, warnings };
  }

  // 顶层 schema：schema_version 为缺省 1；缺失仅告警（createMinStore 容缺省），
  // 存在但非法（非正整数）则报错。
  if (data.schema_version !== undefined
    && (!Number.isInteger(data.schema_version) || data.schema_version < 1)) {
    const message = 'min-candidates.json.schema_version 应为正整数';
    errors.push(message);
    fail(message);
  } else if (data.schema_version === undefined) {
    warnings.push('min-candidates.json 缺少 schema_version（缺省按 1 处理）');
    console.warn('⚠️  min-candidates.json 缺少 schema_version（缺省按 1 处理）');
  }

  if (!Array.isArray(data.candidates)) {
    const message = 'min-candidates.json.candidates 应为数组';
    errors.push(message);
    fail(message);
    return { valid: false, errors, warnings };
  }

  const ids = new Set();
  for (let i = 0; i < data.candidates.length; i++) {
    const candidate = data.candidates[i];
    const tag = `min-candidates.json.candidates[${i}] (${(candidate && candidate.title) || '未知'})`;
    if (!candidate || typeof candidate !== 'object') {
      const message = `${tag} 应为对象`;
      errors.push(message);
      fail(message);
      continue;
    }
    // v2 单状态轴候选：id 非空且唯一
    if (!candidate.id || ids.has(candidate.id)) {
      const message = `${tag}.id 缺失或重复: ${candidate.id}`;
      errors.push(message);
      fail(message);
    }
    ids.add(candidate.id);
    // review_status 必须 ∈ MIN_REVIEW_STATUSES（pending/approved/discarded）
    if (!MIN_REVIEW_STATUSES.includes(candidate.review_status)) {
      const message = `${tag}.review_status 无效（合法值：${MIN_REVIEW_STATUSES.join(' / ')}）`;
      errors.push(message);
      fail(message);
    }
    // platform 必须合法（youtube / x / bilibili）
    if (!NEWS_PLATFORMS.includes(candidate.platform)) {
      const message = `${tag}.platform 不支持: ${candidate.platform}`;
      errors.push(message);
      fail(message);
    }
    // 公开字段完整性：approved 候选必须有 title/url/published_at（不全告警，不阻塞）
    if (candidate.review_status === 'approved') {
      for (const field of ['title', 'url', 'published_at']) {
        const value = candidate[field];
        if (value === undefined || value === null || value === '') {
          const message = `${tag} 已 approved 但缺少公开字段 ${field}`;
          warnings.push(message);
          console.warn(`⚠️  ${message}`);
        }
      }
    }
  }

  if (errors.length === 0) {
    console.log(`  min-candidates.json: ${data.candidates.length} 条候选（v2 单状态轴），通过`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

// ═══════════════════════════════════════════════════════════════
// news 域入口：按顺序校验所有新闻配置、人工内容和运行时数据
//
// 每个文件独立 try/catch —— 一个文件的 JSON 解析失败
// 不会阻止后续文件的校验，确保一次运行暴露所有问题。
// ═══════════════════════════════════════════════════════════════
function validateNews() {
  // news-sources.json
  try {
    validateNewsSources(JSON.parse(fs.readFileSync(NEWS_FILES.sources, 'utf8')));
  } catch (e) {
    fail(`news-sources.json 解析失败：${e.message}`);
  }

  // 其余新闻配置、人工内容和运行时数据
  for (const [name, file, validator] of [
    ['news-config.json', NEWS_FILES.config, validateNewsConfig],
    ['news-manual-items.json', NEWS_FILES.manualItems, validateManualItems],
    ['news-registry.json', NEWS_FILES.registry, validateNewsRegistry],
    ['news-quota.json', NEWS_FILES.quota, validateNewsQuota],
    ['pending-authorizations.json', NEWS_FILES.authorizations, validateAuthorizations],
    ['hotspot-candidates.json', NEWS_FILES.candidates, validateNewsCandidates],
    ['review-events.json', NEWS_FILES.reviewEvents, validateReviewEvents],
  ]) {
    try {
      validator(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      fail(`${name} 解析失败：${e.message}`);
    }
  }

  // hotspots.json
  try {
    validateHotspots(JSON.parse(fs.readFileSync(NEWS_FILES.hotspots, 'utf8')));
  } catch (e) {
    fail(`hotspots.json 解析失败：${e.message}`);
  }
}

module.exports = { validateNews, validateMinNews, get failed() { return failed; } };
