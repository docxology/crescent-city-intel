# Agents Guide — `scripts/`

## Overview

**All files in `scripts/` are thin TypeScript orchestrators.** They contain no
business logic — they import from `src/` and call the appropriate functions.
Every script is runnable directly via `bun run <script-name>`.

## Convention

- **No inline logic** — all computation lives in `src/`.
- **Single responsibility** — one script per functional area.
- **CI-friendly exit codes** — non-zero on failure or detected changes.
- **Real imports, not shell glue** — TypeScript `import` instead of `bun run` subprocess calls.

## Scripts

| Script | npm alias | What it orchestrates |
| :--- | :--- | :--- |
| `weekly-check.ts` | `bun run weekly-check` | Full weekly health check: monitor + all 8 alerts + news + meetings + analytics |
| `run-monitor.ts` | `bun run monitor` | Municipal code change detection (`src/monitor.ts`) |
| `run-alerts.ts` | `bun run alerts` / `bun run alerts:all` | All 8 alert monitors concurrently + composite severity computation |
| `run-news.ts` | `bun run news` | RSS news aggregation (`src/news_monitor.ts`) |
| `run-meetings.ts` | `bun run gov-meetings` | Government meeting scraper (`src/gov_meeting_monitor.ts`) |
| `run-coverage.ts` | `bun run coverage` | Domain coverage analysis |
| `run-readability.ts` | `bun run readability` | Flesch-Kincaid + Gunning Fog scoring |
| `weekly-check.sh` | _(legacy)_ | Bash predecessor to `weekly-check.ts` — kept for reference |
| `cron-setup.sh` | `bun run cron-setup` | macOS Launchd / Linux cron installer |

## v2.0 Changes

- `run-alerts.ts` now runs all 8 monitors (was 3) and computes composite 8-monitor severity, persisting to `output/alerts/composite/current.json`
- `weekly-check.ts` now runs all 8 alert monitors + alert analytics in its weekly cycle

## Adding New Scripts

1. Create `scripts/<name>.ts`
2. Import the relevant function(s) from `src/`
3. Call with minimal argument processing (flags only, no business logic)
4. Add an npm alias in `package.json`
5. Document here and in the root `README.md`
