/**
 * refine-zh-localizations.js —— 一次性回填：重跑 approved 中文候选的标题精炼
 *
 * 背景（问题二）：本地化 prompt 只约束"忠实翻译"，对本来就是中文的原文（language=zh）
 * DeepSeek 当"翻译对象"原样返回（或繁转简），从不做标题精炼——导致 localizations.zh.title
 * 带 # 标签 / emoji / 情绪化开场（如 "👉AI，第一次开始"自己找路"😱"），前端标题位照显。
 *
 * 本脚本修复**已存在**的候选数据（prompt 规则已改，未来采集自动生效）：
 *   - 筛选 review_status === 'approved' && language === 'zh' 的候选（会进前端展示的）；
 *   - 逐条调 localizeCandidate 重跑，成功写回 localizations.zh（新精炼标题），
 *     失败记 localizations_meta.zh.llm_error 不覆盖旧值（诚实降级）；
 *   - 原子写回 min-candidates.json。
 *
 * 用法：
 *   node scripts/refine-zh-localizations.js            # dry-run：只打印名单与新旧对比
 *   node scripts/refine-zh-localizations.js --apply    # 实跑：写回候选层
 *
 * 依赖 .env 的 DEEPSEEK_API_KEY（真实调用，38 条 approved zh，成本可忽略）。
 */

'use strict';

const { loadDotEnv } = require('../src/shared/env');
const { readMinStore, writeMinStore } = require('../src/news/min/min-store');
const { localizeCandidate } = require('../src/news/classify/content-localizer');

const APPLY = process.argv.includes('--apply');
const DRY = !APPLY;

async function main() {
  loadDotEnv();
  const store = readMinStore();
  const targets = store.candidates.filter(
    c => c && c.review_status === 'approved' && c.language === 'zh'
  );

  console.log(`ℹ️ approved && language=zh 候选：${targets.length} 条`);
  if (!targets.length) {
    console.log('（无目标，无需回填）');
    return;
  }

  if (DRY) {
    console.log('── dry-run：仅列出目标候选（不改文件），加 --apply 实跑 ──');
    for (const c of targets) {
      const oldTitle = (c.localizations && c.localizations.zh && c.localizations.zh.title) || '(无)';
      const summary = String(c.summary || c.title || '(无标题)').trim().slice(0, 40);
      console.log(`  [${c.platform}] ${c.id}\n     旧标题: ${oldTitle.slice(0, 50)}\n     摘要:   ${summary}`);
    }
    return;
  }

  // ── 实跑：逐条重跑本地化，成功写回 ──
  let ok = 0;
  let failed = 0;
  const maxConcurrent = 3; // 轻量并发，避免一次 38 条打爆 DeepSeek
  const pool = [];
  const targetsCopy = targets.slice();
  for (let i = 0; i < maxConcurrent; i++) {
    pool.push((async () => {
      while (targetsCopy.length) {
        const c = targetsCopy.shift();
        const oldTitle = (c.localizations && c.localizations.zh && c.localizations.zh.title) || '(无)';
        const suggestion = await localizeCandidate(c, { provider: 'deepseek', locale: 'zh' });
        if (suggestion && (suggestion.title || suggestion.description)) {
          c.localizations ||= {};
          c.localizations.zh = {
            title: suggestion.title || '',
            description: suggestion.description || '',
          };
          c.localizations_meta ||= {};
          c.localizations_meta.zh = {
            localizer: suggestion.localizer,
            generated_at: suggestion.generated_at,
            input_chars: suggestion.input_chars,
            llm_error: suggestion.llm_error,
          };
          ok++;
          console.log(`✅ ${c.id}\n   旧: ${oldTitle.slice(0, 45)}\n   新: ${suggestion.title.slice(0, 45)}`);
        } else {
          failed++;
          c.localizations_meta ||= {};
          c.localizations_meta.zh = {
            localizer: 'llm_failed',
            generated_at: null,
            input_chars: suggestion ? suggestion.input_chars : 0,
            llm_error: (suggestion && suggestion.llm_error) || 'llm_failed',
          };
          console.log(`⚠️ 失败（保留旧值）: ${c.id} → ${(suggestion && suggestion.llm_error) || 'unknown'}`);
        }
      }
    })());
  }
  await Promise.all(pool);

  writeMinStore(store, `refine-zh-localizations-${Date.now()}`);
  console.log(`\n✅ 回填完成：成功 ${ok} / 失败 ${failed} → min-candidates.json`);
  console.log('   下一步：node scripts/publish-news.js 重建公开投影');
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
});
