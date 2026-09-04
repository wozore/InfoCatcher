'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PROJECT_DIR } = require('../shared/env');

/**
 * 高熵密钥形态表。
 * samplePrefix / sampleLength 用于自检动态构造正例（拼接，避免源码自身命中）。
 * 长度阈值取真实 key 长度下限。
 */
const PATTERNS = [
  { name: 'OpenAI/DeepSeek sk-', regex: /\bsk-[A-Za-z0-9]{24,}\b/g, samplePrefix: 'sk-', sampleLength: 32 },
  { name: 'Anthropic sk-ant-', regex: /\bsk-ant-[A-Za-z0-9]{20,}\b/g, samplePrefix: 'sk-ant-', sampleLength: 32 },
  { name: 'GitHub classic PAT', regex: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g, samplePrefix: 'ghp_', sampleLength: 36 },
  { name: 'GitHub fine-grained PAT', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, samplePrefix: 'github_pat_', sampleLength: 40 },
  { name: 'AWS access key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, samplePrefix: 'AKIA', sampleLength: 16 },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, samplePrefix: 'AIza', sampleLength: 35 },
  { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, samplePrefix: 'xoxb-', sampleLength: 20 },
  { name: 'Stripe key', regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g, samplePrefix: 'sk_live_', sampleLength: 24 },
];

/** 收集待扫描文件：git 可见的全部文件（tracked + 非 ignore 的 untracked） */
function listFiles(rootDir = PROJECT_DIR) {
  try {
    const out = execFileSync(
      'git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'],
      { cwd: rootDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    return out.split('\0').filter(Boolean).map(f => path.join(rootDir, f));
  } catch (_) {
    const SKIP_DIRS = new Set(['.git', 'node_modules', '.env']);
    const files = [];
    (function walk(d) {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          if (!SKIP_DIRS.has(ent.name)) walk(path.join(d, ent.name));
        } else {
          files.push(path.join(d, ent.name));
        }
      }
    })(rootDir);
    return files;
  }
}

/**
 * 扫描指定目录下的文件，返回命中清单。
 * @param {string} [rootDir=PROJECT_DIR]
 * @returns {{file:string,line:number,pattern:string,preview:string}[]}
 */
function scanRepo(rootDir = PROJECT_DIR) {
  const findings = [];
  for (const file of listFiles(rootDir)) {
    const rel = path.relative(rootDir, file).split(path.sep).join('/');
    if (!fs.existsSync(file)) continue;
    if (!fs.statSync(file).isFile()) continue;

    const buf = fs.readFileSync(file);
    if (buf.includes(0)) continue;

    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const p of PATTERNS) {
        p.regex.lastIndex = 0;
        const m = p.regex.exec(line);
        if (m) {
          const preview = (m[0].length > 12 ? m[0].slice(0, 6) + '…' + m[0].slice(-6) : m[0]);
          findings.push({ file: rel, line: i + 1, pattern: p.name, preview });
          break;
        }
      }
    }
  }
  return findings;
}

/** 模式自检：每个模式必须命中动态构造的正例、且不命中低熵负例 */
function selftest() {
  const negative = 'sk-abcdef 短占位 github_pat_ short AKIA1234 AIza短 无密钥';
  for (const p of PATTERNS) {
    const positive = p.samplePrefix + 'A'.repeat(p.sampleLength);
    p.regex.lastIndex = 0;
    if (!p.regex.test(positive)) return false;
    p.regex.lastIndex = 0;
    if (p.regex.test(negative)) return false;
  }
  return true;
}

module.exports = {
  PATTERNS,
  listFiles,
  scanRepo,
  selftest,
};
