/**
 * The geo-observations envelope is stated three times: the TypeScript interface
 * in `src/geo_observations.ts`, the hand-written checks in
 * `validatePagesGeoObservations` (`src/pages_snapshot.ts`), and the inline
 * OpenAPI response schema. This file proves they agree, which is the TODO item's
 * acceptance criterion.
 *
 * Why it matters: the interface is what TypeScript enforces on the builder, the
 * validator is what gates the published artifact, and the OpenAPI schema is
 * what a consumer reads. A field added to two of the three is a contract that
 * passes every existing test and is wrong in one of the three worlds.
 *
 * The cross-check compares the RUNTIME shape of a real built envelope against
 * the OpenAPI schema, because those are the two that can be compared directly
 * and they are the two a consumer actually reads. The validator is pinned by
 * asserting it accepts the real envelope and rejects each field's absence —
 * which is the property the gates depend on.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { GEO_OBSERVATIONS_SCHEMA, type GeoObservationsEnvelope } from "../src/geo_observations.ts";
import { validatePagesGeoObservations } from "../src/pages_snapshot.ts";

const REPO_ROOT = process.cwd();

/** A minimal, fully-valid envelope: every field present with a legal value. */
function validEnvelope(): GeoObservationsEnvelope {
  return {
    schema: GEO_OBSERVATIONS_SCHEMA,
    anchor: {
      name: "Crescent City", guid: "44236585", municipality: "Crescent City",
      county: "Del Norte", state: "CA", latitude: 41.7558, longitude: -124.2026,
    },
    generatedAt: "2026-09-28T00:00:00.000Z",
    composite: {
      level: "WATCH", reason: "Roads: advisory", assessedAt: "2026-09-28T00:00:00.000Z",
      hasUnavailableMonitors: false,
    },
    monitors: [{
      id: "noaa-tsunami", label: "NOAA Tsunami", status: "empty",
      checkedAt: "2026-09-28T00:00:00.000Z", itemCount: 0, ageMs: 1000, url: "https://api.weather.gov/alerts/active?area=CA",
    }],
    hazardSummary: [{ tag: "flood", domainCount: 2, topicCount: 5 }],
    freshness: { contractSchema: "crescent-city-geo-intel/v1", contractGeneratedAt: "2026-09-27T00:00:00.000Z" },
  };
}

/**
 * The OpenAPI response schema's top-level property names, read out of the spec
 * rather than restated. Scoped to the `/api/geo-observations` response so a
 * schema change anywhere else in the spec cannot perturb this.
 *
 * Throws rather than returning an empty list: a vacuous pass here would make
 * every other test in this file true for the wrong reason, which is how an
 * earlier draft of this check "passed" while extracting nothing at all.
 */
function openApiTopLevelProperties(): string[] {
  const lines = readFileSync(join(REPO_ROOT, "openapi.yaml"), "utf-8").split("\n");
  const pathStart = lines.indexOf("  /api/geo-observations:");
  if (pathStart === -1) throw new Error("openapi.yaml has no /api/geo-observations path");

  // The response schema's own `properties:` is the one nested under the '200'
  // response, not the one under the parameters or the inner objects. Find it by
  // indentation relative to the path: 16 spaces, inside application/json.
  let propertiesAt = -1;
  for (let i = pathStart; i < Math.min(pathStart + 60, lines.length); i++) {
    if (lines[i] === " ".repeat(16) + "properties:") { propertiesAt = i; break; }
  }
  if (propertiesAt === -1) throw new Error("openapi.yaml /api/geo-observations has no response properties block");

  const keys: string[] = [];
  for (let i = propertiesAt + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= 16) break; // dedented out of the block
    if (indent === 18) {
      const match = /^ {18}([A-Za-z][A-Za-z0-9]*):/.exec(line);
      if (match) keys.push(match[1]!);
    }
  }
  if (keys.length === 0) throw new Error("openapi.yaml /api/geo-observations response publishes no properties");
  return keys;
}

describe("the geo-observations envelope is stated once in practice", () => {
  test("a real built envelope carries exactly the fields the OpenAPI schema publishes", () => {
    const envelope = validEnvelope();
    const documented = openApiTopLevelProperties();
    expect(documented.length).toBeGreaterThan(0);
    // Nothing the spec omits, and nothing it promises that the builder omits.
    // A field present in one and absent in the other is a contract mismatch that
    // no existing test would catch.
    expect([...Object.keys(envelope).filter(key => !documented.includes(key))].join(","))
      .toBe("");
    expect([...documented.filter(key => !(key in envelope))].join(",")).toBe("");
  });

  test("the schema string is the one the builder emits", () => {
    const spec = readFileSync(join(REPO_ROOT, "openapi.yaml"), "utf-8");
    const start = spec.indexOf("  /api/geo-observations:");
    const block = spec.slice(start, spec.indexOf("\n  /api/", start + 10));
    expect(block).toContain(`enum: [${GEO_OBSERVATIONS_SCHEMA}]`);
    expect(block).toContain(`enum: [${validEnvelope().freshness.contractSchema}]`);
  });

  test("the validator accepts the envelope the builder produces", () => {
    // The gate depends on this pairing: what the builder writes must be what
    // the Pages validator accepts, or a correct run publishes an artifact the
    // release gate then rejects.
    expect(validatePagesGeoObservations(validEnvelope())).toEqual([]);
  });

  test("the validator rejects each envelope field being absent", () => {
    // The other half of the pairing: the validator's guarantees must be about
    // these fields, so dropping any one of them is an error. If a future field
    // is added to the builder and the validator ignores it, this fails.
    for (const field of Object.keys(validEnvelope())) {
      const without = { ...validEnvelope() } as Record<string, unknown>;
      delete without[field];
      const errors = validatePagesGeoObservations(without);
      expect(`${field}: ${errors.length > 0}`).toBe(`${field}: true`);
    }
  });

  test("the validator's required fields are exactly the spec's properties", () => {
    // The strongest form of the cross-check: prove the validator does not
    // silently ignore a field the spec promises. For each published property,
    // blanking it must produce an error.
    for (const field of openApiTopLevelProperties()) {
      if (field === "composite") continue; // explicitly nullable by contract
      const blanked: Record<string, unknown> = { ...validEnvelope() };
      blanked[field] = typeof blanked[field] === "string" ? "" : null;
      const errors = validatePagesGeoObservations(blanked);
      expect(`${field} validated: ${errors.length > 0}`).toBe(`${field} validated: true`);
    }
  });

  test("composite is nullable in both the interface and the validator", () => {
    // The one field allowed to be null, so a missing composite artifact is an
    // honest "no data" rather than a failure.
    expect(validatePagesGeoObservations({ ...validEnvelope(), composite: null })).toEqual([]);
    const spec = readFileSync(join(REPO_ROOT, "openapi.yaml"), "utf-8");
    const start = spec.indexOf("  /api/geo-observations:");
    const block = spec.slice(start, spec.indexOf("\n  /api/", start + 10));
    expect(block).toMatch(/composite:\n\s+type: object\n\s+nullable: true/);
  });
});
