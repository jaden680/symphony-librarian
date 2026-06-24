# Knowledge Curation ("Librarian") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Librarian" that searches Slack/Notion for scattered past decisions, distills them into classified Obsidian notes, so Symphony can ground answers in a fast, local decision layer.

**Architecture:** A separate batch command (`npm run curate`) drives a Claude Code CLI agent that has Slack/Notion **read** tools + vault **read/write** tools (no code access). Topics enter a JSONL queue from a bootstrap list (`--topics`) or harvested gap sections of past answers (`--from-answers`); each pending topic runs one agent that writes/updates a single classified note. Symphony reads the curated vault (read-only) and ignores the `_inbox/` draft area.

**Tech Stack:** TypeScript + Node 22 (CommonJS, global `fetch`), `yaml`. Tests use Node's built-in `node:test` + `node:assert` (no new deps) for pure-logic modules, and a standalone offline harness (mirroring `src/test/e2e.ts`) for the full agent loop.

## Global Constraints

- Node.js >= 22; CommonJS; reuse existing modules (`src/logger.ts`, `src/env.ts`, `src/template.ts`, `src/agent.ts`).
- Minimize external dependencies (only `yaml`, already present).
- Librarian writes ONLY inside the vault root; never reads/writes code; no `Bash` tool (so no deletion).
- Secrets never logged; `ANTHROPIC_API_KEY` stripped from subprocesses (reuse `buildAgentEnv`); no `LINEAR_API_KEY` needed.
- Slack/Notion are **read-only**; distill (do not bulk-copy raw content).
- Structured logs only (one JSON line per event) via the existing `Logger`.
- Default `review_mode: draft` → notes land in `vault/_inbox/`.
- All file paths absolute in code; `tsc -p tsconfig.json` must pass with `noUnusedLocals`/`noUnusedParameters`.

---

## File Structure

- Create `src/librarian/types.ts` — config + queue types.
- Create `src/librarian/queue.ts` — `CurationQueue` (JSONL: enqueue+dedup, pending, markDone).
- Create `src/librarian/gaps.ts` — parse gap sections from answer markdown.
- Create `src/librarian/vault.ts` — vault path containment + existing-note lookup.
- Create `src/librarian/config.ts` — `loadLibrarianConfig(path)` (front matter + prompt + validate).
- Create `src/librarian/runner.ts` — `runLibrarianTopic(...)` (renders command/prompt, runs the agent, logs note changes).
- Create `src/librarian/curate.ts` — orchestration: enqueue (topics/answers) + drain queue.
- Create `src/librarian/cli.ts` — CLI entry (`--topics`, `--topics-file`, `--from-answers`, drain).
- Modify `src/agent.ts` — make `answerFile` optional, add optional `logPath`.
- Create `LIBRARIAN.md` — config + distillation prompt.
- Create `src/test/librarian/queue.test.ts`, `gaps.test.ts`, `vault.test.ts`, `config.test.ts` — `node:test` units.
- Create `src/test/librarian-e2e.ts` — offline full-loop harness (fake agent + temp vault).
- Modify `package.json` — `curate`, `test:unit` scripts.
- Modify `WORKFLOW.md` — Symphony prompt ignores `./wiki/_inbox/`.

---

## Task 1: Generalize the agent runner (optional answerFile + logPath)

**Files:**
- Modify: `src/agent.ts`
- Test: covered by existing `src/test/e2e.ts` (must still pass) + new librarian-e2e (Task 11).

**Interfaces:**
- Produces: `runAgent(opts: RunAgentOptions): Promise<AgentResult>` where `RunAgentOptions` adds optional `logPath?: string` (absolute log file path; default `<workspacePath>/symphony-agent.log`) and makes `answerFile?: string` optional (when omitted, `AgentResult` for the completed case has `answerProduced: false`).

- [ ] **Step 1: Update the options interface**

In `src/agent.ts`, change `RunAgentOptions`:

```typescript
export interface RunAgentOptions {
  command: string;
  workspacePath: string;
  prompt: string;
  stallTimeoutMs: number;
  /** Filename (relative to workspace) signalling a produced answer. Optional. */
  answerFile?: string;
  /** Absolute path for the agent activity log. Defaults to <workspace>/symphony-agent.log. */
  logPath?: string;
  logger: Logger;
  onSpawn?: (kill: () => void) => void;
}
```

- [ ] **Step 2: Use logPath and guard answerFile**

In `runAgent`, replace the log stream path and the close-handler answer check:

```typescript
const logFile = opts.logPath ?? path.join(cwd, AGENT_LOG);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
```

