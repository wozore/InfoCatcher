'use strict';

const fs = require('fs');
const path = require('path');

const MVP_DIR = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.resolve(MVP_DIR, '..', '..', '热点信息源清单.md');
const OUTPUT = path.join(MVP_DIR, 'data', 'news-sources.json');

const PLATFORM_MAP = {
  YouTube: 'youtube',
  Bilibili: 'bilibili',
  X: 'x',
};

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

function stripCode(value) {
  return value.trim().replace(/^`|`$/g, '').replace(/^@/, '');
}

function slug(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-|-$/g, '') || 'source';
}

function tagsFrom(primary, extra) {
  const tags = [];
  const text = `${primary} ${extra}`;
  for (const [needle, tag] of TYPE_TAGS) {
    if (text.includes(needle) && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function reliabilityPrior(primary) {
  if (primary.includes('官方公司') || primary.includes('实验室')) return 80;
  if (primary.includes('研究者') || primary.includes('核心开发者')) return 70;
  return 50;
}

function parseMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const records = [];
  let section = null;

  for (const line of lines) {
    const heading = line.match(/^##\s+(YouTube|Bilibili|X)\s*$/);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (!section || !line.trim().startsWith('|')) continue;

    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (!cells.length || cells[0] === '名称' || /^-+$/.test(cells[0])) continue;

    const platform = PLATFORM_MAP[section];
    let name;
    let profileUrl;
    let externalId;
    let primaryType;
    let extraTags;
    let language;
    let active;
    let notes;

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
      cadence_class: 'unknown',
      enabled: Boolean(externalId && profileUrl),
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

  const seenIds = new Map();
  for (const source of records) {
    const key = `${source.platform}:${source.external_id || source.profile_url}`;
    if (seenIds.has(key)) {
      source.enabled = false;
      source.needs_review = true;
      source.review_notes.push(`与 ${seenIds.get(key)} 的平台标识重复，核对前禁用`);
    } else {
      seenIds.set(key, source.id);
    }
    if (!source.content_tags.length) {
      source.review_notes.push('缺少可映射的内容类型标签');
      source.enabled = false;
    }
    if (!source.external_id) {
      source.review_notes.push('缺少平台 ID/Handle');
      source.enabled = false;
    }
  }

  return records;
}

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
  console.log(`已生成 ${path.relative(MVP_DIR, OUTPUT)}：${JSON.stringify(counts)}，待核对 ${review} 条`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}

module.exports = { parseMarkdown, tagsFrom };
