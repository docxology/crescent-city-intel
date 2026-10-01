import { describe, test, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateArtifact, SOURCE_HEALTH_SCHEMA } from "../src/artifact_contracts.ts";
import { validateSchema, isPublicCitationUrl } from "../src/schema_validation.ts";
import { buildEventsArtifact, type StructuredEvent } from "../src/events.ts";
import { buildDirectoryArtifact, parseDirectoryArtifact } from "../src/directory.ts";
import { sourceHealth, summarizeSourceHealth } from "../src/shared/source_health.ts";
import { buildAnalyticsOverview, readAnalyticsOverview } from "../src/analytics_backend.ts";
import { publicAnalytics, publicEvents, publicReports, assertPublicFamilyArtifact } from "../src/pages_public.ts";
import { validateApiValue } from "../src/api/contracts.ts";
import { assessSampling } from "../src/trend_sampling.ts";
import { withEmptyCorpus } from "./helpers/output-root.ts";

const stamp = "2026-09-30T12:00:00.000Z";
const event: StructuredEvent = { id: "event-1", title: "Council meeting", kind: "government-meeting", dateStart: null, dateAllDay: true, timeNote: null, location: null, organizer: null, status: "unknown", description: "Source omits an occurrence date", sourceLinks: ["https://example.test/meeting"], sourceName: "Official fixture", fetchedAt: stamp, extractionMethod: "markup", confidence: null };
const directory = () => buildDirectoryArtifact(stamp, { entries: [{ name: "Public library", category: "Government", address: null, phone: null, website: "https://example.test/library", description: null, source: "https://example.test/library" }] })!;
describe("shared artifact-family authority", () => {
  test("actual events preserve unknown dates/fidelity and reject forged types, confidence, counts and URLs", () => {
    const artifact = buildEventsArtifact(stamp, [event]);
    expect(validateArtifact("events", artifact)).toEqual([]);
    expect(() => assertPublicFamilyArtifact("events", publicEvents(artifact))).not.toThrow();
    const calendar = structuredClone(artifact); calendar.events[0]!.calendarEvidence = { uid: "meeting-1", recurrenceId: null, timezone: null, timeBasis: "floating" };
    expect(validateArtifact("events", calendar)).toEqual([]);
    expect((publicEvents(calendar) as any).events[0].calendarEvidence).toEqual(calendar.events[0]!.calendarEvidence);
    expect(validateArtifact("events", { ...calendar, events: [{ ...calendar.events[0], calendarEvidence: { ...calendar.events[0]!.calendarEvidence, timeBasis: "guessed" } }] }).length).toBeGreaterThan(0);
    for (const mutate of [
      (a: any) => a.count++, (a: any) => a.schemaVersion = "events/v99", (a: any) => a.events[0].confidence = 1.1,
      (a: any) => delete a.events[0].confidence, (a: any) => a.events[0].dateStart = "2026-02-30", (a: any) => a.events[0].dateAllDay = "true",
      (a: any) => a.events.push(a.events[0]), (a: any) => a.events[0].sourceLinks = ["http://127.0.0.2/private"],
      (a: any) => a.events[0].sourceLinks = ["https://example.test/#section=1;access_token=private-fixture-token"],
      (a: any) => a.events[0].status = "scheduled", (a: any) => a.generatedAt = "2026-09-30T25:00:00Z",
      (a: any) => a.events[0].fetchedAt = false,
    ]) { const copy = structuredClone(artifact); mutate(copy); expect(validateArtifact("events", copy).length).toBeGreaterThan(0); }
  });
  test("source-health legacy migration validates exact retained clocks and truthful aggregates", () => {
    const row = sourceHealth("Official fixture", "ok", stamp, { fetchedAt: stamp, itemCount: 2, url: "https://example.test/feed" });
    const legacy = { checkedAt: stamp, sources: [row] };
    expect(validateArtifact("source-health-report", legacy).length).toBeGreaterThan(0);
    expect(validateArtifact("source-health-report", legacy, { allowLegacyHealthEnvelope: true })).toEqual([]);
    expect(validateArtifact("source-health-report", { ...legacy, schemaVersion: SOURCE_HEALTH_SCHEMA })).toEqual([]);
    const drift = { url: "https://example.test/document", changed: false, isNew: true, previousHash: null, currentHash: "a".repeat(64) };
    expect(validateArtifact("source-health-report", { ...legacy, documentDrift: [drift] }, { allowLegacyHealthEnvelope: true })).toEqual([]);
    expect(validateArtifact("source-health-report", { ...legacy, documentDrift: [{ ...drift, changed: true }] }, { allowLegacyHealthEnvelope: true }).length).toBeGreaterThan(0);
    expect(validateArtifact("source-health-report", { ...legacy, sources: [{ ...row, checkedAt: "2026-02-30T12:00:00Z" }] }, { allowLegacyHealthEnvelope: true }).length).toBeGreaterThan(0);
    for (const changes of [{ observedAt: "2026-02-30T12:00:00Z" }, { productDate: "2026-02-30" }, { observationAgeMs: -1 }, { validUntil: "tomorrow" }, { timestampBasis: "guessed" }]) expect(validateArtifact("source-health", { ...row, ...changes }).length).toBeGreaterThan(0);
    const summary = summarizeSourceHealth([row], stamp);
    expect(validateArtifact("source-health-summary", summary)).toEqual([]);
    expect(validateArtifact("source-health-summary", { ...summary, present: 100 }).length).toBeGreaterThan(0);
    expect(validateArtifact("source-health-summary", { ...summary, missingSources: ["invented"] }).length).toBeGreaterThan(0);
  });
  test("directory loader reuses type/category/count/URL authority", () => {
    const artifact = directory();
    expect(validateArtifact("directory", artifact)).toEqual([]);
    expect(parseDirectoryArtifact(JSON.stringify(artifact))).not.toBeNull();
    expect(artifact.entries[0]!.reviewedAt).toBeNull();
    for (const mutate of [(a: any) => a.count++, (a: any) => a.categories[0].count++, (a: any) => a.entries[0].phone = 555, (a: any) => a.entries[0].reviewedAt = "2026-02-30", (a: any) => a.entries[0].source = "https://example.test/?key=private-fixture-token", (a: any) => a.entries[0].website = "javascript:alert(1)", (a: any) => a.entries[0].hiddenOperatorField = "/Users/private"] ) {
      const copy = structuredClone(artifact); mutate(copy); expect(validateArtifact("directory", copy).length).toBeGreaterThan(0); expect(parseDirectoryArtifact(JSON.stringify(copy))).toBeNull();
    }
  });
  test("real empty-root analytics round trip rejects type and semantic corruption at its reader", async () => {
    await withEmptyCorpus(async root => {
      const overview = await buildAnalyticsOverview({ generatedAt: stamp });
      expect(validateArtifact("analytics-overview", overview)).toEqual([]);
      expect(() => assertPublicFamilyArtifact("analytics-overview", publicAnalytics(overview))).not.toThrow();
      const sampling = assessSampling([], { nowMs: Date.parse(stamp), windowDays: 30, intervalMs: 86400000, expectedSources: ["source-1"] });
      const sampled = { ...overview, sampling };
      expect(validateArtifact("analytics-overview", sampled)).toEqual([]);
      expect((publicAnalytics(sampled) as any).sampling).toEqual(sampling);
      expect(validateArtifact("analytics-overview", { ...sampled, sampling: { ...sampling, comparable: true } }).length).toBeGreaterThan(0);
      expect(validateArtifact("analytics-overview", { ...sampled, sampling: { ...sampling, current: { ...sampling.current, missingSlots: 0 } } }).length).toBeGreaterThan(0);
      await mkdir(join(root, "state"), { recursive: true });
      const { paths } = await import("../src/shared/paths.ts");
      await writeFile(paths.analyticsOverview, JSON.stringify(overview));
      expect(await readAnalyticsOverview()).not.toBeNull();
      const corrupt = structuredClone(overview); corrupt.metrics.code.sections++;
      await writeFile(paths.analyticsOverview, JSON.stringify(corrupt));
      expect(await readAnalyticsOverview()).toBeNull();
      expect(validateArtifact("analytics-overview", { ...overview, schemaVersion: "99" }).length).toBeGreaterThan(0);
    });
  }, 30000);
  test("monthly public projection retains all metric and reporting evidence without operator paths", () => {
    const summary = summarizeSourceHealth([], stamp);
    const metadata = { schemaVersion: "1.0.0", reportType: "monthly-civic-health", period: "2026-09", generatedAt: stamp, periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z", status: "ok", metrics: { codeArticles: 3, newsItems: 5 }, sourceHealth: summary, sourceDiscovery: { registryFingerprint: "a".repeat(64), sourceCount: 2, monitoredCount: 1, discoveryOnlyCount: 1, referenceOnlyCount: 0, coverageGaps: [] }, artifacts: { markdown: "/Users/private/report.md", metadata: "/Users/private/report.json" }, warnings: [] };
    expect(validateArtifact("monthly-report", metadata)).toEqual([]);
    const dto = publicReports(metadata)!;
    expect(dto.metrics).toEqual(metadata.metrics); expect(dto.periodStart).toBe(metadata.periodStart); expect(dto.artifacts).toBeUndefined();
    expect(() => assertPublicFamilyArtifact("monthly-report", dto)).not.toThrow();
    expect(validateArtifact("monthly-report", { ...metadata, metrics: { newsItems: "5" } }).length).toBeGreaterThan(0);
  });
  test("API and artifacts share bounded date, alternatives and recursive type semantics", () => {
    const schema = { type: "array", maxItems: 4, items: { type: "string", format: "date-time" } };
    const value = ["2026-02-30T00:00:00Z"];
    expect(validateApiValue(value, schema)).toEqual(validateSchema(value, schema));
    expect(validateSchema([1, 2, 3], { type: "array", items: { type: "number" } }, "value", { maxNodes: 2 }).join(";")).toContain("budget exceeded");
    const recursive: any = { self: null }; recursive.self = recursive;
    const recursiveSchema: any = { type: "object", properties: {} }; recursiveSchema.properties.self = recursiveSchema;
    expect(validateSchema(recursive, recursiveSchema).join(";")).toContain("nesting");
    for (const citation of ["http://10.0.0.1/feed", "https://example.test/?auth=fixture", "https://example.test/#/router?token=fixture", "https://example.test/#access_token%3Dfixture", "ftp://example.test/feed"]) expect(isPublicCitationUrl(citation)).toBe(false);
    expect(isPublicCitationUrl("https://example.test/section#123")).toBe(true);
  });
});
