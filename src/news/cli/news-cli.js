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
 *   review —— 热点审核状态管理（B16 决策 46/48/50/55/56/57/69）
 *     review list    [--status pending|approved|held|discarded] [--platform ...] [--limit N]
 *     review summary
 *     review set     --id <id> --status pending|approved|held|discarded [--reason ...]
 *     review batch   --ids <id1,id2,...> --status approved [--reason ...]
 *     （set 单条设置审核状态；batch 只处理显式列出的 ids，不支持隐式「全部」；
 *       ai_processing_status 未 completed 时禁止设为 approved）
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
const { createAuthorizationStore, decideAuthorization } = require('../core/news-authorization');
const { normalizeManualItem, importManualItems } = require('../../content/news-manual');
const {
  REVIEW_STATUSES,
  readCandidateStore,
  writeCandidateStore,
  setReviewStatus,
  setBatchReviewStatus,
  reviewSummary,
} = require('../core/news-candidates');
const { NEWS_FILES } = require('../../shared/paths');

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
      content_type: flags.type,
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
        content_type: candidate.content_type,
        title: candidate.title,
        published_at: candidate.published_at,
        ai_processing_status: candidate.ai_processing_status,
        review_status: candidate.review_status,
        hold_reason: candidate.hold_reason || null,
        error_type: candidate.error_type || null,
      })),
    };
  }

  if (action === 'set') {
    if (!flags.id) throw new Error('review set 缺少 --id');
    if (!flags.status) throw new Error('review set 缺少 --status');
    const next = setReviewStatus(store, flags.id, flags.status, { reason: flags.reason });
    writeCandidateStore(next, `review-set-${flags.id}-${Date.now()}`);
    const candidate = next.candidates.find(item => item.id === flags.id);
    return {
      id: candidate.id,
      review_status: candidate.review_status,
      review_reason: candidate.review_reason || null,
      updated_at: next.updated_at,
    };
  }

  if (action === 'batch') {
    if (!flags.ids) throw new Error('review batch 缺少 --ids（逗号分隔的明确 id 列表，决策 56）');
    if (!flags.status) throw new Error('review batch 缺少 --status');
    const ids = String(flags.ids).split(',').map(id => id.trim()).filter(Boolean);
    if (!ids.length) throw new Error('review batch 的 --ids 为空');
    const result = setBatchReviewStatus(store, ids, flags.status, { reason: flags.reason });
    if (result.updated > 0) writeCandidateStore(result.store, `review-batch-${Date.now()}`);
    return { status: flags.status, ...result, updated_at: result.store.updated_at };
  }

  throw new Error(`未知 review 命令: ${action}`);
}

function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const [group, action] = positional;
  let result;
  if (group === 'source') result = sourceCommand(action, flags);
  else if (group === 'content') result = contentCommand(action, flags);
  else if (group === 'authorization') result = authorizationCommand(action, flags);
  else if (group === 'quota') result = quotaCommand(action, flags);
  else if (group === 'lock') result = lockCommand(action, flags);
  else if (group === 'review') result = reviewCommand(action, flags);
  else throw new Error('用法: news-cli.js source|content|authorization|quota|lock|review <action> [options]');
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`❌ ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, normalizeTags, validateSource, importSources, optionalNumber, contentCommand, reviewCommand, main, FILES };
