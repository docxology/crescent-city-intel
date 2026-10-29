import { describe, expect, test } from "bun:test";
import {
  buildSourceDiscoveryReport,
  getSourceRegistry,
  normalizeSourceUrl,
  probeSource,
  sourceRegistryFingerprint,
  validateSourceRegistry,
  sourceIdForMonitor,
  writeSourceDiscoveryArtifacts,
} from "../src/source_registry.ts";
import { sourceHealth, isSourceHealthReceipt, errorMessage, EXPECTED_SOURCE_HEALTH } from "../src/shared/source_health.ts";
import { MONITOR_KEYS, buildExtendedMonitorDefinitions, classifySourceHealth } from "../src/alerts/composite.ts";
import { NWS_ALERTS_URL, NWS_FORECAST_ZONE } from "../src/alerts/nws_weather.ts";
import { NWS_ALERTS_URL as CENTRAL_NWS_ALERTS_URL, NWS_FORECAST_ZONE as CENTRAL_NWS_FORECAST_ZONE, USGS_EARTHQUAKE_URL } from "../src/constants.ts";
import { coopsUrl } from "../src/alerts/noaa_tides.ts";
import { COUNTY_CIVICCLERK_API, COUNTY_CIVICCLERK_PORTAL } from "../src/official_meetings.ts";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withOutputRoot, paths } from "../src/shared/paths.ts";
import { withTransportScope } from "../src/shared/transport.ts";
import { runBoundedChild } from "../src/shared/subprocess.ts";

