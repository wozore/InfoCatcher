'use strict';

const envelope = require('./catalog-draft-envelope');
const store = require('./catalog-draft-store');
const assistant = require('./catalog-assistant');
const adapters = require('../intake/catalog-adapters');
const options = require('./draft-options');

module.exports = { ...envelope, ...store, ...assistant, ...adapters, ...options };
