/**
 * generate-rss.js — 零依赖 RSS 2.0 Feed 生成器
 *
 * 从 hotspots.json 取评分最高的 N 条内容，输出 standards-compliant feed.xml。
 * RSS 阅读器可通过 feed.xml 订阅 InfoCatcher AI 热点，每日自动更新。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DIRS, NEWS_FILES } = require('../shared/paths');

const FEED_PATH = path.join(DIRS.public, 'feed.xml');
const FEED_ITEM_LIMIT = 30;
const SITE_URL = 'https://wozore.github.io/InfoCatcher';

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

function generateRss() {
  let items = [];
  try {
    const hotspots = JSON.parse(fs.readFileSync(NEWS_FILES.hotspots, 'utf8'));
    items = (hotspots.items || [])
      .slice()
      .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
      .slice(0, FEED_ITEM_LIMIT);
  } catch (e) {
    console.warn('⚠️ generate-rss: 无法读取 hotspots.json，跳过 RSS 生成');
    return;
  }

  const now = rfc822(new Date().toISOString());

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n';
  xml += '  <channel>\n';
  xml += '    <title>InfoCatcher AI 热点</title>\n';
  xml += '    <link>' + esc(SITE_URL) + '</link>\n';
  xml += '    <description>AI 工具情报与行业热点，每日自动采集 + 人工精选</description>\n';
  xml += '    <language>zh-cn</language>\n';
  xml += '    <lastBuildDate>' + now + '</lastBuildDate>\n';
  xml += '    <generator>InfoCatcher RSS Engine</generator>\n';
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

  const tmp = FEED_PATH + '.tmp.' + Date.now();
  fs.writeFileSync(tmp, xml, { encoding: 'utf8', flag: 'w' });
  fs.renameSync(tmp, FEED_PATH);
  console.log('📡 RSS feed 已生成：' + FEED_PATH + '（' + items.length + ' 条）');
}

function writeJsonAtomic(filePath, data, runId) {
  // Stub — 仅用于满足模块加载；实际由 build-news.js 提供
}

if (require.main === module) {
  generateRss();
}

module.exports = { generateRss };
