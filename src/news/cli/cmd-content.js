/**
 * cmd-content.js —— classify / localize preview 命令组
 *
 *   classify preview   --title <t> [--description <d>]    预览单条分类（不写入）
 *   localize preview   --title <t> [--description <d>] [--locale zh]   预览单条翻译（不写入）
 *
 * 仅保留 preview：零依赖、纯函数预览，供维护者调试单条输入的分类/翻译效果；
 * 批量分类/总结/本地化由 v2 管线 pipeline-min 在采集链路内自动完成。
 * 完整 CLI 帮助见 news-cli.js 顶部。
 */

'use strict';

const {
  classifyCandidate,
} = require('../classify/content-classifier');
const { localizeCandidate } = require('../classify/content-localizer');

async function classifyCommand(action, flags, deps = {}) {
  if (action === 'preview') {
    const title = flags.title || '';
    const description = flags.description || '';
    if (!title && !description) throw new Error('classify preview 需要 --title 或 --description');
    return classifyCandidate({ title, description }, {
      provider: flags.provider,
      model: flags.model,
      listToolCards: deps.catalogApi && deps.catalogApi.listToolCards,
    });
  }
  throw new Error(`未知 classify 命令: ${action}`);
}

async function localizeCommand(action, flags) {
  if (action === 'preview') {
    const title = flags.title || '';
    const description = flags.description || '';
    if (!title && !description) throw new Error('localize preview 需要 --title 或 --description');
    return localizeCandidate({ title, description }, {
      locale: flags.locale || 'zh',
      model: flags.model,
      provider: flags.provider,
      external: flags.external === true || flags.external === 'true',
    });
  }
  throw new Error(`未知 localize 命令: ${action}`);
}

module.exports = {
  classifyCommand, localizeCommand,
};
