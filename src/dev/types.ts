// Types for dev mode (write code → Draft PR).

export interface DevRepo {
  /** Display name and worktree subdir (e.g. "app-ios"). */
  name: string;
  /** Absolute path to the local git repo the worktree is created from. */
  path: string;
  /** Lowercased labels that route a ticket to this repo. */
  labels: string[];
  /** Base branch to branch from; empty = the repo's default branch. */
  base: string;
  /** Optional verify command run in the worktree before the PR; empty = skip. */
  verify: string;
}

export interface DevConfig {
  /** Command for the lightweight classifier (no tools; emits decision JSON). */
  classifierCommand: string;
  repos: DevRepo[];
  /** Absolute dir where per-ticket worktrees are created. */
  worktreeRoot: string;
  /** Open PRs as Draft. */
  prDraft: boolean;
  /** Regex line patterns stripped from commit messages + PR bodies. */
  stripPatterns: string[];
  /** Inactivity timeout (ms) for the dev agent. */
  stallTimeoutMs: number;
  /** Dev agent command template (uses {{ model }}). */
  command: string;
  /** Dev prompt template (body below the front matter). */
  promptTemplate: string;
  /** Absolute path of the loaded DEV.md. */
  configPath: string;
}

/** Outcome of running the dev pipeline for one ticket. */
export type DevResult =
  | { ok: true; prUrl: string; branch: string; repo: string; updated: boolean; title: string }
  | { ok: false; reason: string };
