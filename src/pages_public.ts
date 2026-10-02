/** Explicit public artifact-family DTO schemas; backend additions stay local. */
import { assertArtifact, type ArtifactFamily } from "./artifact_contracts.js";
import { isIP } from "node:net";
import { isPublicAddress } from "./shared/transport.js";
type Shape = true | { [field: string]: Shape } | [Shape];
const scalars = (fields: string): { [field: string]: Shape } => Object.fromEntries(fields.split(/\s+/).filter(Boolean).map(field => [field, true]));
function project(value: unknown, shape: Shape): unknown {
  if (shape === true) return value === null || ["string", "number", "boolean"].includes(typeof value) ? value : Array.isArray(value) && value.every(item => item === null || ["string", "number", "boolean"].includes(typeof item)) ? value : undefined;
  if (Array.isArray(shape)) return Array.isArray(value) ? value.map(item => project(item, shape[0])).filter(item => item !== undefined) : [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return value === null ? null : {};
  const source = value as Record<string, unknown>;
  if (source.operatorOnly === true) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) if (Object.hasOwn(source, key)) {
    const projected = project(source[key], field);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
}
function publicMap(value: unknown, row: Shape): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => /^[A-Za-z0-9_: .-]{1,160}$/.test(key)).map(([key, item]) => [key, project(item, row)]).filter(([, item]) => item !== undefined));
}
const item = scalars("id title source url date summary");
const sourceHealth = scalars("sourceId source status checkedAt fetchedAt observedAt productDate validUntil timestampBasis observationAgeMs observationFreshness itemCount url httpStatus ageMs freshness freshnessWindowMs durationMs disabled provenance");
const registry = scalars("id name kind authority region canonicalUrl endpointUrl discoveredFrom collectionMode automation enabled configuredMonitor referenceOnly expectedCadence provenance");
const stats = { ...scalars("type totalEvents firstEvent lastEvent avgPerDay"), severityCounts: {} };
const signal = scalars("id category severity title detail evidence nextStep");
const healthSummary = scalars("checkedAt total ok empty unavailable stale present missing coveragePercent coverageStatus presentSources missingSources degraded registryCount monitoredCount discoveryOnlyCount referenceOnlyCount sources");
const reportShape = { ...scalars("schemaVersion generatedAt status runId startedAt completedAt durationMs period month year inputFingerprint provider model requestCount createdCount skippedCount totalSteps successfulSteps failedSteps degradedSteps"), counts: scalars("articles sections news meetings youtube curated alerts events sources succeeded failed skipped"), steps: [scalars("name status startedAt completedAt durationMs")] } satisfies Shape;
const alertRow = scalars("id title number text description summary headline source sourceName url link level status severity type event eventType magnitude depth distance distanceKm latitude longitude lat lon location fetchedAt checkedAt assessedAt effective expires sent onset instruction areaDesc timestamp start end date waveHeight wavePeriod windSpeed windDirection waterTemperature airTemperature tideHeight stationName stationId name route county condition reason value units price grade volume vesselName mmsi vesselType speed course heading permitNumber address reportName season seasonStatus zone area schoolName");
const monitorShape = { ...scalars("schemaVersion monitor source sourceUrl url fetchedAt checkedAt assessedAt generatedAt timestamp status level reason summary message detail count itemCount available availability station stationId stationName droughtCategory dsci averagePrice state fuelType warningCount alertCount activeCount earthquakeCount plumeCount closureCount noticeCount"), events: [alertRow], alerts: [alertRow], earthquakes: [alertRow], incidents: [alertRow], closures: [alertRow], notices: [alertRow], permits: [alertRow], reports: [alertRow], vessels: [alertRow], plumes: [alertRow], tides: [alertRow], forecast: [alertRow], current: alertRow } satisfies Shape;

