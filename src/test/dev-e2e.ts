// Offline end-to-end test for DEV MODE.
//
// Spins up: a fake Linear server with a dev-labeled ticket; a real temp git repo
// with a bare `origin`; a fake `gh` stub on PATH; and a fake dev agent that edits
// a file and writes pr.md/commit.txt (with Claude attribution, to prove stripping).
// Runs the REAL Orchestrator and asserts the full dev pipeline:
//   classify(dev) → worktree → agent → commit(sanitized) → push → Draft PR →
//   Linear comment(PR link) → issue moved to In Review.

import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AddressInfo } from 'net';
import { Logger, LogRecord } from '../logger';
import { ConfigStore } from '../config';
import { Orchestrator } from '../orchestrator';

const API_KEY = 'dummy-key-dev';

const STATES = [
  { id: 's-todo', name: 'Todo', type: 'unstarted' },
  { id: 's-prog', name: 'In Progress', type: 'started' },
  { id: 's-review', name: 'In Review', type: 'started' },
  { id: 's-done', name: 'Done', type: 'completed' },
];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

interface FakeServer {
  server: http.Server;
  port: number;
  getIssueState(): string;
  getComments(): string[];
  getTransitions(): string[];
}

function startFakeLinear(branchName: string): Promise<FakeServer> {
  const issue = { id: 'issue-dev-1', identifier: 'ZZ-9', state: 'Todo' };
  const comments: string[] = [];
  const transitions: string[] = [];

  const issueNode = () => ({
    id: issue.id,
    identifier: issue.identifier,
    title: 'Add a feature flag for the new banner',
    description: 'Implement a simple feature flag toggling the promo banner.',
    priority: 2,
    url: 'https://linear.app/zz/issue/ZZ-9',
    branchName,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    state: { id: 's-todo', name: issue.state, type: 'unstarted' },
    labels: { nodes: [{ name: 'dev' }, { name: 'ios' }] },
    inverseRelations: { nodes: [] },
  });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.headers['authorization'] !== API_KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ message: 'invalid auth' }] }));
        return;
      }
      const parsed = JSON.parse(body) as { query?: string; variables?: Record<string, unknown> };
      const q = parsed.query ?? '';
      const vars = parsed.variables ?? {};
      const reply = (data: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data }));
      };
      if (q.includes('SymphonyTeam')) {
        reply({ teams: { nodes: [{ id: 'team-1', key: 'ZZ', name: 'Test', states: { nodes: STATES } }] } });
      } else if (q.includes('SymphonyIssues')) {
        const requested = ((vars.states as string[]) ?? []).map((s) => String(s).toLowerCase());
        const nodes = requested.includes(issue.state.toLowerCase()) ? [issueNode()] : [];
        reply({ issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } });
      } else if (q.includes('SymphonyIssueStates')) {
        const ids = (vars.ids as string[]) ?? [];
        reply({ issues: { nodes: ids.includes(issue.id) ? [{ id: issue.id, state: { name: issue.state } }] : [] } });
      } else if (q.includes('SymphonyComment')) {
        comments.push(String(vars.body));
        reply({ commentCreate: { success: true } });
      } else if (q.includes('SymphonyMove')) {
        const sid = String(vars.stateId);
        const name = STATES.find((s) => s.id === sid)?.name ?? issue.state;
        issue.state = name;
        transitions.push(name);
        reply({ issueUpdate: { success: true } });
      } else {
        reply({});
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        getIssueState: () => issue.state,
        getComments: () => comments,
        getTransitions: () => transitions,
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-dev-e2e-'));
  const repoDir = path.join(tmp, 'repo');
  const originDir = path.join(tmp, 'origin.git');
  const worktreeRoot = path.join(tmp, 'worktrees');
  const binDir = path.join(tmp, 'bin');
  const ghRecord = path.join(tmp, 'gh_record.txt');
  const devAgent = path.join(tmp, 'dev-agent.sh');
  const answerAgent = path.join(tmp, 'answer-agent.sh');
  const branchName = 'zz-9-feature-flag';

  // --- real git repo + bare origin on `main` ---
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Tester']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# repo\n');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-m', 'initial']);
  execFileSync('git', ['init', '--bare', '-b', 'main', originDir]);
  git(repoDir, ['remote', 'add', 'origin', originDir]);
  git(repoDir, ['push', '-u', 'origin', 'main']);

  // --- fake gh stub on PATH ---
  fs.mkdirSync(binDir, { recursive: true });
  const ghPath = path.join(binDir, 'gh');
  fs.writeFileSync(
    ghPath,
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then exit 1; fi', // no existing PR
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
      '  echo "CREATE $*" >> "$GH_RECORD"',
      '  prev=""',
      '  for a in "$@"; do',
      '    if [ "$prev" = "--body-file" ]; then echo "BODY<<<" >> "$GH_RECORD"; cat "$a" >> "$GH_RECORD"; echo ">>>BODY" >> "$GH_RECORD"; fi',
      '    prev="$a"',
      '  done',
      '  echo "https://github.com/fake/repo/pull/7"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
  );
  fs.chmodSync(ghPath, 0o755);

  // --- fake dev agent: edit a file + write pr.md/commit.txt (with Claude attribution) ---
  fs.writeFileSync(
    devAgent,
    [
      'cat > /dev/null', // consume the prompt; do NOT create a stray worktree file
      'echo "feature_flag = true" >> feature.txt',
      `printf '%s\\n' 'Add promo banner feature flag' '' 'Implements a feature flag for the promo banner.' '' 'Co-Authored-By: Claude <noreply@anthropic.com>' > pr.md`,
      `printf '%s\\n' 'feat: add promo banner feature flag' '' 'Adds feature.txt toggling the banner.' '' '🤖 Generated with Claude Code' > commit.txt`,
      `echo '{"type":"result","subtype":"success"}'`,
      'exit 0',
    ].join('\n') + '\n',
  );
  // Minimal answer agent (should never run in this test, but config needs a command).
  fs.writeFileSync(answerAgent, ['cat > /dev/null', 'printf "ok" > answer.md', 'exit 0'].join('\n') + '\n');

  const fake = await startFakeLinear(branchName);
  const endpoint = `http://127.0.0.1:${fake.port}/graphql`;
  process.env.TEST_LINEAR_KEY = API_KEY;
  process.env.GH_RECORD = ghRecord;
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;

  const devPath = path.join(tmp, 'DEV.md');
  fs.writeFileSync(
    devPath,
    `---
classifier:
  command: bash ${answerAgent}
repos:
  - name: testrepo
    path: ${repoDir}
    labels: [ios]
    base: main
    verify: ''
worktree_root: ${worktreeRoot}
pr:
  draft: true
  strip_patterns: []
agent:
  stall_timeout_ms: 60000
claude:
  command: bash ${devAgent}
---
Implement Linear issue {{ issue.identifier }}: {{ issue.title }}. Write pr.md and commit.txt.
`,
  );

  const workflowPath = path.join(tmp, 'WORKFLOW.md');
  fs.writeFileSync(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: $TEST_LINEAR_KEY
  endpoint: ${endpoint}
  team_key: ZZ
  done_state: Done
  start_state: In Progress
  active_states: [Todo, In Progress]
  poll_interval_sec: 1
  post_answer_comment: true
workspace:
  root: ${path.join(tmp, 'workspaces')}
dev:
  enabled: true
  path: ${devPath}
  dev_labels: [dev, feature, bug]
  answer_labels: [question, answer]
  done_state: In Review
agent:
  max_concurrent_agents: 1
  stall_timeout_ms: 60000
  max_attempts: 2
claude:
  command: bash ${answerAgent}
---
Answer issue {{ issue.identifier }}. Write answer.md.
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

  const store = new ConfigStore(workflowPath, logger);
  const orchestrator = new Orchestrator(store, logger);
  await orchestrator.start();

  const done = await waitFor(
    () => records.some((r) => r.event === 'issue_transitioned' && (r as { to_state?: string }).to_state === 'In Review'),
    25_000,
  );

  orchestrator.stop();
  await new Promise<void>((r) => fake.server.close(() => r()));

  // --- assertions ---
  const failures: string[] = [];
  const has = (event: string) => records.some((r) => r.event === event);
  const check = (cond: boolean, msg: string) => {
    if (!cond) failures.push(msg);
  };

  const worktree = path.join(worktreeRoot, 'ZZ-9');
  check(done, 'expected the dev ticket to reach In Review within timeout');
  check(has('dev_enabled'), 'expected dev_enabled at startup');
  check(has('dev_dispatched'), 'expected dev_dispatched');
  check(has('dev_worktree_ready'), 'expected a worktree to be created');
  check(has('dev_pr_created'), 'expected a Draft PR to be created');
  check(fs.existsSync(path.join(worktree, 'feature.txt')), 'expected the agent code change in the worktree');

  // The branch was pushed to origin with the code change.
  let pushedOk = false;
  try {
    const sha = git(originDir, ['rev-parse', branchName]);
    pushedOk = sha.length > 0;
  } catch {
    pushedOk = false;
  }
  check(pushedOk, `expected branch ${branchName} pushed to origin`);

  // Commit message sanitized — no Claude attribution, real subject kept.
  let commitMsg = '';
  try {
    commitMsg = git(worktree, ['log', '-1', '--format=%B']);
  } catch {
    /* ignore */
  }
  check(/feat: add promo banner feature flag/.test(commitMsg), 'commit subject should be the agent message');
  check(!/Claude/i.test(commitMsg), 'commit message must not mention Claude');
  check(!commitMsg.includes('🤖'), 'commit message must not contain the robot emoji');

  // pr.md / commit.txt were protocol files, not committed into the repo.
  check(!fs.existsSync(path.join(worktree, 'pr.md')), 'pr.md must be removed (not committed)');
  let tracked = '';
  try {
    tracked = git(worktree, ['ls-files']);
  } catch {
    /* ignore */
  }
  check(!tracked.split('\n').includes('pr.md'), 'pr.md must not be tracked');
  check(!tracked.split('\n').includes('commit.txt'), 'commit.txt must not be tracked');
  check(tracked.split('\n').includes('feature.txt'), 'feature.txt must be tracked (the real change)');

  // gh recorded a draft PR create, and the recorded body was sanitized.
  const ghLog = fs.existsSync(ghRecord) ? fs.readFileSync(ghRecord, 'utf8') : '';
  check(/CREATE pr create/.test(ghLog), 'gh pr create should have been invoked');
  check(/--draft/.test(ghLog), 'PR should be created as a Draft');
  check(!/Claude/i.test(ghLog), 'PR body must not mention Claude');

  // Linear comment posted with the PR URL, and ticket moved to In Review.
  const comments = fake.getComments();
  check(
    comments.some((c) => c.includes('https://github.com/fake/repo/pull/7')),
    'expected a Linear comment containing the Draft PR URL',
  );
  check(fake.getIssueState() === 'In Review', `expected ticket in In Review (got ${fake.getIssueState()})`);
  const tr = fake.getTransitions();
  check(tr.includes('In Progress') && tr.indexOf('In Progress') < tr.indexOf('In Review'), `expected In Progress before In Review (got ${JSON.stringify(tr)})`);

  // No answer-mode artifacts: this ticket must not have produced answer.md.
  check(!has('worker_dispatched'), 'dev ticket must not go through the answer worker');
  // Secret redaction.
  check(!records.some((r) => JSON.stringify(r).includes(API_KEY)), 'API key must never appear in logs');

  process.stdout.write('\n========== DEV E2E RESULT ==========\n');
  if (failures.length === 0) {
    process.stdout.write('PASS — dev pipeline verified offline (worktree → commit → push → Draft PR → In Review)\n');
    process.exit(0);
  } else {
    process.stdout.write('FAIL:\n');
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.stdout.write(`(temp dir kept: ${tmp})\n`);
    process.exit(1);
  }
}

void main().catch((err) => {
  process.stderr.write(`dev-e2e harness error: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
