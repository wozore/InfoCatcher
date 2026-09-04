'use strict';

// 本地 Bonsai 模型自动启动（llm-endpoints 的配套模块）
//
// 职责：在真正发起本地 LLM 请求前，确保本地服务在线——
//   探测离线时自动 spawn 启动脚本并轮询等待就绪；启动失败/超时输出报错，
//   不自动回退 DeepSeek。
//
// 关键设计（测试隔离）：
//   - 只对「真实全局 fetch」负责自动启动。调用方注入自定义 fetchImpl
//     （项目测试的 mock 模式）时一律视为就绪直接放行，绝不在测试里探测
//     或拉起外部服务进程。
//   - 确认在线后 TTL 内不重复探测，批量调用只付一次探测开销；
//     启动超时后 TTL 内不重复 spawn，避免重复拉起多个服务进程。

const fs = require('fs');
const { spawn } = require('child_process');
const { LOCAL_API_BASE, LOCAL_MODEL } = require('./llm-endpoints');

// 本地服务启动脚本（env 可覆盖；默认 Bonsai llama-server）。
const DEFAULT_LOCAL_MODEL_SCRIPT = 'D:\\Application\\LocalModel\\Bonsai-Agent\\start_server.ps1';
const LOCAL_MODEL_SCRIPT = process.env.KNOWVIEW_LOCAL_MODEL_SCRIPT || process.env.INFOCATCHER_LOCAL_MODEL_SCRIPT || DEFAULT_LOCAL_MODEL_SCRIPT;

// 自动启动总开关（env '0' 关闭；关闭时仅报错不拉起）。优先 KNOWVIEW_*，回退旧 INFOCATCHER_*。
const AUTOSTART_ENV = 'KNOWVIEW_AUTOSTART_LOCAL_MODEL';
const LEGACY_AUTOSTART_ENV = 'INFOCATCHER_AUTOSTART_LOCAL_MODEL';

// 确认在线后 TTL 内不重复探测（批量调用只付一次开销）。
const CONFIRMED_TTL_MS = 60_000;
// 启动后轮询就绪：间隔与总超时（3.6G 模型加载可能需 1-2 分钟）。
const POLL_INTERVAL_MS = 2_000;
const READY_TIMEOUT_MS = 120_000;

let confirmedAt = 0;            // 最近一次确认在线的时间戳
let lastStartAttemptAt = null;  // 最近一次启动尝试的时间戳（null=尚未启动；超时后 TTL 内不重复拉起）
let startPromise = null;        // 进行中的启动任务（防并发重复启动）

function autostartEnabled() {
  const value = process.env[AUTOSTART_ENV] ?? process.env[LEGACY_AUTOSTART_ENV];
  return value !== '0';
}

/** 最小探测请求：max_tokens 1 + 关思维链，确认整条链路可用。 */
function buildProbePayload() {
  return {
    model: LOCAL_MODEL,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
}

/**
 * 探测本地端点是否「可达」：只要 fetch 没有在连接层抛错即视为在线
 * （HTTP 业务错误仍说明服务活着，交给真实请求处理）。
 */
async function probeLocal(fetchImpl) {
  if (!fetchImpl) return false;
  try {
    await fetchImpl(LOCAL_API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildProbePayload()),
      ...(typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(30_000) } : {}),
    });
    return true;
  } catch (error) {
    return false;
  }
}

