// WORKFLOW.md loading, parsing, validation, and dynamic reload.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { EffectiveConfig } from './types';
import { Logger } from './logger';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const DEFAULTS = {
  endpoint: 'https://api.linear.app/graphql',
  doneState: 'Done',
  activeStates: ['Todo', 'In Progress'],
  terminalStates: ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'],
  pollIntervalMs: 10_000,
  maxConcurrentAgents: 1,
  stallTimeoutMs: 600_000,
  maxAttempts: 3,
  maxRetryBackoffMs: 300_000,
  hookTimeoutMs: 60_000,
  wikiMountName: 'wiki',
  claudeCommand: 'claude -p --permission-mode dontAsk --output-format stream-json --verbose',
};

/** Replace standalone `$VAR_NAME` string tokens with the corresponding env value. */
function resolveEnvTokens(value: unknown): unknown {
  if (typeof value === 'string') {
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
    if (m) {
      const envVal = process.env[m[1]];
      return envVal === undefined ? '' : envVal;
    }
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

function asStringList(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x.length > 0);
  return fallback;
}

function asInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.trunc(Number(v));
  return fallback;
}

function asString(v: unknown, fallback = ''): string {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

/** Expand a leading `~` / `~/` to the user's home directory (path.resolve does not). */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolve a config path: expand `~`, then resolve relative to the WORKFLOW.md dir. */
function resolvePath(workflowDir: string, raw: string): string {
  return path.resolve(workflowDir, expandHome(raw));
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off', ''].includes(s)) return false;
  }
  return fallback;
}

