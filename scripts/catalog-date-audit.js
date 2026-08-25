'use strict';

const { runCatalogDateAudit } = require('../src/maintenance/catalog-date-audit');

function parseArgs(argv = process.argv.slice(2)) {
  return { dryRun: argv.includes('--dry-run') };
}

function main(argv = process.argv.slice(2)) {
  const { dryRun } = parseArgs(argv);
  const result = runCatalogDateAudit({ dryRun });
  const { summary } = result.report;
  console.log(`日期审计: ${summary.total} 条三级详情`);
  for (const [category, count] of Object.entries(summary.by_category)) console.log(`  ${category}: ${count}`);
  if (result.outputPath) console.log(`清单已写入: ${result.outputPath}`);
  else console.log('dry-run：未写入审计清单');
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`日期审计失败: ${error.message}`);
    if (error.details) for (const detail of error.details) console.error(`  ${detail.path}: ${detail.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, main };
