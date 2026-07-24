#!/usr/bin/env bun
/**
 * Monthly Civic Health Report Generator
 *
 * Auto-generates output/reports/monthly-YYYY-MM.md summarizing:
 *   - Municipal code stats (sections, words, readability)
 *   - Alert events for the month (earthquake, weather, tsunami)
 *   - Meeting monitor activity
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
import { isIsoTimestamp, writeTextAtomic } from './shared/source_health.js';

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
function inMonth(records: any[], month: string): any[] {
  return records.filter(r => {
    const ts = r.fetchedAt ?? r.time ?? r.scrapedAt ?? '';
    return isIsoTimestamp(ts) && ts.startsWith(month);
  });
}

function readBatchItems(dir: string, month: string): any[] {
  if (!existsSync(dir)) return [];
  const items: any[] = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const batch = readJson(join(dir, file));
    if (Array.isArray(batch)) {
      items.push(...batch.filter(item => {
        const ts = item?.curatedAt ?? item?.fetchedAt ?? '';
        return isIsoTimestamp(ts) && ts.startsWith(month);
      }));
      continue;
    }
    if (!batch || !isIsoTimestamp(batch.fetchedAt) || !batch.fetchedAt.startsWith(month)) continue;
    if (Array.isArray(batch.items)) items.push(...batch.items);
  }
  return items;
}

/** Format a magnitude as M4.2 */
const fmtMag = (m: number) => `M${m.toFixed(1)}`;

// ─── Main ─────────────────────────────────────────────────────────

async function generateMonthlyReport(targetMonth?: string): Promise<void> {
  const now = new Date();
  const month = targetMonth ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [year, monthNum] = month.split('-');
  // `new Date("YYYY-MM-01")` parses as UTC midnight; toLocaleDateString then
  // renders it in the local timezone, which rolls back to the previous month
  // for any timezone behind UTC (e.g. US Pacific: July 2026 displayed as
  // "June 2026"). Constructing with explicit numeric args parses in local
  // time instead, avoiding the UTC/local day-boundary mismatch.
  const monthLabel = new Date(Number(year), Number(monthNum) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  logger.info(`Generating monthly civic health report for ${monthLabel}`, { month });

  // ── Load data sources ──────────────────────────────────────────
  const manifestPath = join(process.cwd(), 'output', 'manifest.json');
  const manifest = readJson(manifestPath);

  const readabilityPath = join(process.cwd(), 'output', 'readability.json');
  const readability = readJson(readabilityPath);

  const earthquakes = inMonth(readJsonl(join(process.cwd(), 'output', 'alerts', 'earthquake', 'history.jsonl')), month);
  const weather = inMonth(readJsonl(join(process.cwd(), 'output', 'alerts', 'weather', 'history.jsonl')), month);
  const tsunami = inMonth(readJsonl(join(process.cwd(), 'output', 'alerts', 'tsunami', 'history.jsonl')), month);
  const airquality = inMonth(readJsonl(join(process.cwd(), 'output', 'alerts', 'airquality', 'history.jsonl')), month);
  const wildfire = inMonth(readJsonl(join(process.cwd(), 'output', 'alerts', 'wildfire', 'history.jsonl')), month);
  const marine = inMonth(readJsonl(join(process.cwd(), 'output', 'alerts', 'marine', 'history.jsonl')), month);

  const newsItems = readBatchItems(paths.news, month);
  const meetingItems = readBatchItems(paths.govMeetings, month);
  const curatedItems = readBatchItems(paths.curated, month);
  const newsCount = newsItems.length;

  const newsHealth = readJson(paths.newsHealth);
  const meetingHealth = readJson(paths.govMeetingsHealth);
  const youtubeHealth = readJson(paths.youtubeHealth);
  const triplicateHealth = readJson(paths.triplicateHealth);

  const coveragePath = join(process.cwd(), 'output', 'domain-coverage.json');
  const coverage = readJson(coveragePath);

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
    const maxMag = Math.max(...earthquakes.map(e => e.magnitude));
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

  // ── Section 3: News Summary ───────────────────────────────────
  lines.push('## 📰 News Monitor');
  lines.push('');
  lines.push(`- **Relevant articles this month**: ${newsCount}`);
  lines.push(`- **Government meeting items this month**: ${meetingItems.length}`);
  lines.push(`- **Curated items this month**: ${curatedItems.length}`);
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
  lines.push(`- **News health artifact**: ${existsSync(paths.newsHealth) ? paths.newsHealth : 'not generated'}`);
  lines.push(`- **Meeting health artifact**: ${existsSync(paths.govMeetingsHealth) ? paths.govMeetingsHealth : 'not generated'}`);
  lines.push(`- **YouTube health artifact**: ${existsSync(paths.youtubeHealth) ? paths.youtubeHealth : 'not generated'}`);
  lines.push(`- **Triplicate health artifact**: ${existsSync(paths.triplicateHealth) ? paths.triplicateHealth : 'not generated'}`);
  lines.push(`- **Alert health artifact**: ${existsSync(paths.alertsHealth) ? paths.alertsHealth : 'not generated'}`);
  lines.push('- Run `bun run verify` to check data integrity');
  lines.push('- Run `bun run coverage` to refresh domain coverage');
  lines.push('- Run `bun run readability` to refresh readability metrics');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_Report generated by [Crescent City Intelligence Platform](https://github.com/docxology/crescent-city-intel)_');

  // ── Write to file ────────────────────────────────────────────
  const reportPath = join(REPORTS_DIR, `monthly-${month}.md`);
  await writeTextAtomic(reportPath, `${lines.join('\n')}\n`);

  logger.info(`Monthly report written to ${reportPath}`, {
    earthquakes: earthquakes.length,
    weather: weather.length,
    tsunami: tsunami.length,
    month,
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
