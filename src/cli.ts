#!/usr/bin/env node
// Symphony orchestrator CLI entry point.
//
//   node dist/cli.js --workflow WORKFLOW.md
//   npm start
//
// Stop with Ctrl-C (SIGINT) or SIGTERM — running agents are terminated cleanly.

import * as path from 'path';
import { Logger } from './logger';
import { ConfigStore, ConfigError } from './config';
import { Orchestrator } from './orchestrator';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

interface CliArgs {
  workflow: string;
  level: LogLevel;
  /** The raw value supplied if it was not a recognized level (for a warning). */
  invalidLevel?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let workflow = 'WORKFLOW.md';
  let level: LogLevel = 'info';
  let invalidLevel: string | undefined;
  const setLevel = (v: string | undefined) => {
    if (v === undefined) return;
    if ((LOG_LEVELS as string[]).includes(v)) level = v as LogLevel;
    else invalidLevel = v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workflow' || a === '-w') {
      workflow = argv[++i] ?? workflow;
    } else if (a.startsWith('--workflow=')) {
      workflow = a.slice('--workflow='.length);
    } else if (a === '--log-level') {
      setLevel(argv[++i]);
    } else if (a.startsWith('--log-level=')) {
      setLevel(a.slice('--log-level='.length));
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return { workflow, level, invalidLevel };
}

function printHelp(): void {
  process.stdout.write(
    [
      'Symphony orchestrator — read-only codebase + Obsidian wiki Q&A',
      '',
      'Usage: node dist/cli.js [--workflow <path>] [--log-level <level>]',
      '',
      'Options:',
      '  -w, --workflow <path>   Path to WORKFLOW.md (default: ./WORKFLOW.md)',
      '      --log-level <level>  debug | info | warn | error (default: info)',
      '  -h, --help               Show this help',
      '',
      'Environment:',
      '  LINEAR_API_KEY   Required. Linear personal API key.',
      '  ANTHROPIC_API_KEY  Must be UNSET (subscription auth only).',
      '',
    ].join('\n') + '\n',
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = new Logger({ level: args.level });
  if (args.invalidLevel) {
    logger.warn('invalid_log_level', {
      supplied: args.invalidLevel,
      using: args.level,
      allowed: LOG_LEVELS,
    });
  }

  // Subscription-auth safety: a present ANTHROPIC_API_KEY would switch the agent
  // to uncapped metered billing on a long-running loop. Warn the operator loudly.
  if (process.env.ANTHROPIC_API_KEY) {
    logger.warn('anthropic_api_key_present', {
      hint: 'ANTHROPIC_API_KEY is set in the orchestrator environment; it is stripped from agent subprocesses, but you should `unset ANTHROPIC_API_KEY` to guarantee subscription auth.',
    });
  }

  let store: ConfigStore;
  try {
    store = new ConfigStore(path.resolve(args.workflow), logger);
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error('startup_failed', { error: err.message });
    } else {
      logger.error('startup_failed', { error: (err as Error).message });
    }
    process.exitCode = 1;
    return;
  }

  const orchestrator = new Orchestrator(store, logger);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutdown_signal', { signal });
    orchestrator.stop();
    // Give in-flight kills a moment, then exit.
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await orchestrator.start();
}

void main().catch((err) => {
  // Last-resort guard; structured where possible.
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
