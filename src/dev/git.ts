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

function branchExists(repoPath: string, branch: string): boolean {
  try {
    git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a worktree at `worktreePath` on `branch`. Idempotent: reuses an existing
 * worktree; checks out an existing branch; otherwise creates the branch off `base`.
 * Returns whether the worktree was newly created.
 */
export function ensureWorktree(repoPath: string, worktreePath: string, branch: string, base: string): { created: boolean } {
  if (fs.existsSync(path.join(worktreePath, '.git'))) return { created: false };
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  if (branchExists(repoPath, branch)) {
    git(repoPath, ['worktree', 'add', worktreePath, branch]);
  } else {
    git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, base]);
  }
  return { created: true };
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
