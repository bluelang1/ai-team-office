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
