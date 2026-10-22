---
name: ai-team-setup
description: Install or update the AI Team operating rules block in ~/.claude/CLAUDE.md. Shows the rules first and writes only after you say yes. Run as /ai-team:ai-team-setup.
disable-model-invocation: true
---

# AI Team setup

Goal: add the AI Team operating rules to the user's global `~/.claude/CLAUDE.md` safely.

Rules source: `${CLAUDE_PLUGIN_ROOT}/rules/OPERATING_RULES.md`. The part to install is the English block between the markers `<!-- ai-team:begin -->` and `<!-- ai-team:end -->` (markers included), followed by the Korean translation block between `<!-- ai-team:ko-begin -->` and `<!-- ai-team:ko-end -->`. Both are in that file.

Steps:
1. Read `${CLAUDE_PLUGIN_ROOT}/rules/OPERATING_RULES.md` and `~/.claude/CLAUDE.md` (it may not exist yet).
2. Detect an existing block: look for the heading `# AI Team operating rules (ai-team plugin)` together with the markers `<!-- ai-team:begin -->` / `<!-- ai-team:end -->` in `~/.claude/CLAUDE.md`.
   - No block: show the full text that would be appended under the heading `# AI Team operating rules (ai-team plugin)`, and ask the user "Append this to ~/.claude/CLAUDE.md? (yes/no)".
   - Block exists and is identical: say "already up to date" and stop.
   - Block exists but differs: show a short diff of old vs new and ask "Update the existing block in place? (yes/no)". Never add a second block.
3. Do nothing until the user answers yes. On no, stop and change nothing.
4. On yes: back up first (`cp ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.bak-ai-team` if it exists). Append (or replace only the text from the begin marker through the end marker) using a minimal edit. Never modify, reorder or delete any other content in the file. Create the file only if it does not exist.
5. Verify by re-reading the file: exactly one block, other content byte-identical (compare against the backup). Report in 3 lines: what was done, backup path, and a reminder that the verdict helper is `ai-team-verdict <agent_id> <ok|rework|fail> "<reason>"`.

## Optional extras (offer after step 5)

After the rules block is handled (installed, already up to date, or declined), offer the two optional steps below. Show each one and apply it only on an explicit "yes" for that step. Skip silently on no. Both edit `~/.claude/settings.json`: back it up first (once per setup run, before its first settings change: `cp ~/.claude/settings.json ~/.claude/settings.json.bak-ai-team-$(date +%Y%m%d%H%M%S)`; later steps in the same run reuse that backup), then **merge** with a minimal edit (e.g. `jq`): add entries to existing arrays, never replace an array or touch unrelated keys. If the file does not exist, create it. Re-read and validate the JSON afterwards.

**Pick a stable path `<ABS>` first.** Settings files do not expand `${CLAUDE_PLUGIN_ROOT}`, so every command written into `~/.claude/settings.json` needs an absolute path. `${CLAUDE_PLUGIN_ROOT}` itself resolves to a versioned cache folder (`~/.claude/plugins/cache/ai-team-office/ai-team/<version>/`), which an update replaces with a new folder, so hooks written with it would silently keep running the old version. Choose `<ABS>` in this order:

