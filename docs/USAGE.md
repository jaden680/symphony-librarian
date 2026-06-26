# Symphony Orchestrator — Codebase + Wiki Q&A (read-only)

A long-running orchestrator that watches a **Linear** board and, for each question
issue, spins up an isolated workspace, runs the **Claude Code CLI** against your
**cloned codebase** and (optionally) your **Obsidian wiki vault**, and produces a
grounded answer as a local `answer.md` file.

This build is intentionally **read-only and PR-free**: it never modifies source or
wiki, never commits/pushes/opens a PR. The only deliverable is `answer.md`, copied
to `~/symphony_answers` with a timestamp.

It follows the [openai/symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md)
(workspace isolation invariants, idempotent single-authority dispatch, strict
prompt rendering, stall-timeout + backoff, dynamic config reload, structured
logging) while swapping the agent from Codex app-server to the Claude Code CLI and
the output from a PR to `answer.md`.

---

## How it works (the loop)

Once started it repeats until you stop it:

1. **Poll** Linear every `poll_interval_sec` (default 10s).
2. Detect issues in `active_states` (default `Todo`, `In Progress`).
3. Create a per-issue isolated workspace at `{workspace.root}/{ISSUE-ID}`.
4. Run the **`after_create`** hook on a *new* workspace (clone the codebase).
5. Mount the wiki vault read-only at `./wiki` (symlink) if configured.
6. Render the prompt template with the issue's data and run the agent **inside the
   workspace** (cwd is validated to equal the workspace path).
7. **Monitor** the agent: normal exit → completed; no output for `stall_timeout_ms`
   → kill and restart (exponential backoff, up to `max_attempts`).
8. Run the **`after_run`** hook (copies `answer.md` to `~/symphony_answers`).
9. Move the issue to `done_state`.
10. Back to step 1.

**Idempotency:** each issue is claimed synchronously before any await, so it is
never dispatched twice; completed issues land in a terminal state and are not
re-picked. Concurrency is capped by `agent.max_concurrent_agents` (default 1).

**Structured logs** (one JSON object per line) include the key lifecycle events
with the issue identifier: `worker_dispatched`, `worker_completed`,
`worker_failed`, `worker_restarted`, plus `team_resolved`, `issue_transitioned`,
hook events (`hook_started`/`hook_failed`/`hook_timeout`), and reconciliation
events (`reconcile_terminal`, `reconcile_failed`).

---

## Requirements

- **Node.js 22+** (uses the global `fetch`).
- **Claude Code CLI** (`claude`) on your `PATH`, authenticated with a **Pro/Max
  subscription** (see below).
- **`gh` CLI** authenticated, if your `after_create` hook clones a private repo.
- A **Linear personal API key**.

---

## Install

```bash
npm install
npm run build
```

---

## Authentication & cost (important)

This orchestrator is designed for **subscription auth** (Claude Pro/Max), not
metered API billing.

1. **Authenticate Claude Code once** with your subscription:
   ```bash
   claude setup-token
   ```
2. **Unset `ANTHROPIC_API_KEY`** in the shell you launch the orchestrator from:
   ```bash
   unset ANTHROPIC_API_KEY
   ```
   If a key is present, Claude Code would use **uncapped metered billing**, which a
   long-running polling loop can run up quickly. The orchestrator **strips
   `ANTHROPIC_API_KEY` (and `LINEAR_API_KEY`) from every agent subprocess** and
   warns at startup if it sees `ANTHROPIC_API_KEY` set — but you should still unset
   it yourself.
3. (Optional sanity check) Run `claude` once and type `/cost` to confirm your
   subscription plan is in effect.

> Tip: keep the default model on **Sonnet** and reserve Opus for heavy tickets.

---

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `LINEAR_API_KEY` | **Yes** | Linear personal API key. Read only from the environment; referenced as `$LINEAR_API_KEY` in `WORKFLOW.md`. Never logged. |
| `ANTHROPIC_API_KEY` | **Must be unset** | Presence forces metered billing. Stripped from subprocesses; unset it in your shell. |

```bash
export LINEAR_API_KEY="lin_api_..."   # your key
unset ANTHROPIC_API_KEY
```

Get a Linear key at **Linear → Settings → Security & access → Personal API keys**.

---

## Configure `WORKFLOW.md`

All configuration lives in a single `WORKFLOW.md` (YAML front matter + the prompt
template below it). Edit the provided example and fill in the `TODO`s:

