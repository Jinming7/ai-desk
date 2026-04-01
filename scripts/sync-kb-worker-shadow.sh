#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${KB_WORKER_SHADOW_DIR:-$HOME/Workspace/TicketManagement-kb-worker}"

mkdir -p "$TARGET_DIR"

rsync -a --delete \
  --exclude ".git" \
  --exclude ".vercel" \
  --exclude "logs" \
  --exclude "uploads" \
  "$ROOT_DIR/" "$TARGET_DIR/"

echo "$TARGET_DIR"
