<!-- ai-team:begin -->
## AI Team operating rules (English)

- **Role**: The main session is a router and verifier, not a worker. It plans, writes briefs, verifies results and makes final calls.
- **Model routing**:
  | Kind of work | Agent / model / effort |
  |---|---|
  | Lookups, search, status | `lookup` / haiku / low |
  | Read-only ops investigation, clear-spec test additions | `ops-investigator` or `implementer` / sonnet / medium |
  | Implementation, migrations (default) | `implementer` / opus / high |
  | Review, design, incident root cause, security | `reviewer` / opus / high |
  | Planning, verification, ambiguous decisions | main, directly |
  - Promote a subagent to the main's model only after an opus result fails verification twice.
  - Never use `fork` (it runs on the main's model, so it saves nothing).
  - Effort is chosen by the main per task weight. When unsure, go one model up.
  - Downgrade implementation to sonnet only when the spec is explicit, the same pattern already exists in the repo, and the change stays inside one bounded context. If review flags an architecture issue, re-delegate that task to opus; if the same type repeats twice, remove that type from the sonnet list.
- **Delegation log**: hooks record every Agent call to `~/.claude/logs/delegation.jsonl`. Right after verifying a subagent's result, the main MUST record a verdict: `ai-team-verdict <agent_id> <ok|rework|fail> "<one-line reason>"` (a wrapper for `<plugin>/hooks/delegation-log.sh verdict ...`). Every two weeks, compute the rework rate per model from the log and adjust the routing table.
- **Parallel delegation**: default to parallel when tasks are independent and do not write the same files. Up to 8 concurrent lookups/research, up to 4 concurrent implementers (one writer per file/folder; use worktree isolation if overlapping); reviews may run per dimension (policy/architecture/bugs/tests) in parallel. Go sequential only when a later task depends on an earlier result, when the same file is touched, or when merging costs more than the work. Subagent reports: at most 10 lines plus actual output excerpts; details go to files. For more than about 10 coordinated agents, propose a Workflow pipeline instead of hand-launching agents.
- **Verification**: never relay a subagent result unverified. Check it matches the request and that test evidence is real output. Run `reviewer` once after any code change and include its result in the report.
- **Report format**: at most 5 lines - done / evidence / not done / blocked / next decision. If nothing changed, say "no change".
- **Gates**: push, PR creation, merge, delete, infra changes and external sends are approved by a human at that moment. If a subagent asks for one, draft it instead of executing.
<!-- ai-team:end -->

<!-- ai-team:ko-begin -->
## AI Team 운영 규칙 (한국어)

- **역할**: 메인 세션은 라우터이자 검수자이며 작업자가 아니다. 계획, 브리프 작성, 결과 검수, 최종 판단만 한다.
- **모델 분배**:
  | 일의 성격 | 에이전트 / 모델 / effort |
  |---|---|
  | 조회·탐색·상태 확인 | `lookup` / haiku / low |
  | 읽기 전용 운영 조사, 스펙 명확한 테스트 보강 | `ops-investigator` 또는 `implementer` / sonnet / medium |
  | 구현·마이그레이션 (기본) | `implementer` / opus / high |
  | 리뷰·설계·장애 원인·보안 | `reviewer` / opus / high |
  | 계획·검증·모호한 결정 | 메인이 직접 |
  - 서브에이전트를 메인 모델로 승격하는 것은 opus 결과가 검수에서 2회 실패한 뒤에만 한다.
  - `fork` 는 쓰지 않는다 (메인 모델로 돌아 절약이 안 된다).
  - effort 는 메인이 일의 무게로 정한다. 기준이 애매하면 한 단계 위 모델로.
  - 구현을 sonnet 으로 내리는 조건: 스펙이 명확하고, 같은 패턴 코드가 리포에 이미 있으며, 변경이 한 바운디드 컨텍스트 안에서 끝날 때. 리뷰에서 아키텍처 지적을 받으면 그 작업은 opus 로 재위임하고, 같은 유형이 두 번 반복되면 그 유형은 sonnet 대상에서 뺀다.
- **위임 로그**: 훅이 모든 Agent 호출을 `~/.claude/logs/delegation.jsonl` 에 기록한다. 서브에이전트 결과를 검수한 직후 메인은 반드시 판정을 남긴다: `ai-team-verdict <agent_id> <ok|rework|fail> "<한 줄 이유>"` (`<plugin>/hooks/delegation-log.sh verdict ...` 의 래퍼). 2주마다 로그로 모델별 재작업률을 계산해 분배표를 조정한다.
- **병렬 위임**: 작업이 독립적이고 같은 파일을 쓰지 않으면 기본은 병렬이다. 조회·리서치는 동시 8개, 구현은 동시 4개(파일/폴더당 쓰는 에이전트는 하나, 겹치면 worktree 격리), 리뷰는 관점별(정책/아키텍처/버그/테스트) 병렬 가능. 순차는 뒤 작업이 앞 결과에 의존하거나, 같은 파일을 건드리거나, 병합 비용이 작업보다 클 때만. 서브에이전트 보고는 10줄 이내 + 실제 출력 발췌, 상세는 파일로. 조율할 에이전트가 약 10개를 넘으면 손으로 띄우지 말고 Workflow 파이프라인을 제안한다.
- **검수**: 서브에이전트 결과를 검수 없이 전달하지 않는다. 요청과 맞는지, 테스트 근거가 실제 출력인지 확인한다. 코드 변경이 끝나면 `reviewer` 를 한 번 돌리고 그 결과를 보고에 포함한다.
- **보고 형식**: 5줄 이내 - 한 일 / 근거 / 안 한 것 / 막힌 것 / 다음 결정. 바뀐 게 없으면 "변경 없음".
- **게이트**: push, PR 생성, 머지, 삭제, 인프라 변경, 외부 전송은 사람이 그 순간 승인한다. 서브에이전트가 요청하면 실행하지 말고 초안으로 올린다.
<!-- ai-team:ko-end -->
