'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic, inspectLock, forceUnlock } = require('./news-storage');
const { createAuthorizationStore, decideAuthorization } = require('./news-authorization');

const MVP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(MVP_DIR, 'data');
const FILES = {
  sources: path.join(DATA_DIR, 'news-sources.json'),
  authorizations: path.join(DATA_DIR, 'pending-authorizations.json'),
  quota: path.join(DATA_DIR, 'news-quota.json'),
  lock: path.join(DATA_DIR, '.news-build.lock'),
  audit: path.join(DATA_DIR, 'news-admin-audit.json'),
};
const PLATFORMS = new Set(['youtube', 'bilibili', 'x']);
const ALLOWED_TAGS = new Set(['横向测评', '即时资讯', '深度解读', '教程实践', '行业观点', '轻度用户体验', '官方来源']);

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

function slug(value) {
  return String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '') || 'source';
}

function normalizeTags(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[、,，]/);
  return [...new Set(values.map(tag => tag.trim()).filter(Boolean))];
}

function validateSource(input, existing = []) {
  if (!PLATFORMS.has(input.platform)) throw new Error(`无效 platform: ${input.platform}`);
  if (!input.external_id) throw new Error('缺少 external_id');
  if (!input.name) throw new Error('缺少 name');
  let url;
  try { url = new URL(input.profile_url); } catch { throw new Error('profile_url 不是有效 URL'); }
  if (url.protocol !== 'https:') throw new Error('profile_url 必须使用 HTTPS');
  if (input.platform === 'youtube' && !/^UC[A-Za-z0-9_-]{20,}$/.test(input.external_id)) throw new Error('YouTube external_id 必须是 UC 开头的 Channel ID');
  if (input.platform === 'bilibili' && !/^\d+$/.test(input.external_id)) throw new Error('Bilibili external_id 必须是数字 UID');
  if (input.platform === 'x' && !/^[A-Za-z0-9_]{1,15}$/.test(input.external_id.replace(/^@/, ''))) throw new Error('X external_id 必须是有效用户名');
  const tags = normalizeTags(input.content_tags);
  if (!tags.length || tags.some(tag => !ALLOWED_TAGS.has(tag))) throw new Error('content_tags 缺失或包含未知标签');
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

function save(file, value, prefix = 'cli') {
  writeJsonAtomic(file, value, `${prefix}-${Date.now()}`);
}

function sourceCommand(action, flags) {
  const payload = readJson(FILES.sources, { schema_version: 1, sources: [] });
  if (action === 'add') {
    const inferredTags = normalizeTags(flags.tag || flags.tags);
    const source = validateSource({
      platform: flags.platform, external_id: flags.external_id, name: flags.name,
      profile_url: flags.url, language: flags.language, content_tags: inferredTags,
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

function optionalNumber(flags, key, suffix = '') {
  return flags[key] !== undefined ? Number(String(flags[key]).replace(new RegExp(`${suffix}$`), '')) : undefined;
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

function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const [group, action] = positional;
  let result;
  if (group === 'source') result = sourceCommand(action, flags);
  else if (group === 'authorization') result = authorizationCommand(action, flags);
  else if (group === 'quota') result = quotaCommand(action, flags);
  else if (group === 'lock') result = lockCommand(action, flags);
  else throw new Error('用法: news-cli.js source|authorization|quota|lock <action> [options]');
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`❌ ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, normalizeTags, validateSource, importSources, optionalNumber, main, FILES };
