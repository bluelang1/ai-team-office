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

## 0.2.5 — 2026-10-21
- Tests: closing the visible tab with a hidden one open releases only questions; `not relayed` log line (control characters masked); `staleBoot` reload rule
- Docs: DESIGN-v2 relay hold rules and idle card; CLAUDE.md commands and gotchas

## 0.2.6 — 2026-10-21
- CEO room: a dashboard answer is now part of the event history (`RelayDecided`, from `ceo-decisions.jsonl`), so after a reload or restart an approved, still-running command no longer comes back as a "답이 필요해요" card without buttons; a late permission_prompt does not reopen it

## 0.2.7 — 2026-10-22
- Plugin agents (`ai-team:reviewer`, `ai-team:implementer` …) get their real job (심사/개발/조사) instead of 사원; reviewers work in the QA room
- Inline scripts that write files (`python3 - <<EOF … open(p,'w')`, `node -e … writeFileSync`) count as coding (개발실)
- CEO room: side-view drawer pedestal facing the 대표; newcomers knock ("똑똑") at the door before queuing (not on reload, skipped under reduced motion)
- Hover card stays open while the pointer is on the card (300ms grace); pressing or focusing inside pins it, so 승인/거부 is one click

## 0.2.8 — 2026-10-22
- README (EN/KO): Update and Troubleshooting sections; keep the dashboard tab open
- `/ai-team:office restart`; `start.sh` stops a dashboard started by another plugin version (node process only), so restart after an update runs the new version
- Setup writes hooks via the version-independent marketplace path and offers to move existing versioned-cache hooks there (timestamped backup)
- New screenshots (sim data)

## 0.2.9 — 2026-10-22
- CEO room: every card opens whole in a right-side drawer (크게 보기): big reading area with decision highlight, lists, links, A−/A+, and the card's own actions
- CEO room list: click the 대표 or +N for a sortable table (온 시각·기다린 시간·종류·프로젝트·누가·내용), 답 필요만/전체 filter, multi-select bulk 돌려보내기 (hides only, never answers)
- Reports that end by asking (다음 결정 …, 할까요?) stay as 결정 대기 (marked 추정) instead of expiring after 90s; capped at 3h
- Opt-in `ceo-stop.sh` Stop hook: send an instruction to a session from the dashboard (same-origin + viewer token + not-Claude caller; 8 in a row per session; macOS only)
- "터미널에서 답할게요" hands a held request to the terminal at once; cards say why there are no buttons (expired after Ns, no dashboard, relay not installed)
- Relay default wait 170s → 120s; Stop wait capped at 320s
- Session grouping (×N) only when the 대표실 overflows; hover needs a 150ms rest to switch people, the open card wins
- Fix: 전체 보기 no longer draws a cut-off 대표실; `OFFICE_TEST_ANCESTRY` only honoured under `node --test`
