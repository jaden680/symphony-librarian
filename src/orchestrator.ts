// The orchestrator loop: poll Linear, dispatch eligible issues to isolated
// workspaces, run the agent, produce answer.md, and move issues to done_state.
//
// Idempotency / single-authority: all state mutations happen on the Node event
// loop. Ticks never overlap (recursive setTimeout, awaited). dispatch() claims an
// issue synchronously before any await, so the next tick cannot double-dispatch.

import * as fs from 'fs';
import { ConfigStore } from './config';
import { LinearClient, LinearError } from './linear';
import { Logger } from './logger';
import { Issue, TrackerState, WorkerHandle } from './types';
import { ensureWorkspace, ensureWikiMount } from './workspace';
import { runHook } from './hooks';
import { runAgent } from './agent';
import { render } from './template';
import { parseGaps } from './librarian/gaps';
import { CurationQueue } from './librarian/queue';
import { findExistingNote } from './librarian/vault';
import { loadLibrarianConfig } from './librarian/config';
import { drainQueue } from './librarian/curate';
import { FollowupStore } from './followups';
import { CommentInfo } from './types';
import { loadDevConfig } from './dev/config';
import { classifyByLabels, selectRepoByLabels, findRepoByName, runClassifier, Mode } from './dev/classify';
import { runDevPipeline } from './dev/pipeline';
import { DevRepo } from './dev/types';

const ANSWER_FILE = 'answer.md';

function lower(s: string): string {
  return s.trim().toLowerCase();
}

export interface OrchestratorDeps {
  /** Override the Linear client factory (tests inject a fake here if desired). */
  linearFactory?: (endpoint: string, apiKey: string) => LinearClient;
}

export class Orchestrator {
  private readonly workers = new Map<string, WorkerHandle>();
  private readonly processed = new Set<string>(); // moved to done this session
  private readonly givenUp = new Set<string>(); // exhausted attempts this session
  private readonly cancelRequested = new Set<string>(); // became terminal externally
  private readonly completedAt = new Map<string, number>(); // id -> done time (for auto-reopen)

  private client!: LinearClient;
  private clientSig = '';
  private team?: { id: string; states: TrackerState[] };
  private teamSig = '';

  private stopped = false;
  private ticking = false;
  private tickTimer?: NodeJS.Timeout;
  private drainTimer?: NodeJS.Timeout;
  private draining = false;
  private viewerId?: string;
  private followupStore?: FollowupStore;

  constructor(
    private readonly store: ConfigStore,
    private readonly logger: Logger,
    private readonly deps: OrchestratorDeps = {},
  ) {}

  async start(): Promise<void> {
    const cfg = this.store.current;
    this.logger.info('orchestrator_starting', {
      team_key: cfg.tracker.teamKey,
      endpoint: cfg.tracker.endpoint,
      active_states: cfg.tracker.activeStates,
      done_state: cfg.tracker.doneState,
      poll_interval_ms: cfg.tracker.pollIntervalMs,
      max_concurrent_agents: cfg.agent.maxConcurrentAgents,
      wiki_enabled: cfg.wiki.vaultPath !== null,
      workspace_root: cfg.workspace.root,
      auto_drain_interval_sec: cfg.curation.autoDrainIntervalSec,
    });
    this.store.watch();
    if (cfg.curation.autoDrainIntervalSec > 0) {
      this.logger.info('curation_drain_enabled', { interval_sec: cfg.curation.autoDrainIntervalSec });
      this.scheduleDrain();
    }
    if (cfg.followups.enabled) {
      this.followupStore = new FollowupStore(cfg.followups.statePath, new Date().toISOString());
      this.logger.info('followups_enabled', { since: this.followupStore.lastCheck });
    }
    if (cfg.dev.enabled) {
      try {
        const devCfg = loadDevConfig(cfg.dev.path);
        this.logger.info('dev_enabled', {
          dev_path: cfg.dev.path,
          repos: devCfg.repos.map((r) => r.name),
          done_state: cfg.dev.doneState,
        });
      } catch (err) {
        // Fail loud at startup rather than silently per-ticket later.
        this.logger.error('dev_config_invalid', { error: (err as Error).message });
        throw err;
      }
    }
    await this.tick();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.store.stop();
    for (const [, w] of this.workers) w.kill?.();
    this.logger.info('orchestrator_stopped', { active_workers: this.workers.size });
  }

