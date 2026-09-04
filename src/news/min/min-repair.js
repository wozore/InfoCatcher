/**
 * min-repair.js —— 热点初审残缺数据双通道自愈修复。
 *
 * 通道 A（本地 Bonsai 调优）：timeoutMs 30000 / maxDescChars 1000 / concurrency 3 / external false。
 * 通道 B（外部 provider，默认跟随注册表开关）：timeoutMs 15000 / concurrency 5 / external true。
 * 两通道各自运行互不干扰，合并时优先采用本地成功结果（零成本），本地失败回退外部结果。
 * 残缺判定、单条审核执行与并发安全落盘共用 enrichment-core.js。
 */

'use strict';

const { summarizeCandidates } = require('../classify/content-summarizer');
const { localizeCandidates, hasUsableLocalizedContent } = require('../classify/content-localizer');
const { runPool } = require('../classify/content-reviewer');
const { revisionOfMinStore } = require('./min-store');
const { getProvider, DEFAULT_PROVIDER_NAME } = require('../../shared/providers');
const {
  needsL1Review,
  needsL2Advice,
  needsSummary,
  needsLocalize,
  needsRepair,
  countRepairWork,
  executeCandidateReview,
  executeL2OnlyAdvice,
  guardedWriteStore,
  nonNegativeInteger,
} = require('./enrichment-core');

const DEFAULT_REPAIR_LIMIT = 100;

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 运行单个通道的初审、摘要与翻译处理。
 * 摘要/翻译首轮后如仍有残缺，延迟 retryDelayMs（默认 5s）后以减半并发自动补做一轮，
 * 吸收限流、网络抖动等瞬时失败（持久失败交由上层合并语义保持诚实不写）。
 * @returns {Promise<{ reviewed: number, summarized: number, localized: number }>}
 */
async function runRepairChannel(items, config, channelOpts) {
  const stats = { reviewed: 0, summarized: 0, localized: 0 };
  const conc = channelOpts.concurrency || 3;
  const locale = channelOpts.locale || 'zh';
  const retryDelayMs = channelOpts.retryDelayMs ?? 5000;

  // 1. 审核：缺 L1 的走完整流程；仅缺 L2 建议的只补建议（不重跑 L1、不改状态）
  if (!channelOpts.skipReview) {
    const l1Targets = items.filter(c => {
      if (c.reviewed_at) return false;
      if (c.review_status === 'discarded' || c.review_status === 'approved') return false;
      return needsL1Review(c);
    });
    const l2Targets = items.filter(c => {
      if (c.reviewed_at) return false;
      if (c.review_status !== 'pending') return false;
      return needsL2Advice(c, channelOpts.l2Enabled !== false);
    });
    if (l1Targets.length > 0) {
      await runPool(l1Targets, conc, async item => {
        try {
          await executeCandidateReview(item, config, channelOpts);
          if (item.l1_review?.verdict) stats.reviewed += 1;
        } catch {
          /* 隔离异常 */
        }
      });
    }
    if (l2Targets.length > 0) {
      await runPool(l2Targets, conc, async item => {
        try {
          await executeL2OnlyAdvice(item, config, channelOpts);
          if (item.ai_advice?.verdict) stats.reviewed += 1;
        } catch {
          /* 隔离异常 */
        }
      });
    }
  }

  // 2. 摘要（仅非 discarded 项；保护只对有效摘要生效，空摘要允许重试）
  //    仅外部通道（external）在首轮后仍有残缺时延迟重试一轮（减半并发，吸收限流/网络抖动）；
  //    本地通道失败多为确定性（模型复述/离线），重试无收益只拖时长。
  if (!channelOpts.skipSummary) {
    const summaryTargets = items.filter(c => c.review_status !== 'discarded' && needsSummary(c));
    if (summaryTargets.length > 0) {
      try {
        const res = await summarizeCandidates(summaryTargets, channelOpts);
        stats.summarized = res?.summarized || 0;
      } catch {
        /* 隔离异常 */
      }
      if (channelOpts.external === true && retryDelayMs > 0) {
        const summaryRetryTargets = summaryTargets.filter(c => needsSummary(c));
        if (summaryRetryTargets.length > 0) {
          await sleepMs(retryDelayMs);
          try {
            const retryRes = await summarizeCandidates(summaryRetryTargets, {
              ...channelOpts,
              concurrency: Math.max(1, Math.floor(conc / 2)),
            });
            stats.summarized += retryRes?.summarized || 0;
          } catch {
            /* 隔离异常 */
          }
        }
      }
    }
  }

  // 3. 翻译（仅非 discarded 项）；重试策略同摘要（仅外部通道）
  if (!channelOpts.skipLocalize) {
    const localizeTargets = items.filter(c => {
      if (c.review_status === 'discarded') return false;
      return needsLocalize(c, locale);
    });
    if (localizeTargets.length > 0) {
      try {
        const res = await localizeCandidates(localizeTargets, channelOpts);
        stats.localized = res?.localized || 0;
      } catch {
        /* 隔离异常 */
      }
      if (channelOpts.external === true && retryDelayMs > 0) {
        const localizeRetryTargets = localizeTargets.filter(c => needsLocalize(c, locale));
        if (localizeRetryTargets.length > 0) {
          await sleepMs(retryDelayMs);
          try {
            const retryRes = await localizeCandidates(localizeRetryTargets, {
              ...channelOpts,
              concurrency: Math.max(1, Math.floor(conc / 2)),
            });
            stats.localized += retryRes?.localized || 0;
          } catch {
            /* 隔离异常 */
          }
        }
      }
    }
  }

  return stats;
}

