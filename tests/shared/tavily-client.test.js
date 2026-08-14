'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalizeUrl,
  searchTavily,
  extractTavily,
} = require('../../src/shared/tavily-client');

function response(data, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

test('canonicalizeUrl removes markdown and CJK trailing punctuation before parsing', () => {
  assert.equal(
    canonicalizeUrl('https://kling.ai/document-api/apiReference/model/imageToVideo`）'),
    'https://kling.ai/document-api/apiReference/model/imageToVideo',
  );
  assert.equal(canonicalizeUrl('https://example.com/page。'), 'https://example.com/page');
  assert.equal(canonicalizeUrl('not a url'), '');
});

test('searchTavily sends domain-limited search and normalizes sources', async () => {
  let request;
  const result = await searchTavily({
    query: 'Kling 2.6 official API',
    includeDomains: ['kling.ai'],
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      request = { url, init: JSON.parse(init.body), authorization: init.headers.Authorization };
      return response({ results: [
        { url: 'https://kling.ai/docs`）', title: 'Docs', content: 'Official excerpt', score: 0.9 },
        { url: 'https://kling.ai/docs`）', title: 'Duplicate', content: 'Duplicate' },
        { url: 'https://third-party.example/kling', title: 'Third party', content: 'Ignore locally' },
      ] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://api.tavily.com/search');
  assert.equal(request.authorization, 'Bearer test-key');
  assert.deepEqual(request.init.include_domains, ['kling.ai']);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].url, 'https://kling.ai/docs');
  assert.equal(result.sources[1].url, 'https://third-party.example/kling');
});

test('extractTavily returns cleaned markdown and preserves failed URLs', async () => {
  let request;
  const result = await extractTavily({
    urls: ['https://kling.ai/docs`）', 'https://kling.ai/pricing'],
    query: 'API access and pricing',
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      request = { url, init: JSON.parse(init.body) };
      return response({
        results: [{ url: 'https://kling.ai/docs', raw_content: '# Official docs\nAPI available.' }],
        failed_results: [{ url: 'https://kling.ai/pricing', error: 'blocked' }],
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://api.tavily.com/extract');
  assert.deepEqual(request.init.urls, ['https://kling.ai/docs', 'https://kling.ai/pricing']);
  assert.equal(result.contents[0].content, '# Official docs\nAPI available.');
  assert.deepEqual(result.failed, [{ url: 'https://kling.ai/pricing', error: 'blocked' }]);
});

test('searchTavily fails closed when the key is missing', async () => {
  const result = await searchTavily({ query: 'test', apiKey: '' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TAVILY_SEARCH_AUTH_REQUIRED');
});
