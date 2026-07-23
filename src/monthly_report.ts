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
 * Reads from existing output/alerts/*/history.jsonl and news/seen-ids.json.
 * No live network calls — summarizes already-scraped local data.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from './logger.js';
import { domains } from './domains.js';

const logger = createLogger('monthly-report');

const REPORTS_DIR = join(process.cwd(), 'output', 'reports');

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
    return typeof ts === 'string' && ts.startsWith(month);
  });
}

/** Format a magnitude as M4.2 */
const fmtMag = (m: number) => `M${m.toFixed(1)}`;

// ─── Main ─────────────────────────────────────────────────────────

async function generateMonthlyReport(targetMonth?: string): Promise<void> {
  const now = new Date();
  const month = targetMonth ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [year, monthNum] = month.split('-');
  const monthLabel = new Date(`${month}-01`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

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

  const seenNews = readJson(join(process.cwd(), 'output', 'news', 'seen-ids.json'));
  const newsCount = seenNews ? Object.keys(seenNews).length : 0;

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
    if (readability?.stats) {
      const s = readability.stats;
      lines.push(`**Readability**: Average grade level ${s.avgGradeLevel?.toFixed(1) ?? '–'} ` +
        `(Flesch ease ${s.avgReadingEase?.toFixed(0) ?? '–'}/100, ${s.distribution?.legal ?? '–'} sections at legal difficulty)`);
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
    const maxWaves = Math.max(...marine.map(m => m.observations?.[0]?.waveHeightFt ?? 0).filter(v => v > 0));
    const maxWind = Math.max(...marine.map(m => m.observations?.[0]?.windSpeedKt ?? 0).filter(v => v > 0));
    const advisories = marine.filter(m => m.advisory);
    lines.push(`- **Peak wave height**: ${maxWaves.toFixed(1)} ft`);
    lines.push(`- **Peak wind speed**: ${maxWind.toFixed(0)} kt`);
    lines.push(`- **Marine advisories issued**: ${advisories.length}`);
  } else {
    lines.push('_No marine buoy readings recorded this month._');
  }
  lines.push('');

  // ── Section 3: News Summary ───────────────────────────────────
  lines.push('## 📰 News Monitor');
  lines.push('');
  lines.push(`- **Total tracked articles**: ${newsCount} (cumulative)`);
  lines.push('- _For detailed article list, see `output/news/seen-ids.json`_');
  lines.push('');

  // ── Section 4: Intelligence Domain Coverage ────────────────────
  lines.push('## 🧠 Intelligence Domain Coverage');
  lines.push('');
  if (coverage?.domains) {
    lines.push(`**Overall coverage**: ${coverage.overallCoveragePct?.toFixed(1) ?? '–'}% of ${coverage.totalSections ?? '–'} sections`);
    lines.push('');
    lines.push('| Domain | Topics | Matched Sections | Coverage % |');
    lines.push('|---|---|---|---|');
    for (const d of coverage.domains) {
      lines.push(`| ${d.name} | ${d.topicCount} | ${d.matchedSections} | ${d.coveragePct?.toFixed(1) ?? '–'}% |`);
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
  lines.push('- Run `bun run verify` to check data integrity');
  lines.push('- Run `bun run coverage` to refresh domain coverage');
  lines.push('- Run `bun run readability` to refresh readability metrics');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_Report generated by [Crescent City Intelligence Platform](https://github.com/docxology/crescent-city-intel)_');

  // ── Write to file ────────────────────────────────────────────
  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, `monthly-${month}.md`);
  writeFileSync(reportPath, lines.join('\n'), 'utf-8');

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
