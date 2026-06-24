// Environment construction for child processes.
//
// Safety constraints (from the work order):
//  - The AGENT subprocess must NOT inherit unnecessary environment variables.
//  - ANTHROPIC_API_KEY must never reach a child (subscription auth only; a stray
//    key would switch Claude Code to metered billing on a long-running loop).
//  - LINEAR_API_KEY is held by the orchestrator and must not leak to children.

const SENSITIVE = ['ANTHROPIC_API_KEY', 'LINEAR_API_KEY'];

/**
 * Minimal allow-listed environment for the agent subprocess. Only variables the
 * Claude Code CLI plausibly needs to locate its subscription credentials and run
 * are passed through.
 */
export function buildAgentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const allow = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'TERM',
    'TMPDIR',
    'TZ',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
  ];
  const env: Record<string, string> = {};
  for (const key of allow) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  // Pass through locale and Claude-specific configuration only.
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('LC_') || key.startsWith('CLAUDE_')) env[key] = value;
  }
  Object.assign(env, extra);
  for (const key of SENSITIVE) delete env[key];
  return env;
}

/**
 * Environment for orchestrator-run hook scripts (e.g. `gh repo clone`). Hooks
 * need git/gh auth, so the allow-list is broader than the agent's — but it is
 * still deny-by-default rather than inheriting the entire parent environment.
 * Operators can widen it explicitly via `hooks.env_passthrough` in WORKFLOW.md.
 *
 * @param extra      issue-derived vars (SYMPHONY_ISSUE_*) the hook can reference safely.
 * @param passthrough additional env var names the operator opted to forward.
 */
export function buildHookEnv(
  extra: Record<string, string> = {},
  passthrough: string[] = [],
): NodeJS.ProcessEnv {
  const allow = [
    // base runtime
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'TERM',
    'TMPDIR',
    'TZ',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    // git / gh / ssh auth needed by clone hooks
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_HOST',
    'GH_CONFIG_DIR',
    'GH_ENTERPRISE_TOKEN',
    'SSH_AUTH_SOCK',
    'SSH_AGENT_PID',
    // network proxies
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ];
  const env: Record<string, string> = {};
  for (const key of allow) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  // Locale and git config conveyed via environment.
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('LC_') || key.startsWith('GIT_')) env[key] = value;
  }
  // Operator-opted passthrough.
  for (const key of passthrough) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  Object.assign(env, extra);
  for (const key of SENSITIVE) delete env[key];
  return env;
}
