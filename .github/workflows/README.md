# Workflows

- `pr-gate.yml`: strict source/tests types, canonical contract checks,
  conservative affected-test selection, real GUI browser smoke, and
  desktop/mobile public Pages reader journeys.
- `pages.yml`: full release gate and public Pages reader journeys, bounded
  isolated municipal acquisition, fresh feeds, complete
  same-edition public-tree validation, and unchanged Pages upload/deploy. Its
  private job tools pin official standalone yt-dlp 2026.08.19 and Deno 2.9.7,
  check bounded HTTPS downloads against fixed SHA-256 digests before execution,
  and verify exact versions before source collection. Bun remains the app and
  check runtime. Source failures and unavailable transcripts remain explicit.
- `weekly.yml`: explicit headless Linux browser mode and real protocol
  preflight, the authoritative contracts/types/plain/coverage gate, full
  current-cycle monitor evidence, with exact artifact handoff
  from optional manual scraping to downstream verification/analysis.

See [AGENTS.md](AGENTS.md). Offline configuration checks, hosted runs, live source
acceptance, and public deployment are separate evidence planes.
