#!/usr/bin/env bash
# Delegation log: records Agent tool calls, completions and verification verdicts to ~/.claude/logs/delegation.jsonl (one JSON line each)
# Usage 1) hook (stdin JSON): PreToolUse/PostToolUse(Agent), SubagentStop
# Usage 2) verdict: delegation-log.sh verdict <agent_id|desc> <ok|rework|fail> "<note>"
LOG="$HOME/.claude/logs/delegation.jsonl"
mkdir -p "$(dirname "$LOG")"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ "${1-}" = "verdict" ]; then
  jq -cn --arg ts "$TS" --arg ref "${2-}" --arg v "${3-}" --arg note "${4-}" --arg sid "${CLAUDE_CODE_SESSION_ID-}" \
    '{ts:$ts,event:"verdict",session_id:$sid,ref:$ref,verdict:$v,note:$note}' >> "$LOG"
  exit 0
fi

# hook mode: truncate long strings to 400 chars (prompt/response heads are enough for evaluation)
jq -c --arg ts "$TS" '
  def trim: if type=="string" and length>400 then .[0:400]+"…" else . end;
  {ts:$ts,
   event:(.hook_event_name // "unknown"),
   session_id:.session_id,
   tool_use_id:.tool_use_id,
   agent_id:(.agent_id // .tool_response.agentId // null),
   agent_type:(.agent_type // .tool_input.subagent_type // null),
   model:(.tool_input.model // .model // null),
   effort:(.tool_input.effort // .effort // null),
   description:(.tool_input.description // null),
   prompt:(.tool_input.prompt|trim),
   prompt_chars:(.tool_input.prompt|if .==null then null else length end),
   response:(.tool_response|if type=="object" then with_entries(.value|=trim) else (.|trim) end),
   usage:(.usage // .tool_response.usage // null),
   duration_ms:(.duration_ms // null)
  } | with_entries(select(.value!=null))' >> "$LOG" 2>/dev/null || true
exit 0
