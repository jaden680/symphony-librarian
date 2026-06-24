#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger';
import { loadLibrarianConfig, LibrarianConfigError } from './config';
import { enqueueTopics, enqueueFromAnswers, drainQueue } from './curate';

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const logger = new Logger({ level: 'info' });

  const workflowPath = path.resolve(arg(argv, '--librarian') ?? 'LIBRARIAN.md');
  let cfg;
  try {
    cfg = loadLibrarianConfig(workflowPath);
  } catch (err) {
    logger.error('startup_failed', { error: (err as LibrarianConfigError).message });
    process.exitCode = 1;
    return;
  }

  const topics = arg(argv, '--topics');
  const topicsFile = arg(argv, '--topics-file');
  const fromAnswers = arg(argv, '--from-answers');

  if (topics) enqueueTopics(topics.split(',').map((t) => t.trim()).filter(Boolean), 'bootstrap', cfg, logger);
  if (topicsFile) {
    const lines = fs.readFileSync(path.resolve(topicsFile), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    enqueueTopics(lines, 'bootstrap', cfg, logger);
  }
  if (fromAnswers) enqueueFromAnswers(path.resolve(fromAnswers), cfg, logger);

  await drainQueue(cfg, logger);
}

void main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
