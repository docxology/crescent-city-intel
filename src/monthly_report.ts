#!/usr/bin/env bun
/**
 * Monthly Civic Health Report Generator
 *
 * Auto-generates output/reports/monthly-YYYY-MM.md summarizing:
 *   - Municipal code stats (sections, words, readability)
 *   - Alert events for the month (earthquake, weather, tsunami)
 *   - Meeting monitor activity (parsed vote tallies + agenda/minutes SHA-256 drift)
 *   - News highlights (top keywords)
 *   - Domain coverage summary
 *
 * Usage: bun run report            (uses current month)
 *        bun run report 2026-02    (specific month)
 *
 * Reads from existing output/alerts/{type}/history.jsonl and current
 * news/meetings/curation batch files; source-health artifacts are included.
 * No live network calls — summarizes already-scraped local data.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createLogger } from './logger.js';
import { domains } from './domains.js';
import { paths } from './shared/paths.js';
import { completeSourceHealth, isIsoTimestamp, summarizeSourceHealth, writeJsonAtomic, writeTextAtomic } from './shared/source_health.js';
import { buildSourceDiscoveryReport, getSourceRegistry } from './source_registry.js';
import { isActiveNewsSource } from './news_monitor.js';
import type { DocumentDrift } from './minutes_extraction.js';
import { crossReferenceAgendaTopics } from './agenda_crossref.js';
import type { AgendaCodeRef } from './agenda_crossref.js';
import { chatWithProvider } from './llm/provider.js';
import { llmConfig } from './llm/config.js';
import type { MonthlyReportMetadata, SourceHealth } from './types.js';

const logger = createLogger('monthly-report');

const REPORTS_DIR = paths.reports;

// ─── Helpers ──────────────────────────────────────────────────────

/** Read a JSONL file safely, return [] if missing */
function readJsonl(filePath: string): any[] {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Read a JSON file safely, return null if missing */
function readJson(filePath: string): any | null {
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, 'utf-8')); } catch { return null; }
}

/** Filter JSONL records to those within the given year-month (YYYY-MM) */
export function parseTargetMonth(targetMonth?: string): { month: string; year: number; monthIndex: number; start: Date; end: Date; label: string } {
  const now = new Date();
  const candidate = targetMonth ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(candidate)) {
    throw new Error(`Invalid report period "${candidate}"; expected YYYY-MM`);
  }
  const [yearText, monthText] = candidate.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  return {
    month: candidate,
    year,
    monthIndex,
    start,
    end,
    label: new Date(year, monthIndex, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
  };
}

export function inPeriod(records: any[], start: Date, end: Date): { items: any[]; invalidTimestamps: number } {
  let invalidTimestamps = 0;
  const items = records.filter(r => {
    const ts = r.fetchedAt ?? r.time ?? r.scrapedAt ?? r.timestamp ?? r.pubDate ?? r.date ?? '';
    if (!isIsoTimestamp(ts)) {
      if (ts) invalidTimestamps++;
      return false;
    }
    const time = Date.parse(ts);
    return time >= start.getTime() && time < end.getTime();
  });
  return { items, invalidTimestamps };
}

function readBatchItems(dir: string, month: string, include: (item: any) => boolean = () => true): any[] {
  if (!existsSync(dir)) return [];
  const items: any[] = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const batch = readJson(join(dir, file));
    if (Array.isArray(batch)) {
      items.push(...batch.filter(item => {
        if (!include(item)) return false;
        const ts = item?.curatedAt ?? item?.fetchedAt ?? item?.pubDate ?? item?.date ?? '';
        const parsed = Date.parse(ts);
        return Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(month);
      }));
      continue;
    }
    if (!batch || !isIsoTimestamp(batch.fetchedAt) || !batch.fetchedAt.startsWith(month)) continue;
    if (Array.isArray(batch.items)) items.push(...batch.items.filter(include));
  }
  return items;
}

/** Format a magnitude as M4.2 */
const fmtMag = (m: number) => `M${m.toFixed(1)}`;
// ─── Meeting votes + agenda/minutes document drift (TODO Phase 4.2) ──

/** Runtime shape guard for untrusted JSON: object (not array) or null. */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
/** Max vote rows rendered in one report (the count line always shows the true total). */
const MEETING_VOTE_ROW_LIMIT = 12;
/** Max drift bullets rendered in one report. */
const MEETING_DRIFT_ROW_LIMIT = 10;

/** One flattened, deduplicated vote row ready for the report table. */
export interface MeetingVoteRow {
  link: string;
  date: string;
  title: string;
  source: string;
  yea: number;
  nay: number;
  abstain: number;
  absent: number;
  passed: boolean;
  /** True when `passed` was derived from the tally rather than stated by the minutes. */
  inferred: boolean;
}

/**
 * Flatten item-level votes (`vote`) and per-motion vote tables (`voteTable`,
 * extracted from minutes text by minutes_extraction.ts) into report rows.
 * The same item appears in every batch file of the month, so rows are
 * deduplicated by (link, tally); rows without a finite yea/nay pair are
 * dropped rather than rendered as zeros. Never throws.
 */
