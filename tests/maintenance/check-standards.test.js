/**
 * check-standards.test.js — 规范静态检查器自身回归
 *
 * 全部用临时目录 fixture 隔离，不依赖真实 src 树的当前状态：
 *   - 正例：命中依赖方向违规、垫片、旧契约短语、行数/导出阈值、环、console、
 *     白名单豁免、CODEBASE-MAP 缺登记
 *   - 反例：合法文件零误报、白名单不存在文件静默忽略
 *
 * 运行方式：node --test tests/maintenance/check-standards.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runChecks, stripCommentsAndStrings, countExports } = require('../../scripts/check-standards');

// ── fixture 工具 ──
function makeFixture(t, files, { whitelist, codemap } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-standards-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  fs.writeFileSync(path.join(root, 'CODEBASE-MAP.md'), codemap !== undefined ? codemap : '默认 map\n');
  if (whitelist !== undefined) {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'check-standards.whitelist.json'), JSON.stringify(whitelist));
  }
  return root;
}

function violationsFor(root, rule) {
  return runChecks({ rootDir: root, codemapPath: path.join(root, 'CODEBASE-MAP.md') }).violations
    .filter(v => v.rule === rule);
}

// ── 文本工具 ──
test('stripCommentsAndStrings 清注释但保留字符串（require 参数可匹配）', (t) => {
  const src = "// const gone = require('./a');\nconst kept = require('./b');\n/* block */";
  const out = stripCommentsAndStrings(src);
  assert.ok(!out.includes('gone'), '行注释内容应被清除');
  assert.ok(!out.includes('block'), '块注释内容应被清除');
  assert.ok(out.includes("'./b'"), '字符串字面量应保留');
});

test('countExports 统计 CommonJS 命名导出、exports.x 与 ES 导出', (t) => {
  const cjs = "module.exports = { a, b: 1, c: { x, y }, d };\nexports.e = 1;\n";
  assert.strictEqual(countExports(stripCommentsAndStrings(cjs)), 5);
  const es = "export { p, q };\nexport function f() {}\nexport const k = 1;\nexport default g;\n";
  assert.strictEqual(countExports(stripCommentsAndStrings(es)), 5);
});

// ── 检测项 1：依赖方向 ──
test('依赖方向：业务域互引命中，→shared 与 maintenance→业务域放行', (t) => {
  const root = makeFixture(t, {
    'src/catalog/a.js': "const { readJson } = require('../news/min/min-store');\nconst { DIRS } = require('../shared/paths');\n",
    'src/news/min/min-store.js': "module.exports = { readJson };\n",
    'src/shared/paths.js': "module.exports = { DIRS };\n",
    'src/maintenance/validate-x.js': "const { readJson } = require('../news/min/min-store');\n",
    'src/maintenance/bad.js': "function load() {\n  return require('../news/min/min-store');\n}\n",
  });
  const violations = violationsFor(root, 'dependency-direction');
  assert.ok(violations.some(v => v.file === 'src/catalog/a.js' && v.message.includes('域间互引 catalog→news')), '域间互引应命中');
  assert.ok(!violations.some(v => v.file === 'src/catalog/a.js' && v.message.includes('shared')), '业务域→shared 应放行');
  assert.ok(!violations.some(v => v.file === 'src/maintenance/validate-x.js'), 'maintenance→业务域 应放行');
  assert.ok(violations.some(v => v.file === 'src/maintenance/bad.js' && v.message.includes('函数体内 require')), '函数体内 require 应命中');
});

test('依赖方向：src→scripts 与 shared→其他域命中', (t) => {
  const root = makeFixture(t, {
    'src/catalog/tx.js': "require('../../scripts/build-dist');\n",
    'src/shared/bad.js': "require('../catalog/catalog-workbench');\n",
    'src/catalog/catalog-workbench.js': "module.exports = {};\n",
    'scripts/build-dist.js': "module.exports = {};\n",
  });
  const violations = violationsFor(root, 'dependency-direction');
  assert.ok(violations.some(v => v.file === 'src/catalog/tx.js' && v.message.includes('src→scripts')), 'src→scripts 应命中');
  assert.ok(violations.some(v => v.file === 'src/shared/bad.js' && v.message.includes('shared→其他域')), 'shared→其他域 应命中');
});

test('依赖方向：浏览器域 import Node 内置模块命中，import 本域放行', (t) => {
  const root = makeFixture(t, {
    'src/web/js/app.js': "import { helper } from './util.js';\nimport fs from 'node:fs';\n",
    'src/web/js/util.js': "export function helper() {}\n",
  });
  const violations = violationsFor(root, 'dependency-direction');
  assert.strictEqual(violations.length, 1);
  assert.ok(violations[0].message.includes('浏览器域 import Node 模块'));
});