- `tracker.team_key` — your Linear team key (the prefix in issue ids, e.g. `ZZ` for
  `ZZ-123`).
- `hooks.after_create` — the command that clones the codebase answers are grounded
  in, e.g. `gh repo clone Your-Org/your-repo .`.
- `wiki.vault_path` — **leave empty for codebase-only**; or set an **absolute path**
  to your Obsidian vault to enable the wiki.

### Enabling the Obsidian wiki

Set `wiki.vault_path` to the absolute path of your vault:

```yaml
wiki:
  vault_path: /Users/me/ObsidianVault
  mount_name: wiki
```

- The vault is exposed **read-only** inside each workspace as a symlink at `./wiki`
  (configurable via `mount_name`). The agent can `grep`/read `.md` notes there.
- The vault is **never modified, created, or deleted**. If the path is empty or
  missing, the orchestrator runs codebase-only.

### Per-ticket model routing

`agent.model` is the default model; issues carrying any label in
`agent.heavy_labels` use `agent.heavy_model` instead. The resolved value is
injected into `claude.command` via the `{{ model }}` placeholder.

```yaml
agent:
  model: sonnet          # default — fast & cheap, good for code Q&A
  heavy_model: opus      # used for heavy-labeled tickets
  heavy_labels: [opus, heavy, deep]
```

Keep `--model {{ model }}` in `claude.command`. Add a label like `opus` to a Linear
issue to route just that ticket to Opus. (Defaulting to Opus is much slower and
~5x more expensive — keep the default on Sonnet.)

### Reading Slack threads (optional)

If an issue references a Slack thread/URL, the agent can read it as evidence. This
requires the **claude.ai Slack connector** authenticated in your Claude Code CLI
(`claude mcp list` should show `claude.ai Slack ✔ Connected`).