```typescript
child.on('close', (code) => {
  if (killTimer) clearTimeout(killTimer);
  if (settled) return;
  const answerProduced = answerFile ? fs.existsSync(path.join(cwd, answerFile)) : false;
  if (code === 0) {
    finish({ kind: 'completed', exitCode: 0, answerProduced });
  } else {
    finish({ kind: 'failed', exitCode: code, reason: `agent exited with code ${code}` });
  }
});
```

(Add `const { command, workspacePath, prompt, stallTimeoutMs, answerFile, logger } = opts;` already destructures these — keep `answerFile` optional. Ensure `path` and `fs` remain imported.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit 0, no type errors.

- [ ] **Step 4: Verify Symphony e2e still passes (regression)**

Run: `node dist/test/e2e.js`
Expected: prints `PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts
git commit -m "refactor(agent): optional answerFile + configurable logPath"
```

---

## Task 2: Librarian types + curation queue

**Files:**
- Create: `src/librarian/types.ts`
- Create: `src/librarian/queue.ts`
- Test: `src/test/librarian/queue.test.ts`

**Interfaces:**
- Produces: `QueueItem` (`{ topic, origin: 'bootstrap'|'gap', sourceHint?, status: 'pending'|'done', enqueuedAt }`); `class CurationQueue { constructor(filePath: string); enqueue(topic, origin, enqueuedAt, sourceHint?): boolean; pending(): QueueItem[]; markDone(topic): void; }`.

- [ ] **Step 1: Write the types**

Create `src/librarian/types.ts`:

```typescript
export interface QueueItem {
  topic: string;
  origin: 'bootstrap' | 'gap';
  sourceHint?: string;
  status: 'pending' | 'done';
  enqueuedAt: string;
}

export interface LibrarianConfig {
  vault: { path: string; inbox: string; taxonomy: string[] };
  reviewMode: 'draft' | 'direct';
  sources: { slack: boolean; notion: boolean };
  queue: { path: string };
  agent: { model: string; stallTimeoutMs: number };
  claude: { command: string };
  promptTemplate: string;
  configPath: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/test/librarian/queue.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run build && node --test dist/test/librarian/queue.test.js`
Expected: FAIL (cannot find module `../../librarian/queue`).

- [ ] **Step 4: Implement the queue**

Create `src/librarian/queue.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { QueueItem } from './types';

export class CurationQueue {
  constructor(private readonly filePath: string) {}

  private readAll(): QueueItem[] {
    if (!fs.existsSync(this.filePath)) return [];
    return fs
      .readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as QueueItem);
  }

  private writeAll(items: QueueItem[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
  }

  /** Enqueue a topic unless an identical pending topic exists. Returns true if added. */
  enqueue(topic: string, origin: QueueItem['origin'], enqueuedAt: string, sourceHint?: string): boolean {
    const t = topic.trim();
    if (t === '') return false;
    const items = this.readAll();
    if (items.some((i) => i.status === 'pending' && i.topic.toLowerCase() === t.toLowerCase())) return false;
    items.push({ topic: t, origin, status: 'pending', enqueuedAt, ...(sourceHint ? { sourceHint } : {}) });
    this.writeAll(items);
    return true;
  }

  pending(): QueueItem[] {
    return this.readAll().filter((i) => i.status === 'pending');
  }

  markDone(topic: string): void {
    const items = this.readAll();
    for (const i of items) if (i.topic === topic && i.status === 'pending') i.status = 'done';
    this.writeAll(items);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build && node --test dist/test/librarian/queue.test.js`
Expected: all 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/librarian/types.ts src/librarian/queue.ts src/test/librarian/queue.test.ts
git commit -m "feat(librarian): curation queue with dedup"
```

---

## Task 3: Gap harvesting from answers

**Files:**
- Create: `src/librarian/gaps.ts`
- Test: `src/test/librarian/gaps.test.ts`

**Interfaces:**
- Produces: `parseGaps(answerMd: string): string[]` (bullet items under the `## 불확실하거나 추가 확인이 필요한 부분` heading); `harvestGaps(dir: string): string[]` (all gaps across `*.md` in a directory).

- [ ] **Step 1: Write the failing test**

Create `src/test/librarian/gaps.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseGaps, harvestGaps } from '../../librarian/gaps';

const ANSWER = `## 결론
something

## 불확실하거나 추가 확인이 필요한 부분
- Airbridge 링크 → home 매핑 규칙
- page_type 전체 값 목록

## 다른 섹션
- not a gap
`;

test('parseGaps extracts only the bullets under the gap heading', () => {
  const gaps = parseGaps(ANSWER);
  assert.deepEqual(gaps, ['Airbridge 링크 → home 매핑 규칙', 'page_type 전체 값 목록']);
});

test('parseGaps returns [] when the section is absent', () => {
  assert.deepEqual(parseGaps('## 결론\nno gaps here'), []);
});

test('harvestGaps reads all .md files in a directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ans-'));
  fs.writeFileSync(path.join(dir, 'A.md'), ANSWER);
  fs.writeFileSync(path.join(dir, 'B.md'), '## 불확실하거나 추가 확인이 필요한 부분\n- extra topic\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  const gaps = harvestGaps(dir).sort();
  assert.deepEqual(gaps.sort(), ['Airbridge 링크 → home 매핑 규칙', 'extra topic', 'page_type 전체 값 목록'].sort());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/test/librarian/gaps.test.js`
Expected: FAIL (cannot find module `../../librarian/gaps`).

- [ ] **Step 3: Implement gaps**

Create `src/librarian/gaps.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

const GAP_HEADER = '## 불확실하거나 추가 확인이 필요한 부분';

/** Extract bullet topics under the gap heading of an answer markdown file. */
export function parseGaps(answerMd: string): string[] {
  const idx = answerMd.indexOf(GAP_HEADER);
  if (idx === -1) return [];
  let section = answerMd.slice(idx + GAP_HEADER.length);
  const nextHeading = section.indexOf('\n## ');
  if (nextHeading !== -1) section = section.slice(0, nextHeading);
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-') || l.startsWith('*'))
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter((l) => l !== '');
}

/** Harvest gaps from every *.md file in a directory. */
export function harvestGaps(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    out.push(...parseGaps(fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/test/librarian/gaps.test.js`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/librarian/gaps.ts src/test/librarian/gaps.test.ts
git commit -m "feat(librarian): harvest gap topics from answer files"
```

---

## Task 4: Vault path containment + existing-note lookup

**Files:**
- Create: `src/librarian/vault.ts`
- Test: `src/test/librarian/vault.test.ts`

**Interfaces:**
- Produces: `resolveVaultPath(vaultRoot: string, rel: string): string` (throws if it escapes the root); `findExistingNote(vaultRoot: string, topic: string): string | null` (best-effort dedup hint — first `.md` whose lowercased content contains the topic).

- [ ] **Step 1: Write the failing test**

Create `src/test/librarian/vault.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/test/librarian/vault.test.js`
Expected: FAIL (cannot find module `../../librarian/vault`).

- [ ] **Step 3: Implement vault**

Create `src/librarian/vault.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

/** Resolve a path under the vault root, rejecting anything that escapes it. */
export function resolveVaultPath(vaultRoot: string, rel: string): string {
  const root = path.resolve(vaultRoot);
  const target = path.resolve(root, rel);
  const rootSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !(target + path.sep).startsWith(rootSep)) {
    throw new Error(`path "${target}" escapes vault root "${root}"`);
  }
  return target;
}

