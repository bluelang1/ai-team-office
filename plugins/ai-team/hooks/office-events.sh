#!/usr/bin/env bash
# Event log for the AI Team Office dashboard: one line per hook event (all sessions and subagents) in ~/.claude/logs/office-events.jsonl.
LOG="$HOME/.claude/logs/office-events.jsonl"
mkdir -p "$(dirname "$LOG")"
TS=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
jq -c --arg ts "$TS" '
  def head(n): if .==null then null elif type=="string" then (if length>n then .[0:n]+"…" else . end) else (tojson|.[0:n]) end;   # non-strings bounded too
  def proj: ((env.CLAUDE_PROJECT_DIR // .cwd // "") | split("/") | last);
  (.tool_input // {}) as $i |
  (if .hook_event_name=="Stop" or .hook_event_name=="SubagentStop" then 4000 else 300 end) as $msgmax |
  {ts:$ts,
   ev:(.hook_event_name // "unknown"),
   sid:.session_id,
   proj:proj,
   cwd:.cwd,
   aid:(.agent_id // null),
   atype:(.agent_type // null),
   tool:(.tool_name // null),
   tuid:(.tool_use_id // null),
   effort:(.effort|if type=="object" then .level else . end),
   mode:.permission_mode,
   dur:(.duration_ms // null),
   # one key argument per tool
   target:(
     $i.file_path // $i.path // $i.pattern // $i.url // $i.query //
     ($i.command|head(120)) // $i.description // $i.skill // $i.name // null),
   # for delegations: which agent, which model
   sub:(if .tool_name=="Agent" then {type:$i.subagent_type, model:$i.model, effort:$i.effort, desc:$i.description, prompt:($i.prompt|head(200))} else null end),
   child:(.tool_response.agentId // null),
   resolved:(.tool_response.resolvedModel // null),
   prompt:(.prompt|head(200)),
   # Stop/SubagentStop: the final report (hook input `last_assistant_message`, per the hooks docs; the transcript may
   # lag), kept long enough to read in the 대표실 card. Other events (Notification) stay short.
   msg:(.message // .last_assistant_message | head($msgmax)),
   ntype:(.notification_type // null),
   # calls that need a human answer: question text (AskUserQuestion) / approval target (PermissionRequest)
   ask:(if .tool_name=="AskUserQuestion" then (($i.questions // [])|map(.question // "")|join(" / ")|head(300))
        elif .hook_event_name=="PermissionRequest" then ((.tool_name // "") + " " + (($i.command // $i.file_path // $i.url // $i.description // "")|tostring|head(160)))
        else null end),
   tty:(.tty // null),
   trigger:(.trigger // null),
   ok:(if .hook_event_name=="PostToolUseFailure" then false else null end),
   err:(.error|head(200))
  } | with_entries(select(.value!=null))' >> "$LOG" 2>/dev/null || true
exit 0
