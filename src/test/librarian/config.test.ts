import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadLibrarianConfig, LibrarianConfigError } from '../../librarian/config';

function write(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  const p = path.join(dir, 'LIBRARIAN.md');
  fs.writeFileSync(p, content);
  return p;
}

const VALID = `---
vault:
  path: /tmp/MyVault
  inbox: _inbox
  taxonomy: [decisions, glossary]
review_mode: draft
sources:
  slack: true
  notion: false
queue:
  path: .symphony/curation_queue.jsonl
agent:
  model: sonnet
  stall_timeout_ms: 600000
claude:
  command: claude -p --model {{ model }} --output-format stream-json --verbose
---
Curate a note for {{ topic }}.
`;

test('loads and resolves a valid config', () => {
  const cfg = loadLibrarianConfig(write(VALID));
  assert.equal(cfg.vault.path, '/tmp/MyVault');
  assert.equal(cfg.vault.inbox, '_inbox');
  assert.equal(cfg.reviewMode, 'draft');
  assert.equal(cfg.sources.slack, true);
  assert.equal(cfg.sources.notion, false);
  assert.equal(cfg.agent.model, 'sonnet');
  assert.ok(cfg.promptTemplate.includes('{{ topic }}'));
});

test('rejects missing vault.path', () => {
  const bad = VALID.replace('  path: /tmp/MyVault\n', '');
  assert.throws(() => loadLibrarianConfig(write(bad)), LibrarianConfigError);
});

test('rejects empty command', () => {
  const bad = VALID.replace(/command: .*/, 'command: ""');
  assert.throws(() => loadLibrarianConfig(write(bad)), LibrarianConfigError);
});
