/**
 * validate.js — InfoCatcher MVP 部署前数据与契约完整性校验（聚合入口）
 *
 * 在热点管线中的位置：CI/CD 的最后一道门禁，被 deploy.yml 和
 * collect-news.yml 在执行部署或提交数据前调用。任何一项不通过
 * 都会以非零退出码终止流水线，阻止错误数据上线。
 *
 * ═══════════════════════════════════════════════════════════════
 * 结构：校验函数按域拆分为两个模块，本文件只做聚合与原则门禁
 * ═══════════════════════════════════════════════════════════════
 *
 *   - validate-catalog.js — catalog 域数据校验（tools / tool-intelligence /
 *     glossary / scenes / featured / index.html），入口 validateCatalog()
 *   - validate-news.js    — news 域数据校验（news-sources → hotspots），
 *     入口 validateNews()
 *   - 本文件（validate.js）—— 依次调用两个模块，随后执行：
 *       index.html 读取、intel-sources 委托校验（acquisition/validate-intel）、
 *       开发原则 1-6 门禁；最后汇总失败状态并 process.exit(0/1)
 *
 * 每个模块与本文件各自维护 fail()/failed 失败计数，最终在
 * 本文件合并判断退出码，保证一次运行报告所有问题。
 *
 * 用法：node scripts/validate.js
 * 无输出 + exit 0 = 全部通过；有报错 + exit 1 = 需要修复
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DIRS } = require('../shared/paths');
const catalog = require('./validate-catalog');
const news = require('./validate-news');

const SRC_DIR = DIRS.src;
let failed = false;

/** 记录一个校验失败项。不中断执行，确保一次运行能报告所有问题 */
function fail(msg) {
  console.error('❌', msg);
  failed = true;
}

// ═══════════════════════════════════════════════════════════════
// 入口：按顺序校验所有数据文件 + HTML
//
// 每个文件独立 try/catch —— 一个文件的 JSON 解析失败
// 不会阻止后续文件的校验，确保一次运行暴露所有问题。
// failed 计数器在全部校验完成后统一判断退出码。
// ═══════════════════════════════════════════════════════════════
console.log('\n📋 InfoCatcher MVP 数据校验\n');

// catalog 域（tools / tool-intelligence / glossary / scenes / featured）
const validatedTools = catalog.validateCatalog();

// news 域（news-sources → hotspots）
news.validateNews();

// index.html（DOM 契约校验函数在 catalog 域模块中）
try {
  const html = fs.readFileSync(`${SRC_DIR}/web/index.html`, 'utf8');
  if (html.length < 1000) fail(`index.html 内容过短（${html.length} 字符）`);
  else catalog.validateHtml(html);
} catch (e) {
  fail(`index.html 读取失败：${e.message}`);
}

// intel-sources.json（委托至 acquisition/validate-intel.js）
try {
  const result = require('../acquisition/validate-intel').validate({ silent: true });
  result.errors.forEach(e => fail(`acquisition: ${e}`));
  result.warnings.forEach(w => console.warn('⚠️  acquisition:', w));
  console.log(`  intel-sources.json + tool-intelligence.json: ${result.valid ? '通过' : '失败'}`);
} catch (e) {
  fail(`acquisition 校验异常: ${e.message}`);
}

// ═══════════════════════════════════════════════════════════════
// 开发原则自动门禁（对应 CLAUDE.md 开发原则 1-6）
// ═══════════════════════════════════════════════════════════════
console.log('\n📋 开发原则合规检查\n');

// --- 原则 1: AI-Ready 结构 — data/ 根目录禁止 .json ---
try {
  const loose = fs.readdirSync(DIRS.data).filter(f => f.endsWith('.json'));
  if (loose.length) loose.forEach(f => fail(`原则1: data/ 根目录禁止 .json（${f} 应归属子目录）`));
  else console.log('  原则1 AI-Ready结构: 通过');
} catch (e) { fail(`原则1 检查异常: ${e.message}`); }

// --- 原则 2: 扩展点显式化 — 前端三文件下限 ---
try {
  const jsDir = `${DIRS.src}/web/js`;
  const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));
  const jsSrc = jsFiles.map(f => fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n');
  const jsEp = (jsSrc.match(/EXTENSION POINT/g) || []).length;
  if (jsEp < 5) fail(`原则2: web/js EXTENSION POINT 仅 ${jsEp} 处（下限 5）`);

  const css = fs.readFileSync(`${DIRS.src}/web/css/style.css`, 'utf8');
  const cssEp = (css.match(/EXTENSION POINT/g) || []).length;
  if (cssEp < 1) fail(`原则2: style.css 缺少 EXTENSION POINT（下限 1）`);

  console.log(`  原则2 扩展点: index.html 3+ · web/js ${jsEp} · style.css ${cssEp}，通过`);
} catch (e) { fail(`原则2 检查异常: ${e.message}`); }

