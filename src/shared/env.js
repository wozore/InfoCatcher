'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');

/**
 * 零依赖 .env 加载器（项目禁止外部包，见 validate.js 原则4）。
 *
 * 约定：
 *   - 只解析 dotenv 子集：空行 / # 注释 / `export KEY=VALUE` / 成对引号；
 *   - 不覆盖已存在的环境变量：CI 中 GitHub Secrets 注入的优先级永远高于 .env；
 *   - 文件不存在或为空时静默返回 0，不报错（CI 环境无 .env 是常态）。
 *
 * @param {string} [filePath]  .env 路径，缺省取项目根目录的 .env
 * @returns {number} 实际写入 process.env 的变量个数
 */
function loadDotEnv(filePath) {
  const resolved = filePath || path.join(PROJECT_DIR, '.env');
  if (!fs.existsSync(resolved)) return 0;

  const raw = fs.readFileSync(resolved, 'utf8');
  let loaded = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // 允许 `export KEY=VALUE` 写法（与 shell 语义一致）
    const noExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;

    const eq = noExport.indexOf('=');
    if (eq <= 0) continue; // 无 KEY 或没有 `=` 的行跳过

    const key = noExport.slice(0, eq).trim();
    let value = noExport.slice(eq + 1).trim();

    // 去掉成对引号（"VALUE" 或 'VALUE'）
    const q = value[0];
    if ((q === '"' || q === "'") && value[value.length - 1] === q) value = value.slice(1, -1);

    if (!key || process.env[key] !== undefined) continue; // 已有值优先，不覆盖
    process.env[key] = value;
    loaded++;
  }
  return loaded;
}

module.exports = { loadDotEnv, PROJECT_DIR };
