#!/usr/bin/env bash
# Thin entry point; package.json owns commands and version metadata.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required. Install it from https://bun.sh." >&2
  exit 1
fi
exec bun run src/interactive_menu.ts "$@"
