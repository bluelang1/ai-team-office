# AI Team Office

Claude Code 메인 세션(Fable)과 서브에이전트가 지금 무엇을 하는지 사무실 메타포로 보여주는 실시간 대시보드.
설계 계약은 [DESIGN.md](DESIGN.md). 의존성 0, 읽기 전용, 127.0.0.1 에만 바인딩, 토큰 소모 0.

## 실행

```bash
node office/server.mjs                 # http://127.0.0.1:4747
office/start.sh start [flags]          # 백그라운드. pid·로그: ~/.claude/ai-team-office/run/server.{pid,log}
office/start.sh status | stop | restart
node --test office/test/               # 리듀서·서버·사용량 테스트 (node:test)
```

| 플래그 | 뜻 |
|---|---|
| `--port N` | 포트 (기본 4747) |
| `--replay <file> --speed N` | 로그 대신 jsonl 파일을 N배 빠르게 재생. ts 는 재생 시각으로 바꿔 보냄 (데모·발표용) |
| `--redact` | prompt·sub.prompt·msg·err·cwd 는 아예 빼고 보냄(화면에 안 씀). target 은 `$HOME` → `~`, URL 은 scheme+host+path 만(쿼리·#·계정 제거), Bash 는 첫 토큰만 남기고 `***`(첫 토큰이 `VAR=값` 이면 값도 `***`). 방 분류는 가리기 전에 서버가 미리 해 둠 |
| `--logs DIR` | 로그 디렉터리 (기본 `~/.claude/logs`) |
| `--no-usage` | 트랜스크립트 사용량 스캔을 끈다(`usage-batch`/`usage` 안 보냄, `ready.usage=false`) |
| `--projects DIR` | 트랜스크립트 디렉터리 (기본 `~/.claude/projects`) |
| `--config DIR` | `building.json`·`pricing.json` 을 읽고 쓰는 곳 (기본 `~/.claude/ai-team-office/`, 아래 "설정 위치") |

브라우저 `?sim=1&speed=5` 는 그 탭에만 `test/fixtures/sample.jsonl` 을 재생한다(실데이터 안 섞임).
`GET /healthz` 는 이벤트 수·접속 수·오늘 사용량 메시지 수를 JSON 으로 준다. `GET /building.json`·`GET /pricing.json` 은 파싱한 설정(없거나 깨졌으면 `{}`)을 준다(같은 Host/Origin 검사).

`GET /projects.json` 은 바닥 편집기용 프로젝트 목록 `[{proj, cwd?, lastActive, sessionsToday}]` (최근 활동순, `--projects` 아래 스캔, 같은 프로젝트 루트의 디렉터리(하위 폴더·worktree)는 하나로 합침(`cwd` = 루트, 오늘 세션 수 합산), scratchpad·`/private/tmp`·`/tmp` 아래·루트 이름이 `scratchpad` 인 것 제외, 10초 캐시, `--redact` 면 `cwd` 생략)를 준다. `POST /building.json` 은 `{ceo?, floors:{<proj>:{floor:1..99, label:≤40자}}}` 를 엄격히 검증(알 수 없는 키·비정수 층·제어문자·200개 초과·64KB 초과 거부 → 400/413)해 쓰기 위치(아래 "설정 위치")의 `building.json` 에 원자적(tmp+rename)으로 쓰고 저장한 JSON 을 돌려준다. `Content-Type: application/json` 필수(415), Origin 은 localhost 이거나 없어야 함(403), Host 검사는 동일, `building.json` 이 심볼릭 링크면 409. 이 엔드포인트는 다른 파일을 쓰지 않는다.
Host 헤더가 `127.0.0.1`·`localhost`·`[::1]`(포트 무관)이 아니면 421, `/events` 는 다른 사이트 Origin 이면 403, GET 이 아니면 405(DNS rebinding 방지).
`--port 0` 이면 빈 포트를 잡고 시작 로그에 실제 포트를 찍는다(테스트용).

## 구조

- `server.mjs` — 시작 시 `office-events.jsonl` + `delegation.jsonl` 에서 오늘(서버 로컬 시간대 자정 이후) 줄만 ts 순(같은 초는 파일 순)으로 모아 두고,
  새 접속마다 `event: batch` 로 한 번에 보낸 뒤 `event: ready`, 이후 새 줄을 `data:` 로 흘린다. 15초마다 keep-alive 주석.
  `ready` 데이터: `{mode, redact, count, dayStart}`. `dayStart` 는 "오늘" 을 자른 로컬 자정(epoch ms). 클라이언트는 시계가 `dayStart + 24h` 를 넘으면 오늘 통계를 0 으로 되돌린다.
  모든 줄은 `norm()`(리듀서와 같은 함수)으로 타입을 맞춘 뒤 보낸다. 깨진 줄은 그 줄만 버리고 tail 오프셋은 줄 단위로 전진한다.
  느린 클라이언트: 첫 버스트를 다 받은 뒤 1MB 넘게 밀리면 프레임을 건너뛰고, 다 비우면 스트림을 끝내 EventSource 가 재접속·재동기화하게 한다. 8MB 넘게 밀리면 끊는다.
  tail 은 디렉터리 `fs.watch` + 완전한 줄만 읽기(쓰다 만 줄은 다음에), 잘림(크기 감소)·회전(inode 변경)이면 처음부터.
  `fs.watch` 를 못 쓰면 500ms 폴링, 쓸 수 있어도 5초 안전 폴링. 깨진 줄은 버리고 계속 돈다.
  `delegation.jsonl` 줄은 판정·모델 힌트만 남기고 줄여서 보낸다(전체 프롬프트 미전송).
- `public/reducer.js` — 순수 리듀서 하나. `reduce(state, event)`, `tick(state, now)`, `classify(tool, target)`, `compliance(state)`.
  서버(`--redact` 분류)·브라우저·테스트가 같은 파일을 쓴다. 상태 머신 표는 파일 머리 주석에 있다.
- `public/app.js` — 리듀서 상태만 읽어 그린다. SSE 줄은 큐에 쌓았다가 프레임당 한 번 `reduceAll` 로 처리(초당 수십 개도 한 번 복제).
  배치가 예외를 던지면 한 줄씩 다시 적용하고 그 줄만 건너뛴다(나쁜 줄 하나가 하루 기록을 지우지 않음).
  캐릭터는 방 이동 기록(`visits`)을 웨이포인트로 걸어가며(구간마다 easeInOutCubic, 0.35~0.9초) 각 지점에서 0.65초 머문다 → 1초짜리 Read 도 눈에 보인다.
  움직일 게 없으면 rAF 루프가 멈추고 1초 타이머만 돈다. `prefers-reduced-motion` 이면 순간 이동·애니메이션 없음.
  `ready` 의 `dayStart`(로컬 자정 epoch ms) + 24시간이 지나면 다시 접속해 "오늘" 을 새로 시작한다(1초 타이머가 확인).

## 사용량 (토큰) — `usage.mjs`

- **소스**: `~/.claude/projects/<proj-dir>/<sid>.jsonl`(메인 세션)과 `<proj-dir>/<sid>/subagents/agent-<aid>.jsonl`(서브에이전트) 중 **오늘(로컬) 수정된 파일만**.
  `type=="assistant"` 줄의 `message.{id, model, usage}` + `timestamp` 를 읽는다. 스트리밍 때문에 같은 `message.id` 가 여러 줄이면 **마지막 줄 값**만 쓴다.
  토큰이 전부 0 인 줄(`<synthetic>` 등)·usage 없는 줄·깨진 줄은 건너뛴다. ts 가 로컬 자정 이전인 줄도 뺀다.
- **레코드**: `{id, ts, proj, sid, aid?, atype?, model, family, in, out, cacheR, cacheW, usd?}`. `id` = message id(재접속 시 클라이언트 중복 제거 키).
  `family` = 모델 이름에 fable/opus/sonnet/haiku 포함 여부, 없으면 `unknown`. `atype` 은 `agent-<aid>.meta.json` 의 `agentType`(있을 때).
  `proj` 는 **프로젝트 루트의 이름**(경로 없음, `--redact` 에서도 동일). 먼저 실행 폴더를 찾는다: 디렉터리 이름은 `/`·`_`·`-`·`.` 를 모두 `-` 로 바꾼 것이라 모호하므로,
  트랜스크립트 줄의 `cwd`(또는 그 상위)를 같은 규칙으로 인코딩해 디렉터리 이름과 맞는 것을 쓰고(`-Users-x-Documents-AI-Team` + cwd `…/AI_Team/office` → `…/AI_Team`), 디렉터리 이름이 `encodeDir(cwd)+'-'` 로 시작하면(프로젝트 아래 worktree 폴더) 그 cwd 를 쓴다.
  cwd 가 없으면 `/` 부터 파일시스템을 내려가며 인코딩이 맞는 자식을 골라 실제 경로를 복원한다(깊이 12, `web-ui` → `web_ui`). 그래도 없으면 디렉터리 이름 **전체**(마지막 조각을 추측하지 않는다).
  **프로젝트 루트 규칙**(사용량·`/projects.json`·office-events `proj`·대표실 카드·building 키 공통, `usage.mjs projectOf`): 그 폴더 또는 가장 가까운 상위 중 git 루트(`.git` 파일·폴더)이거나 `.claude/` 폴더·`CLAUDE.md` 가 있는 곳(`$HOME`·`/` 제외), 없으면 그 폴더 자신. 이름 = 루트의 basename, 단 `.git` 이 `<main>/.git/worktrees/…` 를 가리키는 파일이면(링크된 worktree) **메인 저장소** 이름. 그래서 `AI_Team/office` 에서 연 세션, `shop-backend-app/.claude/worktrees/*` 세션은 각각 `AI_Team`, `shop-backend-app` 층으로 모인다.
- **SSE**: 접속하면 `event: batch`(훅 이벤트) → `event: usage-batch`(오늘 사용량 배열, 프레임당 ≤1000) → `event: ready`, 이후 새/바뀐 메시지마다 `event: usage`.
  `ready` 추가 필드: `usage`(켜짐 여부), `usageFiles`(추적 중 파일 수), `usageCount`(배치 레코드 수), `hasPricing`, `building`(파싱한 `building.json` 또는 `null`).
  배치가 5000 건을 넘으면 최근 10분 밖 레코드를 (proj, sid, aid, family) × 1분 구간으로 합친다(그래도 많으면 10분, 1시간). 합친 레코드는 `n`(메시지 수)·`agg`(구간 분)를 갖고 `id` 가 `agg:` 로 시작한다. 합계는 보존된다.
- **읽기 방식**: 1MB 청크로 줄 단위 스트리밍(파일 전체를 메모리에 올리지 않음), `"type":"assistant"` 가 들어 있는 줄만 JSON 파싱. 1초마다 추적 파일의 새 완전한 줄만 읽고(쓰다 만 줄은 다음에), 10초마다 디렉터리를 다시 훑어 새 세션·서브에이전트 파일을 추가한다. 자정이 지나면 어제 레코드는 버린다. 첫 접속은 초기 스캔이 끝날 때까지 기다린다(실측 27개 파일·54MB 에 약 60ms).
- **정직성 한계**: 요금제(5시간 창) 한도·잔여량은 로컬 어디에도 없어 **표시하지 않는다**. 모델은 트랜스크립트에 기록된 `message.model` 그대로이고, 메인 세션 모델도 이 값으로 본다(훅 이벤트 쪽은 여전히 fable 로 가정). 오늘 수정되지 않은 파일(어제 시작해 오늘 안 쓴 세션)은 읽지 않는다. 토큰 수는 API 가 돌려준 usage 값이며 청구서와 다를 수 있다.

### 설정 위치

사용자 설정은 **코드 폴더 밖**에 둔다(플러그인으로 설치하면 업데이트 때 코드 폴더가 통째로 바뀐다).
읽는 순서: `--config DIR` → `~/.claude/ai-team-office/` → (예전 설치 호환, 읽기 전용) `office/` 폴더 자체.
쓰기(`POST /building.json`)는 `--config` 가 있으면 거기, 없으면 항상 `~/.claude/ai-team-office/`(처음 쓸 때 700 으로 만든다).
`--config` 없이 시작했을 때 `office/` 에만 `building.json`·`pricing.json` 이 있으면 새 위치로 한 번 복사하고 로그에 한 줄 남긴다(이미 있으면 덮어쓰지 않는다).
`start.sh` 의 pid·로그도 `~/.claude/ai-team-office/run/` 에 둔다. 이 파일들은 `.gitignore` 대상이다.

### `building.json` (선택, `~/.claude/ai-team-office/building.json`)

```json
{ "ceo": "대표", "floors": { "shop-backend-app": { "floor": 1, "label": "쇼핑 백엔드" }, "AI_Team": { "floor": 9, "label": "AI 팀 사무실" } } }
```
`floors` 키 = 프로젝트 이름(위 프로젝트 루트 규칙, 이벤트·사용량의 `proj` 와 같음). 없거나 깨진 파일이면 `ready.building=null`, `/building.json` 은 `{}`. 접속할 때마다 다시 읽는다. 예시: `building.example.json`.
서버는 내보낼 때(`ready.building`, `GET /building.json`) 키를 정규화한다: 알려진 프로젝트(`/projects.json` + 이벤트에 나온 이름)가 아닌 키는 별칭(실행 폴더·cwd basename → 프로젝트, 예 `office` → `AI_Team`)이나 같은 `encodeDir`(`web-ui` → `web_ui`)로 실제 이름에 매핑한다. 정확한 키가 이미 있으면 매핑된 중복은 빠진다. 끝내 못 맞춘 키는 그대로 두고 `unknownKeys: [...]` 에 나열한다(편집기 경고용). 파일 자체는 고치지 않는다. `POST` 는 `unknownKeys` 를 받아도 무시하고 저장하지 않는다.

### `pricing.json` (선택, `~/.claude/ai-team-office/pricing.json`)

```json
{ "_comment": "USD per 1M tokens", "opus": { "in": 0, "out": 0, "cacheR": 0, "cacheW": 0 } }
```
단가는 코드에 없다. 사용자가 적은 USD/100만 토큰 값으로만 레코드마다 `usd = (in·p.in + out·p.out + cacheR·p.cacheR + cacheW·p.cacheW) / 1e6` 를 붙인다.
네 값이 모두 있는 패밀리만 쓰고, 행이 없는 패밀리·`unknown` 은 `usd` 없음. `_` 로 시작하는 키는 무시. 파일이 없으면 `usd` 필드 자체가 없고 `hasPricing=false`. 10초마다 mtime 을 보고 다시 읽는다. 예시: `pricing.example.json`(0 은 자리표시자).

## 화면 읽는 법

- **계기판**(우상단): 큰 % = 의도 모델 = 실제 모델 비율. 초록 ≥ 90%, 호박 ≥ 70%, 빨강 그 아래. 바로 밑 한 줄이 답이다
  (`규칙 준수 중 · 위반 없음` / `… · 위반 1건 (opus→sonnet)`). 0 인 칩은 숨김. 막대: Fable 직접(보라) vs 위임(회색), 판정 통과/재작업/실패.
  모델별 위임 수·평균 소요·재작업률 표도 여기 있다. **오늘 통계** 는 도구 실패·승인 요청·세션·이벤트 네 숫자만.
- **캐릭터**: 모델마다 색과 모자가 다르다 — fable 왕관(보라), opus 캡(파랑), sonnet 헤드폰(청록), haiku 방울 털모자(노랑).
  effort 는 이름표 안 세로 막대 1~4개(둥근 "…" 말풍선은 생각 중). 의도와 다른 모델로 돈 서브에이전트는 머리 옆에 빨간 ✗.
  한 방에 3명부터는 뒷줄로 비켜 서고, 말풍선은 그 방에서 가장 최근에 움직인 사람 것만 뜬다. 책상 없는 서브는 이름표에 atype 만.
- **위임 로그**: `type·aid` + 의도→실제 모델 색 점. ✗(불일치) 줄은 붉게 칠해 맨 위로. 호출 자체가 실패하면 `실패`, 결과가 끝내 안 오면 `만료`. 판정은 통과/재작업/실패, 아직이면 `판정 전`. 메인이 긴 위임을 기다리는 동안은 말풍선·카드에 `위임 대기`.
- **티커**: 초당 최대 2번 갱신, 새 줄만 왼쪽에 끼워 넣는다. 도구 이름은 한국어(자료 조사·실행 중·작성 중), `PostToolUse 완료` 줄은 뺀다.

## 상태는 어떻게 정해지나 (정직성 표)

이름표 옆 점: 초록 = 관측(훅 이벤트가 직접 말함), 파랑 = 추정(침묵에서 유추), 회색 = 오래됨(5분+ 이벤트 없음).

| 화면 | 근거 | 종류 |
|---|---|---|
| 자료실/서버실/작업대/외부창구/회의실 | `PreToolUse` 의 tool + target 을 `classify` (Bash 는 명령 머리: `rg/cat/ls/git log`=자료실, `sed -i`/`>`/`mkdir`=작업대, `curl/gh/aws/git push`=외부창구, 그 밖=서버실) | 관측 |
| 검수실 | `atype=code-reviewer` 의 도구 활동 | 관측 |
| 생각 중 "…" 말풍선 | `UserPromptSubmit` 직후, 또는 `PostToolUse` 뒤 3초 넘게 다음 도구가 없음 | 추정 |
| 손 들기 + 빨간 "승인 대기" + 상단 호박색 필 | `PermissionRequest` 또는 `Notification ntype=permission_prompt`. 같은 캐릭터의 다음 Pre/Post/Stop/UserPrompt 로 해제 | 관측 |
| 막힘 1분+ (호박색) | `PreToolUse` 후 60초 넘게 `PostToolUse` 없음. 메인이 동기 Agent 호출을 기다리는 중이면 막힘 대신 `label='위임 대기'`(💤·흐림도 없음, 위임 10분 만료 후엔 일반 규칙) | 추정 |
| 💤 | 3분 넘게 그 캐릭터 이벤트 없음 | 추정 |
| 흐림(오래됨) | 5분 넘게 이벤트 없음. 사라졌다고 단정하지 않음 | 추정 |
| ⚡ | `PostToolUseFailure` (3초 표시, 실패 수 누적) | 관측 |
| 엘리베이터 도착 | `SubagentStart` 또는 그 aid 의 첫 이벤트 | 관측 |
| 엘리베이터 퇴장 + 스탬프 | `SubagentStop`. 스탬프(통과/재작업/실패)는 `delegation.jsonl` 의 `event=verdict`(ref=aid) ok/rework/fail | 관측 |
| 머리 옆 빨간 ✗ | 그 서브에이전트의 위임 기록이 의도 vs 실제 모델 ✗ | 관측 |
| 의도 vs 실제 모델 ✓/✗ | 메인 `PreToolUse Agent` 의 `sub.model` vs 직후 `PostToolUse` 의 `resolved`. 모델 미지정 위임은 `?`, 미지정인데 fable 로 돌면 ✗ | 관측 |
| Fable 직접 vs 위임 | aid 없는 `PreToolUse` 중 Agent 아닌 것 / Agent 인 것 | 관측 |
| 재작업률 | 모델별 (rework+fail) / 판정 수. 모델은 위임 기록의 실제 모델, 없으면 `delegation.jsonl` 의 모델 | 관측 |
| 숨쉬기·깜빡임·커피잔 | 장식. 상태와 무관 | — |

가짜 활동은 없다: 랜덤 이동·잡담 없음, 이벤트가 없으면 캐릭터는 가만히 있다.
늦게 도착한 줄(그 캐릭터의 마지막 ts 보다 이른 ts)은 통계·위임 기록엔 반영하되 캐릭터를 뒤로 되돌리지 않는다. 단 `SubagentStart`/`SubagentStop` 은 늦어도 적용한다(훅 ts 가 초 단위라 Stop 이 1초 앞설 수 있음).
위임 짝짓기: 메인 `PreToolUse Agent` ↔ `PostToolUse`/`PostToolUseFailure` 는 `tuid`(tool_use_id)가 양쪽에 있으면 그것으로, 없으면 (sid, desc, 먼저 온 순서)로 묶는다. 실패는 그 위임을 `failed` 로 닫고, 10분 넘게 짝이 없으면 `expired`.

## 알려진 한계

- **컨텍스트 사용량은 표시하지 않는다.** 훅 페이로드에 없다(DESIGN.md "피할 것").
- 메인 세션의 모델은 이벤트에 없어서 항상 fable 로 가정한다.
- 훅 ts 는 초 단위라 같은 초 안의 순서는 파일 순서를 따른다.
- `SubagentStop` 이 없는 서브에이전트는 5분 무활동(도구 실행 중이면 10분) 뒤 엘리베이터로 퇴근하고 책상이 비워진다. 진짜 끝났는지는 모른다(티커에 "종료 신호 없음").
- 판정이 오늘 로그에 없는 위임(어제 시작)과 묶이면 모델을 `unknown` 으로 센다.
- 브라우저 알림(Notification API)은 넣지 않았다. 소리 알림은 상단 🔕 토글(기본 무음).

## API: `GET /focus?sid=<session id>`

Best-effort: 해당 세션을 돌리는 터미널 창을 앞으로 가져온다(macOS 전용, 포커스만 — 입력은 절대 보내지 않는다). `sid` 는 `[0-9a-f-]{8,64}`(아니면 400), localhost Origin/Host 검사, 1초에 1회(초과 시 429). 응답 `{ok, method, detail}`.
순서: `~/.claude/projects/*/<sid>.jsonl` 에서 `cwd`(와 그 줄까지 나온 `tty`) 찾기(찾으면 60초, 못 찾으면 5초 캐시) → 트랜스크립트에 `tty` 가 있으면 그 TTY 의 실행 중 `claude` 프로세스(정확), 없거나 안 맞으면 cwd 가 같은 `claude` 프로세스의 TTY → AppleScript(iTerm2, Terminal.app; TTY 는 argv 로 전달) → 실패 시 범용 폴백: `claude` 프로세스의 조상 중 첫 `.app` 번들을 `open -a` 로 활성화(`/Applications`, `~/Applications`, `/System/Applications` 아래만 허용, 그 외는 거부). 어떤 터미널 앱이든 동작하지만 탭 선택은 iTerm2/Terminal 에서만 된다. `method`: `iterm2`/`terminal`/`app-bundle`/`none`/`unsupported`(macOS 아님).

## 대표실에서 답하기 (권한 승인·질문 응답)

Claude Code 가 사람에게 묻는 두 가지 — 권한 확인(`PermissionRequest`)과 `AskUserQuestion` — 를 대시보드 대표실에서 답할 수 있다. 훅이 요청을 서버로 넘기고 **기다린다**. 대표실에서 승인/거부하거나 보기를 고르면 훅이 그 결정을 Claude Code 에 돌려준다. 그 밖의 모든 경우(대시보드 꺼짐, 열린 탭 없음, 시간 초과, 터미널에서 먼저 답함, 오류)엔 훅이 **아무것도 출력하지 않고** 빠지며, 공식 문서대로 "exit 0 + 빈 출력 = 결정 없음" 이라 터미널의 원래 프롬프트가 그대로 쓰인다.

### 설치 (사용자가 직접, `~/.claude/settings.json`)

`<office>` 는 이 폴더의 절대 경로. 플러그인으로 설치했다면 버전이 들어간 캐시 폴더(`~/.claude/plugins/cache/…/<version>/`) 대신 마켓플레이스 체크아웃 `~/.claude/plugins/marketplaces/ai-team-office/plugins/ai-team/office` 를 쓴다 — `claude plugin marketplace update` 가 그 자리에서 갱신하므로 업데이트 뒤에도 새 훅이 돈다(`/ai-team:ai-team-setup` 이 이렇게 써 준다). 훅 `timeout`(초) 은 **대기 시간/1000 + 5 이상**이어야 한다 — 스크립트의 curl `--max-time` 이 그 값이라 더 짧으면 Claude Code 가 훅을 먼저 죽이고, 그 뒤 대표실 답은 410 으로 거절된다. 기본 `OFFICE_RELAY_WAIT_MS=170000` → max-time 175 → `timeout` ≥ 175(아래 예시 180), 최대 540000 → ≥ 545, 질문용 60000 → ≥ 65. `OFFICE_RELAY_WAIT_MS` 는 1~7자리 10진수만 받는다(`060000` = 60000, 앞 0 은 8진수가 아님; 그 외·더 긴 값은 기본값). 기존 `PermissionRequest`/`PreToolUse` 배열이 있으면 항목을 **추가**한다.

```json
{
  "hooks": {
    "PermissionRequest": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "<office>/hooks/ceo-relay.sh", "timeout": 180 } ] }
    ],
    "PreToolUse": [
      { "matcher": "AskUserQuestion", "hooks": [ { "type": "command", "command": "<office>/hooks/ceo-relay.sh", "timeout": 180 } ] }
    ]
  }
}
```

- 필요: `bash`, `curl`, `jq` (node 기동 비용 없음). 환경변수: `OFFICE_PORT`(4747), `OFFICE_RELAY_WAIT_MS`(170000, 최대 540000), `OFFICE_RELAY_QUESTION_WAIT_MS`(질문만 따로, 기본은 앞 값), `OFFICE_RELAY_DISABLE=1`(끄기).
- 대안: 공식 `http` 훅 — `{ "type": "http", "url": "http://127.0.0.1:4747/relay/hook?waitMs=170000", "timeout": 180 }`. 같은 롱폴이고 응답 본문이 곧 훅 JSON(결정 없으면 `{}`). 다만 서버가 꺼져 있으면 Claude Code 가 "non-blocking error" 로 처리(트랜스크립트에 훅 오류 표시)하므로 기본은 스크립트(접속 1초 실패 시 조용히 빠짐)다. `allowedHttpHookUrls` 를 쓰는 환경이면 이 URL 을 허용 목록에 넣어야 한다.

### 경합 규칙 (먼저 답한 쪽이 이긴다)

| 상황 | 결과 |
|---|---|
| 대표실에서 승인/거부/답변 | 훅이 결정 JSON 출력. 카드 `answered`(by dashboard). 두 번째 답은 409 |
| 대기 시간 초과 | 훅 출력 없음 → 터미널 프롬프트. 카드 `resolved`(by terminal, reason timeout) |
| 터미널에서 먼저 답함 | Claude Code 가 훅을 끝내면 연결이 끊겨 `withdrawn`. 훅이 남아 있어도 같은 세션·같은 에이전트의 `PostToolUse`/`PostToolUseFailure`/`PermissionDenied`(같은 도구·같은 target, 질문은 같은 `tool_use_id`), 그 세션의 `UserPromptSubmit`/`SessionEnd`, 그 에이전트의 `Stop`/`SubagentStop` 이 office-events 에 찍히면 `resolved`(by terminal) 로 닫고 훅은 빈 출력 |
| 대시보드 탭이 하나도 안 열려 있음 (질문은: 보이는 탭이 없음) | 즉시 "결정 없음"(`reason: no-viewer`) — 아무도 안 보는데 프롬프트를 붙잡지 않는다. "대시보드" = `Origin` 또는 `Referer` 가 이 서버 자신(loopback, 같은 포트)인 `/events` 연결(브라우저 EventSource 는 보내고 curl 은 안 보냄). **권한 요청**은 터미널 프롬프트가 훅과 동시에 떠 있으므로 백그라운드 탭이라도 열려 있으면 붙잡는다(터미널에서 일하다 나중에 대표실에서 승인 가능, 터미널에서 먼저 답해도 됨). **질문**(`PreToolUse`)은 훅이 끝나야 터미널 질문 창이 뜨므로 **보이는** 탭이 있을 때만 붙잡는다. 탭이 숨겨지면 페이지가 `POST /viewer {vid, visible:false}` 를 보낸다. 다른 SSE 리더는 대시보드로 세지 않는다. 넘긴 경우 서버 로그에 `not relayed: …` 한 줄을 남긴다 |
| 마지막으로 보이던 탭이 백그라운드로 감 / 마지막 탭이 닫힘 | 백그라운드: 대기 중 **질문**만 `resolved`(no-viewer). 닫힘: 전부 `resolved`(no-viewer), 훅은 빈 출력 → 터미널 프롬프트. 닫힘은 5초 유예 뒤에 판단하므로 새로고침(닫혔다 바로 다시 연결)은 대기 항목을 풀지 않는다(`OFFICE_VIEWER_GRACE_MS`). 서버가 재시작되면 열린 페이지는 `ready.boot` 가 바뀐 것을 보고 새로고침해 새 토큰을 받는다(옛 토큰으로는 답이 403) |
| 훅이 이미 끝났는데 대표실에서 답함 | 410 `the hook that asked is gone …` — 아무에게도 전달되지 않는 답을 성공으로 보이지 않는다 |

**질문(AskUserQuestion)은 대기 중 터미널이 막힌다.** `PreToolUse` 훅은 도구 실행 *전*에 돌기 때문에, 훅이 기다리는 동안 터미널엔 질문 UI 가 아직 안 뜬다. 대기 시간이 지나야(또는 Esc 로 중단해야) 터미널에서 답할 수 있다. 그래서 `OFFICE_RELAY_QUESTION_WAIT_MS` 를 짧게(예: 60000) 두는 것을 권한다. 권한 확인 대화상자가 훅 대기 중에 함께 뜨는지는 문서에 명시가 없다 — 어느 쪽이든 위 규칙으로 정리된다.

### API

- `POST /relay/ask?waitMs=N` (훅 스크립트용) — 본문: 훅 입력 JSON 그대로. 응답 `{id, kind, decision, by}`; 결정 없으면 `decision: null`.
- `POST /relay/hook?waitMs=N` (`http` 훅용) — 같은 롱폴, 응답은 최종 훅 JSON 또는 `{}`.
- `POST /relay/answer` `{id, decision}` — 권한: `{behavior: "allow"|"deny", message?}`(message 는 deny 만, 제어문자 제거·500자). 질문: `{answers: {"<질문 원문>": "<보기 label 또는 직접 입력>"}}`, 다중선택은 문자열 배열도 받아 `", "` 로 합친다. 모든 질문에 답해야 한다. 200 / 400(형식) / 404(모름·만료) / 409(이미 해결) / 410(훅 연결이 끊김: 답이 전달될 곳 없음).
- `POST /relay/release` `{id}` — 돌려보내기: 결정 없이 끝냄(터미널 프롬프트로). 404/409/410 은 answer 와 같다.
- `POST /viewer` `{vid, visible:boolean}` — 이 탭이 보이는지. 숨은 탭은 대시보드로 세지 않고, 보이는 탭이 0 이 되면 대기 항목을 `no-viewer` 로 푼다.
- answer·release·pending·viewer 는 **대시보드 전용**: `Origin` 이 이 서버 자신(`http://127.0.0.1:<port>` 등)이어야 하고(없으면 403), 헤더 `X-Office-Token` 이 서버가 시작할 때 만든 토큰과 같아야 한다(403). 토큰은 서버가 내려주는 `index.html` 의 `<meta name="office-token">` 에만 있고 SSE 에는 없다. answer·release 는 추가로 **호출한 프로세스**를 확인한다(아래 보안).
- `GET /relay/pending` — 대기 목록(대시보드 전용; 브라우저는 같은 출처 GET 에 Origin 을 안 붙이므로 페이지는 쓰지 않고 SSE 로 받는다). SSE 에는 `event: ceo` 로 `{type:'snapshot', items}`(접속 직후), `ask`, `answered`, `resolved`, `withdrawn` 이 온다.
- item: `{id, kind:'permission'|'question', sid, proj, cwd?, aid?, atype?, tool, tuid?, mode?, target, input, questions?, clipped?, createdAt, expiresAt}`. `input` 은 문자열 4000자에서 자름(`clipped: true`).
- 모든 결정·해소는 `<logs>/ceo-decisions.jsonl`(기본 `~/.claude/logs/`) 에 `{ts, id, sid, tool, kind, by, decision}` 로 남는다.

### 정직한 한계

- 할 수 있는 건 **그 질문에 대한 답**뿐이다: 권한 허용/거부(+거부 사유), 질문 보기 선택. 새 지시·자유 프롬프트를 세션에 넣는 통로는 Claude Code 에 없다. 그건 터미널(또는 Remote Control)에서.
- "허용" 은 이번 한 번만이다. `updatedPermissions`(규칙 추가·모드 변경)와 `updatedInput`(명령 바꿔치기)은 서버도 스크립트도 절대 보내지 않는다.
- 공식 문서: 훅의 allow 는 **deny/ask 권한 규칙을 덮어쓰지 못한다**. 설정의 deny 규칙은 그대로 막는다.
- 터미널 쪽 해소 감지는 office-events 훅 줄에 의존한다(초 단위 ts, 항목 생성 초 이후 줄만). `PostToolUse` 류는 양쪽에 `tool_use_id` 가 있으면 그것만, 없으면 **null 이 아닌 같은 target** 일 때만 맞춘다. 그 훅이 없으면 타임아웃·연결 끊김으로만 정리된다.

### `proj` 이름: office-events 훅 vs 사용량

`~/.claude/hooks/office-events.sh` 는 `proj` 를 **현재** `.cwd` 의 basename 으로 적는다(`def proj: (.cwd // "" | split("/") | last)`). 세션이 하위 폴더로 `cd` 하면 그 폴더 이름이 된다. 사용량은 트랜스크립트 폴더(= **실행** 폴더)에서 이름을 얻는다. 서버는 두 쪽 모두 위 프로젝트 루트 규칙으로 다시 계산하므로(이벤트는 `cwd` 가 있을 때) 대부분 같아지지만, 루트 표시(.git·.claude·CLAUDE.md)가 없는 폴더에서 `cd` 하면 여전히 갈린다. 훅은 상태가 없어 세션별 시작 cwd 를 기억할 수 없다. 가장 단순하고 정직한 해결은 Claude Code 가 모든 훅에 넘기는 `CLAUDE_PROJECT_DIR`(세션의 프로젝트 = 실행 폴더) 를 쓰는 한 줄 변경이다:
`def proj: ((env.CLAUDE_PROJECT_DIR // .cwd // "") | split("/") | last);`

### 보안

- 결정은 오직 `POST /relay/answer` 에서 온다. 서버는 스스로 허용하지 않는다. 스크립트는 서버 응답에서 `behavior`/`message`/`answers` 만 골라 JSON 을 직접 만들고, 질문 원문은 Claude Code 가 준 stdin 에서 되돌려준다.
- 127.0.0.1 에만 바인드, Host 가 loopback 이 아니면 421, 다른 사이트 Origin 은 403, POST 는 `Content-Type: application/json` 필수(브라우저 단순 요청 CSRF 차단). 스크립트는 `curl -q --noproxy '*'` 로 프록시·`.curlrc` 를 타지 않는다.
- **자기 승인 차단(겹겹이)**: Claude 서브에이전트가 Bash 로 `curl /relay/answer` 를 쳐서 자기 권한 요청을 스스로 승인하지 못하게 한다.
  1. Origin 필수: answer·release·pending·viewer 는 `Origin` 헤더가 정확히 이 서버(loopback, 같은 포트)여야 한다. Origin 없는 요청(curl 기본)은 403.
  2. 뷰어 토큰: 프로세스마다 새로 만든 무작위 토큰을 `X-Office-Token` 으로 보내야 한다. 페이지는 `index.html` 의 meta 에서 읽는다.
  3. 호출 프로세스 검사(macOS, 결정적인 단계): 요청의 TCP 상대 포트를 `lsof -nP -iTCP@127.0.0.1:<port> -sTCP:ESTABLISHED -Fpc` 로 PID 로 바꾸고 `ps -o ppid=,comm=` 로 조상을 최대 40단계 올라간다. 조상 중에 Claude Code CLI(`claude`, `claude-code`, `node…claude`)가 있으면 403 `agent processes cannot answer`. 브라우저는 `claude` 의 자식이 아니다. 상대 프로세스를 못 찾으면(이미 끊김) 403. macOS 가 아니거나 `lsof`/`ps` 를 실행할 수 없으면 1·2 만으로 동작하고 로그에 한 번 남긴다.
- **알려진 한계(정직하게)**: 같은 사용자 계정의 프로세스가 **작정하면** 여전히 브라우저를 흉내 낼 수 있다 — `index.html` 을 받아 토큰을 읽고 Origin 을 붙인 뒤, `claude` 의 자손이 아닌 프로세스(예: `launchd` 로 띄운 작업, `open -a` 로 연 앱, `nohup`+`disown` 후 부모가 바뀐 프로세스)에서 요청하면 통과한다. 이 검사들은 **에이전트가 실수로·습관적으로 자기 요청을 승인하는 것**을 막는 장치이지, 같은 계정의 악성 코드를 막는 경계가 아니다. 4747 포트를 먼저 잡은 프로세스는 훅에 답할 수도 있다. **공유 계정·공용 머신에서는 대시보드를 돌리지 말 것.**
- `--redact`: 카드에 `cwd`·`input` 없음, target 은 기존 규칙대로 가림(Bash 첫 토큰만). 질문 본문·보기는 답하려면 필요해서 남긴다. 결정 로그엔 거부 사유·답 내용을 남기지 않는다(Claude 에게는 그대로 전달).

## 플랜 한도 · 컨텍스트 (`limits.mjs`)

statusline 래퍼가 세션마다 쓰는 `~/.claude/logs/statusline/<session_id>.json` 을 읽는다(`--statusline DIR` 로 바꿀 수 있다). `fs.watch` + 2초 폴링, 깨진/쓰는 중인 파일은 무시한다.

- `account.five_hour` / `seven_day` `{pct, resetsAt, capturedAt}`: 계정 전체 값이라 그 창을 가진 파일 중 `_captured_at` 이 가장 최신인 것을 쓴다. `resets_at` 이 지났으면 `null`(리셋됨). `pct` 는 null 일 수 있다. `account.stale` = 최신 캡처가 15분 넘음.
- `sessions[]`: 오늘(로컬) 캡처된 세션만, 최신순. `{sid, proj, model, family, ctx:{size,pct,inTokens}, costUsd, capturedAt, stale(10분)}`. `proj` 는 `workspace.project_dir || cwd || transcript_path` 에서 이벤트와 같은 프로젝트 루트 규칙으로 구한다.
- 전달: SSE `ready` 프레임의 `limits`, 바뀔 때마다(500ms 디바운스) `event: limits`(전체 스냅샷), `GET /limits.json`.
- `--redact`: `costUsd` 를 뺀다(스냅샷에 transcript 경로는 원래 없다).
