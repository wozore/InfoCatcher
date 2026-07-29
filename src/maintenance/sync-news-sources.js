/**
 * sync-news-sources.js — 热点信息源清单 Markdown → JSON 同步工具
 *
 * 在热点管线中的位置：独立维护工具，由维护者在修改热点信息源清单后手动运行。
 * 不是构建时步骤——news-sources.json 是人工审阅后的持久配置，
 * 只有维护者确认来源变更后才执行本脚本重新生成。
 *
 * 输入：../../热点信息源清单.md（工程仓库根目录）
 * 输出：data/news/sources/news-sources.json（MVP 仓库的标准化来源配置）
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要这个脚本：
 * ═══════════════════════════════════════════════════════════════
 *   热点信息源清单是人工维护的 Markdown 表格，方便阅读和编辑，
 *   但 build-news.js 需要严格的 JSON 格式。本脚本负责：
 *     1. 将 Markdown 表格解析为结构化 JSON
 *     2. 自动映射内容类型标签（TYPE_TAGS）
 *     3. 自动分配可靠性先验分（reliabilityPrior）
 *     4. 自动标记缺失 ID/标签/重复的来源并禁用
 *   这样维护者只需编辑易读的 Markdown，不需手工维护 2771 行 JSON。
 *
 * ═══════════════════════════════════════════════════════════════
 * 运行方式：
 * ═══════════════════════════════════════════════════════════════
 *   node scripts/sync-news-sources.js                    # 使用默认输入
 *   node scripts/sync-news-sources.js ../../other.md     # 指定输入文件
 *
 * ═══════════════════════════════════════════════════════════════
 * 注意事项：
 * ═══════════════════════════════════════════════════════════════
 *   - X 平台表格的列顺序与 YouTube/Bilibili 不同（ID 在 URL 前面），
 *     脚本已在 parseMarkdown() 中按平台区分解析。
 *   - 缺失 external_id 或 content_tags 的来源会自动 disabled，
 *     并在 review_notes 中记录原因，不会进入真实采集。
 *   - 同平台重复的来源也会自动禁用，需人工核对后处理。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DIRS, NEWS_FILES, SOURCE_LIST_PATH } = require('../shared/paths');

const DEFAULT_INPUT = SOURCE_LIST_PATH;
const OUTPUT = NEWS_FILES.sources;

/** Markdown 二级标题到平台标识的映射 */
const PLATFORM_MAP = {
  YouTube: 'youtube',
  Bilibili: 'bilibili',
  X: 'x',
};

/**
 * 内容类型标签映射表。
 * 从左边的分类关键词自动推导右边的标准化标签。
 * 支持一对多映射：多个原始分类可以映射到同一个标签（如 "AI 新闻" 和 "行业分析" 都→"即时资讯"）。
 * 新增来源分类时在此追加条目即可。
 */
const TYPE_TAGS = [
  ['横向测评', '横向测评'],
  ['AI 新闻', '即时资讯'],
  ['行业分析', '即时资讯'],
  ['即时资讯', '即时资讯'],
  ['深度技术解读', '深度解读'],
  ['深度解读', '深度解读'],
  ['技术科普', '深度解读'],
  ['教程实践', '教程实践'],
  ['工作流', '教程实践'],
  ['行业观点', '行业观点'],
  ['泛科技观察', '行业观点'],
  ['官方公司', '官方来源'],
  ['实验室', '官方来源'],
  ['研究者', '深度解读'],
  ['核心开发者', '深度解读'],
  ['工具 / 开源项目', '教程实践'],
];

/** 去除文本中的反引号和 @ 前缀（Markdown 表格中常见的格式化标记） */
function stripCode(value) {
  return value.trim().replace(/^`|`$/g, '').replace(/^@/, '');
}

/** 生成 URL 安全的小写标识符，用于构造来源 id */
function slug(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-|-$/g, '') || 'source';
}

/**
 * 从原始类型文本中提取标准化内容标签。
 * 在原始分类(primary)和附加标签(extra)的拼接文本中按 TYPE_TAGS 表匹配。
 */
