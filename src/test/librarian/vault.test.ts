import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveVaultPath, findExistingNote } from '../../librarian/vault';

test('resolveVaultPath keeps paths inside the root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  assert.equal(resolveVaultPath(root, 'decisions/x.md'), path.join(root, 'decisions/x.md'));
});

test('resolveVaultPath rejects escapes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  assert.throws(() => resolveVaultPath(root, '../evil.md'));
  assert.throws(() => resolveVaultPath(root, '/etc/passwd'));
});

test('findExistingNote finds a note mentioning the topic', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  fs.mkdirSync(path.join(root, 'decisions'));
  fs.writeFileSync(path.join(root, 'decisions/deeplink.md'), '---\ntitle: Deeplink routing\n---\nbody');
  assert.equal(findExistingNote(root, 'deeplink routing'), path.join(root, 'decisions/deeplink.md'));
  assert.equal(findExistingNote(root, 'nonexistent topic'), null);
});