// ── 检测项 2：垫片 ──
test('垫片：module.exports = require(...) 与整体仅 re-export 均命中', (t) => {
  const root = makeFixture(t, {
    'src/shared/passthrough.js': "'use strict';\nmodule.exports = require('./providers');\n",
    'src/catalog/ai/reexport.js': `'use strict';

const gateway = require('../../shared/llm-gateway');

module.exports = {
  extractJson: gateway.extractJson,
  diagnosticsOf: gateway.diagnosticsOf,
};
`,
    'src/shared/llm-gateway.js': "module.exports = { extractJson, diagnosticsOf };\n",
    'src/shared/providers/index.js': "module.exports = require('./real');\n",
    'src/shared/providers/real.js': "module.exports = { real: true };\n",
  }, { whitelist: { shim: [{ file: 'src/shared/providers/index.js', count: 1, note: '装配真身豁免' }] } });
  const files = violationsFor(root, 'shim').map(v => v.file);
  assert.ok(files.includes('src/shared/passthrough.js'), '纯透传应命中');
  assert.ok(files.includes('src/catalog/ai/reexport.js'), '整体仅 re-export 应命中');
  assert.ok(!files.includes('src/shared/providers/index.js'), '白名单豁免应放行');
});

test('垫片：有自有逻辑的文件不误报', (t) => {
  const root = makeFixture(t, {
    'src/catalog/facade.js': `'use strict';
const gateway = require('../shared/llm-gateway');
const { readJson } = require('../news/min/min-store');

function run() {
  const data = readJson();
  return gateway.extractJson(data);
}
module.exports = { run, extractJson: gateway.extractJson };
`,
    'src/shared/llm-gateway.js': "module.exports = { extractJson };\n",
    'src/news/min/min-store.js': "module.exports = { readJson };\n",
  });
  assert.strictEqual(violationsFor(root, 'shim').length, 0);
});

// ── 检测项 3：旧契约叙事 ──
test('旧契约叙事：注释与字符串中的短语命中，正文提及 v2 不误报', (t) => {
  const root = makeFixture(t, {
    'src/catalog/a.js': "// 旧版字段已随 v2 移除\nconst msg = '不再校验';\nconst VERSION = 2; // v2 主链\n",
  });
  const violations = violationsFor(root, 'legacy-narrative');
  assert.strictEqual(violations.length, 1);
  assert.ok(violations[0].message.includes('旧版') && violations[0].message.includes('已随 v2') && violations[0].message.includes('不再校验'));
  assert.ok(!violations[0].message.includes('@deprecated'));
});

// ── 检测项 4：体量与导出 ──
test('体量与导出：行数与导出阈值命中', (t) => {
  const big = Array.from({ length: 402 }, (_, i) => `// 第 ${i} 行`).join('\n');
  const manyExports = `module.exports = { ${Array.from({ length: 16 }, (_, i) => `f${i}`).join(', ')} };\n`;
  const root = makeFixture(t, {
    'src/catalog/big.js': big,
    'src/catalog/many.js': manyExports,
    'src/catalog/ok.js': "module.exports = { a, b };\n",
  });
  const files = violationsFor(root, 'size-exports').map(v => `${v.file}: ${v.message}`);
  assert.ok(files.some(f => f.startsWith('src/catalog/big.js: 行数 40')), '行数超限应命中');
  assert.ok(files.some(f => f.startsWith('src/catalog/many.js: 导出 16')), '导出超限应命中');
  assert.ok(!files.some(f => f.startsWith('src/catalog/ok.js')), '合规文件不报');
});

test('体量与导出：require(变量) 与单值默认导出命中，require.main 入口豁免', (t) => {
  const root = makeFixture(t, {
    'src/catalog/dynamic.js': "const target = './x';\nrequire(target);\n",
    'src/catalog/single.js': "module.exports = doWork;\nfunction doWork() {}\n",
    'src/catalog/cli.js': "module.exports = main;\nfunction main() {}\nif (require.main === module) { main(); }\n",
  });
  const violations = violationsFor(root, 'size-exports');
  assert.ok(violations.some(v => v.file === 'src/catalog/dynamic.js' && v.message.includes('require(变量)')), '动态引用应命中');
  assert.ok(violations.some(v => v.file === 'src/catalog/single.js' && v.message.includes('单值默认导出')), '单值默认导出应命中');
  assert.ok(!violations.some(v => v.file === 'src/catalog/cli.js'), 'require.main 入口应豁免');
});

// ── 检测项 5：模块图环 ──
test('环检测：A→B→A 命中，无环图不报', (t) => {
  const root = makeFixture(t, {
    'src/catalog/a.js': "const b = require('./b');\nmodule.exports = { a: 1 };\n",
    'src/catalog/b.js': "const a = require('./a');\nmodule.exports = { b: 1 };\n",
    'src/news/n1.js': "const n2 = require('./n2');\nmodule.exports = {};\n",
    'src/news/n2.js': "module.exports = {};\n",
  });
  const cycles = violationsFor(root, 'cycles');
  assert.strictEqual(cycles.length, 1);
  assert.deepStrictEqual(cycles[0].file.split('|'), ['src/catalog/a.js', 'src/catalog/b.js']);
});