export function publicReports(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const source = value as Record<string, unknown>;
  if (source.reportType === "monthly-civic-health") {
    const dto = project(value, { ...scalars("schemaVersion reportType period generatedAt periodStart periodEnd status warnings"), sourceHealth: healthSummary, sourceDiscovery: scalars("registryFingerprint sourceCount monitoredCount discoveryOnlyCount referenceOnlyCount coverageGaps") }) as Record<string, unknown>;
    dto.metrics = publicMap(source.metrics, true);
    return dto;
  }
  if (Array.isArray(source.steps) && source.durationMs !== undefined && source.sourceHealth) return project(value, { ...scalars("schemaVersion runId pipeline status exitCode startedAt completedAt durationMs"), sourceHealth: healthSummary, steps: [scalars("name status startedAt completedAt durationMs itemCount")] }) as Record<string, unknown>;
  if (source.providerReachable !== undefined && source.attemptedCount !== undefined) return project(value, scalars("schemaVersion runId startedAt completedAt provider model inputCount attemptedCount succeededCount retryableCount sourceOnlyCount reusedCount providerChecked providerReachable")) as Record<string, unknown>;
  if (source.stepCount !== undefined) return project(value, { ...scalars("schemaVersion runId pipeline status exitCode startedAt completedAt monitorStatus alertFailures missingAlerts degradedAlerts feedFailures missingFeeds degradedFeeds downstreamFailures missingDownstream degradedDownstream stepCount"), sourceHealth: healthSummary, steps: [scalars("name status durationMs")] }) as Record<string, unknown>;
  return project(value, reportShape) as Record<string, unknown>;
}
/** Checked public boundary uses the same family authority as local readers/HTTP responses. */
export function assertPublicFamilyArtifact(family: ArtifactFamily, value: unknown): void {
  assertArtifact(family, value, { audience: "public" });
  assertPublicArtifact(value);
}
export function publicAlerts(value: unknown): { composite: Record<string, unknown> | null; current: Record<string, unknown>[] } {
  const dto = project(value, { composite: { ...scalars("level assessedAt generatedAt reason hasUnavailableMonitors monitorsPresent monitorsExpected presentCount expectedCount available degraded status"), sourceHealth: [sourceHealth], factors: [scalars("source level reason")], alerts: [alertRow] }, current: [monitorShape] }) as { composite: Record<string, unknown> | null; current: Record<string, unknown>[] };
  const original = value as { composite?: { monitors?: unknown } };
  if (dto.composite && original.composite?.monitors) dto.composite.monitors = publicMap(original.composite.monitors, scalars("level reason available status count detail source checkedAt summary availability"));
  return dto;
}
export function publicEvents(value: unknown): unknown {
  const dto = project(value, { ...scalars("schemaVersion profileId profileSha256 generatedAt count"), llm: scalars("attempted status provider model summarizedCount"), provenance: scalars("deterministicFrom summarizer boundaries"), events: [{ ...scalars("id title kind dateStart dateAllDay timeNote publicationAt location organizer status description sourceLinks sourceName fetchedAt extractionMethod confidence"), calendarEvidence: scalars("uid recurrenceId timezone timeBasis") }] }) as Record<string, unknown>;
  if (value && typeof value === "object" && Object.hasOwn(value, "summaries")) dto.summaries = publicMap((value as Record<string, unknown>).summaries, scalars("text status provider model generatedAt"));
  return dto;
}
export function publicSourceHealth(value: unknown): unknown { return project(value, [sourceHealth]); }
export function publicSourceRegistry(value: unknown): unknown { return project(value, [registry]); }
export function publicSourceDiscovery(value: unknown): unknown {
  const dto = project(value, { ...scalars("schemaVersion generatedAt scope registryFingerprint previousFingerprint changed sourceCount monitoredCount discoveryOnlyCount referenceOnlyCount enabledCount coverageGaps"), probe: scalars("checked unavailable"), sources: [{ ...registry, ...scalars("operationalStatus checkedAt itemCount healthSource collection healthBinding"), reachability: scalars("status checkedAt httpStatus"), healthReceipts: [scalars("source sourceId status checkedAt fetchedAt ageMs freshness")] }] }) as Record<string, unknown>;
  if (value && typeof value === "object") for (const field of ["countsByKind", "countsByAuthority"]) dto[field] = publicMap((value as Record<string, unknown>)[field], true);
  return dto;
}
export function publicAnalytics(value: unknown): unknown {
  const dto = project(value, { ...scalars("schemaVersion generatedAt inputFingerprint status headline summary"), entryPoint: scalars("title startHere readOrder interpretation"), metrics: { code: scalars("articles sections words avgWordsPerSection"), sources: healthSummary, content: scalars("news meetings youtube curated searchQueries"), alerts: scalars("totalEvents mostActiveType mostRecent") }, code: { ...scalars("totalArticles totalSections totalWords avgWordsPerSection"), titleBreakdown: [scalars("title articleCount sectionCount wordCount")], longestSections: [scalars("number title words guid")], shortestSections: [scalars("number title words guid")] }, sources: { missing: [sourceHealth], degraded: [sourceHealth], ...scalars("coverageGaps registryFingerprint") }, alerts: { ...scalars("level reason assessedAt"), analytics: { ...scalars("totalEvents mostActiveType"), mostRecentAlert: { ...scalars("timestamp type severity description"), record: alertRow }, typeStats: [{ ...stats, severityCounts: {} }] } }, content: { recent: [item], curated: [item] }, pipeline: scalars("status runId completedAt curationProvider curationModel reportPeriod"), signals: [signal], llm: scalars("status provider model promptVersion inputFingerprint summarizedAt") }) as Record<string, unknown>;
  const original = value as { alerts?: { analytics?: { typeStats?: Array<{ severityCounts?: unknown }> } } };
  const sampling = value && typeof value === "object" ? (value as Record<string, unknown>).sampling : undefined;
  if (sampling !== undefined) dto.sampling = project(sampling, { ...scalars("schemaVersion invalidRows duplicateChecks comparable reason unit"), current: scalars("startMs endMs intervalMs expectedSlots observedSlots presentSlots unavailableSlots missingSlots coveragePercent presentSourceIds"), previous: scalars("startMs endMs intervalMs expectedSlots observedSlots presentSlots unavailableSlots missingSlots coveragePercent presentSourceIds") });
  const rows = ((dto.alerts as Record<string, unknown> | undefined)?.analytics as Record<string, unknown> | undefined)?.typeStats;
  if (Array.isArray(rows)) rows.forEach((row, index) => { row.severityCounts = publicMap(original.alerts?.analytics?.typeStats?.[index]?.severityCounts, true); });
  return dto;
}

