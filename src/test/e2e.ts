// Offline end-to-end test.
//
// Spins up a fake Linear GraphQL server and a fake agent script, then runs the
// REAL Orchestrator against them. Proves the full loop without external creds:
//   poll -> worker_dispatched -> agent writes answer.md -> after_run copies it
//   -> issue moved to Done (issueUpdate) -> issue_transitioned.
//
// Exits 0 on success, 1 on any failed assertion.

import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { Logger, LogRecord } from '../logger';
import { ConfigStore } from '../config';
import { Orchestrator } from '../orchestrator';

const API_KEY = 'dummy-key-123';

const STATES = [
  { id: 's-todo', name: 'Todo', type: 'unstarted' },
  { id: 's-prog', name: 'In Progress', type: 'started' },
  { id: 's-done', name: 'Done', type: 'completed' },
];

const VIEWER_ID = 'bot-viewer-1';

interface StoredComment {
  id: string;
  body: string;
  createdAt: string;
  authorId: string;
  issueId: string;
}

interface FakeServer {
  server: http.Server;
  port: number;
  getMovedStateId(): string | null;
  getIssueState(): string;
  getComment(): string | null;
  getTransitions(): string[];
  reopen(): void;
  getBotCommentCount(): number;
  postHumanComment(body: string): void;
  getBotCommentBodies(): string[];
}

