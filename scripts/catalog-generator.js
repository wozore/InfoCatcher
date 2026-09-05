'use strict';

const { loadDotEnv } = require('../src/shared/env');
loadDotEnv();

const commands = require('../src/catalog/catalog-generator-commands');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2).replace(/-/g, '_');
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; index += 1; }
  }
  return { positional, flags };
}

/** 交互确认属人类 I/O，留在壳内并经 io 注入下沉命令。 */
async function ask(question) {
  process.stdout.write(question);
  return new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', value => resolve(String(value).trim()));
  });
}

async function main(argv = process.argv.slice(2)) {
  return commands.runCommand(parseArgs(argv), {
    ask,
    print: value => console.log(JSON.stringify(value, null, 2)),
    printError: value => console.error(JSON.stringify(value, null, 2)),
  });
}

if (require.main === module) {
  main().then(result => { if (result?.ok === false) process.exitCode = 1; }).catch(error => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  main,
  readSeed: commands.readSeed,
  tavilyAccessModeFromFlags: commands.tavilyAccessModeFromFlags,
  generatorOptionsFromFlags: commands.generatorOptionsFromFlags,
};
