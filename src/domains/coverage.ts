/**
 * Domain coverage metrics — computes the percentage of municipal code sections
 * cross-referenced by each intelligence domain.
 *
 * Usage:
 *   bun run src/domains/coverage.ts
 *   import { computeDomainCoverage } from './src/domains/coverage.ts';
 *
 * Output: output/domain-coverage.json
 */
import { createLogger } from "../logger.js";
import { domains } from "../domains.js";
import { loadAllSections } from "../shared/data.js";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const logger = createLogger("domain-coverage");

export interface DomainCoverageEntry {
  domainId: string;
  domainName: string;
  referencedSectionNumbers: string[];
  /** Number of unique sections referenced by this domain */
  referencedCount: number;
  /** % of all sections cross-referenced by this domain */
  coveragePct: number;
}

export interface CoverageReport {
  computedAt: string;
  totalSections: number;
  /** Sections covered by at least one domain */
  coveredSections: number;
  /** % of all sections covered by at least one domain */
  overallCoveragePct: number;
  domains: DomainCoverageEntry[];
}

/**
 * Compute how many scraped sections each domain's topics reference.
 * Matches by section number prefix (§ stripped, normalized).
 */
export async function computeDomainCoverage(): Promise<CoverageReport> {
  logger.info("Computing domain coverage metrics...");

  const sections = await loadAllSections();
  const totalSections = sections.length;

  // Build a fast lookup: normalized section numbers
  const sectionNumbers = new Set(
    sections.map(s => s.number.replace(/§\s*/, "").trim().toLowerCase())
  );

  const globalCovered = new Set<string>();
  const domainEntries: DomainCoverageEntry[] = [];

  /**
   * Return the actual scraped section numbers that match a ref (exact, or a
   * "17.04" prefix matching "17.04.010"). This counts SECTIONS, not refs — a
   * single ref like "17.04" that matches 40 real sections must contribute 40
   * to coverage, not 1 (the prior behavior under-reported coverage).
   */
  function matchingSections(ref: string): Set<string> {
    const out = new Set<string>();
    for (const sn of sectionNumbers) {
      if (sn === ref || sn.startsWith(ref + ".") || sn.startsWith(ref + " ")) out.add(sn);
    }
    return out;
  }

  for (const domain of domains) {
    const refs = new Set<string>();

    for (const topic of domain.topics) {
      for (const src of topic.sources) {
        const num = src.sectionNumber.replace(/§\s*/, "").trim().toLowerCase();
        refs.add(num);
      }
    }

    // Expand every ref to the set of ACTUAL sections it covers.
    const coveredSections = new Set<string>();
    for (const ref of refs) {
      for (const sn of matchingSections(ref)) {
        coveredSections.add(sn);
        globalCovered.add(sn);
      }
    }

    const coveragePct =
      totalSections > 0 ? Math.round((coveredSections.size / totalSections) * 10000) / 100 : 0;

    domainEntries.push({
      domainId: domain.id,
      domainName: domain.name,
      referencedSectionNumbers: [...coveredSections].sort(),
      referencedCount: coveredSections.size,
      coveragePct,
    });
  }

  // Sort by coverage descending
  domainEntries.sort((a, b) => b.coveragePct - a.coveragePct);

  const coveredCount = globalCovered.size;

  const overallCoveragePct =
    totalSections > 0 ? Math.round((coveredCount / totalSections) * 10000) / 100 : 0;

  const report: CoverageReport = {
    computedAt: new Date().toISOString(),
    totalSections,
    coveredSections: coveredCount,
    overallCoveragePct,
    domains: domainEntries,
  };

  await mkdir("output", { recursive: true });
  const outPath = join("output", "domain-coverage.json");
  await writeFile(outPath, JSON.stringify(report, null, 2));

  logger.info(
    `Domain coverage: ${coveredCount}/${totalSections} sections (${overallCoveragePct}%) covered by at least one domain`
  );
  for (const d of domainEntries) {
    logger.info(`  ${d.domainName}: ${d.referencedCount} sections (${d.coveragePct}%)`);
  }

  return report;
}

