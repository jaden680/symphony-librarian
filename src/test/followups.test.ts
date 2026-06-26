import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FollowupStore, isFollowupComment } from '../followups';

function tmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-'));
  return path.join(dir, 'nested', 'followups.json');
}

test('FollowupStore: first run seeds lastCheck from now, empty responded', () => {
  const p = tmpPath();
  const store = new FollowupStore(p, '2026-06-26T00:00:00.000Z');
  assert.equal(store.lastCheck, '2026-06-26T00:00:00.000Z');
  assert.equal(store.hasResponded('c1'), false);
});

test('FollowupStore: markResponded + setLastCheck persist across reload', () => {
  const p = tmpPath();
  const a = new FollowupStore(p, '2026-06-26T00:00:00.000Z');
  a.markResponded('c1');
  a.setLastCheck('2026-06-26T01:00:00.000Z');

  // Reload from disk — a fresh store must see the persisted state, not the seed.
  const b = new FollowupStore(p, '2099-01-01T00:00:00.000Z');
  assert.equal(b.lastCheck, '2026-06-26T01:00:00.000Z');
  assert.equal(b.hasResponded('c1'), true);
  assert.equal(b.hasResponded('c2'), false);
});

test('FollowupStore: responded list is capped at 1000', () => {
  const p = tmpPath();
  const store = new FollowupStore(p, '2026-06-26T00:00:00.000Z');
  for (let i = 0; i < 1100; i++) store.markResponded(`c${i}`);
  // Oldest evicted, newest retained.
  assert.equal(store.hasResponded('c0'), false);
  assert.equal(store.hasResponded('c1099'), true);
});

test('FollowupStore: corrupt file falls back to seed', () => {
  const p = tmpPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'not json {{{');
  const store = new FollowupStore(p, '2026-06-26T00:00:00.000Z');
  assert.equal(store.lastCheck, '2026-06-26T00:00:00.000Z');
  assert.equal(store.hasResponded('c1'), false);
});

const BOT = 'bot-id';
const never = () => false;

test('isFollowupComment: human reply on a bot-answered issue → true', () => {
  assert.equal(isFollowupComment({ id: 'c1', authorId: 'human' }, BOT, [BOT, 'human'], never), true);
});

test('isFollowupComment: bot own comment → false', () => {
  assert.equal(isFollowupComment({ id: 'c1', authorId: BOT }, BOT, [BOT], never), false);
});

test('isFollowupComment: issue the bot never commented on → false', () => {
  assert.equal(isFollowupComment({ id: 'c1', authorId: 'human' }, BOT, ['human', 'other'], never), false);
});

test('isFollowupComment: already responded → false', () => {
  assert.equal(isFollowupComment({ id: 'c1', authorId: 'human' }, BOT, [BOT], (id) => id === 'c1'), false);
});
