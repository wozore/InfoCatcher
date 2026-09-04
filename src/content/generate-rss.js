/**
 * generate-rss.js — 零依赖 RSS 2.0 Feed 生成器
 *
 * 从 hotspots.json 取最近窗口内的 N 条内容，输出 standards-compliant feed.xml。
 * RSS 阅读器可通过 feed.xml 订阅 知览 KnowView AI 热点，每日自动更新。
 *
 * B16 决策 72：RSS 与热点视图/发布出口共用同一套公开过滤规则
 * （news-public-gate.js 的 filterPublicItems：近期时间窗口 + 公开字段完整），
 * 避免出现「热点视图有这条、RSS 却没有」或相反的口径漂移。
 * 过滤逻辑集中在 news-public-gate.js，本文件只消费其结果。
 */
'use strict';

const fs = require('fs');
const { NEWS_FILES, RSS_FEED_PATH } = require('../shared/paths');
const { filterPublicItems } = require('../news/core/news-public-gate');

const FEED_ITEM_LIMIT = 30;
const SITE_URL = 'https://wozore.github.io/KnowView';

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rfc822(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return days[d.getUTCDay()] + ', ' +
    String(d.getUTCDate()).padStart(2, '0') + ' ' +
    months[d.getUTCMonth()] + ' ' +
    d.getUTCFullYear() + ' ' +
    String(d.getUTCHours()).padStart(2, '0') + ':' +
    String(d.getUTCMinutes()).padStart(2, '0') + ':' +
    String(d.getUTCSeconds()).padStart(2, '0') + ' GMT';
}

/**
 * 从公开热点投影选出 RSS 条目（B16 决策 72）。
 * 复用 news-public-gate.js 的 filterPublicItems（近期窗口 + 公开字段完整），
 * 与热点视图/发布出口使用同一规则，再按发布时间倒序取前 limit 条。
 * 纯函数，供单元测试直接验证；opts.config 为公开窗口配置（缺省回退 30 天）。
 */
function getFeedItems(hotspots, { config, now, limit = FEED_ITEM_LIMIT } = {}) {
  return filterPublicItems(hotspots?.items || [], { config, now: now || Date.now() })
    .slice()
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    .slice(0, limit);
}

function generateRss() {
  let items = [];
  try {
    const hotspots = JSON.parse(fs.readFileSync(NEWS_FILES.hotspots, 'utf8'));
    // B16 决策 63/72：RSS 与热点视图共用同一公开过滤规则（单一来源规则，
    // 规则集中在 news-public-gate.js）；读取失败时用默认 30 天窗口。
    // 配置只读 v2（news-config-v2.json，热点管线 v2 默认；v1 config 已随 v1 删除）。
    let config = null;
    try { config = JSON.parse(fs.readFileSync(NEWS_FILES.configV2, 'utf8')); } catch { config = null; }
    items = getFeedItems(hotspots, { config, now: Date.now() });
  } catch (e) {
    console.warn('⚠️ generate-rss: 无法读取 hotspots.json，跳过 RSS 生成');
    return;
  }

  const now = rfc822(new Date().toISOString());

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n';
  xml += '  <channel>\n';
  xml += '    <title>知览 KnowView AI 热点</title>\n';
  xml += '    <link>' + esc(SITE_URL) + '</link>\n';
  xml += '    <description>AI 热点、工具与模型情报，每日自动采集 + 人工精选</description>\n';
  xml += '    <language>zh-cn</language>\n';
  xml += '    <lastBuildDate>' + now + '</lastBuildDate>\n';
  xml += '    <generator>KnowView RSS Engine</generator>\n';
  xml += '    <atom:link href="' + esc(SITE_URL + '/feed.xml') + '" rel="self" type="application/rss+xml"/>\n';

  for (const item of items) {
    const title = esc(item.title || '无标题');
    const link = esc(item.url || SITE_URL);
    const desc = esc(item.description || '');
    const author = esc(item.author_name || '未知作者');
    const pubDate = rfc822(item.published_at) || now;
    const guid = esc(item.url || item.id || '');

    xml += '    <item>\n';
    xml += '      <title>' + title + '</title>\n';
    xml += '      <link>' + link + '</link>\n';
    xml += '      <description><![CDATA[' + desc + ']]></description>\n';
    xml += '      <author>' + author + '</author>\n';
    xml += '      <pubDate>' + pubDate + '</pubDate>\n';
    xml += '      <guid isPermaLink="true">' + guid + '</guid>\n';
    if (item.platform) xml += '      <category>' + esc(item.platform) + '</category>\n';
    for (const tag of (item.source_tags || []).slice(0, 3)) {
      xml += '      <category>' + esc(tag) + '</category>\n';
    }
    xml += '    </item>\n';
  }

  xml += '  </channel>\n';
  xml += '</rss>\n';

  const tmp = RSS_FEED_PATH + '.tmp.' + Date.now();
  fs.writeFileSync(tmp, xml, { encoding: 'utf8', flag: 'w' });
  fs.renameSync(tmp, RSS_FEED_PATH);
  console.log('📡 RSS feed 已生成：' + RSS_FEED_PATH + '（' + items.length + ' 条）');
}

if (require.main === module) {
  generateRss();
}

module.exports = { getFeedItems, generateRss };