// CLI entry point
if (import.meta.main) {
  computeDomainCoverage().catch((err: any) => {
    logger.error("Coverage computation failed", { error: err.message });
    process.exit(1);
  });
}

// ─── Coverage gap scoring (Round 2, additive) ───────────────────────────
//
// Signal-level gaps complement the section-coverage metrics above: a domain
// can reference plenty of code sections yet have stale news while its hazard
// alerts keep firing — exactly the "alerts present but news stale" blind spot.
// Pure functions only; insights.ts feeds these into its report payload.

export interface DomainGapInput {
  domainId: string;
  /** Alert monitor events recorded in the recent window (live signal). */
  alertEvents: number;
  /** News items recorded in the recent window. */
  newsCount: number;
  /** Epoch ms of the newest recent news item; null when none. */
  latestNewsAtMs: number | null;
  /** Meeting items referencing the domain in the recent window. */
  meetingsCount: number;
  /** Epoch ms the snapshot is evaluated at. */
  checkedAtMs: number;
}

/** Days without fresh news before a live-alert domain counts as news-stale. */
export const GAP_NEWS_STALE_DAYS = 14;

export interface DomainCoverageGap {
  domainId: string;
  /** Machine-readable gap class from GAP_REASON_* */
  kind: string;
  /** Deterministic severity score (0 excluded); higher = more urgent. */
  score: number;
  detail: string;
}

export const GAP_REASON_NEWS_STALE = "news-stale-while-alerts-active";
export const GAP_REASON_NO_RECENT_ITEMS = "no-recent-coverage";
export const GAP_REASON_MEETING_REFERENCE_ONLY = "meeting-reference-without-news";

/**
 * Score per-domain signal coverage gaps over a flat value scale:
 *   0          no gap worth reporting
 *   1..39      meeting-reference-only (the domain surfaced in proceedings but never in news)
 *   40..79     no recent items at all
 *   80..100    alerts firing while news has gone stale (most actionable)
 * The exact integer is deterministic from input ages so callers and tests can
 * assert on it; empty alert feeds NEVER manufacture urgency by themselves.
 */
export function scoreDomainCoverageGaps(inputs: DomainGapInput[]): DomainCoverageGap[] {
  const gaps: DomainCoverageGap[] = [];
  for (const input of inputs) {
    if (input.alertEvents > 0) {
      const daysSilent = input.latestNewsAtMs === null
        ? Number.POSITIVE_INFINITY
        : (input.checkedAtMs - input.latestNewsAtMs) / (24 * 60 * 60 * 1000);
      if (!Number.isFinite(daysSilent) || daysSilent > GAP_NEWS_STALE_DAYS) {
        const ageComponent = Number.isFinite(daysSilent)
          ? Math.min(20, Math.round((daysSilent - GAP_NEWS_STALE_DAYS) * 2))
          : 20;
        gaps.push({
          domainId: input.domainId,
          kind: GAP_REASON_NEWS_STALE,
          score: 80 + ageComponent,
          detail: Number.isFinite(daysSilent)
            ? `${input.alertEvents} alert event(s) recorded but the latest news item is ${Math.floor(daysSilent)} day(s) old`
            : `${input.alertEvents} alert event(s) recorded but no news item exists in the recent window`,
        });
        continue;
      }
    }
    if (input.newsCount === 0 && input.meetingsCount === 0 && input.alertEvents === 0) {
      gaps.push({
        domainId: input.domainId,
        kind: GAP_REASON_NO_RECENT_ITEMS,
        score: 40,
        detail: "No alerts, news, or meeting references recorded for this domain in the recent window",
      });
      continue;
    }
    if (input.newsCount === 0 && input.meetingsCount > 0) {
      gaps.push({
        domainId: input.domainId,
        kind: GAP_REASON_MEETING_REFERENCE_ONLY,
        score: 25,
        detail: `Referenced in ${input.meetingsCount} recent proceeding(s) but absent from recent news`,
      });
    }
  }
  return gaps.sort((a, b) => b.score - a.score || a.domainId.localeCompare(b.domainId));
}
