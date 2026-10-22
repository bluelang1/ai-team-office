#!/usr/bin/env bash
# 대표실 relay hook: forwards a PermissionRequest (matcher "*") or PreToolUse(AskUserQuestion) to the AI Team Office
# server and waits for the dashboard. Prints a decision ONLY when the dashboard answered; in every other case
# (server down, no dashboard open, timeout, error, OFFICE_RELAY_DISABLE=1) it prints nothing and exits 0, which
# Claude Code treats as "no decision" -> the native terminal prompt applies.
# Env: OFFICE_PORT (4747), OFFICE_RELAY_WAIT_MS (permission: 540000 = the max; the terminal prompt shows alongside,
#      so holding never blocks it — first answer wins; 100..540000), OFFICE_RELAY_QUESTION_WAIT_MS (question: defaults
#      to OFFICE_RELAY_WAIT_MS if set, else 120000 — a held question delays the terminal question UI until the hook
#      returns), OFFICE_RELAY_DISABLE=1 (no-op). The hook `timeout` must be >= wait/1000 + 5 (setup writes 600).
# The JSON printed is built here from narrow fields (behavior, message, answers) — the server cannot make this
# script rewrite tool input or add permission rules. Questions are echoed back from Claude Code's own stdin.
# A PermissionRequest for AskUserQuestion is answered like a question (allow + updatedInput.answers), never a bare
# allow; it uses the long approval wait because its terminal UI is already showing.
set -u
[ "${OFFICE_RELAY_DISABLE:-}" = "1" ] && exit 0
command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 || exit 0

input=$(cat) || exit 0
ev=$(jq -r '.hook_event_name // ""' <<<"$input" 2>/dev/null) || exit 0
tool=$(jq -r '.tool_name // ""' <<<"$input" 2>/dev/null) || exit 0

default_ms=540000
wait_ms=${OFFICE_RELAY_WAIT_MS:-540000}
case "$ev" in
  PermissionRequest) ;;
  PreToolUse) [ "$tool" = "AskUserQuestion" ] || exit 0; default_ms=120000; wait_ms=${OFFICE_RELAY_QUESTION_WAIT_MS:-${OFFICE_RELAY_WAIT_MS:-120000}} ;;
  *) exit 0 ;;
esac
# 1..7 decimal digits only (else the default), read as base 10 (`060000` is 60000, `0800` is 800 — never octal),
# then clamped; nothing longer reaches arithmetic, so no overflow. curl gets wait/1000 + 5 seconds.
if [[ "$wait_ms" =~ ^[0-9]{1,7}$ ]]; then wait_ms=$((10#$wait_ms)); else wait_ms=$default_ms; fi
(( wait_ms < 100 )) && wait_ms=100
(( wait_ms > 540000 )) && wait_ms=540000
port=${OFFICE_PORT:-4747}
[[ "$port" =~ ^[0-9]{1,5}$ ]] || exit 0
port=$((10#$port))
max_s=$(( wait_ms / 1000 + 5 ))
[ -n "${OFFICE_RELAY_DEBUG:-}" ] && printf 'ceo-relay: wait_ms=%s max_time=%s\n' "$wait_ms" "$max_s" >&2

# -q: ignore ~/.curlrc; --noproxy: never send this to an HTTP proxy; --connect-timeout 1: dashboard down = step aside.
resp=$(printf '%s' "$input" | curl -q -s --fail --noproxy '*' --connect-timeout 1 --max-time "$max_s" \
  -H 'Content-Type: application/json' --data-binary @- \
  "http://127.0.0.1:${port}/relay/ask?waitMs=${wait_ms}" 2>/dev/null) || exit 0
[ -n "$resp" ] || exit 0

# The answers for a question card (PreToolUse(AskUserQuestion), or a PermissionRequest FOR AskUserQuestion): an object
# of strings from the server, kept only for Claude Code's own question texts, cleaned and capped below.
answers_of() { jq -c '(.decision.answers // null) | if type == "object" and length > 0 and all(.[]; type == "string") then . else empty end' <<<"$resp" 2>/dev/null; }
# $1 = hookEventName: PreToolUse -> permissionDecision allow + updatedInput; PermissionRequest -> decision allow + updatedInput.
question_out() {
  local answers; answers=$(answers_of) || return 0
  [ -n "$answers" ] || return 0
  jq -c --argjson a "$answers" --arg evn "$1" '
    (.tool_input // {}) as $in
    | [($in.questions // [])[] | .question] as $qs
    | ($a | with_entries(select(.key as $k | any($qs[]; . == $k)) | .value |= (gsub("[[:cntrl:]]+"; " ") | .[0:500]))) as $ans
    | if ($ans|length) == ($qs|length) and ($qs|length) > 0
      then (if $evn == "PermissionRequest"
            then {hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior: "allow", updatedInput: ($in + {answers: $ans})}}}
            else {hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: ($in + {answers: $ans})}} end)
      else empty end' <<<"$input" 2>/dev/null
}

if [ "$ev" = "PermissionRequest" ] && [ "$tool" = "AskUserQuestion" ]; then
  # The terminal question UI is already showing (a permission prompt does not wait for this hook), so a bare "allow"
  # would do nothing: only answers count, and only when every question is answered.
  out=$(question_out PermissionRequest) || exit 0
elif [ "$ev" = "PermissionRequest" ]; then
  out=$(jq -c '
    (.decision // null) as $d
    | if ($d|type) != "object" then empty
      elif $d.behavior == "allow" then {hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior: "allow"}}}
      elif $d.behavior == "deny" then
        (($d.message // "") | if type == "string" then gsub("[[:cntrl:]]+"; " ") | .[0:500] else "" end) as $m
        | {hookSpecificOutput: {hookEventName: "PermissionRequest",
            decision: ({behavior: "deny"} + (if ($m|length) > 0 then {message: $m} else {} end))}}
      else empty end' <<<"$resp" 2>/dev/null) || exit 0
else
  out=$(question_out PreToolUse) || exit 0
fi
[ -n "$out" ] && printf '%s\n' "$out"
exit 0
