/**
 * check-standards.js — 零依赖代码规范静态检查器（Node 20 原生，无 npm 依赖）
 *
 * 检测范围：src/**\/*.{js,mjs}。检测项（规范正文见 docs/codebase-refactor-plan.md §1.7）：
 *   1. dependency-direction — 域间互引 / src→scripts / 浏览器域→Node 模块 /
 *      shared→其他域 / 函数体内 require
 *   2. shim — module.exports = require(...) 透传或整体仅 re-export 的垫片文件
 *   3. legacy-narrative — 注释与字符串中的旧契约叙事短语
 *   4. size-exports — 行数>400 / 导出>15 / require(变量) 动态引用 / 单值默认导出
 *   5. cycles — require/import 依赖图环
 *   6. assembly — src 内 console.* / process.exit / process.env 直读
 *   7. codemap — src 代码文件必须在 CODEBASE-MAP.md 有条目
 *
 * 白名单：scripts/check-standards.whitelist.json，只减不增；
 * 条目指向已不存在的文件时静默忽略。违规时退出码 1。
 *
 * 已知局限：不解析正则字面量与模板字符串 ${} 内表达式（漏报方向，白名单兜底）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BROWSER_DOMAINS = new Set(['web', 'maintainer-web']);
// 层级（§1.1，高→低）：浏览器 → server(maintenance) → 业务域 → shared；根级为 service 门面
const LAYERS = { web: 3, 'maintainer-web': 3, maintenance: 2, catalog: 1, news: 1, comparison: 1, content: 1, pending: 0, build: 0 };
const NODE_BUILTINS = new Set(require('module').builtinModules);
const LEGACY_RE = /已随 v\d|旧版|已删除的|不再校验|@deprecated|遗留/g;
const ENV_EXEMPT_RE = /(^|\/)(env\.js|providers\/|load[^/]*Config\.js$)/;
const SHIM_EXEMPT = new Set(['src/shared/providers/index.js']);
const LINE_LIMIT = 400;
const EXPORT_LIMIT = 15;

// ── 文本工具：把注释替换为等长空白，保留字符串字面量（require 参数等真实代码） ──
// 已知局限：不解析正则字面量（含 // 的正则会截断该行后续内容，漏报方向）与模板 ${} 表达式。
function stripCommentsAndStrings(src) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const d = src[i + 1] || '';
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
      out += c; i++;
    } else if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; } else out += ' ';
      i++;
    } else {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; }
      else { out += c === '\n' ? '\n' : ' '; i++; }
    }
  }
  return out;
}

function listSourceFiles(rootDir) {
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs)$/.test(entry.name)) files.push(full);
    }
  };
  const srcDir = path.join(rootDir, 'src');
  if (fs.existsSync(srcDir)) walk(srcDir);
  return files.sort();
}

function toRel(rootDir, file) {
  return path.relative(rootDir, file).replace(/\\/g, '/');
}

function domainOf(rel) {
  const parts = rel.split('/');
  return parts.length >= 3 ? parts[1] : '(root)';
}

// 解析相对引用目标为 src 内文件；返回 null 表示目标不在 src 或不可解析
function resolveTarget(rootDir, fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(fromFile), spec);
  const candidates = [abs, `${abs}.js`, `${abs}.mjs`, path.join(abs, 'index.js'), path.join(abs, 'index.mjs')];
  for (const cand of candidates) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      const rel = toRel(rootDir, cand);
      return rel.startsWith('src/') ? rel : null;
    }
  }
  return null;
}

// ── 检测项 1：依赖方向 ──
function checkDependencyDirection(rootDir, file, rel, stripped, violations) {
  const srcDomain = domainOf(rel);
  const isBrowser = BROWSER_DOMAINS.has(srcDomain);
  const edge = (spec, lineNo) => {
    const target = resolveTarget(rootDir, file, spec);
    if (target === null) {
      const builtin = spec.replace(/^node:/, '');
      if (isBrowser && (NODE_BUILTINS.has(builtin) || !spec.startsWith('.'))) {
        violations.push({ rule: 'dependency-direction', file: rel, message: `浏览器域 import Node 模块: ${spec} (行 ${lineNo})` });
      } else if (!isBrowser && spec.startsWith('../../scripts/') || (!isBrowser && spec.split('/').includes('scripts'))) {
        if (!spec.startsWith('.')) return; // 裸包名不判定
        violations.push({ rule: 'dependency-direction', file: rel, message: `src→scripts 反向依赖: ${spec} (行 ${lineNo})` });
      }
      return;
    }
    const targetDomain = domainOf(target);
    if (srcDomain === 'news' && target === 'src/catalog/interface.js') return;
    if (targetDomain === srcDomain) return;
    if (isBrowser) {
      violations.push({ rule: 'dependency-direction', file: rel, message: `浏览器域跨域引用 ${srcDomain}→${targetDomain}: ${target}` });
    } else if (targetDomain === 'shared') {
      // →shared：依赖更稳定层，合法
      return;
    } else if (srcDomain === 'shared') {
      violations.push({ rule: 'dependency-direction', file: rel, message: `shared→其他域(${targetDomain}): ${target}` });
    } else if (srcDomain === '(root)' || targetDomain === '(root)') {
      return; // 根级文件 = service 门面（catalog-interface.js），与业务域双向合法
    } else {
      const layerOf = d => LAYERS[d] ?? 1;
      if (layerOf(srcDomain) > layerOf(targetDomain)) return; // 上层→下层（server→业务域），合法
      const kind = layerOf(srcDomain) === layerOf(targetDomain) ? '域间互引' : '向上依赖';
      violations.push({ rule: 'dependency-direction', file: rel, message: `${kind} ${srcDomain}→${targetDomain}: ${target}` });
    }
  };
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const importRe = /(?:^|\n)\s*(?:import\s[^;'"]*?from\s*|import\s*|export\s[^;'"]*?from\s*)['"]([^'"]+)['"]/g;
  for (const re of [requireRe, importRe]) {
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const lineNo = stripped.slice(0, m.index).split('\n').length;
      edge(m[1], lineNo);
    }
  }
  // 函数体内 require：缩进启发（顶层 require 顶格）
  const lines = stripped.split('\n');
  lines.forEach((line, idx) => {
    const m = line.match(/^(\s+)\S.*\brequire\(\s*['"]/);
    if (m && m[1].length > 0) {
      violations.push({ rule: 'dependency-direction', file: rel, message: `函数体内 require（应提到模块顶层）: 行 ${idx + 1}` });
    }
  });
}

// ── 检测项 2：垫片 ──
function checkShim(rel, src, stripped, violations) {
  if (SHIM_EXEMPT.has(rel)) return;
  if (/module\.exports\s*=\s*require\s*\(/.test(stripped)) {
    violations.push({ rule: 'shim', file: rel, message: 'module.exports = require(...) 纯透传垫片' });
    return;
  }
  // 整体仅 re-export：顶层 require 变量 + module.exports 每个属性值都是 <变量>.<成员>
  const topRequires = new Set();
  const reqDeclRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(/g;
  let m;
  while ((m = reqDeclRe.exec(stripped)) !== null) topRequires.add(m[1]);
  const exportBlock = stripped.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\}/);
  if (exportBlock && topRequires.size > 0) {
    const props = exportBlock[1].split(',').map(s => s.trim()).filter(Boolean);
    const isReexport = props.length > 0 && props.every(p => {
      const value = p.replace(/^[A-Za-z_$][\w$]*\s*:\s*/, '').replace(/,\s*$/, '').trim();
      return /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(value) && topRequires.has(value.split('.')[0]);
    });
    const meaningful = stripped
      .replace(/'use strict';?/, '')
      .replace(/(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\([^)]*\);?/g, '')
      .replace(/module\.exports\s*=\s*\{[\s\S]*?\n\};?/, '')
      .replace(/\s/g, '');
    if (isReexport && meaningful.length === 0) {
      violations.push({ rule: 'shim', file: rel, message: '整体仅 re-export 的垫片文件' });
    }
  }
}

