#!/usr/bin/env bash
# Daily LifeOS / Pulse bridge run for Crescent City.
# Refreshes the platform's real outputs (news, gov meetings, alerts), then writes
# the LocalIntelligence digest the Pulse LOCAL tab reads. Best-effort: a failing
# fetcher never blocks the digest write (the bridge fills from whatever output
# exists). Schedule via Hermes cron (lifeos-crescent-city-digest) or cron-setup.
set -uo pipefail
cd "$(dirname "$0")/.."
bun run scripts/run-news.ts       >/dev/null 2>&1 || true
bun run scripts/run-meetings.ts   >/dev/null 2>&1 || true
bun run scripts/run-alerts.ts     >/dev/null 2>&1 || true
bun run scripts/lifeos-bridge.ts
