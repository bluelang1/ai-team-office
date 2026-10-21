#!/usr/bin/env bash
# Event feed for the AI Team Office dashboard: one line per session/subagent activity in ~/.claude/logs/office-events.jsonl
LOG="$HOME/.claude/logs/office-events.jsonl"
mkdir -p "$(dirname "$LOG")"
TS=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
jq -c --arg ts "$TS" '
  def head(n): if type=="string" then (if length>n then .[0:n]+"…" else . end) else . end;
  def proj: (.cwd // "" | split("/") | last);
  (.tool_input // {}) as $i |
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
   # for delegations: who, which model
   sub:(if .tool_name=="Agent" then {type:$i.subagent_type, model:$i.model, effort:$i.effort, desc:$i.description, prompt:($i.prompt|head(200))} else null end),
   child:(.tool_response.agentId // null),
   resolved:(.tool_response.resolvedModel // null),
   prompt:(.prompt|head(200)),
   msg:(.message // .last_assistant_message | head(300)),
   ntype:(.notification_type // null),
   trigger:(.trigger // null),
   ok:(if .hook_event_name=="PostToolUseFailure" then false else null end),
   err:(.error|head(200))
  } | with_entries(select(.value!=null))' >> "$LOG" 2>/dev/null || true
exit 0
