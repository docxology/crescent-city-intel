import { describe, expect, test } from "bun:test";
import {
  buildSourceDiscoveryReport,
  getSourceRegistry,
  normalizeSourceUrl,
  probeSource,
  sourceRegistryFingerprint,
  validateSourceRegistry,
  sourceIdForMonitor,
} from "../src/source_registry.ts";
import { sourceHealth, isSourceHealthReceipt, errorMessage, EXPECTED_SOURCE_HEALTH } from "../src/shared/source_health.ts";
import { MONITOR_KEYS, buildExtendedMonitorDefinitions, classifySourceHealth } from "../src/alerts/composite.ts";
import { NWS_ALERTS_URL, NWS_FORECAST_ZONE } from "../src/alerts/nws_weather.ts";
import { NWS_ALERTS_URL as CENTRAL_NWS_ALERTS_URL, NWS_FORECAST_ZONE as CENTRAL_NWS_FORECAST_ZONE } from "../src/constants.ts";
import { coopsUrl } from "../src/alerts/noaa_tides.ts";
import { COUNTY_CIVICCLERK_API, COUNTY_CIVICCLERK_PORTAL } from "../src/official_meetings.ts";

describe("source discovery registry", () => {
  test("County identity declares its approved public provider, and tide discovery retains producer UTC parameters without historical dates", () => {
    const county = getSourceRegistry().find(source => source.id === "county-meetings")!;
    expect(county.endpointUrl).toBe(COUNTY_CIVICCLERK_API); expect(county.discoveredFrom).toContain(COUNTY_CIVICCLERK_PORTAL); expect(county.collectionMode).toBe("api");
    const tides = getSourceRegistry().find(source => source.configuredMonitor === "alert:tides")!;
    const request = new URL(tides.endpointUrl!), producer = new URL(coopsUrl("predictions", "20260930", "20261002"));
    expect(request.searchParams.get("date")).toBe("today"); expect(request.searchParams.has("begin_date")).toBe(false); expect(request.searchParams.has("end_date")).toBe(false);
    for (const key of ["station", "product", "datum", "time_zone", "interval", "units", "format", "application"]) expect(request.searchParams.get(key)).toBe(producer.searchParams.get(key));
    expect(request.searchParams.get("time_zone")).toBe("gmt");
  });
  test("weather inventory derives the exact current Coastal Del Norte producer request", () => {
    const weather = getSourceRegistry().find(source => source.configuredMonitor === "alert:weather")!;
    expect(NWS_FORECAST_ZONE).toBe("CAZ101");
    expect(NWS_FORECAST_ZONE).toBe(CENTRAL_NWS_FORECAST_ZONE);
    expect(NWS_ALERTS_URL).toBe(CENTRAL_NWS_ALERTS_URL);
    expect(EXPECTED_SOURCE_HEALTH.find(source => source.source === "NWS Weather")!.url).toBe(NWS_ALERTS_URL);
    expect(weather.canonicalUrl).toBe(NWS_ALERTS_URL);
    const request = new URL(weather.canonicalUrl);
    expect(request.origin).toBe("https://api.weather.gov");
    expect([...request.searchParams.entries()]).toEqual([["zone", "CAZ101"]]);
    expect(weather.provenance).toContain("Coastal Del Norte");
    expect(weather.provenance).not.toContain("CAZ006");
  });
  test("normalizes tracking URLs without changing the source identity", () => {
    expect(normalizeSourceUrl("HTTPS://Example.com/path/?utm_source=x#fragment")).toBe("https://example.com/path");
    expect(normalizeSourceUrl("not a url")).toBe("not a url");
  });

  test("has unique, provenance-complete source identities", () => {
    const registry = getSourceRegistry();
    expect(registry.length).toBeGreaterThan(30);
    expect(validateSourceRegistry(registry)).toEqual([]);
    expect(new Set(registry.map(source => source.id)).size).toBe(registry.length);
    // The news RSS listing and deep browser reference connector are distinct producers.
    expect(registry.find(source => source.id === "triplicate-home-reference")?.collectionMode).toBe("rss");
    expect(registry.find(source => source.id === "triplicate-news-reference")).toMatchObject({ automation: "monitored", collectionMode: "playwright", configuredMonitor: "triplicate:deep-content" });
    expect(sourceIdForMonitor("triplicate")).toBe("triplicate-home-reference");
    expect(sourceIdForMonitor("triplicate:deep-content")).toBe("triplicate-news-reference");
    expect(registry.find(source => source.id === "triplicate-calendar")?.collectionMode).toBe("api");
    expect(registry.find(source => source.id === "harbor-recordings")?.automation).toBe("discovery-only");
  });

  test("fingerprint is deterministic regardless of registry ordering", async () => {
    const registry = getSourceRegistry();
    const first = await sourceRegistryFingerprint(registry);
    const second = await sourceRegistryFingerprint([...registry].reverse());
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
  test("public source inventory/health rejects credentials and producer diagnostics redact query and fragment secrets", () => {
    const at = "2026-09-30T12:00:00Z", item = getSourceRegistry()[0];
    for (const url of ["https://user:private@example.test/", "https://example.test/?api_key=private", "https://example.test/#access_token=private-fixture-token"]) {
      expect(validateSourceRegistry([{ ...item, canonicalUrl: url }]).length).toBeGreaterThan(0);
      expect(isSourceHealthReceipt({ source: "Unsafe fixture", status: "ok", checkedAt: at, fetchedAt: at, itemCount: 1, url })).toBe(false);
      expect(sourceHealth("Safe diagnostic", "unavailable", at, { url }).url).not.toContain("private");
      expect(errorMessage(new Error(`Unavailable ${url}`))).not.toContain("private");
    }
    expect(isSourceHealthReceipt(sourceHealth("Public section", "ok", at, { fetchedAt: at, itemCount: 1, url: "https://ecode360.com/CR4919#44236217" }))).toBe(true);
    expect(isSourceHealthReceipt({ source: "Bad item count", status: "ok", checkedAt: at, itemCount: NaN })).toBe(false);
    expect(errorMessage(new Error("Unavailable HTTPS://example.test/?api_key=private-fixture-token#auth=private-fixture-token"))).not.toContain("private-fixture-token");
  });

  test("inventories exactly the active alert roster and stamps unavailable producer receipts", () => {
    const inventory = getSourceRegistry().filter(source => source.configuredMonitor?.startsWith("alert:"));
    expect(inventory.map(source => source.configuredMonitor!.slice(6)).sort()).toEqual([...MONITOR_KEYS].sort());
    expect(new Set(inventory.map(source => source.configuredMonitor)).size).toBe(MONITOR_KEYS.length);
    for (const key of MONITOR_KEYS) expect(sourceIdForMonitor(`alert:${key}`)).toBeDefined();
    const definitions = buildExtendedMonitorDefinitions({} as Parameters<typeof buildExtendedMonitorDefinitions>[0]);
    for (const definition of definitions) {
      const receipt = classifySourceHealth(definition, { status: "fulfilled", value: null }, new Map(), "2026-09-30T12:00:00Z");
      expect(receipt.sourceId).toBe(sourceIdForMonitor(`alert:${definition.key}`));
      expect(receipt.status).toBe("unavailable");
    }
  });

  test("joins known monitor health while keeping discovery-only sources explicit", async () => {
    const registry = getSourceRegistry();
    const report = await buildSourceDiscoveryReport({
      registry,
      checkedAt: "2026-07-24T00:00:00.000Z",
      health: [sourceHealth("Lost Coast Outpost", "ok", "2026-07-24T00:00:00.000Z", { itemCount: 2, fetchedAt: "2026-07-24T00:00:00.000Z" })],
    });
    expect(report.sourceCount).toBe(registry.length);
    expect(report.sources.find(source => source.id === "news-lost-coast-outpost")?.operationalStatus).toBe("ok");
    expect(report.sources.find(source => source.id === "harbor-news")?.operationalStatus).toBe("not-checked");
    expect(report.sources.find(source => source.id === "triplicate-home-reference")?.referenceOnly).toBeFalsy(); // monitored now, not reference-only
    expect(report.coverageGaps.length).toBeGreaterThan(0);
  });

  test("collection IDs, old receipts and shared parser coverage remain distinct from reachability", async () => {
    const at = "2026-09-30T12:00:00Z";
    const health = [
      sourceHealth("City Council", "ok", at, { fetchedAt: at, itemCount: 3 }),
      sourceHealth("Planning Commission", "unavailable", at, { itemCount: 0, error: "Parser failed" }),
      sourceHealth("Lost Coast Outpost", "ok", "2026-09-01T00:00:00Z", { fetchedAt: "2026-09-01T00:00:00Z", itemCount: 4 }),
      { ...sourceHealth("Renamed newsroom", "empty", at, { fetchedAt: at, itemCount: 0 }), sourceId: "news-redwood-voice" },
      { ...sourceHealth("Harbor Commission", "ok", at, { fetchedAt: at, itemCount: 5 }), sourceId: "unrelated-source-id" },
    ];
    const report = await buildSourceDiscoveryReport({ checkedAt: at, health });
    const city = report.sources.find(source => source.id === "city-meetings-evogov")!; expect(city.collection).toBe("partial"); expect(city.operationalStatus).toBe("unavailable"); expect(city.healthReceipts).toHaveLength(2); expect(city.itemCount).toBe(3);
    const oldNews = report.sources.find(source => source.id === "news-lost-coast-outpost")!; expect(oldNews.operationalStatus).toBe("stale"); expect(oldNews.healthReceipts[0].fetchedAt).toBe("2026-09-01T00:00:00Z"); expect(oldNews.reachability.status).toBe("not-checked");
    expect(report.sources.find(source => source.id === "news-redwood-voice")!.healthBinding).toBe("source-id"); expect(report.sources.find(source => source.id === "harbor-agendas")!.operationalStatus).toBe("not-checked");
    expect(report.probe.checked).toBe(0); expect(report.probe.unavailable).toBe(0);
    const migrated = await buildSourceDiscoveryReport({ checkedAt: at, health: health.map(row => row.source === "City Council" ? { ...row, sourceId: "city-meetings-evogov" } : row) });
    const mixedCity = migrated.sources.find(source => source.id === "city-meetings-evogov")!;
    expect(mixedCity.healthBinding).toBe("source-id"); expect(mixedCity.collection).toBe("partial"); expect(mixedCity.operationalStatus).toBe("unavailable"); expect(mixedCity.healthReceipts).toHaveLength(2);
  });

  test("uses a real local HTTP fixture for bounded status and timeout probes", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async request => {
        const path = new URL(request.url).pathname;
        if (path === "/status") return new Response("ok");
        if (path === "/missing") return new Response("missing", { status: 503, statusText: "Fixture unavailable" });
        await new Promise(resolve => setTimeout(resolve, 100));
        return new Response("slow");
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const definition = (path: string) => ({
      id: `fixture-${path.slice(1)}`,
      name: `Fixture ${path}`,
      kind: "reference" as const,
      authority: "reference" as const,
      region: "Crescent City" as const,
      canonicalUrl: `${base}${path}`,
      discoveredFrom: [base],
      collectionMode: "html" as const,
      automation: "discovery-only" as const,
      enabled: true,
      provenance: "local HTTP fixture",
    });
    try {
      expect((await probeSource(definition("/status"), { allowPrivateHosts: ["127.0.0.1"] })).status).toBe("ok");
      expect((await probeSource(definition("/missing"), { allowPrivateHosts: ["127.0.0.1"] })).status).toBe("unavailable");
      const previousTimeout = process.env.SOURCE_DISCOVERY_TIMEOUT_MS;
      process.env.SOURCE_DISCOVERY_TIMEOUT_MS = "20";
      try {
        expect((await probeSource(definition("/slow"), { allowPrivateHosts: ["127.0.0.1"] })).status).toBe("unavailable");
      } finally {
        if (previousTimeout === undefined) delete process.env.SOURCE_DISCOVERY_TIMEOUT_MS;
        else process.env.SOURCE_DISCOVERY_TIMEOUT_MS = previousTimeout;
      }
    } finally {
      server.stop(true);
    }
  });
});
