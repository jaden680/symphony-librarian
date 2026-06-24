import { LibrarianConfig, QueueItem } from './types';
import { CurationQueue } from './queue';
import { harvestGaps } from './gaps';
import { findExistingNote } from './vault';
import { runLibrarianTopic } from './runner';
import { Logger } from '../logger';

function nowIso(): string {
  return new Date().toISOString();
}

/** Enqueue topics, skipping those already covered by an existing vault note. */
export function enqueueTopics(
  topics: string[],
  origin: QueueItem['origin'],
  cfg: LibrarianConfig,
  logger: Logger,
): number {
  const queue = new CurationQueue(cfg.queue.path);
  let added = 0;
  for (const topic of topics) {
    const t = topic.trim();
    if (t === '') continue;
    if (findExistingNote(cfg.vault.path, t)) {
      logger.info('topic_skipped', { topic: t, reason: 'note_exists' });
      continue;
    }
    if (queue.enqueue(t, origin, nowIso())) {
      added++;
      logger.info('topic_enqueued', { topic: t, origin });
    }
  }
  return added;
}

export function enqueueFromAnswers(dir: string, cfg: LibrarianConfig, logger: Logger): number {
  return enqueueTopics(harvestGaps(dir), 'gap', cfg, logger);
}

export async function drainQueue(cfg: LibrarianConfig, logger: Logger): Promise<{ processed: number; failed: number }> {
  const queue = new CurationQueue(cfg.queue.path);
  let processed = 0;
  let failed = 0;
  for (const item of queue.pending()) {
    const res = await runLibrarianTopic(item.topic, cfg, logger);
    if (res.ok) {
      queue.markDone(item.topic);
      processed++;
    } else {
      failed++;
    }
  }
  logger.info('curation_complete', { processed, failed });
  return { processed, failed };
}
