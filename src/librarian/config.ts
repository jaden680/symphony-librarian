import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { LibrarianConfig } from './types';

/** Expand a leading `~`/`~/` to the home dir, then resolve relative to `dir`. */
function resolveHome(dir: string, raw: string): string {
  const p = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(dir, p);
}

export class LibrarianConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibrarianConfigError';
  }
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function resolveEnvTokens(value: unknown): unknown {
  if (typeof value === 'string') {
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
    if (m) return process.env[m[1]] ?? '';
    return value;
  }
  if (Array.isArray(value)) return value.map(resolveEnvTokens);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveEnvTokens(v);
    return out;
  }
  return value;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asString(v: unknown, fb = ''): string {
  return v === null || v === undefined ? fb : String(v);
}
function asInt(v: unknown, fb: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.trunc(Number(v));
  return fb;
}
function asBool(v: unknown, fb: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off', ''].includes(s)) return false;
  }
  return fb;
}
function asStringList(v: unknown, fb: string[]): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x !== '');
  return fb;
}

export function loadLibrarianConfig(filePath: string): LibrarianConfig {
  const abs = path.resolve(filePath);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new LibrarianConfigError(`cannot read ${abs}: ${(err as Error).message}`);
  }
  const m = FRONT_MATTER_RE.exec(raw);
  if (!m) throw new LibrarianConfigError('LIBRARIAN.md must start with a YAML front-matter block');
  let parsed: unknown;
  try {
    parsed = YAML.parse(m[1]);
  } catch (err) {
    throw new LibrarianConfigError(`invalid YAML: ${(err as Error).message}`);
  }
  const cfg = asObject(resolveEnvTokens(parsed));
  const dir = path.dirname(abs);

  const vault = asObject(cfg.vault);
  const sources = asObject(cfg.sources);
  const queue = asObject(cfg.queue);
  const agent = asObject(cfg.agent);
  const claude = asObject(cfg.claude);

  const vaultPathRaw = asString(vault.path, '').trim();
  const reviewMode = asString(cfg.review_mode, 'draft').trim() === 'direct' ? 'direct' : 'draft';

  const effective: LibrarianConfig = {
    vault: {
      path: vaultPathRaw === '' ? '' : resolveHome(dir, vaultPathRaw),
      inbox: asString(vault.inbox, '_inbox').trim() || '_inbox',
      taxonomy: asStringList(vault.taxonomy, ['decisions', 'domain-rules', 'integrations', 'glossary']),
    },
    reviewMode,
    sources: { slack: asBool(sources.slack, true), notion: asBool(sources.notion, true) },
    queue: { path: resolveHome(dir, asString(queue.path, '.symphony/curation_queue.jsonl')) },
    agent: {
      model: asString(agent.model, 'sonnet').trim() || 'sonnet',
      stallTimeoutMs: Math.max(1000, asInt(agent.stall_timeout_ms, 600_000)),
    },
    claude: { command: asString(claude.command, '').trim() },
    promptTemplate: (m[2] ?? '').trim(),
    configPath: abs,
  };

  const problems: string[] = [];
  if (!effective.vault.path) problems.push('vault.path is required');
  if (!effective.claude.command) problems.push('claude.command is empty');
  if (!effective.promptTemplate) problems.push('prompt template (below front matter) is empty');
  if (problems.length) throw new LibrarianConfigError(`invalid config:\n  - ${problems.join('\n  - ')}`);

  return effective;
}
