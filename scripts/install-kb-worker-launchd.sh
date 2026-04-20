#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_TEMPLATE="$ROOT_DIR/ops/com.nexusflow.kb-worker.plist.template"
PLIST_TARGET="$HOME/Library/LaunchAgents/com.nexusflow.kb-worker.plist"
LOG_DIR="$ROOT_DIR/logs"
LABEL="com.nexusflow.kb-worker"
UID_VALUE="$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

sed "s|__ROOT_DIR__|$ROOT_DIR|g" "$PLIST_TEMPLATE" > "$PLIST_TARGET"
chmod 644 "$PLIST_TARGET"
chmod +x "$ROOT_DIR/scripts/run-kb-worker-launchd.sh"

launchctl bootout "gui/$UID_VALUE" "$PLIST_TARGET" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID_VALUE" "$PLIST_TARGET"
launchctl enable "gui/$UID_VALUE/$LABEL"
launchctl kickstart -k "gui/$UID_VALUE/$LABEL"
launchctl print "gui/$UID_VALUE/$LABEL" | sed -n '1,40p'
