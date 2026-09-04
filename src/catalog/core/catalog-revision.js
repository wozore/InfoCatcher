'use strict';

const crypto = require('crypto');
const { AREAS } = require('./catalog-contract');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return `${JSON.stringify(stableValue(value))}\n`;
}

function revisionOf(snapshot) {
  const content = AREAS.map(area => stableStringify(snapshot?.[area] || [])).join('');
  return `sha256:${crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}`;
}

function previewHashOf(preview) {
  return `sha256:${crypto.createHash('sha256').update(Buffer.from(stableStringify(preview), 'utf8')).digest('hex')}`;
}

module.exports = { stableValue, stableStringify, revisionOf, previewHashOf };
