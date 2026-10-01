import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSourceCoverageAssessment, assessRetainedSourceCoverage } from "../src/source_coverage.ts";
import { getSourceRegistry } from "../src/source_registry.ts";
import { DIGITRAFFIC_AIS_URL } from "../src/alerts/ais.ts";
const stamp = "2026-09-30T12:00:00Z", encode = (value: unknown) => ({ bytes: new TextEncoder().encode(JSON.stringify(value)) });
const registry = getSourceRegistry();
const url = (key: string) => { const source = registry.find(row => row.configuredMonitor === `alert:${key}`)!; return source.endpointUrl ?? source.canonicalUrl; };
test("coverage reports catalog units, missing facts and foreign AIS limits without pretending target collection", async () => {
  const observations = { permits: encode({ fetchedAt: stamp, sourceUrl: url("permits"), permits: [{ id: "application-type" }], catalogSize: 1 }), pacfin: encode({ fetchedAt: stamp, sourceUrl: url("pacfin"), reports: [{ id: "report-definition" }], reportCount: 1, landingDataAvailable: false }), ais: encode({ fetchedAt: stamp, sourceUrl: DIGITRAFFIC_AIS_URL, vesselsObserved: 20, vesselsInWatchArea: [], coversDelNorteWaters: false }) };
  const report = await buildSourceCoverageAssessment(registry, observations, stamp);
  expect(report.sources.map(row => row.retainedCount)).toEqual([1, 1, 0]);
  expect(report.sources.map(row => row.targetFactAvailable)).toEqual([false, false, false]);
  expect(report.sources[2]!.status).toBe("local-coverage-unavailable"); expect(report.primaryDocuments.effectiveDate).toBeNull();
  const missing = await buildSourceCoverageAssessment(registry, {}, stamp);
  expect(missing.sources.every(row => row.retainedCount === null && row.targetFactAvailable === null && row.status === "not-assessed")).toBe(true);
  for (const bad of [encode({ fetchedAt: stamp, sourceUrl: url("pacfin"), reports: [], reportCount: 0, landingDataAvailable: true }), encode({ fetchedAt: stamp, sourceUrl: url("pacfin"), reports: [], reportCount: "0", landingDataAvailable: false })]) await expect(buildSourceCoverageAssessment(registry, { pacfin: bad }, stamp)).rejects.toThrow();
  for (const sourceUrl of [DIGITRAFFIC_AIS_URL, `${DIGITRAFFIC_AIS_URL}?fixture=1`, `${DIGITRAFFIC_AIS_URL}#123`, DIGITRAFFIC_AIS_URL.replace("meri.digitraffic.fi", "MERI.DIGITRAFFIC.FI"), `${DIGITRAFFIC_AIS_URL}/`]) await expect(buildSourceCoverageAssessment(registry, { ais: encode({ fetchedAt: stamp, sourceUrl, vesselsObserved: 0, vesselsInWatchArea: [], coversDelNorteWaters: true }) }, stamp)).rejects.toThrow("Foreign default");
  await expect(buildSourceCoverageAssessment(registry, { permits: encode({ fetchedAt: stamp, sourceUrl: "http://127.0.0.2/private", permits: [], catalogSize: 0 }) }, stamp)).rejects.toThrow("Invalid retained");
  await expect(buildSourceCoverageAssessment(registry.filter(row => row.configuredMonitor !== "alert:permits"), {}, stamp)).rejects.toThrow("identity");
  await expect(buildSourceCoverageAssessment(registry, { permits: encode({ fetchedAt: "2026-10-01T12:00:00Z", sourceUrl: url("permits"), permits: [], catalogSize: 0 }) }, stamp)).rejects.toThrow("Invalid retained");
  const local = { fetchedAt: stamp, sourceUrl: "https://local-feed.example.test/positions", vesselsObserved: 1, vesselsInWatchArea: [{ lon: -124.2, lat: 41.8, positionAt: stamp }], coversDelNorteWaters: true };
  expect((await buildSourceCoverageAssessment(registry, { ais: encode(local) }, stamp)).sources[2]!.targetFactAvailable).toBe(true);
  for (const [positionAt, status] of [["2026-09-29T12:00:00Z", "local-observation-stale"], [null, "local-observation-unknown"]] as const) {
    const assessed = (await buildSourceCoverageAssessment(registry, { ais: encode({ ...local, vesselsInWatchArea: [{ ...local.vesselsInWatchArea[0], positionAt }] }) }, stamp)).sources[2]!;
    expect(assessed.targetFactAvailable).toBe(false); expect(assessed.status).toBe(status);
  }
});
test("read-only assessment distinguishes absent observations from corrupt retained bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-coverage-"));
  try {
    expect((await assessRetainedSourceCoverage(root, stamp)).sources.every(row => row.status === "not-assessed")).toBe(true);
    await mkdir(join(root, "alerts/permits"), { recursive: true }); await writeFile(join(root, "alerts/permits/current.json"), "{bad");
    await expect(assessRetainedSourceCoverage(root, stamp)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