/** Report only diagnostic classes; never echo the sensitive value in errors. */
export function publicExposureErrors(value: unknown): string[] {
  const errors = new Set<string>();
  const urlFields = /^(?:url|sourceUrl|canonicalUrl|endpointUrl|website|sourceLinks|discoveredFrom|link|href)$/i;
  const inspectUrl = (url: URL): void => {
    if (url.username || url.password) errors.add("URL credentials in public artifact");
    const credentialKey = (key: string) => /(?:key|token|secret|password|authorization|signature|credential|^auth$|^sig$|^bearer$|^jwt$)/i.test(key);
    if ([...url.searchParams.keys()].some(credentialKey)) errors.add("credential-bearing URL in public artifact");
    // OAuth-style fragments are saved/publicly transferred with the URL even
    // though the browser omits them from its HTTP request. Section anchors
    // without parameter assignments remain ordinary public identifiers.
    let fragment = url.hash.slice(1);
    try { fragment = decodeURIComponent(fragment); } catch { /* scan the literal fragment */ }
    if (fragment.includes("=")) {
      const parameters = new URLSearchParams(fragment.slice(fragment.indexOf("?") + 1).replace(/;/g, "&"));
      if ([...parameters.keys()].some(credentialKey)) errors.add("credential-bearing URL in public artifact");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostname) ? !isPublicAddress(hostname) : !hostname.includes(".") || /(?:^localhost$|\.(?:localhost|local|internal|lan)$)/i.test(hostname)) errors.add("local service URL in public artifact");
  };
  const visit = (item: unknown, field = ""): void => {
    if (urlFields.test(field) && Array.isArray(item) && (!/^(?:sourceLinks|discoveredFrom)$/i.test(field) || !item.every(row => typeof row === "string"))) errors.add("invalid URL array in public artifact");
    if (urlFields.test(field) && item !== null && item !== undefined && !Array.isArray(item)) {
      if (typeof item !== "string") errors.add("invalid URL field in public artifact");
      else if (item.trim()) {
        try {
          const relativeHref = field.toLowerCase() === "href" && /^[/#?]/.test(item) && !/^\/\//.test(item) && !/[\\\u0000-\u0020\u007f]/.test(item);
          const url = relativeHref ? new URL(item, "https://ecode360.com/") : new URL(item);
          if (!["http:", "https:"].includes(url.protocol)) errors.add("unsafe URL protocol in public artifact");
          inspectUrl(url);
        }
        catch { errors.add("invalid URL field in public artifact"); }
      }
    }
    if (typeof item === "string") {
      if (/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\|file:\/\/|\bBearer\s+[A-Za-z0-9._-]+)/i.test(item)) errors.add("operator path or credential in public artifact");
      for (const match of item.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi)) {
        try {
          const url = new URL(match[0]);
          inspectUrl(url);
        } catch { /* prose URLs may end in punctuation; DTO URL checks are separate */ }
      }
    } else if (Array.isArray(item)) item.forEach(row => visit(row, field));
    else if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      if (/^(?:api[_-]?key|authorization|access[_-]?token|password|secret|operatorSignalsNoticed|operatorSignals|requestLog|chatHistory|searchQueryLog|ragQueryLog)$/i.test(key) && child !== null) errors.add("private field in public artifact");
      if (key === "operatorOnly" && child === true) errors.add("operator-only record in public artifact");
      visit(child, key);
    }
  };
  visit(value); return [...errors];
}