/** Best-effort dedup hint: first .md note whose content mentions the topic. */
export function findExistingNote(vaultRoot: string, topic: string): string | null {
  const root = path.resolve(vaultRoot);
  if (!fs.existsSync(root)) return null;
  const needle = topic.trim().toLowerCase();
  if (needle === '') return null;
  const walk = (dir: string): string | null => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const r = walk(p);
        if (r) return r;
      } else if (e.name.endsWith('.md')) {
        if (fs.readFileSync(p, 'utf8').toLowerCase().includes(needle)) return p;
      }
    }
    return null;
  };
  return walk(root);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/test/librarian/vault.test.js`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/librarian/vault.ts src/test/librarian/vault.test.ts
git commit -m "feat(librarian): vault containment + dedup lookup"
```

---

## Task 5: Librarian config loader

**Files:**
- Create: `src/librarian/config.ts`
- Test: `src/test/librarian/config.test.ts`

**Interfaces:**
- Consumes: `LibrarianConfig` (Task 2).
- Produces: `loadLibrarianConfig(filePath: string): LibrarianConfig` (throws `LibrarianConfigError` on fatal problems); `class LibrarianConfigError extends Error`.

- [ ] **Step 1: Write the failing test**

Create `src/test/librarian/config.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/test/librarian/config.test.js`
Expected: FAIL (cannot find module `../../librarian/config`).

- [ ] **Step 3: Implement config**

