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

After the rules block is handled (installed, already up to date, or declined), offer the two optional steps below. Show each one and apply it only on an explicit "yes" for that step. Skip silently on no. Both edit `~/.claude/settings.json`: back it up first (`cp ~/.claude/settings.json ~/.claude/settings.json.bak-ai-team`), then **merge** with a minimal edit (e.g. `jq`): add entries to existing arrays, never replace an array or touch unrelated keys. If the file does not exist, create it. Re-read and validate the JSON afterwards.

**Resolve `${CLAUDE_PLUGIN_ROOT}` first.** Settings files do not expand `${CLAUDE_PLUGIN_ROOT}`, so before writing any command into `~/.claude/settings.json`, resolve it to the absolute plugin path (the directory containing this skill's `skills/`, `bin/` and `office/` folders) and write that absolute path. Note that a plugin update changes the install path, so re-run this setup after updating the plugin.

### (a) "대표실 relay" (CEO-room relay)

Explain: lets you answer permission requests and `AskUserQuestion` questions from the dashboard (with a hand-back button). It steps aside instantly when no dashboard tab is open, answers only from the dashboard (never on its own), and `OFFICE_RELAY_DISABLE=1` turns it off. Needs `curl` and a running dashboard (`/ai-team:office start`).

Show and, on yes, merge these two hook entries (idempotent: skip any entry whose command already contains `ceo-relay.sh`), with `<ABS>` the resolved plugin path:

- `hooks.PermissionRequest` += `{"matcher":"*","hooks":[{"type":"command","command":"OFFICE_RELAY_QUESTION_WAIT_MS=60000 \"<ABS>/office/hooks/ceo-relay.sh\"","timeout":180}]}`
- `hooks.PreToolUse` += `{"matcher":"AskUserQuestion","hooks":[{"type":"command","command":"OFFICE_RELAY_QUESTION_WAIT_MS=60000 \"<ABS>/office/hooks/ceo-relay.sh\"","timeout":180}]}`

### (b) "플랜 한도 표시" (plan limits display)

Explain: the dashboard shows 5-hour and 7-day plan limits and per-session context, which Claude Code only exposes through the statusline JSON. A small wrapper saves that JSON locally and then runs your previous statusline unchanged.

On yes:
1. Read `statusLine` from `~/.claude/settings.json`. If it already points at `<ABS>/bin/statusline-tee`, say "already installed" and stop.
2. Save the previous command: write `statusLine.command` (empty file if there was none) to `~/.claude/logs/statusline/.previous-command` (create the directory). If a previous `statusLine` exists with other fields (e.g. `padding`), keep them.
3. Make sure `<ABS>/bin/statusline-tee` is executable (`chmod +x`) and set `statusLine` to `{"type":"command","command":"<ABS>/bin/statusline-tee"}` (keeping other existing fields).
4. Tell the user the wrapper prints exactly what the previous command printed, and prints nothing if there was none.

## Undo

Offer this when the user asks to remove the extras. Back up `~/.claude/settings.json` first, then:

- **Relay**: remove only the entries whose command contains `ceo-relay.sh` from `hooks.PermissionRequest` and `hooks.PreToolUse` (delete an array only if it becomes empty). Alternatively set `OFFICE_RELAY_DISABLE=1` to disable it without editing settings.
- **Plan limits**: read `~/.claude/logs/statusline/.previous-command`; if non-empty, set `statusLine.command` back to it; if empty, remove the `statusLine` key. Then delete `.previous-command`. Captured JSON files in `~/.claude/logs/statusline/` can be deleted too.