export function buildMeetingVoteRows(meetingItems: unknown[]): MeetingVoteRow[] {
  const rows: MeetingVoteRow[] = [];
  const seen = new Set<string>();
  const push = (item: Record<string, unknown> | null, vote: unknown): void => {
    const tally = asRecord(vote);
    if (!item || !tally) return;
    const yea = Number(tally.yea);
    const nay = Number(tally.nay);
    if (!Number.isFinite(yea) || !Number.isFinite(nay)) return;
    const abstain = Number(tally.abstain);
    const absent = Number(tally.absent);
    const link = typeof item.link === 'string' ? item.link : '';
    const date = typeof item.date === 'string' ? item.date : '';
    const rawTitle = typeof item.title === 'string' ? item.title : '';
    const source = typeof item.source === 'string' ? item.source : '';
    const row: MeetingVoteRow = {
      link,
      date,
      title: rawTitle || 'Untitled',
      source,
      yea,
      nay,
      abstain: Number.isFinite(abstain) ? abstain : 0,
      absent: Number.isFinite(absent) ? absent : 0,
      passed: tally.passed === true,
      inferred: tally.inferred === true,
    };
    const key = `${row.link}|${row.yea}-${row.nay}-${row.abstain}-${row.absent}-${row.passed ? 1 : 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };
  for (const item of meetingItems ?? []) {
    const record = asRecord(item);
    if (!record) continue;
    push(record, record.vote);
    if (Array.isArray(record.voteTable)) for (const vote of record.voteTable) push(record, vote);
  }
  return rows;
}

function normalizeDrift(d: unknown): DocumentDrift | null {
  const record = asRecord(d);
  if (!record) return null;
  const url = record.url;
  const currentHash = record.currentHash;
  if (typeof url !== 'string' || !url || typeof currentHash !== 'string' || !currentHash) return null;
  const previousHash = record.previousHash;
  return {
    url,
    changed: record.changed === true,
    isNew: record.isNew === true,
    previousHash: typeof previousHash === 'string' ? previousHash : null,
    currentHash,
  };
}

/**
 * Collect agenda/minutes SHA-256 drift for the report month. Batch files in
 * `govMeetingsDir` record drift at change time (union over the whole month);
 * the health artifact holds only the latest run, so a change that happened
 * mid-month is visible even after newer runs overwrite the health artifact.
 * Deduplicated by (url, previous hash, current hash). Never throws.
 */
export function collectDocumentDrift(govMeetingsDir: string, month: string, healthDrift: unknown): DocumentDrift[] {
  const drift: DocumentDrift[] = [];
  const seen = new Set<string>();
  const push = (d: unknown): void => {
    const normalized = normalizeDrift(d);
    if (!normalized) return;
    const key = `${normalized.url}|${normalized.previousHash ?? ''}|${normalized.currentHash}`;
    if (seen.has(key)) return;
    seen.add(key);
    drift.push(normalized);
  };
  if (existsSync(govMeetingsDir)) {
    for (const file of readdirSync(govMeetingsDir).filter(f => f.endsWith('.json'))) {
      const batch = asRecord(readJson(join(govMeetingsDir, file)));
      if (!batch) continue;
      const fetchedAt = batch.fetchedAt;
      if (typeof fetchedAt !== 'string' || !isIsoTimestamp(fetchedAt) || !fetchedAt.startsWith(month)) continue;
      if (Array.isArray(batch.documentDrift)) for (const d of batch.documentDrift) push(d);
    }
  }
  if (Array.isArray(healthDrift)) for (const d of healthDrift) push(d);
  return drift;
}

function mdCell(text: string): string {
  return text.replace(/\|/g, '/');
}

/**
 * Render the meeting-votes, document-drift, and agenda→code cross-reference
 * subsections of the monthly report. Pure: returns the markdown lines, caller
 * owns ordering/blank lines.
 */
export function renderMeetingVotesSection(rows: MeetingVoteRow[], drift: DocumentDrift[], refs: AgendaCodeRef[] = []): string[] {
  const lines: string[] = [];
  lines.push('### 🏛️ Recorded votes');
  lines.push('');
  if (rows.length === 0) {
    lines.push('_No parseable vote tallies were recorded in this month\'s meeting items._');
  } else {
    const passed = rows.filter(r => r.passed).length;
    lines.push(`**${rows.length} vote record${rows.length === 1 ? '' : 's'}** · ${passed} passed · ${rows.length - passed} failed. Extracted from agenda/minutes text by the vote parser — verify against the linked minutes before relying on a tally.`);
    lines.push('');
    lines.push('| Date | Meeting | Yea | Nay | Abstain | Absent | Result |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const row of rows.slice(0, MEETING_VOTE_ROW_LIMIT)) {
      const title = row.link ? `[${mdCell(row.title)}](${row.link})` : mdCell(row.title);
      lines.push(`| ${mdCell(row.date) || '–'} | ${title} | ${row.yea} | ${row.nay} | ${row.abstain} | ${row.absent} | ${row.passed ? 'Passed' : 'Failed'}${row.inferred ? ' (inferred)' : ''} |`);
    }
    if (rows.length > MEETING_VOTE_ROW_LIMIT) lines.push(`_... and ${rows.length - MEETING_VOTE_ROW_LIMIT} more_`);
  }
  lines.push('');
  lines.push('### 📄 Agenda/minutes document drift');
  lines.push('');
  if (drift.length === 0) {
    lines.push('_No agenda/minutes documents were added or changed this month (or drift tracking was unavailable)._');
  } else {
    const changed = drift.filter(d => d.changed).length;
    lines.push(`**${drift.length} document event${drift.length === 1 ? '' : 's'}** · ${changed} changed · ${drift.length - changed} new. SHA-256 over the fetched document text; a changed hash means the source document moved.`);
    lines.push('');
    for (const d of drift.slice(0, MEETING_DRIFT_ROW_LIMIT)) {
      lines.push(`- ${d.changed ? '🔄 Changed' : '🆕 New'}: ${mdCell(d.url)} — ${d.previousHash ? d.previousHash.slice(0, 12) : '–'} → ${d.currentHash.slice(0, 12)}`);
    }
    if (drift.length > MEETING_DRIFT_ROW_LIMIT) lines.push(`_... and ${drift.length - MEETING_DRIFT_ROW_LIMIT} more_`);
  }
  lines.push('');
  lines.push('### 📎 Agenda topics → municipal code');
  lines.push('');
  if (refs.length === 0) {
    lines.push('_No agenda items were cross-referenced to code sections this month._');
  } else {
    const topics = new Set(refs.map(r => r.topic));
    lines.push(`**${refs.length} association${refs.length === 1 ? '' : 's'}** across ${topics.size} agenda topic${topics.size === 1 ? '' : 's'}, via the BM25 index over the scraped municipal code. Topical matches only — not legal advice.`);
    lines.push('');
    for (const ref of refs.slice(0, MEETING_DRIFT_ROW_LIMIT)) {
      const topic = ref.agendaUrl ? `[${mdCell(ref.topic)}](${ref.agendaUrl})` : mdCell(ref.topic);
      lines.push(`- ${topic} → ${mdCell(ref.sectionNumber)} ${mdCell(ref.sectionTitle)} — ${mdCell(ref.articleTitle)}`);
    }
    if (refs.length > MEETING_DRIFT_ROW_LIMIT) lines.push(`_... and ${refs.length - MEETING_DRIFT_ROW_LIMIT} more_`);
  }
  return lines;
}

// ─── Executive digest (LLM connective prose over data-derived metrics) ──

const DIGEST_SYSTEM_PROMPT =
  'You are a civic-data report editor. You will be given ONLY verified numeric metrics. '
  + 'Write 2-4 sentences of neutral connective prose summarizing the month. '
  + 'You MUST NOT introduce any number, date, rate, or quantity that is not given to you verbatim. '
  + 'Plain text only — no headings, bullets, or markdown.';

export const DIGEST_PROMPT_VERSION = '2026-08-26-digest-v1';

function isSafeDigestText(text: string): boolean {
  return typeof text === 'string' && text.trim().length > 0 && !text.includes('```');
}

/** Strip stray markdown/fencing the model may still emit. */
function cleanDigest(raw: string): string {
  return raw.replace(/```[\s\S]*?```/g, '').trim();
}

/**
 * LLM executive digest over collected monthly metrics. Numbers come only
 * from `metrics`; the model writes connective prose between them. Any
 * failure (provider unreachable, timeout, empty output) degrades silently:
 * the caller omits the digest section and the report remains complete.
 */
export async function generateExecutiveDigest(
  metrics: Record<string, number>,
  monthLabel: string,
): Promise<{ prose: string; provider: string; model: string; promptVersion: string } | null> {
  try {
    const metricLines = Object.entries(metrics)
      .filter(([, v]) => Number.isFinite(v))
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');
    if (!metricLines) return null;
    const prompt =
      `Write a brief neutral executive digest (2-4 sentences) for the ${monthLabel} `
      + `civic health report of Crescent City, CA using exactly these metrics:\n${metricLines}`;
    const raw = await Promise.race([
      chatWithProvider([{ role: 'user', content: prompt }], undefined, undefined, {
        systemPrompt: DIGEST_SYSTEM_PROMPT,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('digest timeout')), 20_000)),
    ]);
    const prose = cleanDigest(String(raw));
    if (!isSafeDigestText(prose)) return null;
    return {
      prose,
      provider: llmConfig.provider,
      model: llmConfig.provider === 'openrouter' ? llmConfig.openrouterModel : llmConfig.chatModel,
      promptVersion: DIGEST_PROMPT_VERSION,
    };
  } catch {
    return null; // silent plain-text fallback: section simply omitted
  }
}

