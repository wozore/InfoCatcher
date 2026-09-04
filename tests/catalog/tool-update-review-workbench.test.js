'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadDotEnv } = require('../../src/shared/env');

loadDotEnv();

const {
  defaultReviewQueue,
  readReviewQueue,
  readReviewQueueProjection,
  reviewQueueRevision,
  setReviewStatusReviewQueue,
  writeReviewQueue,
} = require('../../src/catalog/tool-update/index');

const NOW = '2026-08-30T12:00:00.000Z';

function candidate(overrides = {}) {
  return {
    candidate_key: 'acme-tool|https://acme.example/changelog|2026-08-29|sha256:aaaa',
    release_key: 'acme-tool|https://acme.example/changelog|2026-08-29',
    product_key: 'acme-tool',
    product_name: 'Acme Tool',
    detail_id: 'tool-level3:acme-tool',
    evidence_detail_id: 'acme-tool:2026-08-29',
    previous_date: '2026-08-01',
    proposed_date: '2026-08-29',
    source_url: 'https://acme.example/changelog',
    source_type: 'html',
    collector: 'official_html',
    product_surface: 'cli',
    repository: null,
    evidence: {
      title: 'Acme Tool 2.0',
      official_published_at: '2026-08-29T09:00:00Z',
      excerpt: 'Released 2026-08-29 with terminal workflows.',
      content_hash: 'sha256:aaaa',
      status: 'ready',
    },
    ai_suggestion: null,
    review_decision: null,
    decision_source: 'deterministic',
    blocked_reasons: [],
    review_status: 'pending',
    status: 'candidate',
    ...overrides,
  };
}

function blockedCandidate() {
  return candidate({
    candidate_key: 'blocked-tool|https://acme.example/changelog|2026-08-29|sha256:bbbb',
    release_key: 'blocked-tool|https://acme.example/changelog|2026-08-29',
    product_key: 'blocked-tool',
    detail_id: 'tool-level3:blocked-tool',
    evidence_detail_id: 'blocked-tool:2026-08-29',
    status: 'blocked',
    blocked_reasons: ['AI_CONFIDENCE_LOW'],
  });
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-update-workbench-')), 'review.json');
}

function seedQueue(file) {
  writeReviewQueue({
    ...defaultReviewQueue(),
    items: [candidate(), blockedCandidate()],
  }, { file, now: NOW, runId: 'workbench-test-seed' });
}

function withoutQueueTimestamp(queue) {
  const copy = JSON.parse(JSON.stringify(queue));
  delete copy.updated_at;
  return copy;
}

