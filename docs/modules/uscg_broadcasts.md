# `src/alerts/uscg_broadcasts.ts` — USCG Broadcast Notice to Mariners monitor

## Purpose

The 15th alert monitor. Reads the USCG Navigation Center **Broadcast Notice to
Mariners (BNM)** search results for Coast Guard **District 11** (the district
whose Sector Humboldt Bay covers Crescent City / Del Norte) and extracts the
notices relevant to the North Coast.

## Endpoint

- Listing: `https://www.navcen.uscg.gov/broadcast-notice-to-mariners-search-results?district=11&sector=0&date-range={START}--{END}&items_per_page=50`
  - Server-rendered Drupal table — no JS, no API key. Verified live 2026-09-08.
  - Window: trailing 35 days (`USCG_BNM_WINDOW_DAYS`), `items_per_page=50`.
- Message detail: `https://www.navcen.uscg.gov/broadcast-notice-to-mariners-message?guid={GUID}`
  - Fetched **only** for rows that pass the North Coast relevance filter
    (usually zero extra requests per run).

The District 11 *Local* Notice to Mariners page was evaluated first and
rejected: it is a weekly-PDF download list with no per-notice text. The
Sector-Humboldt-Bay-only listing (`sector=37`) is too thin (14 messages in a
90-day window, many with empty geographic fields).

## Surface

| Export | Kind | Notes |
| :--- | :--- | :--- |
| `runUscgBroadcastMonitor()` | orchestrator | fetch → parse → filter → persist; returns `null` on failure (never throws) |
| `parseBnmListing(html)` | pure | listing table → `UscgBnmRow[]` |
| `parseBnmMessage(html)` | pure | detail page → synopsis text (strips the NOS `BT` terminator) |
| `parseBnmTimestamp(raw)` | pure | `"2026-09-04 07:03:12 -0400"` → ISO |
| `isNorthCoastBroadcast(row)` | pure | `NORTH_COAST_KEYWORDS` relevance filter |
| `classifyUscgBroadcast(criticality)` | pure | SAFETY/unknown → `ADVISORY`; CANCELLATION/SUMMARY → `CALM` |
| `buildUscgBroadcastReport(rows, now)` | pure | report with `items` (relevant), `totalBroadcasts`, `worstLevel`, `summary` |
| `appendUscgHistory(items, fetchedAt)` | persistence | bounded JSONL append, deduped by guid |
| `uscgHistoryPath()` / `uscgCurrentPath()` | seam | resolve through `outputRoot()` (honours `CC_OUTPUT_DIR`) |
| `getLastUscgError()` | health | last run's error message for the runner |

## Artifacts

- `output/alerts/uscg/current.json` — the report (atomic write).
- `output/alerts/uscg/history.jsonl` — one record per relevant broadcast,
  deduped by `uscg-<guid>`; read by `src/alert_analytics.ts` (`uscg` is in
  `ALERT_TYPES`).

## Wiring

- `MONITOR_KEYS` / `NULL_ON_FAILURE_MONITORS` / `EXTENDED_MONITOR_SPECS` in
  `src/alerts/composite.ts` (key `"uscg"`, source name
  `"USCG Broadcast Notice to Mariners"`).
- `EXPECTED_SOURCE_HEALTH` in `src/shared/source_health.ts`.
- `scripts/run-alerts.ts` batch (entry `runNullableMonitor("uscg", ...)`).
- Healer roster derives from `ALERT_MONITOR_SOURCE_NAMES` automatically.
- `computeAlertSeverity` (severity.ts) does not yet score the `uscg` composite
  input; `buildExtendedCompositeInput` already shapes it
  (`totalBroadcasts` / `relevantCount` / `worstLevel` / `available`).

## Tests

`tests/uscg-broadcasts.test.ts` — fixture-driven, zero network:
`tests/fixtures/uscg/bnm-d11-listing.html` and
`tests/fixtures/uscg/bnm-message-68955277.html` are verbatim captures of the
live 2026-09-08 NAVCEN pages (US government work, public domain), trimmed to
the content region. History-append tests redirect the artifact root to a tmp
dir via `CC_OUTPUT_DIR`.
