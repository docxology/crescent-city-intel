# Geo-Intel Module

## `src/geo.ts` — Crescent City geo-intelligence contract

Builds a **stable, machine-readable Geo-Intel snapshot** for external geospatial
consumers (notably the GEO-INFER geodesign ecosystem). It distills the scraped
municipal code + curated civic-domains surface into a focused JSON contract so a
map-based dashboard can import and spatially weight Crescent City policy without
re-scraping.

There are 12 civic intelligence domains in the curated surface (defined in
`src/domains.ts`, documented in `docs/modules/domains.md`); this module projects
them into a geospatial contract plus a hazard-relevant subset.

## Contract shape (`buildGeoIntel`)

The returned object is a plain JSON value with this shape:

```typescript
{
  schema: "crescent-city-geo-intel/v1",
  anchor: {
    name, guid, municipality, county, state,
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
| `CRESCENT_CITY_ANCHOR` | `object` | Authoritative city + Del Norte bounds (WGS84) |
| `buildGeoIntel(domainList?)` | `(IntelligenceDomain[]) → Record<string, unknown>` | Build the full contract (pure) |
| `hazardRelevantDomains()` | `() → Array<{…}>` | Subset of domains with hazard-tagged topics |
| `geoPaths` | `{ pagesSeed, liveExport }` | `pages-data/geo-intel.json` + `output/geo-intel.json` |
| `writeGeoIntelExports()` | `() → Promise<string[]>` | Write committed seed + live export (guarded) |

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
maps: GEO-INFER's Del Norte / Crescent City dashboard reads it, maps its 12
civic domains + hazard-relevant subset onto H3 hexes, and weights the municipal
policy surface by natural-hazard intent (tsunami, seismic, flood, erosion).

## Tests

`tests/geo-intel.test.ts` (7) — anchor coordinates/bounds, schema + 12-domain
count, code cross-refs, hazard-relevant surface, injected-domain purity.

Run with: `bun run test` (suite) or `bun test tests/geo-intel.test.ts`.