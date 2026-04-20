#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

echo "[dev-reset] cleaning project dev processes and occupied ports..."

# 1) kill listeners on common local ports
for port in 4000 5173; do
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true
done >> "$TMP_FILE"

# 2) kill stale dev processes from this workspace
ps -ax -o pid= -o command= | awk -v root="$ROOT_DIR" '
  index($0, root) > 0 {
    if ($0 ~ /concurrently/ || $0 ~ /tsx watch src\/index\.ts/ || $0 ~ /vite([[:space:]]|$)/ || $0 ~ /npm run dev/) {
      print $1
    }
  }
' >> "$TMP_FILE"

PIDS="$(sort -u "$TMP_FILE" | tr '\n' ' ' | xargs 2>/dev/null || true)"
if [ -n "${PIDS}" ]; then
  echo "[dev-reset] killing pids: ${PIDS}"
  # shellcheck disable=SC2086
  kill -9 ${PIDS} 2>/dev/null || true
else
  echo "[dev-reset] no stale process found"
fi

if [ "${1:-}" = "--clean-only" ]; then
  echo "[dev-reset] clean-only mode completed"
  exit 0
fi

echo "[dev-reset] starting dev services on http://localhost:5173 and http://localhost:4000"
cd "$ROOT_DIR"
exec npm run dev
