'use strict';

const store = require('./store');
const seed = require('./catalog-seed');
const rules = require('./rules');

module.exports = { ...store, ...seed, ...rules };