/**
 * 热点初审残缺数据双通道自愈修复机制。
 * - 原子落盘，遵守不变式：受保护的字幕总结与已有人工审核标记绝不被覆盖；discarded 绝不进入摘要/翻译修复。
 *
 * @param {object} store - min store 对象 ({ candidates: [] })
 * @param {object} [config] - news-config-v2.json
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function repairIncompleteCandidates(store, config = {}, options = {}) {
  const candidates = Array.isArray(store?.candidates) ? store.candidates : [];
  const locale = options.locale || 'zh';
  const dryRun = options.dryRun === true;
  const l2Enabled = config?.review?.l2_enabled !== false;
  const repairLimit = nonNegativeInteger(options.limit, DEFAULT_REPAIR_LIMIT, 'options.limit');
  // 双通道请求期间的基准 revision，用于并发安全落盘
  const baseRevision = revisionOfMinStore(store);

  // 1. 筛选出残缺条目
  const rawTargets = candidates.filter(c => needsRepair(c, {
    locale,
    l2Enabled,
    skipReview: options.skipReview === true,
    skipSummary: options.skipSummary === true,
    skipLocalize: options.skipLocalize === true,
  }));
  const targets = rawTargets.slice(0, repairLimit);

  const resultStats = {
    totalTargets: targets.length,
    repairedReview: 0,
    repairedSummary: 0,
    repairedLocalize: 0,
    channelASuccesses: { reviewed: 0, summarized: 0, localized: 0 },
    channelBSuccesses: { reviewed: 0, summarized: 0, localized: 0 },
    remainingIncomplete: 0,
  };

  if (targets.length === 0) {
    resultStats.remainingIncomplete = countRepairWork(candidates, {
      locale,
      l2Enabled,
      skipReview: options.skipReview === true,
      skipSummary: options.skipSummary === true,
      skipLocalize: options.skipLocalize === true,
    }).total;
    return resultStats;
  }

  // 2. 双通道数据深拷贝隔离
  const targetsA = structuredClone(targets);
  const targetsB = structuredClone(targets);

  // 3. 通道参数配置（通道 B 外部 provider 跟随全局开关，密钥按 provider 读取）
  const externalProvider = options.providerB || options.provider || DEFAULT_PROVIDER_NAME;
  const externalProviderInfo = getProvider(externalProvider) || getProvider(DEFAULT_PROVIDER_NAME);
  const channelAOpts = {
    ...options,
    timeoutMs: options.channelA?.timeoutMs ?? 30000,
    maxDescChars: options.channelA?.maxDescChars ?? 1000,
    concurrency: options.channelA?.concurrency ?? 3,
    l2Enabled,
    external: false,
    apiKey: options.apiKeyA || 'local-bonsai',
    fetchImpl: options.fetchImplA || options.fetchImpl,
    reviewCandidate: options.reviewCandidateA || options.reviewCandidate,
    locale,
    config,
  };

  const externalApiKey = options.apiKeyB || options.apiKey || process.env[externalProviderInfo.apiKeyEnv];
  const channelBOpts = {
    ...options,
    timeoutMs: options.channelB?.timeoutMs ?? 15000,
    concurrency: options.channelB?.concurrency ?? 5,
    l2Enabled,
    external: true,
    provider: externalProvider,
    apiKey: externalApiKey,
    // 缺密钥时外部调用必然失败（missing_api_key 非瞬时错误），关闭重试避免无谓延迟
    retryDelayMs: externalApiKey ? (options.retryDelayMs ?? 5000) : 0,
    fetchImpl: options.fetchImplB || options.fetchImpl,
    reviewCandidate: options.reviewCandidateB || options.reviewCandidate,
    locale,
    config,
  };

  // 4. 双通道并行独立执行
  const [statsA, statsB] = await Promise.all([
    runRepairChannel(targetsA, config, channelAOpts).catch(() => ({ reviewed: 0, summarized: 0, localized: 0 })),
    options.externalEnabled === false
      ? Promise.resolve({ reviewed: 0, summarized: 0, localized: 0 })
      : runRepairChannel(targetsB, config, channelBOpts).catch(() => ({ reviewed: 0, summarized: 0, localized: 0 })),
  ]);

  resultStats.channelASuccesses = statsA;
  resultStats.channelBSuccesses = statsB;

  // 5. 结果合并：优先采用本地零成本成功结果，本地失败则回退外部结果
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const a = targetsA[i];
    const b = targetsB[i];

    // ── 审核结论合并 ──
    if (!target.reviewed_at) {
      const hadReviewDefect = needsL1Review(target) || needsL2Advice(target, l2Enabled);
      if (hadReviewDefect) {
        const aSuccess = Boolean(a.l1_review?.verdict && (
          a.review_status !== 'pending' ||
          a.ai_advice?.verdict ||
          !l2Enabled
        ));
        const bSuccess = Boolean(b.l1_review?.verdict && (
          b.review_status !== 'pending' ||
          b.ai_advice?.verdict ||
          !l2Enabled
        ));

        if (aSuccess) {
          target.review_status = a.review_status;
          target.l1_review = a.l1_review;
          target.ai_advice = a.ai_advice;
          if (a.discard_reason) target.discard_reason = a.discard_reason; else delete target.discard_reason;
          if (a.discard_stage) target.discard_stage = a.discard_stage; else delete target.discard_stage;
          resultStats.repairedReview += 1;
        } else if (bSuccess) {
          target.review_status = b.review_status;
          target.l1_review = b.l1_review;
          target.ai_advice = b.ai_advice;
          if (b.discard_reason) target.discard_reason = b.discard_reason; else delete target.discard_reason;
          if (b.discard_stage) target.discard_stage = b.discard_stage; else delete target.discard_stage;
          resultStats.repairedReview += 1;
        }
      }
    }

    // 严禁对 discarded 条目进行摘要与翻译修复
    if (target.review_status === 'discarded') {
      continue;
    }

    // ── 摘要合并（有效摘要存在时跳过；保护标记 + 空摘要允许重试补齐） ──
    if (!target.summary || !String(target.summary).trim()) {
      const aSumSuccess = Boolean(a.summary && a.summarizer !== 'llm_failed');
      const bSumSuccess = Boolean(b.summary && b.summarizer !== 'llm_failed');

      if (aSumSuccess) {
        target.summary = a.summary;
        target.summary_key_points = a.summary_key_points || [];
        target.summarizer = a.summarizer;
        target.summary_generated_at = a.summary_generated_at;
        target.summary_input_chars = a.summary_input_chars;
        target.summary_llm_error = null;
        resultStats.repairedSummary += 1;
      } else if (bSumSuccess) {
        target.summary = b.summary;
        target.summary_key_points = b.summary_key_points || [];
        target.summarizer = b.summarizer;
        target.summary_generated_at = b.summary_generated_at;
        target.summary_input_chars = b.summary_input_chars;
        target.summary_llm_error = null;
        resultStats.repairedSummary += 1;
      }
    }

    // ── 本地化翻译合并（可用判定：原样复述的假翻译不抢占合并结果） ──
    const hasLocal = hasUsableLocalizedContent(target, locale);
    if (!hasLocal) {
      const aLoc = a.localizations?.[locale];
      const aLocSuccess = hasUsableLocalizedContent(a, locale);
      const bLoc = b.localizations?.[locale];
      const bLocSuccess = hasUsableLocalizedContent(b, locale);

      if (aLocSuccess) {
        target.localizations ||= {};
        target.localizations[locale] = aLoc;
        target.localizations_meta ||= {};
        target.localizations_meta[locale] = a.localizations_meta?.[locale] || {
          localizer: 'llm_deepseek',
          generated_at: new Date().toISOString(),
          input_chars: 0,
          llm_error: null,
        };
        resultStats.repairedLocalize += 1;
      } else if (bLocSuccess) {
        target.localizations ||= {};
        target.localizations[locale] = bLoc;
        target.localizations_meta ||= {};
        target.localizations_meta[locale] = b.localizations_meta?.[locale] || {
          localizer: 'llm_deepseek',
          generated_at: new Date().toISOString(),
          input_chars: 0,
          llm_error: null,
        };
        resultStats.repairedLocalize += 1;
      }
    }
  }

  // 6. 并发安全原子落盘：双通道请求期间若候选层被并发修改（如工作台人工审核），
  //    只把修复结果合并进最新状态，绝不覆盖人工结论
  if (!dryRun) {
    if (store) {
      store.updated_at = new Date().toISOString();
    }
    const writeResult = guardedWriteStore(store, baseRevision, targets, options.runId || 'min-repair-dual-channel', {
      ...options,
      locale,
      l2Enabled,
    });
    resultStats.writeMerged = writeResult.merged;
  }

  resultStats.remainingIncomplete = countRepairWork(candidates, {
    locale,
    l2Enabled,
    skipReview: options.skipReview === true,
    skipSummary: options.skipSummary === true,
    skipLocalize: options.skipLocalize === true,
  }).total;
  return resultStats;
}

module.exports = {
  repairIncompleteCandidates,
};
