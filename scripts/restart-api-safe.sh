#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
ROOT="${SCRIPT_DIR:h}"
PORT="${PORT:-4000}"
LOG_FILE="${LOG_FILE:-/tmp/ticket-api.log}"

cd "$ROOT"

PIDS=()

while IFS= read -r pid; do
  [[ -n "$pid" ]] && PIDS+=("$pid")
done < <(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)

while IFS= read -r pid; do
  [[ -n "$pid" ]] && PIDS+=("$pid")
done < <(ps -axo pid=,command= | rg "TicketManagement/apps/api/.+(src/index.ts|dist/index.js)" | awk '{print $1}' || true)

if (( ${#PIDS[@]} > 0 )); then
  UNIQUE_PIDS=("${(@u)PIDS}")
  kill "${UNIQUE_PIDS[@]}" 2>/dev/null || true
  sleep 1
fi

nohup node apps/api/dist/index.js >"$LOG_FILE" 2>&1 &
NEW_PID=$!

for _ in {1..30}; do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo "API process exited before startup completed" >&2
    tail -n 120 "$LOG_FILE" >&2 || true
    exit 1
  fi

  if lsof -nP -a -p "$NEW_PID" -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "$NEW_PID"
    exit 0
  fi

  sleep 1
done

echo "API did not start listening on port $PORT in time" >&2
tail -n 120 "$LOG_FILE" >&2 || true
exit 1
