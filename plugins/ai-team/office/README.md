# AI Team Office

Claude Code 메인 세션(Fable)과 서브에이전트가 지금 무엇을 하는지 사무실 메타포로 보여주는 실시간 대시보드.
설계 계약은 [DESIGN.md](DESIGN.md). 의존성 0, 읽기 전용, 127.0.0.1 에만 바인딩, 토큰 소모 0.

## 실행

```bash
node office/server.mjs                 # http://127.0.0.1:4747
office/start.sh start [flags]          # 백그라운드. pid: office/.run/server.pid, 로그: office/.run/server.log
office/start.sh status | stop | restart
node --test office/test/               # 리듀서 테스트 (node:test)
```

| 플래그 | 뜻 |
|---|---|
| `--port N` | 포트 (기본 4747) |
| `--replay <file> --speed N` | 로그 대신 jsonl 파일을 N배 빠르게 재생. ts 는 재생 시각으로 바꿔 보냄 (데모·발표용) |
| `--redact` | prompt·sub.prompt·msg·err·cwd 는 아예 빼고 보냄(화면에 안 씀). target 은 `$HOME` → `~`, URL 은 scheme+host+path 만(쿼리·#·계정 제거), Bash 는 첫 토큰만 남기고 `***`(첫 토큰이 `VAR=값` 이면 값도 `***`). 방 분류는 가리기 전에 서버가 미리 해 둠 |
| `--logs DIR` | 로그 디렉터리 (기본 `~/.claude/logs`) |

브라우저 `?sim=1&speed=5` 는 그 탭에만 `test/fixtures/sample.jsonl` 을 재생한다(실데이터 안 섞임).
`GET /healthz` 는 이벤트 수·접속 수를 JSON 으로 준다.
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
