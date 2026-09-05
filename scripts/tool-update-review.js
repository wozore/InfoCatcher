'use strict';

const { loadDotEnv } = require('../src/shared/env');
loadDotEnv();

// 依赖方向注记：catalog 域模块不得直接 require news 域汉化器。
// 本壳是 service-facade：在此绑定 news 域 localizeCandidate，经 deps 注入下沉实现。
const { localizeCandidate } = require('../src/news/classify/content-localizer');
const reviewLocalize = require('../src/catalog/tool-update/review-localize');
const reviewScan = require('../src/catalog/tool-update/review-scan');
const reviewCommands = require('../src/catalog/tool-update/review-commands');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2).replace(/-/g, '_');
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; index += 1; }
  }
  return { positional, flags };
}

/** 交互确认属人类 I/O，留在壳内并经 deps 注入下沉命令。 */
async function ask(question) {
  process.stdout.write(question);
  return new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', value => resolve(String(value).trim()));
  });
}

/**
 * 默认通知出口：local-model 只发送不含路径/凭据的状态事件；CLI 将其写到 stderr，
 * 不污染既有 stdout JSON 输出。测试与上层组合根可通过 deps.notify 注入替代处理器。
 */
function notifyLocalModel(event) {
  process.stderr.write(`[local-model] ${event.status}${event.code ? ` (${event.code})` : ''}\n`);
}

function boundLocalizeToolCandidate(deps = {}) {
  return deps.localizeToolCandidate
    || ((candidate, options) => reviewLocalize.localizeToolCandidate(candidate, options, { localizeCandidate }));
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const { positional, flags } = parseArgs(argv);
  const [command] = positional;
  const io = {
    ...deps,
    ask: deps.ask || ask,
    notify: deps.notify || notifyLocalModel,
    localizeToolCandidate: boundLocalizeToolCandidate(deps),
  };
  let result;
  if (command === 'preflight') result = await reviewScan.runPreflight(flags, io);
  else if (command === 'scan') result = await reviewScan.runScan(flags, io);
  else if (command === 'localize') result = await reviewCommands.runLocalize(flags, io);
  else if (command === 'list') result = reviewCommands.runList(flags, io);
  else if (command === 'preview') result = reviewCommands.runPreview(flags, io);
  else if (command === 'apply') result = await reviewCommands.runApply(flags, io);
  else throw new Error('用法: tool-update-review preflight|scan|localize|list|preview|apply [--products a,b] [--tavily-access-mode keyed|keyless] [--provider local|zhipu|deepseek]');
  if (deps.print !== false) console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  main().then(result => { if (result?.ok === false) process.exitCode = 1; }).catch(error => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  PRODUCT_KEYS: reviewScan.PRODUCT_KEYS,
  parseArgs,
  accessModeOf: reviewScan.accessModeOf,
  modeOf: reviewScan.modeOf,
  runPreflight: reviewScan.runPreflight,
  runScan: reviewScan.runScan,
  runLocalize: reviewCommands.runLocalize,
  summarizeToolEvidenceExternally: reviewLocalize.summarizeToolEvidenceExternally,
  localizeToolCandidate: (candidate, options, deps = {}) => reviewLocalize.localizeToolCandidate(candidate, options, { localizeCandidate, ...deps }),
  runList: reviewCommands.runList,
  runPreview: reviewCommands.runPreview,
  runApply: reviewCommands.runApply,
  main,
};
