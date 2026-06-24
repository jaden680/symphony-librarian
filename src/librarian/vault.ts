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
