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
