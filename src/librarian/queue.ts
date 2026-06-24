import * as fs from 'fs';
import * as path from 'path';
import { QueueItem } from './types';

export class CurationQueue {
  constructor(private readonly filePath: string) {}

  private readAll(): QueueItem[] {
    if (!fs.existsSync(this.filePath)) return [];
    return fs
      .readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as QueueItem);
  }

  private writeAll(items: QueueItem[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
  }

  /** Enqueue a topic unless an identical pending topic exists. Returns true if added. */
  enqueue(topic: string, origin: QueueItem['origin'], enqueuedAt: string, sourceHint?: string): boolean {
    const t = topic.trim();
    if (t === '') return false;
    const items = this.readAll();
    if (items.some((i) => i.status === 'pending' && i.topic.toLowerCase() === t.toLowerCase())) return false;
    items.push({ topic: t, origin, status: 'pending', enqueuedAt, ...(sourceHint ? { sourceHint } : {}) });
    this.writeAll(items);
    return true;
  }

  pending(): QueueItem[] {
    return this.readAll().filter((i) => i.status === 'pending');
  }

  markDone(topic: string): void {
    const t = topic.toLowerCase();
    const items = this.readAll();
    // Case-insensitive match, consistent with enqueue()'s dedup comparison.
    for (const i of items) if (i.topic.toLowerCase() === t && i.status === 'pending') i.status = 'done';
    this.writeAll(items);
  }
}
