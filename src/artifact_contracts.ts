/** Versioned persisted-family authority, reused by loaders, HTTP and public DTO boundaries. */
import { validateSchema, type ValueSchema } from "./schema_validation.js";

export const ARTIFACT_CONTRACT_VERSION = "crescent-city-artifact-contracts/v1";
export const SOURCE_HEALTH_SCHEMA = "crescent-city-source-health/v1";
export const DIRECTORY_CATEGORY_VALUES = ["Government", "Schools", "Healthcare", "Restaurants", "Churches", "Retail", "Services", "Finance", "Media", "Lodging", "Attractions"] as const;
const str = (maxLength = 20_000): ValueSchema => ({ type: "string", maxLength });
const text = { type: "string", minLength: 1, maxLength: 20_000 };
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const number = { type: "number", minimum: 0 };
const bool = { type: "boolean" };
const time = { type: "string", format: "date-time" };
const day = { type: "string", format: "date" };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const url = { type: "string", format: "public-url", maxLength: 4096 };
const nullable = (schema: ValueSchema): ValueSchema => ({ ...schema, nullable: true });
const enumeration = (...values: string[]): ValueSchema => ({ type: "string", enum: values });
const array = (items: ValueSchema, maxItems = 10_000): ValueSchema => ({ type: "array", items, maxItems });
const object = (properties: Record<string, ValueSchema>, required = Object.keys(properties)): ValueSchema => ({ type: "object", properties, required, additionalProperties: false });
const map = (items: ValueSchema, maxProperties = 10_000): ValueSchema => ({ type: "object", additionalProperties: items, maxProperties, propertyNames: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9_: .-]+$" } });
const countMap = map(integer);
const strings = array(str(), 10_000);
const freshness = enumeration("fresh", "stale", "unknown");
export const SOURCE_HEALTH_ROW_SCHEMA = object({
  source: text, sourceId: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,127}$" }, status: enumeration("ok", "empty", "unavailable", "stale"), checkedAt: time, fetchedAt: time,
  observedAt: time, productDate: day, validUntil: time, timestampBasis: enumeration("retrieval", "observation", "product"), observationAgeMs: number, observationFreshness: freshness,
  itemCount: integer, url, error: str(), httpStatus: { type: "integer", minimum: 100, maximum: 599 }, ageMs: number, provenance: str(), freshness, freshnessWindowMs: number, durationMs: number, disabled: bool,
}, ["source", "status", "checkedAt", "itemCount"]);
export const SOURCE_HEALTH_SUMMARY_SCHEMA = object({ checkedAt: time, total: integer, ok: integer, empty: integer, unavailable: integer, stale: integer, present: integer, missing: integer, degraded: integer, coveragePercent: { type: "number", minimum: 0, maximum: 100 }, coverageStatus: enumeration("complete", "partial", "none"), presentSources: strings, missingSources: strings, sources: strings });
const documentDrift = object({ url, changed: bool, isNew: bool, previousHash: nullable(hash), currentHash: hash });
const healthReport = object({ schemaVersion: enumeration(SOURCE_HEALTH_SCHEMA), runId: { type: "string", pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$" }, checkedAt: time, sources: array(SOURCE_HEALTH_ROW_SCHEMA, 1000), attempts: array(object({ key: text, requested: bool }), 1000), documentDrift: array(documentDrift, 10_000) }, ["schemaVersion", "checkedAt", "sources"]);
export const CALENDAR_EVIDENCE_SCHEMA = object({ uid: nullable(str()), recurrenceId: nullable(str()), timezone: nullable(str()), timeBasis: enumeration("utc", "tzid", "floating", "date-only") });
const eventRow = object({ id: text, title: text, kind: enumeration("government-meeting", "community-listing", "civic-news", "youtube", "holiday-closure"), dateStart: nullable(day), publicationAt: nullable({ anyOf: [day, time] }), calendarEvidence: CALENDAR_EVIDENCE_SCHEMA, dateAllDay: bool, timeNote: nullable(str()), location: nullable(str()), organizer: nullable(str()), status: enumeration("scheduled", "completed", "unknown", "cancelled"), description: str(), sourceLinks: { ...array(url, 8), minItems: 1, uniqueItems: true }, sourceName: text, fetchedAt: nullable(time), extractionMethod: nullable(enumeration("markup", "llm")), confidence: nullable({ type: "number", minimum: 0, maximum: 1 }) }, ["id", "title", "kind", "dateStart", "dateAllDay", "timeNote", "location", "organizer", "status", "description", "sourceLinks", "sourceName", "fetchedAt", "extractionMethod", "confidence"]);
const events = object({ schemaVersion: enumeration("crescent-city-events/v1"), generatedAt: time, count: integer,
  llm: object({ attempted: bool, status: enumeration("ok", "unavailable", "skipped"), provider: enumeration("ollama", "openrouter", "none"), model: nullable(str()), summarizedCount: integer, error: str() }, ["attempted", "status", "provider", "model", "summarizedCount"]),
  provenance: object({ deterministicFrom: strings, summarizer: nullable(str()), boundaries: strings }), events: array(eventRow, 200),
  summaries: map(object({ text: str(), status: enumeration("ok", "source_only"), provider: str(), model: nullable(str()), generatedAt: time }), 200),
}, ["schemaVersion", "generatedAt", "count", "llm", "provenance", "events"]);
const category = enumeration(...DIRECTORY_CATEGORY_VALUES);
const directory = object({ schema: enumeration("crescent-city-directory/v1"), generatedAt: { anyOf: [day, time] }, count: integer, categories: array(object({ category, count: { ...integer, minimum: 1 } }), DIRECTORY_CATEGORY_VALUES.length), entries: array(object({ name: text, category, address: nullable(str()), phone: nullable(str()), website: nullable(url), description: nullable(str()), source: url, consultedAt: nullable({ anyOf: [day, time] }), reviewedAt: nullable({ anyOf: [day, time] }) }, ["name", "category", "address", "phone", "website", "description", "source"])) });
const sourceCounts = object({ registryFingerprint: hash, sourceCount: integer, monitoredCount: integer, discoveryOnlyCount: integer, referenceOnlyCount: integer, coverageGaps: strings });
const monthly = object({ schemaVersion: enumeration("1.0.0"), reportType: enumeration("monthly-civic-health"), period: { type: "string", pattern: "^\\d{4}-(?:0[1-9]|1[0-2])$" }, generatedAt: time, periodStart: time, periodEnd: time, status: enumeration("ok", "degraded", "unavailable"), metrics: countMap, sourceHealth: SOURCE_HEALTH_SUMMARY_SCHEMA, sourceDiscovery: sourceCounts, artifacts: object({ markdown: text, metadata: text }), warnings: strings });
const pipeline = object({ schemaVersion: enumeration("1.0.0"), runId: text, pipeline: text, status: enumeration("ok", "degraded", "failed"), exitCode: integer, startedAt: time, completedAt: time, durationMs: number,
  steps: array(object({ name: text, status: enumeration("ok", "degraded", "failed", "skipped"), startedAt: time, completedAt: time, durationMs: number, itemCount: integer, outputPaths: strings, error: str(), metadata: { type: "object", maxProperties: 100 } }, ["name", "status", "startedAt", "completedAt", "durationMs"]), 1000), sourceHealth: SOURCE_HEALTH_SUMMARY_SCHEMA, metadata: object({ appVersion: text, commit: nullable(str(64)), runtime: text, ci: bool }) });
const curation = object({ schemaVersion: enumeration("1.0.0"), runId: text, startedAt: time, completedAt: time, provider: enumeration("ollama", "openrouter", "none"), model: str(), inputCount: integer, attemptedCount: integer, succeededCount: integer, retryableCount: integer, sourceOnlyCount: integer, reusedCount: integer, outputPath: nullable(str()), providerChecked: bool, providerReachable: bool, providerError: str() }, ["schemaVersion", "runId", "startedAt", "completedAt", "provider", "model", "inputCount", "attemptedCount", "succeededCount", "retryableCount", "sourceOnlyCount", "outputPath", "providerReachable"]);
const weekly = object({ schemaVersion: enumeration("1.0.0"), runId: text, pipeline: text, startedAt: time, completedAt: time, monitorStatus: text, alertFailures: integer, missingAlerts: integer, degradedAlerts: integer, feedFailures: integer, missingFeeds: integer, degradedFeeds: integer, downstreamFailures: integer, missingDownstream: integer, degradedDownstream: integer, stepCount: integer, steps: array(object({ name: text, status: enumeration("ok", "degraded", "failed", "skipped"), durationMs: number, error: str() }, ["name", "status", "durationMs"]), 1000), exitCode: integer, status: enumeration("ok", "degraded", "failed"), sourceHealth: SOURCE_HEALTH_SUMMARY_SCHEMA, metadata: pipeline.properties.metadata });
const code = object({ totalArticles: integer, totalSections: integer, totalWords: integer, avgWordsPerSection: number, titleBreakdown: array(object({ title: text, articleCount: integer, sectionCount: integer, wordCount: integer })), longestSections: array(object({ number: str(), title: str(), words: integer, guid: text }), 10), shortestSections: array(object({ number: str(), title: str(), words: integer, guid: text }), 10) });
const missingHealth = object({ source: text, status: enumeration("ok", "empty", "unavailable", "stale"), error: str(), checkedAt: time }, ["source", "status", "checkedAt"]);
const signal = object({ id: text, category: enumeration("source", "alert", "content", "code", "pipeline"), severity: enumeration("info", "watch", "warning"), title: text, detail: str(), evidence: strings, nextStep: str(), operatorOnly: bool }, ["id", "category", "severity", "title", "detail", "evidence", "nextStep"]);
const item = object({ id: text, title: str(), source: text, url: nullable(url), date: nullable({ anyOf: [day, time] }), summary: str() }, ["id", "title", "source", "url", "date"]);
const alertStats = object({ type: text, totalEvents: integer, firstEvent: nullable(time), lastEvent: nullable(time), severityCounts: countMap, avgPerDay: number });
const samplingWindow = object({ startMs: { type: "integer", minimum: -8.64e15, maximum: 8.64e15 }, endMs: { type: "integer", minimum: -8.64e15, maximum: 8.64e15 }, intervalMs: { type: "integer", minimum: 60_000, maximum: 31 * 86_400_000 }, expectedSlots: integer, observedSlots: integer, presentSlots: integer, unavailableSlots: integer, missingSlots: integer, coveragePercent: { type: "number", minimum: 0, maximum: 100 }, presentSourceIds: { ...strings, maxItems: 1000, uniqueItems: true } });
export const SAMPLING_RECEIPT_SCHEMA = object({ schemaVersion: enumeration("civic-sampling/v1"), current: samplingWindow, previous: samplingWindow, invalidRows: integer, duplicateChecks: integer, comparable: bool, reason: text, unit: enumeration("distinct source checks per declared sampling slot") });
const overview = object({ schemaVersion: enumeration("1.0.0"), generatedAt: time, inputFingerprint: hash, status: enumeration("ok", "degraded", "unavailable"), headline: text, summary: str(), entryPoint: object({ title: text, startHere: str(), readOrder: strings, interpretation: str() }),
  metrics: object({ code: object({ articles: integer, sections: integer, words: integer, avgWordsPerSection: number }), sources: { ...SOURCE_HEALTH_SUMMARY_SCHEMA, properties: { ...SOURCE_HEALTH_SUMMARY_SCHEMA.properties, registryCount: integer, monitoredCount: integer, discoveryOnlyCount: integer, referenceOnlyCount: integer }, required: [...SOURCE_HEALTH_SUMMARY_SCHEMA.required, "registryCount", "monitoredCount", "discoveryOnlyCount", "referenceOnlyCount"] }, content: object({ news: integer, meetings: integer, youtube: integer, curated: integer, searchQueries: integer }), alerts: object({ totalEvents: integer, mostActiveType: nullable(str()), mostRecent: nullable(str()) }) }), code,
  sources: object({ missing: array(missingHealth, 1000), degraded: array(missingHealth, 1000), coverageGaps: strings, registryFingerprint: hash }),
  alerts: object({ level: text, reason: str(), assessedAt: nullable(time), analytics: object({ totalEvents: integer, mostActiveType: nullable(str()), mostRecentAlert: nullable(object({ timestamp: time, type: text, severity: str(), description: str(), record: { type: "object", maxProperties: 200 } })), typeStats: array(alertStats, 100) }) }),
  content: object({ recent: array(item, 100), curated: array(item, 100) }), pipeline: object({ status: nullable(str()), runId: nullable(str()), completedAt: nullable(time), curationProvider: nullable(str()), curationModel: nullable(str()), reportPeriod: nullable(str()) }), signals: array(signal, 1000), operatorSignalsNoticed: array(signal, 1000),
  llm: object({ status: enumeration("ok", "unavailable", "not-requested"), provider: str(), model: str(), promptVersion: str(), inputFingerprint: hash, summarizedAt: nullable(time), error: str() }, ["status", "provider", "model", "promptVersion", "inputFingerprint", "summarizedAt"]),
});
overview.properties.sampling = SAMPLING_RECEIPT_SCHEMA;

const sectionIdentity = object({ articleGuid: text, guid: text, number: str(), title: str(), textSha256: hash, historySha256: hash });
const lineage = object({ schemaVersion: enumeration("crescent-city-corpus-lineage/v1"), generatedAt: time, beforeEditionId: hash, afterEditionId: hash, inputFingerprint: hash, transformVersion: enumeration("retained-section-lineage/v1"), count: integer,
  candidates: array(object({ id: hash, kind: enumeration("added", "removed", "renumbered", "retitled", "modified", "identity-candidate"), before: nullable(sectionIdentity), after: nullable(sectionIdentity), suggestedAfterGuids: strings, reviewStatus: enumeration("pending"), legalConclusion: nullable({ type: "null" }) })),
  ordinances: array(object({ documentId: text, documentKind: enumeration("ordinance", "meeting-record", "policy-proposal"), sourceUrl: url, documentSha256: hash, bytes: integer, mediaType: enumeration("application/pdf", "text/html", "text/plain"), adoptionDate: nullable(day), effectiveDate: nullable(day), reviewStatus: enumeration("pending", "reviewed", "rejected"), reviewedAt: nullable(time), reviewOwner: nullable(text), evidenceSpan: nullable(str()), sourceChanged: bool }), 1000), limitations: strings,
});
export const ARTIFACT_SCHEMAS = { events, "source-health": SOURCE_HEALTH_ROW_SCHEMA, "source-health-report": healthReport, "source-health-summary": SOURCE_HEALTH_SUMMARY_SCHEMA, "monthly-report": monthly, "pipeline-run": pipeline, "curation-run": curation, "weekly-summary": weekly, "analytics-overview": overview, directory: { oneOf: [directory, object({ schema: enumeration("crescent-city-directory-unavailable/v1"), generatedAt: time, available: { type: "boolean", enum: [false] }, reason: text })] }, "corpus-lineage": lineage } as const;
export type ArtifactFamily = keyof typeof ARTIFACT_SCHEMAS;
export interface ArtifactValidationOptions { audience?: "internal" | "public"; allowLegacyHealthEnvelope?: boolean }

/** Public projections omit operational errors/path receipts; they retain all public evidence fields. */
export function artifactSchema(family: ArtifactFamily, options: ArtifactValidationOptions = {}): ValueSchema {
  const schema = structuredClone(ARTIFACT_SCHEMAS[family]) as ValueSchema;
  if (family === "source-health-report" && options.allowLegacyHealthEnvelope) schema.required = schema.required.filter((key: string) => key !== "schemaVersion");
  if (options.audience === "public") {
    const strip = (row: ValueSchema): void => {
      for (const key of ["error", "providerError", "operatorOnly", "operatorSignalsNoticed", "outputPaths", "outputPath"]) { if (row.properties) delete row.properties[key]; if (row.required) row.required = row.required.filter((field: string) => field !== key); }
      for (const child of Object.values(row.properties ?? {})) strip(child as ValueSchema);
      if (row.items) strip(row.items); if (typeof row.additionalProperties === "object") strip(row.additionalProperties);
      for (const child of [...(row.anyOf ?? []), ...(row.oneOf ?? [])]) strip(child);
    };
    strip(schema);
    if (family === "monthly-report") { delete schema.properties.artifacts; schema.required = schema.required.filter((key: string) => key !== "artifacts"); }
    if (family === "pipeline-run" || family === "weekly-summary") { delete schema.properties.metadata; schema.required = schema.required.filter((key: string) => key !== "metadata"); delete schema.properties.steps.items.properties.metadata; }
  }
  return schema;
}

/** Semantic invariants are kept beside their structural schema, never duplicated at each consumer. */
export function validateArtifact(family: ArtifactFamily, value: unknown, options: ArtifactValidationOptions = {}): string[] {
  const errors = validateSchema(value, artifactSchema(family, options), family);
  if (errors.length) return errors;
  const v = value as Record<string, any>;
  const fail = (message: string) => errors.push(`${family}: ${message}`);
  const duplicate = (rows: any[], identity: (row: any) => string) => new Set(rows.map(identity)).size !== rows.length;
  if (family === "events") {
    if (v.count !== v.events.length) fail("count does not match rows");
    if (duplicate(v.events, row => row.id)) fail("duplicate event identities");
    if (v.events.some((row: any) => row.status !== "unknown" && row.dateStart === null && row.status !== "cancelled")) fail("known occurrence status requires an occurrence date");
    if (Object.keys(v.summaries ?? {}).some(key => !v.events.some((row: any) => row.id === key))) fail("summary references unknown event");
    if (v.llm.summarizedCount !== Object.values(v.summaries ?? {}).filter((row: any) => row.status === "ok").length) fail("summary count does not match rows");
  }
  if (family === "directory" && v.schema === "crescent-city-directory/v1") {
    if (v.count !== v.entries.length) fail("count does not match rows");
    if (duplicate(v.entries, row => `${row.category}:${row.name.toLocaleLowerCase()}`)) fail("duplicate directory identities");
    const counts = new Map<string, number>(); for (const row of v.entries) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
    if (duplicate(v.categories, row => row.category) || v.categories.length !== counts.size || v.categories.some((row: any) => row.count !== counts.get(row.category))) fail("category counts do not match rows");
  }
  if (family === "corpus-lineage") {
    if (v.count !== v.candidates.length || duplicate(v.candidates, row => row.id) || duplicate(v.ordinances, row => row.documentId)) fail("lineage count or identities are inconsistent");
    if (v.candidates.some((row: any) => row.kind === "added" ? row.before !== null || row.after === null : row.kind === "removed" ? row.before === null || row.after !== null : row.before === null || row.after === null)) fail("lineage candidate sides contradict kind");
    if (v.ordinances.some((row: any) => row.documentKind !== "ordinance" && (row.adoptionDate !== null || row.effectiveDate !== null) || row.reviewStatus !== "reviewed" && (row.adoptionDate !== null || row.effectiveDate !== null) || row.reviewStatus === "reviewed" && (row.reviewedAt === null || row.reviewOwner === null || row.evidenceSpan === null) || row.sourceChanged && row.reviewStatus !== "pending")) fail("ordinance dates lack current reviewed evidence");
  }
  if (family === "source-health-report") {
    if (duplicate(v.sources, row => row.source)) fail("duplicate source identities");
    if (v.documentDrift && (duplicate(v.documentDrift, row => row.url) || v.documentDrift.some((row: any) => row.isNew !== (row.previousHash === null) || row.changed !== (row.previousHash !== null && row.previousHash !== row.currentHash)))) fail("document drift contradicts retained hashes");
  }
  const healthSummary = (summary: Record<string, any>): void => {
    if (summary.total !== summary.ok + summary.empty + summary.unavailable + summary.stale || summary.present !== summary.ok + summary.empty || summary.missing !== summary.unavailable + summary.stale || summary.degraded !== summary.missing) fail("source health counts are inconsistent");
    if (summary.coveragePercent !== (summary.total ? Math.round(summary.present / summary.total * 1000) / 10 : 0) || summary.coverageStatus !== (summary.total === 0 || summary.present === 0 ? "none" : summary.missing === 0 ? "complete" : "partial")) fail("source coverage is inconsistent");
    if (summary.sources.length !== summary.total || summary.presentSources.length !== summary.present || summary.missingSources.length !== summary.missing || duplicate(summary.sources, row => row) || [...summary.presentSources, ...summary.missingSources].sort().join("\0") !== [...summary.sources].sort().join("\0")) fail("source health names are inconsistent");
  };
  if (family === "source-health-summary") healthSummary(v);
  if (family === "monthly-report" || family === "pipeline-run" || family === "weekly-summary") healthSummary(v.sourceHealth);
  if (family === "monthly-report") {
    if (Date.parse(v.periodStart) >= Date.parse(v.periodEnd) || v.periodStart.slice(0, 7) !== v.period) fail("invalid reporting period");
    const s = v.sourceDiscovery; if (s.sourceCount !== s.monitoredCount + s.discoveryOnlyCount + s.referenceOnlyCount) fail("source inventory counts are inconsistent");
  }
  if (family === "pipeline-run") {
    if (Date.parse(v.completedAt) < Date.parse(v.startedAt) || v.steps.some((row: any) => Date.parse(row.completedAt) < Date.parse(row.startedAt))) fail("completion precedes start");
    if (duplicate(v.steps, row => row.name)) fail("duplicate pipeline steps");
    if ((v.status === "failed" && v.exitCode < 2 || v.status === "ok" && v.exitCode !== 0) || v.status === "ok" && v.steps.some((row: any) => ["failed", "degraded"].includes(row.status))) fail("pipeline verdict contradicts steps or exit code");
  }
  if (family === "curation-run") {
    if (Date.parse(v.completedAt) < Date.parse(v.startedAt) || v.attemptedCount > v.inputCount || v.succeededCount + v.sourceOnlyCount > v.attemptedCount || v.retryableCount > v.attemptedCount || (v.reusedCount ?? 0) > v.inputCount) fail("curation counts or timestamps contradict the run");
  }
  if (family === "weekly-summary") {
    if (v.stepCount !== v.steps.length || duplicate(v.steps, row => row.name) || v.missingAlerts !== v.degradedAlerts || v.missingFeeds !== v.degradedFeeds || v.missingDownstream !== v.degradedDownstream || Date.parse(v.completedAt) < Date.parse(v.startedAt)) fail("weekly counts, aliases or timestamps contradict the run");
  }
  if (family === "analytics-overview") {
    healthSummary(v.metrics.sources);
    const c = v.code, m = v.metrics.code;
    if (m.articles !== c.totalArticles || m.sections !== c.totalSections || m.words !== c.totalWords || m.avgWordsPerSection !== c.avgWordsPerSection) fail("code metrics contradict statistics");
    if (c.totalSections !== c.titleBreakdown.reduce((sum: number, row: any) => sum + row.sectionCount, 0) || c.totalWords !== c.titleBreakdown.reduce((sum: number, row: any) => sum + row.wordCount, 0)) fail("code title totals do not match statistics");
    const a = v.alerts.analytics;
    if (a.totalEvents !== a.typeStats.reduce((sum: number, row: any) => sum + row.totalEvents, 0) || v.metrics.alerts.totalEvents !== a.totalEvents || v.metrics.alerts.mostActiveType !== a.mostActiveType || v.metrics.alerts.mostRecent !== (a.mostRecentAlert?.description ?? null)) fail("alert metrics contradict statistics");
    if (duplicate(a.typeStats, row => row.type) || a.typeStats.some((row: any) => row.totalEvents !== Object.values(row.severityCounts).reduce((sum: number, count: any) => sum + count, 0))) fail("alert histogram counts do not match statistics");
    if (v.sampling) {
      const s = v.sampling;
      if ([s.current, s.previous].some(w => w.startMs >= w.endMs || w.observedSlots !== w.presentSlots + w.unavailableSlots || w.expectedSlots !== w.observedSlots + w.missingSlots || w.coveragePercent !== (w.expectedSlots ? Math.round(w.presentSlots / w.expectedSlots * 10_000) / 100 : 0)) || s.current.startMs !== s.previous.endMs || s.current.endMs - s.current.startMs !== s.previous.endMs - s.previous.startMs || s.current.intervalMs !== s.previous.intervalMs || s.current.expectedSlots !== s.previous.expectedSlots) fail("sampling windows or denominators are inconsistent");
      if (s.comparable !== (s.invalidRows === 0 && s.current.coveragePercent >= 80 && s.previous.coveragePercent >= 80 && JSON.stringify(s.current.presentSourceIds) === JSON.stringify(s.previous.presentSourceIds))) fail("sampling comparability contradicts coverage evidence");
    }
  }
  return errors.slice(0, 20);
}
export function assertArtifact(family: ArtifactFamily, value: unknown, options: ArtifactValidationOptions = {}): void {
  const errors = validateArtifact(family, value, options);
  if (errors.length) throw new Error(`Invalid ${family} artifact: ${errors.join("; ")}`);
}
