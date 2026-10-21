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

**2 skills**
- `/ai-team:ai-team-setup` shows the operating rules and, only if you say yes, adds them to `~/.claude/CLAUDE.md`.
- `/ai-team:office [start|stop|status|open]` runs the dashboard at http://127.0.0.1:4747 (needs `node` >= 20).

**Operating rules** live in `rules/OPERATING_RULES.md` (routing table, delegation log, review and gate rules, English and Korean).

## Privacy

Everything is local. The dashboard binds to `127.0.0.1`, sends nothing anywhere and consumes zero model tokens; it only reads the two log files. Start it with `--redact` to hide prompts, messages, cwd and command arguments from what it displays. Logs are not redacted on disk, so delete `~/.claude/logs/*.jsonl` if you need to.

## 한국어

Claude Code 용 모델 라우팅 AI 팀 플러그인입니다. 에이전트 4개(lookup, ops-investigator, implementer, reviewer), 훅 2개(위임 로그, 오피스 이벤트 로그: `~/.claude/logs/`), 스킬 2개(`/ai-team:ai-team-setup`, `/ai-team:office`)와 운영 규칙을 설치합니다. 모든 것은 로컬에서만 동작하며(127.0.0.1, 토큰 소모 0, `--redact` 지원), 훅에는 `jq`, 대시보드에는 `node` 20 이상이 필요합니다. 자세한 설명은 [루트 README](../../README.md) 를 보세요.
