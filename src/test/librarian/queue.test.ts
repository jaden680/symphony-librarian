import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CurationQueue } from '../../librarian/queue';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'q-')), 'queue.jsonl');
}

test('enqueue adds a pending item and returns true', () => {
  const q = new CurationQueue(tmpFile());
  assert.equal(q.enqueue('deeplink', 'bootstrap', '2026-01-01T00:00:00Z'), true);
  assert.equal(q.pending().length, 1);
  assert.equal(q.pending()[0].topic, 'deeplink');
});

test('enqueue dedups identical pending topic (case-insensitive)', () => {
  const q = new CurationQueue(tmpFile());
  q.enqueue('Deeplink', 'bootstrap', '2026-01-01T00:00:00Z');
  assert.equal(q.enqueue('deeplink', 'gap', '2026-01-02T00:00:00Z'), false);
  assert.equal(q.pending().length, 1);
});

test('markDone moves item out of pending', () => {
  const f = tmpFile();
  const q = new CurationQueue(f);
  q.enqueue('payments', 'bootstrap', '2026-01-01T00:00:00Z');
  q.markDone('payments');
  assert.equal(q.pending().length, 0);
  // a done topic can be re-enqueued
  assert.equal(q.enqueue('payments', 'bootstrap', '2026-01-03T00:00:00Z'), true);
});

test('empty topic is rejected', () => {
  const q = new CurationQueue(tmpFile());
  assert.equal(q.enqueue('  ', 'bootstrap', '2026-01-01T00:00:00Z'), false);
});
