/** Read-only coverage assessment: a collected catalog is never an issued permit, landing total or local AIS census. */
import { join } from "node:path";
import { getSourceRegistry, validateSourceRegistry, sourceRegistryFingerprint } from "./source_registry.js";
import { AIS_WATCH_BOX, DIGITRAFFIC_AIS_URL } from "./alerts/ais.js";
import { captureArtifactBytes, canonicalArtifactJson } from "./artifact_custody.js";
import { custodyHash } from "./corpus_editions.js";
import { isPublicCitationUrl, isStrictTimestamp } from "./schema_validation.js";
import { assertPublicArtifact } from "./pages_public.js";
import { assessSourceClock, SOURCE_CLOCK_POLICIES } from "./source_clocks.js";
import type { SourceDefinition } from "./types.js";

export const SOURCE_COVERAGE_SCHEMA = "crescent-city-source-coverage/v1";
export type CoverageMonitor = "permits" | "pacfin" | "ais";
export interface CoverageObservation { bytes: Uint8Array | null }
export interface SourceCoverageAssessment {
  schemaVersion: typeof SOURCE_COVERAGE_SCHEMA; generatedAt: string; registryFingerprint: string;
  registryCount: number; monitoredCount: number; discoveryOnlyCount: number;
  sources: Array<{
    sourceId: string; monitor: CoverageMonitor; canonicalUrl: string; registryProvenance: string;
    retainedReportSha256: string | null; fetchedAt: string | null; reportUrl: string | null;
    collectedUnit: "permit-application-types" | "report-catalog-entries" | "vessel-positions";
    retainedCount: number | null; targetFact: "issued-permits" | "landing-figures" | "Del-Norte-vessel-traffic";
    targetFactAvailable: boolean | null; accessBoundary: string; geographicBoundary: string;
    status: "not-assessed" | "catalog-only" | "local-coverage-unavailable" | "source-declared-local-sample" | "local-observation-stale" | "local-observation-unknown";
    primaryClock: { timestampBasis: "retrieval" | "observation" | "product"; observedAt: string | null; observationAgeMs: number | null; observationFreshness: "fresh" | "stale" | "unknown"; policyMaxAgeMs: number };
  }>;
  watchBox: typeof AIS_WATCH_BOX;
  primaryDocuments: { adoptionDate: null; effectiveDate: null; status: "requires-document-bound-review"; limitation: string };
  limitations: string[];
}
const own = (row: object, key: string) => Object.hasOwn(row, key);
/** Strict projection of retained observations; never fetches a source or inspects credentials. */
export async function buildSourceCoverageAssessment(registry: SourceDefinition[], observations: Partial<Record<CoverageMonitor, CoverageObservation>>, generatedAt = new Date().toISOString()): Promise<SourceCoverageAssessment> {
  if (!isStrictTimestamp(generatedAt) || validateSourceRegistry(registry).length) throw new Error("Invalid coverage registry or assessment date");
  const sources: SourceCoverageAssessment["sources"] = [];
  for (const monitor of ["permits", "pacfin", "ais"] as const) {
    const definition = registry.filter(row => row.configuredMonitor === `alert:${monitor}`);
    if (definition.length !== 1) throw new Error(`Coverage registry requires exactly one ${monitor} identity`);
    const source = definition[0]!, raw = observations[monitor]?.bytes ?? null;
    if (raw !== null && (!(raw instanceof Uint8Array) || raw.length > 2 * 1024 * 1024)) throw new Error("Coverage report exceeds byte bound");
    const row = raw === null ? null : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Record<string, unknown>;
    if (!isPublicCitationUrl(source.canonicalUrl) || source.endpointUrl && !isPublicCitationUrl(source.endpointUrl) || raw !== null && (!row || typeof row !== "object" || Array.isArray(row) || typeof row.fetchedAt !== "string" || !isStrictTimestamp(row.fetchedAt) || Date.parse(row.fetchedAt) > Date.parse(generatedAt) || typeof row.sourceUrl !== "string" || !isPublicCitationUrl(row.sourceUrl))) throw new Error(`Invalid retained ${monitor} observation`);
    const clock = assessSourceClock(monitor, row, Date.parse(generatedAt));
    const count = (field: string, total: string): number | null => {
      if (row === null) return null;
      const values = row[field], n = row[total];
      if (!Array.isArray(values) || values.length > 100_000 || !Number.isSafeInteger(n) || n !== values.length || !values.every(value => value && typeof value === "object" && !Array.isArray(value))) throw new Error(`Invalid ${monitor} retained count or rows`);
      return n as number;
    };
    let retainedCount: number | null, targetFactAvailable: boolean | null = row ? false : null;
    let status: SourceCoverageAssessment["sources"][number]["status"] = row ? "catalog-only" : "not-assessed";
    if (monitor === "permits") retainedCount = count("permits", "catalogSize");
    else if (monitor === "pacfin") {
      retainedCount = count("reports", "reportCount");
      if (row && row.landingDataAvailable !== false) throw new Error("Current PacFIN connector cannot attest landing figures");
    } else {
      if (row && (typeof row.coversDelNorteWaters !== "boolean" || !Array.isArray(row.vesselsInWatchArea) || !Number.isSafeInteger(row.vesselsObserved) || (row.vesselsObserved as number) < row.vesselsInWatchArea.length || !row.vesselsInWatchArea.every(value => value && typeof value === "object" && !Array.isArray(value) && Number.isFinite(value.lon) && Number.isFinite(value.lat) && value.lon >= AIS_WATCH_BOX.minLon && value.lon <= AIS_WATCH_BOX.maxLon && value.lat >= AIS_WATCH_BOX.minLat && value.lat <= AIS_WATCH_BOX.maxLat))) throw new Error("Invalid retained AIS geographic observations");
      // Query/fragment/host case cannot turn the same foreign provider into a local source.
      if (row && new URL(row.sourceUrl as string).hostname.toLowerCase() === new URL(DIGITRAFFIC_AIS_URL).hostname && row.coversDelNorteWaters === true) throw new Error("Foreign default feed cannot establish local AIS coverage");
      retainedCount = row ? (row.vesselsInWatchArea as unknown[]).length : null;
      targetFactAvailable = row ? row.coversDelNorteWaters === true && clock.usable : null;
      status = row ? row.coversDelNorteWaters !== true ? "local-coverage-unavailable" : clock.usable ? "source-declared-local-sample" : clock.observationFreshness === "stale" ? "local-observation-stale" : "local-observation-unknown" : "not-assessed";
    }
    if (row && monitor !== "ais" && row.sourceUrl !== (source.endpointUrl ?? source.canonicalUrl)) throw new Error("Retained report URL does not match registry source authority");
    if (row && (own(row, "issuedPermits") || own(row, "landingFigures"))) throw new Error("Unimplemented target facts cannot be promoted from catalog reports");
    sources.push({ sourceId: source.id, monitor, canonicalUrl: source.canonicalUrl, registryProvenance: source.provenance,
      retainedReportSha256: raw === null ? null : custodyHash(raw), fetchedAt: row ? row.fetchedAt as string : null, reportUrl: row ? row.sourceUrl as string : null,
      collectedUnit: monitor === "permits" ? "permit-application-types" : monitor === "pacfin" ? "report-catalog-entries" : "vessel-positions", retainedCount,
      targetFact: monitor === "permits" ? "issued-permits" : monitor === "pacfin" ? "landing-figures" : "Del-Norte-vessel-traffic", targetFactAvailable, status,
      primaryClock: { timestampBasis: clock.timestampBasis!, observedAt: clock.observedAt ?? null, observationAgeMs: clock.observationAgeMs ?? null, observationFreshness: clock.observationFreshness!, policyMaxAgeMs: SOURCE_CLOCK_POLICIES[monitor].maxAgeMs },
      accessBoundary: monitor === "permits" ? "Public application catalog only; issued-permit register is not collected." : monitor === "pacfin" ? "Public report catalog only; credentialed landing report execution is not implemented." : "Configured public feed observations only; this assessment does not inspect credentials or establish provider completeness.",
      geographicBoundary: monitor === "permits" ? "City catalog; no issued-site geography is collected." : monitor === "pacfin" ? "Report definitions; no port/species landing measurements are collected." : "Positions inside the declared Del Norte watch box; the foreign default feed does not establish US-water coverage." });
  }
  const assessment: SourceCoverageAssessment = { schemaVersion: SOURCE_COVERAGE_SCHEMA, generatedAt, registryFingerprint: await sourceRegistryFingerprint(registry), registryCount: registry.length,
    monitoredCount: registry.filter(row => row.automation === "monitored").length, discoveryOnlyCount: registry.filter(row => row.automation === "discovery-only").length,
    sources, watchBox: AIS_WATCH_BOX, primaryDocuments: { adoptionDate: null, effectiveDate: null, status: "requires-document-bound-review", limitation: "This coverage assessment does not establish adopted ordinances, legal effectivity, archive completeness or field currency. Exact document bytes, native text/page evidence and explicit review belong to the lineage/correction contracts." },
    limitations: ["Read-only local evidence; no current upstream refetch, credential check or comprehensive source survey occurred.", "A report byte hash proves retained identity, not factual correctness, completeness or present availability.", "Missing reports remain not-assessed with null facts; an empty foreign AIS feed never becomes local calm."] };
  assertPublicArtifact(assessment); return assessment;
}
/** Every read is bounded and read-only; corrupt existing observations fail rather than become unknown. */
export async function assessRetainedSourceCoverage(root: string, generatedAt = new Date().toISOString()): Promise<SourceCoverageAssessment> {
  const observations: Partial<Record<CoverageMonitor, CoverageObservation>> = {};
  for (const monitor of ["permits", "pacfin", "ais"] as const) {
    const file = join(root, "alerts", monitor, "current.json");
    const bytes = await captureArtifactBytes(file, 2 * 1024 * 1024).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    observations[monitor] = { bytes };
  }
  return buildSourceCoverageAssessment(getSourceRegistry(), observations, generatedAt);
}
/** Deterministic serialization for receipts and independent replay; does not write files. */
export const sourceCoverageBytes = (assessment: SourceCoverageAssessment): Uint8Array => new TextEncoder().encode(`${canonicalArtifactJson(assessment)}\n`);
