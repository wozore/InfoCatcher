/**
 * i18n.js —— 前端 i18n 框架核心（原生 ES module，无打包器）
 *
 * 两层 i18n 分离：
 *   1. UI 文案层：t(key, params) 从当前语言字典取界面文案（按钮/标签/状态消息）；
 *      字典按语言建文件（src/web/i18n/<lang>.js，当前仅 zh）。
 *   2. 内容数据层：getLocalizedField(item, field) 读取 item.localizations[lang][field]
 *      （数据侧 AI 翻译产生，非前端运行时翻译），原文兜底。
 *
 * 试点接入（热点视图）：
 *   - trending.js 渲染文案 → t()；热点内容字段 → getLocalizedField()；
 *   - index.html trending 部分静态文案 → data-i18n 属性 + applyStaticTranslations()；
 *   - data.js 共享工具（timeAgo/formatMetric/标签常量）→ t()。
 *   其余视图文案后续按同框架接入（加语言文件即多语言）。
 *
 * 容错语义：t() 缺 key 回退 zh → 原 key（UI 不空，未接入的文案原样显示）；
 * getLocalizedField 缺本地化字段回退 null（调用方回退原文）。
 */

import { messages as zhMessages } from '../i18n/zh.js';

const DICTIONARIES = { zh: zhMessages };
const SUPPORTED_LANGS = ['zh'];
const DEFAULT_LANG = 'zh';

let currentLang = DEFAULT_LANG;

/** 按点路径取字典值（如 'trending.status.loadFailed'）。 */
function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * UI 文案翻译。缺 key 回退：当前语言 → zh → 原 key（保证 UI 不空）。
 * 支持 {placeholder} 插值：t('timeAgo.minutes', { n: 5 }) → '5 分钟前'。
 * @param {string} key - 点路径 key（如 'trending.card.viewSource'）
 * @param {object} [params] - 插值参数 { name: value }
 * @returns {string}
 */
export function t(key, params) {
  let template = getPath(DICTIONARIES[currentLang], key);
  if (template == null && currentLang !== DEFAULT_LANG) template = getPath(DICTIONARIES[DEFAULT_LANG], key);
  if (template == null) return key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      template = String(template).replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
    }
  }
  return String(template);
}

/** 切换当前语言（未来多语言入口；当前仅 zh）。 */
export function setLang(lang) {
  if (SUPPORTED_LANGS.includes(lang)) currentLang = lang;
}

/** 获取当前语言代码。 */
export function getCurrentLang() {
  return currentLang;
}

/**
 * 内容数据本地化读取：item.localizations[lang][field]，字符串非空才返回，否则 null。
 * 调用方用 `getLocalizedField(item, field) || item[field]` 原文兜底。
 * @param {object} item - 内容条目（含可选 localizations）
 * @param {string} field - 'title' | 'description' ...
 * @param {string} [lang] - 缺省当前语言
 * @returns {string|null}
 */
export function getLocalizedField(item, field, lang = currentLang) {
  const value = item?.localizations?.[lang]?.[field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 替换静态 HTML 文案：扫描 [data-i18n="key"] 替换 textContent，
 * [data-i18n-aria="key"] 替换 aria-label。页面加载早期调用一次；
 * 未来语言切换时重新调用（各视图渲染用 t()，会自动跟随）。
 * @param {Document|Element} [root]
 */
export function applyStaticTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
}

export { SUPPORTED_LANGS, DEFAULT_LANG };