/** 启动本地服务（detached 独立存活；stdio ignore 不阻塞 Node、不吞输出）。 */
function startLocalServer(spawnImpl = spawn) {
  if (!LOCAL_MODEL_SCRIPT) return { started: false, error: `未配置本地模型启动脚本（${AUTOSTART_ENV}）` };
  if (!fs.existsSync(LOCAL_MODEL_SCRIPT)) {
    return { started: false, error: `本地模型启动脚本不存在：${LOCAL_MODEL_SCRIPT}` };
  }
  // 平台门禁只对真实 spawn（生产路径）生效：.ps1 启动脚本仅在 Windows 可用。
  // 注入自定义 spawnImpl（测试 mock / 定制环境）时放行，由注入实现负责平台兼容，
  // 与 ensureLocalModel 注入 fetchImpl 即放行的测试隔离设计一致。
  if (spawnImpl === spawn && process.platform !== 'win32') {
    return { started: false, error: `本地模型自动启动当前仅支持 Windows（脚本：${LOCAL_MODEL_SCRIPT}）` };
  }
  try {
    // Windows 下禁用 detached：它映射 DETACHED_PROCESS，控制台程序（powershell.exe）
    // 拿不到控制台会静默瞬间退出（实测 exit 0），启动脚本根本不会执行。
    // Windows 子进程本就不随父进程退出而终止，unref 即可实现独立存活。
    const child = spawnImpl(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', LOCAL_MODEL_SCRIPT],
      { detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    return { started: true };
  } catch (error) {
    return { started: false, error: `本地模型启动失败：${error.message}` };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 确保本地模型服务在线。返回 { ok:true } 或 { ok:false, code, error, autoStarted }。
 *
 * @param {object} [options]
 *   fetchImpl      发起探测的 fetch（与真实请求同源；注入自定义 fetchImpl 时放行不处理）
 *   spawnImpl      测试注入的 spawn
 *   probeImpl      测试注入的探测函数
 *   nowFn          测试注入的时钟
 *   readyTimeoutMs 启动就绪总超时（测试可缩短）
 *   pollIntervalMs 就绪轮询间隔（测试可缩短）
 */
async function ensureLocalModel(options = {}) {
  const globalFetch = typeof fetch === 'function' ? fetch : null;

  // 注入自定义 fetchImpl（测试/定制环境）：视为就绪放行，不探测不启动。
  if (options.fetchImpl && options.fetchImpl !== globalFetch) {
    return { ok: true, skipped: true };
  }
  const fetchImpl = options.fetchImpl || globalFetch;
  if (!fetchImpl) return { ok: true, skipped: true }; // 无 fetch 环境放行，由调用方自决

  const nowFn = options.nowFn || (() => Date.now());
  const probe = options.probeImpl || probeLocal;
  const spawnImpl = options.spawnImpl || spawn;

  // 幂等缓存：确认在线后 TTL 内直接放行。
  if (confirmedAt && nowFn() - confirmedAt < CONFIRMED_TTL_MS) {
    return { ok: true, cached: true };
  }

  if (await probe(fetchImpl)) {
    confirmedAt = nowFn();
    return { ok: true };
  }

  // 离线。自动启动禁用，或上次启动超时仍在 TTL 内：只报错不重复拉起。
  if (!autostartEnabled()) {
    return { ok: false, code: 'LOCAL_MODEL_OFFLINE', error: `本地 AI 服务离线，且自动启动已禁用（${AUTOSTART_ENV}=0）`, autoStarted: false };
  }
  if (lastStartAttemptAt !== null && nowFn() - lastStartAttemptAt < READY_TIMEOUT_MS) {
    return { ok: false, code: 'LOCAL_MODEL_STARTING', error: `本地 AI 服务离线（上次启动未就绪，${Math.ceil((READY_TIMEOUT_MS - (nowFn() - lastStartAttemptAt)) / 1000)}s 内不再重复启动；可手动执行 ${LOCAL_MODEL_SCRIPT}）`, autoStarted: false };
  }

  // 自动启动（并发去重：进行中复用同一 promise）。
  if (!startPromise) {
    lastStartAttemptAt = nowFn();
    console.log(`[local-model] 本地 AI 服务离线，正在自动启动（${LOCAL_MODEL_SCRIPT}）…`);
    startPromise = (async () => {
      const launch = startLocalServer(spawnImpl);
      if (!launch.started) return { ok: false, code: 'LOCAL_MODEL_START_FAILED', error: launch.error, autoStarted: false };
      const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
      const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
      const deadline = nowFn() + readyTimeoutMs;
      while (nowFn() < deadline) {
        await sleep(pollIntervalMs);
        if (await probe(fetchImpl)) {
          confirmedAt = nowFn();
          return { ok: true, autoStarted: true };
        }
      }
      return {
        ok: false,
        code: 'LOCAL_MODEL_START_TIMEOUT',
        error: `本地 AI 服务启动后 ${Math.round(readyTimeoutMs / 1000)}s 内未就绪（${LOCAL_API_BASE}）；请检查 ${LOCAL_MODEL_SCRIPT}`,
        autoStarted: true,
      };
    })();
  }
  const result = await startPromise;
  startPromise = null; // 允许后续调用重试
  return result;
}

/** 重置内部状态（测试用）。 */
function resetLocalModelState() {
  confirmedAt = 0;
  lastStartAttemptAt = null;
  startPromise = null;
}

module.exports = {
  LOCAL_MODEL_SCRIPT,
  CONFIRMED_TTL_MS,
  POLL_INTERVAL_MS,
  READY_TIMEOUT_MS,
  AUTOSTART_ENV,
  autostartEnabled,
  buildProbePayload,
  probeLocal,
  startLocalServer,
  ensureLocalModel,
  resetLocalModelState,
};
