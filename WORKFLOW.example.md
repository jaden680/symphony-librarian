---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY        # read ONLY from the environment; never inline a key
  team_key: ZZ                   # issues look like JAY-1, JAY-2, ...
  done_state: Done
  start_state: In Progress        # move the issue here when the agent starts (empty = no start transition)
  active_states:
    - Todo
    - In Progress
  poll_interval_sec: 10
  # Set true to also post the produced answer.md back to the issue as a Linear
  # comment when it completes. Default false (answer stays local). The orchestrator
  # never creates PRs or edits the issue body — only this optional comment.
  post_answer_comment: true

workspace:
  root: ./symphony_workspaces

wiki:
  # Leave empty to run codebase-only. To enable the wiki, set an absolute path to
  # your Obsidian vault. It is mounted READ-ONLY (symlink) at ./wiki inside each
  # workspace. The vault is never modified, created, or deleted.
  vault_path: /path/to/ObsidianVault   # dedicated Symphony knowledge vault (read-only here)
  mount_name: wiki

curation:
  # When true, harvest each answer's "추가 확인 필요" gaps into the shared curation
  # queue so the Librarian can fill them later. Gaps already covered by a vault note
  # are skipped. The answer's Linear comment also reports what was queued.
  auto_enqueue_gaps: true
  queue_path: .symphony/curation_queue.jsonl
  # In-process auto-drain: >0 makes Symphony itself run the Librarian every N seconds
  # while it is up (no cron needed; stops when Symphony stops). 0 = off (drain
  # manually with `npm run curate`, or via scripts/curate-cron.sh).
  auto_drain_interval_sec: 600    # 10 minutes
  librarian_path: LIBRARIAN.md

agent:
  max_concurrent_agents: 3
  stall_timeout_ms: 600000        # kill + restart an agent after 10 min of no output
  max_attempts: 3                 # initial attempt + retries/restarts per issue (this run)
  # Per-ticket model routing: default to `model`, but switch to `heavy_model`
  # when the issue carries any label in `heavy_labels`. The chosen value is
  # injected into claude.command as {{ model }}.
  model: sonnet
  heavy_model: opus
  heavy_labels:                   # add a label like "opus" or "deep" to a Linear issue to use Opus
    - opus
    - heavy
    - deep

claude:
  # Subscription auth (Pro/Max). Run `claude setup-token` once beforehand and keep
  # ANTHROPIC_API_KEY unset. The orchestrator launches: bash -lc "<command>".
  #
  # Read-only safe: only Read/Grep/Glob (investigate) and Write (answer.md) are
  # auto-allowed — Bash and Edit are NOT, so the agent cannot modify or run
  # commands against the symlinked source repos. Non-allowed tools fail (they do
  # not hang the non-interactive run).
  # {{ model }} is resolved per ticket from agent.model / agent.heavy_model below
  # (label-based routing): default Sonnet, Opus only for heavy-labeled tickets.
  #
  # Slack: `--setting-sources user` loads the user's claude.ai Slack connector so
  # the agent can read threads referenced in an issue. Only READ tools are allowed
  # (no send/post). Trade-off: this also loads your other user MCP servers and
  # global settings, so it is a bit heavier. To run lean/codebase-only, drop
  # `--setting-sources user` and the mcp__claude_ai_Slack__* entries.
  command: claude -p --model {{ model }} --setting-sources user --permission-mode default --allowedTools Read,Grep,Glob,Write,mcp__claude_ai_Slack__slack_search_public,mcp__claude_ai_Slack__slack_search_public_and_private,mcp__claude_ai_Slack__slack_read_thread,mcp__claude_ai_Slack__slack_read_channel,mcp__claude_ai_Slack__slack_read_user_profile,mcp__claude_ai_Slack__slack_search_users --output-format stream-json --verbose

hooks:
  timeout_ms: 120000
  # Optional: extra environment variable NAMES to forward to hook subprocesses.
  # Hooks otherwise get a deny-by-default allow-list (PATH/HOME/git/gh/ssh/proxy).
  # env_passthrough:
  #   - MY_EXTRA_TOKEN
  #
  # Issue data is exposed to hooks as SAFE environment variables — prefer these
  # over inlining {{ issue.* }} into a hook (untrusted issue text in a hook is
  # auto shell-escaped, but env vars are the clean, recommended path):
  #   $SYMPHONY_ISSUE_IDENTIFIER  $SYMPHONY_ISSUE_TITLE  $SYMPHONY_ISSUE_DESCRIPTION
  #   $SYMPHONY_ISSUE_STATE  $SYMPHONY_ISSUE_URL  $SYMPHONY_ISSUE_BRANCH  $SYMPHONY_ISSUE_PRIORITY
  #
  # Runs once when a workspace is first created. Instead of cloning, expose the
  # existing local repos read-only as symlinks under ./codebase/ (no network, no
  # disk copy). Idempotent via `ln -sfn`.
  after_create: |
    mkdir -p codebase
    ln -sfn "/path/to/your-ios-repo" codebase/your-ios-repo
    ln -sfn "/path/to/your-android-repo" codebase/your-android-repo
  # Runs after each agent attempt. NEVER commits/pushes/opens a PR. It only copies
  # the produced answer.md to ~/symphony_answers with a timestamp.
  after_run: |
    mkdir -p ~/symphony_answers
    cp answer.md "$HOME/symphony_answers/${SYMPHONY_ISSUE_IDENTIFIER}-$(date +%Y%m%d-%H%M).md" \
      || echo "no answer.md produced for ${SYMPHONY_ISSUE_IDENTIFIER}"
---
You are answering a question about the codebase. Linear issue {{ issue.identifier }}: {{ issue.title }}

Question:
{{ issue.description }}

You have read-only evidence sources:
1. The codebases under ./codebase/ — `your-ios-repo` and `your-android-repo` (source files).
2. (If present) The Obsidian wiki vault at ./wiki — markdown notes holding
   historical decisions, hidden business rules, and context the code alone does
   not reveal. IGNORE the ./wiki/_inbox/ folder (unreviewed drafts). If ./wiki
   does not exist, rely on the codebase only.
3. Slack (read-only): if this issue's description references a Slack thread or URL
   (e.g. a slack.com/archives/... link, or a channel/thread mention), use the
   Slack tools to read that thread/channel and use its content as evidence. Cite
   the Slack channel + thread. Do NOT post or send anything to Slack.
Search the relevant codebase under ./codebase/, the wiki if present, and any Slack
thread referenced by the issue. When sources disagree, note the discrepancy.

Rules:
- READ-ONLY. Do NOT modify, create (except answer.md), or delete any source file
  or wiki note. Do not commit, push, or open a pull request.
- Ground every claim in evidence. Cite file paths with line numbers for code
  claims, and note titles/paths for wiki claims.
- If you cannot find supporting evidence, say so explicitly instead of guessing.

Write your answer to a file named `answer.md` in the workspace root, in this structure:
## 질문 요약
## 결론
## 근거   (코드: 파일:라인 / 위키: 노트 제목·경로 / 링크 / URL)
## 불확실하거나 추가 확인이 필요한 부분
