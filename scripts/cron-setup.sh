#!/bin/bash
# Delegate explicit scheduling plans and owned file operations to Bun.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/scheduler-plan.ts" "$@"
