# ai-team (plugin)

Model-routed AI team for Claude Code. The main session plans and verifies; cheaper subagents do the work; every delegation is logged with a verification verdict; an optional pixel-office dashboard shows it live. Full overview, screenshots and the state-derivation table are in the [root README](../../README.md).

## Install

```bash
claude plugin marketplace add bluelang1/ai-team-office
claude plugin install ai-team@ai-team-office
```

## What it installs

**4 agents**

| Agent | Model / effort | Use |
|---|---|---|
| `lookup` | haiku / low | read-only search and status |
| `ops-investigator` | sonnet / medium | read-only ops investigation, drafts change commands |
| `implementer` | opus / high | ticket-sized implementation and tests |
| `reviewer` | opus / high | read-only code review |

**2 hooks** (need `jq`)
- `delegation-log.sh` appends Agent calls, completions and verdicts to `~/.claude/logs/delegation.jsonl`. Record a verdict with `ai-team-verdict <agent_id> <ok|rework|fail> "<note>"`.
- `office-events.sh` appends session and tool activity (tool, one key argument, timestamps, short prompt heads) to `~/.claude/logs/office-events.jsonl`.

**Opt-in extras** (offered by `/ai-team:ai-team-setup`, applied only on an explicit yes, never in default hooks)
- CEO-room relay: `office/hooks/ceo-relay.sh` as `PermissionRequest` / `PreToolUse(AskUserQuestion)` hooks (`timeout` 600), so approvals and questions can be answered in the dashboard (approve/deny, pick, or type an answer; "터미널에서 답할게요" hands it back). Approvals show in the terminal at the same time (first answer wins, held up to 9 min); questions are held briefly. Steps aside when no dashboard tab is open; `OFFICE_RELAY_DISABLE=1` disables it.
- Instruction box: `office/hooks/ceo-stop.sh` as a `Stop` hook (`timeout` 330). When a main session stops with a report that asks you something, type its next instruction in the dashboard. Blocks that session's input while waiting (2 min default; Esc frees it), 8 in a row per session, macOS only.
- Plan limit display: `bin/statusline-tee` wraps your existing statusline and saves its JSON for the dashboard.

**Dashboard features**: a building with one floor per project and a floor editor, a voxel-style pixel office behind a glass curtain wall, ranks/roles/animal nicknames, a CEO room with answerable approvals and questions, terminal focus (macOS only), 5h/7d plan limits and context per session, token usage charts, and a 19:00 cat secretary.

**Limits**: no text into a working session (only answers to what was asked, plus the opt-in instruction to a stopped session), no per-model weekly limit, terminal focus is macOS only.

**Requirements**: `node` >= 20, `jq`, `curl`; macOS for `/focus`.

**2 skills**
- `/ai-team:ai-team-setup` shows the operating rules and, only if you say yes, adds them to `~/.claude/CLAUDE.md`.
- `/ai-team:office [start|stop|status|open]` runs the dashboard at http://127.0.0.1:4747 (needs `node` >= 20).

**Operating rules** live in `rules/OPERATING_RULES.md` (routing table, delegation log, review and gate rules, English and Korean).

## Privacy and security

Everything is local. The dashboard binds to `127.0.0.1` with Host/Origin checks, sends nothing anywhere and consumes zero model tokens; it only reads local logs. Dashboard answers count only while a dashboard tab is open (viewer rule). Start it with `--redact` to hide prompts, messages, cwd and command arguments from what it displays. Logs are not redacted on disk, so delete `~/.claude/logs/*.jsonl` if you need to.

## 한국어

Claude Code 용 모델 라우팅 AI 팀 플러그인입니다. 에이전트 4개(lookup, ops-investigator, implementer, reviewer), 훅 2개(위임 로그, 오피스 이벤트 로그: `~/.claude/logs/`), 스킬 2개(`/ai-team:ai-team-setup`, `/ai-team:office`)와 운영 규칙을 설치합니다. 모든 것은 로컬에서만 동작하며(127.0.0.1, Host/Origin 검사, 토큰 소모 0, `--redact` 지원), 훅에는 `jq`·`curl`, 대시보드에는 `node` 20 이상(터미널 포커스는 macOS)이 필요합니다. 대표실 relay(승인·질문: 터미널과 동시에 뜨고 먼저 답한 쪽이 이김, 승인은 최대 9분 대기, 훅 `timeout` 600), 지시 보내기 Stop 훅(묻는 보고로 멈춘 세션에 다음 지시, 기다리는 동안 그 세션 입력을 막음, 기본 2분, macOS 전용), 플랜 한도 표시는 setup 스킬에서 opt-in 으로 설치합니다. 0.2.10 으로 올리면 setup 을 다시 실행해 relay 훅 `timeout` 을 600 으로 올리고 세션을 재시작하세요. 자세한 설명은 [루트 README](../../README.md) 를 보세요.
