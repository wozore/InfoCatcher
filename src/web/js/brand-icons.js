import { escapeHtml } from './ui-helpers.js';
import { getVendorLevel2Items } from './data-catalog.js';

const ICON_BUCKETS = ['model', 'series', 'tool', 'vendor'];
const HEX_COLOR_PATTERN = /^#[0-9a-f]{3,8}$/i;
let manifest = null;
let loadPromise = null;

function normalizeEntry(entry) {
  const path = typeof entry === 'string' ? entry : entry?.path;
  const color = typeof entry === 'object' && entry ? entry.color : null;
  if (!isSafeAssetPath(path)) return null;
  return {
    path,
    color: typeof color === 'string' && HEX_COLOR_PATTERN.test(color) ? color : null,
    coloredSrc: null, // 带指定颜色的 SVG data URI；预取后就绪
  };
}

function isSafeAssetPath(path) {
  return typeof path === 'string' && /^[a-zA-Z0-9._/-]+$/.test(path) && !path.startsWith('/') && !path.includes('..');
}

function normalizeManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = {};
  for (const bucket of ICON_BUCKETS) {
    const source = value[bucket];
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      normalized[bucket] = {};
      continue;
    }
    normalized[bucket] = Object.fromEntries(Object.entries(source)
      .map(([key, entry]) => [key, normalizeEntry(entry)])
      .filter(([, entry]) => entry));
  }
  return normalized;
}

function colorizedSvgDataUri(svgText, color) {
  // 去掉原有 fill，统一着色成指定十六进制颜色，编码为 SVG data URI。
  // 直接作为 <img> 源加载，不依赖 CSS mask 的外部 SVG（file:// 下不可靠，会造成整块染色）。
  const colored = svgText
    .replace(/\sfill="[^"]*"/g, '')
    .replace(/<path\b/g, (match) => match + ' fill="' + color + '"');
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(colored);
}

async function preloadColoredIcons(manifest) {
  const jobs = [];
  for (const bucket of ICON_BUCKETS) {
    for (const entry of Object.values(manifest[bucket] || {})) {
      if (!entry.color) continue;
      jobs.push(
        fetch('icons/' + entry.path)
          .then(response => (response.ok ? response.text() : null))
          .then(text => {
            if (text) entry.coloredSrc = colorizedSvgDataUri(text, entry.color);
          })
          .catch(() => {})
      );
    }
  }
  await Promise.all(jobs);
}

async function loadIcons() {
  if (manifest) return manifest;
  if (loadPromise) return loadPromise;
  loadPromise = fetch('icons/manifest.json')
    .then(response => {
      if (!response.ok) throw new Error(`icons/manifest.json: HTTP ${response.status}`);
      return response.json();
    })
    .then(async value => {
      manifest = normalizeManifest(value);
      await preloadColoredIcons(manifest);
      return manifest;
    })
    .catch(() => {
      manifest = null;
      return null;
    })
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

function slugOf(value) {
  const text = String(value || '');
  return text.includes(':') ? text.split(':').pop() : text;
}

function resolveSeriesKey(vendorKey, level3Id) {
  const detailId = String(level3Id || '');
  if (!detailId || !vendorKey) return null;
  const groups = getVendorLevel2Items(vendorKey) || [];
  const group = groups.find(item => (item.detail_refs || []).some(ref => ref.id === detailId));
  return group ? slugOf(group.id) : null;
}

function resolveBrandIcon({ vendorKey, toolKey, seriesKey, modelKey } = {}) {
  if (!manifest) return null;
  const candidates = [
    ['model', modelKey],
    ['series', seriesKey],
    ['tool', toolKey],
    ['vendor', vendorKey],
  ];
  for (const [bucket, key] of candidates) {
    const entry = key && manifest[bucket]?.[key];
    if (entry) return { bucket, key, path: 'icons/' + entry.path, color: entry.color, coloredSrc: entry.coloredSrc };
  }
  return null;
}

function brandIconHtml({ vendorKey, toolKey, seriesKey, modelKey, detailId, detailKind, emoji, cls = '' } = {}) {
  const resolved = resolveBrandIcon({
    vendorKey,
    toolKey: toolKey || (detailKind === 'tool' ? slugOf(detailId) : null),
    seriesKey: seriesKey || resolveSeriesKey(vendorKey, detailId),
    modelKey: modelKey || (detailKind === 'api_model' ? slugOf(detailId) : null),
  });
  if (resolved) {
    const className = ['brand-icon', cls].filter(Boolean).join(' ');
    // 优先带颜色的 data URI（颜色只落在图标形状上）；未就绪时回退原始 SVG，绝不整块染色
    const src = resolved.coloredSrc || resolved.path;
    return '<img class="' + escapeHtml(className) + '" src="' + escapeHtml(src) + '" alt="" loading="lazy">';
  }
  return emoji ? '<span class="brand-icon-emoji ' + escapeHtml(cls) + '" aria-hidden="true">' + escapeHtml(emoji) + '</span>' : '';
}

export { loadIcons, resolveSeriesKey, resolveBrandIcon, brandIconHtml };
