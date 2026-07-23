# Intelligence Modules — v2.0 Documentation

This document covers all new modules added in v2.0.0.

## New Alert Monitors

### EPA AirNow Air Quality (`src/alerts/epa_airnow.ts`)

Fetches real-time Air Quality Index (AQI) data from the EPA AirNow API for
Crescent City (ZIP 95531).

**Data sources**: `airnowapi.org/aq/observation/zipCode/current/`
**Requires**: `AIRNOW_API_KEY` env var (free at airnowapi.org)
**Output**: `output/alerts/airquality/current.json` + `history.jsonl`
**API endpoint**: `GET /api/alerts/airquality`

Parameters tracked: PM2.5, Ozone (O3), PM10

AQI classification:
| AQI Range | Level | Health Advisory |
|---|---|---|
| 0-50 | GOOD | None |
| 51-100 | MODERATE | Sensitive groups caution |
| 101-150 | UNHEALTHY_SENSITIVE | Limit outdoor activity |
| 151-200 | UNHEALTHY | All affected |
| 201-300 | VERY_UNHEALTHY | Stay indoors |
| 301+ | HAZARDOUS | Emergency |

### CAL FIRE Wildfire (`src/alerts/calfire_wildfire.ts`)

Fetches active wildfire incidents from CAL FIRE for Del Norte County and
surrounding areas (Siskiyou, Humboldt, Trinity).

**Data sources**: `fire.ca.gov/imap/imapdata/all`
**Output**: `output/alerts/wildfire/current.json` + `history.jsonl`
**API endpoint**: `GET /api/alerts/wildfire`

Tracked per incident: acres burned, containment %, evacuation orders/warnings,
structures threatened/destroyed, distance from Crescent City (Haversine).

Severity classification:
| Condition | Level |
|---|---|
| Evacuation orders active | EMERGENCY |
| Large fire (>1000 ac, <50% contained) nearby | WARNING |
| Any active incident | ADVISORY |
| No incidents | NONE |

### NDBC Marine Buoy (`src/alerts/ndbc_marine.ts`)

Fetches real-time marine observations from 3 NDBC buoy stations nearest
to Crescent City.

**Data sources**: `ndbc.noaa.gov/data/realtime2/`
**Output**: `output/alerts/marine/current.json` + `history.jsonl`
**API endpoint**: `GET /api/alerts/marine`

Monitored stations:
| Station | Name | Distance |
|---|---|---|
| 46027 | St Georges CA | 27 NM NW |
| 46022 | Eel River CA | 120 NM S |
| 46214 | Humboldt Bay CA | 60 NM S |

Parameters: wave height (ft), wave period (s), wind speed (kt), wind direction,
water temperature (F), air temperature (F), barometric pressure (hPa).

Severity thresholds:
| Condition | Level |
|---|---|
| Wave ≥15 ft or wind ≥34 kt (gale) | WARNING |
| Wave ≥10 ft or wind ≥22 kt | WATCH |
| Long-period swell ≥15 s | WATCH |
| Normal conditions | CALM |

## Composite 8-Monitor Severity (`src/alerts/severity.ts`)

Aggregates all 8 alert monitors into a single composite severity level.

**Priority order**: EMERGENCY > WARNING > WATCH > CALM
**API endpoint**: `GET /api/alerts/composite`

The composite takes the highest severity across all monitors. Each monitor
contributes a `MonitorStatus` with level, summary, and count.

## Structured Query Engine (`src/structured_queries.ts`)

### Legislative History
- `parseLegislativeHistory(text)` — parses ordinance chain from history field
- `GET /api/history/:guid` — full legislative history for a section

### Section Comparison
- `compareSections(guid1, guid2)` — word-level diff between two sections
- `GET /api/compare?guid1=X&guid2=Y` — API endpoint

Returns: lines unique to each, common lines, word count delta, similarity ratio.

### Semantic Similarity
- `findSimilarSections(guid, limit)` — cosine-similarity term overlap search
- `GET /api/similar/:guid?limit=N` — API endpoint

Uses cosine similarity on term frequency vectors with a 1.5× boost for
sections in the same Title.

### Cross-Reference Validation
- `resolveCrossReferences(guid)` — resolve § references in a single section
- `validateAllCrossReferences()` — validate all refs across entire corpus
- `GET /api/cross-refs/validate` — API endpoint

Returns: total references, resolved count, unresolved references, resolution rate,
and the sections with the most unresolved references.

## Legal Citation Parser (`src/legal_parser.ts`)

### Citation Extraction
- `extractCitations(text)` — finds CA Code, U.S.C., case law citations
- `extractOrdinanceAmendments(historyText)` — parses ordinance chain
- `GET /api/citations/:guid` — API endpoint

Supported citation types:
- California Code (Government, Health & Safety, Penal, Vehicle, Water, etc.)
- Federal law (U.S.C.)
- Case law (X v. Y pattern)
- Ordinance references (Ord. No. XXXX)

### Definition Glossary
- `extractDefinitions(text, sectionNumber)` — finds "shall mean"/"means" patterns
- `buildGlossary(sections)` — builds glossary from entire corpus
- `GET /api/glossary` — API endpoint

### Effective Date Extraction
- `extractEffectiveDate(historyText)` — most recent amendment year

## Fuzzy Search (`src/shared/fuzzy.ts`)

Levenshtein edit distance for typo-tolerant search.

- `levenshtein(a, b)` — edit distance between two strings
- `similarity(a, b)` — normalized 0-1 similarity ratio
- `closestMatch(query, candidates, threshold)` — best match from vocabulary
- `fuzzyCorrect(queryWords, vocabulary, threshold)` — corrections for unknown words
- `expandQueryFuzzy(query, vocabulary)` — expand query with corrections
- `GET /api/fuzzy?q=...` — API endpoint

Integrated into `src/gui/search.ts` as fallback: when BM25 returns 0 results,
fuzzy corrections are returned in `fuzzyCorrections` field.

## Streaming RAG (`src/llm/streaming_rag.ts`)

Server-Sent Events for word-by-word RAG answer streaming.

- `POST /api/chat/stream` — SSE endpoint

Event structure:
1. `event: sources` — JSON array of source sections
2. `event: token` — each token of the generated answer
3. `event: done` — final metadata (model, latency, sources)
4. `event: error` — on failure

## Alert Analytics (`src/alert_analytics.ts`)

Aggregates all alert history JSONL files across all 8 monitor types.

- `buildAlertAnalytics()` — full analytics report
- `getRecentAlerts(limit)` — most recent events across all types
- `getAlertsByType(type, fromDate, toDate)` — filtered by type and date range
- `GET /api/alerts/timeline` — unified chronological timeline
- `GET /api/alerts/recent?limit=N` — recent alerts

Per-type statistics: total events, first/last event, severity distribution,
average events per day.

## Expanded Intelligence Domains

3 new domains added (12 total):

### Climate & Environment
Topics: Climate adaptation & sea-level rise, Drought & water conservation,
Air quality & environmental justice.

### Demographics & Social Indicators
Topics: Population & demographic profile, Poverty & economic vulnerability,
Homelessness & housing instability.

### Public Health & Safety
Topics: Emergency medical services, Food safety & restaurant inspection,
Mental health & crisis response.

## Monthly Report Integration

The monthly civic health report now includes sections for all new alert types:
- Air Quality (peak AQI, unhealthy days)
- Wildfire Activity (incident count, evacuation orders)
- Marine Conditions (peak wave height, wind speed, advisories)