Create `src/librarian/config.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { LibrarianConfig } from './types';

export class LibrarianConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibrarianConfigError';
  }
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function resolveEnvTokens(value: unknown): unknown {
  if (typeof value === 'string') {
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
    if (m) return process.env[m[1]] ?? '';
    return value;
  }
  if (Array.isArray(value)) return value.map(resolveEnvTokens);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveEnvTokens(v);
    return out;
  }
  return value;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asString(v: unknown, fb = ''): string {
  return v === null || v === undefined ? fb : String(v);
}
function asInt(v: unknown, fb: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.trunc(Number(v));
  return fb;
}
function asBool(v: unknown, fb: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off', ''].includes(s)) return false;
  }
  return fb;
}
function asStringList(v: unknown, fb: string[]): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x !== '');
  return fb;
}

export function loadLibrarianConfig(filePath: string): LibrarianConfig {
  const abs = path.resolve(filePath);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new LibrarianConfigError(`cannot read ${abs}: ${(err as Error).message}`);
  }
  const m = FRONT_MATTER_RE.exec(raw);
  if (!m) throw new LibrarianConfigError('LIBRARIAN.md must start with a YAML front-matter block');
  let parsed: unknown;
  try {
    parsed = YAML.parse(m[1]);
  } catch (err) {
    throw new LibrarianConfigError(`invalid YAML: ${(err as Error).message}`);
  }
  const cfg = asObject(resolveEnvTokens(parsed));
  const dir = path.dirname(abs);

  const vault = asObject(cfg.vault);
  const sources = asObject(cfg.sources);
  const queue = asObject(cfg.queue);
  const agent = asObject(cfg.agent);
  const claude = asObject(cfg.claude);

  const vaultPathRaw = asString(vault.path, '').trim();
  const reviewMode = asString(cfg.review_mode, 'draft').trim() === 'direct' ? 'direct' : 'draft';

  const effective: LibrarianConfig = {
    vault: {
      path: vaultPathRaw === '' ? '' : path.resolve(dir, vaultPathRaw),
      inbox: asString(vault.inbox, '_inbox').trim() || '_inbox',
      taxonomy: asStringList(vault.taxonomy, ['decisions', 'domain-rules', 'integrations', 'glossary']),
    },
    reviewMode,
    sources: { slack: asBool(sources.slack, true), notion: asBool(sources.notion, true) },
    queue: { path: path.resolve(dir, asString(queue.path, '.symphony/curation_queue.jsonl')) },
    agent: {
      model: asString(agent.model, 'sonnet').trim() || 'sonnet',
      stallTimeoutMs: Math.max(1000, asInt(agent.stall_timeout_ms, 600_000)),
    },
    claude: { command: asString(claude.command, '').trim() },
    promptTemplate: (m[2] ?? '').trim(),
    configPath: abs,
  };

  const problems: string[] = [];
  if (!effective.vault.path) problems.push('vault.path is required');
  if (!effective.claude.command) problems.push('claude.command is empty');
  if (!effective.promptTemplate) problems.push('prompt template (below front matter) is empty');
  if (problems.length) throw new LibrarianConfigError(`invalid config:\n  - ${problems.join('\n  - ')}`);

  return effective;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/test/librarian/config.test.js`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/librarian/config.ts src/test/librarian/config.test.ts
git commit -m "feat(librarian): LIBRARIAN.md config loader"
```

---

## Task 6: Librarian runner (one topic → agent → note)

**Files:**
- Create: `src/librarian/runner.ts`
- Test: covered by librarian-e2e (Task 11).

**Interfaces:**
- Consumes: `LibrarianConfig` (Task 2), `render` from `../template`, `runAgent` from `../agent`, `Logger` from `../logger`.
- Produces: `runLibrarianTopic(topic: string, cfg: LibrarianConfig, logger: Logger): Promise<{ ok: boolean; changedNotes: string[] }>` — renders command (`{{ model }}`) and prompt (`{{ topic }}`, `{{ vault_dir }}`, `{{ inbox }}`, `{{ taxonomy }}`), runs the agent with cwd=vault, logs note changes by diffing the vault's `.md` set before/after.

- [ ] **Step 1: Implement the runner**

Create `src/librarian/runner.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { LibrarianConfig } from './types';
import { Logger } from '../logger';
import { render } from '../template';
import { runAgent } from '../agent';

function listNotes(root: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.set(p, fs.statSync(p).mtimeMs);
    }
  };
  walk(root);
  return out;
}

