'use strict';

const implementation = require('../src/news/cli/news-cli');

if (require.main === module) {
  try { implementation.main(); }
  catch (error) { console.error(`❌ ${error.message}`); process.exitCode = 1; }
}

module.exports = implementation;