1. **Stable (preferred):** the marketplace checkout `$HOME/.claude/plugins/marketplaces/ai-team-office/plugins/ai-team`, if it exists and contains `office/hooks/ceo-relay.sh` and `bin/statusline-tee`. `claude plugin marketplace update ai-team-office` updates this folder in place, so the path never changes and the hooks follow updates.
2. **Fallback:** the resolved `${CLAUDE_PLUGIN_ROOT}` (the directory containing this skill's `skills/`, `bin/` and `office/` folders). Tell the user: "This path includes the plugin version; re-run `/ai-team:ai-team-setup` after updating the plugin."

Write `<ABS>` into settings as the expanded absolute path (as before), and tell the user which of the two was used.

**Existing entries on a versioned path (offer, then rewrite).** Before (a) and (b), look for commands in `~/.claude/settings.json` that contain `ceo-relay.sh` (in `hooks.PermissionRequest` / `hooks.PreToolUse`) or `ceo-stop.sh` (in `hooks.Stop`) or `statusline-tee` (in `statusLine.command`) and whose path contains `/plugins/cache/`. If any are found and `<ABS>` is the stable path:
- Show each old command and the new one (only the path part changes: inside the quoted path token, replace only the part from its start through `/plugins/cache/ai-team-office/ai-team/<version>` with `<ABS>`, e.g. `"<old>/office/hooks/ceo-relay.sh"` → `"<ABS>/office/hooks/ceo-relay.sh"`; keep env prefixes such as `OFFICE_RELAY_QUESTION_WAIT_MS=60000`, quoting, `timeout` and `matcher` unchanged).
- Ask "Rewrite these to the stable path so they follow plugin updates? (yes/no)". On yes: back up first (once per setup run, before its first settings change: `cp ~/.claude/settings.json ~/.claude/settings.json.bak-ai-team-$(date +%Y%m%d%H%M%S)`; later steps in the same run reuse that backup), change only those `command` strings in place (no new entries, no reordering, nothing else touched), then re-read and validate the JSON. Do **not** touch `~/.claude/logs/statusline/.previous-command` when rewriting `statusline-tee`.
- Idempotent: commands already under `<ABS>` are left alone, and an entry rewritten here counts as installed for (a) / (b).
- If `<ABS>` is the fallback (no marketplace checkout), do not rewrite; just say the entries point at a versioned folder and must be re-run after each update.

### (a) "대표실 relay" (CEO-room relay)

Explain: lets you answer permission requests and `AskUserQuestion` questions from the dashboard (with a hand-back button). A held permission request does not block the terminal: its prompt shows there at the same time and whichever answers first wins, so it is held up to 9 minutes (540 s). A held question delays the terminal's question UI until the hook returns, so it is kept short (60 s here). It steps aside instantly when no dashboard tab is open, answers only from the dashboard (never on its own), and `OFFICE_RELAY_DISABLE=1` turns it off. Needs `curl` and a running dashboard (`/ai-team:office start`).

Show and, on yes, merge these two hook entries (idempotent: skip any entry whose command already contains `ceo-relay.sh`, whatever its path; a versioned path is handled by the rewrite above), with `<ABS>` the path chosen above:

- `hooks.PermissionRequest` += `{"matcher":"*","hooks":[{"type":"command","command":"OFFICE_RELAY_QUESTION_WAIT_MS=60000 \"<ABS>/office/hooks/ceo-relay.sh\"","timeout":600}]}`
- `hooks.PreToolUse` += `{"matcher":"AskUserQuestion","hooks":[{"type":"command","command":"OFFICE_RELAY_QUESTION_WAIT_MS=60000 \"<ABS>/office/hooks/ceo-relay.sh\"","timeout":600}]}`

The `timeout` must be at least the hook's wait / 1000 + 5 seconds (the permission default wait is 540000 → ≥ 545), otherwise Claude Code kills the hook first and a dashboard answer is refused (410). **Existing installs:** if a `ceo-relay.sh` entry already exists with a `timeout` below 545 (earlier versions wrote 180), show it and offer "Raise the timeout to 600 so approvals can wait the full 9 minutes? (yes/no)". On yes: back up first (as above, once per run), change only that `timeout` value in place, re-read and validate the JSON. On no, leave it: the hook then gives up after `timeout` seconds and the terminal prompt simply stays.

### (a2) "대표실 지시 보내기" (Stop relay, optional, after (a))

Explain: when a main session stops with a report that asks you something (e.g. "다음 결정: …를 정해 주세요"), the 대표실 card gets a box to type the next instruction; sending it makes Claude continue with that text (Stop hook `{"decision":"block","reason":…}`). It waits only while a dashboard tab is visible and only for reports that ask; while it waits (2 minutes by default) the terminal shows the Stop hook running and that session cannot take terminal input (Esc stops it, or press "터미널에서 할게요" on the card). `OFFICE_RELAY_DISABLE=1` turns it off. Needs `curl`, `jq` and a running dashboard.

Show and, on yes, merge this entry (idempotent: skip if any `hooks.Stop` command already contains `ceo-stop.sh`, whatever its path), with `<ABS>` the path chosen above:

- `hooks.Stop` += `{"hooks":[{"type":"command","command":"\"<ABS>/office/hooks/ceo-stop.sh\"","timeout":330}]}`

The `timeout` (330 s) pairs with the hook's maximum wait: `OFFICE_RELAY_STOP_WAIT_MS` defaults to 120000 and is clamped to 320000 (curl waits up to wait + 5 s = 325 s < 330 s). Keep that pairing if you change either. The dashboard offers at most 8 instructions in a row per session (Claude Code's own stop-hook continuation cap) and only on macOS (it needs the caller-process check).

### (b) "플랜 한도 표시" (plan limits display)

Explain: the dashboard shows 5-hour and 7-day plan limits and per-session context, which Claude Code only exposes through the statusline JSON. A small wrapper saves that JSON locally and then runs your previous statusline unchanged.

On yes:
1. Read `statusLine` from `~/.claude/settings.json`. If its command already contains `statusline-tee` (any path), say "already installed" and stop (a versioned path is handled by the rewrite above; never wrap `statusline-tee` in itself).
2. Save the previous command: write `statusLine.command` (empty file if there was none) to `~/.claude/logs/statusline/.previous-command` (create the directory). If a previous `statusLine` exists with other fields (e.g. `padding`), keep them.
3. Make sure `<ABS>/bin/statusline-tee` is executable (`chmod +x`) and set `statusLine` to `{"type":"command","command":"<ABS>/bin/statusline-tee"}` (keeping other existing fields).
4. Tell the user the wrapper prints exactly what the previous command printed, and prints nothing if there was none.

## Undo

Offer this when the user asks to remove the extras. Back up `~/.claude/settings.json` first, then:

- **Relay**: remove only the entries whose command contains `ceo-relay.sh` (whatever its path: stable, versioned cache or a local checkout) from `hooks.PermissionRequest` and `hooks.PreToolUse`, and those containing `ceo-stop.sh` from `hooks.Stop` (delete an array only if it becomes empty). Alternatively set `OFFICE_RELAY_DISABLE=1` to disable both without editing settings.
- **Plan limits** (only if `statusLine.command` contains `statusline-tee`, whatever its path): read `~/.claude/logs/statusline/.previous-command`; if non-empty, set `statusLine.command` back to it; if empty, remove the `statusLine` key. Then delete `.previous-command`. Captured JSON files in `~/.claude/logs/statusline/` can be deleted too.
