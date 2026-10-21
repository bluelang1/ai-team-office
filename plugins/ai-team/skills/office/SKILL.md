---
name: office
description: Start, stop, check or open the AI Team pixel office dashboard (local only, http://127.0.0.1:4747). Run as /ai-team:office [start|stop|status|open].
argument-hint: "[start|stop|status|open]"
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/office/start.sh *)
---

# AI Team office dashboard

Argument: `$ARGUMENTS` (default `start` when empty). The dashboard is local only and listens on 127.0.0.1:4747; it consumes no model tokens.

- `start`: run `${CLAUDE_PLUGIN_ROOT}/office/start.sh start`, then open http://127.0.0.1:4747 in the browser (`open` on macOS, `xdg-open` on Linux).
- `stop`: run `${CLAUDE_PLUGIN_ROOT}/office/start.sh stop`.
- `status`: run `${CLAUDE_PLUGIN_ROOT}/office/start.sh status` and report running or not.
- `open`: only open http://127.0.0.1:4747 (start first if status says not running).

If `${CLAUDE_PLUGIN_ROOT}/office/start.sh` does not exist, tell the user the dashboard files are not installed in this version and stop. Report the result in 2 lines.
