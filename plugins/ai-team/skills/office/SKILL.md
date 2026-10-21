---
name: office
description: Start, stop, restart, check or open the AI Team pixel office dashboard (local only, http://127.0.0.1:4747). Run as /ai-team:office [start|stop|restart|status|open]; use restart after a plugin update.
argument-hint: "[start|stop|restart|status|open]"
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/office/start.sh *)
---

# AI Team office dashboard

Argument: `$ARGUMENTS` (default `start` when empty). The dashboard is local only and listens on 127.0.0.1:4747; it consumes no model tokens.

- `start`: run `${CLAUDE_PLUGIN_ROOT}/office/start.sh start`, then open http://127.0.0.1:4747 in the browser (`open` on macOS, `xdg-open` on Linux).
- `stop`: run `${CLAUDE_PLUGIN_ROOT}/office/start.sh stop`.
- `status`: run `${CLAUDE_PLUGIN_ROOT}/office/start.sh status` and report running or not. If it says another version folder is running, suggest `/ai-team:office restart`.
- `restart`: run `${CLAUDE_PLUGIN_ROOT}/office/start.sh restart`. It stops the running dashboard even if it was started by an older plugin version, then starts this version. Open tabs reload by themselves; the header shows `(vX.Y.Z)` of the running server. Use this after `claude plugin update`, from a session started after the update: an older session's `${CLAUDE_PLUGIN_ROOT}` still points at the previous version, so restarting from it would bring the old version back. If `status` here reports another version folder and this folder's `../.claude-plugin/plugin.json` version is the older one, say so and suggest a new session instead of restarting.
- `open`: only open http://127.0.0.1:4747 (start first if status says not running).

If `${CLAUDE_PLUGIN_ROOT}/office/start.sh` does not exist, tell the user the dashboard files are not installed in this version and stop. Report the result in 2 lines.
