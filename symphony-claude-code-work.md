# 작업 지시서: Symphony 오케스트레이터 구축 (코드베이스 + 위키 Q&A 전용)

> Claude Code에 이 파일 내용을 붙여넣어 사용한다.
> 채울 곳: `team_key`, `after_create`의 레포 주소.
> 사전 준비: `claude setup-token`(구독 인증) 1회, `LINEAR_API_KEY` export.
> (`wiki.vault_path`는 일단 비워두면 코드베이스 전용으로 동작한다.)

---

## 목표
openai/symphony의 SPEC.md를 따라, Linear 보드를 감시하다가 코드베이스에 관한
질문 이슈를 자동으로 집어 답변하는 오케스트레이터를 만든다.
이 구현은 코드를 수정하지 않으며(read-only), 답변은 PR이 아니라 로컬 파일로 산출한다.
답변 근거로 코드베이스와 함께 Obsidian 위키(vault)를 사용한다. (위키는 나중에 붙여도 됨)

## 참조 스펙 (먼저 읽을 것)
- https://github.com/openai/symphony/blob/main/SPEC.md
이 스펙을 먼저 읽고, MUST/SHOULD 요구사항을 충족하도록 구현한다.

## 기술 스택
- TypeScript + Node.js (22+)
- 설정 파일: WORKFLOW.md 한 개 (상단 YAML front-matter + 하단 프롬프트 템플릿)
- 외부 의존성은 최소화

## 핵심 동작 (오케스트레이터 루프 — 끄기 전까지 무한 반복)
1. Linear API 폴링 (기본 10초 간격, 설정으로 변경 가능)
2. active_states 상태의 이슈 감지
3. 이슈별 격리 워크스페이스 디렉터리 생성: {workspace.root}/{issue.identifier}
4. after_create 훅 실행 (답변 근거가 될 코드베이스 clone)
5. 워크스페이스 안에서 에이전트 명령 실행. 프롬프트 템플릿의 플레이스홀더를
   실제 이슈 데이터로 치환해 전달
6. 에이전트 모니터링: 정상 종료 시 완료 처리, stall_timeout_ms 초과 시 종료 후 재시작
7. after_run 훅 실행
8. 이슈를 done_state로 이동
9. 1번으로 돌아가 반복
- 동시 실행 개수는 agent.max_concurrent_agents를 준수
- 이미 처리 중이거나 완료한 이슈는 중복 디스패치하지 않을 것 (멱등성 보장)
- 주요 이벤트는 구조적 로그로 남길 것: worker_dispatched / worker_completed /
  worker_failed / worker_restarted (이슈 식별자 포함)

## 위키(vault) 연결 — 이번 구현의 추가사항 (나중에 채워도 됨)
- 답변 근거 소스는 두 개다: (1) 클론된 코드베이스, (2) Obsidian vault.
- vault는 설정값(wiki.vault_path)으로 경로를 받아, 워크스페이스에 읽기 전용으로
  접근 가능하게 한다. vault 경로는 코드베이스와 무관하게 임의 위치일 수 있다.
- 마운트/링크 방식은 OS 심볼릭 링크나 읽기 전용 바인드 등 가장 단순한 방법을 쓰되,
  에이전트가 vault 내 .md 파일을 grep/읽기로 탐색할 수 있으면 된다.
- vault는 절대 수정/생성/삭제하지 않는다 (완전 읽기 전용).
- vault 경로가 설정에 없거나 비어 있으면, 위키 없이 코드베이스만으로 동작한다.