// ─── Main ─────────────────────────────────────────────────────────

async function generateMonthlyReport(targetMonth?: string): Promise<void> {
  const now = new Date();
  const period = parseTargetMonth(targetMonth);
  const { month } = period;
  const monthLabel = period.label;
  const warnings: string[] = [];

  logger.info(`Generating monthly civic health report for ${monthLabel}`, { month });

  // ── Load data sources ──────────────────────────────────────────
  const manifestPath = join(process.cwd(), 'output', 'manifest.json');
  const manifest = readJson(manifestPath);

  const readabilityPath = join(process.cwd(), 'output', 'readability.json');
  const readability = readJson(readabilityPath);

  const periodItems = (label: string, records: any[]): any[] => {
    const result = inPeriod(records, period.start, period.end);
    if (result.invalidTimestamps > 0) {
      warnings.push(`${label}: ignored ${result.invalidTimestamps} record(s) with invalid timestamps`);
    }
    return result.items;
  };
  const earthquakes = periodItems('Earthquake history', readJsonl(join(process.cwd(), 'output', 'alerts', 'earthquake', 'history.jsonl')));
  const weather = periodItems('Weather history', readJsonl(join(process.cwd(), 'output', 'alerts', 'weather', 'history.jsonl')));
  const tsunami = periodItems('Tsunami history', readJsonl(join(process.cwd(), 'output', 'alerts', 'tsunami', 'history.jsonl')));
  const airquality = periodItems('Air-quality history', readJsonl(join(process.cwd(), 'output', 'alerts', 'airquality', 'history.jsonl')));
  const wildfire = periodItems('Wildfire history', readJsonl(join(process.cwd(), 'output', 'alerts', 'wildfire', 'history.jsonl')));
  const marine = periodItems('Marine history', readJsonl(join(process.cwd(), 'output', 'alerts', 'marine', 'history.jsonl')));
  const tides = periodItems('Tide history', readJsonl(join(process.cwd(), 'output', 'tides', 'history.jsonl')));
  const fishing = periodItems('Fishing history', readJsonl(join(process.cwd(), 'output', 'fishing', 'history.jsonl')));

  const newsItems = readBatchItems(paths.news, month, item => isActiveNewsSource(item?.source));
  const meetingItems = readBatchItems(paths.govMeetings, month);
  const curatedItems = readBatchItems(paths.curated, month);
  const newsCount = newsItems.length;

  const newsHealth = readJson(paths.newsHealth);
  const meetingHealth = readJson(paths.govMeetingsHealth);
  const youtubeHealth = readJson(paths.youtubeHealth);
  const triplicateHealth = readJson(paths.triplicateHealth);

  const coveragePath = join(process.cwd(), 'output', 'domain-coverage.json');
  const coverage = readJson(coveragePath);

  const healthReports = [newsHealth, meetingHealth, youtubeHealth, triplicateHealth, readJson(paths.alertsHealth)];
  const observedSourceHealth: SourceHealth[] = healthReports.flatMap(report => {
    if (!Array.isArray(report?.sources)) return [];
    return report.sources.filter((source: any) => source && typeof source.source === 'string' &&
      ['ok', 'empty', 'unavailable', 'stale'].includes(source.status) &&
      isIsoTimestamp(source.checkedAt) && Number.isInteger(source.itemCount) && source.itemCount >= 0) as SourceHealth[];
  });
  if (observedSourceHealth.length === 0) warnings.push('No source-health artifacts were available for this report');
  const sourceHealth = completeSourceHealth(observedSourceHealth, now.toISOString());
  const healthSummary = summarizeSourceHealth(sourceHealth, now.toISOString());
  const sourceDiscovery = readJson(paths.sourceDiscovery) ?? await buildSourceDiscoveryReport({
    checkedAt: now.toISOString(),
    health: sourceHealth,
    registry: getSourceRegistry(),
  });
  if (!existsSync(paths.sourceDiscovery)) warnings.push('Source discovery artifact was not available; report used the in-process registry without a persisted check.');

  // ── Build report markdown ────────────────────────────────────
  const lines: string[] = [];

  lines.push(`# Crescent City Civic Health Report — ${monthLabel}`);
  lines.push('');
  lines.push(`> **Generated**: ${now.toISOString()}  `);
  lines.push(`> **Source**: Crescent City Municipal Intelligence System  `);
  lines.push(`> **Period**: ${month}  `);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Section 1: Municipal Code Status ──────────────────────────
  lines.push('## 📋 Municipal Code Status');
  lines.push('');
  if (manifest) {
    lines.push(`| Metric | Value |`);
    lines.push(`|---|---|`);
    lines.push(`| Articles scraped | ${Object.keys(manifest.articles ?? {}).length} |`);
    lines.push(`| Total sections | ${manifest.sectionCount ?? '–'} |`);
    lines.push(`| TOC nodes | ${manifest.tocNodeCount ?? '–'} |`);
    lines.push(`| Last scraped | ${manifest.completedAt ?? manifest.scrapedAt ?? '–'} |`);
    lines.push('');
    // output/readability.json (written by scoreCorpusReadability()) has no
    // top-level `stats` field — its real shape is averageGradeLevel/allScores
    // with per-section score.{gradeLevel,readingEase,difficulty}. The `stats`
    // check below was always false, so this line never rendered in any report.
    if (readability?.averageGradeLevel !== undefined) {
      const scores = readability.allScores as Array<{ score: { readingEase: number; difficulty: string } }> | undefined;
      const avgReadingEase = scores?.length
        ? scores.reduce((sum, s) => sum + s.score.readingEase, 0) / scores.length
        : null;
      const legalCount = scores?.filter(s => s.score.difficulty === 'legal').length ?? null;
      lines.push(`**Readability**: Average grade level ${readability.averageGradeLevel.toFixed(1)} ` +
        `(Flesch ease ${avgReadingEase !== null ? avgReadingEase.toFixed(0) : '–'}/100, ${legalCount ?? '–'} sections at legal difficulty)`);
    }
  } else {
    lines.push('_No scraped data available. Run `bun run scrape` first._');
  }
  lines.push('');

  // ── Section 2: Alert Events ────────────────────────────────────
  lines.push('## 🚨 Alert Events');
  lines.push('');

  // Earthquakes
  lines.push(`### 🌍 Earthquakes (${earthquakes.length} events this month)`);
  if (earthquakes.length > 0) {
    const cascadiaEqs = earthquakes.filter(e => e.cascadia);
    // Guard against null/NaN magnitudes — Math.max over a mixed array yields
    // NaN which would render as "MNaN" in the report.
    const mags = earthquakes.map(e => e.magnitude ?? 0).filter((m): m is number => Number.isFinite(m));
    const maxMag = mags.length > 0 ? Math.max(...mags) : 0;
    lines.push(`- **Max magnitude**: ${fmtMag(maxMag)}`);
    if (cascadiaEqs.length > 0) {
      lines.push(`- **Cascadia Subduction Zone events**: ${cascadiaEqs.length} (${cascadiaEqs.map(e => fmtMag(e.magnitude)).join(', ')})`);
    }
    lines.push('');
    lines.push('| Time | Magnitude | Place | Distance | Cascadia |');
    lines.push('|---|---|---|---|---|');
    for (const eq of earthquakes.slice(0, 10)) {
      lines.push(`| ${eq.time?.substring(0, 16) ?? '–'} | ${fmtMag(eq.magnitude)} | ${eq.place ?? '–'} | ${eq.distanceKm ?? '–'} km | ${eq.cascadia ? '⚠️ Yes' : 'No'} |`);
    }
    if (earthquakes.length > 10) lines.push(`_... and ${earthquakes.length - 10} more_`);
  } else {
    lines.push('_No earthquakes meeting threshold (M4.0+, within 200 km) detected this month._');
  }
  lines.push('');

  // Weather
  lines.push(`### 🌩️ NWS Weather Alerts (${weather.length} events this month)`);
  if (weather.length > 0) {
    const warnings = weather.filter(w => w.severityLevel === 'warning');
    const watches = weather.filter(w => w.severityLevel === 'watch');
    const advisories = weather.filter(w => w.severityLevel === 'advisory');
    lines.push(`- Warnings: **${warnings.length}** · Watches: **${watches.length}** · Advisories: **${advisories.length}**`);
    lines.push('');
    lines.push('| Date | Event | Severity |');
    lines.push('|---|---|---|');
    for (const w of weather.slice(0, 8)) {
      lines.push(`| ${(w.fetchedAt ?? '–').substring(0, 10)} | ${w.event ?? '–'} | ${w.severityLevel ?? '–'} |`);
    }
  } else {
    lines.push('_No NWS weather alerts detected this month._');
  }
  lines.push('');

  // Tsunami
  lines.push(`### 🌊 Tsunami Alerts (${tsunami.length} events this month)`);
  if (tsunami.length > 0) {
    for (const t of tsunami) {
      lines.push(`- **${t.event ?? 'Alert'}** (${t.threatLevel ?? t.severity ?? '–'}): ${t.headline ?? '–'}`);
    }
  } else {
    lines.push('_No tsunami alerts issued this month._ ✅');
  }
  lines.push('');

  // Air Quality
  lines.push(`### 🌫️ Air Quality (${airquality.length} readings this month)`);
  if (airquality.length > 0) {
    const maxAqi = Math.max(...airquality.map(a => a.maxAqi ?? 0));
    const unhealthyDays = airquality.filter(a => (a.maxAqi ?? 0) > 100).length;
    lines.push(`- **Peak AQI**: ${maxAqi} (${(airquality.find(a => a.maxAqi === maxAqi)?.level) ?? '–'})`);
    lines.push(`- **Days with AQI > 100**: ${unhealthyDays}`);
  } else {
    lines.push('_No air quality readings recorded this month._');
  }
  lines.push('');

  // Wildfire
  lines.push(`### 🔥 Wildfire Activity (${wildfire.length} reports this month)`);
  if (wildfire.length > 0) {
    const evacReports = wildfire.filter(w => w.hasEvacuationOrders);
    const totalIncidents = wildfire.reduce((sum, w) => sum + (w.totalIncidents ?? 0), 0);
    lines.push(`- **Total incident reports**: ${totalIncidents}`);
    if (evacReports.length > 0) {
      lines.push(`- ⚠️ **Evacuation orders active**: ${evacReports.length} report(s)`);
    }
  } else {
    lines.push('_No wildfire activity detected in Del Norte region this month._ ✅');
  }
  lines.push('');

  // Marine
  lines.push(`### ⚓ Marine Conditions (${marine.length} buoy readings this month)`);
  if (marine.length > 0) {
    // `marine` rows come from output/alerts/marine/history.jsonl, one flat
    // per-station reading per line (waveHeightFt/windSpeedKt directly on the
    // record) — there is no nested `observations` array on this shape, so
    // `m.observations?.[0]?...` was always undefined regardless of real data.
    // Separately, Math.max(...[]) is -Infinity when every reading's wave/wind
    // field is null (buoy stations frequently report null wave height —
    // confirmed live this session), so the positive-values array can still
    // legitimately end up empty even after reading the right field.
    const waveValues = marine.map((m: any) => m.waveHeightFt ?? 0).filter(v => v > 0);
    const windValues = marine.map((m: any) => m.windSpeedKt ?? 0).filter(v => v > 0);
    const maxWaves = waveValues.length > 0 ? Math.max(...waveValues) : null;
    const maxWind = windValues.length > 0 ? Math.max(...windValues) : null;
    const advisories = marine.filter(m => m.advisory);
    lines.push(`- **Peak wave height**: ${maxWaves !== null ? maxWaves.toFixed(1) + ' ft' : 'no data'}`);
    lines.push(`- **Peak wind speed**: ${maxWind !== null ? maxWind.toFixed(0) + ' kt' : 'no data'}`);
    lines.push(`- **Marine advisories issued**: ${advisories.length}`);
  } else {
    lines.push('_No marine buoy readings recorded this month._');
  }
  lines.push('');

  // Tides
  lines.push(`### 🌊 Tides (${tides.length} readings this month)`);
  if (tides.length > 0) {
    const peak = tides.reduce((best, t) => Math.max(best, Number(t.maxPredictedLevel) || 0), 0);
    const highTideAlerts = tides.filter(t => t.highTideAlert === true || t.level === 'WARNING').length;
    lines.push(`- **Peak predicted level**: ${peak > 0 ? peak.toFixed(1) + ' ft MLLW' : 'no data'}`);
    lines.push(`- **High-tide alert days (≥7.0 ft MLLW surge)**: ${highTideAlerts}`);
  } else {
    lines.push('_No tide readings recorded this month._');
  }
  lines.push('');

  // Fishing
  lines.push(`### 🦀 Dungeness Crab Season (${fishing.length} reports this month)`);
  if (fishing.length > 0) {
    const closureReports = fishing.filter(f => f.level === 'WATCH' || f.crabCommercialOpen === false || f.crabRecreationalOpen === false);
    lines.push(`- **Closure/watch reports**: ${closureReports.length}`);
    const latest = fishing[fishing.length - 1];
    lines.push(`- **Latest status**: ${latest?.summary ?? '–'}`);
  } else {
    lines.push('_No fishing monitor reports recorded this month._');
  }
  lines.push('');

  // ── Section 3: News Summary ───────────────────────────────────
  lines.push('## 📰 News Monitor');
  lines.push('');
  lines.push(`- **Relevant articles this month**: ${newsCount}`);
  lines.push(`- **Government meeting items this month**: ${meetingItems.length}`);
  lines.push(`- **Curated items this month**: ${curatedItems.length}`);
  lines.push(`- **Discovered source registry**: ${sourceDiscovery.sourceCount ?? 0} sources (${sourceDiscovery.monitoredCount ?? 0} monitored, ${sourceDiscovery.discoveryOnlyCount ?? 0} discovery-only, ${sourceDiscovery.referenceOnlyCount ?? 0} reference-only)`);
  const healthLine = (label: string, report: any): string => {
    const sources = Array.isArray(report?.sources) ? report.sources : [];
    if (sources.length === 0) return `- **${label} source health**: no health artifact`;
    const counts = sources.reduce((acc: Record<string, number>, source: any) => {
      const status = source?.status ?? 'unavailable';
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {});
    return `- **${label} source health**: ${Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ')}`;
  };
  lines.push(healthLine('News', newsHealth));
  lines.push(healthLine('Meetings', meetingHealth));
  lines.push(healthLine('YouTube', youtubeHealth));
  lines.push(healthLine('Triplicate', triplicateHealth));
  if (newsItems.length > 0) {
    lines.push('');
    lines.push('### Recent news');
    for (const item of newsItems.slice(0, 5)) {
      lines.push(`- [${item.title}](${item.link}) — ${item.source ?? 'unknown source'}`);
    }
  }
  if (curatedItems.length > 0) {
    lines.push('');
    lines.push('### Curated highlights');
    lines.push('_Provider-generated summaries are source-grounded briefs, not independent reporting. Follow the cited source before relying on a claim._');
    for (const item of curatedItems.slice(0, 5)) {
      const summary = String(item.summary ?? item.sourceExcerpt ?? 'No summary available').replace(/\s+/g, ' ').trim();
      const title = item.link ? `[${item.title ?? 'Untitled'}](${item.link})` : `**${item.title ?? 'Untitled'}**`;
      const provider = item.provider && item.model ? ` · provider: ${item.provider}/${item.model}` : '';
      lines.push(`- ${title} — ${summary} · source: ${item.source ?? 'unknown'}${provider}`);
    }
  }
  if (meetingHealth?.sources) {
    const unavailableMeetings = meetingHealth.sources.filter((s: any) => s.status === 'unavailable').map((s: any) => s.source);
    if (unavailableMeetings.length) lines.push(`- **Meeting sources unavailable**: ${unavailableMeetings.join(', ')}`);
  }
  lines.push('');
  const meetingVoteRows = buildMeetingVoteRows(meetingItems);
  const meetingDrift = collectDocumentDrift(paths.govMeetings, month, meetingHealth?.documentDrift);
  let agendaCodeRefs: AgendaCodeRef[] = [];
  try {
    agendaCodeRefs = await crossReferenceAgendaTopics(
      meetingItems.flatMap(item => (Array.isArray(item?.agendaItems) ? item.agendaItems : [])),
    );
  } catch (error: unknown) {
    warnings.push(`Agenda cross-reference failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  lines.push(...renderMeetingVotesSection(meetingVoteRows, meetingDrift, agendaCodeRefs));
  lines.push('');

  // ── Section 4: Intelligence Domain Coverage ────────────────────
  lines.push('## 🧠 Intelligence Domain Coverage');
  lines.push('');
  if (coverage?.domains) {
    lines.push(`**Overall coverage**: ${coverage.overallCoveragePct?.toFixed(1) ?? '–'}% of ${coverage.totalSections ?? '–'} sections`);
    lines.push('');
    // coverage.domains rows come from output/domain-coverage.json (written by
    // computeDomainCoverage()), whose real fields are domainName/referencedCount
    // — not name/matchedSections, which this table was reading before (always
    // undefined). topicCount isn't part of that report at all; look it up from
    // the static domains list this file already imports.
    const topicCountById = new Map(domains.map(d => [d.id, d.topics.length]));
    lines.push('| Domain | Topics | Matched Sections | Coverage % |');
    lines.push('|---|---|---|---|');
    for (const d of coverage.domains) {
      const topicCount = topicCountById.get(d.domainId) ?? '–';
      lines.push(`| ${d.domainName} | ${topicCount} | ${d.referencedCount} | ${d.coveragePct?.toFixed(1) ?? '–'}% |`);
    }
  } else {
    const totalTopics = domains.reduce((sum, d) => sum + d.topics.length, 0);
    lines.push(`**${domains.length} domains** · **${totalTopics} topics** tracked`);
    lines.push('_Run `bun run coverage` to compute section-level coverage metrics._');
  }
  lines.push('');

  // ── Section 5: System Health ──────────────────────────────────
  lines.push('## ⚙️ System Health');
  lines.push('');
  lines.push(`- **Report generated**: ${now.toISOString()}`);
  lines.push(`- **Data freshness**: ${manifest?.completedAt ?? 'Scrape not yet run'}`);
  lines.push(`- **Report status**: ${manifest ? 'ok' : 'unavailable'}`);
  lines.push(`- **Source coverage**: ${healthSummary.present}/${healthSummary.total} checks have an established current state (${healthSummary.coveragePercent}%); ${healthSummary.missing} unavailable or stale`);
  lines.push(`- **News health artifact**: ${existsSync(paths.newsHealth) ? paths.newsHealth : 'not generated'}`);
  lines.push(`- **Meeting health artifact**: ${existsSync(paths.govMeetingsHealth) ? paths.govMeetingsHealth : 'not generated'}`);
  lines.push(`- **YouTube health artifact**: ${existsSync(paths.youtubeHealth) ? paths.youtubeHealth : 'not generated'}`);
  lines.push(`- **Triplicate health artifact**: ${existsSync(paths.triplicateHealth) ? paths.triplicateHealth : 'not generated'}`);
  lines.push(`- **Alert health artifact**: ${existsSync(paths.alertsHealth) ? paths.alertsHealth : 'not generated'}`);
  lines.push(`- **Source registry artifact**: ${existsSync(paths.sourceRegistry) ? paths.sourceRegistry : 'not generated'}`);
  lines.push(`- **Source discovery artifact**: ${existsSync(paths.sourceDiscovery) ? paths.sourceDiscovery : 'not generated'}`);
  if (Array.isArray(sourceDiscovery.coverageGaps) && sourceDiscovery.coverageGaps.length > 0) {
    lines.push('');
    lines.push('### Known source-coverage gaps');
    for (const gap of sourceDiscovery.coverageGaps) lines.push(`- ${gap}`);
  }
  lines.push('- Run `bun run verify` to check data integrity');
  lines.push('- Run `bun run coverage` to refresh domain coverage');
  lines.push('- Run `bun run readability` to refresh readability metrics');
  if (warnings.length > 0) {
    lines.push('');
    lines.push('### Report warnings');
    for (const warning of warnings) lines.push(`- ${warning}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_Report generated by [Crescent City Intelligence Platform](https://github.com/docxology/crescent-city-intel)_');

  // ── Executive digest (LLM connective prose over verified metrics) ──
  const digest = await generateExecutiveDigest({
    earthquakes: earthquakes.length,
    weatherAlerts: weather.length,
    tsunamiAlerts: tsunami.length,
    airQualityReadings: airquality.length,
    wildfireReports: wildfire.length,
    marineReadings: marine.length,
    newsItems: newsCount,
    meetingItems: meetingItems.length,
    curatedItems: curatedItems.length,
    discoveredSources: Number(sourceDiscovery.sourceCount ?? 0),
    monitoredSources: Number(sourceDiscovery.monitoredCount ?? 0),
    meetingVotes: meetingVoteRows.length,
  }, monthLabel);
  if (digest) {
    lines.push('');
    lines.push('## 🗞️ Executive Digest');
    lines.push('');
    lines.push(`_LLM-generated connective prose over verified metrics (provider ${digest.provider}/${digest.model}). All figures above this note are data-derived._`);
    lines.push('');
    lines.push(digest.prose);
  } else {
    warnings.push('Executive digest was unavailable (LLM provider unreachable or timed out); report continues without it.');
  }

  // ── Write to file ────────────────────────────────────────────
  const reportPath = join(REPORTS_DIR, `monthly-${month}.md`);
  const metadataPath = join(REPORTS_DIR, `monthly-${month}.json`);
  const reportStatus: MonthlyReportMetadata['status'] = !manifest ? 'unavailable' : 'ok';
  const metadata: MonthlyReportMetadata = {
    schemaVersion: '1.0.0',
    reportType: 'monthly-civic-health',
    period: month,
    generatedAt: now.toISOString(),
    periodStart: period.start.toISOString(),
    periodEnd: period.end.toISOString(),
    status: reportStatus,
    metrics: {
      codeArticles: Object.keys(manifest?.articles ?? {}).length,
      codeSections: Number(manifest?.sectionCount ?? 0),
      earthquakes: earthquakes.length,
      weatherAlerts: weather.length,
      tsunamiAlerts: tsunami.length,
      airQualityReadings: airquality.length,
      wildfireReports: wildfire.length,
      marineReadings: marine.length,
      newsItems: newsCount,
      meetingItems: meetingItems.length,
      curatedItems: curatedItems.length,
      meetingVoteRecords: meetingVoteRows.length,
      changedMeetingDocuments: meetingDrift.filter(d => d.changed).length,
      agendaCodeRefs: agendaCodeRefs.length,
      discoveredSources: Number(sourceDiscovery.sourceCount ?? 0),
      monitoredSources: Number(sourceDiscovery.monitoredCount ?? 0),
      discoveryOnlySources: Number(sourceDiscovery.discoveryOnlyCount ?? 0),
      referenceOnlySources: Number(sourceDiscovery.referenceOnlyCount ?? 0),
    },
    sourceHealth: healthSummary,
    sourceDiscovery: {
      registryFingerprint: String(sourceDiscovery.registryFingerprint ?? ''),
      sourceCount: Number(sourceDiscovery.sourceCount ?? 0),
      monitoredCount: Number(sourceDiscovery.monitoredCount ?? 0),
      discoveryOnlyCount: Number(sourceDiscovery.discoveryOnlyCount ?? 0),
      referenceOnlyCount: Number(sourceDiscovery.referenceOnlyCount ?? 0),
      coverageGaps: Array.isArray(sourceDiscovery.coverageGaps) ? sourceDiscovery.coverageGaps : [],
    },
    artifacts: { markdown: reportPath, metadata: metadataPath },
    warnings,
  };
  await writeTextAtomic(reportPath, `${lines.join('\n')}\n`);
  await writeJsonAtomic(metadataPath, metadata);
  if (month === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`) {
    await writeJsonAtomic(paths.latestReportMetadata, metadata);
  }

  logger.info(`Monthly report written to ${reportPath}`, {
    earthquakes: earthquakes.length,
    weather: weather.length,
    tsunami: tsunami.length,
    month,
    reportStatus,
    metadataPath,
  });

  console.log(`\n✅ Report: ${reportPath}`);
  console.log(`   Earthquake events: ${earthquakes.length}`);
  console.log(`   Weather alerts:    ${weather.length}`);
  console.log(`   Tsunami alerts:    ${tsunami.length}`);
  console.log(`   Air quality:       ${airquality.length}`);
  console.log(`   Wildfire reports:  ${wildfire.length}`);
  console.log(`   Marine readings:   ${marine.length}`);
}

// ─── Entry point ──────────────────────────────────────────────────
if (import.meta.main) {
  const targetMonth = process.argv[2]; // e.g. "2026-02"
  generateMonthlyReport(targetMonth).catch(err => {
    logger.error('Monthly report generation failed', { error: String(err) });
    process.exit(1);
  });
}

export { generateMonthlyReport };
