# Design: Knowledge Curation ("Librarian") — Obsidian Decision Layer

- **Date:** 2026-06-23
- **Status:** Approved (design); pending implementation plan
- **Component of:** Symphony orchestrator (`/path/to/symphony-librarian`)

## 1. Problem & Goal

Symphony answers Linear questions from the **codebase** (+ optionally a wiki and
explicitly-linked Slack/Notion). But many correct answers depend on **past
decisions and hidden context** that are **scattered across Slack/Notion history**
and not traceable to a single linked source. Searching that history **live, on
every question** is slow and has poor recall.

**Goal:** build a curated, searchable **decision layer** in the Obsidian vault so
Symphony can ground answers in distilled past decisions via fast local grep. The
expensive "search the scattered sources" work happens **once per decision at
curation time**, not on every answer.

**Key reframe:** the vault is a **curated decision log**, NOT a cache/dump of
Slack/Notion. Value = distilled decisions/rules with source links, not raw message
archives. Scale target: **dozens to low hundreds** of notes → Obsidian + grep is
sufficient (no embeddings/vector index needed).

## 2. Non-Goals

- Not a raw mirror of Slack/Notion (no bulk message dumping).
- Not a vector/RAG index (volume is small; grep over curated notes suffices).
- Librarian does **not** read or modify code (that is Symphony's domain).
- Not a 24/7 daemon — curation is an **episodic batch command**.
- No write-back to Slack/Notion (read-only there).

## 3. Architecture

Two roles with **opposite write permissions**, connected only through the vault:

```
Symphony (Reader, existing)
  reads: code + vault (./wiki, READ-ONLY) + linked Slack/Notion (live)
  emits: answer.md / Linear comment + "추가 확인 필요" knowledge gaps
        │ gaps (topics)
        ▼
  Curation queue  ◄── Bootstrap CLI (B): operator supplies topics
        │
        ▼
Librarian (Writer, NEW)
  reads: Slack + Notion (SEARCH across history) + existing vault
  writes: distilled, classified decision notes INTO the vault
  never touches code
        │ new/updated notes
        ▼
  vault → Symphony grabs them on the next question (loop closes)
```

### Components
1. **Librarian worker** — per queue item, runs a Claude Code CLI agent with
   Slack/Notion **read** tools + vault **Write/Edit**. Separate config
   (`LIBRARIAN.md`) and command (`npm run curate`) from Symphony.
2. **Curation queue** — `.symphony/curation_queue.jsonl`, append-only:
   `{ topic, origin: "bootstrap"|"gap", source_hint?, status: "pending"|"done", enqueued_at }`.
   Enqueue **dedups**: skip if an identical pending topic exists OR a vault note
   already covers it.
3. **Vault** — the only interface between the two roles.

### Relationship to Symphony
Same repo and harness style (Claude CLI subprocess, WORKFLOW-style config,
reused `config`/`logger`/`env`/`template`/`agent` modules where practical), but
**permissions are inverted**: Symphony = vault read-only / Librarian = vault write,
no code access.

### Scope split
- **v1:** Librarian core (search → distill → write → dedup) + Bootstrap (B) +
  gap harvesting from produced answers (A, semi-automatic) + manual draft review.
- **v2 (later):** Symphony auto-appends gaps to the queue at completion; `cron`
  runs `npm run curate` for unattended top-up.

## 4. Note Format, Taxonomy, Dedup

### Note format (frontmatter + body)
Filename = human-readable slug (Symphony cites note title/path), e.g.
`decisions/deeplink-path-routing.md`:

```markdown
---
title: 딥링크는 path 기반 라우팅
type: decision              # decision | domain-rule | integration | glossary
status: active              # active | superseded | draft
tags: [deeplink, routing, ios]
aliases: [딥링크 라우팅, deeplink path]
decided: 2024-03-15
updated: 2026-06-23
sources:
  - slack: https://…/archives/…/p…
  - notion: https://www.notion.so/…
supersedes: []
---

## 결론
## 배경/이유   (context the code cannot reveal)
## 세부 규칙/예외
## 출처
## 변경 이력
```

### Taxonomy (folders = type; small & fixed, extensible)
- `decisions/` — decision records (the "why")
- `domain-rules/` — hidden business rules
- `integrations/` — external integration contracts (e.g. Airbridge)
- `glossary/` — domain terms
- `_index.md` — MOC, updated when a note is added
- `_inbox/` — draft area (see Safety), **excluded from Symphony's read path**

### Dedup / update (gap-driven revisits the same topic often)
Before writing, the Librarian greps the vault by title/aliases/tags:
1. **Match + consistent** → **update** (merge details, refresh `updated`, append
   source, add a 변경 이력 line) via **Edit (merge, not overwrite)**.
2. **Match + contradicts/supersedes** → update with the new conclusion; old
   conclusion moves to 변경 이력; `status`/`decided` capture recency.
3. **No match** → create one new note in the correct folder.

One topic = one note (consolidate scattered fragments). No note sprawl.

## 5. Triggers

Curation is a **batch command** (not a daemon): enqueue → drain queue → exit.

```bash
# B) Bootstrap — operator names key topics (no channel needed; agent searches)
npm run curate -- --topics "딥링크 라우팅, 결제 정산, 푸시 알림 정책"
npm run curate -- --topics-file topics.txt

# A) Gap-driven (v1) — harvest "추가 확인 필요" sections from produced answers
npm run curate -- --from-answers ~/symphony_answers

# Drain pending queue only
npm run curate
```

- `--topics` / `--from-answers` enqueue (with dedup) then immediately process.
- Processing: one Librarian agent run per pending topic (concurrency 1, since it
  writes the vault); mark `done` on success.
- **A is near-automatic in v1**: Symphony answers already contain a
  `## 불확실하거나 추가 확인이 필요한 부분` section; `--from-answers` parses it →
  topics → queue. No Symphony code change needed (zero coupling).

## 6. Safety & Review

### Write boundary
- cwd = vault root; `--allowedTools Read,Grep,Glob,Write,Edit` (Read/Grep/Glob are
  needed to dedup-search the vault and to Edit-merge existing notes) + Slack/Notion
  read tools. **No Bash → no `rm`/deletion.**
- **Path containment:** reject writes outside the vault root (same invariant
  style as Symphony's workspace containment).
- **No code access** in the Librarian workspace (no `./codebase`).
- **Updates use Edit-merge**, never blind overwrite → never clobber
  hand-authored notes.

### Review gate (prevents hallucinated knowledge from polluting answers)
- Default **draft-first**: Librarian writes to `vault/_inbox/`; **Symphony does
  not read `_inbox/`** (excluded in its prompt). The operator reviews in Obsidian
  and moves the note to the correct folder to "promote" it; only then does
  Symphony use it.
- Toggle `review_mode: draft | direct` (default **draft**). Switch to `direct`
  once trust is established.

### Source & privacy (the vault may be synced/shared)
- Slack/Notion **read-only** (no posting). **Distill, do not bulk-copy**; keep a
  decision summary + **source links**.
- Do not store secrets / PII / private raw content in the vault (prompt-enforced).

### Operational
- Env hygiene identical to Symphony: `ANTHROPIC_API_KEY` stripped, no LINEAR key
  needed, secrets never logged.
- Structured logs: `curation_started`, `note_written`, `note_updated`,
  `note_skipped` (dedup), `curation_failed`, including sources used.
- **Idempotent re-runs**: dedup + queue `done` → safe to run repeatedly.

## 7. Configuration (`LIBRARIAN.md`)

YAML front matter + a distillation prompt template (mirrors Symphony's
WORKFLOW.md structure). Sketch:

```yaml
---
vault:
  path: /Users/me/ObsidianVault   # absolute; the write target
  inbox: _inbox                   # draft folder, excluded from Symphony reads
  taxonomy: [decisions, domain-rules, integrations, glossary]
review_mode: draft                # draft | direct
sources:
  slack: true                     # via claude.ai Slack connector (read tools)
  notion: true                    # via claude.ai Notion connector (read tools)
queue:
  path: .symphony/curation_queue.jsonl
agent:
  model: sonnet
  stall_timeout_ms: 600000
claude:
  command: claude -p --model {{ model }} --setting-sources user --permission-mode default
    --allowedTools Read,Grep,Glob,Write,Edit,mcp__claude_ai_Slack__slack_search_public,mcp__claude_ai_Slack__slack_read_thread,mcp__claude_ai_Slack__slack_read_channel,mcp__claude_ai_Notion__notion-search,mcp__claude_ai_Notion__notion-fetch
    --output-format stream-json --verbose
---
You are a knowledge librarian. Curate ONE decision note for the topic: {{ topic }}.
Search Slack and Notion for scattered evidence about this topic, gather and
reconcile it (prefer the most recent decision; note supersessions), then write a
single classified note into the vault following the house format. Check the vault
first for an existing note on this topic and UPDATE it (Edit-merge) instead of
creating a duplicate. Cite every claim with a Slack/Notion source link. Do NOT
copy raw private content; distill. READ-ONLY on Slack/Notion (never post).
```

Note: a small Symphony-side change accompanies v1 — its prompt is told to ignore
`./wiki/_inbox/` so unreviewed drafts never become answer evidence.

## 8. Logging Events
`curation_started`, `topic_enqueued`, `note_written`, `note_updated`,
`note_skipped` (with reason: dedup/no-evidence), `curation_failed`, plus the
source links consulted. Topic identifier included in every line.

## 9. v1 Acceptance Criteria
1. `npm run build` passes.
2. `npm run curate -- --topics "<topic>"` runs a Librarian agent that searches
   Slack/Notion and writes a classified draft note into `vault/_inbox/` with
   correct frontmatter + source links.
3. Running the same topic again **updates** (not duplicates) the note.
4. `npm run curate -- --from-answers <dir>` harvests gap topics from answer files
   and enqueues them (deduped).
5. Writes never escape the vault root; no Bash/delete; Slack/Notion read-only.
6. Symphony excludes `_inbox/` from its evidence.
7. Offline test proves the queue→distill→write→dedup loop with fake Slack/Notion
   tools and a temp vault (mirrors Symphony's e2e harness).

## 10. Open Questions / Future (v2+)
- Auto-enqueue gaps directly from Symphony at completion; scheduled `cron` curate.
- Optional `--from-channels` sweep (decision detection across a channel).
- Promotion helper (`--promote`) vs manual move in Obsidian.
- Periodic staleness re-check of `active` decisions against latest sources.