test('read projection exposes a stable revision and a defensive field projection', () => {
  const file = tmpFile();
  try {
    seedQueue(file);
    const projection = readReviewQueueProjection(file);

    assert.match(projection.revision, /^sha256:[0-9a-f]{64}$/);
    assert.equal(projection.items.length, 2);
    assert.equal(projection.items[0].candidate_key, candidate().candidate_key);
    assert.equal('content' in projection.items[0].evidence, false);
    assert.equal('unexpected_client_field' in projection.items[0], false);

    const localizedFile = tmpFile();
    writeReviewQueue({ ...defaultReviewQueue(), items: [candidate({
      localizations: { zh: { title: 'Acme 工具更新', description: '已发布终端工作流更新。' } },
      localizations_meta: { zh: { localizer: 'llm_deepseek', generated_at: NOW, input_chars: 20, llm_error: null, fallback: 'external_summary', summary_chars: 40 } },
    })] }, { file: localizedFile, now: NOW });
    const localized = readReviewQueueProjection(localizedFile).items[0];
    assert.equal(localized.localizations.zh.title, 'Acme 工具更新');
    assert.equal(localized.localizations.zh.description, '已发布终端工作流更新。');
    assert.equal(localized.localizations_meta.zh.fallback, 'external_summary');
    assert.equal(localized.localizations_meta.zh.summary_chars, 40);
    fs.rmSync(path.dirname(localizedFile), { recursive: true, force: true });

    projection.items[0].review_status = 'approved';
    projection.items[0].evidence.excerpt = 'tampered';
    const reread = readReviewQueue(file);
    assert.equal(reread.items[0].review_status, 'pending');
    assert.equal(reread.items[0].evidence.excerpt, candidate().evidence.excerpt);
    assert.equal(reviewQueueRevision(reread), projection.revision);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('mutation changes only the addressed candidate review_status and writes atomically', () => {
  const file = tmpFile();
  try {
    seedQueue(file);
    const before = readReviewQueue(file);
    const projection = readReviewQueueProjection(file);
    const targetKey = before.items[0].candidate_key;

    const result = setReviewStatusReviewQueue({
      candidate_key: targetKey,
      review_status: 'approved',
      expected_revision: projection.revision,
      file,
      now: '2026-08-30T12:01:00.000Z',
      source_url: 'https://attacker.example/replace-me',
    });

    assert.equal(result.ok, true);
    assert.equal(result.updated, 1);
    assert.notEqual(result.revision, projection.revision);
    const after = readReviewQueue(file);
    const expected = JSON.parse(JSON.stringify(before));
    expected.items[0].review_status = 'approved';
    assert.deepEqual(withoutQueueTimestamp(after), withoutQueueTimestamp(expected));
    assert.equal(after.items[1].review_status, 'pending');
    assert.equal(after.items[0].source_url, before.items[0].source_url);
    assert.equal('revision' in after, false);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['review.json']);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('blocked candidate cannot be approved, but can be explicitly rejected', () => {
  const file = tmpFile();
  try {
    seedQueue(file);
    const blocked = readReviewQueue(file).items[1];
    const revision = readReviewQueueProjection(file).revision;

    const denied = setReviewStatusReviewQueue(blocked.candidate_key, 'approved', { file, expectedRevision: revision });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'TOOL_UPDATE_REVIEW_BLOCKED_CANNOT_APPROVE');
    assert.equal(reviewQueueRevision(readReviewQueue(file)), revision);

    const rejected = setReviewStatusReviewQueue(blocked.candidate_key, 'rejected', {
      file,
      expectedRevision: revision,
      now: '2026-08-30T12:02:00.000Z',
    });
    assert.equal(rejected.ok, true);
    assert.equal(readReviewQueue(file).items[1].review_status, 'rejected');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('stale expected revision, unknown candidate, and invalid status fail closed without writing', () => {
  const file = tmpFile();
  try {
    seedQueue(file);
    const before = readReviewQueue(file);
    const currentRevision = readReviewQueueProjection(file).revision;

    const stale = setReviewStatusReviewQueue(before.items[0].candidate_key, 'approved', {
      file,
      expectedRevision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'REVISION_CONFLICT');
    assert.equal(stale.revision, currentRevision);
    assert.deepEqual(readReviewQueue(file), before);

    const missing = setReviewStatusReviewQueue('not-in-queue', 'rejected', { file, expectedRevision: currentRevision });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'TOOL_UPDATE_REVIEW_CANDIDATE_NOT_FOUND');
    assert.deepEqual(readReviewQueue(file), before);

    const invalid = setReviewStatusReviewQueue(before.items[0].candidate_key, 'discarded', {
      file,
      expectedRevision: currentRevision,
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'TOOL_UPDATE_REVIEW_STATUS_INVALID');
    assert.deepEqual(readReviewQueue(file), before);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('missing expected revision is rejected before any queue write', () => {
  const file = tmpFile();
  try {
    seedQueue(file);
    const before = readReviewQueue(file);
    const result = setReviewStatusReviewQueue(before.items[0].candidate_key, 'approved', { file });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TOOL_UPDATE_REVIEW_EXPECTED_REVISION_REQUIRED');
    assert.deepEqual(readReviewQueue(file), before);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