## 설정 스키마 (WORKFLOW.md 예시 — 이 형식으로 동작하게 구현)
```
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY      # 환경변수에서만 읽기
  team_key: ZZ                  # 내가 실제 값으로 교체
  done_state: Done
  active_states:
    - Todo
    - In Progress
  poll_interval_sec: 10

workspace:
  root: ./symphony_workspaces

wiki:
  vault_path:                   # 일단 비워둠 → 코드베이스 전용. 나중에 vault 경로 채우기. 읽기 전용.

agent:
  max_concurrent_agents: 1
  stall_timeout_ms: 600000

claude:
  command: claude -p --permission-mode dontAsk --output-format stream-json --verbose

hooks:
  after_create: |
    gh repo clone Your-Org/your-repo .    # 내가 실제 레포로 교체
  after_run: |
    mkdir -p ~/symphony_answers
    cp answer.md ~/symphony_answers/{{ issue.identifier }}-$(date +%Y%m%d-%H%M).md \
      || echo "no answer.md produced for {{ issue.identifier }}"
---
You are answering a question about the codebase. Linear issue {{ issue.identifier }}: {{ issue.title }}

Question:
{{ issue.description }}

You have read-only evidence sources in this workspace:
1. The cloned codebase (source files).
2. (If present) The Obsidian wiki vault (markdown notes) — historical decisions,
   hidden business rules, and context that the code alone does not reveal.
Search the codebase, and the wiki if it is present. When code and wiki disagree,
note the discrepancy.

Rules:
- READ-ONLY. Do NOT modify, create (except answer.md), or delete any source file or wiki note.
- Ground every claim in evidence. Cite file paths with line numbers for code claims,
  and note titles/paths for wiki claims.
- If you cannot find supporting evidence, say so explicitly instead of guessing.

Write your answer to a file named `answer.md` in the workspace root, in this structure:
## 질문 요약
## 결론
## 근거   (코드: 파일:라인 / 위키: 노트 제목·경로 / 링크 / URL)
## 불확실하거나 추가 확인이 필요한 부분
```

## 이 구현의 커스터마이징 (중요 — PR 버전과 다름)
- after_run 훅에서 git commit/push/PR 생성을 절대 하지 않는다.
- 완료 산출물 = 워크스페이스 루트에 생성된 answer.md 파일.
- after_run은 answer.md를 ~/symphony_answers 로 타임스탬프 붙여 복사만 한다.
- 실행 에이전트는 Claude Code CLI (위 claude.command).

## 인증 / 비용 (중요)
- Claude Code는 **구독 인증(Pro/Max)** 으로 돌린다. 사전에 `claude setup-token`을 1회 실행한다.
- `ANTHROPIC_API_KEY`는 환경에서 반드시 unset 한다. 키가 있으면 종량제(캡 없음)로 우선 적용되어,
  long-running 폴링 루프가 큰 비용을 낼 수 있다.
- 에이전트 서브프로세스에 `ANTHROPIC_API_KEY`가 새어들지 않도록 환경을 정리한다.
- 기본 모델은 Sonnet으로 두고, 무거운 티켓에만 Opus를 쓴다.
- (확인) `claude` 실행 후 `/cost`로 구독 플랜이 잡히는지 검증한다.

## 안전 제약
- 클론된 코드베이스와 vault는 모두 읽기 전용으로 취급한다.
  answer.md 외의 파일 생성/수정/삭제 금지.
- max_concurrent_agents 기본값 1.
- 모든 토큰(LINEAR_API_KEY 등)은 환경변수에서만 읽고, 로그에 절대 출력하지 않는다.
  ANTHROPIC_API_KEY는 사용하지 않는다(구독 인증 사용).
- 에이전트 서브프로세스에 불필요한 환경변수를 상속시키지 않는다.

## 확장성 (지금 말고 나중에)
- 1차 버전의 근거 소스는 "코드베이스 grep/읽기" (+ 선택적으로 vault 읽기)만 지원한다.
- 나중에 Obsidian MCP 서버나 Slack(MCP), 웹검색을 추가할 수 있도록,
  에이전트 명령과 프롬프트 템플릿을 코드에서 분리해 WORKFLOW.md에 둔다.

## 최종 산출물
- 소스 코드
- 위 커스터마이징을 반영한 WORKFLOW.md 예시
- README.md: 설치 / 인증(claude setup-token, 구독) / 환경변수(LINEAR_API_KEY) / vault 경로 설정법 / 실행 명령 / 끄는 법
- 단일 명령으로 시작 가능하게 (예: `npm start` 또는 `node dist/cli.js --workflow WORKFLOW.md`)

## 진행 방식
먼저 SPEC.md를 읽고 구현 계획을 짧게 요약해 보여준 뒤, 내 확인을 받고 구현을 시작하라.