export function assertPublicArtifact(value: unknown): void {
  const errors = publicExposureErrors(value);
  if (errors.length) throw new Error(`Publication privacy check failed: ${errors.join("; ")}`);
}

/** Core custody files retain exact bytes, so unknown fields fail instead of being silently rewritten. */
export function assertPublicMunicipalFile(file: string, value: unknown): void {
  type Spec = true | { [field: string]: Spec } | [Spec];
  const section = scalars("guid number title text history");
  const toc: { [field: string]: Spec } = { ...scalars("prefix tocName guid parent href title number indexNum type label hideNumber") }; toc.children = [toc];
  const score = scalars("gradeLevel readingEase gunningFog complexWordPct avgSyllablesPerWord avgWordsPerSentence wordCount sentenceCount difficulty");
  const schemas: Record<string, Spec> = {
    "crescent-city-code.json": { ...scalars("municipality guid source exportedAt"), articles: [{ ...scalars("guid title number url sha256 exportedArticleSha256"), sections: [section] }] },
    "toc.json": toc,
    "manifest.json": { ...scalars("municipality municipalityGuid sourceUrl version scrapedAt completedAt tocNodeCount articlePageCount sectionCount tocFingerprint tocFetchedAt tocSource lastRunAt"), articles: { map: scalars("guid title number sectionCount sha256 filePath lastScrapedAt extractionSha256") } },
    "verification-report.json": { ...scalars("schemaVersion verifiedAt municipality overallStatus publicationEligible totalArticles passedArticles failedArticles totalExpectedSections totalFoundSections missingSections localErrors"), binding: scalars("manifestSha256 tocSha256 articleSetSha256"), planes: scalars("local currentToc sample"), evidence: scalars("currentToc sample limitations"), results: [{ ...scalars("guid title status"), checks: scalars("fileExists sha256Match sectionCountMatch expectedSections foundSections allSectionsPresent missingSections") }], sample: { ...scalars("attempted passes mismatches failed selected"), results: [scalars("guid status error")] } },
    "domain-coverage.json": { ...scalars("computedAt totalSections coveredSections overallCoveragePct"), domains: [scalars("domainId domainName referencedCount referencedSectionNumbers coveredSections coveragePct")] },
    "readability.json": { ...scalars("computedAt totalSections scored averageGradeLevel"), hardestSections: [{ ...scalars("number title"), score }], easiestSections: [{ ...scalars("number title"), score }], allScores: [{ ...scalars("number title"), score }] },
  };
  const check = (item: unknown, spec: Spec): void => {
    const invalid = () => { throw new Error("Public municipal artifact contains an unsupported field or shape"); };
    if (spec === true) {
      if (item !== null && !["string", "number", "boolean"].includes(typeof item) && !(Array.isArray(item) && item.every(row => row === null || ["string", "number", "boolean"].includes(typeof row)))) invalid();
      return;
    }
    if (Array.isArray(spec)) { if (!Array.isArray(item)) invalid(); else item.forEach(row => check(row, spec[0])); return; }
    if (!item || typeof item !== "object" || Array.isArray(item)) { invalid(); return; }
    if (Object.hasOwn(spec, "map")) { for (const row of Object.values(item)) check(row, spec.map!); return; }
    for (const [key, row] of Object.entries(item)) { if (!Object.hasOwn(spec, key)) invalid(); else check(row, spec[key]!); }
  };
  if (!schemas[file]) throw new Error("Unknown public municipal artifact family");
  check(value, schemas[file]); assertPublicArtifact(value);
}
