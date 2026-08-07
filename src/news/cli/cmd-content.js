/**
 * cmd-content.js —— content / classify / transcript 命令组（自 news-cli.js 拆分，行为不变）
 *
 *   content add --source-id ... --type bilibili --url ... --title ... [--summary ...] [--published-at ...] [--dry-run]
 *   content import --file <json> [--dry-run] [--allow-partial]
 *   content list
 *
 *   classify preview   --title <t> [--description <d>]    预览单条分类（不写入）
 *   classify candidates [--provider <id>] [--model <m>]   对候选层跑分类建议（ai_suggested，不覆盖已 reviewed）
 *   classify hotspots  [--provider <id>] [--model <m>]    对公开热点跑分类建议（过渡用途；真实路径 A 走候选层）
 *   classify confirm   [--reviewer <name>]                批量确认：ai_suggested → reviewed（接受分类建议，人工审核确认）
 *     （L0 规则式分类零成本、可离线（默认，不配 --provider 时）。L1 AI 分类：
 *       --provider deepseek 走 DeepSeek（需环境变量 DEEPSEEK_API_KEY，缺 key 时自动回退 L0，
 *       不阻塞）；--model 可覆盖默认 deepseek-chat（b16-task-status.md 第 4 项成本提醒）。）
 *
 *   transcript status --id <id>
 *   transcript fetch  --id <id> [--base-url ...] [--lang ...]
 *     （fetch 尝试获取 YouTube 自动字幕：缺失/过短 → held，技术失败 → error；
 *       成功且此前因字幕原因 held 的候选重置为 pending 等待复审，决策 52；
 *       完整字幕写入 data/news/runtime/transcripts/，不进 PR）
 *
 *   localize preview     --title <t> [--description <d>] [--locale zh]   预览单条翻译（不写入）
 *   localize candidates  [--locale zh] [--limit N] [--dry-run]           对候选层批量翻译（存量迁移）
 *     （把候选 title/description 翻译成目标语言存 localizations[locale]；
 *       只处理无 localizations[locale] 的候选；默认 --dry-run 预览条数（成本预览），
 *       非 dry-run 写回候选层后运行 publish-news.js 重建投影即前端中文化）
 *
 * 完整 CLI 帮助见 news-cli.js 顶部。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  readJson,
  writeJsonAtomic,
  acquireLock,
  releaseLock,
} = require('../core/news-storage');
const { normalizeManualItem, importManualItems } = require('../../content/news-manual');
const {
  classifyCandidate,
  classifyCandidates,
  confirmContentType,
} = require('../classify/content-classifier');
const {
  fetchYouTubeTranscript,
  applyTranscriptOutcome,
  storeTranscript,
} = require('../collectors/news-transcripts');
const { readCandidateStore, writeCandidateStore } = require('../core/news-candidates');
const { recordReviewTransition, readReviewEventLog } = require('../core/news-review-events');
const { localizeCandidate, localizeCandidates } = require('../classify/content-localizer');
const { NEWS_FILES } = require('../../shared/paths');
const { FILES, save } = require('./cmd-sources');
const { resolveReviewer, optionalNumber } = require('./cmd-ops');

// ── 命令实现 ──────────────────────────────────────────────

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

// ── localize 命令组：热点内容本地化（多语言翻译）─────
//
//   localize preview     --title <t> [--description <d>] [--locale zh]   预览单条翻译（不写入）
//   localize candidates  [--locale zh] [--limit N] [--dry-run]           对候选层批量翻译（存量迁移主路径）
//     （把候选的 title/description 翻译成目标语言存 localizations[locale]；
//       只处理候选层中尚无 localizations[locale] 的候选，不重复花钱；
//       默认 --dry-run 只预览将翻译条数（成本预览），非 dry-run 才写回候选层；
//       写回后运行 node scripts/publish-news.js 重建公开投影即前端中文化。
//       需环境变量 DEEPSEEK_API_KEY，缺 key 时自动降级不写翻译，不阻塞。）

async function localizeCommand(action, flags) {
  const locale = flags.locale || 'zh';

  if (action === 'preview') {
    const title = flags.title || '';
    const description = flags.description || '';
    if (!title && !description) throw new Error('localize preview 需要 --title 或 --description');
    return localizeCandidate({ title, description }, { locale, model: flags.model });
  }

  if (action === 'candidates') {
    const store = readCandidateStore();
    const candidates = (store.candidates || []).filter(candidate => !candidate.localizations?.[locale]);
    const limit = optionalNumber(flags, 'limit');
    const targets = limit !== undefined && limit > 0 ? candidates.slice(0, limit) : candidates;
    const dryRun = Boolean(flags.dry_run);
    if (dryRun) {
      return {
        dry_run: true, locale,
        will_localize: targets.length,
        skipped: (store.candidates || []).length - targets.length,
        total: (store.candidates || []).length,
      };
    }
    const result = await localizeCandidates(targets, {
      locale,
      model: flags.model,
      concurrency: optionalNumber(flags, 'concurrency') ?? 5,
    });
    // localizeCandidates 原地修改了 targets 上的候选对象（store.candidates 共享引用同步生效），
    // 直接写回整个 store 即可，不需重建数组。
    if (result.localized > 0) {
      writeCandidateStore(store, `localize-candidates-${Date.now()}`);
    }
    return { dry_run: false, locale, localized: result.localized, skipped: result.skipped, total: (store.candidates || []).length };
  }

  throw new Error(`未知 localize 命令: ${action}`);
}

module.exports = {
  contentCommand, classifyCommand, transcriptCommand, localizeCommand,
};