// ── 检测项 4：体量与导出 ──
function countExports(stripped) {
  let count = 0;
  let m;
  const blockRe = /module\.exports\s*=\s*\{/g;
  while ((m = blockRe.exec(stripped)) !== null) {
    let depth = 1;
    let i = blockRe.lastIndex;
    while (i < stripped.length && depth > 0) {
      const c = stripped[i];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
      i++;
    }
    const body = stripped.slice(blockRe.lastIndex, i - 1);
    let d = 0;
    for (const ch of body) {
      if ('{(['.includes(ch)) d++;
      else if ('})]'.includes(ch)) d--;
      else if (ch === ',' && d === 0) count++;
    }
    if (body.trim()) count++;
    blockRe.lastIndex = i;
  }
  const assignRe = /^\s*exports\.[A-Za-z_$][\w$]*\s*=/gm;
  while ((m = assignRe.exec(stripped)) !== null) count++;
  const esNamedRe = /export\s*\{([^}]*)\}/g;
  while ((m = esNamedRe.exec(stripped)) !== null) {
    count += m[1].split(',').filter(s => s.trim()).length;
  }
  const esDeclRe = /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\b/gm;
  while ((m = esDeclRe.exec(stripped)) !== null) count++;
  const esDefaultRe = /^\s*export\s+default\b/gm;
  while ((m = esDefaultRe.exec(stripped)) !== null) count++;
  return count;
}

