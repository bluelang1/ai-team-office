# Changelog

## 0.2.0 - 2026-10-21

- Dashboard: building with one floor per project and a floor editor; voxel-style pixel office with glass curtain wall view; ranks, roles and animal nicknames.
- CEO room: answerable permission requests and questions, hand-back button, terminal focus (macOS), 5h/7d plan limits and per-session context, token usage charts, 19:00 cat secretary.
- Opt-in extras in `/ai-team:ai-team-setup`: CEO-room relay hook and plan-limit statusline wrapper (`bin/statusline-tee`), each with undo. Relay is not in the default hooks.
- `office-events.sh` now records `tuid`, `ask`, `tty` and uses `CLAUDE_PROJECT_DIR` for the project name.
- Security: Host/Origin checks, viewer rule, 127.0.0.1 only; honest limits documented (no free-form text injection, no per-model weekly limit).

## 0.1.0 - 2026-10-21

- Marketplace `ai-team-office` with plugin `ai-team`.
- Agents: `lookup` (haiku/low), `ops-investigator` (sonnet/medium), `implementer` (opus/high), `reviewer` (opus/high).
- Hooks: delegation log with verdicts (`delegation.jsonl`) and office event feed (`office-events.jsonl`).
- Skills: `/ai-team:ai-team-setup` (installs operating rules after confirmation), `/ai-team:office` (start/stop/status of the dashboard).
- Operating rules block (EN + KO) and `ai-team-verdict` helper.
- Pixel office dashboard: zero dependencies, 127.0.0.1 only, zero tokens, `--redact`, replay mode, light/dark themes.

## 0.2.1 — 2026-10-21
- CEO room: the CEO faces the door; visitors queue in front of the desk facing him
- Night view: occasional shooting stars over the mountains; couples strolling in the park

## 0.2.2 — 2026-10-21
- CEO room: report cards show the full report (scrollable, copy button); removed the empty-room note
- CEO sits properly in a high-back executive chair
- Fix: sent-back reports no longer reappear after reconnect; card no longer re-renders every second
- Hook: keep up to 4000 chars of the final message on Stop/SubagentStop; bound non-string values
- Add CLAUDE.md contributor guide

## 0.2.3 — 2026-10-21
- CEO room: the idle ping ~60s after a turn ends no longer replaces the open report card (report body stays visible)
- Header shows the running version, e.g. `AI Team Office (v0.2.3)`, read from `plugin.json` via `/healthz`

## 0.2.4 — 2026-10-21
- CEO room relay: permission prompts are held while any dashboard tab is open, even in the background (questions still need a visible tab); a reload no longer drops pending items (5s grace on close)
- A page left open across a server restart reloads itself for a fresh viewer token
- "입력을 기다리고 있어요" (idle) is a short-lived 대기 중 card, no longer "답이 필요해요"
- Server log says why a request was not relayed
