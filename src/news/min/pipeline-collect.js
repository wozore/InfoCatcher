/**
 * pipeline-collect.js —— 热点管线 v2 的采集编排：双平台并行采集 + YouTube 调度到期闸
 * + 调度状态落盘。采集器失败降级返回空并记 coverage，不抛错。
 *
 * 分时采集（options.platforms）：只启动列表内平台的采集 Task；未启用平台的
 * coverage.collectors[platform] 保持初始 { status:'not_run', items:0, error:null }。
 * YouTube 到期闸仅调度运行生效（options.scheduled 由 CLI --scheduled 注入）；
 * 手动 dispatch / 本地运行不受闸、也不写调度状态——手动采集与调度节奏互不影响。
 */

'use strict';

const { collectYouTubeV2 } = require('../collectors/collector-youtube-v2');
const { collectXV2 } = require('../collectors/collector-x-v2');
const { isYoutubeDue, readScheduleState, resolveXWindow, writeScheduleState } = require('./pipeline-schedule');

/** 错误标签：防御 undefined 边界。 */
function errorLabel(error) {
  return (error && (error.message || error.code)) || String(error);
}

/**
 * 执行采集阶段：按 options.platforms 并行采集，更新 coverage.collectors，
 * 并在「调度运行 + YouTube 实际采集（success/partial）」时刷新调度状态。
 * @returns {Promise<{ mergedRaw: Array, platforms: string[] }>}
 */
async function collectPlatforms({ options, config, now, runId, coverage, noteError }) {
  const platforms = Array.isArray(options.platforms) && options.platforms.length
    ? options.platforms
    : ['youtube', 'x'];
  const youtubeCollector = (options.collectors && options.collectors.youtube) || collectYouTubeV2;
  const xCollector = (options.collectors && options.collectors.x) || collectXV2;
  const xWindow = resolveXWindow(options, now);

  // YouTube 到期闸：仅调度运行生效。
  const scheduledRun = options.scheduled === true;
  let youtubeDueFlag = true;
  if (platforms.includes('youtube') && scheduledRun) {
    let scheduleState = null;
    try {
      scheduleState = options.scheduleStateIn ? options.scheduleStateIn() : readScheduleState();
    } catch (error) {
      noteError('schedule_state_read', error);
    }
    youtubeDueFlag = isYoutubeDue(config, scheduleState, now);
    if (!youtubeDueFlag) {
      coverage.collectors.youtube = { status: 'not_due', items: 0, error: null, reason: 'not_due' };
    }
  }

  const collectTasks = [];
  if (platforms.includes('youtube') && youtubeDueFlag) {
    collectTasks.push((async () => {
      const slot = coverage.collectors.youtube;
      try {
        const result = await youtubeCollector({ config, now, apiKey: options.youtubeApiKey, fetchImpl: options.fetchImpl });
        const collected = result && Array.isArray(result.items) ? result.items : [];
        slot.items = collected.length;
        slot.status = (result && result.coverage && result.coverage.status) || 'success';
        slot.reason = (result && result.coverage && result.coverage.reason) || null;
        return collected;
      } catch (error) {
        slot.status = 'failed';
        slot.error = errorLabel(error);
        return [];
      }
    })());
  }
  if (platforms.includes('x')) {
    collectTasks.push((async () => {
      const slot = coverage.collectors.x;
      try {
        const result = await xCollector({
          config, now,
          sinceIso: xWindow.sinceIso, untilIso: xWindow.untilIso,
          xApiKey: options.xApiKey, fetchImpl: options.fetchImpl,
        });
        const collected = result && Array.isArray(result.items) ? result.items : [];
        slot.items = collected.length;
        slot.status = (result && result.coverage && result.coverage.status) || 'success';
        slot.reason = (result && result.coverage && result.coverage.reason) || null;
        slot.credits = result && result.credits ? result.credits : null;
        return collected;
      } catch (error) {
        slot.status = 'failed';
        slot.error = errorLabel(error);
        return [];
      }
    })());
  }

  const collectedArrays = await Promise.all(collectTasks);
  const mergedRaw = collectedArrays.flat();
  coverage.collected_total = mergedRaw.length;

  // 调度状态落盘：仅「调度运行 + YouTube 实际采集（success/partial）」刷新到期基准。
  // not_due、failed、手动/本地运行一律不写——失败不吞窗口，手动不挤压调度节奏。
  if (platforms.includes('youtube') && scheduledRun && youtubeDueFlag
    && ['success', 'partial'].includes(coverage.collectors.youtube.status)) {
    try {
      const scheduleState = {
        schema_version: 1,
        youtube_last_collected_at: now.toISOString(),
        run_id: runId,
      };
      if (options.scheduleStateOut) options.scheduleStateOut(scheduleState, runId);
      else writeScheduleState(scheduleState, runId);
    } catch (error) {
      noteError('schedule_state_write', error);
    }
  }

  return { mergedRaw, platforms };
}

module.exports = { collectPlatforms };
