# ai-team-office

**English** | [한국어](#한국어)

A Claude Code plugin that turns your session into a model-routed AI team: a Fable/Opus main session that plans and verifies, cheaper subagents that do the work, a delegation log with verification verdicts, and a real-time pixel office dashboard.


![AI Team Office dashboard, light theme: pixel office rooms with the main session and subagent characters](docs/office-light.png)
![AI Team Office dashboard, dark theme: the same office with the model-ratio gauge and delegation stamps](docs/office-dark.png)

## Quick start

**Requirements:** `node` >= 20 (dashboard) and `jq` (the hooks use it to write logs). macOS or Linux.

```bash
claude plugin marketplace add bluelang1/ai-team-office
claude plugin install ai-team@ai-team-office
```

Then, inside Claude Code:

1. `/ai-team:ai-team-setup` - shows the operating rules and, only if you say yes, appends them to `~/.claude/CLAUDE.md`.
2. `/ai-team:office` - starts the dashboard and opens http://127.0.0.1:4747.

## Routing table

| Kind of work | Agent | Model / effort |
|---|---|---|
| Lookups, search, status | `lookup` | haiku / low |
| Read-only ops investigation, clear-spec test additions | `ops-investigator` / `implementer` | sonnet / medium |
| Implementation, migrations (default) | `implementer` | opus / high |
| Review, design, incident root cause, security | `reviewer` | opus / high |
| Planning, verification, ambiguous decisions | main session | main model |

Full rules: [`plugins/ai-team/rules/OPERATING_RULES.md`](plugins/ai-team/rules/OPERATING_RULES.md).

## How office states are derived

The dashboard only reads hook logs, so every state is either **observed** (a hook event says so) or **inferred** (a timer or a guess). Inferred states are labelled as such in the UI, and "stale" is never read as "gone".

| Shown | Derived from | Kind |
|---|---|---|
| Library (reading) | `PreToolUse` of Read, Grep, Glob, LSP, WebFetch, WebSearch, ToolSearch; Bash `rg`/`cat`/`ls`/`git log` etc. | observed |
| Workbench (writing) | `PreToolUse` of Edit, Write, NotebookEdit; Bash `sed -i`, `>` redirects, `mkdir` | observed |
| External desk | `mcp__*` tools; Bash `curl`, `gh`, `aws`, `git push`, `npm publish` | observed |
| Server room | any other Bash command | observed |
| Meeting room | `PreToolUse` of Agent (delegation) | observed |
| Review room | tool activity of a `code-reviewer` subagent | observed |
| Thinking bubble | right after `UserPromptSubmit`, or no next tool 3 s after `PostToolUse` | inferred |
| Hand up, "awaiting approval" | `PermissionRequest` or permission-prompt `Notification`; cleared by that character's next event | observed |
| Stuck (amber) | no `PostToolUse` 60 s after `PreToolUse` (shown as "waiting on delegation" while main waits for a sync Agent call) | inferred |
| Sleeping (zzz) | no event from that character for 3 min | inferred |
| Faded (stale) | no event for 5 min; not treated as gone | inferred |
| Lightning | `PostToolUseFailure` | observed |
| Elevator arrive / leave + stamp | `SubagentStart` / `SubagentStop`; stamp from `delegation.jsonl` verdict (ok/rework/fail) | observed |
| Intended vs actual model | `model` in the Agent call vs the resolved model afterwards | observed |
| Subagent with no `SubagentStop` | leaves after 5 min idle (10 min if a tool is running); delegations without a match expire after 10 min | inferred |

**Not shown:** context-window usage (hook payloads do not carry it), and the main session's model, which is assumed to be Fable for every event. Decorations (breathing, blinking, coffee cup) mean nothing. Details: [`plugins/ai-team/office/README.md`](plugins/ai-team/office/README.md) and [`DESIGN.md`](plugins/ai-team/office/DESIGN.md).

## Privacy

- Local only: the dashboard binds to `127.0.0.1`; nothing is sent anywhere.
- Consumes no tokens: it only reads hook event logs under `~/.claude/logs/`.
- Use `--redact` to mask prompts and file paths in what the dashboard displays.

## Credits

Inspired by @cowboy76's office post, and by [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents), [Claude-Office](https://github.com/W17ant/Claude-Office) and [agent-virtual-office](https://github.com/KbWen/agent-virtual-office).

## License

MIT, see [LICENSE](LICENSE).

---

## 한국어

모델 라우팅 AI 팀을 Claude Code 에 입히는 플러그인입니다. 계획·검수는 Fable/Opus 메인이, 실제 작업은 더 저렴한 서브에이전트가 맡고, 위임 로그(검수 판정 포함)와 실시간 픽셀 오피스 대시보드를 제공합니다.

### 30초 설치

요구 사항: `node` 20 이상, `jq`(훅이 사용).

```bash
claude plugin marketplace add bluelang1/ai-team-office
claude plugin install ai-team@ai-team-office
```

Claude Code 안에서:

1. `/ai-team:ai-team-setup` - 운영 규칙을 보여주고, 동의(yes)할 때만 `~/.claude/CLAUDE.md` 에 추가합니다.
2. `/ai-team:office` - 대시보드를 켜고 http://127.0.0.1:4747 을 엽니다.

### 분배표

| 일의 성격 | 에이전트 | 모델 / effort |
|---|---|---|
| 조회·탐색·상태 확인 | `lookup` | haiku / low |
| 읽기 전용 운영 조사, 스펙 명확한 테스트 보강 | `ops-investigator` / `implementer` | sonnet / medium |
| 구현·마이그레이션 (기본) | `implementer` | opus / high |
| 리뷰·설계·장애 원인·보안 | `reviewer` | opus / high |
| 계획·검증·모호한 결정 | 메인 세션 | 메인 모델 |

### 상태는 어떻게 판정하나

모든 상태는 **관측**(훅 이벤트가 직접 말함) 또는 **추정**(타이머·유추)입니다. 영문 표를 참고하세요: 도구→방 매핑(Bash 는 명령 머리로 자료실/작업대/외부창구/서버실 분류), 막힘 60초, 💤 3분, 흐림 5분, 위임 만료 10분. 컨텍스트 사용량은 표시하지 않고, 메인 모델은 Fable 로 가정합니다. 자세한 내용은 [`office/README.md`](plugins/ai-team/office/README.md).

### 프라이버시

- 로컬 전용: `127.0.0.1` 에만 바인딩하며 외부로 아무것도 보내지 않습니다.
- 토큰 소모 없음: `~/.claude/logs/` 의 훅 이벤트 로그만 읽습니다.
- `--redact` 로 대시보드에 표시되는 프롬프트·경로를 가릴 수 있습니다.

### 크레딧

@cowboy76 님의 오피스 게시글에서 영감을 받았고, [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents), [Claude-Office](https://github.com/W17ant/Claude-Office), [agent-virtual-office](https://github.com/KbWen/agent-virtual-office) 를 참고했습니다.

### 라이선스

MIT. [LICENSE](LICENSE) 참고.
