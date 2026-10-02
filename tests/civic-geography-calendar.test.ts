import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultCivicProfile, validateCivicProfile, withCivicProfile, type CivicProfile } from "../src/civic_profile.ts";
import { buildGeoIntel, buildMunicipalityContract, getDefaultCrescentSpec, writeGeoIntelExports, prepareCivicGeoExportRoots } from "../src/geo.ts";
import { buildGeoView, buildGeoViewSvg } from "../src/geo_view.ts";
import { buildHazardObservations, loadObservationInputs, type GeoObservationInput } from "../src/geo_observations.ts";
import { buildEventsArtifact, buildEventsIcs, civicDay, classify, collectEvents, pacificDay, parseEventDate, escapeIcsText } from "../src/events.ts";
import { withOutputRoot } from "../src/shared/paths.ts";

const eastern: CivicProfile = validateCivicProfile({
  ...defaultCivicProfile, id: "example-eastern", name: "Example Civic", municipality: "Example Civic, NY", county: "Example County", state: "New York",
  timeZone: "America/New_York", code: null, corpusSlug: "example-eastern-code", vectorNamespace: "example-eastern-code",
  anchor: { latitude: 42, longitude: -73, bounds: { west: -74, south: 41, east: -72, north: 43 } },
  calendar: { uidDomain: "example-eastern-intel", productId: "-//Example Civic//Events Calendar//EN" },
  publication: { title: "Example Civic Intelligence", description: "Synthetic offline method acceptance", siteUrl: "https://example.org", repositoryUrl: "https://example.org/repository" },
  capabilities: ["geo", "events"],
});
const clock = new Date("2026-09-30T04:30:00Z");

