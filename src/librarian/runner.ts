import * as fs from 'fs';
import * as path from 'path';
import { LibrarianConfig } from './types';
import { resolveVaultPath } from './vault';
import { Logger } from '../logger';
import { render } from '../template';
import { runAgent } from '../agent';

// Snapshot of note path -> mtime, used to detect created/updated notes. Note:
// on filesystems with coarse (1s) mtime granularity a same-tick update may be
// reported as no-change; this affects logging only (the note is still written).
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
  // Containment: the inbox name is config-derived — resolveVaultPath rejects any
  // value (e.g. "../escape") that would land outside the vault root. The agent's
  // own writes are contained by cwd=vault + allowedTools (no Bash → no deletion).
  if (cfg.reviewMode === 'draft') fs.mkdirSync(resolveVaultPath(vaultRoot, cfg.vault.inbox), { recursive: true });

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
