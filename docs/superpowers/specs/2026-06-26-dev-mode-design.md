# Symphony Dev Mode — Design

**Date:** 2026-06-26
**Status:** Approved (brainstorm), implementing

## Goal

Extend Symphony from a read-only Q&A bot into a dual-mode assistant. A ticket is
classified as **answer** (current read-only flow) or **dev** (write code → Draft
PR for human review). Decision → branch → execute → report.

## Decisions (from brainstorm)

1. **Classification** — hybrid: routing label wins; otherwise a lightweight LLM
   classifier judges from the ticket text. Ambiguous → fall back to **answer** (safe).
2. **Repo selection** — hybrid: `ios`/`android` label wins; else the classifier picks.
3. **Git/PR execution** — **orchestrator-owned (deterministic)**. The agent only
   edits code and writes `pr.md` + `commit.txt`; the orchestrator does
   `git commit/push` + `gh pr create --draft` and strips Claude attribution.
4. **Verify** — optional per-repo `verify` command, default off. Failure → no PR,
   report failure. Otherwise rely on Draft PR + CI + human review.
5. **Completion state** — dev tickets land in **In Review** (not Done).

## Flow

```
pick up ticket
  → classify (label fast-path; LLM fallback only when no decisive label)
      ├─ answer → existing read-only flow → comment + Done
      └─ dev    → dev pipeline → Draft PR → comment(PR link) + In Review
```

### Dev pipeline (orchestrator)

1. **Worktree** — `git worktree add` a new branch (Linear `branchName`) off the
   repo's default branch. The user's working copy and the default branch are never
   touched.
2. **Agent (dev profile)** — only this mode gets `Edit/Write/Bash`. Agent edits
   code, writes `pr.md` (line 1 = title, rest = body) and `commit.txt`. It does NOT
   push or open a PR.
3. **(optional) verify** — per-repo command; failure aborts before any PR.
4. **Deterministic finalize** — `git status` (no changes → abort+report);
   `git add -A` + commit (sanitized message); `git push -u origin <branch>`;
   `gh pr create --draft` (sanitized `pr.md` body + Linear issue link). Re-runs
   reuse the branch and update the existing PR.
5. **Report** — Linear comment with PR URL + summary; move to **In Review**.

## Config

`WORKFLOW.md` gains a small routing block; dev execution config lives in a separate
`DEV.md` (mirrors `LIBRARIAN.md`).

```yaml
# WORKFLOW.md
dev:
  enabled: false                     # master switch; OFF = 100% current behavior
  path: DEV.md
  dev_labels: [dev, feature, bug, fix]
  answer_labels: [question, answer, docs]
  done_state: In Review
```

```yaml
# DEV.md front matter
classifier:
  command: claude -p --model sonnet --output-format stream-json --verbose
repos:
  - { name: <repo>, path: <abs>, labels: [ios], base: '', verify: '' }
worktree_root: ./symphony_worktrees
pr:
  draft: true
  strip_patterns: ['Co-Authored-By:.*Claude', 'Generated with.*Claude', '🤖']
agent:
  stall_timeout_ms: 1800000
claude:
  command: claude -p --model {{ model }} --permission-mode acceptEdits --allowedTools Read,Grep,Glob,Edit,Write,Bash --output-format stream-json --verbose
# (prompt body below)
```

## Safety model

- **Master switch** `dev.enabled` (default false): off → classifier never runs, all
  tickets take the existing read-only path (fully backward compatible).
- **Two tool profiles**: answer = read-only (`Read/Grep/Glob/Write`); dev adds
  `Edit/Write/Bash`. Selected strictly by mode.
- **Isolation**: dev writes happen only in a throwaway worktree + new branch.
- **Draft only, never merged**; push only to a feature branch (orchestrator enforces
  `branch != default`). In Review = explicit human gate.
- **Attribution stripped** deterministically from commit + PR body.
- Unchanged: `ANTHROPIC_API_KEY` stripped, `LINEAR_API_KEY` redacted, `gh` uses
  existing auth.

## Modules (`src/dev/`)

- `types.ts` — `DevConfig`, `DevRepo`.
- `config.ts` — `loadDevConfig(path)` (DEV.md front matter + prompt body).
- `classify.ts` — pure `classifyByLabels`, `selectRepoByLabels`; async `runClassifier`.
- `sanitize.ts` — pure `sanitizeMessage(text, patterns)`.
- `git.ts` — worktree/commit/push helpers (real git, `execFileSync`).
- `pr.ts` — `gh pr create --draft` / existing-PR lookup.
- `pipeline.ts` — `runDevPipeline(...)`: worktree → agent → verify → commit → push → PR.

Orchestrator integration: `runWorker` classifies first; dev tickets call
`runDevTicket` (loads DEV.md, runs pipeline, comments + moves to In Review).

## Edge cases

- No file changes → no commit; report "no changes"; leave ticket.
- verify fails → no PR; report failure; leave ticket.
- Branch/PR already exists (re-run, auto-reopen) → push updates; comment "PR updated".

## Testing

- **Unit**: `classifyByLabels`, `selectRepoByLabels`, `sanitizeMessage`.
- **e2e** (offline): fake Linear with a dev ticket (`dev`+`ios` labels → label fast
  path, no classifier needed); a temp git repo + bare `origin`; a fake `gh` stub on
  `PATH` recording `pr create`; a fake agent that edits a file + writes
  `pr.md`/`commit.txt` (with a Claude line + 🤖 to prove stripping). Assert: worktree
  created, branch pushed, draft PR recorded, commit message sanitized, Linear comment
  has the PR URL, ticket → In Review.
