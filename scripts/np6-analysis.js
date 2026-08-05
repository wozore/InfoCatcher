// N-P6 去重键语义分析（只读，不改数据）
'use strict';
const path = require('path');
const DATA = p => require(path.join(__dirname, '..', 'data', 'news', 'runtime', p));

const candidates = DATA('hotspot-candidates.json').candidates;
const registry = DATA('news-registry.json');

// 与 build-news.js normalizeUrl 完全一致（保留查询参数，仅去 utm/feature/si/spm_id_from 与 hash）
function normUrl(raw) {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_') || ['feature', 'si', 'spm_id_from'].includes(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch { return ''; }
}
function normTitle(t) { return (t || '').trim().toLowerCase().replace(/\s+/g, ' '); }

console.log('===== 候选层（' + candidates.length + ' 条）去重键命中对比 =====');
const stats = { native: 0, url: 0, urlTitle: 0, crossPlatformUrl: 0, urlNativeMismatch: 0 };
const seenNative = new Map(), seenUrl = new Map(), seenUrlTitle = new Map();
for (const it of candidates) {
  const nk = it.platform + ':' + it.native_id;
  const uk = it.platform + ':' + normUrl(it.url);
  const utk = uk + '|' + normTitle(it.title);
  if (seenNative.has(nk)) stats.native++;
  if (seenUrl.has(uk)) {
    stats.url++;
    if (seenUrl.get(uk) !== it.platform) stats.crossPlatformUrl++;
    if (!seenNative.has(nk)) stats.urlNativeMismatch++;
  }
  if (seenUrlTitle.has(utk)) stats.urlTitle++;
  seenNative.set(nk, it.platform);
  seenUrl.set(uk, it.platform);
  seenUrlTitle.set(utk, it.platform);
}
console.log('native_id 去重会去掉    :', stats.native, '条');
console.log('URL 去重会去掉          :', stats.url, '条 (其中跨平台', stats.crossPlatformUrl, ')');
console.log('url+title 去重会去掉    :', stats.urlTitle, '条');
console.log('URL 重复但 native 不同  :', stats.urlNativeMismatch, '条 <- 当前实现会漏');

console.log('\n--- URL 重复明细（候选层）---');
const byUrl = new Map();
for (const it of candidates) {
  const u = normUrl(it.url);
  if (!u) continue;
  if (!byUrl.has(u)) byUrl.set(u, []);
  byUrl.get(u).push(it);
}
let anyDup = false;
for (const [u, items] of byUrl) {
  if (items.length > 1) {
    anyDup = true;
    console.log('URL=' + u);
    for (const it of items) console.log('   ' + it.platform + ':' + it.native_id + ' | ' + it.title.slice(0, 40));
  }
}
if (!anyDup) console.log('(候选层无 URL 重复)');

const REG_N = Object.keys(registry.videos).length;
console.log('\n===== registry（' + REG_N + ' 条）URL 冲突检测 =====');
const byUrlR = new Map();
const nativeSet = new Set();
let noUrl = 0, sameUrlDiffNative = 0, noNative = 0;
for (const rec of Object.values(registry.videos)) {
  nativeSet.add(rec.platform + ':' + rec.native_id);
  if (!rec.native_id) noNative++;
  const raw = rec.canonical_url || rec.url;
  if (!raw) { noUrl++; continue; }
  const u = normUrl(raw);
  if (!u) { noUrl++; continue; }
  const k = rec.platform + ':' + u;
  if (byUrlR.has(k)) {
    const prev = byUrlR.get(k);
    if (prev.native_id !== rec.native_id) sameUrlDiffNative++;
    prev.sameUrlCount = (prev.sameUrlCount || 1) + 1;
  } else byUrlR.set(k, { native_id: rec.native_id, sameUrlCount: 1 });
}
console.log('无 canonical_url 记录     :', noUrl);
console.log('无 native_id 记录         :', noNative);
const urlCollisions = [...byUrlR.values()].reduce((n, v) => n + (v.sameUrlCount - 1), 0);
console.log('platform+URL 冲突条数     :', urlCollisions);
console.log('URL 相同 native 不同      :', sameUrlDiffNative, '<- URL fallback 键语义关键');
console.log('全部记录 key 唯一性       :', nativeSet.size === REG_N ? 'OK' : '冲突!');
const multiGroups = [...byUrlR.values()].filter(v => v.sameUrlCount > 1).length;
console.log('多记录共享 URL 的分组数   :', multiGroups);
if (multiGroups > 0) {
  console.log('--- URL 冲突分组明细（前 10 组）---');
  let shown = 0;
  for (const [u, v] of byUrlR) {
    if (v.sameUrlCount > 1 && shown < 10) {
      shown++;
      console.log('URL=' + u + ' (n=' + v.sameUrlCount + ')');
    }
  }
}
