/**
 * Canonical manuscript variables derived from the shared analytics envelope.
 *
 * The manuscript is deliberately a consumer of the analytics artifact rather
 * than a second analytics implementation. This keeps the paper, local GUI,
 * and Pages snapshot on one evidence fingerprint.
 */
import type { AnalyticsOverview } from "./analytics_backend.js";

export const MANUSCRIPT_VARIABLE_NAMES = new Set([
  "SNAPSHOT_DATE",
  "CODE_SECTIONS",
  "CODE_ARTICLES",
  "CODE_WORDS",
  "SOURCE_TOTAL",
  "SOURCE_OK",
  "SOURCE_EMPTY",
  "SOURCE_UNAVAILABLE",
  "SOURCE_STALE",
  "ANALYTICS_STATUS",
  "ALERT_LEVEL",
  "LLM_STATUS",
  "ANALYTICS_FINGERPRINT",
  "REGISTRY_COUNT",
  "MONITORED_COUNT",
  "DISCOVERY_ONLY_COUNT",
  "REFERENCE_ONLY_COUNT",
  "ALERT_EVENTS",
  "CURATED_BRIEFS",
  "ALERT_REASON",
  "LLM_PROVIDER",
  "LLM_MODEL",
]);

function displayNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function displayTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
}

export function valuesFromOverview(overview: AnalyticsOverview): Record<string, string> {
  const { metrics, alerts, llm } = overview;
  return {
    SNAPSHOT_DATE: displayTimestamp(overview.generatedAt),
    CODE_SECTIONS: displayNumber(metrics.code.sections),
    CODE_ARTICLES: displayNumber(metrics.code.articles),
    CODE_WORDS: displayNumber(metrics.code.words),
    SOURCE_TOTAL: displayNumber(metrics.sources.total),
    SOURCE_OK: displayNumber(metrics.sources.ok),
    SOURCE_EMPTY: displayNumber(metrics.sources.empty),
    SOURCE_UNAVAILABLE: displayNumber(metrics.sources.unavailable),
    SOURCE_STALE: displayNumber(metrics.sources.stale),
    ANALYTICS_STATUS: overview.status,
    ALERT_LEVEL: alerts.level,
    LLM_STATUS: llm.status,
    ANALYTICS_FINGERPRINT: overview.inputFingerprint,
    REGISTRY_COUNT: displayNumber(metrics.sources.registryCount),
    MONITORED_COUNT: displayNumber(metrics.sources.monitoredCount),
    DISCOVERY_ONLY_COUNT: displayNumber(metrics.sources.discoveryOnlyCount),
    REFERENCE_ONLY_COUNT: displayNumber(metrics.sources.referenceOnlyCount),
    ALERT_EVENTS: displayNumber(metrics.alerts.totalEvents),
    CURATED_BRIEFS: displayNumber(metrics.content.curated),
    ALERT_REASON: alerts.reason,
    LLM_PROVIDER: llm.provider,
    LLM_MODEL: llm.model,
  };
}

export function renderableManuscriptTokenNames(): Set<string> {
  return new Set(MANUSCRIPT_VARIABLE_NAMES);
}