  /** Schedule the next in-process curation drain (lifecycle-bound to the orchestrator). */
  private scheduleDrain(): void {
    if (this.stopped) return;
    const sec = this.store.current.curation.autoDrainIntervalSec;
    if (sec <= 0) return; // disabled (possibly via reload) — stop scheduling
    this.drainTimer = setTimeout(() => void this.runDrain(), Math.max(1000, sec * 1000));
  }

  /** Run the Librarian once to drain the curation queue. Single-flight; best-effort. */
  private async runDrain(): Promise<void> {
    if (this.stopped) return;
    if (this.draining) {
      this.scheduleDrain();
      return;
    }
    this.draining = true;
    const log = this.logger.child({ component: 'curation_drain' });
    try {
      const libCfg = loadLibrarianConfig(this.store.current.curation.librarianPath);
      log.info('curation_drain_started', {});
      const res = await drainQueue(libCfg, log);
      log.info('curation_drain_finished', res);
    } catch (err) {
      log.error('curation_drain_failed', { error: (err as Error).message });
    } finally {
      this.draining = false;
      this.scheduleDrain();
    }
  }

  /** Poll for new human comments on bot-answered issues and answer them. */
  private async checkFollowups(): Promise<void> {
    const cfg = this.store.current;
    if (!this.followupStore) return;
    if (!this.viewerId) this.viewerId = await this.client.getViewerId();
    const since = this.followupStore.lastCheck;
    const comments = (await this.client.fetchCommentsSince(since)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let anchor = since;
    for (const c of comments) {
      if (c.createdAt <= since) continue;
      // Safely consumable (advance past): other team, our own comment, or already answered.
      if (lower(c.issue.teamKey) !== lower(cfg.tracker.teamKey) || c.authorId === this.viewerId || this.followupStore.hasResponded(c.id)) {
        anchor = c.createdAt;
        continue;
      }
      // Only a follow-up if the bot has commented on this issue (i.e. it answered it).
      let authorIds: string[];
      try {
        authorIds = (await this.client.fetchIssueComments(c.issue.id)).map((x) => x.authorId).filter((x): x is string => x !== null);
      } catch {
        break; // can't verify now → retry next tick without advancing past this comment
      }
      if (!authorIds.includes(this.viewerId)) {
        anchor = c.createdAt;
        continue; // not bot-answered → ignore
      }
      if (this.workers.has(c.issue.id) || this.workers.size >= cfg.agent.maxConcurrentAgents) break; // busy/no slot → retry
      this.followupStore.markResponded(c.id);
      anchor = c.createdAt;
      void this.runFollowup(c);
    }
    if (anchor !== since) this.followupStore.setLastCheck(anchor);
  }

  /** Answer a follow-up comment in a fresh agent session, injecting the full thread. */
  private async runFollowup(comment: CommentInfo): Promise<void> {
    const cfg = this.store.current;
    const issue: Issue = {
      id: comment.issue.id,
      identifier: comment.issue.identifier,
      title: comment.issue.title,
      description: comment.issue.description,
      priority: null,
      state: comment.issue.state,
      branch_name: null,
      url: null,
      labels: [],
      blocked_by: [],
      created_at: null,
      updated_at: null,
    };
    const log = this.logger.child({ issue_id: issue.id, issue_identifier: issue.identifier, followup_comment: comment.id });
    this.workers.set(issue.id, { issue, status: 'running' });
    try {
      const { path: wsPath, createdNow } = ensureWorkspace(cfg.workspace.root, issue.identifier);
      if (createdNow && cfg.hooks.afterCreate) {
        const res = await runHook('after_create', cfg.hooks.afterCreate, wsPath, { issue, attempt: null }, cfg.hooks.timeoutMs, log, cfg.hooks.envPassthrough);
        if (!res.ok) {
          log.error('followup_failed', { reason: 'after_create_failed', detail: res.reason });
          return;
        }
      }
      ensureWikiMount(wsPath, cfg.wiki.vaultPath, cfg.wiki.mountName, log);

      // Reconstruct the conversation from Linear (this is a fresh session — no memory).
      let thread = '';
      try {
        const all = await this.client.fetchIssueComments(issue.id);
        thread = all
          .map((x) => `[${x.authorId === this.viewerId ? 'BOT(이전 답변)' : 'HUMAN'} · ${x.createdAt}]\n${x.body}`)
          .join('\n\n---\n\n');
      } catch {
        /* best-effort; thread context optional */
      }

      const model = this.resolveModel(issue);
      let prompt: string;
      let command: string;
      try {
        const base = render(cfg.promptTemplate, { issue, attempt: null });
        prompt =
          `[FOLLOW-UP] 이 이슈는 이미 답변했고, 팀원이 새 댓글을 달았습니다. 지금은 새 세션이라 이전 대화 기억이 없으니 ` +
          `아래 전체 스레드를 읽고, 가장 최근 댓글에 대해 이전 답변 위에 이어서 **추가 답변**을 작성하세요(이전 답변을 통째로 반복하지 말 것). ` +
          `답은 answer.md 에 쓰세요.\n\n` +
          `===== 댓글 스레드 (오래된→최신) =====\n${thread || '(스레드 조회 불가)'}\n\n` +
          `===== 지금 답해야 할 최신 댓글 =====\n${comment.body}\n\n` +
          `===== 원래 작업 지시 & 규칙 =====\n${base}`;
        command = render(cfg.claude.command, { issue, attempt: null, model }, { shellEscape: true });
      } catch (err) {
        log.error('followup_failed', { reason: 'render_failed', detail: (err as Error).message });
        return;
      }

      log.info('followup_dispatched', { comment: comment.id, model });
      const result = await runAgent({
        command,
        workspacePath: wsPath,
        prompt,
        stallTimeoutMs: cfg.agent.stallTimeoutMs,
        answerFile: ANSWER_FILE,
        logger: log,
      });
      if (result.kind !== 'completed') {
        log.error('followup_failed', { reason: result.kind });
        return;
      }
      // Harvest gaps first so the follow-up comment can report what was queued.
      const curation = cfg.curation.autoEnqueueGaps
        ? this.enqueueAnswerGaps(wsPath, log)
        : { enqueued: [], skipped: [] };
      try {
        const answer = fs.readFileSync(`${wsPath}/${ANSWER_FILE}`, 'utf8');
        if (answer.trim()) {
          const footer = buildCurationFooter(curation.enqueued, curation.skipped);
          const body = footer ? `${answer.trimEnd()}\n\n${footer}` : answer;
          await this.client.createComment(issue.id, body);
          log.info('followup_answered', { chars: body.length, gaps_enqueued: curation.enqueued.length });
        } else {
          log.warn('followup_answer_empty', {});
        }
      } catch (err) {
        log.warn('followup_post_failed', { reason: (err as Error).message });
      }
    } catch (err) {
      log.error('followup_failed', { reason: 'unexpected', detail: (err as Error).message });
    } finally {
      this.workers.delete(issue.id);
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const interval = this.store.current.tracker.pollIntervalMs;
    this.tickTimer = setTimeout(() => void this.tick(), interval);
  }

  /**
   * Decide dev vs answer AND which repo (used to scope both the dev worktree and
   * the answer-mode codebase). Labels win; the LLM classifier is consulted only
   * when no decisive label exists or a dev label has no repo — and at most once.
   * The repo is best-effort for BOTH modes (null = no signal → expose all repos in
   * answer mode). A dev ticket with no resolvable repo falls back to answer.
   */
  private async classifyTicket(issue: Issue, log: Logger): Promise<{ mode: Mode; repo: DevRepo | null }> {
    const cfg = this.store.current;
    const devCfg = loadDevConfig(cfg.dev.path);
    const labelMode = classifyByLabels(issue.labels, cfg.dev.devLabels, cfg.dev.answerLabels);
    const labelRepo = selectRepoByLabels(issue.labels, devCfg.repos);
    const soleRepo = devCfg.repos.length === 1 ? devCfg.repos[0] : null;
    const model = this.resolveModel(issue);

    let classifierDecision: { mode: Mode; repoName: string | null } | null | undefined;
    const classify = async () => {
      if (classifierDecision === undefined) {
        classifierDecision = devCfg.classifierCommand ? await runClassifier(issue, devCfg, model, log) : null;
      }
      return classifierDecision;
    };

    // Mode: label wins; else ask the classifier (null → answer).
    const mode: Mode = labelMode ?? (await classify())?.mode ?? 'answer';

    // Repo: label > sole configured repo > classifier pick. Only call the
    // classifier specifically to resolve a repo when in dev mode (answer scoping
    // never forces an extra call — "no signal → all repos"); reuse it if it ran.
    let repo: DevRepo | null = labelRepo ?? soleRepo;
    if (!repo && (classifierDecision !== undefined || mode === 'dev')) {
      repo = findRepoByName((await classify())?.repoName, devCfg.repos);
    }

    if (mode === 'dev' && !repo) {
      // Can't resolve a dev repo → fall back to answer (scoped to any label/sole repo).
      return { mode: 'answer', repo: labelRepo ?? soleRepo };
    }
    log.info('classified', { mode, repo: repo?.name ?? null, by: labelMode ? 'label' : 'agent' });
    return { mode, repo };
  }

  /** Dev pipeline: write code → Draft PR → comment + move to dev.done_state. */
  private async runDevTicket(issue: Issue, repo: DevRepo, handle: WorkerHandle, log: Logger): Promise<void> {
    const cfg = this.store.current;
    handle.status = 'running';
    log.info('dev_dispatched', { repo: repo.name });
    await this.maybeMoveToStartState(issue, log);

    let result;
    try {
      const devCfg = loadDevConfig(cfg.dev.path);
      const model = this.resolveModel(issue);
      result = await runDevPipeline({ issue, repo, devCfg, model, logger: log });
    } catch (err) {
      log.error('dev_failed', { reason: 'unexpected', detail: (err as Error).message });
      this.givenUp.add(issue.id);
      return;
    }

    if (!result.ok) {
      log.error('dev_failed', { reason: result.reason });
      if (cfg.tracker.postAnswerComment) {
        try {
          await this.client.createComment(
            issue.id,
            `🛠 개발 모드 실패: \`${result.reason}\`\nSymphony가 코드 작업을 완료하지 못했습니다. 워크트리/로그를 확인해 주세요.`,
          );
        } catch (err) {
          log.warn('dev_comment_failed', { reason: (err as Error).message });
        }
      }
      this.givenUp.add(issue.id);
      return;
    }

    if (cfg.tracker.postAnswerComment) {
      try {
        await this.client.createComment(issue.id, devResultComment(result));
        log.info('dev_comment_posted', { url: result.prUrl });
      } catch (err) {
        log.warn('dev_comment_failed', { reason: (err as Error).message });
      }
    }

    const stateId = this.resolveStateId(cfg.dev.doneState);
    if (!stateId) {
      log.error('dev_done_state_not_found', { done_state: cfg.dev.doneState });
      this.givenUp.add(issue.id);
      return;
    }
    try {
      await this.client.moveIssueToState(issue.id, stateId);
      log.info('issue_transitioned', { to_state: cfg.dev.doneState, phase: 'dev_done' });
      this.processed.add(issue.id);
      this.completedAt.set(issue.id, Date.now());
    } catch (err) {
      const le = err as LinearError;
      log.error('tracker_transition_failed', { error: le.message, category: le.category ?? 'unknown' });
      this.givenUp.add(issue.id);
    }
  }

  private async resolveTeamIfNeeded(): Promise<void> {
    const cfg = this.store.current;
    const sig = `${cfg.tracker.endpoint}|${cfg.tracker.apiKey}`;
    if (sig !== this.clientSig || !this.client) {
      this.client = this.deps.linearFactory
        ? this.deps.linearFactory(cfg.tracker.endpoint, cfg.tracker.apiKey)
        : new LinearClient(cfg.tracker.endpoint, cfg.tracker.apiKey);
      this.clientSig = sig;
      this.team = undefined;
    }
    const teamSig = `${sig}|${cfg.tracker.teamKey}`;
    if (this.team && teamSig === this.teamSig) return;
    const team = await this.client.getTeam(cfg.tracker.teamKey);
    this.team = { id: team.id, states: team.states };
    this.teamSig = teamSig;
    this.logger.info('team_resolved', {
      team_key: team.key,
      team_name: team.name,
      states: team.states.map((s) => s.name),
    });
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) {
      if (!this.stopped) this.scheduleNext();
      return;
    }
    this.ticking = true;
    try {
      // Defensive reload (SPEC SHOULD): re-validate before dispatch.
      const cfg = this.store.current;
      await this.resolveTeamIfNeeded();
      await this.reconcile();

      const candidates = await this.client.fetchCandidateIssues(this.team!.id, cfg.tracker.activeStates);
      const eligible = candidates.filter((i) => this.isEligible(i, cfg.tracker.terminalStates, cfg.tracker.requiredLabels));
      eligible.sort(byPriorityThenAge);

      let slots = Math.max(cfg.agent.maxConcurrentAgents - this.workers.size, 0);
      this.logger.debug('tick', {
        candidates: candidates.length,
        eligible: eligible.length,
        running: this.workers.size,
        free_slots: slots,
      });
      for (const issue of eligible) {
        if (slots <= 0) break;
        this.dispatch(issue);
        slots--;
      }

      // Comment-driven follow-ups (best-effort; never breaks the main loop).
      if (cfg.followups.enabled && this.followupStore) {
        try {
          await this.checkFollowups();
        } catch (err) {
          this.logger.warn('followup_check_failed', { error: (err as Error).message });
        }
      }
    } catch (err) {
      const le = err as LinearError;
      this.logger.error('tick_failed', { error: le.message, category: le.category ?? 'unknown' });
    } finally {
      this.ticking = false;
      this.scheduleNext();
    }
  }

  private isEligible(issue: Issue, terminalStates: string[], requiredLabels: string[]): boolean {
    if (this.workers.has(issue.id)) return false;
    if (this.givenUp.has(issue.id)) return false;
    if (this.processed.has(issue.id)) {
      // Auto-reopen: a completed issue is a candidate again ⇒ it was moved back to
      // an active state by a human. After the grace window (covers the brief lag
      // before the done transition propagates), clear it and let it run again.
      const since = Date.now() - (this.completedAt.get(issue.id) ?? 0);
      if (since < this.store.current.tracker.reopenGraceMs) return false;
      this.processed.delete(issue.id);
      this.completedAt.delete(issue.id);
      this.logger.child({ issue_id: issue.id, issue_identifier: issue.identifier }).info('issue_reopened', {});
    }
    const term = new Set(terminalStates.map(lower));
    if (term.has(lower(issue.state))) return false;
    for (const label of requiredLabels) {
      if (!issue.labels.includes(label)) return false;
    }
    // Blocker rule for Todo: do not dispatch while any blocker is non-terminal.
    if (lower(issue.state) === 'todo' && issue.blocked_by.length > 0) return false;
    return true;
  }

  /** Synchronously claim the issue, then run the worker in the background. */
  private dispatch(issue: Issue): void {
    this.workers.set(issue.id, { issue, status: 'claimed' });
    void this.runWorker(issue);
  }

  /** Pick the model for an issue: heavyModel if it carries a heavy label, else default. */
  private resolveModel(issue: Issue): string {
    const { model, heavyModel, heavyLabels } = this.store.current.agent;
    if (heavyLabels.length > 0 && issue.labels.some((l) => heavyLabels.includes(l))) return heavyModel;
    return model;
  }

  private resolveStateId(stateName: string): string | null {
    const match = this.team!.states.find((s) => lower(s.name) === lower(stateName));
    return match ? match.id : null;
  }

  /** Best-effort: move the issue to the configured start_state when work begins. */
  private async maybeMoveToStartState(issue: Issue, log: Logger): Promise<void> {
    const startState = this.store.current.tracker.startState;
    if (!startState) return; // disabled
    if (lower(issue.state) === lower(startState)) return; // already there
    const id = this.resolveStateId(startState);
    if (!id) {
      log.warn('start_state_not_found', { start_state: startState });
      return;
    }
    try {
      await this.client.moveIssueToState(issue.id, id);
      log.info('issue_transitioned', { to_state: startState, phase: 'start' });
    } catch (err) {
      const le = err as LinearError;
      log.warn('start_transition_failed', { error: le.message, category: le.category ?? 'unknown' });
    }
  }

  private async runWorker(issue: Issue): Promise<void> {
    const cfg = this.store.current;
    const log = this.logger.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    const handle = this.workers.get(issue.id)!;

    // Repo scope for answer mode (exposed to hooks as $SYMPHONY_REPOS; empty = all).
    let scopedRepoName = '';
    try {
      // --- mode classification: dev tickets take a separate write→PR pipeline ---
      // (inside the try so the finally below always releases the worker slot).
      if (cfg.dev.enabled) {
        let mode: Mode = 'answer';
        let repo: DevRepo | null = null;
        try {
          const decision = await this.classifyTicket(issue, log);
          mode = decision.mode;
          repo = decision.repo;
        } catch (err) {
          log.warn('classify_error', { detail: (err as Error).message, fallback: 'answer' });
        }
        if (mode === 'dev' && repo) {
          await this.runDevTicket(issue, repo, handle, log);
          return;
        }
        if (mode === 'dev' && !repo) {
          log.warn('dev_no_repo', { reason: 'no repo resolved; falling back to answer mode' });
        }
        // Answer mode: scope the codebase to the selected repo, if any.
        scopedRepoName = repo?.name ?? '';
        if (scopedRepoName) log.info('answer_repo_scoped', { repo: scopedRepoName });
      }

      // --- workspace preparation ---
      const { path: wsPath, createdNow } = ensureWorkspace(cfg.workspace.root, issue.identifier);
      const hookCtx = { issue, attempt: null as number | null, selectedRepos: scopedRepoName };

      if (createdNow && cfg.hooks.afterCreate) {
        const res = await runHook('after_create', cfg.hooks.afterCreate, wsPath, hookCtx, cfg.hooks.timeoutMs, log, cfg.hooks.envPassthrough);
        if (!res.ok) {
          // Fatal to workspace creation: remove the partial dir, give up this issue.
          try {
            fs.rmSync(wsPath, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
          log.error('worker_failed', { reason: 'after_create_failed', detail: res.reason });
          this.givenUp.add(issue.id);
          return;
        }
      }
      ensureWikiMount(wsPath, cfg.wiki.vaultPath, cfg.wiki.mountName, log);

      handle.status = 'running';
      const model = this.resolveModel(issue);
      log.info('worker_dispatched', { workspace: wsPath, state: issue.state, created_now: createdNow, model });

      // Move to the start_state (e.g. "In Progress") now that work has begun.
      await this.maybeMoveToStartState(issue, log);

      // --- attempt loop ---
      const maxAttempts = cfg.agent.maxAttempts;
      let succeeded = false;
      for (let attempt = 1; attempt <= maxAttempts && !this.stopped; attempt++) {
        if (this.cancelRequested.has(issue.id)) break;

        const renderCtx = { issue, attempt: attempt === 1 ? null : attempt };
        let prompt: string;
        let command: string;
        try {
          prompt = render(cfg.promptTemplate, renderCtx);
          // Command is operator-authored shell; shell-escape substituted values.
          command = render(cfg.claude.command, { ...renderCtx, model }, { shellEscape: true });
        } catch (err) {
          log.error('worker_failed', { reason: 'render_failed', detail: (err as Error).message, attempt });
          break;
        }

        if (cfg.hooks.beforeRun) {
          const res = await runHook('before_run', cfg.hooks.beforeRun, wsPath, renderCtx, cfg.hooks.timeoutMs, log, cfg.hooks.envPassthrough);
          if (!res.ok) {
            log.error('worker_failed', { reason: 'before_run_failed', detail: res.reason, attempt });
            if (attempt < maxAttempts) {
              await this.interruptibleSleep(this.backoff(attempt, cfg.agent.maxRetryBackoffMs), issue.id);
              continue;
            }
            break;
          }
        }

        const result = await runAgent({
          command,
          workspacePath: wsPath,
          prompt,
          stallTimeoutMs: cfg.agent.stallTimeoutMs,
          answerFile: ANSWER_FILE,
          logger: log,
          onSpawn: (kill) => {
            handle.kill = kill;
          },
        });
        handle.kill = undefined;

        if (this.cancelRequested.has(issue.id)) break;

        if (result.kind === 'completed') {
          log.info('worker_completed', { attempt, answer_produced: result.answerProduced });
          await this.afterRunAndComplete(issue, wsPath, renderCtx, log);
          succeeded = true;
          break;
        } else if (result.kind === 'stalled') {
          log.warn('worker_restarted', { attempt, elapsed_ms: result.elapsedMs, reason: 'stall_timeout' });
          if (attempt < maxAttempts) {
            await this.interruptibleSleep(this.backoff(attempt, cfg.agent.maxRetryBackoffMs), issue.id);
            continue;
          }
          log.error('worker_failed', { reason: 'stalled_max_attempts', attempts: attempt });
        } else {
          log.error('worker_failed', { reason: 'agent_error', detail: result.reason, exit_code: result.exitCode, attempt });
          if (attempt < maxAttempts) {
            await this.interruptibleSleep(this.backoff(attempt, cfg.agent.maxRetryBackoffMs), issue.id);
            continue;
          }
        }
      }

      if (!succeeded && !this.cancelRequested.has(issue.id) && !this.stopped) {
        this.givenUp.add(issue.id);
      }
      if (this.cancelRequested.has(issue.id)) {
        log.warn('worker_cancelled', { reason: 'issue_became_terminal' });
      }
    } catch (err) {
      log.error('worker_failed', { reason: 'unexpected', detail: (err as Error).message });
      this.givenUp.add(issue.id);
    } finally {
      this.cancelRequested.delete(issue.id);
      this.workers.delete(issue.id);
    }
  }

  private async afterRunAndComplete(
    issue: Issue,
    wsPath: string,
    renderCtx: Record<string, unknown>,
    log: Logger,
  ): Promise<void> {
    const cfg = this.store.current;
    // after_run: failures are logged and ignored.
    if (cfg.hooks.afterRun) {
      await runHook('after_run', cfg.hooks.afterRun, wsPath, renderCtx, cfg.hooks.timeoutMs, log, cfg.hooks.envPassthrough);
    }
    // Re-check after the (possibly long) after_run await: if the issue went
    // terminal upstream or we are shutting down, do NOT force a done transition.
    if (this.cancelRequested.has(issue.id)) {
      log.warn('transition_skipped', { reason: 'cancelled_during_after_run' });
      return;
    }
    if (this.stopped) {
      log.warn('transition_skipped', { reason: 'shutting_down' });
      return;
    }
    // Harvest the answer's knowledge gaps into the curation queue FIRST (best-effort),
    // so the answer comment can report what was queued for later curation.
    const curation = cfg.curation.autoEnqueueGaps
      ? this.enqueueAnswerGaps(wsPath, log)
      : { enqueued: [], skipped: [] };

    // Optionally publish the answer (+ a curation note) back to Linear as a comment.
    if (cfg.tracker.postAnswerComment) {
      try {
        const answer = fs.readFileSync(`${wsPath}/${ANSWER_FILE}`, 'utf8');
        if (answer.trim()) {
          const footer = buildCurationFooter(curation.enqueued, curation.skipped);
          const body = footer ? `${answer.trimEnd()}\n\n${footer}` : answer;
          await this.client.createComment(issue.id, body);
          log.info('answer_comment_posted', { chars: body.length, gaps_enqueued: curation.enqueued.length });
        } else {
          log.warn('answer_comment_skipped', { reason: 'answer.md is empty' });
        }
      } catch (err) {
        log.warn('answer_comment_skipped', { reason: (err as Error).message });
      }
    }
    // Move the issue to done_state (orchestrator-owned transition for this build).
    const doneStateId = this.resolveStateId(cfg.tracker.doneState);
    if (!doneStateId) {
      // Not cleanly completed → give up (not auto-reopenable, avoids a re-dispatch loop).
      log.error('done_state_not_found', { done_state: cfg.tracker.doneState });
      this.givenUp.add(issue.id);
      return;
    }
    try {
      await this.client.moveIssueToState(issue.id, doneStateId);
      log.info('issue_transitioned', { to_state: cfg.tracker.doneState });
      // Cleanly done → eligible for auto-reopen if moved back to an active state.
      this.processed.add(issue.id);
      this.completedAt.set(issue.id, Date.now());
    } catch (err) {
      const le = err as LinearError;
      log.error('tracker_transition_failed', { error: le.message, category: le.category ?? 'unknown' });
      this.givenUp.add(issue.id);
    }
  }

  /** Read the answer's gaps, enqueue new ones (skip those already in the vault). */
  private enqueueAnswerGaps(wsPath: string, log: Logger): { enqueued: string[]; skipped: string[] } {
    const cfg = this.store.current;
    const enqueued: string[] = [];
    const skipped: string[] = [];
    try {
      const answer = fs.readFileSync(`${wsPath}/${ANSWER_FILE}`, 'utf8');
      const queue = new CurationQueue(cfg.curation.queuePath);
      const now = new Date().toISOString();
      for (const gap of parseGaps(answer)) {
        if (cfg.wiki.vaultPath && findExistingNote(cfg.wiki.vaultPath, gap)) {
          skipped.push(gap);
          continue;
        }
        if (queue.enqueue(gap, 'gap', now)) {
          enqueued.push(gap);
          log.info('gap_enqueued', { gap });
        }
      }
    } catch (err) {
      log.warn('gap_enqueue_failed', { reason: (err as Error).message });
    }
    return { enqueued, skipped };
  }

  /** Reconcile running issues against tracker state; cancel ones gone terminal. */
  private async reconcile(): Promise<void> {
    const cfg = this.store.current;
    const ids = [...this.workers.keys()];
    if (ids.length === 0) return;
    let states: Map<string, string>;
    try {
      states = await this.client.fetchIssueStatesByIds(ids);
    } catch (err) {
      this.logger.warn('reconcile_failed', { error: (err as Error).message });
      return;
    }
    const term = new Set(cfg.tracker.terminalStates.map(lower));
    for (const [id, stateName] of states) {
      const worker = this.workers.get(id);
      if (!worker) continue;
      if (term.has(lower(stateName)) && !this.processed.has(id)) {
        this.logger.child({ issue_id: id, issue_identifier: worker.issue.identifier }).warn('reconcile_terminal', {
          state: stateName,
        });
        this.cancelRequested.add(id);
        worker.kill?.();
      }
    }
  }

  private backoff(attempt: number, capMs: number): number {
    return Math.min(10_000 * 2 ** (attempt - 1), capMs);
  }

  /** Sleep that returns early if the orchestrator stops or the issue is cancelled. */
  private interruptibleSleep(ms: number, issueId: string): Promise<void> {
    return new Promise((resolve) => {
      const start = Date.now();
      const iv = setInterval(() => {
        if (this.stopped || this.cancelRequested.has(issueId) || Date.now() - start >= ms) {
          clearInterval(iv);
          resolve();
        }
      }, 250);
    });
  }
}

/** A short markdown footer summarizing which answer gaps were queued for curation. */
function buildCurationFooter(enqueued: string[], skipped: string[]): string {
  if (enqueued.length === 0 && skipped.length === 0) return '';
  const lines = ['---', '### 🗂 지식 큐레이션 (knowledge curation)'];
  if (enqueued.length > 0) lines.push(`- 큐 적재됨 — 추후 위키로 정제 예정: ${enqueued.join(', ')}`);
  if (skipped.length > 0) lines.push(`- 이미 위키에 있어 스킵: ${skipped.join(', ')}`);
  return lines.join('\n');
}

/** Linear comment reporting the dev-mode outcome (Draft PR link). */
function devResultComment(result: { prUrl: string; branch: string; repo: string; updated: boolean; title: string }): string {
  const verb = result.updated ? '갱신했습니다' : '열었습니다';
  return [
    `🛠 **개발 모드** — Draft PR을 ${verb}. 리뷰 후 머지해 주세요.`,
    '',
    `- PR: ${result.prUrl}`,
    `- 레포: \`${result.repo}\` · 브랜치: \`${result.branch}\``,
    `- 제목: ${result.title}`,
  ].join('\n');
}

function byPriorityThenAge(a: Issue, b: Issue): number {
  // Linear priority: 1=Urgent..4=Low are preferred; 0 ("No priority") and null
  // sort last. Then oldest-first, then identifier for a deterministic tie-break.
  const norm = (p: number | null): number => (p === null || p < 1 ? Number.MAX_SAFE_INTEGER : p);
  const pa = norm(a.priority);
  const pb = norm(b.priority);
  if (pa !== pb) return pa - pb;
  const ta = a.created_at ? Date.parse(a.created_at) : Number.MAX_SAFE_INTEGER;
  const tb = b.created_at ? Date.parse(b.created_at) : Number.MAX_SAFE_INTEGER;
  if (ta !== tb) return ta - tb;
  return a.identifier.localeCompare(b.identifier);
}
