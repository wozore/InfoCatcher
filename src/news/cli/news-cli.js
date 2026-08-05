/**
 * news-cli.js —— 热点运维命令行入口（零依赖，仅依赖项目内模块）
 *
 * 在热点管线中的位置：供维护者在终端手动运行，不与浏览器或 GitHub Actions 直接交互。
 * 所有命令只修改 JSON 数据文件，不修改采集核心代码。
 *
 * 命令分组：
 *
 *   source —— 来源管理
 *     source add     --platform youtube|bilibili|x --external-id ... --name ... --url ... --language ... --tag ...
 *     source import  --file <json> [--dry-run] [--allow-partial]
 *     source enable  --id ...
 *     source disable --id ...
 *
 *     - add: 单条添加，校验平台 ID 格式、HTTPS 主页、标签合法、同平台不重复。
 *     - import: 批量导入，默认全有或全无（atomic），--allow-partial 才写入有效条目。
 *     - enable/disable: 切换来源启用状态，不删除数据。
 *
 *   authorization —— 授权任务处理
 *     authorization list
 *     authorization continue    --id ... --until <days> [--max-quota ...] [--note ...]
 *     authorization until-first --id ... --earliest <days> --max-pages ... [--max-quota ...] [--note ...]
 *     authorization skip        --id ...
 *     authorization stop        --id ...
 *
 *   quota —— 额度管理
 *     quota resume --platform youtube|bilibili --reason ...
 *     （记录决策和时间，不修改余额；下一次构建创建新预算后自动恢复）
 *
 *   lock —— 构建锁管理
 *     lock status
 *     lock force-unlock --reason ...
 *     （status 只读；force-unlock 删除锁并写入审计，必须提供 reason）
 *
 *   registry —— Registry 保留策略（N-P2）
 *     registry prune   [--apply] [--retention-days <n>]
 *     （默认 dry-run 只预览将裁剪的记录数；--apply 才实际裁剪并归档到
 *       news-registry-pruned.json（含 run_id/规则/时间 + 记录全文，可回滚）；
 *       裁剪依据 last_seen_at 超 retention_days 天（默认取 news-config.json
 *       的 registry_retention_days=270，与采集回溯窗口一致）；
 *       build-news 每轮结束也会自动执行同等裁剪）
 *
 *   review —— 热点审核状态管理（B16 决策 46/48/50/55/56/57/69/70）
 *     review list    [--status pending|approved|held|discarded] [--platform ...] [--limit N]
 *     review summary
 *     review set     --id <id> --status pending|approved|held|discarded [--reason ...] [--reviewer ...]
 *     review batch   --ids <id1,id2,...> --status approved [--reason ...] [--reviewer ...]
 *     review log     [--candidate-id <id>] [--action ...] [--limit N]
 *     （set 单条设置审核状态；batch 只处理显式列出的 ids，不支持隐式「全部」；
 *       ai_processing_status 未 completed 时禁止设为 approved；
 *       每次流转写入 reviewer / reviewed_at / from_status / candidate_version，决策 70；
 *       每次流转同时追加到追加式审核事件日志 review-events.json（决策 70：只追加、不改写历史），
 *       review log 用于查看历史流转记录；
 *       --reviewer 缺省回退到 GITHUB_ACTOR / USER / cli）
 *
 *   transcript —— 视频字幕/文字稿处理（B16 决策 51/52/54/61/67）
 *     transcript status --id <id>
 *     transcript fetch  --id <id> [--base-url ...] [--lang ...]
 *     （fetch 尝试获取 YouTube 自动字幕：缺失/过短 → held，技术失败 → error；
 *       成功且此前因字幕原因 held 的候选重置为 pending 等待复审，决策 52；
 *       完整字幕写入 data/news/runtime/transcripts/，不进 PR）
 *
 *   legacy —— 旧热点数据迁移（B16 决策 64）
 *     legacy import   [--dry-run]
 *     legacy status
 *     （import 把旧 hotspots.json 导入内部候选层，标记 legacy 并以 pending
 *       进入待审核流程，不自动公开；只导入候选层中尚不存在的 id；
 *       --dry-run 只打印将导入的条数，不写文件；
 *       导入后通过 review set/batch --status approved 逐条/批量审核，
 *       再运行 publish-news.js 重建公开投影，决策 64/59）
 *
 * 安全约束：
 *   - 不接受 --api-key 等凭据参数；API Key 只能由 GitHub Secrets 注入。
 *   - 校验 external_id 格式：YouTube → UC 开头、B站 → 纯数字 UID、X → 有效用户名。
 *   - 校验 profile_url 必须使用 HTTPS。
 *   - 校验 content_tags 必须来自允许列表。
 *
 * 扩展点：
 *   - 新增平台：在 PLATFORMS Set 和 validateSource() 的 ID 格式校验中增加对应分支。
 *   - 新增命令组：参照 source/authorization/quota/lock 模式，在 main() 增加 else-if 分支。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic, inspectLock, forceUnlock, acquireLock, releaseLock } = require('../core/news-storage');
const { createRegistry, pruneRegistry } = require('../core/news-registry');
const { createAuthorizationStore, decideAuthorization } = require('../core/news-authorization');
const { normalizeManualItem, importManualItems } = require('../../content/news-manual');
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
const {
  fetchYouTubeTranscript,
  applyTranscriptOutcome,
  storeTranscript,
} = require('../collectors/news-transcripts');
const { NEWS_FILES } = require('../../shared/paths');
const {
  classifyCandidate,
  classifyCandidates,
  confirmContentType,
} = require('../classify/content-classifier');

/** CLI 操作的目标数据文件（均为绝对路径） */
const FILES = {
  sources: NEWS_FILES.sources,
  authorizations: NEWS_FILES.authorizations,
  quota: NEWS_FILES.quota,
  registry: NEWS_FILES.registry,
  manualItems: NEWS_FILES.manualItems,
  lock: NEWS_FILES.lock,
  audit: NEWS_FILES.adminAudit,
  candidates: NEWS_FILES.candidates,
  config: NEWS_FILES.config,
  registryPruned: NEWS_FILES.registryPruned,
};

