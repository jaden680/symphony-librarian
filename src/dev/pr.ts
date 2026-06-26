// Draft PR creation via the `gh` CLI. Orchestrator-owned so the Draft flag and
// body sanitization are guaranteed regardless of what the agent did.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export class DevPrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevPrError';
  }
}

function gh(cwd: string, args: string[]): string {
  try {
    return execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message: string };
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    throw new DevPrError(`gh ${args.join(' ')} failed: ${stderr || e.message}`);
  }
}

/** URL of an existing open PR for `branch`, or null if none. */
export function existingPrUrl(cwd: string, branch: string): string | null {
  try {
    const url = gh(cwd, ['pr', 'view', branch, '--json', 'url', '-q', '.url']);
    return url || null;
  } catch {
    return null; // no PR for this branch
  }
}

export interface CreatePrOptions {
  title: string;
  body: string;
  base: string;
  head: string;
  draft: boolean;
}

/** Create a (Draft) PR; returns its URL. Body is passed via a temp file. */
export function createPr(cwd: string, opts: CreatePrOptions): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-pr-'));
  const bodyFile = path.join(tmp, 'body.md');
  try {
    fs.writeFileSync(bodyFile, opts.body);
    const args = ['pr', 'create', '--title', opts.title, '--body-file', bodyFile, '--base', opts.base, '--head', opts.head];
    if (opts.draft) args.push('--draft');
    return gh(cwd, args);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
