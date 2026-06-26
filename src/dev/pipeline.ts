// Dev pipeline: worktree → agent writes code + pr.md/commit.txt → optional verify
// → deterministic commit/push/Draft-PR (with attribution stripped) → DevResult.
//
// The agent NEVER pushes or opens a PR. The orchestrator owns those steps so the
// Draft flag and sanitization are guaranteed.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DevConfig, DevRepo, DevResult } from './types';
import { Issue } from '../types';
import { Logger } from '../logger';
import { render } from '../template';
import { runAgent } from '../agent';
import { buildAgentEnv } from '../env';
import { sanitizeMessage } from './sanitize';
import { defaultBranch, ensureWorktree, hasChanges, commitAll, pushBranch } from './git';
import { existingPrUrl, createPr } from './pr';

const PR_FILE = 'pr.md';
const COMMIT_FILE = 'commit.txt';

/** Sanitize a string to a safe git branch component. */
function safeBranch(raw: string): string {
  return raw
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
    .slice(0, 200);
}

/** First non-blank line = title (with a leading `#` stripped); the rest = body. */
function parsePr(text: string): { title: string; body: string } {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const title = (lines[i] ?? '').replace(/^#+\s*/, '').trim();
  const body = lines.slice(i + 1).join('\n').trim();
  return { title, body };
}

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export interface DevPipelineOpts {
  issue: Issue;
  repo: DevRepo;
  devCfg: DevConfig;
  model: string;
  logger: Logger;
}

export async function runDevPipeline(opts: DevPipelineOpts): Promise<DevResult> {
  const { issue, repo, devCfg, model, logger } = opts;
  const log = logger;

  const branchRaw = issue.branch_name && issue.branch_name.trim() !== '' ? issue.branch_name : `${issue.identifier}-symphony`;
  let branch = safeBranch(branchRaw);
  const base = repo.base || defaultBranch(repo.path);
  if (!branch || branch === base) branch = safeBranch(`${issue.identifier}-dev`);

  const worktreePath = path.join(devCfg.worktreeRoot, issue.identifier);

  // --- worktree ---
  try {
    const { created, startPoint } = ensureWorktree(repo.path, worktreePath, branch, base);
    log.info('dev_worktree_ready', { worktree: worktreePath, branch, base, start_point: startPoint, created });
  } catch (err) {
    return { ok: false, reason: `worktree_failed: ${(err as Error).message}` };
  }

  // --- agent ---
  let command: string;
  let prompt: string;
  try {
    command = render(devCfg.command, { issue, model }, { shellEscape: true });
    prompt = render(devCfg.promptTemplate, { issue, model });
  } catch (err) {
    return { ok: false, reason: `render_failed: ${(err as Error).message}` };
  }

  // Agent log goes OUTSIDE the worktree so it is never committed.
  const metaDir = path.join(devCfg.worktreeRoot, '.meta');
  fs.mkdirSync(metaDir, { recursive: true });
  const logPath = path.join(metaDir, `${issue.identifier}.log`);

  log.info('dev_agent_started', { model });
  const result = await runAgent({
    command,
    workspacePath: worktreePath,
    prompt,
    stallTimeoutMs: devCfg.stallTimeoutMs,
    logPath,
    logger: log,
  });
  if (result.kind !== 'completed') {
    return { ok: false, reason: `agent_${result.kind}` };
  }

  // --- collect the agent's protocol files, then remove them so they are NOT committed ---
  const prRaw = readIfExists(path.join(worktreePath, PR_FILE));
  const commitRaw = readIfExists(path.join(worktreePath, COMMIT_FILE));
  for (const f of [PR_FILE, COMMIT_FILE]) {
    try {
      fs.rmSync(path.join(worktreePath, f), { force: true });
    } catch {
      /* ignore */
    }
  }

  // --- optional verify (on the changed code, before any PR) ---
  if (repo.verify) {
    log.info('dev_verify_started', {});
    const vr = spawnSync('bash', ['-lc', repo.verify], { cwd: worktreePath, encoding: 'utf8', env: buildAgentEnv() });
    if (vr.status !== 0) {
      log.error('dev_verify_failed', { status: vr.status, stderr: (vr.stderr || '').slice(-500) });
      return { ok: false, reason: 'verify_failed' };
    }
  }

  if (!hasChanges(worktreePath)) {
    return { ok: false, reason: 'no_changes' };
  }

  // --- commit (sanitized message) ---
  const { title: prTitle, body: prBody } = parsePr(prRaw ?? '');
  const title = sanitizeMessage(prTitle, devCfg.stripPatterns) || issue.title || issue.identifier;
  const commitMsg = sanitizeMessage(commitRaw ?? prTitle ?? title, devCfg.stripPatterns) || title;
  try {
    commitAll(worktreePath, commitMsg);
  } catch (err) {
    return { ok: false, reason: `commit_failed: ${(err as Error).message}` };
  }

  // --- push ---
  try {
    pushBranch(worktreePath, branch);
  } catch (err) {
    return { ok: false, reason: `push_failed: ${(err as Error).message}` };
  }

  // --- Draft PR (reuse existing if the branch already has one) ---
  const existing = existingPrUrl(worktreePath, branch);
  if (existing) {
    log.info('dev_pr_updated', { url: existing, branch });
    return { ok: true, prUrl: existing, branch, repo: repo.name, updated: true, title };
  }
  const bodyBase = sanitizeMessage(prBody, devCfg.stripPatterns);
  const body = issue.url ? `${bodyBase}\n\n---\nLinear: ${issue.url}`.trim() : bodyBase;
  try {
    const url = createPr(worktreePath, { title, body, base, head: branch, draft: devCfg.prDraft });
    log.info('dev_pr_created', { url, branch, draft: devCfg.prDraft });
    return { ok: true, prUrl: url, branch, repo: repo.name, updated: false, title };
  } catch (err) {
    return { ok: false, reason: `pr_failed: ${(err as Error).message}` };
  }
}
