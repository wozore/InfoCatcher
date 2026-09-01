'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const store = require('../../../src/news/feedback/pending-review-store');

function tempFile(prefix) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'pending.json');
}

test('pending store uses stable candidate keys and preserves reviewed decisions', async () => {
  const toolFile = tempFile('pending-store-');
  const first = await store.mergePending('tools', [{ name: ' Tool X ', description: 'first' }], { toolFile });
  assert.equal(first.cards.length, 1);
  assert.equal(first.cards[0].candidate_key, store.candidateKeyOf('tools', 'tool x'));
  assert.equal(first.cards[0].review_status, 'pending');
  const reviewed = await store.reviewPending('tools', first.cards[0].candidate_key, 'discarded', first.revision, { toolFile });
  const merged = await store.mergePending('tools', [{ name: 'Tool X', description: 'first' }], { toolFile });
  assert.equal(merged.cards[0].review_status, 'discarded');
  assert.equal(merged.cards[0].reviewed_at, reviewed.cards[0].reviewed_at);
  const changed = await store.mergePending('tools', [{ name: 'Tool X', description: 'changed' }], { toolFile });
  assert.equal(changed.cards[0].review_status, 'pending');
  assert.notEqual(changed.revision, merged.revision);
});

test('pending store review uses revision CAS and projection hides business fields', async () => {
  const conceptFile = tempFile('pending-concept-');
  const result = await store.mergePending('concepts', [{ term: 'RAG', definition: 'private evidence' }], { conceptFile });
  await assert.rejects(
    store.reviewPending('concepts', result.cards[0].candidate_key, 'approved', 'sha256:stale', { conceptFile }),
    error => error.code === 'REVISION_CONFLICT',
  );
  const publicView = store.projectPending('concepts', result);
  assert.deepEqual(Object.keys(publicView.items[0]).sort(), ['blocking_reasons', 'candidate_key', 'generated_at', 'mentioned_in_summaries', 'review_status', 'reviewed_at', 'source_hotspot', 'term', 'workflow_state']);
  assert.equal(Object.hasOwn(publicView.items[0], 'definition'), false);
});

test('pending store review is async and serializes concurrent writes', async () => {
  const toolFile = tempFile('pending-race-');
  const first = await store.mergePending('tools', [{ name: 'Racer', description: 'v1' }], { toolFile });
  const [approved, rejected] = await Promise.allSettled([
    store.reviewPending('tools', first.cards[0].candidate_key, 'approved', first.revision, { toolFile }),
    store.reviewPending('tools', first.cards[0].candidate_key, 'discarded', first.revision, { toolFile }),
  ]);
  assert.equal(approved.status, 'fulfilled');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason.code, 'REVISION_CONFLICT');
  const after = await store.mergePending('tools', [{ name: 'Racer', description: 'v1' }], { toolFile });
  assert.equal(after.cards[0].review_status, 'approved', '并发后人工结论仍在，业务字段未变前不重置');
});
