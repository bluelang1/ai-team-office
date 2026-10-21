# Changelog

## 0.1.0 - 2026-10-21

- Marketplace `ai-team-office` with plugin `ai-team`.
- Agents: `lookup` (haiku/low), `ops-investigator` (sonnet/medium), `implementer` (opus/high), `reviewer` (opus/high).
- Hooks: delegation log with verdicts (`delegation.jsonl`) and office event feed (`office-events.jsonl`).
- Skills: `/ai-team:ai-team-setup` (installs operating rules after confirmation), `/ai-team:office` (start/stop/status of the dashboard).
- Operating rules block (EN + KO) and `ai-team-verdict` helper.
- Pixel office dashboard: zero dependencies, 127.0.0.1 only, zero tokens, `--redact`, replay mode, light/dark themes.