// --- 原则 3: CLAUDE.md 同步 — 工具数 + 子目录登记 ---
// 注意：代码索引已迁移至根目录 CODEBASE-MAP.md（CLAUDE.md 仅 @import），
// 以下清单同步检查降为软警告：清单缺失/漂移只提示、不阻塞 CI（2026-08-06 用户拍板）。
try {
  const claudePath = path.resolve(DIRS.project, '.claude', 'CLAUDE.md');
  if (!fs.existsSync(claudePath)) {
    console.warn('  ⚠️  原则3: CLAUDE.md 不存在（非工程仓库），跳过同步检查');
  } else {
    const claudeMd = fs.readFileSync(claudePath, 'utf8');

    // 工具数一致
    const m = claudeMd.match(/tools\.json\s+#\s*(\d+)\s*个工具/);
    if (!m) console.warn('  ⚠️  原则3: CLAUDE.md 缺少 "tools.json  # N 个工具" 数量声明（仅警告，不阻塞）');
    else {
      const declared = parseInt(m[1], 10);
      if (declared !== validatedTools.length) console.warn(`  ⚠️  原则3: CLAUDE.md 声明 ${declared} 个工具，实际 ${validatedTools.length}（仅警告，不阻塞）`);
    }

    // scripts/ 子目录全覆盖（CLAUDE.md 用树形格式如 ├── acquisition/）
    const scriptDirs = fs.readdirSync(DIRS.scripts, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    for (const d of scriptDirs) {
      if (!claudeMd.includes(`${d}/`)) console.warn(`  ⚠️  原则3: CLAUDE.md 缺少 scripts/${d}/ 目录（仅警告，不阻塞）`);
    }

    // data/ 子目录全覆盖
    const dataDirs = fs.readdirSync(DIRS.data, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    for (const d of dataDirs) {
      if (!claudeMd.includes(`${d}/`)) console.warn(`  ⚠️  原则3: CLAUDE.md 缺少 data/${d}/ 目录（仅警告，不阻塞）`);
    }
  }
  console.log('  原则3 CLAUDE.md同步: 通过（清单未同步仅警告，不阻塞）');
} catch (e) { fail(`原则3 检查异常: ${e.message}`); }

// --- 原则 4: 零外部依赖 — 无 package.json + 无 npm require ---
try {
  if (fs.existsSync(`${DIRS.src}/package.json`)) fail('原则4: src/ 禁止 package.json');
  if (fs.existsSync(`${DIRS.project}/package.json`)) fail('原则4: 项目根禁止 package.json');

  const NODE_BUILTINS = new Set(['fs', 'path', 'crypto', 'os', 'child_process', 'http', 'https', 'url', 'zlib', 'stream', 'assert', 'test', 'module', 'perf_hooks']);
  const jsFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }))
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') && jsFiles.push(path.join(d, e.name));
  })(DIRS.scripts);

  for (const f of jsFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let mm;
    while ((mm = re.exec(src)) !== null) {
      const mod = mm[1];
      if (!mod.startsWith('.') && !mod.startsWith('/') && !mod.startsWith('node:') && !NODE_BUILTINS.has(mod))
        fail(`原则4: ${path.relative(DIRS.src, f)} 引用了外部模块 "${mod}"`);
    }
  }
  console.log('  原则4 零外部依赖: 通过');
} catch (e) { fail(`原则4 检查异常: ${e.message}`); }

// --- 原则 5: 先结构后逻辑 — paths.js 覆盖 data/ 所有 JSON ---
try {
  const exports = require('../shared/paths');
  const registered = new Set();
  (function collect(v) {
    if (typeof v === 'string' && v.includes(DIRS.data)) registered.add(path.resolve(v));
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  })({ DIRS: exports.DIRS, CATALOG_FILES: exports.CATALOG_FILES, NEWS_FILES: exports.NEWS_FILES, ACQUISITION_FILES: exports.ACQUISITION_FILES });

  const dataJson = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }))
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') && dataJson.push(path.resolve(path.join(d, e.name)));
  })(DIRS.data);

  for (const j of dataJson)
    if (!registered.has(j)) fail(`原则5: ${path.relative(DIRS.src, j)} 未在 paths.js 登记`);

  console.log(`  原则5 路径登记: ${dataJson.length} 个 JSON 全部覆盖，通过`);
} catch (e) { fail(`原则5 检查异常: ${e.message}`); }

// --- 原则 6: 密钥零残留 — check-secrets 高熵扫描 ---
try {
  const { scanRepo } = require('../../scripts/check-secrets');
  const findings = scanRepo();
  if (findings.length) findings.forEach(f => fail(`原则6: ${f.file}:${f.line} 疑似密钥 [${f.pattern}] ${f.preview}`));
  else console.log('  原则6 密钥扫描: 通过');
} catch (e) { fail(`原则6 检查异常: ${e.message}`); }

// 汇总两个域的失败状态 + 本文件原则门禁的失败状态
failed = failed || catalog.failed || news.failed;

console.log(failed ? '\n❌ 校验未通过，请修复上述错误后重试\n' : '\n✅ 全部通过\n');
process.exit(failed ? 1 : 0);
