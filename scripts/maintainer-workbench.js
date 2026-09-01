#!/usr/bin/env node
'use strict';

const { loadDotEnv } = require('../src/shared/env');
const { createMaintainerWorkbenchServer } = require('../src/maintenance/maintainer-workbench-server');

async function main() {
  loadDotEnv();
  const workbench = createMaintainerWorkbenchServer();
  const started = await workbench.start();
  console.log(`维护者工作台已启动：${started.url}`);
  console.log('仅监听 127.0.0.1；按 Ctrl+C 停止。');
  const stop = async () => {
    try { await workbench.close(); } finally { process.exit(0); }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
