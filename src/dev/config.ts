// DEV.md loading + validation (mirrors LIBRARIAN.md). Front matter holds the dev
// execution config; the body below is the dev prompt template.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { DevConfig, DevRepo } from './types';

export class DevConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevConfigError';
  }
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function resolveHome(dir: string, raw: string): string {
  const p = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(dir, p);
}

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
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
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

export function loadDevConfig(filePath: string): DevConfig {
  const abs = path.resolve(filePath);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new DevConfigError(`cannot read ${abs}: ${(err as Error).message}`);
  }
  const m = FRONT_MATTER_RE.exec(raw);
  if (!m) throw new DevConfigError('DEV.md must start with a YAML front-matter block');
  let parsed: unknown;
  try {
    parsed = YAML.parse(m[1]);
  } catch (err) {
    throw new DevConfigError(`invalid YAML: ${(err as Error).message}`);
  }
  const cfg = asObject(resolveEnvTokens(parsed));
  const dir = path.dirname(abs);

  const classifier = asObject(cfg.classifier);
  const pr = asObject(cfg.pr);
  const agent = asObject(cfg.agent);
  const claude = asObject(cfg.claude);

  const repos: DevRepo[] = asArray(cfg.repos).map((r) => {
    const o = asObject(r);
    return {
      name: asString(o.name, '').trim(),
      path: resolveHome(dir, asString(o.path, '').trim()),
      labels: asStringList(o.labels, []).map((l) => l.toLowerCase()),
      base: asString(o.base, '').trim(),
      verify: asString(o.verify, '').trim(),
    };
  });

  const effective: DevConfig = {
    classifierCommand: asString(classifier.command, '').trim(),
    repos,
    worktreeRoot: resolveHome(dir, asString(cfg.worktree_root, './symphony_worktrees').trim() || './symphony_worktrees'),
    prDraft: asBool(pr.draft, true),
    stripPatterns: asStringList(pr.strip_patterns, []),
    stallTimeoutMs: Math.max(1000, asInt(agent.stall_timeout_ms, 1_800_000)),
    command: asString(claude.command, '').trim(),
    promptTemplate: (m[2] ?? '').trim(),
    configPath: abs,
  };

  const problems: string[] = [];
  if (effective.repos.length === 0) problems.push('at least one repo is required under repos:');
  for (const r of effective.repos) {
    if (!r.name) problems.push('a repo is missing name');
    if (!r.path) problems.push(`repo "${r.name}" is missing path`);
  }
  if (!effective.command) problems.push('claude.command is empty');
  if (!effective.promptTemplate) problems.push('prompt template (below front matter) is empty');
  if (problems.length) throw new DevConfigError(`invalid DEV.md:\n  - ${problems.join('\n  - ')}`);

  return effective;
}
