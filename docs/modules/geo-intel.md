# Geo-Intel Module

## `src/geo.ts` — transferable municipality geo-intelligence contract

Builds a **stable, machine-readable Geo-Intel snapshot** for external geospatial
consumers (notably the GEO-INFER geodesign ecosystem). The builder is
**municipality-agnostic**: any city can emit a contract from a `MunicipalitySpec`
(anchor + curated civic-domain surface). **Crescent City, CA is the default /
anchor implementation**, and its contract schema (`crescent-city-geo-intel/v1`)
is pinned so GEO-INFER's CrescentCityIntelMapper keeps importing it unchanged.

It distills a municipality's scraped municipal code + curated civic-domains
surface into a focused JSON contract so a map-based dashboard can import and
spatially weight city policy without re-scraping.

Crescent City has 12 civic intelligence domains in the curated surface (defined
in `src/domains.ts`, documented in `docs/modules/domains.md`); this module
projects them into a geospatial contract plus a hazard-relevant subset.

## Municipality framework

Any city is served by the same pure builder. Provide a spec and get a contract:

```typescript
type MunicipalitySpec = {
  // Contract identifier — becomes the output `schema` (stable across re-runs).
  id: string;
  // Geographic + civic identity; fields are per-municipality.
  anchor: {
    name, guid, municipality, county, state,
    latitude, longitude,
    bounds: { west, south, east, north }   // WGS84 decimal degrees
  };
  // Curated civic-intelligence domain surface for this city.
  domains: IntelligenceDomain[];
};
```

## Contract shape (`buildGeoIntel` / `buildMunicipalityContract`)

