'use strict';

const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const NEWS_CLI = path.join(PROJECT_ROOT, 'scripts', 'news-cli.js');

function spawnTask(name, args, options) {
  const child = options.spawnImpl(process.execPath, [NEWS_CLI, 'min-review', ...args], {
    cwd: PROJECT_ROOT,
    shell: false,
    stdio: 'inherit',
  });
  if (!child || typeof child.once !== 'function') {
    throw new Error(`${name} 未返回可等待的子进程`);
  }
  return child;
}

function waitForChild(name, child) {
  return new Promise(resolve => {
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      resolve({ name, ...outcome });
    };
    child.once('error', error => finish({ ok: false, error }));
    child.once('close', (code, signal) => {
      finish(code === 0 ? { ok: true, code, signal } : { ok: false, code, signal });
    });
  });
}

function stopChild(name, child, logger) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
    logger.error(`[中止] ${name} 失败后已请求停止本次启动的另一子进程（PID ${child.pid ?? 'unknown'}）。`);
  } catch (error) {
    logger.error(`[警告] 无法停止本次启动的 ${name} 子进程：${error.message}`);
  }
}

/**
 * 在第一次审核结论落地后安全并行运行两个只读候选层任务。
 * 任何失败都使整体失败，并且只尝试终止本函数创建并记录的另一个子进程。
 */
async function runAfterFirstReview(options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const logger = options.logger || console;
  const children = [];
  try {
    const refine = spawnTask('关键词提纯', ['refine'], { spawnImpl });
    children.push({ name: '关键词提纯', child: refine });
    const aiTop = spawnTask('AI top 名单', ['ai-top'], { spawnImpl });
    children.push({ name: 'AI top 名单', child: aiTop });
  } catch (error) {
    for (const task of children) stopChild(task.name, task.child, logger);
    throw new Error(`启动审核后任务失败：${error.message}`);
  }

  const pending = new Map(children.map(task => [task.name, waitForChild(task.name, task.child)]));
  const results = [];
  let failed = false;
  while (pending.size) {
    const result = await Promise.race([...pending.values()]);
    pending.delete(result.name);
    results.push(result);
    if (!result.ok && !failed) {
      failed = true;
      logger.error(`[错误] ${result.name} 失败。正在停止本次启动的其余任务。`);
      for (const task of children) {
        if (task.name !== result.name) stopChild(task.name, task.child, logger);
      }
    }
  }

  const failures = results.filter(result => !result.ok);
  if (failures.length) {
    const detail = failures.map(result => {
      if (result.error) return `${result.name}: ${result.error.message}`;
      return `${result.name}: exit=${result.code ?? 'unknown'}${result.signal ? ` signal=${result.signal}` : ''}`;
    }).join('；');
    throw new Error(`审核后并行任务失败：${detail}`);
  }
  return results;
}

async function main() {
  await runAfterFirstReview();
  console.log('✅ 关键词提纯清单与 AI top 清单均已生成。');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { PROJECT_ROOT, NEWS_CLI, runAfterFirstReview, stopChild, waitForChild };