const PLATFORMS = new Set(['youtube', 'bilibili', 'x']);
const ALLOWED_TAGS = new Set(['横向测评', '即时资讯', '深度解读', '教程实践', '行业观点', '轻度用户体验', '官方来源']);

// ── CLI 参数解析 ──────────────────────────────────────────

/**
 * 解析命令行参数。
 * --key value  → flags.key = 'value'
 * --flag       → flags.flag = true
 * 其余参数      → positional[]
 */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2).replace(/-/g, '_');
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; index += 1; }
  }
  return { positional, flags };
}

// ── 工具函数 ──────────────────────────────────────────────

function slug(value) {
  return String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '') || 'source';
}

/** 标准化标签：支持数组或逗号/顿号分隔字符串 */
function normalizeTags(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[、,，]/);
  return [...new Set(values.map(tag => tag.trim()).filter(Boolean))];
}

/**
 * 安全解析数值型 CLI 参数。
 * 使用 !== undefined 而非真值判断，确保 --max-quota 0 等显式零值
 * 能被正确传递到授权层，由授权层的正整数检查拒绝。
 */
function optionalNumber(flags, key, suffix = '') {
  return flags[key] !== undefined ? Number(String(flags[key]).replace(new RegExp(`${suffix}$`), '')) : undefined;
}

/** 审核者标识：--reviewer 优先，其次 GITHUB_ACTOR，再次本地用户，最后 fallback cli */
function resolveReviewer(flags) {
  return flags.reviewer || process.env.GITHUB_ACTOR || process.env.USER || process.env.USERNAME || 'cli';
}

// ── 来源校验 ──────────────────────────────────────────────

/**
 * 校验并标准化一条来源输入。
 * 校验项：
 *   - platform 合法
 *   - external_id 格式匹配平台规则
 *   - profile_url 使用 HTTPS
 *   - content_tags 来自允许列表
 *   - 不与现有来源的 (platform, external_id) 重复
 *
 * @param {object} input 用户提供的来源字段
 * @param {Array} existing 已存在的来源列表（用于去重）
 * @returns {object} 标准化后的来源对象
 */