// ── 检测项 6：组装纪律 ──
test('组装纪律：console 命中、process.exit 命中、env 豁免文件放行', (t) => {
  const root = makeFixture(t, {
    'src/catalog/loggy.js': "console.log('hi');\nconsole.warn('w');\nprocess.exit(1);\nprocess.env.HOME;\n",
    'src/shared/env.js': "const key = process.env.APP_KEY;\nmodule.exports = { key };\n",
    'src/catalog/loadMyConfig.js': "const cfg = process.env.MY_CFG;\nmodule.exports = { cfg };\n",
  });
  const byFile = {};
  for (const v of violationsFor(root, 'assembly')) {
    (byFile[v.file] = byFile[v.file] || []).push(v.message);
  }
  const loggy = (byFile['src/catalog/loggy.js'] || []).join(' ');
  assert.ok(loggy.includes('console.log') && loggy.includes('console.warn'), 'console 应命中');
  assert.ok(loggy.includes('process.exit'), 'process.exit 应命中');
  assert.ok(loggy.includes('process.env'), '非豁免文件 process.env 应命中');
  assert.ok(!byFile['src/shared/env.js'] && !byFile['src/catalog/loadMyConfig.js'], 'env.js 与 load*Config 应豁免');
});

// ── 检测项 7：CODEBASE-MAP 完整性 ──
test('CODEBASE-MAP：未登记文件命中，已登记放行', (t) => {
  const root = makeFixture(t, {
    'src/catalog/listed.js': "module.exports = {};\n",
    'src/catalog/unlisted.js': "module.exports = {};\n",
  }, { codemap: '- [listed.js](src/catalog/listed.js) — 已登记\n' });
  const violations = violationsFor(root, 'codemap');
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].file, 'src/catalog/unlisted.js');
});

// ── 白名单机制 ──
test('白名单：命中条目豁免；指向不存在文件静默忽略；未命中条目仍报', (t) => {
  const root = makeFixture(t, {
    'src/catalog/loggy.js': "console.log('hi');\n",
    'src/catalog/noisy.js': "console.log('hi');\n",
  }, {
    whitelist: {
      assembly: [
        { file: 'src/catalog/loggy.js', count: 1, note: '已登记' },
        { file: 'src/catalog/deleted-file.js', count: 1, note: '文件已删，静默忽略' },
      ],
    },
  });
  const violations = violationsFor(root, 'assembly');
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].file, 'src/catalog/noisy.js', '白名单外违规应报');
});

test('白名单 count：实际违规数恰等于记载数时放行', (t) => {
  const root = makeFixture(t, {
    'src/catalog/loggy.js': "console.log('a');\nconsole.warn('b');\n",
  }, { whitelist: { assembly: [{ file: 'src/catalog/loggy.js', count: 2, note: '存量 2 处' }] } });
  assert.strictEqual(violationsFor(root, 'assembly').length, 0);
  assert.strictEqual(violationsFor(root, 'whitelist-growth').length, 0);
});

test('白名单 count：实际违规数超出记载数时报 whitelist-growth', (t) => {
  const root = makeFixture(t, {
    'src/catalog/loggy.js': "console.log('a');\nconsole.warn('b');\nconsole.error('c');\n",
  }, { whitelist: { assembly: [{ file: 'src/catalog/loggy.js', count: 2, note: '存量 2 处' }] } });
  const growth = violationsFor(root, 'whitelist-growth');
  assert.strictEqual(growth.length, 1);
  assert.strictEqual(growth[0].file, 'src/catalog/loggy.js');
  assert.ok(growth[0].message.includes('记载数 2') && growth[0].message.includes('实际违规 3'), 'message 应含记载数与实际数');
});

test('白名单 count：条目缺 count 时 fail-closed 不豁免', (t) => {
  const root = makeFixture(t, {
    'src/catalog/loggy.js': "console.log('hi');\n",
  }, { whitelist: { assembly: [{ file: 'src/catalog/loggy.js', note: '缺 count 字段' }] } });
  const violations = violationsFor(root, 'assembly');
  assert.strictEqual(violations.length, 1, '缺 count 的条目不应豁免');
});

test('依赖方向：浏览器域 import shared 命中（盲区封堵）', (t) => {
  const root = makeFixture(t, {
    'src/web/js/app.js': "import { fmt } from '../../shared/beijing-time.js';\n",
    'src/shared/beijing-time.js': "export function fmt() {}\n",
  });
  const violations = violationsFor(root, 'dependency-direction');
  assert.strictEqual(violations.length, 1);
  assert.ok(violations[0].message.includes('浏览器域跨域引用 web→shared'));
});

test('runChecks 汇总：扫描数、退出判定与分组统计', (t) => {
  const root = makeFixture(t, {
    'src/catalog/a.js': "console.log('x');\n",
    'src/catalog/b.js': "module.exports = {};\n",
  }, { whitelist: { assembly: [{ file: 'src/catalog/a.js', count: 1, note: '已登记' }] }, codemap: '- [a.js](src/catalog/a.js) — 已登记\n- [b.js](src/catalog/b.js) — 已登记\n' });
  const result = runChecks({ rootDir: root, codemapPath: path.join(root, 'CODEBASE-MAP.md') });
  assert.strictEqual(result.scanned, 2);
  assert.strictEqual(result.total, 0);
  assert.strictEqual(Object.keys(result.byRule).length, 0);
});