function startFakeLinear(): Promise<FakeServer> {
  const issue = {
    id: 'issue-uuid-1',
    identifier: 'ZZ-1',
    state: 'Todo',
  };
  let movedStateId: string | null = null;
  let commentBody: string | null = null;
  const transitions: string[] = [];
  const comments: StoredComment[] = [];
  let commentSeq = 0;
  const nowIso = () => new Date().toISOString();

  const issueNode = () => ({
    id: issue.id,
    identifier: issue.identifier,
    title: 'How does authentication work?',
    description: 'Explain the authentication flow and where the token is validated.',
    priority: 2,
    url: 'https://linear.app/zz/issue/ZZ-1',
    branchName: 'zz-1-auth',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    state: { id: 's-todo', name: issue.state, type: 'unstarted' },
    labels: { nodes: [{ name: 'question' }] },
    inverseRelations: { nodes: [] },
  });

  // A second Todo issue that is BLOCKED by a non-terminal issue. It must never be
  // dispatched — this locks in the corrected inverseRelations blocker direction.
  const blockedNode = () => ({
    id: 'issue-uuid-2',
    identifier: 'ZZ-2',
    title: 'Blocked question',
    description: 'Should not run while blocked.',
    priority: 1,
    url: 'https://linear.app/zz/issue/ZZ-2',
    branchName: 'zz-2',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
    state: { id: 's-todo', name: 'Todo', type: 'unstarted' },
    labels: { nodes: [{ name: 'question' }] },
    inverseRelations: { nodes: [{ type: 'blocks', issue: { id: 'blocker-1', state: { type: 'started' } } }] },
  });

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.headers['authorization'] !== API_KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ message: 'invalid auth' }] }));
        return;
      }
      let parsed: { query?: string; variables?: Record<string, unknown> };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const q = parsed.query ?? '';
      const vars = parsed.variables ?? {};
      const reply = (data: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data }));
      };

      if (q.includes('SymphonyTeam')) {
        reply({ teams: { nodes: [{ id: 'team-1', key: 'ZZ', name: 'Test Team', states: { nodes: STATES } }] } });
      } else if (q.includes('SymphonyIssues')) {
        const requested = ((vars.states as string[]) ?? []).map((s) => String(s).toLowerCase());
        const nodes: unknown[] = [];
        if (requested.includes(issue.state.toLowerCase())) nodes.push(issueNode());
        if (requested.includes('todo')) nodes.push(blockedNode()); // always blocked, never dispatched
        reply({ issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } });
      } else if (q.includes('SymphonyIssueStates')) {
        const ids = (vars.ids as string[]) ?? [];
        const nodes = ids.includes(issue.id) ? [{ id: issue.id, state: { name: issue.state } }] : [];
        reply({ issues: { nodes } });
      } else if (q.includes('SymphonyViewer')) {
        reply({ viewer: { id: VIEWER_ID } });
      } else if (q.includes('SymphonyIssueComments')) {
        // Full thread of an issue (must be checked before the SymphonyComment* prefixes).
        const id = String(vars.id);
        const nodes = comments
          .filter((c) => c.issueId === id)
          .map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, user: { id: c.authorId } }));
        reply({ issue: { comments: { nodes } } });
      } else if (q.includes('SymphonyComments')) {
        // Comments created after `since` (server-side createdAt filter).
        const since = String(vars.since);
        const nodes = comments
          .filter((c) => c.createdAt > since)
          .map((c) => ({
            id: c.id,
            body: c.body,
            createdAt: c.createdAt,
            user: { id: c.authorId },
            issue: {
              id: c.issueId,
              identifier: issue.identifier,
              title: issueNode().title,
              description: issueNode().description,
              state: { name: issue.state },
              team: { key: 'ZZ' },
            },
          }));
        reply({ comments: { nodes } });
      } else if (q.includes('SymphonyComment')) {
        // commentCreate mutation — record it as a BOT-authored comment (this is how
        // the bot "answers", which is what makes later human replies follow-ups).
        commentBody = String(vars.body);
        comments.push({ id: `bot-c${++commentSeq}`, body: commentBody, createdAt: nowIso(), authorId: VIEWER_ID, issueId: String(vars.issueId) });
        reply({ commentCreate: { success: true } });
      } else if (q.includes('SymphonyMove')) {
        const sid = String(vars.stateId);
        const name = STATES.find((s) => s.id === sid)?.name ?? issue.state;
        issue.state = name;
        transitions.push(name);
        if (sid === 's-done') movedStateId = sid;
        reply({ issueUpdate: { success: true } });
      } else {
        reply({});
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        getMovedStateId: () => movedStateId,
        getIssueState: () => issue.state,
        getComment: () => commentBody,
        getTransitions: () => transitions,
        reopen: () => {
          issue.state = 'Todo';
        },
        getBotCommentCount: () => comments.filter((c) => c.authorId === VIEWER_ID).length,
        getBotCommentBodies: () => comments.filter((c) => c.authorId === VIEWER_ID).map((c) => c.body),
        postHumanComment: (body: string) => {
          comments.push({ id: `human-c${++commentSeq}`, body, createdAt: nowIso(), authorId: 'human-1', issueId: issue.id });
        },
      });
    });
  });
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      if (predicate()) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        resolve(false);
      }
    }, 200);
  });
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-e2e-'));
  const workspacesDir = path.join(tmp, 'workspaces');
  const vaultDir = path.join(tmp, 'vault');
  const answersDir = path.join(tmp, 'answers');
  const agentScript = path.join(tmp, 'fake-agent.sh');
  const libScript = path.join(tmp, 'fake-librarian.sh');
  const librarianPath = path.join(tmp, 'LIBRARIAN.md');
  const workflowPath = path.join(tmp, 'WORKFLOW.md');

  // A fake vault note, so the wiki symlink + read path is exercised.
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'auth-decisions.md'), '# Auth\nTokens are validated in middleware.\n');

  // A fake agent: reads the prompt from stdin, emits stream-json-ish activity,
  // writes answer.md, exits 0.
  fs.writeFileSync(
    agentScript,
    [
      // Latest prompt → .prompt_received.txt; every prompt also appended to
      // .prompts_all.txt so multi-run flows (follow-up, reopen) stay inspectable.
      'tee .prompt_received.txt >> .prompts_all.txt',
      `echo '{"type":"agent","status":"running"}'`,
      `printf '## 질문 요약\\nAuth question\\n## 결론\\nValidated in middleware\\n## 불확실하거나 추가 확인이 필요한 부분\\n- Airbridge mapping rule\\n' > answer.md`,
      `echo '{"type":"agent","status":"completed"}'`,
      'exit 0',
    ].join('\n') + '\n',
  );

  // A fake Librarian agent for the in-process auto-drain: writes one note into the
  // vault _inbox for the queued gap, then exits 0.
  fs.writeFileSync(
    libScript,
    [
      'cat > .last_librarian_prompt.txt',
      'mkdir -p _inbox/decisions',
      `printf '%s\\n' '---' 'title: Airbridge mapping' 'type: decision' 'status: draft' '---' '## 결론' 'curated from slack' > _inbox/decisions/airbridge.md`,
      `echo '{"type":"result","subtype":"success"}'`,
      'exit 0',
    ].join('\n') + '\n',
  );

  // LIBRARIAN.md for the in-process drain: same vault + same queue as Symphony.
  fs.writeFileSync(
    librarianPath,
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
  path: ${path.join(tmp, '.symphony/curation_queue.jsonl')}
agent:
  model: sonnet
  stall_timeout_ms: 60000
claude:
  command: bash ${libScript}
---
Curate a note for {{ topic }} in {{ vault_dir }}.
`,
  );

  const fake = await startFakeLinear();
  const endpoint = `http://127.0.0.1:${fake.port}/graphql`;

  process.env.TEST_LINEAR_KEY = API_KEY;

  const workflow = `---
tracker:
  kind: linear
  api_key: $TEST_LINEAR_KEY
  endpoint: ${endpoint}
  team_key: ZZ
  done_state: Done
  start_state: In Progress
  active_states:
    - Todo
    - In Progress
  poll_interval_sec: 1
  reopen_grace_sec: 1
  post_answer_comment: true
workspace:
  root: ${workspacesDir}
wiki:
  vault_path: ${vaultDir}
  mount_name: wiki
curation:
  auto_enqueue_gaps: true
  queue_path: ${path.join(tmp, '.symphony/curation_queue.jsonl')}
  auto_drain_interval_sec: 2
  librarian_path: ${librarianPath}
followups:
  enabled: true
  state_path: ${path.join(tmp, '.symphony/followups.json')}
agent:
  max_concurrent_agents: 1
  stall_timeout_ms: 60000
  max_attempts: 2
claude:
  command: bash ${agentScript}
hooks:
  timeout_ms: 30000
  after_create: |
    echo "fake clone" > CLONE_MARKER.txt
  after_run: |
    mkdir -p ${answersDir}
    cp answer.md "${answersDir}/\${SYMPHONY_ISSUE_IDENTIFIER}.md" || echo "no answer.md produced"
---
You are answering Linear issue {{ issue.identifier }}: {{ issue.title }}

Question:
{{ issue.description }}

Search the codebase and ./wiki (if present). Write your answer to answer.md.
`;
  fs.writeFileSync(workflowPath, workflow);

  const records: LogRecord[] = [];
  const logger = new Logger({
    level: 'debug',
    sink: (rec, line) => {
      records.push(rec);
      process.stdout.write(line + '\n');
    },
  });

  const store = new ConfigStore(workflowPath, logger);
  const orchestrator = new Orchestrator(store, logger);
  await orchestrator.start();

  const draftNote = path.join(vaultDir, '_inbox/decisions/airbridge.md');
  const completed = await waitFor(
    () =>
      records.some((r) => r.event === 'issue_transitioned' && (r as { to_state?: string }).to_state === 'Done') &&
      fs.existsSync(draftNote), // in-process drain wrote the curated note
    25_000,
  );

  // --- follow-up: a teammate replies on the already-answered issue ---
  const botCommentsBefore = fake.getBotCommentCount();
  fake.postHumanComment('이 토큰 만료되면 어떻게 갱신돼?');
  const followedUp = await waitFor(() => fake.getBotCommentCount() > botCommentsBefore, 15_000);

  // --- auto-reopen: move ZZ-1 back to Todo, expect a second dispatch ---
  const dispatchCount = () =>
    records.filter((r) => r.event === 'worker_dispatched' && r.issue_identifier === 'ZZ-1').length;
  const firstCount = dispatchCount();
  const stateBeforeReopen = fake.getIssueState(); // 'Done' from the first completion
  fake.reopen();
  const reopened = await waitFor(() => dispatchCount() > firstCount, 15_000);

  orchestrator.stop();
  await new Promise<void>((r) => fake.server.close(() => r()));

  // --- assertions ---
  const failures: string[] = [];
  const has = (event: string) => records.some((r) => r.event === event);
  const check = (cond: boolean, msg: string) => {
    if (!cond) failures.push(msg);
  };

  const wsPath = path.join(workspacesDir, 'ZZ-1');
  check(completed, 'expected an issue_transitioned event within timeout');
  check(has('worker_dispatched'), 'expected a worker_dispatched event');
  check(has('worker_completed'), 'expected a worker_completed event');
  check(has('issue_transitioned'), 'expected an issue_transitioned event');
  check(fs.existsSync(path.join(wsPath, 'answer.md')), 'expected answer.md in the workspace');
  check(fs.existsSync(path.join(wsPath, 'CLONE_MARKER.txt')), 'expected after_create marker (CLONE_MARKER.txt)');
  check(fs.existsSync(path.join(answersDir, 'ZZ-1.md')), 'expected after_run to copy answer to answers dir');
  check(
    fs.existsSync(path.join(wsPath, 'wiki')) && fs.lstatSync(path.join(wsPath, 'wiki')).isSymbolicLink(),
    'expected a read-only wiki symlink in the workspace',
  );
  check(fake.getMovedStateId() === 's-done', `expected issue moved to Done state id (got ${fake.getMovedStateId()})`);
  check(stateBeforeReopen === 'Done', `expected fake issue Done after first completion (got ${stateBeforeReopen})`);
  // start_state: Todo -> In Progress on start, then -> Done, in that order.
  const tr = fake.getTransitions();
  check(tr.includes('In Progress'), `expected a start transition to In Progress (got ${JSON.stringify(tr)})`);
  check(
    tr.indexOf('In Progress') < tr.indexOf('Done'),
    `expected In Progress before Done (got ${JSON.stringify(tr)})`,
  );
  // Blocker direction: ZZ-2 is blocked by a non-terminal issue and must NEVER be dispatched.
  check(
    !records.some((r) => r.event === 'worker_dispatched' && r.issue_identifier === 'ZZ-2'),
    'blocked issue ZZ-2 must not be dispatched',
  );
  check(!fs.existsSync(path.join(workspacesDir, 'ZZ-2')), 'blocked issue ZZ-2 must not get a workspace');
  // auto-reopen: moving a completed issue back to an active state re-dispatches it.
  check(reopened, 'expected ZZ-1 to be re-dispatched after being moved back to Todo');
  check(has('issue_reopened'), 'expected an issue_reopened event');
  // comment-driven follow-up: a human reply on an answered issue gets an extra answer.
  check(followedUp, 'expected a follow-up answer comment after a human reply');
  check(has('followup_dispatched'), 'expected a followup_dispatched event');
  check(has('followup_answered'), 'expected a followup_answered event');
  const allPrompts = fs.existsSync(path.join(wsPath, '.prompts_all.txt'))
    ? fs.readFileSync(path.join(wsPath, '.prompts_all.txt'), 'utf8')
    : '';
  check(allPrompts.includes('[FOLLOW-UP]'), 'follow-up prompt should be marked [FOLLOW-UP]');
  check(allPrompts.includes('만료'), 'follow-up prompt should inject the latest human comment');
  check(
    allPrompts.includes('Validated in middleware'),
    'follow-up prompt should inject the prior comment thread (the bot answer)',
  );
  // v2: the answer's gap was auto-enqueued into the curation queue.
  check(has('gap_enqueued'), 'expected the answer gap to be auto-enqueued (gap_enqueued)');
  const queueFile = path.join(tmp, '.symphony/curation_queue.jsonl');
  check(
    fs.existsSync(queueFile) && fs.readFileSync(queueFile, 'utf8').includes('Airbridge mapping rule'),
    'expected the curation queue to contain the harvested gap topic',
  );
  // v2: the in-process auto-drain ran the Librarian and wrote a curated note.
  check(has('curation_drain_started'), 'expected an in-process curation drain to start');
  check(has('curation_drain_finished'), 'expected the in-process drain to finish');
  check(fs.existsSync(draftNote), 'expected the drain to write a curated note into the vault _inbox');
  // opt-in comment: the answer.md content must have been posted back to Linear.
  check(fake.getComment() !== null, 'expected the answer to be posted as a Linear comment');
  check(
    (fake.getComment() ?? '').includes('Validated in middleware'),
    'posted comment should contain the answer.md content',
  );
  // Some posted comment must report the curation enqueue (footer + the queued gap).
  // (Asserted across all bot comments, not just the last: by the time the reopen
  // re-answers, the gap is already curated, so its footer won't re-list it.)
  check(
    fake.getBotCommentBodies().some((b) => b.includes('지식 큐레이션') && b.includes('Airbridge mapping rule')),
    'a posted comment should include the curation footer with the enqueued gap',
  );
  // Secret redaction: the API key must never appear in any emitted log line.
  const leaked = records.some((r) => JSON.stringify(r).includes(API_KEY));
  check(!leaked, 'API key must never appear in logs');

  // Prompt was rendered with real issue data and reached the agent via stdin.
  const promptReceived = path.join(wsPath, '.prompt_received.txt');
  if (fs.existsSync(promptReceived)) {
    const p = fs.readFileSync(promptReceived, 'utf8');
    check(p.includes('ZZ-1'), 'prompt should contain the issue identifier');
    check(p.includes('authentication'), 'prompt should contain the rendered issue description');
  } else {
    failures.push('expected the agent to receive the rendered prompt on stdin');
  }

  process.stdout.write('\n========== E2E RESULT ==========\n');
  if (failures.length === 0) {
    process.stdout.write('PASS — full orchestrator loop verified offline\n');
    process.stdout.write(`workspace: ${wsPath}\n`);
    process.exit(0);
  } else {
    process.stdout.write('FAIL:\n');
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.stdout.write(`(temp dir kept for inspection: ${tmp})\n`);
    process.exit(1);
  }
}

void main().catch((err) => {
  process.stderr.write(`e2e harness error: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
