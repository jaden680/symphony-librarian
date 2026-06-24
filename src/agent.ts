// Agent subprocess runner (Claude Code CLI) with stall detection.
//
// The configured `claude.command` is launched via `bash -lc <command>` with the
// workspace as cwd (SPEC Invariant 1). The rendered prompt is written to stdin.
// Output activity resets the stall timer; if no output is seen for
// stallTimeoutMs the process is killed and the attempt reported as stalled.

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildAgentEnv } from './env';
import { AgentResult } from './types';
import { Logger } from './logger';

export interface RunAgentOptions {
  command: string;
  workspacePath: string;
  prompt: string;
  stallTimeoutMs: number;
  /** Filename (relative to workspace) signalling a produced answer. Optional. */
  answerFile?: string;
  /** Absolute path for the agent activity log. Defaults to <workspace>/symphony-agent.log. */
  logPath?: string;
  logger: Logger;
  /** Receives the child so the caller can kill it on shutdown. */
  onSpawn?: (kill: () => void) => void;
}

const AGENT_LOG = 'symphony-agent.log';

export function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const { command, workspacePath, prompt, stallTimeoutMs, answerFile, logger } = opts;

  // SPEC Invariant 1: validate cwd == workspace_path before launch.
  const cwd = path.resolve(workspacePath);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return Promise.resolve({ kind: 'failed', exitCode: null, reason: 'workspace path missing at launch' });
  }

  return new Promise<AgentResult>((resolve) => {
    const logFile = opts.logPath ?? path.join(cwd, AGENT_LOG);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    let lastActivity = Date.now();
    let settled = false;
    let killScheduled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess;

    try {
      child = spawn('bash', ['-lc', command], {
        cwd,
        env: buildAgentEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      logStream.end();
      resolve({ kind: 'failed', exitCode: null, reason: (err as Error).message });
      return;
    }

    const kill = () => {
      if (killScheduled) return; // dedupe: a second kill() must not stack timers
      killScheduled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 3000);
      killTimer.unref(); // never let the escalation timer hold the event loop open
    };
    opts.onSpawn?.(kill);

    let logEnded = false;
    logStream.on('error', () => {
      /* ignore log write errors; the agent run must not crash on logging */
    });
    const writeLog = (d: Buffer) => {
      if (!logEnded) logStream.write(d);
    };

    const finish = (result: AgentResult) => {
      if (settled) return;
      settled = true;
      clearInterval(stallTimer);
      logEnded = true;
      logStream.end();
      // Note: killTimer (SIGKILL escalation) is intentionally NOT cleared here —
      // on a stall we resolve immediately but still want SIGKILL to fire if the
      // child ignores SIGTERM. It is cleared on 'close' once the child exits.
      resolve(result);
    };

    const touch = () => {
      lastActivity = Date.now();
    };
    child.stdout?.on('data', (d: Buffer) => {
      touch();
      writeLog(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      touch();
      writeLog(d);
    });

    // Feed the prompt via stdin (claude -p reads the prompt from stdin).
    child.stdin?.on('error', () => {
      /* ignore EPIPE if the process exits before reading */
    });
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      /* ignore */
    }

    const stallTimer = setInterval(() => {
      if (stallTimeoutMs <= 0) return; // disabled
      const elapsed = Date.now() - lastActivity;
      if (elapsed > stallTimeoutMs) {
        logger.warn('agent_stalled', { elapsed_ms: elapsed, stall_timeout_ms: stallTimeoutMs });
        kill();
        finish({ kind: 'stalled', elapsedMs: elapsed });
      }
    }, 1000);

    child.on('error', (err) => {
      finish({ kind: 'failed', exitCode: null, reason: err.message });
    });

    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer); // child exited; no SIGKILL escalation needed
      if (settled) return; // already reported as stalled
      const answerProduced = answerFile ? fs.existsSync(path.join(cwd, answerFile)) : false;
      if (code === 0) {
        finish({ kind: 'completed', exitCode: 0, answerProduced });
      } else {
        finish({ kind: 'failed', exitCode: code, reason: `agent exited with code ${code}` });
      }
    });
  });
}
