'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runAfterFirstReview } = require('../../scripts/run-after-first-review');

function fakeChild({ code = 0, error = null, delay = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = 100 + delay;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.signalCode = 'SIGTERM';
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  };
  queueMicrotask(() => {
    if (error) child.emit('error', error);
    else setTimeout(() => {
      child.exitCode = code;
      child.emit('close', code, null);
    }, delay);
  });
  return child;
}

function logger() {
  return { error() {} };
}

test('审核后并行编排：两个子任务成功才整体成功', async () => {
  const children = [fakeChild(), fakeChild()];
  const result = await runAfterFirstReview({ spawnImpl: () => children.shift(), logger: logger() });
  assert.equal(result.length, 2);
  assert.ok(result.every(item => item.ok));
});

test('审核后并行编排：任一失败时停止本次启动的另一个子进程', async () => {
  const failed = fakeChild({ code: 1 });
  const slow = fakeChild({ code: 0, delay: 20 });
  const children = [failed, slow];
  await assert.rejects(
    runAfterFirstReview({ spawnImpl: () => children.shift(), logger: logger() }),
    /审核后并行任务失败/,
  );
  assert.equal(slow.signalCode, 'SIGTERM');
});

test('审核后并行编排：启动失败会显式失败', async () => {
  assert.rejects(
    runAfterFirstReview({ spawnImpl: () => { throw new Error('spawn failed'); }, logger: logger() }),
    /启动审核后任务失败/,
  );
});