function tagsFrom(primary, extra) {
  const tags = [];
  const text = `${primary} ${extra}`;
  for (const [needle, tag] of TYPE_TAGS) {
    if (text.includes(needle) && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/**
 * 根据主要类型自动分配来源可靠性先验分。
 * 官方来源(公司/实验室) → 80、研究者/核心开发者 → 70、其余 → 50。
 * 这个分数是保守估计，后续可通过 news-cli.js 手工调整。
 */
function reliabilityPrior(primary) {
  if (primary.includes('官方公司') || primary.includes('实验室')) return 80;
  if (primary.includes('研究者') || primary.includes('核心开发者')) return 70;
  return 50;
}

/**
 * 解析 Markdown 表格为来源对象数组。
 *
 * 表格结构（三个平台分三个二级标题）：
 *   ## YouTube / ## Bilibili
 *     | 名称 | 主页URL | 平台ID | 类型 | 附加标签 | 语言 | 近期活跃 | 备注 |
 *   ## X
 *     | 名称 | 用户名 | 主页URL | 类型 | 附加标签 | 语言 | 近期活跃 | 备注 |
 *
 * X 的列顺序不同（ID 在 URL 前面），脚本已区分处理。
 */
function parseMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const records = [];
  let section = null;

  for (const line of lines) {
    // 识别二级标题，确定当前正在解析哪个平台
    const heading = line.match(/^##\s+(YouTube|Bilibili|X)\s*$/);
    if (heading) {
      section = heading[1];
      continue;
    }
    // 跳过非表格行
    if (!section || !line.trim().startsWith('|')) continue;

    // 解析表格行：去掉首尾的 |，按 | 分割后 trim 每个单元格
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    // 跳过表头和分隔行
    if (!cells.length || cells[0] === '名称' || /^-+$/.test(cells[0])) continue;

    const platform = PLATFORM_MAP[section];
    let name, profileUrl, externalId, primaryType, extraTags, language, active, notes;

    // X 平台的列顺序与其他平台不同：名称 | 用户名 | 主页URL | ...
    if (section === 'X') {
      [name, externalId, profileUrl, primaryType, extraTags, language, active, notes] = cells;
    } else {
      [name, profileUrl, externalId, primaryType, extraTags, language, active, notes] = cells;
    }

    externalId = stripCode(externalId || '');
    const contentTags = tagsFrom(primaryType || '', extraTags || '');
    const idBase = externalId || slug(name);

    records.push({
      id: `${platform}-${slug(idBase)}`,
      platform,
      external_id: externalId || null,
      handle: platform === 'x' ? externalId : null,
      name,
      profile_url: profileUrl,
      language: language === '中文' ? 'zh' : language === '英文' ? 'en' : 'unknown',
      primary_type: primaryType || null,
      content_tags: contentTags,
      original_tags: (extraTags || '').split(/[、,，]/).map(v => v.trim()).filter(Boolean),
      cadence_class: 'unknown',           // 后续由维护者通过 CLI 或手工标注
      enabled: Boolean(externalId && profileUrl), // 缺 ID 或 URL 默认禁用
      collector: platform === 'youtube' ? 'youtube_rss' : platform === 'x' ? 'twitterapi_io' : 'rsshub_bilibili',
      reliability_prior: reliabilityPrior(primaryType || ''),
      quality_prior: 50,
      active_60d: active === '是' ? true : active === '否' ? false : null,
      evidence_url: profileUrl,
      checked_at: '2026-07-23',
      notes: notes || '',
      needs_review: !externalId || !profileUrl || contentTags.length === 0,
      review_notes: [],
    });
  }

  // ── 第二遍扫描：自动标记问题来源 ────────────────────────
  // 这些问题来源不会被删除，但会被 disabled 并标记 needs_review
  const seenIds = new Map();
  for (const source of records) {
    const key = `${source.platform}:${source.external_id || source.profile_url}`;
    if (seenIds.has(key)) {
      // 同平台重复：可能是维护者误添加
      source.enabled = false;
      source.needs_review = true;
      source.review_notes.push(`与 ${seenIds.get(key)} 的平台标识重复，核对前禁用`);
    } else {
      seenIds.set(key, source.id);
    }
    if (!source.content_tags.length) {
      // 缺少标签：采集脚本无法确定其内容类型
      source.review_notes.push('缺少可映射的内容类型标签');
      source.enabled = false;
    }
    if (!source.external_id) {
      // 缺少平台 ID：采集脚本无法定位该来源
      source.review_notes.push('缺少平台 ID/Handle');
      source.enabled = false;
    }
  }

  return records;
}

/**
 * 主入口：读取 Markdown → 解析 → 写入 JSON → 输出统计。
 * 可选参数：第一个命令行参数可指定输入文件路径。
 */
function main() {
  const input = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_INPUT;
  if (!fs.existsSync(input)) {
    throw new Error(`来源清单不存在：${input}`);
  }
  const sources = parseMarkdown(fs.readFileSync(input, 'utf8'));
  const payload = {
    schema_version: 1,
    generated_from: path.basename(input),
    generated_at: new Date().toISOString(),
    sources,
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const counts = sources.reduce((acc, source) => {
    acc[source.platform] = (acc[source.platform] || 0) + 1;
    return acc;
  }, {});
  const review = sources.filter(source => source.needs_review).length;
  console.log(`已生成 ${path.relative(DIRS.project, OUTPUT)}：${JSON.stringify(counts)}，待核对 ${review} 条`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}

module.exports = { parseMarkdown, tagsFrom, main };
