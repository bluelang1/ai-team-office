#!/usr/bin/env bash
# 대표실 Stop relay (opt-in, hooks.Stop): when a MAIN session's final report asks the 대표 something and a dashboard
# is on screen, forward it to the AI Team Office server and wait for an instruction typed in the dashboard. Prints
# {"decision":"block","reason":"<instruction>"} ONLY when the dashboard sent one (Claude Code then keeps working with
# that reason, per the hooks docs); in every other case (server down, no visible dashboard, the report does not ask,
# a subagent, timeout, released to the terminal, error, OFFICE_RELAY_DISABLE=1) it prints nothing and exits 0 = Claude
# stops as usual. stop_hook_active=true may still wait: every continuation is typed by the human.
# Env: OFFICE_PORT (4747), OFFICE_RELAY_STOP_WAIT_MS (120000; 100..320000 — the cap keeps curl's wait+5 s under the
#      hook timeout 330 s the setup writes), OFFICE_RELAY_DISABLE=1 (no-op).
# The JSON printed is built here from one narrow field (.decision.text), cleaned again (CR/CRLF -> \n, other control
# characters -> space, trimmed, 2000 characters): the server cannot make this script print anything else.
set -u
[ "${OFFICE_RELAY_DISABLE:-}" = "1" ] && exit 0
command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 || exit 0

input=$(cat) || exit 0
pre=$(jq -r 'if (.hook_event_name // "") == "Stop" and ((.agent_id // "") == "")
  and ((.last_assistant_message // "") | type == "string" and length > 0) then "go" else "" end' <<<"$input" 2>/dev/null) || exit 0
[ "$pre" = "go" ] || exit 0          # whether the report asks is decided by the server (public/ceo.js reportAsks)

wait_ms=${OFFICE_RELAY_STOP_WAIT_MS:-120000}
# 1..7 decimal digits only (else the default), read as base 10 (never octal), then clamped (same as ceo-relay.sh).
if [[ "$wait_ms" =~ ^[0-9]{1,7}$ ]]; then wait_ms=$((10#$wait_ms)); else wait_ms=120000; fi
(( wait_ms < 100 )) && wait_ms=100
(( wait_ms > 320000 )) && wait_ms=320000
port=${OFFICE_PORT:-4747}
[[ "$port" =~ ^[0-9]{1,5}$ ]] || exit 0
port=$((10#$port))
max_s=$(( wait_ms / 1000 + 5 ))
[ -n "${OFFICE_RELAY_DEBUG:-}" ] && printf 'ceo-stop: wait_ms=%s max_time=%s\n' "$wait_ms" "$max_s" >&2

# -q: ignore ~/.curlrc; --noproxy: never via a proxy; --connect-timeout 1: dashboard down = step aside at once.
resp=$(printf '%s' "$input" | curl -q -s --fail --noproxy '*' --connect-timeout 1 --max-time "$max_s" \
  -H 'Content-Type: application/json' --data-binary @- \
  "http://127.0.0.1:${port}/relay/ask?waitMs=${wait_ms}" 2>/dev/null) || exit 0
[ -n "$resp" ] || exit 0

out=$(jq -c '
  if .kind != "instruct" or ((.decision // null) | type) != "object" or ((.decision.text // null) | type) != "string" then empty
  else (.decision.text | gsub("\r\n?"; "\n") | gsub("[\\x00-\\x09\\x0b-\\x1f\\x7f]+"; " ")
        | sub("^[[:space:]]+"; "") | sub("[[:space:]]+$"; "") | .[0:2000]) as $t
    | if ($t | length) > 0 then {decision: "block", reason: $t} else empty end
  end' <<<"$resp" 2>/dev/null) || exit 0
[ -n "$out" ] && printf '%s\n' "$out"
exit 0
