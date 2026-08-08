'use strict';

/**
 * check-secrets.js — 密钥扫描守卫（零依赖）
 *
 * 目标：防止 API Key / 令牌以明文形式进入版本库。
 * 做法：扫描「会进 git 的」文件（tracked + 未被 ignore 的 untracked），
 * 命中高熵密钥形态即以非零退出码终止（CI 门禁、validate.js 原则6）。
 *
 * 设计约定：
 *   - 只匹配「高熵」形态（长度限定 + 明确前缀），刻意不匹配低熵文本
 *     （如正则字符类定义、`sk-` 短占位、文档示例），避免第三方 bundle
 *     （如 .obsidian 插件自带的密钥检测正则）造成误报；
 *   - 用 `git ls-files -c -o --exclude-standard` 取文件清单：gitignore 的
 *     `.env`、第三方 skills、会话数据等天然不扫描（那些本来就该存 key）；
 *   - 二进制文件跳过（读到的字节含 \0 即视为二进制）。
 *
 * 用法：
 *   node scripts/check-secrets.js          # 扫描，有命中则 exit 1
 *   node scripts/check-secrets.js --selftest  # 仅跑模式自检
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');

/**
 * 高熵密钥形态表。
 * samplePrefix / sampleLength 用于自检动态构造正例（拼接，避免源码自身命中）。
 * 长度阈值取「真实 key 长度下限」：OpenAI/DeepSeek sk- 32+、GitHub PAT 36、
 * Google AIza 35、AWS AKIA 16、Anthropic sk-ant 40+。
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
function listFiles() {
  try {
    const out = execFileSync(
      'git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'],
      { cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    return out.split('\0').filter(Boolean).map(f => path.join(PROJECT_DIR, f));
  } catch (e) {
    // 回退：非 git 环境下手动遍历，排除注定不该扫的目录
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
    })(PROJECT_DIR);
    return files;
  }
}

/**
 * 扫描整个仓库，返回命中清单。
 * @returns {{file:string,line:number,pattern:string,preview:string}[]}
 */
function scanRepo() {
  const findings = [];
  for (const file of listFiles()) {
    const rel = path.relative(PROJECT_DIR, file);
    if (!fs.existsSync(file)) continue;
    if (!fs.statSync(file).isFile()) continue;

    const buf = fs.readFileSync(file);
    if (buf.includes(0)) continue; // 二进制跳过

    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const p of PATTERNS) {
        p.regex.lastIndex = 0;
        const m = p.regex.exec(line);
        if (m) {
          const preview = (m[0].length > 12 ? m[0].slice(0, 6) + '…' + m[0].slice(-6) : m[0]);
          findings.push({ file: rel, line: i + 1, pattern: p.name, preview });
          break; // 一行报告一次即可
        }
      }
    }
  }
  return findings;
}

/** 模式自检：每个模式必须命中动态构造的正例、且不命中低熵负例 */
function selftest() {
  let ok = true;
  const negative = 'sk-abcdef 短占位 github_pat_ short AKIA1234 AIza短 无密钥';

  for (const p of PATTERNS) {
    const positive = p.samplePrefix + 'A'.repeat(p.sampleLength);
    p.regex.lastIndex = 0;
    if (!p.regex.test(positive)) {
      console.error(`✗ ${p.name}: 未命中正例`);
      ok = false;
    }
    p.regex.lastIndex = 0;
    if (p.regex.test(negative)) {
      console.error(`✗ ${p.name}: 误命中低熵负例`);
      ok = false;
    }
  }
  console.log(ok ? '✅ 密钥模式自检通过' : '❌ 密钥模式自检失败');
  return ok;
}

function main() {
  if (process.argv.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
    return;
  }

  const findings = scanRepo();
  if (findings.length) {
    console.error('❌ 检测到疑似密钥，禁止提交：');
    for (const f of findings) console.error(`   ${f.file}:${f.line}  [${f.pattern}] ${f.preview}`);
    console.error('请将密钥移入 .env（已 gitignore）或用环境变量注入，再重试。');
    process.exit(1);
  }
  console.log(`✅ 密钥扫描通过：${listFiles().length} 个文件无高熵密钥形态`);
}

module.exports = { scanRepo, selftest, PATTERNS };

if (require.main === module) main();
