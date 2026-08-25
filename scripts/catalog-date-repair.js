'use strict';

const fs = require('fs');
const {
  planDateRepair,
  applyDateRepair,
} = require('../src/catalog/catalog-date-repair');
const { loadCatalogSnapshot } = require('../src/catalog/catalog-transaction-store');
const { parseArgs } = require('./catalog-generator');

function readRepair(file) {
  if (!file) throw new Error('请提供 --repair <date-repair.json>');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function publicPreview(plan) {
  return {
    ok: plan.ok,
    ...(plan.ok ? {
      detail_id: plan.detail_id,
      target_field: plan.target_field,
      date: plan.date,
      source: plan.source,
      before_revision: plan.before_revision,
      target_revision: plan.target_revision,
      preview: plan.preview,
      preview_hash: plan.preview_hash,
    } : { code: plan.code, error: plan.error, ...(plan.errors ? { errors: plan.errors } : {}) }),
  };
}

function ask(question) {
  process.stdout.write(question);
  return new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', value => resolve(String(value).trim()));
  });
}

async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const [command] = positional;
  const repair = readRepair(flags.repair);
  const current = loadCatalogSnapshot();
  const planned = planDateRepair(current.snapshot, repair);
  console.log(JSON.stringify(publicPreview(planned), null, 2));
  if (command === 'plan') return planned;
  if (command !== 'apply') throw new Error('用法: catalog-date-repair plan|apply --repair <date-repair.json>');
  if (!planned.ok) return planned;
  if (!flags.expected_revision || !flags.preview_hash) {
    return { ok: false, code: 'DATE_REPAIR_REVIEW_REQUIRED', error: 'Apply 必须回传 plan 输出的 --expected-revision 与 --preview-hash' };
  }
  const confirmation = flags.confirm || await ask(`输入 APPLY ${planned.detail_id} 以确认日期修补：`);
  if (confirmation !== `APPLY ${planned.detail_id}`) return { ok: false, code: 'DATE_REPAIR_APPLY_CONFIRMATION_REQUIRED' };
  const result = applyDateRepair(repair, {
    expectedRevision: flags.expected_revision,
    previewHash: flags.preview_hash,
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  main().then(result => { if (result?.ok === false) process.exitCode = 1; }).catch(error => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { readRepair, publicPreview, main };
