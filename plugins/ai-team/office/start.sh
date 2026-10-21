#!/usr/bin/env bash
# AI Team Office background runner: ./start.sh start|stop|restart|status [server flags...]
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
RUN="$DIR/.run"; PID="$RUN/server.pid"; LOG="$RUN/server.log"
mkdir -p "$RUN"
cmd="${1:-start}"; [ $# -gt 0 ] && shift

pid_of() { [ -f "$PID" ] && tr -cd '0-9' <"$PID"; }
# Running = the pid file names a live process that really is this server (guards against pid reuse).
running() {
  local p; p="$(pid_of)" || return 1; [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null && ps -p "$p" -o command= 2>/dev/null | grep -qF "$DIR/server.mjs"
}
port_of() { local p=4747 prev=""; for a in "$@"; do [ "$prev" = "--port" ] && p="$a"; prev="$a"; done; echo "$p"; }

case "$cmd" in
  start)
    if running; then echo "이미 실행 중 (pid $(pid_of))"; exit 0; fi
    nohup node "$DIR/server.mjs" "$@" >>"$LOG" 2>&1 &
    echo $! >"$PID"
    sleep 0.6
    if running; then echo "시작함 pid $(pid_of) → http://127.0.0.1:$(port_of "$@")  (로그: $LOG)"
    else echo "시작 실패. 로그 끝:"; tail -n 20 "$LOG"; rm -f "$PID"; exit 1; fi ;;
  stop)
    if running; then
      p="$(pid_of)"; kill "$p"
      for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
        kill -0 "$p" 2>/dev/null || break; sleep 0.1
      done
      if kill -0 "$p" 2>/dev/null; then echo "3초 안에 안 끝남 (pid $p). 직접 확인: ps -p $p"; exit 1; fi
      echo "중지함 pid $p"
    else echo "실행 중 아님"; fi
    rm -f "$PID" ;;
  restart) "$0" stop || exit 1; exec "$0" start "$@" ;;
  status)
    if running; then echo "실행 중 pid $(pid_of)"; tail -n 3 "$LOG"; else echo "중지됨"; exit 1; fi ;;
  *) echo "usage: $0 start|stop|restart|status [--port N] [--redact] [--replay file --speed N]"; exit 2 ;;
esac