describe("source discovery registry", () => {
  test("Harbor discovery links use the official navigation's current host", () => {
    const registry = getSourceRegistry();
    for (const [id, path] of [["harbor-recordings", "board-meeting-recordings"], ["harbor-updates", "updates"], ["harbor-rfps", "request-for-proposals"]]) {
      expect(registry.find(source => source.id === id)?.canonicalUrl).toBe(`https://www.ccharbor.com/${path}`);
      expect(registry.find(source => source.id === id)?.automation).toBe("discovery-only");
    }
  });

  test("report sorting preserves caller-owned registry order and rejects invalid report clocks", async () => {
    const registry = getSourceRegistry().reverse();
    const order = registry.map(source => source.id);
    await buildSourceDiscoveryReport({ registry, health: [] });
    expect(registry.map(source => source.id)).toEqual(order);
    for (const checkedAt of ["invalid", "2026-02-30T00:00:00Z"]) {
      await expect(buildSourceDiscoveryReport({ registry: [], health: [], checkedAt })).rejects.toThrow("timestamp");
    }
  });

  test("equal display names keep distinct source-ID probe results and cannot imply collection", async () => {
    const server = Bun.serve({ port: 0, fetch: request => new Response("fixture", { status: new URL(request.url).pathname === "/missing" ? 503 : 200 }) });
    const base = `http://127.0.0.1:${server.port}`;
    const seed = getSourceRegistry()[0]!;
    const registry = ["available", "missing"].map(id => ({ ...seed, id, name: "Shared provider", canonicalUrl: `https://discovery.example/${id}`, endpointUrl: undefined }));
    try {
      const report = await withTransportScope({ fixture: { origin: base, allowedOrigins: ["https://discovery.example"] } }, () => buildSourceDiscoveryReport({ registry, health: [], probe: true }));
      expect(report.probe).toEqual({ checked: 2, unavailable: 1 });
      expect(report.sources.find(source => source.id === "available")!.reachability.status).toBe("ok");
      expect(report.sources.find(source => source.id === "missing")!.reachability.status).toBe("unavailable");
      expect(report.sources.every(source => source.collection === "not-checked")).toBe(true);
    } finally { server.stop(true); }
  });

  test("absent retained health stays unchecked; corrupt, malformed, oversized and linked health fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cci-discovery-health-"));
    try {
      await withOutputRoot(root, async () => {
        const at = "2026-09-30T12:00:00Z";
        const source = getSourceRegistry().find(source => source.id === "news-lost-coast-outpost")!;
        expect((await buildSourceDiscoveryReport({ registry: [source], checkedAt: at })).sources[0]!.collection).toBe("not-checked");
        await mkdir(join(root, "news"));
        const valid = JSON.stringify({ sources: [sourceHealth(source.name, "ok", at, { sourceId: source.id, fetchedAt: at, itemCount: 1 })] });
        await writeFile(paths.newsHealth, valid);
        expect((await buildSourceDiscoveryReport({ registry: [source], checkedAt: at })).sources[0]!.collection).toBe("ok");
        await writeSourceDiscoveryArtifacts({ outputDir: root, checkedAt: at });
        const committed = [paths.sourceRegistry, paths.sourceDiscovery, paths.sourceDiscoverySeen];
        const before = await Promise.all(committed.map(path => readFile(path)));
        for (const text of ["{", "null", "{}", '{"sources":[null]}', JSON.stringify({ sources: [{ source: source.name, status: "ok", itemCount: -1, checkedAt: at }] }), " ".repeat(2 * 1024 * 1024 + 1)]) {
          await writeFile(paths.newsHealth, text);
          await expect(buildSourceDiscoveryReport({ registry: [source], checkedAt: at })).rejects.toThrow();
          await expect(writeSourceDiscoveryArtifacts({ outputDir: root, checkedAt: at })).rejects.toThrow();
          expect(await Promise.all(committed.map(path => readFile(path)))).toEqual(before);
        }
        await rm(paths.newsHealth);
        const target = join(root, "retained-health.json");
        await writeFile(target, valid);
        await symlink(target, paths.newsHealth);
        await expect(buildSourceDiscoveryReport({ registry: [source], checkedAt: at })).rejects.toThrow();
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("explicit probe deadlines are honored without changing environment configuration", async () => {
    const server = Bun.serve({ port: 0, fetch: async () => { await Bun.sleep(150); return new Response("late"); } });
    try {
      const source = { ...getSourceRegistry()[0]!, canonicalUrl: `http://127.0.0.1:${server.port}/slow`, endpointUrl: undefined };
      const result = await probeSource(source, { allowPrivateHosts: ["127.0.0.1"], timeoutMs: 20 });
      expect(result.status).toBe("unavailable");
      expect(result.error).toMatch(/deadline|cancel|timeout/i);
      expect((await probeSource(source, { allowPrivateHosts: ["127.0.0.1"], timeoutMs: 1000 })).status).toBe("ok");
    } finally { server.stop(true); }
  });

  test("actual discovery CLI reports probe totals while uncollected sources stay unchecked", async () => {
    const root = await mkdtemp(join(tmpdir(), "cci-discovery-cli-"));
    const server = Bun.serve({ port: 0, fetch: request => new Response("fixture", { status: new URL(request.url).pathname === "/updates" ? 503 : 200 }) });
    try {
      const offline = await runBoundedChild([process.execPath, "--eval", `process.env.CC_OUTPUT_DIR = ${JSON.stringify(root)}; await import('./scripts/run-source-discovery.ts');`], { timeoutMs: 15_000 });
      expect(offline.status).toBe("ok");
      expect(offline.stdout).not.toContain("Bounded probes:");
      expect(JSON.parse(await readFile(join(root, "source-discovery.json"), "utf8")).probe).toEqual({ checked: 0, unavailable: 0 });
      const fixture = { origin: `http://127.0.0.1:${server.port}`, allowedOrigins: [...new Set(getSourceRegistry().map(source => new URL(source.endpointUrl ?? source.canonicalUrl).origin))] };
      const code = `import { withTransportScope } from './src/shared/transport.ts';
        import { runSourceDiscoveryCli } from './src/source_registry.ts';
        process.env.CC_OUTPUT_DIR = ${JSON.stringify(root)};
        await withTransportScope({ fixture: ${JSON.stringify(fixture)} }, () => runSourceDiscoveryCli(['--check']));`;
      const child = await runBoundedChild([process.execPath, "--eval", code], { timeoutMs: 15_000 });
      expect(child.status).toBe("ok");
      expect(child.reaped).toBe(true);
      const report = JSON.parse(await readFile(join(root, "source-discovery.json"), "utf8"));
      expect(report.probe.checked).toBeGreaterThan(0);
      expect(report.probe.unavailable).toBe(1);
      expect(report.sources.every((source: { operationalStatus: string }) => source.operationalStatus === "not-checked")).toBe(true);
      expect(child.stdout).toContain(`Bounded probes: ${report.probe.checked} checked; 1 unavailable.`);
    } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
  }, 20_000);

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
  test("earthquake inventory and missing-health markers share the monitor's full past-hour feed", () => {
    const earthquake = getSourceRegistry().find(source => source.configuredMonitor === "alert:earthquake")!;
    expect(earthquake.canonicalUrl).toBe(USGS_EARTHQUAKE_URL);
    expect(EXPECTED_SOURCE_HEALTH.find(source => source.source === "USGS Earthquake")!.url).toBe(USGS_EARTHQUAKE_URL);
    expect(new URL(earthquake.canonicalUrl).pathname).toEndWith("/all_hour.geojson");
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