The returned object is a plain JSON value with this shape (anchor fields are
per-municipality; the `schema` string is the caller's spec `id`):

```typescript
{
  schema: "crescent-city-geo-intel/v1",   // = spec.id; frozen for Crescent City
  anchor: {
    name, guid, county, state,
    latitude: 41.76, longitude: -124.2,
    bounds: { west, south, east, north }   // Del Norte County extent
  },
  generatedAt: string,          // ISO timestamp
  domainCount: 12,
  domains: [{
    id, name, icon, description, updatedAt,
    topicCount, tags: string[],
    sections: [{ sectionNumber, relevance }]   // municipal-code cross-refs
  }],
  hazard: {
    relevantDomainCount: number,
    relevantDomains: [{
      id, name, icon,
      hazardTags: string[],      // tsunami, seismic, flood, fire, erosion, …
      topics: [{ name, tags, sections }]
    }]
  }
}
```

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `CRESCENT_CITY_ANCHOR` | `MunicipalityAnchor` | Authoritative Crescent City + Del Norte bounds (WGS84) — the default anchor |
| `getDefaultCrescentSpec()` | `() → MunicipalitySpec` | Current anchor + 12 domains as data (not hardcoded in the builder) |
| `buildMunicipalityContract(spec)` | `(MunicipalitySpec) → Record<string, unknown>` | **Transferable** pure builder for any city's contract |
| `buildGeoIntel(domainList?)` | `(IntelligenceDomain[]) → Record<string, unknown>` | Backward-compatible Crescent shorthand (resolves the default spec, delegates to the transferable builder) |
| `hazardRelevantDomains(surface?)` | `(IntelligenceDomain[]?) → Array<{…}>` | Hazard-tagged subset; moves with the supplied surface (defaults to the in-repo 12) |
| `geoPaths` | `{ pagesSeed, liveExport }` | `pages-data/geo-intel.json` + `output/geo-intel.json` |
| `writeGeoIntelExports()` | `() → Promise<string[]>` | Write the default (Crescent) contract to committed seed + live export (guarded) |

Consumers that currently call `buildGeoIntel(domains)` or read
`pages-data/geo-intel.json` observe **no change**: output structure and schema
string are preserved. Sibling cities call `buildMunicipalityContract(spec)`
directly for their own anchor + domains.

## `src/geo_view.ts` — map-ready feature view (`buildGeoView`)

Turns the geo-intel contract into a **tiles-free, GeoJSON-shaped feature
surface** a client can render directly onto a blank canvas or any projection:

1. **Del Norte County bounds polygon** — a closed 4-vertex `Polygon` ring.
2. **City anchor point** — Crescent City centroid (`kind: "anchor"`).
3. **One point per hazard-relevant civic domain** — deterministic, anchor-relative
   offsets (`HAZARD_OFFSETS`), each flagged `nominal: true` because the contract
   carries no per-domain surveyed coordinates (honest placement — no fabricated
   locations).
4. **Aggregated municipal-code section references** — each section with the
   domains + topics that cite it, sorted numerically.
5. **Hazard-intent summary** — tag frequency across relevant domains
   (`hazardTags` + top-6 `topHazardTags`).

Output schema: `crescent-city-geo-view/v1`, CRS `EPSG:4326`. The builder is a
**pure function** — it takes the `buildGeoIntel()` output (or any
schema-compatible object) and returns a JSON-safe structure, with defensive
normalization so malformed/partial contracts degrade to Crescent defaults
rather than throwing.

| Export | Signature | Description |
| :--- | :--- | :--- |
| `buildGeoView(raw)` | `(Record<string, unknown>) → GeoIntelView` | Build the map-ready feature view from a geo-intel contract |
| `buildGeoIntelSurface(raw)` | `(Record<string, unknown>) → GeoIntelSurface` | Add the tiles-free `view` without mutating the contract; shared by `/api/geo-intel` and Pages |

`GET /api/geo-intel` returns the contract **and** this feature view together;
see `openapi.yaml` for the response schema.

## CLI

```bash
bun run geo:intel        # alias in package.json
bun run src/geo.ts       # direct
```

Writes:

- `pages-data/geo-intel.json` — committed public seed readable without a live `output/`
- `output/geo-intel.json` — live export (skipped gracefully if `output/` absent)

## Geospatial consumers

The `pages-data/geo-intel.json` seed is a dependency-free import for downstream
maps: GEO-INFER's Crescent City dashboard reads it, maps Crescent's 12 civic
domains + hazard-relevant subset onto H3 hexes, and weights the municipal policy
surface by natural-hazard intent (tsunami, seismic, flood, erosion). Because
the builder is transferable, sibling cities export their own spec through the
same `buildMunicipalityContract` path and are consumed identically.

The static Pages exporter preserves that seed shape for direct consumers and
publishes an additive API-shaped `data/geo-intel.json`: all contract fields stay
at the top level and `view` is produced by `buildGeoIntelSurface`. The live API
route calls the same pure builder, preventing API/Pages shape drift.

## Tests

`tests/geo-intel.test.ts` (13) — anchor coordinates/bounds, default-spec data
shape, schema + 12-domain count, code cross-refs, hazard-relevant surface,
injected-domain purity, a second-municipality example proving the builder is
transferable while Crescent City stays GEO-INFER-compatible, and word-boundary
hazard matching.

`tests/geo-view.test.ts` — bounds polygon closure + ring order, anchor point,
per-hazard-domain points with `nominal` flags + section counts, section
aggregation, hazard-tag summary, defensive fallback on malformed input.

### Hazard matching

The hazard subset uses **word-boundary** keyword matching (not exact tag
equality), so composite tags surface their hazard intent: `"flood zone"` matches
`flood`, `"sea level rise"` matches `sea level`, `"climate adaptation"` matches
`climate`, and `"tsunami zone"` / `"tsunami drill"` match `tsunami`. Words are
matched on boundaries so `"stormwater"` does not falsely read as `storm`. With
the in-repo Crescent surface this flags **4** hazard-relevant domains
(emergency-management, environmental-protection, event-planning,
climate-environment) and carries flood + sea-level policy the prior consumers
(RISK/BAYES/ACT) receive as defaults.

Run with: `bun run test` (suite) or `bun test tests/geo-intel.test.ts`.
