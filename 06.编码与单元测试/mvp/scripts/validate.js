/**
 * InfoCatcher MVP 数据校验
 *
 * 在 CI(Continuous Integration) 中自动运行，检查 tools.json / glossary.json 的格式和完整性。
 * 任何检查不通过时返回非零退出码，阻止部署。
 *
 * 用法：node scripts/validate.js
 * 无输出 = 全部通过；报错信息会写明哪个文件、哪个字段、什么值有问题。
 */

const fs = require('fs');
const path = require('path');

const MVP_DIR = path.resolve(__dirname, '..');
let failed = false;

function fail(msg) {
  console.error('❌', msg);
  failed = true;
}

// 批量检查必填字段
function checkRequired(obj, path, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null) {
      fail(`${path}.${f} 缺失`);
    }
  }
}

// ===== 1. tools.json 校验 =====
const TOOL_REQUIRED = [
  'id', 'name', 'vendor', 'category', 'scenes', 'url', 'icon',
  'free_tier', 'paid_tiers',
  'rating_overall', 'rating_chinese', 'rating_ease', 'rating_price',
  'access_level', 'access_barrier',
  'strengths', 'weaknesses', 'best_for', 'not_for',
  'last_updated', 'source'
];

function validateTools(data) {
  const ids = new Map();

  for (let i = 0; i < data.length; i++) {
    const t = data[i];
    const tag = `tools.json[${i}] (${t.name || '未知'})`;

    checkRequired(t, tag, TOOL_REQUIRED);

    // ID 唯一
    if (t.id) {
      if (ids.has(t.id)) fail(`重复的工具 ID: "${t.id}"（第 ${i + 1} 条与第 ${ids.get(t.id) + 1} 条重复）`);
      ids.set(t.id, i);
    }

    // ID 格式
    if (t.id && !/^[a-z0-9][a-z0-9_-]*$/.test(t.id))
      fail(`${tag}.id "${t.id}" 格式有误（仅限小写字母、数字、连字符、下划线）`);

    // 评分范围 1-5
    ['rating_overall', 'rating_chinese', 'rating_ease', 'rating_price'].forEach(k => {
      if (typeof t[k] === 'number' && (t[k] < 1 || t[k] > 5))
        fail(`${tag}.${k} = ${t[k]}，超出 1-5 范围`);
    });

    // category / scenes / best_for / not_for 必须为数组
    ['category', 'scenes', 'best_for', 'not_for'].forEach(k => {
      if (t[k] !== undefined && !Array.isArray(t[k]))
        fail(`${tag}.${k} 应为数组`);
    });

    // paid_tiers 必须为数组
    if (t.paid_tiers !== undefined && !Array.isArray(t.paid_tiers))
      fail(`${tag}.paid_tiers 应为数组`);

    // access_level 取值
    if (t.access_level && !['开放', '受限'].includes(t.access_level))
      fail(`${tag}.access_level = "${t.access_level}"，应为"开放"或"受限"`);

    // 日期格式 YYYY-MM-DD
    if (t.last_updated && !/^\d{4}-\d{2}-\d{2}$/.test(t.last_updated))
      fail(`${tag}.last_updated = "${t.last_updated}"，格式应为 YYYY-MM-DD`);
  }

  console.log(`  tools.json: ${data.length} 个工具，全部通过`);
}

// ===== 2. glossary.json 校验 =====
const GLOSSARY_REQUIRED = ['term', 'category', 'summary', 'source'];

function validateGlossary(data) {
  const terms = new Set();

  for (let i = 0; i < data.length; i++) {
    const g = data[i];
    const tag = `glossary.json[${i}] (${g.term || '未知'})`;

    checkRequired(g, tag, GLOSSARY_REQUIRED);

    // 术语唯一
    if (g.term) {
      if (terms.has(g.term.toLowerCase())) fail(`${tag} 重复的术语名称`);
      terms.add(g.term.toLowerCase());
    }

    // 分类不能为空
    if (g.category && typeof g.category === 'string' && g.category.trim() === '')
      fail(`${tag}.category 为空`);

    // source 格式
    if (g.source && typeof g.source === 'object') {
      if (!g.source.name) fail(`${tag}.source.name 缺失`);
    }
  }

  console.log(`  glossary.json: ${data.length} 条术语，全部通过`);
}

// ===== 3. index.html 完整性检查 =====
function validateHtml(html) {
  // 检查关键 ID 是否存在（至少检查视图容器）
  const expected = [
    'view-tools', 'view-scenes', 'view-compare', 'view-glossary', 'view-about',
    'searchInput', 'toolGrid', 'sceneGrid', 'modalOverlay'
  ];
  for (const id of expected) {
    const regex = new RegExp(`id=["']${id}["']`);
    if (!regex.test(html)) fail(`index.html 缺少 id="${id}"`);
  }

  // 检查 EXTENSION POINT 注释是否还存在（意外删除会警告）
  const epCount = (html.match(/EXTENSION POINT/g) || []).length;
  if (epCount < 3) fail(`index.html 中 EXTENSION POINT 注释不足 ${epCount} 处（预期至少 3 处）`);

  // 检查 Nav 按钮数量
  const navBtns = (html.match(/class="nav-btn"/g) || []).length;
  if (navBtns < 4) fail(`index.html 导航按钮不足 ${navBtns} 个（预期至少 4 个）`);

  console.log(`  index.html: ${epCount} 处扩展点 · ${navBtns} 个导航按钮，通过`);
}

// ===== 入口 =====
console.log('\n📋 InfoCatcher MVP 数据校验\n');

// tools.json
try {
  const raw = fs.readFileSync(path.join(MVP_DIR, 'data/tools.json'), 'utf8');
  const tools = JSON.parse(raw);
  if (!Array.isArray(tools)) fail('tools.json 应为数组');
  else if (tools.length < 20) fail(`tools.json 仅有 ${tools.length} 个工具，预期至少 20 个`);
  else validateTools(tools);
} catch (e) {
  fail(`tools.json 解析失败：${e.message}`);
}

// glossary.json
try {
  const raw = fs.readFileSync(path.join(MVP_DIR, 'data/glossary.json'), 'utf8');
  const glossary = JSON.parse(raw);
  if (!Array.isArray(glossary)) fail('glossary.json 应为数组');
  else if (glossary.length < 10) fail(`glossary.json 仅有 ${glossary.length} 条术语，预期至少 10 条`);
  else validateGlossary(glossary);
} catch (e) {
  fail(`glossary.json 解析失败：${e.message}`);
}

// index.html
try {
  const html = fs.readFileSync(path.join(MVP_DIR, 'index.html'), 'utf8');
  if (html.length < 1000) fail(`index.html 内容过短（${html.length} 字符）`);
  else validateHtml(html);
} catch (e) {
  fail(`index.html 读取失败：${e.message}`);
}

console.log(failed ? '\n❌ 校验未通过，请修复上述错误后重试\n' : '\n✅ 全部通过\n');
process.exit(failed ? 1 : 0);