export async function runLibrarianTopic(
  topic: string,
  cfg: LibrarianConfig,
  logger: Logger,
): Promise<{ ok: boolean; changedNotes: string[] }> {
  const log = logger.child({ topic });
  const vaultRoot = path.resolve(cfg.vault.path);
  fs.mkdirSync(vaultRoot, { recursive: true });
  if (cfg.reviewMode === 'draft') fs.mkdirSync(path.join(vaultRoot, cfg.vault.inbox), { recursive: true });

  const ctx = {
    topic,
    model: cfg.agent.model,
    vault_dir: vaultRoot,
    inbox: cfg.vault.inbox,
    review_mode: cfg.reviewMode,
    taxonomy: cfg.vault.taxonomy.join(', '),
  };

  let command: string;
  let prompt: string;
  try {
    command = render(cfg.claude.command, ctx, { shellEscape: true });
    prompt = render(cfg.promptTemplate, ctx);
  } catch (err) {
    log.error('curation_failed', { reason: 'render_failed', detail: (err as Error).message });
    return { ok: false, changedNotes: [] };
  }

  const before = listNotes(vaultRoot);
  log.info('curation_started', { vault: vaultRoot, review_mode: cfg.reviewMode });

  // Agent log goes OUTSIDE the vault so it never pollutes notes.
  const logPath = path.join(path.dirname(cfg.queue.path), `librarian-${Date.now()}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const result = await runAgent({
    command,
    workspacePath: vaultRoot,
    prompt,
    stallTimeoutMs: cfg.agent.stallTimeoutMs,
    logPath,
    logger: log,
  });

  if (result.kind !== 'completed') {
    log.error('curation_failed', { reason: result.kind, detail: result.kind === 'failed' ? result.reason : undefined });
    return { ok: false, changedNotes: [] };
  }

  const after = listNotes(vaultRoot);
  const changed: string[] = [];
  for (const [p, mtime] of after) {
    if (!before.has(p)) {
      changed.push(p);
      log.info('note_written', { note: path.relative(vaultRoot, p) });
    } else if (before.get(p) !== mtime) {
      changed.push(p);
      log.info('note_updated', { note: path.relative(vaultRoot, p) });
    }
  }
  if (changed.length === 0) log.info('note_skipped', { reason: 'no_note_written' });
  return { ok: true, changedNotes: changed };
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/librarian/runner.ts
git commit -m "feat(librarian): topic runner (agent + note-change detection)"
```

---

## Task 7: Curate orchestration

**Files:**
- Create: `src/librarian/curate.ts`
- Test: covered by librarian-e2e (Task 11).

**Interfaces:**
- Consumes: `CurationQueue`, `loadLibrarianConfig`, `harvestGaps`, `findExistingNote`, `runLibrarianTopic`, `Logger`.
- Produces: `enqueueTopics(topics: string[], origin, cfg, logger): number`; `enqueueFromAnswers(dir, cfg, logger): number`; `drainQueue(cfg, logger): Promise<{ processed: number; failed: number }>`.

- [ ] **Step 1: Implement curate**

Create `src/librarian/curate.ts`:

```typescript
import { LibrarianConfig, QueueItem } from './types';
import { CurationQueue } from './queue';
import { harvestGaps } from './gaps';
import { findExistingNote } from './vault';
import { runLibrarianTopic } from './runner';
import { Logger } from '../logger';

function nowIso(): string {
  return new Date().toISOString();
}

/** Enqueue topics, skipping those already covered by an existing vault note. */
export function enqueueTopics(
  topics: string[],
  origin: QueueItem['origin'],
  cfg: LibrarianConfig,
  logger: Logger,
): number {
  const queue = new CurationQueue(cfg.queue.path);
  let added = 0;
  for (const topic of topics) {
    const t = topic.trim();
    if (t === '') continue;
    if (findExistingNote(cfg.vault.path, t)) {
      logger.info('topic_skipped', { topic: t, reason: 'note_exists' });
      continue;
    }
    if (queue.enqueue(t, origin, nowIso())) {
      added++;
      logger.info('topic_enqueued', { topic: t, origin });
    }
  }
  return added;
}

export function enqueueFromAnswers(dir: string, cfg: LibrarianConfig, logger: Logger): number {
  return enqueueTopics(harvestGaps(dir), 'gap', cfg, logger);
}

export async function drainQueue(cfg: LibrarianConfig, logger: Logger): Promise<{ processed: number; failed: number }> {
  const queue = new CurationQueue(cfg.queue.path);
  let processed = 0;
  let failed = 0;
  for (const item of queue.pending()) {
    const res = await runLibrarianTopic(item.topic, cfg, logger);
    if (res.ok) {
      queue.markDone(item.topic);
      processed++;
    } else {
      failed++;
    }
  }
  logger.info('curation_complete', { processed, failed });
  return { processed, failed };
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/librarian/curate.ts
git commit -m "feat(librarian): enqueue + drain orchestration"
```

---

## Task 8: CLI entry

**Files:**
- Create: `src/librarian/cli.ts`
- Modify: `package.json` (add `curate` + `test:unit` scripts)

**Interfaces:**
- Consumes: `loadLibrarianConfig`, `enqueueTopics`, `enqueueFromAnswers`, `drainQueue`, `Logger`.
- Produces: CLI runnable as `node dist/librarian/cli.js [--librarian <path>] [--topics "a, b"] [--topics-file <path>] [--from-answers <dir>]`.

- [ ] **Step 1: Implement the CLI**

Create `src/librarian/cli.ts`:

```typescript
#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger';
import { loadLibrarianConfig, LibrarianConfigError } from './config';
import { enqueueTopics, enqueueFromAnswers, drainQueue } from './curate';

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const logger = new Logger({ level: 'info' });

  const workflowPath = path.resolve(arg(argv, '--librarian') ?? 'LIBRARIAN.md');
  let cfg;
  try {
    cfg = loadLibrarianConfig(workflowPath);
  } catch (err) {
    logger.error('startup_failed', { error: (err as LibrarianConfigError).message });
    process.exitCode = 1;
    return;
  }

  const topics = arg(argv, '--topics');
  const topicsFile = arg(argv, '--topics-file');
  const fromAnswers = arg(argv, '--from-answers');

  if (topics) enqueueTopics(topics.split(',').map((t) => t.trim()).filter(Boolean), 'bootstrap', cfg, logger);
  if (topicsFile) {
    const lines = fs.readFileSync(path.resolve(topicsFile), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    enqueueTopics(lines, 'bootstrap', cfg, logger);
  }
  if (fromAnswers) enqueueFromAnswers(path.resolve(fromAnswers), cfg, logger);

  await drainQueue(cfg, logger);
}

void main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm scripts**

In `package.json` `scripts`, add:

```json
    "curate": "node dist/librarian/cli.js --librarian LIBRARIAN.md",
    "test:unit": "npm run build && node --test dist/test/librarian/"
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Verify startup validation (no LIBRARIAN.md)**

Run: `node dist/librarian/cli.js --librarian /nonexistent/LIBRARIAN.md; echo "exit: $?"`
Expected: a JSON line with `"event":"startup_failed"` and `exit: 1`.

- [ ] **Step 5: Commit**

```bash
git add src/librarian/cli.ts package.json
git commit -m "feat(librarian): curate CLI entry"
```

---

## Task 9: LIBRARIAN.md config + prompt

**Files:**
- Create: `LIBRARIAN.md`

**Interfaces:**
- Produces: a config consumed by `loadLibrarianConfig`. Placeholders used by the runner: `{{ model }}` (command), `{{ topic }}` / `{{ vault_dir }}` / `{{ inbox }}` / `{{ taxonomy }}` (prompt).

- [ ] **Step 1: Write LIBRARIAN.md**

Create `LIBRARIAN.md`:

```markdown
---
vault:
  path: $HOME/ObsidianVault   # TODO: set your real vault path (write target)
  inbox: _inbox
  taxonomy: [decisions, domain-rules, integrations, glossary]
review_mode: draft
sources:
  slack: true
  notion: true
queue:
  path: .symphony/curation_queue.jsonl
agent:
  model: sonnet
  stall_timeout_ms: 600000
claude:
  command: claude -p --model {{ model }} --setting-sources user --permission-mode default --allowedTools Read,Grep,Glob,Write,Edit,mcp__claude_ai_Slack__slack_search_public,mcp__claude_ai_Slack__slack_read_thread,mcp__claude_ai_Slack__slack_read_channel,mcp__claude_ai_Notion__notion-search,mcp__claude_ai_Notion__notion-fetch --output-format stream-json --verbose
---
You are a knowledge librarian curating a single decision note for this topic:
{{ topic }}

Your vault is the current working directory ({{ vault_dir }}). Review mode is
{{ review_mode }} — when it is "draft", write into the ./{{ inbox }}/ folder;
otherwise write into the matching type folder. Note types (folders): {{ taxonomy }}.

Steps:
1. Search Slack and Notion for scattered evidence about this topic (use the read
   tools). Gather and reconcile the pieces; prefer the most recent decision and
   note any supersession.
2. Check the vault FIRST (Grep/Glob/Read) for an existing note on this topic. If
   found, UPDATE it with Edit (merge; do not overwrite hand-written content). If
   not, create ONE new note.
3. Write a single classified markdown note with this frontmatter:
   title, type (one of the folders), status (active|superseded|draft), tags,
   aliases, decided, updated, sources (slack/notion links), supersedes.
   Body sections: ## 결론 / ## 배경·이유 / ## 세부 규칙·예외 / ## 출처 / ## 변경 이력.

Rules:
- READ-ONLY on Slack/Notion — never post or send. Distill; do NOT paste raw
  private content. Cite every claim with a Slack/Notion source link.
- Write ONLY inside the vault. Do not touch code. Do not delete files.
- If you cannot find supporting evidence, write a short note saying so (status:
  draft) rather than inventing content.
```

- [ ] **Step 2: Commit**

```bash
git add LIBRARIAN.md
git commit -m "feat(librarian): example LIBRARIAN.md config + prompt"
```

---

## Task 10: Symphony excludes the draft inbox

**Files:**
- Modify: `WORKFLOW.md` (prompt body, wiki evidence bullet)

**Interfaces:** none (prompt text only).

- [ ] **Step 1: Update the wiki evidence instruction**

In `WORKFLOW.md`, change the wiki bullet in the prompt body:

Find:
```
2. (If present) The Obsidian wiki vault at ./wiki — markdown notes holding
   historical decisions, hidden business rules, and context the code alone does
   not reveal. If ./wiki does not exist, rely on the codebase only.
```
Replace with:
```
2. (If present) The Obsidian wiki vault at ./wiki — markdown notes holding
   historical decisions, hidden business rules, and context the code alone does
   not reveal. IGNORE the ./wiki/_inbox/ folder (unreviewed drafts). If ./wiki
   does not exist, rely on the codebase only.
```

- [ ] **Step 2: Verify config still parses**

Run: `LINEAR_API_KEY=dummy node -e "require('./dist/config.js').loadConfig('WORKFLOW.md'); console.log('ok')"`
Expected: prints `ok` (build first if needed: `npm run build`).

- [ ] **Step 3: Commit**

```bash
git add WORKFLOW.md
git commit -m "feat(symphony): ignore wiki/_inbox drafts in answers"
```

---

## Task 11: Offline end-to-end harness

**Files:**
- Create: `src/test/librarian-e2e.ts`
- Modify: `package.json` (add `test:librarian-e2e` script)

**Interfaces:**
- Consumes: `loadLibrarianConfig`, `enqueueTopics`, `enqueueFromAnswers`, `drainQueue`, `CurationQueue`, `Logger`.

This proves the queue → distill → write → dedup loop using a **fake agent script** (no real Slack/Notion/Claude) and a temp vault.

- [ ] **Step 1: Write the harness**

Create `src/test/librarian-e2e.ts`:

```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger, LogRecord } from '../logger';
import { loadLibrarianConfig } from '../librarian/config';
import { enqueueTopics, enqueueFromAnswers, drainQueue } from '../librarian/curate';

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-e2e-'));
  const vault = path.join(tmp, 'vault');
  const agentScript = path.join(tmp, 'fake-librarian.sh');
  const answers = path.join(tmp, 'answers');
  const workflow = path.join(tmp, 'LIBRARIAN.md');
  fs.mkdirSync(answers, { recursive: true });

  // Fake agent: reads the prompt, writes ONE classified note into the inbox.
  // The note filename is derived from a fixed slug so re-runs hit the same file
  // (exercises dedup/update). It appends a marker line each run.
  fs.writeFileSync(
    agentScript,
    [
      'cat > .last_prompt.txt',
      'mkdir -p _inbox/decisions',
      'note="_inbox/decisions/deeplink-routing.md"',
      'if [ -f "$note" ]; then echo "- updated $(date +%s)" >> "$note"; else printf "%s\\n" "---" "title: Deeplink routing" "type: decision" "status: draft" "sources: [slack://x]" "---" "## 결론" "path-based" "## 변경 이력" "- created" > "$note"; fi',
      'echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\"}"',
      'exit 0',
    ].join('\n') + '\n',
  );

  fs.writeFileSync(
    workflow,
    `---
vault:
  path: ${vault}
  inbox: _inbox
  taxonomy: [decisions, glossary]
review_mode: draft
sources:
  slack: true
  notion: true
queue:
  path: ${path.join(tmp, '.symphony/curation_queue.jsonl')}
agent:
  model: sonnet
  stall_timeout_ms: 60000
claude:
  command: bash ${agentScript}
---
Curate a note for {{ topic }} in {{ vault_dir }} (inbox {{ inbox }}, types {{ taxonomy }}).
`,
  );

  const records: LogRecord[] = [];
  const logger = new Logger({ level: 'debug', sink: (rec, line) => { records.push(rec); process.stdout.write(line + '\\n'); } });

  const cfg = loadLibrarianConfig(workflow);

  // 1) bootstrap enqueue + drain -> note written
  enqueueTopics(['deeplink routing'], 'bootstrap', cfg, logger);
  await drainQueue(cfg, logger);

  // 2) gap harvest enqueue: existing-note dedup should SKIP the same topic
  fs.writeFileSync(path.join(answers, 'JAY-1.md'), '## 불확실하거나 추가 확인이 필요한 부분\\n- deeplink routing\\n');
  const beforeQueueLen = require('fs').readFileSync(cfg.queue.path, 'utf8');
  enqueueFromAnswers(answers, cfg, logger);

  const notePath = path.join(vault, '_inbox/decisions/deeplink-routing.md');
  const noteCount = fs.existsSync(path.join(vault, '_inbox/decisions'))
    ? fs.readdirSync(path.join(vault, '_inbox/decisions')).filter((f) => f.endsWith('.md')).length
    : 0;

  const failures: string[] = [];
  const has = (e: string) => records.some((r) => r.event === e);
  const check = (c: boolean, m: string) => { if (!c) failures.push(m); };

  check(has('curation_started'), 'expected curation_started');
  check(has('note_written'), 'expected note_written');
  check(fs.existsSync(notePath), 'expected the note file in _inbox');
  check(noteCount === 1, \`expected exactly one note (got \${noteCount})\`);
  check(records.some((r) => r.event === 'topic_skipped' && (r as any).reason === 'note_exists'),
    'gap re-enqueue of an existing-note topic must be skipped');
  // queue unchanged by the skipped gap enqueue
  check(require('fs').readFileSync(cfg.queue.path, 'utf8') === beforeQueueLen, 'queue must not grow on dedup-skip');
  // agent received the rendered prompt with the topic
  const prompt = fs.readFileSync(path.join(vault, '.last_prompt.txt'), 'utf8');
  check(prompt.includes('deeplink routing'), 'agent prompt should contain the topic');

  process.stdout.write('\\n========== LIBRARIAN E2E ==========\\n');
  if (failures.length === 0) {
    process.stdout.write('PASS\\n');
    process.exit(0);
  } else {
    for (const f of failures) process.stdout.write(\`  - \${f}\\n\`);
    process.stdout.write(\`(temp kept: \${tmp})\\n\`);
    process.exit(1);
  }
}

void main().catch((err) => { process.stderr.write(\`harness error: \${(err as Error).stack}\\n\`); process.exit(1); });
```

- [ ] **Step 2: Add the script**

In `package.json` `scripts`, add:

```json
    "test:librarian-e2e": "npm run build && node dist/test/librarian-e2e.js"
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Run the harness**

Run: `node dist/test/librarian-e2e.js`
Expected: prints `PASS`, exit 0. (Verifies: note written to `_inbox`, exactly one note after a duplicate-topic gap enqueue, the gap enqueue was skipped via existing-note dedup, the queue did not grow, and the agent received the rendered topic prompt.)

- [ ] **Step 5: Run all unit tests + Symphony e2e (full regression)**

Run: `npm run build && node --test dist/test/librarian/ && node dist/test/e2e.js && node dist/test/librarian-e2e.js`
Expected: all unit tests PASS, both e2e harnesses print `PASS`.

- [ ] **Step 6: Commit**

```bash
git add src/test/librarian-e2e.ts package.json
git commit -m "test(librarian): offline end-to-end harness"
```

---

## Task 12: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Knowledge curation (Librarian)" section**

Append to `README.md` after the "Reading Slack threads" section:

```markdown
## Knowledge curation (Librarian)

Symphony reads the vault; the **Librarian** writes it. It searches Slack/Notion for
scattered past decisions, distills them into classified Obsidian notes, and never
touches code. Curation is a batch command (not a daemon):

```bash
# Bootstrap: name the key topics; the agent finds the scattered evidence
npm run curate -- --topics "deeplink routing, payment settlement"

# Gap-driven: harvest "추가 확인 필요" topics from past answers
npm run curate -- --from-answers ~/symphony_answers

# Drain the pending queue only
npm run curate
```

Config lives in `LIBRARIAN.md` (set `vault.path`). Notes land in `vault/_inbox/`
as drafts (`review_mode: draft`); review in Obsidian and move them into a type
folder (`decisions/`, `domain-rules/`, `integrations/`, `glossary/`) to promote
them. Symphony ignores `_inbox/`. Slack/Notion are read-only; the Librarian cannot
delete files (no Bash) and writes only inside the vault.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document the Librarian knowledge-curation flow"
```

---

## Self-Review Notes (completed by plan author)

- **Spec coverage:** two-role architecture (Tasks 6/7/10), queue+dedup (Task 2), gap harvest (Task 3), vault containment/draft (Tasks 4/6/9/10), config (Task 5), triggers (Tasks 7/8), note format/taxonomy/dedup (prompt in Task 9 + dedup in Tasks 4/7), safety (allowedTools/no-Bash/read-only in Task 9; logPath-outside-vault in Task 6), v1 acceptance criteria 1-7 (Tasks 1-11). v2 items intentionally deferred.
- **Placeholders:** none — every code step contains full code.
- **Type consistency:** `LibrarianConfig`/`QueueItem` defined in Task 2 and consumed unchanged in Tasks 5-8; `runAgent` `logPath`/optional `answerFile` from Task 1 used in Task 6; `render(..., { shellEscape })` matches the existing `template.ts` signature.
- **Note:** This directory is not a git repo yet; the commit steps assume `git init` has been run. If git is not desired, skip the commit steps — each task is still independently testable.
