---
# DEV.md — dev-mode execution config (copy to DEV.md; gitignored).
#
# Used only when WORKFLOW.md has `dev.enabled: true`. The agent edits code in an
# isolated git worktree and writes pr.md + commit.txt; the orchestrator then
# commits (sanitized), pushes a feature branch, and opens a DRAFT PR for review.

classifier:
  # Lightweight classifier, invoked ONLY when a ticket has no decisive routing
  # label (or a dev label but no repo label). It just reads the ticket text and
  # writes decision.json — no tools needed. Keep it cheap (Sonnet, no MCP).
  command: claude -p --model sonnet --permission-mode acceptEdits --allowedTools Write --output-format stream-json --verbose

repos:
  # One entry per repo Symphony may develop in. `labels` route a ticket to a repo
  # (e.g. an `ios` label → the iOS repo). With a single repo, no label is needed.
  - name: your-ios-repo
    path: /path/to/your-ios-repo      # absolute path to the local git checkout
    labels: [ios]
    base: ''                          # base branch; empty = the repo's default (origin/HEAD)
    verify: ''                        # optional: command run in the worktree before the PR; non-zero aborts. e.g. 'swiftlint lint --quiet'
  - name: your-android-repo
    path: /path/to/your-android-repo
    labels: [android]
    base: ''
    verify: ''

# Where per-ticket worktrees are created (relative to this file or absolute).
worktree_root: ./symphony_worktrees

pr:
  draft: true                          # always open as Draft for human review
  # Lines matching these regexes are removed from commit messages AND PR bodies.
  # Common AI trailers (Co-Authored-By: Claude, "Generated with Claude Code", 🤖)
  # are ALWAYS stripped; these are extra patterns on top of that.
  strip_patterns: []

agent:
  stall_timeout_ms: 1800000            # dev runs are longer than answers (30 min)

claude:
  # Dev profile: this mode adds Edit/Write/Bash so the agent can actually change
  # code. It must NOT push or open a PR (the orchestrator does that). {{ model }}
  # is resolved per-ticket (agent.model / heavy_model in WORKFLOW.md).
  command: claude -p --model {{ model }} --setting-sources user --permission-mode acceptEdits --allowedTools Read,Grep,Glob,Edit,Write,Bash --output-format stream-json --verbose
---
당신은 이 git worktree에서 Linear 이슈를 **직접 구현**합니다.

이슈 {{ issue.identifier }}: {{ issue.title }}

요구사항:
{{ issue.description }}

작업 순서:
1. 먼저 코드베이스를 읽고 기존 패턴·컨벤션을 파악하세요 (Read/Grep/Glob).
2. 요구사항을 충족하는 **최소한의** 변경을 구현하세요. 주변 코드 스타일을 그대로 따르세요.
3. 변경을 끝낸 뒤:
   - `pr.md` 작성 — **1번째 줄 = PR 제목**, 그 아래 = PR 본문(무엇을·왜 바꿨는지, 리뷰 포인트, 테스트 방법).
   - `commit.txt` 작성 — conventional-commit 형식의 커밋 메시지(제목 줄 + 본문).

규칙:
- **git push / PR 생성은 하지 마세요.** 커밋·푸시·Draft PR은 오케스트레이터가 처리합니다.
- 커밋 메시지·PR 본문에 AI/도구 관련 흔적(예: "Generated with...", "Co-Authored-By", 🤖)을 넣지 마세요. (자동 제거되지만 애초에 넣지 말 것.)
- 요구사항과 무관한 리팩터링은 하지 마세요. 범위를 좁게 유지하세요.
- 확신이 없으면 추측해서 광범위하게 고치지 말고, `pr.md` 본문에 불확실한 부분을 명시하세요.
