// Offline end-to-end test for the Librarian curation flow.
//
// Uses a fake agent shell script and a temp vault — no real Slack/Notion/Claude.
// Proves: enqueue → drain (agent runs, note written) → gap re-enqueue dedup
//         (topic skipped because note_exists) → queue unchanged.
//
// Exits 0 on PASS, 1 on any failed assertion.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger, LogRecord } from '../logger';
import { loadLibrarianConfig } from '../librarian/config';
import { enqueueTopics, enqueueFromAnswers, drainQueue } from '../librarian/curate';

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-e2e-'));
  const vaultDir = path.join(tmp, 'vault');
  const answersDir = path.join(tmp, 'answers');
  const agentScript = path.join(tmp, 'fake-librarian.sh');
  const librarianMd = path.join(tmp, 'LIBRARIAN.md');
  const queuePath = path.join(tmp, '.symphony', 'curation_queue.jsonl');

  fs.mkdirSync(answersDir, { recursive: true });

  // Fake agent script:
  // - reads stdin into .last_prompt.txt (relative to cwd=vault)
  // - ensures _inbox/decisions/ exists
  // - if deeplink-routing.md already exists, appends "- updated"; otherwise creates it with frontmatter+body
  // - prints a result line and exits 0
  const agentLines = [
    'cat > .last_prompt.txt',
    'mkdir -p _inbox/decisions',
    'note="_inbox/decisions/deeplink-routing.md"',
    'if [ -f "$note" ]; then',
    '  echo "- updated" >> "$note"',
    'else',
    "  printf '%s\\n' '---' 'title: Deeplink routing' 'type: decision' 'status: draft' '---' '## body' 'deeplink routing info' > \"$note\"",
    'fi',
    'echo \'{"type":"result","subtype":"success"}\'',
    'exit 0',
  ];
  fs.writeFileSync(agentScript, agentLines.join('\n') + '\n');

  // LIBRARIAN.md with front matter pointing at the temp vault
  fs.writeFileSync(
    librarianMd,
    `---
vault:
  path: ${vaultDir}
  inbox: _inbox
  taxonomy: [decisions, glossary]
review_mode: draft
sources:
  slack: true
  notion: true
queue:
  path: ${queuePath}
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
  const logger = new Logger({
    level: 'debug',
    sink: (rec, line) => {
      records.push(rec);
      process.stdout.write(line + '\n');
    },
  });

  const cfg = loadLibrarianConfig(librarianMd);

  // Step 1: bootstrap enqueue + drain → note should be written
  enqueueTopics(['deeplink routing'], 'bootstrap', cfg, logger);
  await drainQueue(cfg, logger);

  // Step 2: write an answer with a gap section referencing the same topic
  const gapSection = '## 불확실하거나 추가 확인이 필요한 부분\n- deeplink routing\n';
  fs.writeFileSync(path.join(answersDir, 'JAY-1.md'), gapSection);

  // Capture the queue file content before the gap enqueue
  const queueBefore = fs.readFileSync(cfg.queue.path, 'utf8');

  // Step 3: enqueue from answers — should be skipped (note already exists)
  enqueueFromAnswers(answersDir, cfg, logger);

  // --- assertions ---
  const notePath = path.join(vaultDir, '_inbox', 'decisions', 'deeplink-routing.md');
  const decisionsDir = path.join(vaultDir, '_inbox', 'decisions');
  const noteCount = fs.existsSync(decisionsDir)
    ? fs.readdirSync(decisionsDir).filter((f) => f.endsWith('.md')).length
    : 0;

  const queueAfter = fs.readFileSync(cfg.queue.path, 'utf8');

  const lastPromptPath = path.join(vaultDir, '.last_prompt.txt');
  const promptContent = fs.existsSync(lastPromptPath) ? fs.readFileSync(lastPromptPath, 'utf8') : '';

  const failures: string[] = [];
  const has = (event: string) => records.some((r) => r.event === event);
  const check = (cond: boolean, msg: string) => {
    if (!cond) failures.push(msg);
  };

  check(has('curation_started'), 'expected a curation_started event');
  check(has('note_written'), 'expected a note_written event');
  check(fs.existsSync(notePath), `expected note file at ${notePath}`);
  check(noteCount === 1, `expected exactly one .md note under _inbox/decisions/ (got ${noteCount})`);
  check(
    records.some((r) => r.event === 'topic_skipped' && (r as Record<string, unknown>)['reason'] === 'note_exists'),
    'expected topic_skipped with reason note_exists for the gap re-enqueue',
  );
  check(queueAfter === queueBefore, 'queue file must not grow when the topic is skipped on dedup');
  check(promptContent.includes('deeplink routing'), 'agent prompt should contain "deeplink routing"');

  process.stdout.write('\n========== LIBRARIAN E2E ==========\n');
  if (failures.length === 0) {
    process.stdout.write('PASS\n');
    process.exit(0);
  } else {
    process.stdout.write('FAIL:\n');
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.stdout.write(`(temp dir kept for inspection: ${tmp})\n`);
    process.exit(1);
  }
}

void main().catch((err) => {
  process.stderr.write(`harness error: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