function validateSource(input, existing = []) {
  if (!PLATFORMS.has(input.platform)) throw new Error(`无效 platform: ${input.platform}`);
  if (!input.external_id) throw new Error('缺少 external_id');
  if (!input.name) throw new Error('缺少 name');

  let url;
  try { url = new URL(input.profile_url); } catch { throw new Error('profile_url 不是有效 URL'); }
  if (url.protocol !== 'https:') throw new Error('profile_url 必须使用 HTTPS');

  // 平台 ID 格式校验
  if (input.platform === 'youtube' && !/^UC[A-Za-z0-9_-]{20,}$/.test(input.external_id)) throw new Error('YouTube external_id 必须是 UC 开头的 Channel ID');
  if (input.platform === 'bilibili' && !/^\d+$/.test(input.external_id)) throw new Error('Bilibili external_id 必须是数字 UID');
  if (input.platform === 'x' && !/^[A-Za-z0-9_]{1,15}$/.test(input.external_id.replace(/^@/, ''))) throw new Error('X external_id 必须是有效用户名');

  const tags = normalizeTags(input.content_tags);
  if (!tags.length || tags.some(tag => !ALLOWED_TAGS.has(tag))) throw new Error('content_tags 缺失或包含未知标签');

  // 同平台去重（大小写不敏感）
  const normalizedExternalId = input.platform === 'x' ? input.external_id.replace(/^@/, '') : input.external_id;
  if (existing.some(source => source.platform === input.platform && String(source.external_id).toLowerCase() === normalizedExternalId.toLowerCase())) {
    throw new Error(`来源已存在: ${input.platform}:${normalizedExternalId}`);
  }

  return {
    id: `${input.platform}-${slug(normalizedExternalId)}`,
    platform: input.platform,
    external_id: normalizedExternalId,
    handle: input.platform === 'x' ? normalizedExternalId : null,
    name: input.name,
    profile_url: url.toString(),
    language: ['zh', 'en'].includes(input.language) ? input.language : 'unknown',
    primary_type: input.primary_type || null,
    content_tags: tags,
    original_tags: normalizeTags(input.original_tags),
    cadence_class: ['low_frequency', 'high_frequency'].includes(input.cadence_class) ? input.cadence_class : 'unknown',
    enabled: input.enabled !== false,
    collector: input.platform === 'youtube' ? 'youtube_rss' : input.platform === 'x' ? 'twitterapi_io' : 'rsshub_bilibili',
    reliability_prior: Number(input.reliability_prior || 50),
    quality_prior: Number(input.quality_prior || 50),
    active_60d: null,
    evidence_url: url.toString(),
    checked_at: new Date().toISOString().slice(0, 10),
    notes: input.notes || '',
    needs_review: false,
    review_notes: [],
  };
}

/**
 * 批量导入来源。
 * 默认原子操作：所有输入都通过校验后才写入，任一条失败则全部回滚。
 * 传入 allowPartial=true 时，只写入通过校验的条目。
 *
 * @returns {{ added: Array, errors: Array, committed: boolean }}
 */
function importSources(payload, inputs, allowPartial = false) {
  const sourceInputs = Array.isArray(inputs) ? inputs : inputs.sources;
  if (!Array.isArray(sourceInputs)) throw new Error('导入文件必须是数组或包含 sources 数组');
  const staged = [];
  const errors = [];
  for (let index = 0; index < sourceInputs.length; index += 1) {
    try { staged.push(validateSource(sourceInputs[index], [...payload.sources, ...staged])); }
    catch (error) { errors.push({ index, error: error.message }); }
  }
  if (errors.length && !allowPartial) return { added: [], errors, committed: false };
  payload.sources.push(...staged);
  return { added: staged, errors, committed: staged.length > 0 };
}

/** 统一 JSON 写入入口 */
function save(file, value, prefix = 'cli') {
  writeJsonAtomic(file, value, `${prefix}-${Date.now()}`);
}

// ── 命令实现 ──────────────────────────────────────────────

function sourceCommand(action, flags) {
  const payload = readJson(FILES.sources, { schema_version: 1, sources: [] });

  if (action === 'add') {
    const source = validateSource({
      platform: flags.platform, external_id: flags.external_id, name: flags.name,
      profile_url: flags.url, language: flags.language, content_tags: normalizeTags(flags.tag || flags.tags),
      primary_type: flags.primary_type, cadence_class: flags.cadence,
      quality_prior: flags.quality_prior, notes: flags.notes,
    }, payload.sources);
    payload.sources.push(source);
    payload.generated_at = new Date().toISOString();
    save(FILES.sources, payload, 'source-add');
    return { added: source.id };
  }

  if (action === 'import') {
    if (!flags.file) throw new Error('source import 缺少 --file');
    const input = JSON.parse(fs.readFileSync(path.resolve(flags.file), 'utf8'));
    const result = importSources(payload, input, Boolean(flags.allow_partial));
    if (!flags.dry_run && result.committed) {
      payload.generated_at = new Date().toISOString();
      save(FILES.sources, payload, 'source-import');
    }
    return { ...result, dry_run: Boolean(flags.dry_run) };
  }

  if (action === 'enable' || action === 'disable') {
    const source = payload.sources.find(item => item.id === flags.id);
    if (!source) throw new Error(`来源不存在: ${flags.id}`);
    source.enabled = action === 'enable';
    payload.generated_at = new Date().toISOString();
    save(FILES.sources, payload, `source-${action}`);
    return { id: source.id, enabled: source.enabled };
  }

  throw new Error(`未知 source 命令: ${action}`);
}

