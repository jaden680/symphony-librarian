// Per-issue workspace creation with SPEC path-safety invariants.
//
//   Invariant 2: workspace path MUST stay inside workspace root (prefix check).
//   Invariant 3: workspace key uses only [A-Za-z0-9._-]; others become "_".
//
// (Invariant 1 — cwd == workspace_path before launch — is enforced in agent.ts.)

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/** Invariant 3: sanitize a tracker identifier into a safe directory name. */
export function sanitizeKey(identifier: string): string {
  const cleaned = identifier.replace(/[^A-Za-z0-9._-]/g, '_');
  // Guard against empty / dot-only names that could escape or collide.
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '_';
  return cleaned;
}

/** Derive and containment-check the absolute workspace path for an issue. */
export function resolveWorkspacePath(root: string, identifier: string): string {
  const absRoot = path.resolve(root);
  const key = sanitizeKey(identifier);
  const candidate = path.resolve(absRoot, key);
  // Invariant 2: candidate must be a direct child contained under the root.
  const rootWithSep = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (!(candidate + path.sep).startsWith(rootWithSep) && candidate !== absRoot) {
    throw new WorkspaceError(`workspace path "${candidate}" escapes root "${absRoot}"`);
  }
  if (candidate === absRoot) {
    throw new WorkspaceError(`workspace path resolved to the root itself for identifier "${identifier}"`);
  }
  return candidate;
}

export interface PreparedWorkspace {
  path: string;
  createdNow: boolean;
}

/** Create the workspace directory if missing. Returns createdNow=true only when newly created. */
export function ensureWorkspace(root: string, identifier: string): PreparedWorkspace {
  fs.mkdirSync(path.resolve(root), { recursive: true });
  const wsPath = resolveWorkspacePath(root, identifier);
  let createdNow = false;
  if (!fs.existsSync(wsPath)) {
    fs.mkdirSync(wsPath, { recursive: true });
    createdNow = true;
  }
  return { path: wsPath, createdNow };
}

/**
 * Expose the read-only Obsidian vault inside the workspace as a symlink. The
 * vault target is never modified; only the link is (idempotently) created.
 */
export function ensureWikiMount(
  workspacePath: string,
  vaultPath: string | null,
  mountName: string,
  logger: Logger,
): void {
  if (!vaultPath) return;
  if (!fs.existsSync(vaultPath)) {
    logger.warn('wiki_vault_missing', { vault_path: vaultPath });
    return;
  }
  const linkPath = path.join(workspacePath, mountName);
  try {
    const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false } as fs.StatOptions) as fs.Stats | undefined;
    if (stat) {
      if (stat.isSymbolicLink()) return; // already mounted
      logger.warn('wiki_mount_conflict', { link_path: linkPath });
      return;
    }
    fs.symlinkSync(vaultPath, linkPath, 'dir');
    logger.info('wiki_mounted', { link_path: linkPath, vault_path: vaultPath });
  } catch (err) {
    logger.warn('wiki_mount_failed', { error: (err as Error).message });
  }
}