/** Parse + validate the WORKFLOW.md at the given path. Throws ConfigError on fatal issues. */
export function loadConfig(workflowPath: string): EffectiveConfig {
  const abs = path.resolve(workflowPath);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read workflow file at ${abs}: ${(err as Error).message}`);
  }

  const m = FRONT_MATTER_RE.exec(raw);
  if (!m) {
    throw new ConfigError('WORKFLOW.md must begin with a YAML front-matter block delimited by `---` lines');
  }
  const frontMatterText = m[1];
  const promptTemplate = (m[2] ?? '').trim();

  let parsed: unknown;
  try {
    parsed = YAML.parse(frontMatterText);
  } catch (err) {
    throw new ConfigError(`invalid YAML front matter: ${(err as Error).message}`);
  }
  const cfg = asObject(resolveEnvTokens(parsed));

  const tracker = asObject(cfg.tracker);
  const workspace = asObject(cfg.workspace);
  const wiki = asObject(cfg.wiki);
  const agent = asObject(cfg.agent);
  const claude = asObject(cfg.claude);
  const codex = asObject(cfg.codex); // tolerate SPEC-style keys
  const polling = asObject(cfg.polling);
  const hooks = asObject(cfg.hooks);
  const curation = asObject(cfg.curation);
  const followups = asObject(cfg.followups);
  const dev = asObject(cfg.dev);

  const workflowDir = path.dirname(abs);

  // --- workspace root: absolute, or relative to the WORKFLOW.md directory ---
  const rawRoot = asString(workspace.root, './symphony_workspaces');
  const workspaceRoot = resolvePath(workflowDir, rawRoot);

  // --- wiki vault: optional; empty/absent => disabled ---
  const rawVault = asString(wiki.vault_path, '').trim();
  const vaultPath = rawVault === '' ? null : resolvePath(workflowDir, rawVault);

  // --- poll interval: poll_interval_sec (user schema) > polling.interval_ms (SPEC) ---
  let pollIntervalMs = DEFAULTS.pollIntervalMs;
  if (tracker.poll_interval_sec !== undefined) {
    pollIntervalMs = asInt(tracker.poll_interval_sec, 10) * 1000;
  } else if (polling.interval_ms !== undefined) {
    pollIntervalMs = asInt(polling.interval_ms, DEFAULTS.pollIntervalMs);
  }
  if (pollIntervalMs < 1000) pollIntervalMs = 1000;

  // --- stall timeout: agent.stall_timeout_ms (user) > codex.stall_timeout_ms (SPEC) ---
  let stallTimeoutMs = DEFAULTS.stallTimeoutMs;
  if (agent.stall_timeout_ms !== undefined) stallTimeoutMs = asInt(agent.stall_timeout_ms, DEFAULTS.stallTimeoutMs);
  else if (codex.stall_timeout_ms !== undefined) stallTimeoutMs = asInt(codex.stall_timeout_ms, DEFAULTS.stallTimeoutMs);

  // --- agent command: claude.command (user) > codex.command (SPEC) > default ---
  const command = asString(claude.command, '').trim() || asString(codex.command, '').trim() || DEFAULTS.claudeCommand;

  const effective: EffectiveConfig = {
    tracker: {
      kind: asString(tracker.kind, '').trim().toLowerCase(),
      endpoint: asString(tracker.endpoint, DEFAULTS.endpoint).trim() || DEFAULTS.endpoint,
      apiKey: asString(tracker.api_key, '').trim(),
      teamKey: asString(tracker.team_key ?? tracker.project_slug, '').trim(),
      doneState: asString(tracker.done_state, DEFAULTS.doneState).trim() || DEFAULTS.doneState,
      startState: asString(tracker.start_state ?? tracker.in_progress_state, '').trim(),
      activeStates: asStringList(tracker.active_states, DEFAULTS.activeStates),
      terminalStates: asStringList(tracker.terminal_states, DEFAULTS.terminalStates),
      requiredLabels: asStringList(tracker.required_labels, []).map((l) => l.toLowerCase()),
      pollIntervalMs,
      reopenGraceMs: Math.max(0, asInt(tracker.reopen_grace_sec, 30)) * 1000,
      postAnswerComment: asBool(tracker.post_answer_comment, false),
    },
    workspace: { root: workspaceRoot },
    wiki: { vaultPath, mountName: asString(wiki.mount_name, DEFAULTS.wikiMountName).trim() || DEFAULTS.wikiMountName },
    agent: {
      maxConcurrentAgents: Math.max(1, asInt(agent.max_concurrent_agents, DEFAULTS.maxConcurrentAgents)),
      stallTimeoutMs,
      maxAttempts: Math.max(1, asInt(agent.max_attempts, DEFAULTS.maxAttempts)),
      maxRetryBackoffMs: Math.max(1000, asInt(agent.max_retry_backoff_ms, DEFAULTS.maxRetryBackoffMs)),
      model: asString(agent.model, 'sonnet').trim() || 'sonnet',
      heavyModel: asString(agent.heavy_model, 'opus').trim() || 'opus',
      heavyLabels: asStringList(agent.heavy_labels, []).map((l) => l.toLowerCase()),
    },
    claude: { command },
    followups: {
      enabled: asBool(followups.enabled, false),
      statePath: resolvePath(workflowDir, asString(followups.state_path, '.symphony/followups.json')),
    },
    dev: {
      enabled: asBool(dev.enabled, false),
      path: resolvePath(workflowDir, asString(dev.path, 'DEV.md')),
      devLabels: asStringList(dev.dev_labels, ['dev', 'feature', 'bug', 'fix']).map((l) => l.toLowerCase()),
      answerLabels: asStringList(dev.answer_labels, ['question', 'answer', 'docs']).map((l) => l.toLowerCase()),
      doneState: asString(dev.done_state, 'In Review').trim() || 'In Review',
    },
    curation: {
      autoEnqueueGaps: asBool(curation.auto_enqueue_gaps, false),
      queuePath: resolvePath(workflowDir, asString(curation.queue_path, '.symphony/curation_queue.jsonl')),
      autoDrainIntervalSec: Math.max(0, asInt(curation.auto_drain_interval_sec, 0)),
      librarianPath: resolvePath(workflowDir, asString(curation.librarian_path, 'LIBRARIAN.md')),
    },
    hooks: {
      afterCreate: optionalScript(hooks.after_create),
      beforeRun: optionalScript(hooks.before_run),
      afterRun: optionalScript(hooks.after_run),
      timeoutMs: Math.max(1000, asInt(hooks.timeout_ms, DEFAULTS.hookTimeoutMs)),
      envPassthrough: asStringList(hooks.env_passthrough, []),
    },
    promptTemplate,
    workflowPath: abs,
  };

  validate(effective);
  return effective;
}

function optionalScript(v: unknown): string | undefined {
  const s = asString(v, '').trim();
  return s === '' ? undefined : asString(v);
}

/** Startup / dispatch-preflight validation (SPEC Section 6.3). */
export function validate(cfg: EffectiveConfig): void {
  const problems: string[] = [];
  if (cfg.tracker.kind !== 'linear') {
    problems.push(`tracker.kind must be "linear" (got "${cfg.tracker.kind || '<missing>'}")`);
  }
  if (!cfg.tracker.apiKey) {
    problems.push('tracker.api_key is missing — set the LINEAR_API_KEY environment variable');
  }
  if (!cfg.tracker.teamKey) {
    problems.push('tracker.team_key is missing');
  }
  if (!cfg.claude.command) {
    problems.push('claude.command (agent command) is empty');
  }
  if (!cfg.promptTemplate) {
    problems.push('prompt template (body below the front matter) is empty');
  }
  if (problems.length > 0) {
    throw new ConfigError(`configuration is invalid:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * Holds the current effective config and reloads it when WORKFLOW.md changes.
 * On an invalid reload it keeps the last-known-good config and logs an error
 * (SPEC: "Invalid reloads MUST NOT crash the service").
 */
export class ConfigStore {
  private cfg: EffectiveConfig;
  private watcher?: fs.FSWatcher;
  private reloadTimer?: NodeJS.Timeout;

  constructor(private readonly workflowPath: string, private readonly logger: Logger) {
    this.cfg = loadConfig(workflowPath);
    this.logger.addSecret(this.cfg.tracker.apiKey);
  }

  get current(): EffectiveConfig {
    return this.cfg;
  }

  /** Re-read the file immediately; returns true on success, false if kept last-good. */
  reload(reason: string): boolean {
    try {
      const next = loadConfig(this.workflowPath);
      this.cfg = next;
      this.logger.addSecret(next.tracker.apiKey);
      this.logger.info('config_reloaded', { reason });
      return true;
    } catch (err) {
      this.logger.error('config_reload_failed', { reason, error: (err as Error).message });
      return false;
    }
  }

  /** Start watching the file for changes (debounced). */
  watch(): void {
    try {
      this.watcher = fs.watch(this.cfg.workflowPath, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.reload('file_changed'), 250);
      });
    } catch (err) {
      this.logger.warn('config_watch_failed', { error: (err as Error).message });
    }
  }

  stop(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.close();
  }
}
