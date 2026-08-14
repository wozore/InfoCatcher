'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadAiModuleConfig,
  validateModuleConfig,
} = require('../../src/shared/ai-config');

function withConfig(value, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infocatcher-ai-config-'));
  const filePath = path.join(dir, 'config.json');
  fs.writeFileSync(filePath, JSON.stringify(value));
  try {
    return callback(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('loads catalog config from modules and keeps module boundaries', () => {
  const config = withConfig({
    modules: {
      catalog: {
        provider: 'openai',
        model: 'gpt-test',
        protocol: 'responses',
        timeout_ms: 9000,
      },
      news: { enabled: false },
    },
  }, filePath => loadAiModuleConfig('catalog', filePath));
  assert.equal(config.provider, 'openai');
  assert.equal(config.model, 'gpt-test');
  assert.equal(config.protocol, 'responses');
  assert.equal(config.timeout_ms, 9000);
  assert.equal(config.max_search_queries, 4);
});

test('rejects protocol mismatch before execution', () => {
  assert.throws(
    () => validateModuleConfig('catalog', { provider: 'anthropic', protocol: 'responses' }),
    error => error.code === 'AI_PROTOCOL_MISMATCH',
  );
});

test('supports legacy catalog root config during transition', () => {
  const config = withConfig({ provider: 'deepseek', model: 'legacy-model' }, filePath => loadAiModuleConfig('catalog', filePath));
  assert.equal(config.model, 'legacy-model');
  assert.equal(config.provider, 'deepseek');
});
