'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { webSearchDeepSeek, extractUrls } = require('../../src/shared/deepseek-websearch');

function fakeResponse(data) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

test('twoStage=false bypasses the return loop (single request)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return fakeResponse({
      output: [{ type: 'message', content: [{ type: 'output_text', text: '单段回答，来源 https://example.com/page' }] }],
      status: 'completed',
    });
  };
  const result = await webSearchDeepSeek({ query: 'test', twoStage: false, apiKey: 'test-key', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(result.rounds, 0);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, 'https://example.com/page');
});

test('twoStage=true returns web_search_call back to restore results', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return fakeResponse({
        output: [
          { type: 'reasoning', content: 'thinking', summary: [] },
          { type: 'web_search_call', id: 'call_1', status: 'completed', action: { type: 'search', queries: ['q1'] } },
        ],
        status: 'completed',
      });
    }
    return fakeResponse({
      output: [{ type: 'message', content: [{ type: 'output_text', text: '研究结论，来源 [官方](https://api-docs.deepseek.com/updates/)' }] }],
      status: 'completed',
    });
  };
  const result = await webSearchDeepSeek({ query: 'test', apiKey: 'test-key', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(calls, 2); // 第一段 + 回传一段
  assert.equal(result.rounds, 1);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, 'https://api-docs.deepseek.com/updates/');
});

test('extractUrls deduplicates and trims trailing punctuation', () => {
  const urls = extractUrls('见 https://a.com/page. 与 https://a.com/page，及 https://b.com/x?q=1。');
  assert.deepEqual(urls, ['https://a.com/page', 'https://b.com/x?q=1']);
});
