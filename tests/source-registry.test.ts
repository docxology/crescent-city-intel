import { describe, expect, test } from "bun:test";
import {
  buildSourceDiscoveryReport,
  getSourceRegistry,
  normalizeSourceUrl,
  probeSource,
  sourceRegistryFingerprint,
  validateSourceRegistry,
} from "../src/source_registry.ts";
import { sourceHealth } from "../src/shared/source_health.ts";

describe("source discovery registry", () => {
  test("normalizes tracking URLs without changing the source identity", () => {
    expect(normalizeSourceUrl("HTTPS://Example.com/path/?utm_source=x#fragment")).toBe("https://example.com/path");
    expect(normalizeSourceUrl("not a url")).toBe("not a url");
  });

  test("has unique, provenance-complete source identities", () => {
    const registry = getSourceRegistry();
    expect(registry.length).toBeGreaterThan(30);
    expect(validateSourceRegistry(registry)).toEqual([]);
    expect(new Set(registry.map(source => source.id)).size).toBe(registry.length);
    expect(registry.find(source => source.id === "triplicate-news-reference")?.automation).toBe("reference-only");
    expect(registry.find(source => source.id === "harbor-recordings")?.automation).toBe("discovery-only");
  });

  test("fingerprint is deterministic regardless of registry ordering", async () => {
    const registry = getSourceRegistry();
    const first = await sourceRegistryFingerprint(registry);
    const second = await sourceRegistryFingerprint([...registry].reverse());
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  test("joins known monitor health while keeping discovery-only sources explicit", async () => {
    const registry = getSourceRegistry();
    const report = await buildSourceDiscoveryReport({
      registry,
      checkedAt: "2026-07-24T00:00:00.000Z",
      health: [sourceHealth("Lost Coast Outpost", "ok", "2026-07-24T00:00:00.000Z", { itemCount: 2 })],
    });
    expect(report.sourceCount).toBe(registry.length);
    expect(report.sources.find(source => source.id === "news-lost-coast-outpost")?.operationalStatus).toBe("ok");
    expect(report.sources.find(source => source.id === "harbor-news")?.operationalStatus).toBe("not-checked");
    expect(report.sources.find(source => source.id === "triplicate-home-reference")?.referenceOnly).toBe(true);
    expect(report.coverageGaps.length).toBeGreaterThan(0);
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
      expect((await probeSource(definition("/status"))).status).toBe("ok");
      expect((await probeSource(definition("/missing"))).status).toBe("unavailable");
      const previousTimeout = process.env.SOURCE_DISCOVERY_TIMEOUT_MS;
      process.env.SOURCE_DISCOVERY_TIMEOUT_MS = "20";
      try {
        expect((await probeSource(definition("/slow"))).status).toBe("unavailable");
      } finally {
        if (previousTimeout === undefined) delete process.env.SOURCE_DISCOVERY_TIMEOUT_MS;
        else process.env.SOURCE_DISCOVERY_TIMEOUT_MS = previousTimeout;
      }
    } finally {
      server.stop(true);
    }
  });
});
