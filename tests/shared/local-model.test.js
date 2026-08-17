'use strict';

/**
 * local-model.test.js —— 本地 Bonsai 自动启动（ensureLocalModel）回归
 *
 * 覆盖：
 *   1. 注入自定义 fetchImpl（测试 mock）→ 放行不探测不启动；
 *   2. 探测成功 → ok，确认在线后 TTL 内缓存不重复探测；
 *   3. 离线 + 自动启动禁用 → LOCAL_MODEL_OFFLINE，不 spawn；
 *   4. 离线 + 自动启动 → spawn 后轮询到就绪返回 ok，只启动一次；
 *   5. 启动后超时未就绪 → LOCAL_MODEL_START_TIMEOUT；
 *   6. 启动未就绪后 TTL 内再调用 → LOCAL_MODEL_STARTING，不重复 spawn。
 *
 * 全用注入的 probeImpl / spawnImpl / nowFn，零真实网络、零外部进程。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// 指向一个真实存在的文件作为「启动脚本」，测试不依赖用户机器路径。
process.env.INFOCATCHER_LOCAL_MODEL_SCRIPT = __filename;

const {
  ensureLocalModel,
  resetLocalModelState,
  CONFIRMED_TTL_MS,
} = require('../../src/shared/local-model');

/** 假时钟：nowFn 手动推进。 */
function fakeClock(start = 0) {
  let now = start;
  return {
    nowFn: () => now,
    advance: ms => { now += ms; },
  };
}

/** 模拟服务由离线变在线：前 failTimes 次探测失败，之后成功。 */
function flakyProbe(failTimes = 0) {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls > failTimes;
  };
}

/** 每次探测推进时钟 30ms 且失败（用于构造超时）。 */
function advancingFailProbe(clock) {
  return async () => {
    clock.advance(30);
    return false;
  };
}

const okSpawn = () => ({ unref() {} });

test.beforeEach(() => {
  resetLocalModelState();
  delete process.env.INFOCATCHER_AUTOSTART_LOCAL_MODEL;
});

test('注入自定义 fetchImpl（测试 mock）时放行，不探测不启动', async () => {
  let probed = 0;
  const result = await ensureLocalModel({
    fetchImpl: async () => {},
    probeImpl: async () => { probed += 1; return true; },
    spawnImpl: () => { throw new Error('不应启动'); },
  });
  assert.deepEqual(result, { ok: true, skipped: true });
  assert.equal(probed, 0);
});

test('探测成功返回 ok，确认在线后 TTL 内不重复探测（缓存）', async () => {
  const clock = fakeClock(1000);
  let probed = 0;
  const probe = async () => { probed += 1; return true; };

  const first = await ensureLocalModel({ nowFn: clock.nowFn, probeImpl: probe });
  assert.equal(first.ok, true);

  clock.advance(30_000); // 30s 后（TTL 内）
  const second = await ensureLocalModel({ nowFn: clock.nowFn, probeImpl: probe });
  assert.deepEqual(second, { ok: true, cached: true });
  assert.equal(probed, 1); // 只探测一次

  clock.advance(CONFIRMED_TTL_MS); // 超过 TTL
  const third = await ensureLocalModel({ nowFn: clock.nowFn, probeImpl: probe });
  assert.equal(third.ok, true);
  assert.equal(probed, 2);
});

test('离线且自动启动禁用：报错 LOCAL_MODEL_OFFLINE，不 spawn', async () => {
  process.env.INFOCATCHER_AUTOSTART_LOCAL_MODEL = '0';
  let spawned = 0;
  const result = await ensureLocalModel({
    probeImpl: async () => false,
    spawnImpl: () => { spawned += 1; return okSpawn(); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LOCAL_MODEL_OFFLINE');
  assert.equal(spawned, 0);
});

test('离线时自动启动：spawn 后轮询到就绪返回 ok，且只启动一次', async () => {
  const clock = fakeClock(0);
  let spawned = 0;
  const result = await ensureLocalModel({
    nowFn: clock.nowFn,
    probeImpl: flakyProbe(2), // 启动前 1 次失败 + 轮询前 2 次失败，第 3 次成功
    spawnImpl: () => { spawned += 1; return okSpawn(); },
    readyTimeoutMs: 60_000,
    pollIntervalMs: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.autoStarted, true);
  assert.equal(spawned, 1);
});

test('启动后超时未就绪：报错 LOCAL_MODEL_START_TIMEOUT', async () => {
  const clock = fakeClock(0);
  let spawned = 0;
  const result = await ensureLocalModel({
    nowFn: clock.nowFn,
    probeImpl: advancingFailProbe(clock),
    spawnImpl: () => { spawned += 1; return okSpawn(); },
    readyTimeoutMs: 40,
    pollIntervalMs: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LOCAL_MODEL_START_TIMEOUT');
  assert.equal(result.autoStarted, true);
  assert.equal(spawned, 1);
});

test('启动未就绪后 TTL 内再调用不重复拉起（LOCAL_MODEL_STARTING）', async () => {
  const clock = fakeClock(0);
  let spawned = 0;
  const opts = {
    nowFn: clock.nowFn,
    probeImpl: advancingFailProbe(clock),
    spawnImpl: () => { spawned += 1; return okSpawn(); },
    readyTimeoutMs: 40,
    pollIntervalMs: 1,
  };

  const first = await ensureLocalModel(opts);
  assert.equal(first.ok, false);
  assert.equal(first.code, 'LOCAL_MODEL_START_TIMEOUT');
  assert.equal(spawned, 1);

  clock.advance(10); // 距上次启动仍 < READY_TIMEOUT_MS（120s）
  const second = await ensureLocalModel(opts);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'LOCAL_MODEL_STARTING');
  assert.equal(spawned, 1); // 未重复 spawn
});
