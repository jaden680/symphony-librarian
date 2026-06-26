// Ticket classification: dev vs answer, and which repo.
//
// Hybrid: a routing label decides cheaply and deterministically; only when no
// label is decisive do we run the lightweight LLM classifier. Anything uncertain
// falls back to "answer" (the safe, read-only path).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DevConfig, DevRepo } from './types';
import { Issue } from '../types';
import { Logger } from '../logger';
import { render } from '../template';
import { runAgent } from '../agent';

export type Mode = 'dev' | 'answer';

/**
 * Decide mode from labels alone. A `dev` label takes precedence (explicit "do
 * work" intent); then an `answer` label; otherwise null (undecided → caller asks
 * the classifier).
 */
export function classifyByLabels(labels: string[], devLabels: string[], answerLabels: string[]): Mode | null {
  const set = new Set(labels.map((l) => l.trim().toLowerCase()));
  if (devLabels.some((l) => set.has(l))) return 'dev';
  if (answerLabels.some((l) => set.has(l))) return 'answer';
  return null;
}

/** First repo whose routing labels intersect the issue labels, else null. */
export function selectRepoByLabels(labels: string[], repos: DevRepo[]): DevRepo | null {
  const set = new Set(labels.map((l) => l.trim().toLowerCase()));
  for (const repo of repos) {
    if (repo.labels.some((l) => set.has(l))) return repo;
  }
  return null;
}

/** Map a classifier-returned repo name to a configured repo (case-insensitive). */
export function findRepoByName(name: string | null | undefined, repos: DevRepo[]): DevRepo | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return repos.find((r) => r.name.trim().toLowerCase() === n) ?? null;
}

/**
 * Run the lightweight LLM classifier in a throwaway dir. Returns the parsed
 * decision, or null on any failure (caller treats null as "answer").
 */
export async function runClassifier(
  issue: Issue,
  devCfg: DevConfig,
  model: string,
  logger: Logger,
): Promise<{ mode: Mode; repoName: string | null } | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-classify-'));
  try {
    const repoNames = devCfg.repos.map((r) => r.name).join(', ') || '(none)';
    const prompt =
      `당신은 이슈 분류기입니다. 아래 이슈가 "코드를 직접 수정/구현해야 하는 개발 작업(dev)"인지 ` +
      `"질문에 답하면 되는 작업(answer)"인지 판단하세요. 또한 dev라면 어느 레포인지 고르세요.\n\n` +
      `가능한 레포: ${repoNames}\n\n` +
      `이슈 ${issue.identifier}: ${issue.title}\n${issue.description ?? ''}\n\n` +
      `오직 아래 형식의 JSON 한 줄을 파일 decision.json 에 쓰세요(설명 금지):\n` +
      `{"mode":"dev"|"answer","repo":"<레포명 또는 null>"}`;
    let command: string;
    try {
      command = render(devCfg.classifierCommand, { issue, model }, { shellEscape: true });
    } catch (err) {
      logger.warn('classify_render_failed', { detail: (err as Error).message });
      return null;
    }
    const result = await runAgent({
      command,
      workspacePath: dir,
      prompt,
      stallTimeoutMs: 120_000,
      logPath: path.join(dir, 'classify.log'),
      logger,
    });
    if (result.kind !== 'completed') {
      logger.warn('classify_agent_failed', { reason: result.kind });
      return null;
    }
    const raw = fs.readFileSync(path.join(dir, 'decision.json'), 'utf8');
    const json = JSON.parse(extractJson(raw)) as { mode?: string; repo?: string | null };
    const mode: Mode = json.mode === 'dev' ? 'dev' : 'answer';
    const repoName = typeof json.repo === 'string' && json.repo.toLowerCase() !== 'null' ? json.repo : null;
    return { mode, repoName };
  } catch (err) {
    logger.warn('classify_failed', { detail: (err as Error).message });
    return null;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Tolerantly extract the first {...} JSON object from a string. */
function extractJson(s: string): string {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}
