'use strict';

const implementation = require('../src/maintenance/sync-news-sources');

if (require.main === module) {
  try {
    implementation.main();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}

module.exports = implementation;