function contentCommand(action, flags) {
  const initialPayload = readJson(FILES.manualItems, { schema_version: 1, updated_at: null, items: [] });
  if (action === 'list') return initialPayload.items;
  const sources = readJson(FILES.sources, { sources: [] }).sources;

  const rejectDuplicates = (payload, registry, items) => {
    for (const item of items) {
      if (payload.items.some(entry => entry.native_id === item.native_id)) throw new Error(`人工内容已存在: bilibili:${item.native_id}`);
      if (registry.videos?.[`bilibili:${item.native_id}`]) throw new Error(`Registry 已存在: bilibili:${item.native_id}`);
    }
  };

  if (action === 'add') {
    const item = normalizeManualItem({
      source_id: flags.source_id,
      source_type: flags.type,
      url: flags.url,
      title: flags.title,
      description: flags.summary,
      published_at: flags.published_at,
    }, sources);
    rejectDuplicates(initialPayload, readJson(FILES.registry, { videos: {} }), [item]);
    if (flags.dry_run) return { added: item, dry_run: true };

    const runId = `manual-content-${Date.now()}`;
    acquireLock(FILES.lock, { run_id: runId, pid: process.pid, started_at: new Date().toISOString(), operation: 'manual_content_add' });
    try {
      const payload = readJson(FILES.manualItems, { schema_version: 1, updated_at: null, items: [] });
      rejectDuplicates(payload, readJson(FILES.registry, { videos: {} }), [item]);
      payload.items.push(item);
      payload.updated_at = new Date().toISOString();
      save(FILES.manualItems, payload, 'content-add');
    } finally { releaseLock(FILES.lock, runId); }
    return { added: item.native_id, dry_run: false };
  }

  if (action === 'import') {
    if (!flags.file) throw new Error('content import 缺少 --file');
    const input = JSON.parse(fs.readFileSync(path.resolve(flags.file), 'utf8'));
    const previewPayload = structuredClone(initialPayload);
    const preview = importManualItems(previewPayload, input, sources, Boolean(flags.allow_partial));
    rejectDuplicates(initialPayload, readJson(FILES.registry, { videos: {} }), preview.added);
    if (flags.dry_run || !preview.committed) {
      return { ...preview, added: preview.added.map(item => item.native_id), dry_run: Boolean(flags.dry_run) };
    }

    const runId = `manual-content-import-${Date.now()}`;
    acquireLock(FILES.lock, { run_id: runId, pid: process.pid, started_at: new Date().toISOString(), operation: 'manual_content_import' });
    try {
      const payload = readJson(FILES.manualItems, { schema_version: 1, updated_at: null, items: [] });
      const result = importManualItems(payload, input, sources, Boolean(flags.allow_partial));
      const registry = readJson(FILES.registry, { videos: {} });
      for (const item of result.added) {
        if (registry.videos?.[`bilibili:${item.native_id}`]) throw new Error(`Registry 已存在: bilibili:${item.native_id}`);
      }
      if (result.committed) {
        payload.updated_at = new Date().toISOString();
        save(FILES.manualItems, payload, 'content-import');
      }
      return { ...result, added: result.added.map(item => item.native_id), dry_run: false };
    } finally { releaseLock(FILES.lock, runId); }
  }

  throw new Error(`未知 content 命令: ${action}`);
}

function authorizationCommand(action, flags) {
  const store = createAuthorizationStore(readJson(FILES.authorizations, null));
  if (action === 'list') return store.tasks.filter(task => task.status === 'pending');

  const mapping = { continue: 'continue', 'until-first': 'until-first', skip: 'skip', stop: 'stop' };
  if (!mapping[action]) throw new Error(`未知 authorization 命令: ${action}`);

  const task = decideAuthorization(store, flags.id, mapping[action], {
    until_days: optionalNumber(flags, 'until', 'd'),
    earliest_days: optionalNumber(flags, 'earliest', 'd'),
    max_pages: optionalNumber(flags, 'max_pages'),
    max_quota: optionalNumber(flags, 'max_quota'),
    operator_note: flags.note || '',
  });
  save(FILES.authorizations, store, 'authorization');
  return task;
}

