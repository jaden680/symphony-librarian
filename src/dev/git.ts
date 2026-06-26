// Git worktree + commit/push helpers for dev mode. Thin wrappers over the `git`
// CLI (execFileSync). All writes happen inside a throwaway worktree on a feature
// branch — never the user's working copy, never the default branch.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export class DevGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevGitError';
  }
}

/** Run `git <args>` in `cwd`, returning trimmed stdout. Throws DevGitError on failure. */
export function git(cwd: string, args: string[], input?: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message: string };
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    throw new DevGitError(`git ${args.join(' ')} failed: ${stderr || e.message}`);
  }
}

/** The repo's default branch (e.g. "main"), best-effort with fallbacks. */
export function defaultBranch(repoPath: string): string {
  try {
    const ref = git(repoPath, ['rev-parse', '--abbrev-ref', 'origin/HEAD']); // e.g. "origin/main"
    const short = ref.replace(/^origin\//, '').trim();
    if (short) return short;
  } catch {
    /* origin/HEAD not set — fall through */
  }
  try {
    const cur = git(repoPath, ['symbolic-ref', '--short', 'HEAD']).trim();
    if (cur) return cur;
  } catch {
    /* detached or bare — fall through */
  }
  return 'main';
}

function refExists(repoPath: string, ref: string): boolean {
  try {
    git(repoPath, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

function branchExists(repoPath: string, branch: string): boolean {
  return refExists(repoPath, `refs/heads/${branch}`);
}

/**
 * Ensure a worktree at `worktreePath` on `branch`. Idempotent: reuses an existing
 * worktree; checks out an existing branch; otherwise fetches `base` from origin and
 * creates the new branch off the *remote tip* (`origin/<base>`) so work starts from
 * the latest integration branch — not a possibly-stale local ref. Falls back to the
 * local base ref when offline / no such remote branch. Returns the created flag and
 * the start point actually used.
 */
export function ensureWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  base: string,
): { created: boolean; startPoint: string } {
  if (fs.existsSync(path.join(worktreePath, '.git'))) return { created: false, startPoint: branch };
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  if (branchExists(repoPath, branch)) {
    git(repoPath, ['worktree', 'add', worktreePath, branch]);
    return { created: true, startPoint: branch };
  }
  // Branch off the latest remote tip. Fetch is best-effort: if it fails (offline,
  // unknown branch) we fall back to whatever local ref `base` resolves to.
  let startPoint = base;
  try {
    git(repoPath, ['fetch', 'origin', base]);
    if (refExists(repoPath, `refs/remotes/origin/${base}`)) startPoint = `origin/${base}`;
    else if (refExists(repoPath, 'FETCH_HEAD')) startPoint = 'FETCH_HEAD';
  } catch {
    /* offline or no such remote branch — use the local base ref */
  }
  git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, startPoint]);
  return { created: true, startPoint };
}

/** True if the worktree has staged or unstaged changes (incl. untracked). */
export function hasChanges(worktreePath: string): boolean {
  return git(worktreePath, ['status', '--porcelain']).length > 0;
}

/** Stage everything and commit with the given (already-sanitized) message. */
export function commitAll(worktreePath: string, message: string): void {
  git(worktreePath, ['add', '-A']);
  // Read the message from stdin (-F -) to safely handle multi-line content, and
  // disable signing so an unconfigured signing key can't block the commit.
  git(worktreePath, ['-c', 'commit.gpgsign=false', 'commit', '-F', '-'], message);
}

/** Push the branch to origin (sets upstream). */
export function pushBranch(worktreePath: string, branch: string): void {
  git(worktreePath, ['push', '-u', 'origin', `HEAD:${branch}`]);
}
