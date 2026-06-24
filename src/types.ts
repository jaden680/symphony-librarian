// Shared types for the Symphony orchestrator.

/** Fully-resolved, validated configuration used by the running orchestrator. */
export interface EffectiveConfig {
  tracker: {
    kind: string;
    endpoint: string;
    /** Resolved secret. Never log this value directly. */
    apiKey: string;
    teamKey: string;
    doneState: string;
    /** State to move an issue to when work starts (e.g. "In Progress"); empty = no start transition. */
    startState: string;
    activeStates: string[];
    terminalStates: string[];
    requiredLabels: string[];
    pollIntervalMs: number;
    /** When true, post answer.md back to the issue as a Linear comment on completion. */
    postAnswerComment: boolean;
  };
  workspace: {
    /** Absolute path. */
    root: string;
  };
  wiki: {
    /** Absolute path to an Obsidian vault, or null when wiki is disabled. */
    vaultPath: string | null;
    /** Directory name the vault is exposed as inside each workspace. */
    mountName: string;
  };
  agent: {
    maxConcurrentAgents: number;
    /** Inactivity timeout in ms; <= 0 disables stall detection. */
    stallTimeoutMs: number;
    /** Max attempts per issue per run (initial + restarts/retries). */
    maxAttempts: number;
    maxRetryBackoffMs: number;
    /** Default model token exposed to the command template as {{ model }}. */
    model: string;
    /** Model used when an issue carries any of heavyLabels. */
    heavyModel: string;
    /** Lowercased labels that route an issue to heavyModel. */
    heavyLabels: string[];
  };
  claude: {
    /** Shell command launched via `bash -lc <command>` inside the workspace. */
    command: string;
  };
  hooks: {
    afterCreate?: string;
    beforeRun?: string;
    afterRun?: string;
    timeoutMs: number;
    /** Extra env var names forwarded to hook subprocesses (deny-by-default base). */
    envPassthrough: string[];
  };
  curation: {
    /** When true, harvest the answer's "추가 확인 필요" gaps into the curation queue. */
    autoEnqueueGaps: boolean;
    /** Absolute path of the shared curation queue (consumed by the Librarian). */
    queuePath: string;
    /** >0 enables an in-process periodic Librarian drain (seconds); 0 = off. */
    autoDrainIntervalSec: number;
    /** Absolute path to LIBRARIAN.md used by the in-process drain. */
    librarianPath: string;
  };
  /** Raw prompt template body (below the YAML front matter). */
  promptTemplate: string;
  /** Absolute path of the loaded WORKFLOW.md. */
  workflowPath: string;
}

/** A normalized issue from the tracker. */
export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: string[];
  created_at: string | null;
  updated_at: string | null;
}

/** A workflow state as known by the tracker (used to resolve done_state -> id). */
export interface TrackerState {
  id: string;
  name: string;
  type: string;
}

export type WorkerStatus = 'claimed' | 'running';

export interface WorkerHandle {
  issue: Issue;
  status: WorkerStatus;
  /** Set while an agent subprocess is alive so we can kill it on shutdown. */
  kill?: () => void;
}

/** Outcome of a single agent attempt. */
export type AgentResult =
  | { kind: 'completed'; exitCode: 0; answerProduced: boolean }
  | { kind: 'failed'; exitCode: number | null; reason: string }
  | { kind: 'stalled'; elapsedMs: number };