describe("generic civic geography and calendar methods", () => {
  test("explicit empty municipality domains remain empty; Crescent defaults keep their surface", () => {
    const spec = getDefaultCrescentSpec();
    expect(buildMunicipalityContract({ ...spec, domains: [] }).domainCount).toBe(0);
    expect(buildGeoIntel([]).domainCount).toBe(12);
    withCivicProfile(eastern, () => {
      const contract = buildGeoIntel();
      expect(contract.schema).toBe("civic-geo-intel/v1");
      expect(contract.profileId).toBe(eastern.id);
      expect(contract.domainCount).toBe(0);
      expect(contract.domains).toEqual([]);
      expect(contract.hazard).toEqual({ relevantDomains: [], relevantDomainCount: 0 });
      expect(contract.anchor).toMatchObject({ name: eastern.name, guid: eastern.id, latitude: 42, longitude: -73 });
      expect(buildGeoIntel([]).domainCount).toBe(0);
    });
  });

  test("second-profile geo map and observations retain only that identity", () => {
    withCivicProfile(eastern, () => {
      const contract = buildGeoIntel();
      const view = buildGeoView(contract);
      expect(view.schema).toBe("civic-geo-view/v1");
      expect(view.profileId).toBe(eastern.id);
      expect(view.anchor.county).toBe("Example County");
      expect(view.features[0]!.id).toBe("municipality-bounds");
      expect(view.features[0]!.properties.label).toBe("Example County extent");
      const svg = buildGeoViewSvg(view);
      expect(svg).toContain("Example Civic civic and hazard geo view");
      expect(svg).toContain("Example County extent");
      expect(svg).not.toContain("Crescent City");
      expect(svg).not.toContain("Del Norte");
      const envelope = buildHazardObservations({ anchor: contract.anchor as GeoObservationInput["anchor"], profileId: eastern.id, contractSchema: String(contract.schema), generatedAt: clock.toISOString(), composite: null, monitors: [], hazardDomains: [], contractGeneratedAt: null });
      expect(envelope.schema).toBe("civic-geo-observations/v1");
      expect(envelope.profileId).toBe(eastern.id);
      expect(envelope.freshness.contractSchema).toBe("civic-geo-intel/v1");
      expect(envelope.anchor.name).toBe(eastern.name);
      expect(envelope.hazardSummary).toEqual([]);
    });
  });

  test("malformed foreign anchors and falsely claimed Crescent schemas fail explicitly", () => {
    withCivicProfile(eastern, () => {
      const contract = buildGeoIntel();
      const anchor = contract.anchor as Record<string, unknown>;
      for (const invalid of [{ ...anchor, latitude: NaN }, { ...anchor, longitude: 181 }, { ...anchor, county: undefined }, { ...anchor, bounds: { west: -72, east: -74, south: 41, north: 43 } }, { ...anchor, bounds: { west: -74, east: -72, south: 43, north: 44 } }]) {
        expect(() => buildGeoView({ ...contract, anchor: invalid })).toThrow("anchor");
      }
      expect(() => buildGeoView({ schema: "civic-geo-intel/v1" })).toThrow("anchor");
      expect(() => buildGeoView({ ...contract, schema: "crescent-city-geo-intel/v1" })).toThrow("geographic identity");
      expect(() => buildGeoView({ ...contract, profileId: "Example\nOther" })).toThrow("profile identity");
      expect(() => buildMunicipalityContract({ ...getDefaultCrescentSpec(), anchor: anchor as unknown as ReturnType<typeof getDefaultCrescentSpec>["anchor"] })).toThrow("geographic identity");
      const input: GeoObservationInput = { anchor: anchor as unknown as GeoObservationInput["anchor"], generatedAt: clock.toISOString(), composite: null, monitors: [], hazardDomains: [], contractGeneratedAt: null };
      expect(() => buildHazardObservations({ ...input, anchor: { ...input.anchor, latitude: Infinity } })).toThrow("coordinates");
      expect(() => buildHazardObservations({ ...input, contractSchema: "crescent-city-geo-intel/v1" })).toThrow("geographic identity");
      expect(() => buildHazardObservations({ ...input, profileId: "Example\nOther" })).toThrow("profile identity");
      const view = buildGeoView(contract);
      expect(() => buildGeoViewSvg({ ...view, anchor: { ...view.anchor, latitude: 91 } })).toThrow("coordinates");
    });
  });

  test("nominal marker offsets stay inside narrow foreign bounds and longitude labels use their hemisphere", () => {
    const contract = buildMunicipalityContract({
      id: "civic-geo-intel/v1", profileId: "example-east",
      anchor: { name: "Example East", guid: "example-east", municipality: "Example East", county: "Example Extent", state: "Example Region", latitude: 35.697, longitude: 139.7, bounds: { west: 139.699, south: 35.696, east: 139.701, north: 35.698 } },
      domains: [0, 1, 2].map(index => ({ id: `hazard-${index}`, name: `Hazard ${index}`, icon: "!", description: "Explicit synthetic flood policy", updatedAt: "2026-09-30", topics: [{ name: "Flood policy", description: "Supplied policy surface", tags: ["flood"], sources: [] }] })),
    });
    const view = buildGeoView(contract);
    for (const feature of view.features) {
      if (feature.geometry.type !== "Point") continue;
      expect(feature.geometry.coordinates[0]!).toBeGreaterThanOrEqual(view.anchor.bounds.west);
      expect(feature.geometry.coordinates[0]!).toBeLessThanOrEqual(view.anchor.bounds.east);
      expect(feature.geometry.coordinates[1]!).toBeGreaterThanOrEqual(view.anchor.bounds.south);
      expect(feature.geometry.coordinates[1]!).toBeLessThanOrEqual(view.anchor.bounds.north);
    }
    const svg = buildGeoViewSvg(view);
    expect(svg).toContain("139.699° E");
    expect(svg).not.toContain("139.699° W");
  });

  test("civil dates follow the profile while pacificDay remains explicitly Pacific", () => {
    expect(pacificDay(clock)).toBe("2026-09-29");
    withCivicProfile(eastern, () => {
      expect(civicDay(clock)).toBe("2026-09-30");
      expect(parseEventDate(clock.toISOString())).toBe("2026-09-30");
      expect(parseEventDate("Wed, 30 Sep 2026 04:30:00 GMT")).toBe("2026-09-30");
      expect(classify("2026-09-29", clock)).toBe("completed");
      expect(classify("2026-09-30", clock)).toBe("scheduled");
      expect(pacificDay(clock)).toBe("2026-09-29");
      expect(civicDay(new Date("2026-03-08T06:59:00Z"))).toBe("2026-03-08");
      expect(civicDay(new Date("2026-03-08T07:01:00Z"))).toBe("2026-03-08");
      expect(() => civicDay(clock, "Not/A_Timezone")).toThrow();
      expect(() => civicDay(new Date(NaN))).toThrow("clock");
      expect(() => validateCivicProfile({ ...eastern, timeZone: "Not/A_Timezone" })).toThrow("timezone");
    });
  });

  test("calendar identity is independently configurable and rejects line injection", () => {
    const events = [{ id: "example-event", title: "Example meeting", dateStart: "2026-09-30", location: null, description: "", sourceLinks: ["https://example.org/event"], status: "scheduled" as const }];
    const prior = buildEventsIcs(events);
    expect(prior).toContain("UID:example-event@crescent-city-intel");
    expect(prior).toContain("PRODID:-//Crescent City Intel//Events Calendar//EN");
    withCivicProfile(eastern, () => {
      const ics = buildEventsIcs(events);
      expect(ics).toContain("UID:example-event@example-eastern-intel");
      expect(ics).toContain("PRODID:-//Example Civic//Events Calendar//EN");
      expect(ics).not.toContain("Crescent City");
      expect(buildEventsArtifact(clock.toISOString(), []).schemaVersion).toBe("civic-events/v1");
      expect(buildEventsArtifact(clock.toISOString(), []).profileId).toBe(eastern.id);
      expect(() => buildEventsIcs(events, { uidDomain: "example.org\r\nBEGIN:VEVENT" })).toThrow("calendar identity");
      expect(() => buildEventsIcs(events, { productId: "Example\nBEGIN:VEVENT" })).toThrow("calendar identity");
      expect(() => validateCivicProfile({ ...eastern, calendar: { ...eastern.calendar, uidDomain: "example.org\r\nUID:other" } })).toThrow();
      expect(() => validateCivicProfile({ ...eastern, calendar: { ...eastern.calendar, productId: "Example\nBEGIN:VEVENT" } })).toThrow();
    });
  });

  test("calendar collection uses the selected civil day for status and ordering", async () => {
    const root = await mkdtemp(join(tmpdir(), "civic-calendar-"));
    try {
      await mkdir(join(root, "gov_meetings"));
      await writeFile(join(root, "gov_meetings", "meetings.json"), JSON.stringify({ items: [{ title: "Example board", link: "https://example.org/meeting", date: "2026-09-29", content: "", source: "Example board" }] }));
      const collected = await withCivicProfile(eastern, () => collectEvents(root, clock));
      expect(collected).toHaveLength(1);
      expect(collected[0]!.status).toBe("completed");
      expect(collected[0]!.dateStart).toBe("2026-09-29");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("observation inputs reject foreign seed identity and do not reuse unbound legacy hazards", async () => {
    const root = await mkdtemp(join(tmpdir(), "civic-observations-"));
    try {
      const seedDir = join(root, "seed"), outDir = join(root, "out");
      await mkdir(seedDir); await mkdir(join(outDir, "alerts", "composite"), { recursive: true });
      const legacyContract = buildGeoIntel();
      await writeFile(join(seedDir, "geo-intel.json"), JSON.stringify(legacyContract));
      await withCivicProfile(eastern, () => withOutputRoot(outDir, async () => {
        await expect(loadObservationInputs({ seedDir })).rejects.toThrow("selected civic profile");
        const contract = buildGeoIntel();
        await writeFile(join(seedDir, "geo-intel.json"), JSON.stringify(contract));
        await writeFile(join(outDir, "alerts", "composite", "current.json"), JSON.stringify({ level: "WATCH", reason: "Unbound legacy hazard" }));
        await writeFile(join(outDir, "alerts", "source-health.json"), JSON.stringify({ sources: [{ source: "Legacy Crescent monitor", status: "ok" }] }));
        const inputs = await loadObservationInputs({ seedDir });
        expect(inputs.anchor.name).toBe(eastern.name);
        expect(inputs.profileId).toBe(eastern.id);
        expect(inputs.contractSchema).toBe("civic-geo-intel/v1");
        expect(inputs.composite).toBeNull(); expect(inputs.monitors).toEqual([]);
        await writeFile(join(seedDir, "geo-intel.json"), JSON.stringify({ ...contract, profileId: "another-profile" }));
        await expect(loadObservationInputs({ seedDir })).rejects.toThrow("selected civic profile");
        await writeFile(join(seedDir, "geo-intel.json"), JSON.stringify({ ...contract, anchor: { ...(contract.anchor as object), latitude: 42.1 } }));
        await expect(loadObservationInputs({ seedDir })).rejects.toThrow("selected civic profile");
        await rm(join(seedDir, "geo-intel.json"));
        const absent = await loadObservationInputs({ seedDir });
        expect(absent.anchor.name).toBe(eastern.name); expect(absent.hazardDomains).toEqual([]);
      }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("alternate geo exports require independent explicit roots, including symlink aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "civic-geo-export-"));
    try {
      await symlink(join(process.cwd(), "pages-data"), join(root, "seed-alias"));
      await withCivicProfile(eastern, async () => {
        await expect(writeGeoIntelExports()).rejects.toThrow("explicit seed/output roots");
        await expect(writeGeoIntelExports({ seedDir: "pages-data", outputDir: join(root, "out") })).rejects.toThrow("independent roots");
        await expect(writeGeoIntelExports({ seedDir: join(root, "seed-alias"), outputDir: join(root, "out") })).rejects.toThrow("independent roots");
        const seedDir = join(root, "seed"), outputDir = join(root, "out");
        const written = await writeGeoIntelExports({ seedDir, outputDir });
        expect(written).toEqual([join(seedDir, "geo-intel.json"), join(outputDir, "geo-intel.json")]);
        const seed = JSON.parse(await readFile(written[0]!, "utf8"));
        const output = JSON.parse(await readFile(written[1]!, "utf8"));
        expect(seed).toEqual(output); expect(seed.profileId).toBe(eastern.id); expect(seed.domains).toEqual([]);
        const binding = JSON.parse(await readFile(join(outputDir, "state", "civic-profile.json"), "utf8"));
        expect(binding.profileId).toBe(eastern.id);
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});


describe("independent civic review regressions", () => {
  test("equivalent T and space offset instants use the same selected civil day", () => withCivicProfile(eastern, () => {
    expect(parseEventDate("2026-09-30 00:30:00+02:00")).toBe("2026-09-29");
    expect(parseEventDate("2026-09-30T00:30:00+02:00")).toBe("2026-09-29");
  }));
  test("calendar properties reject injected source URLs and escape bare CR in text and UID", () => {
    const ics = buildEventsIcs([{ id: "one\rUID:injected", title: "Title\rATTENDEE:injected", dateStart: "2026-10-01", location: null, description: "", sourceLinks: ["https://example.org/event\r\nATTENDEE:mailto:injected@example.org"], status: "scheduled" }]);
    expect(ics).not.toContain("\r\nATTENDEE:"); expect(ics).not.toContain("\r\nUID:injected"); expect(ics).not.toContain("URL:");
    expect(escapeIcsText("one\rtwo")).toBe("one\\ntwo");
  });
  test("default observation loading rejects a foreign profile identity on the correct anchor", async () => {
    const root = await mkdtemp(join(tmpdir(), "geo-foreign-id-"));
    try { await writeFile(join(root, "geo-intel.json"), JSON.stringify({ ...buildGeoIntel(), profileId: eastern.id }));
      await withOutputRoot(join(root, "output"), () => expect(loadObservationInputs({ seedDir: root })).rejects.toThrow("differs"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("shared geo writer admission protects absolute and normalized seed aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "geo-writer-alias-"));
    try { await withCivicProfile(eastern, async () => {
      for (const seed of [join(process.cwd(), "pages-data"), "./pages-data", "output/../pages-data"]) await expect(prepareCivicGeoExportRoots(seed, join(root, "output"))).rejects.toThrow("independent roots");
      await prepareCivicGeoExportRoots(join(root, "seed"), join(root, "output"));
      expect(JSON.parse(await readFile(join(root, "seed/state/civic-profile.json"), "utf8")).profileId).toBe(eastern.id);
    }); } finally { await rm(root, { recursive: true, force: true }); }
  });
});