function quotaCommand(action, flags) {
  if (action !== 'resume') throw new Error(`未知 quota 命令: ${action}`);
  if (!PLATFORMS.has(flags.platform) || !flags.reason) throw new Error('quota resume 需要有效 --platform 和 --reason');
  const quota = readJson(FILES.quota, { schema_version: 1, resume_events: [] });
  quota.resume_events ||= [];
  quota.resume_events.push({ platform: flags.platform, reason: flags.reason, at: new Date().toISOString() });
  save(FILES.quota, quota, 'quota-resume');
  return quota.resume_events.at(-1);
}

function lockCommand(action, flags) {
  if (action === 'status') return inspectLock(FILES.lock);
  if (action === 'force-unlock') return { removed: forceUnlock(FILES.lock, flags.reason, FILES.audit) };
  throw new Error(`未知 lock 命令: ${action}`);
}

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

// ── 入口 ──────────────────────────────────────────────────

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

// ── classify 命令组：热点内容类型分类（B16 路径 A）─────
//
//   classify preview   --title <t> [--description <d>]    预览单条分类（不写入）
//   classify candidates [--provider <id>] [--model <m>]   对候选层跑分类建议（ai_suggested，不覆盖已 reviewed）
//   classify hotspots  [--provider <id>] [--model <m>]    对公开热点跑分类建议（过渡用途；真实路径 A 走候选层）
//   classify confirm   [--reviewer <name>]                批量确认：ai_suggested → reviewed（接受分类建议，人工审核确认）
//
// L0 规则式分类零成本、可离线（默认，不配 --provider 时）。L1 AI 分类：
// --provider deepseek 走 DeepSeek（需环境变量 DEEPSEEK_API_KEY，缺 key 时自动回退 L0，
// 不阻塞）；--model 可覆盖默认 deepseek-chat（b16-task-status.md 第 4 项成本提醒）。

async function classifyCommand(action, flags) {
  const classifyOptions = { provider: flags.provider, model: flags.model };
  if (action === 'preview') {
    const title = flags.title || '';
    const description = flags.description || '';
    if (!title && !description) throw new Error('classify preview 需要 --title 或 --description');
    return classifyCandidate({ title, description }, classifyOptions);
  }

  if (action === 'candidates') {
    const store = readCandidateStore();
    const result = await classifyCandidates(store.candidates, classifyOptions);
    if (result.classified > 0) {
      writeCandidateStore({ ...store, candidates: result.items }, `classify-candidates-${Date.now()}`);
    }
    return { classified: result.classified, skipped: result.skipped, total: (store.candidates || []).length };
  }

  if (action === 'hotspots') {
    const data = readJson(NEWS_FILES.hotspots, { items: [] });
    const result = await classifyCandidates(data.items, classifyOptions);
    if (result.classified > 0) {
      writeJsonAtomic(NEWS_FILES.hotspots, { ...data, items: result.items }, `classify-hotspots-${Date.now()}`);
    }
    return { classified: result.classified, skipped: result.skipped, total: (data.items || []).length };
  }

  // 批量确认：接受 ai_suggested 建议 → reviewed（人工审核确认，记录 reviewer/时间）
  if (action === 'confirm') {
    const data = readJson(NEWS_FILES.hotspots, { items: [] });
    const reviewer = resolveReviewer(flags);
    let confirmed = 0;
    for (const item of data.items || []) {
      if (item && item.content_type_status === 'ai_suggested' && item.content_type && item.content_type !== 'unclassified') {
        confirmContentType(item, item.content_type, { reviewer });
        confirmed++;
      }
    }
    if (confirmed > 0) {
      writeJsonAtomic(NEWS_FILES.hotspots, data, `confirm-hotspots-${Date.now()}`);
    }
    return { confirmed, total: (data.items || []).length, reviewer };
  }

  throw new Error(`未知 classify 命令: ${action}`);
}

// ── transcript 命令组：视频字幕/文字稿处理（B16 决策 51/52/54/61/67）─────

