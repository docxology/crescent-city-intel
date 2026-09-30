# AGENTS.md — crescent-city-intel/.github/workflows

- `weekly.yml` — "Weekly Intelligence Cycle": cron `0 7 * * 1` (Mondays
  07:00 UTC) + manual dispatch; weekly health check, optional full scrape
  (input `run_scrape`, requires Chromium).
- `pages.yml` — "Publish Public Intelligence Snapshot": push to `main`,
  cron `30 8 * * 1` (after the weekly window), manual dispatch; builds and
  publishes the public snapshot site.
Secrets/vars used include `CRESCENT_CITY_API_KEY`, `OLLAMA_URL`.