To enable, the shipped `claude.command` includes:
- `--setting-sources user` — loads your user MCP servers (the only way the Slack
  connector's auth is reused in headless mode).
- read-only Slack tools in `--allowedTools` (`...slack_read_thread`,
  `...slack_read_channel`, `...slack_search_public`, etc.). **Send/post tools are
  deliberately excluded** — the agent can read Slack but never write to it.

Trade-off: `--setting-sources user` also loads your other user MCP servers and
global settings, making each run a bit heavier. For lean, codebase-only runs,
remove `--setting-sources user` and the `mcp__claude_ai_Slack__*` entries from
`claude.command`.

### Comment-driven follow-ups (optional)

When `followups.enabled: true` (and `post_answer_comment: true`), a teammate can
just **reply on the issue** and Symphony answers the follow-up — no need to reopen
the ticket. There is no webhook or tunnel: Symphony polls for comments created
since its last check (cheap — scales with comment volume, not ticket count), and
treats a comment as a follow-up when it's by a human (not the bot) on an issue the
bot has previously commented on.

Each follow-up runs as a **fresh agent session**, so the entire Linear comment
thread (the bot's prior answers + the human replies) is reconstructed and injected
into the prompt as context. The agent writes an *additional* answer that builds on
the prior one and addresses the latest comment, then posts it as a new comment.
Answered comment ids and the last-checked timestamp persist to
`followups.state_path`, so a restart never re-answers old comments.

> Note: the `comments(filter: { createdAt: { gt: ... } })` query is verified against
> the offline test fake; confirm it against your live Linear workspace. The poll
> fails gracefully (logged as `followup_check_failed`) and retries next tick.

### Config reference

| Key | Default | Notes |
|-----|---------|-------|
| `tracker.kind` | — | Must be `linear`. |
| `tracker.api_key` | — | `$LINEAR_API_KEY` (env indirection). |
| `tracker.endpoint` | `https://api.linear.app/graphql` | Override for testing. |
| `tracker.team_key` | — | Linear team key. |
| `tracker.done_state` | `Done` | State to move finished issues to. |
| `tracker.start_state` | _(empty)_ | State to move an issue to when the agent starts (e.g. `In Progress`); empty = no start transition. |
| `tracker.active_states` | `[Todo, In Progress]` | Dispatch-eligible states. |
| `tracker.terminal_states` | `[Closed, Cancelled, Canceled, Duplicate, Done]` | Never dispatched. |
| `tracker.required_labels` | `[]` | Issue must carry all of these. |
| `tracker.poll_interval_sec` | `10` | Poll cadence (min 1s). |
| `tracker.post_answer_comment` | `false` | If true, post `answer.md` back to the issue as a Linear comment on completion. |
| `workspace.root` | `./symphony_workspaces` | Relative to `WORKFLOW.md`. |
| `wiki.vault_path` | _(empty)_ | Absolute path; empty disables the wiki. |
| `wiki.mount_name` | `wiki` | Symlink name inside the workspace. |
| `agent.max_concurrent_agents` | `1` | Global concurrency cap. |
| `agent.model` | `sonnet` | Default model, injected into `claude.command` as `{{ model }}`. |
| `agent.heavy_model` | `opus` | Model used for issues carrying a `heavy_labels` label. |
| `agent.heavy_labels` | `[]` | Labels that route an issue to `heavy_model`. |
| `agent.stall_timeout_ms` | `600000` | Inactivity → kill + restart; `<=0` disables. |
| `agent.max_attempts` | `3` | Attempts per issue per run (initial + retries). |
| `agent.max_retry_backoff_ms` | `300000` | Backoff cap. |
| `claude.command` | `claude -p --permission-mode dontAsk --output-format stream-json --verbose` | Launched via `bash -lc`. |
| `hooks.after_create` | — | New workspace only; failure is fatal to that issue. |
| `hooks.before_run` | — | Before each attempt; failure fails the attempt. |
| `hooks.after_run` | — | After each attempt; failure logged & ignored. |
| `hooks.timeout_ms` | `60000` | Applies to all hooks. |
| `hooks.env_passthrough` | `[]` | Extra env var names forwarded to hooks (base env is an allow-list). |
| `tracker.reopen_grace_sec` | `30` | After completion, wait this long before re-dispatching an issue moved back to an active state (covers done-state propagation lag). |
| `followups.enabled` | `false` | Answer new human comments on issues the bot already answered. Polls comments (no webhook). Requires `post_answer_comment: true`. |
| `followups.state_path` | `.symphony/followups.json` | Persists the last-checked timestamp + answered comment ids across restarts. |

Changes to `WORKFLOW.md` are **picked up live** (file watch) — polling cadence,
concurrency, states, hooks, and the prompt for future runs all re-apply without a
restart. An invalid edit is rejected and the last good config keeps running.
(Exception: turning `followups.enabled` from off → on needs a restart, since the
follow-up state is initialized at startup.)

---

## Run

```bash
# default: reads ./WORKFLOW.md
npm start

# or explicitly
node dist/cli.js --workflow WORKFLOW.md

# more logs
node dist/cli.js --workflow WORKFLOW.md --log-level debug
```

You should see `orchestrator_starting`, then `team_resolved`, and on each matching
issue a `worker_dispatched` line.

Answers are written to each workspace's `answer.md` and copied to
`~/symphony_answers/{ISSUE-ID}-<timestamp>.md`.

---

## Stop

Press **Ctrl-C** (SIGINT) or send **SIGTERM**. The orchestrator stops scheduling,
terminates any running agent subprocesses, and exits. Workspaces persist on disk so
a later run can reuse them (the `after_create` hook does not re-run on reuse).

---

## Verify offline (no Linear / no Claude needed)

A self-contained end-to-end test spins up a fake Linear GraphQL server and a fake
agent, then runs the real orchestrator end to end:

```bash
npm run test:e2e
```

It asserts the full loop: `worker_dispatched` → agent writes `answer.md` →
`after_run` copy → issue moved to `Done` (`issue_transitioned`), the wiki symlink is
created, and the API key never appears in logs. Prints `PASS` and exits 0 on
success.

---

## Safety model

- **Read-only:** the cloned codebase and the wiki vault are treated as read-only.
  The agent is instructed (in the prompt) to write only `answer.md`. The vault is
  mounted via symlink and never written by the orchestrator.
- **No PR/commit/push:** the `after_run` hook only copies `answer.md` locally. The
  one optional write-back to the tracker is a Linear **comment** containing the
  answer, enabled only when `tracker.post_answer_comment: true` (default off). The
  orchestrator never creates PRs or edits the issue body.
- **Secrets:** `LINEAR_API_KEY` is read only from the environment and redacted from
  all log output. `ANTHROPIC_API_KEY` is never used and is stripped from
  subprocesses. Agent subprocesses get a minimal allow-listed environment; hook
  subprocesses get a broader but still deny-by-default allow-list (PATH/HOME plus
  git/gh/ssh/proxy vars), extendable via `hooks.env_passthrough`.
- **Hook inputs:** issue data is exposed to hooks as `$SYMPHONY_ISSUE_*`
  environment variables (`SYMPHONY_ISSUE_IDENTIFIER`, `_TITLE`, `_DESCRIPTION`,
  `_STATE`, `_URL`, `_BRANCH`, `_PRIORITY`). **Prefer these over inlining
  `{{ issue.* }}`** into a hook: untrusted issue text rendered into a hook is
  automatically shell-escaped, but the env vars are the clean, injection-proof path.
- **Workspace containment:** issue identifiers are sanitized to `[A-Za-z0-9._-]` and
  each workspace path is verified to stay under `workspace.root`; the agent's cwd is
  validated to equal its workspace before launch.
- **Trust:** treat Linear data, repo contents, and prompt inputs as untrusted. Run
  in an environment you are comfortable letting `claude.command` execute in.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `startup_failed ... tracker.api_key is missing` | `export LINEAR_API_KEY=...` before starting. |
| `startup_failed ... tracker.team_key is missing` | Set `tracker.team_key` in `WORKFLOW.md`. |
| `no team found with key "ZZ"` | Wrong team key, or the API key lacks access to that team. |
| `done_state_not_found` | `tracker.done_state` doesn't match a workflow state name in that team. |
| `anthropic_api_key_present` warning | `unset ANTHROPIC_API_KEY` to ensure subscription billing. |
| `worker_restarted` repeatedly | Agent produces no output for `stall_timeout_ms`; raise it or check the `claude` command. |
| `hook_failed after_create` | The clone command failed (check `gh auth status` / repo path). |
| No `worker_dispatched` lines | No issues currently in `active_states`, or all carry a `required_labels` mismatch. |

---

## Knowledge curation (Librarian)

Symphony reads the vault; the **Librarian** writes it. It searches Slack/Notion for
scattered past decisions, distills them into classified Obsidian notes, and never
touches code. Curation is a batch command (not a daemon):

```bash
# Bootstrap: name the key topics; the agent finds the scattered evidence
npm run curate -- --topics "deeplink routing, payment settlement"

# Gap-driven: harvest "추가 확인 필요" topics from past answers
npm run curate -- --from-answers ~/symphony_answers

# Drain the pending queue only
npm run curate
```

Config lives in `LIBRARIAN.md` (set `vault.path`). Notes land in `vault/_inbox/`
as drafts (`review_mode: draft`); review in Obsidian and move them into a type
folder (`decisions/`, `domain-rules/`, `integrations/`, `glossary/`) to promote
them. Symphony ignores `_inbox/`. Slack/Notion are read-only; the Librarian cannot
delete files (no Bash) and writes only inside the vault.

### Automatic gap-driven curation

Set `curation.auto_enqueue_gaps: true` in `WORKFLOW.md` and Symphony harvests each
answer's "추가 확인 필요" gaps into the shared queue (skipping gaps already covered by
a vault note, and reporting what was queued in the answer's Linear comment). Then
drain the queue automatically in one of two ways:

**In-process (recommended)** — `curation.auto_drain_interval_sec: 600` makes Symphony
itself run the Librarian every N seconds while it is up; it stops when Symphony
stops (no cron, no orphan jobs). A single-flight guard prevents overlapping drains.

```yaml
curation:
  auto_enqueue_gaps: true
  auto_drain_interval_sec: 600     # 10 min; 0 = off
  librarian_path: LIBRARIAN.md
```

**cron (for unattended hosts where Symphony isn't always running)** — schedule the
wrapper instead (set `auto_drain_interval_sec: 0` to avoid double-draining):

```cron
0 * * * * /path/to/symphony-librarian/scripts/curate-cron.sh >> "$HOME/symphony_curate.log" 2>&1
```

`scripts/curate-cron.sh` sets a minimal `PATH`, unsets `ANTHROPIC_API_KEY`, takes a
single-flight lock, and runs `npm run curate`. Either way the loop is hands-off:
Symphony answers → gaps queued → drained → the next answers are richer.

Offline test: `npm run test:librarian-e2e` (and unit tests: `npm run test:unit`).

## Extending later

The agent command and prompt template live entirely in `WORKFLOW.md`, decoupled
from the code. To add evidence sources later (Obsidian MCP server, Slack MCP, web
search), extend `claude.command` with the appropriate MCP/config flags and update
the prompt — no code changes required for v1's grep/read model.