function checkSizeExports(rel, stripped, violations) {
  const lineCount = stripped.split('\n').length;
  if (lineCount > LINE_LIMIT) {
    violations.push({ rule: 'size-exports', file: rel, message: `行数 ${lineCount} > ${LINE_LIMIT}` });
  }
  const exports = countExports(stripped);
  if (exports > EXPORT_LIMIT) {
    violations.push({ rule: 'size-exports', file: rel, message: `导出 ${exports} 个 > ${EXPORT_LIMIT}` });
  }
  let m;
  const dynRe = /require\(\s*(?!['"`])(?!require\.main)([A-Za-z_$][\w$.]*)\s*\)/g;
  while ((m = dynRe.exec(stripped)) !== null) {
    if (m[1] === 'module' || m[1] === 'exports') continue;
    violations.push({ rule: 'size-exports', file: rel, message: `require(变量) 动态引用: ${m[1]}` });
  }
  if (/module\.exports\s*=\s*(?!{|\[|require\s*\(|Object\.)[A-Za-z_$][\w$]*\s*;?\s*(?:\n|$)/.test(stripped)
    || /module\.exports\s*=\s*(?:async\s+)?function\b/.test(stripped)) {
    if (!stripped.includes('require.main')) {
      violations.push({ rule: 'size-exports', file: rel, message: 'CommonJS 单值默认导出（应命名导出）' });
    }
  }
}

// ── 检测项 5：模块图环（SCC） ──
function buildGraph(rootDir, files) {
  const edges = new Map();
  const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const impRe = /(?:import\s[^;'"]*?from\s*|import\s*|export\s[^;'"]*?from\s*)['"]([^'"]+)['"]/g;
  for (const file of files) {
    const rel = toRel(rootDir, file);
    const stripped = stripCommentsAndStrings(fs.readFileSync(file, 'utf8'));
    const targets = new Set();
    for (const re of [reqRe, impRe]) {
      let m;
      while ((m = re.exec(stripped)) !== null) {
        const t = resolveTarget(rootDir, file, m[1]);
        if (t && t !== rel) targets.add(t);
      }
    }
    edges.set(rel, [...targets]);
  }
  return edges;
}

function findCycles(edges) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;
  const strongconnect = v => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) || []) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc = [];
      for (;;) {
        const w = stack.pop();
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      if (scc.length > 1 || (scc.length === 1 && (edges.get(scc[0]) || []).includes(scc[0]))) sccs.push(scc.sort());
    }
  };
  for (const v of [...edges.keys()].sort()) if (!index.has(v)) strongconnect(v);
  return sccs;
}

// ── 检测项 6：组装纪律 ──
function checkAssembly(rel, stripped, violations) {
  let m;
  const consoleRe = /\bconsole\.(log|error|warn|info|debug|trace)\s*\(/g;
  while ((m = consoleRe.exec(stripped)) !== null) {
    violations.push({ rule: 'assembly', file: rel, message: `console.${m[1]}（行 ${stripped.slice(0, m.index).split('\n').length}）` });
  }
  const hasMainGuard = stripped.includes('require.main');
  const exitRe = /\bprocess\.exit\s*\(/g;
  while ((m = exitRe.exec(stripped)) !== null) {
    if (hasMainGuard) continue;
    violations.push({ rule: 'assembly', file: rel, message: `process.exit（行 ${stripped.slice(0, m.index).split('\n').length}）` });
  }
  if (!ENV_EXEMPT_RE.test(rel)) {
    const envRe = /\bprocess\.env\s*[.[]/g;
    while ((m = envRe.exec(stripped)) !== null) {
      violations.push({ rule: 'assembly', file: rel, message: `process.env 直读（行 ${stripped.slice(0, m.index).split('\n').length}）` });
    }
  }
}

// ── 检测项 7：CODEBASE-MAP 完整性 ──
function checkCodemap(rootDir, files, codemapPath, violations) {
  let mapText = '';
  try {
    mapText = fs.readFileSync(codemapPath, 'utf8');
  } catch {
    violations.push({ rule: 'codemap', file: toRel(rootDir, codemapPath), message: 'CODEBASE-MAP.md 无法读取' });
    return;
  }
  for (const file of files) {
    const rel = toRel(rootDir, file);
    const mapLink = `](${rel})`;
    if (!mapText.includes(mapLink)) {
      violations.push({ rule: 'codemap', file: rel, message: '未在 CODEBASE-MAP.md 以精确路径登记' });
    }
  }
}

// ── 白名单（只减不增） ──
// 条目格式：{ file, count, note }。count = 该文件该检测项的存量违规处数（机器校验）：
// 实际违规数超过 count 即报 whitelist-growth（绕过门禁必须改白名单文件，diff 可审查）；
// 无条目或条目缺 count 时不豁免（fail-closed）。cycles 条目无 count 概念，按环节点集合豁免。
function loadWhitelist(rootDir) {
  const wlPath = path.join(rootDir, 'scripts', 'check-standards.whitelist.json');
  if (!fs.existsSync(wlPath)) return { cycles: [] };
  return JSON.parse(fs.readFileSync(wlPath, 'utf8'));
}

function applyWhitelist(rootDir, violations) {
  const wl = loadWhitelist(rootDir);
  const groups = new Map();
  for (const v of violations) {
    const key = `${v.rule}|${v.file}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  const wlEntries = new Map();
  for (const [rule, entries] of Object.entries(wl)) {
    if (!Array.isArray(entries) || rule === 'cycles') continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      wlEntries.set(`${rule}|${entry.file}`, entry);
    }
  }
  const wlCycles = new Set((wl.cycles || []).map(c => (c.cycle || []).slice().sort().join('|')));
  const filtered = [];
  for (const [key, group] of groups) {
    const sep = key.indexOf('|');
    const rule = key.slice(0, sep);
    const file = key.slice(sep + 1);
    if (rule === 'cycles') {
      if (!wlCycles.has(file)) filtered.push(...group);
      continue;
    }
    if (!fs.existsSync(path.join(rootDir, file))) continue; // 文件已删/违规已消除：静默忽略
    const entry = wlEntries.get(key);
    if (!entry || typeof entry.count !== 'number') {
      filtered.push(...group);
      continue;
    }
    if (group.length > entry.count) {
      filtered.push({
        rule: 'whitelist-growth',
        file,
        message: `${rule} 白名单记载数 ${entry.count}，实际违规 ${group.length} 处——只减不增被突破，须改代码消除而非加白名单`,
      });
    }
  }
  return filtered;
}

// ── 主入口 ──
function runChecks(options = {}) {
  const rootDir = options.rootDir || REPO_ROOT;
  const codemapPath = options.codemapPath || path.join(rootDir, 'CODEBASE-MAP.md');
  const files = listSourceFiles(rootDir);
  const edges = buildGraph(rootDir, files);
  const violations = [];
  for (const file of files) {
    const rel = toRel(rootDir, file);
    const src = fs.readFileSync(file, 'utf8');
    const stripped = stripCommentsAndStrings(src);
    checkDependencyDirection(rootDir, file, rel, stripped, violations);
    checkShim(rel, src, stripped, violations);
    let m;
    const legacyHits = new Set();
    LEGACY_RE.lastIndex = 0;
    while ((m = LEGACY_RE.exec(src)) !== null) legacyHits.add(m[0]);
    if (legacyHits.size > 0) {
      violations.push({ rule: 'legacy-narrative', file: rel, message: `旧契约叙事短语: ${[...legacyHits].join('、')}` });
    }
    checkSizeExports(rel, stripped, violations);
    checkAssembly(rel, stripped, violations);
  }
  for (const scc of findCycles(edges)) {
    violations.push({ rule: 'cycles', file: scc.join('|'), message: `循环依赖: ${scc.join(' ↔ ')}` });
  }
  checkCodemap(rootDir, files, codemapPath, violations);
  const filtered = applyWhitelist(rootDir, violations);
  const byRule = {};
  for (const v of filtered) byRule[v.rule] = (byRule[v.rule] || 0) + 1;
  return { violations: filtered, total: filtered.length, byRule, scanned: files.length };
}

function main(options = {}) {
  const result = runChecks(options);
  console.log(`check-standards: 扫描 ${result.scanned} 个 src 文件，白名单外违规 ${result.total} 处`);
  const grouped = new Map();
  for (const v of result.violations) {
    if (!grouped.has(v.rule)) grouped.set(v.rule, []);
    grouped.get(v.rule).push(v);
  }
  for (const [rule, items] of grouped) {
    console.log(`\n[${rule}] ${items.length} 处`);
    for (const v of items) console.log(`  ${v.file}: ${v.message}`);
  }
  if (result.total > 0) {
    console.error(`\ncheck-standards: 存在 ${result.total} 处白名单外违规，退出码 1`);
    return false;
  }
  return true;
}

if (require.main === module) {
  process.exit(main() ? 0 : 1);
}

module.exports = { runChecks, main, stripCommentsAndStrings, countExports };
