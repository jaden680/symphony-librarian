export interface QueueItem {
  topic: string;
  origin: 'bootstrap' | 'gap';
  sourceHint?: string;
  status: 'pending' | 'done';
  enqueuedAt: string;
}

export interface LibrarianConfig {
  vault: { path: string; inbox: string; taxonomy: string[] };
  reviewMode: 'draft' | 'direct';
  sources: { slack: boolean; notion: boolean };
  queue: { path: string };
  agent: { model: string; stallTimeoutMs: number };
  claude: { command: string };
  promptTemplate: string;
  configPath: string;
}
