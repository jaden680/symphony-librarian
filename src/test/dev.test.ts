import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyByLabels, selectRepoByLabels, findRepoByName } from '../dev/classify';
import { sanitizeMessage } from '../dev/sanitize';
import { DevRepo } from '../dev/types';

const DEV = ['dev', 'feature', 'bug'];
const ANS = ['question', 'answer'];

test('classifyByLabels: dev label → dev', () => {
  assert.equal(classifyByLabels(['feature'], DEV, ANS), 'dev');
});

test('classifyByLabels: answer label → answer', () => {
  assert.equal(classifyByLabels(['question'], DEV, ANS), 'answer');
});

test('classifyByLabels: no routing label → null (undecided)', () => {
  assert.equal(classifyByLabels(['frontend', 'p1'], DEV, ANS), null);
});

test('classifyByLabels: dev takes precedence when both present', () => {
  assert.equal(classifyByLabels(['question', 'dev'], DEV, ANS), 'dev');
});

test('classifyByLabels: case-insensitive', () => {
  assert.equal(classifyByLabels(['Feature'], DEV, ANS), 'dev');
});

const REPOS: DevRepo[] = [
  { name: 'app-ios', path: '/x/ios', labels: ['ios'], base: '', verify: '' },
  { name: 'app-android', path: '/x/android', labels: ['android'], base: '', verify: '' },
];

test('selectRepoByLabels: matches by label', () => {
  assert.equal(selectRepoByLabels(['android'], REPOS)?.name, 'app-android');
});

test('selectRepoByLabels: no match → null', () => {
  assert.equal(selectRepoByLabels(['backend'], REPOS), null);
});

test('findRepoByName: case-insensitive name match', () => {
  assert.equal(findRepoByName('APP-IOS', REPOS)?.name, 'app-ios');
  assert.equal(findRepoByName(null, REPOS), null);
  assert.equal(findRepoByName('nope', REPOS), null);
});

test('sanitizeMessage: strips Co-Authored-By Claude trailer', () => {
  const msg = 'feat: add thing\n\nbody line\n\nCo-Authored-By: Claude <noreply@anthropic.com>';
  const out = sanitizeMessage(msg);
  assert.ok(!/Claude/i.test(out), 'no Claude');
  assert.ok(out.includes('feat: add thing'));
  assert.ok(out.includes('body line'));
});

test('sanitizeMessage: strips Generated-with and 🤖 lines', () => {
  const msg = 'fix: bug\n\n🤖 Generated with Claude Code\n\nreal detail';
  const out = sanitizeMessage(msg);
  assert.ok(!out.includes('🤖'));
  assert.ok(!/Generated with/i.test(out));
  assert.ok(!/Claude Code/i.test(out));
  assert.ok(out.includes('fix: bug'));
  assert.ok(out.includes('real detail'));
});

test('sanitizeMessage: extra custom pattern', () => {
  const out = sanitizeMessage('title\nSECRET-TRAILER: x\nkeep', ['SECRET-TRAILER:.*']);
  assert.ok(!out.includes('SECRET-TRAILER'));
  assert.ok(out.includes('keep'));
});

test('sanitizeMessage: collapses blank-line runs left by removals', () => {
  const out = sanitizeMessage('a\n\n🤖\n\n\nb');
  assert.equal(out, 'a\n\nb');
});

test('sanitizeMessage: invalid user pattern is ignored, not fatal', () => {
  const out = sanitizeMessage('keep this', ['(unclosed']);
  assert.equal(out, 'keep this');
});