/** 从 news-config.json 读取字幕获取配置；CLI 标志可覆盖（--base-url / --lang）。 */
function readTranscriptConfig(flags) {
  const config = readJson(FILES.config, { schema_version: 1, collection: {} });
  const c = config.collection || {};
  return {
    baseUrl: flags.base_url || c.transcript_base_url || 'https://www.youtube.com/api/timedtext',
    languages: flags.lang ? [flags.lang] : (c.transcript_languages || ['zh-Hans', 'zh-Hant', 'zh', 'en']),
    minChars: c.transcript_min_chars ?? 80,
    timeoutMs: c.transcript_timeout_ms ?? 10000,
  };
}

async function transcriptCommand(action, flags) {
  const store = readCandidateStore();

  if (action === 'status') {
    if (!flags.id) throw new Error('transcript status 缺少 --id');
    const candidate = store.candidates.find(item => item.id === flags.id);
    if (!candidate) throw new Error(`候选不存在：${flags.id}`);
    return {
      id: candidate.id,
      platform: candidate.platform,
      transcript_status: candidate.transcript_status || null,
      transcript: candidate.transcript || null,
      review_status: candidate.review_status,
      ai_processing_status: candidate.ai_processing_status,
      hold_reason: candidate.hold_reason || null,
      error_type: candidate.error_type || null,
    };
  }

  if (action === 'fetch') {
    if (!flags.id) throw new Error('transcript fetch 缺少 --id');
    const candidate = store.candidates.find(item => item.id === flags.id);
    if (!candidate) throw new Error(`候选不存在：${flags.id}`);
    if (candidate.platform !== 'youtube') throw new Error(`候选 ${flags.id} 不是 YouTube 内容；字幕处理仅适用于 YouTube（B站采集已搁置，决策 52）`);
    const config = readTranscriptConfig(flags);
    const result = await fetchYouTubeTranscript(candidate.native_id, {
      baseUrl: config.baseUrl, languages: config.languages,
      minChars: config.minChars, timeoutMs: config.timeoutMs,
    });
    const wasHeld = candidate.review_status === 'held';
    const reviewStatusBefore = candidate.review_status;
    applyTranscriptOutcome(candidate, result);
    if (result.ok) {
      if (wasHeld) candidate.review_status = 'pending'; // 决策 52：补充字幕后重新置为 pending 再审核
      storeTranscript(candidate, result, { runId: `transcript-fetch-${candidate.id}` });
    }
    writeCandidateStore(store, `transcript-fetch-${Date.now()}`);
    // 决策 70：字幕导致的审核状态变化（held / 恢复为 pending）也追加到只追加审核事件日志
    if (candidate.review_status !== reviewStatusBefore) {
      const action = candidate.review_status === 'held' ? 'transcript_auto_hold' : 'transcript_recovery';
      recordReviewTransition(candidate, { action, reason: candidate.hold_reason || null, reviewer: resolveReviewer(flags) });
    }
    return {
      id: candidate.id,
      transcript_status: candidate.transcript_status,
      review_status: candidate.review_status,
      ai_processing_status: candidate.ai_processing_status,
      hold_reason: candidate.hold_reason || null,
      error_type: candidate.error_type || null,
      result: result.ok
        ? { ok: true, language: result.language, chars: result.chars, fingerprint: result.fingerprint }
        : { ok: false, reason: result.reason },
    };
  }

  throw new Error(`未知 transcript 命令: ${action}`);
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

async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const [group, action] = positional;
  let result;
  if (group === 'source') result = sourceCommand(action, flags);
  else if (group === 'content') result = contentCommand(action, flags);
  else if (group === 'authorization') result = authorizationCommand(action, flags);
  else if (group === 'quota') result = quotaCommand(action, flags);
  else if (group === 'lock') result = lockCommand(action, flags);
  else if (group === 'registry') result = registryCommand(action, flags);
  else if (group === 'review') result = reviewCommand(action, flags);
  else if (group === 'classify') result = await classifyCommand(action, flags);
  else if (group === 'transcript') result = await transcriptCommand(action, flags);
  else if (group === 'legacy') result = legacyCommand(action, flags);
  else throw new Error('用法: news-cli.js source|content|authorization|quota|lock|registry|review|classify|transcript|legacy <action> [options]');
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs, normalizeTags, validateSource, importSources, optionalNumber,
  contentCommand, reviewCommand, transcriptCommand, legacyCommand, main, FILES,
};
