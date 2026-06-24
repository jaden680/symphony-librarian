// Workspace hook execution with timeout (SPEC Section: Workspace Hooks).
//
// Hooks run via `bash -lc <script>` in the workspace directory. `{{ ... }}`
// placeholders are rendered before execution; shell constructs like `$(date)`
// are left for bash to evaluate. Failure semantics are decided by the caller.

import { spawn } from 'child_process';
import { render } from './template';
import { buildHookEnv } from './env';
import { Logger } from './logger';
import { Issue } from './types';

export interface HookResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  reason?: string;
}

/** Derive shell-safe SYMPHONY_ISSUE_* env vars from the render context's issue. */
function issueEnv(context: Record<string, unknown>): Record<string, string> {
  const issue = context.issue as Issue | undefined;
  if (!issue) return {};
  return {
    SYMPHONY_ISSUE_ID: issue.id ?? '',
    SYMPHONY_ISSUE_IDENTIFIER: issue.identifier ?? '',
    SYMPHONY_ISSUE_TITLE: issue.title ?? '',
    SYMPHONY_ISSUE_DESCRIPTION: issue.description ?? '',
    SYMPHONY_ISSUE_STATE: issue.state ?? '',
    SYMPHONY_ISSUE_URL: issue.url ?? '',
    SYMPHONY_ISSUE_BRANCH: issue.branch_name ?? '',
    SYMPHONY_ISSUE_PRIORITY: issue.priority === null || issue.priority === undefined ? '' : String(issue.priority),
  };
}

/**
 * Run a hook script. Returns the outcome; never throws. The caller logs/handles
 * failure according to the hook type's documented semantics.
 */
export function runHook(
  name: string,
  script: string | undefined,
  workspacePath: string,
  context: Record<string, unknown>,
  timeoutMs: number,
  logger: Logger,
  envPassthrough: string[] = [],
): Promise<HookResult> {
  if (!script || script.trim() === '') {
    return Promise.resolve({ ok: true, code: 0, timedOut: false });
  }

  let rendered: string;
  try {
    // shellEscape: any `{{ issue.* }}` value is single-quote escaped so untrusted
    // tracker text cannot inject shell. Operators should prefer the
    // $SYMPHONY_ISSUE_* env vars below for issue data in hooks.
    rendered = render(script, context, { shellEscape: true });
  } catch (err) {
    logger.error('hook_render_failed', { hook: name, error: (err as Error).message });
    return Promise.resolve({ ok: false, code: null, timedOut: false, reason: 'render_failed' });
  }

  logger.info('hook_started', { hook: name });
  return new Promise<HookResult>((resolve) => {
    const child = spawn('bash', ['-lc', rendered], {
      cwd: workspacePath,
      env: buildHookEnv(issueEnv(context), envPassthrough),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const finish = (result: HookResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      logger.error('hook_timeout', { hook: name, timeout_ms: timeoutMs });
      finish({ ok: false, code: null, timedOut: true, reason: 'timeout' });
    }, timeoutMs);

    let stderr = '';
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString();
    });

    child.on('error', (err) => {
      logger.error('hook_failed', { hook: name, error: err.message });
      finish({ ok: false, code: null, timedOut: false, reason: err.message });
    });

    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, code: 0, timedOut: false });
      } else {
        logger.error('hook_failed', { hook: name, code, stderr: stderr.trim().slice(0, 500) });
        finish({ ok: false, code, timedOut: false, reason: `exit ${code}` });
      }
    });
  });
}
