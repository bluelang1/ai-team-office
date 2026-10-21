# AI Team Office — 실시간 에이전트 대시보드 설계 (2026-10-21)

## 목적
Claude Code 메인 세션(Fable)과 서브에이전트(opus/sonnet/haiku)가 **지금 무엇을 하고 있는지**를
"회사 사무실" 메타포로 실시간 시각화한다. 새 운영 규칙(모델 분배·위임 로그·판정)이 실제로 지켜지는지
한눈에 보이는 것이 1차 목표, 보기 좋고 귀엽고 부드러운 것이 2차 목표.

## 데이터 소스 (이미 설치됨, 수정 금지)
- `~/.claude/logs/office-events.jsonl` — 훅 `~/.claude/hooks/office-events.sh` 가 12개 이벤트에서 1줄씩 append.
  필드: `ts ev sid proj cwd aid atype tool effort mode dur target sub{type,model,effort,desc,prompt} child resolved prompt msg ntype trigger ok err`
  - `aid` 없음 = 메인 세션 자신의 활동. `aid` 있음 = 그 서브에이전트의 활동.
  - `ev=PreToolUse tool=Agent` 의 `sub` = 위임 의도(모델/effort). 직후 `PostToolUse` 의 `child`/`resolved` = 실제 agent_id/실제 모델.
  - `SubagentStart/Stop` 에 `aid atype`. Stop 에 `msg`(마지막 메시지 머리).
  - `Notification ntype=permission_prompt` 또는 `PermissionRequest` = 사람 승인 대기.
  - `UserPromptSubmit prompt` = 사람이 지시함. `Stop` = 메인 턴 종료(대기).
- `~/.claude/logs/delegation.jsonl` — 위임 요약 + `event=verdict`(ok/rework/fail, note). 판정 보드·재작업률 통계용.
- 로그는 append-only, 여러 세션이 동시에 쓴다. 서버는 파일을 tail 하고 세션별로 분리해 보여준다.

## 상태 머신 (에이전트 1명 = 캐릭터 1명)
| 상태 | 트리거 | 장소 |
|---|---|---|
| idle/waiting | Stop, SessionStart, SubagentStop 후 | 자기 책상, 숨쉬기 애니 |
| thinking | UserPromptSubmit 후 첫 도구 전, 또는 PostToolUse 후 다음 PreToolUse 전 3초 이상 | 책상, 턱 괴기 + 말풍선 "…" |
| reading | PreToolUse Read/Grep/Glob/LSP/WebFetch/WebSearch/ToolSearch | 자료실, 책 펼침. target 을 말풍선에 |
| running | PreToolUse Bash | 서버실 랙 앞, 랙 LED 깜빡임. 명령 머리를 말풍선에 |
| writing | PreToolUse Edit/Write/NotebookEdit | 작업대, 타이핑. 파일명 |
| delegating | PreToolUse Agent (메인만) | 회의실로 이동, 호출 → 엘리베이터 문 열림, 새 캐릭터 등장 |
| reviewing | atype=code-reviewer 활동 중 | 검수실 |
| blocked | PermissionRequest / Notification permission_prompt | 책상에서 손 들기, 빨간 배지 "승인 대기" |
| failed | PostToolUseFailure | 머리 위 번개, 잠깐 |
| leaving | SubagentStop | 엘리베이터로 걸어가 퇴장 (verdict 가 있으면 ok=초록 스탬프, rework=노랑, fail=빨강) |

## 캐릭터 규칙
- 모델별 색/모자: fable=보라(메인, 넥타이), opus=남색, sonnet=청록, haiku=노랑. effort 는 머리 위 작은 점 1~4개.
- 이름표: `atype` (lookup / code-reviewer / implementer / Explore …) + 짧은 aid 4자.
- 메인(Fable)은 항상 사무실 중앙 큰 책상. 서브는 엘리베이터로 도착해 빈 책상에 앉음.
- 세션(sid) 여러 개 = 층(floor) 여러 개. 상단 탭으로 층 전환, 기본은 가장 최근 활동 층.

## 레이아웃 (데스크톱 기준, 1280 이상)
- 좌 70%: 사무실 씬 (SVG/DOM 스프라이트 또는 canvas). 방: 중앙 책상(메인), 책상 4~6개(서브), 자료실, 서버실, 작업대, 회의실, 검수실, 엘리베이터.
- 우 30%: 패널 3단
  1. **지금** — 활동 중인 에이전트 카드(모델 배지·effort·현재 상태·경과 시간·마지막 target)
  2. **위임 로그** — 최근 위임 (누가→누구, 의도 모델 vs 실제 모델 일치 여부 ✓/✗, 소요, 판정 스탬프)
  3. **오늘 통계** — 모델별 위임 수·판정 분포(ok/rework/fail)·평균 소요, Fable 직접 도구 호출 수 vs 위임 수
- 하단 띠: 이벤트 티커(최근 30개, 새 항목이 왼쪽에서 슬라이드 인).
- 모바일/좁은 폭: 씬 위, 패널 아래로 스택.

## 기술
- 서버: Node 24 단일 파일 `office/server.mjs`, 의존성 0. 정적 파일 + `GET /events` SSE. 시작 시 오늘치 로그 리플레이 후 tail(fs.watch + 폴링 fallback). 포트 4747.
- 프런트: `office/public/index.html` + `app.js` + `style.css`. 프레임워크 없이 바닐라. 애니메이션은 CSS transition/keyframes + requestAnimationFrame 이동. prefers-reduced-motion 존중.
- 실행: `node office/server.mjs` → http://localhost:4747 . `office/start.sh` 로 백그라운드 시작/중지.
- 테스트: `office/test/replay.mjs` 가 샘플 jsonl 을 빠르게 재생해 상태 머신 단위 검증(node:test).

## 품질 기준 (검수 체크리스트)
- [ ] 이 세션에서 lookup 위임을 1번 하면 10초 안에 엘리베이터→자료실→퇴장이 보인다.
- [ ] 의도 모델(haiku)과 실제 모델(claude-haiku-5-5) 일치가 위임 로그에 ✓ 로 표시된다.
- [ ] 메인이 직접 Bash 를 치면 중앙 캐릭터가 서버실로 간다.
- [ ] 승인 대기 시 빨간 배지가 뜨고 해제되면 사라진다.
- [ ] 로그 파일이 없거나 비어도 빈 사무실이 뜬다(에러 없음).
- [ ] 60fps 근처, CPU 5% 이하(idle). 이벤트 폭주(초당 20개)에도 UI 멈춤 없음.
- [ ] 다크/라이트 모두 보기 좋음.

## 시장 조사 반영 (조사 결과 도착 후 채움)
(아래 "참고 구현 비교" 절 참조)

## 참고 구현 비교 (2026-10-21 조사, 14개)
| 가져올 것 | 출처 | 우리 적용 |
|---|---|---|
| 도구→방 매핑 + Bash 명령 내용으로 세분류 (`rg/cat`=자료실, `sed -i`=작업대, `curl/gh/aws`=외부창구, `gradlew test/npm test`=서버실) | @cowboy76 원글 | 리듀서에 `classify(tool, target)` 한 함수로 |
| 이벤트→씬 상태를 **리듀서 하나**로, 픽스처 리플레이로 테스트 | W17ant/Claude-Office `officeReducer.ts` | `public/reducer.js` 를 서버·브라우저·테스트가 공유 |
| 정직한 상태: 관측(observed)/추정(inferred)/오래됨(stale) 표기, 45초 침묵=생각 중(막힌 게 아님), 5분 무활동=퇴근 | KbWen/agent-virtual-office | 캐릭터 이름표 옆 작은 점 색으로 |
| 사람 필요 신호: 손 들기 + 호박색 필 + (옵션) 차임·브라우저 알림 | Cubicle, Claude-Office | 기본 무음, 상단 토글 |
| 막힘 타이머: 한 명령 1분 넘으면 호박색, 3분 침묵이면 💤, 실패 카운터 | Agent Standup | 카드 배지 |
| 프로젝트=층, 세션=방 | @cowboy76, Pixel Agents areas | 상단 층 탭(proj), 방 탭(sid 앞 4자) |
| 리플레이·시뮬레이터 (`--replay file --speed 20`, `?sim=1`) | Claude Quest, ClaudeVille | 데모·테스트·발표용 |
| 스프라이트를 코드로 생성(이미지 자산 0) | alminisl/agent-office, Cubicle | CSS/SVG 캐릭터. 외부 이미지 금지 |
| 엘리베이터 등·퇴장 | @cowboy76, alminisl | 위임 시작/종료 |
| 안전: 127.0.0.1 바인딩, 읽기 전용, 토큰 0 소모, 경로 가리기 옵션 | Cubicle `--redact`, Claude-Office | `--redact` 는 홈 경로를 `~` 로, 명령 인자 마스킹 |
| 가짜 활동 금지(랜덤 이벤트·잡담 없음) | agent-virtual-office 원칙 | idle 애니는 숨쉬기·커피 정도만, 상태와 무관함을 명확히 |

**우리만의 차별점**(다른 구현에 없음): 모델 분배 준수 계기판. 위임마다 "의도 모델 vs 실제 모델" ✓/✗, 메인(Fable) 직접 도구 호출 비율, 판정(ok/rework/fail) 스탬프와 모델별 재작업률. 이게 이 대시보드의 존재 이유다.

**피할 것**: 터미널 텍스트 스크래핑(깨짐), 프롬프트에 뭔가 주입하는 것(행동 변화), LAN 노출, 컨텍스트 사용량 표시(훅 페이로드에 없음 → v1 제외), 무거운 프레임워크(유지보수 비용으로 죽은 프로젝트 다수).
