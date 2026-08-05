#!/usr/bin/env bun
/**
 * LifeOS / Pulse bridge — writes the LocalIntelligence digest consumed by the
 * Pulse LOCAL tab from THIS platform's real outputs (news digests, government
 * meetings, alert history, municipal-code stats).
 *
 * The digest follows the schema of `~/.claude/skills/LocalIntelligence/
 * Tools/Types.ts` (sections of {items, source_status, errors?} + meta), and is
 * written to BOTH `latest.json` paths the Pulse module reads (the
 * customizations path first, the memory/data path second) plus the dated file
 * `<date>_crescent-city_ca_digest.json`.
 *
 * Section mapping from repo outputs:
 *   news        <- output/news/news-*.json (latest digest)
 *   officials   <- output/gov_meetings/gov_meetings-*.json (City Council)
 *   legislation <- output/gov_meetings/*.json (Planning/Harbor commissions)
 *   construction/crime/business/elections/arrests -> empty (this platform does
 *   not produce that data; Pulse renders graceful empty states for them).
 *
 * meta.overview carries the composite alert level + municipal-code section
 * count so the LOCAL tab reflects platform state even in empty sections.
 *
 * Directories overridable for tests: LIFEOS_CUSTOMIZATIONS_DIR,
 * LIFEOS_DATA_DIR, REPO_OUTPUT_DIR. Never throws: missing output dirs yield
 * empty sections, not a crash.
 */
import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface LifeosItem {
  title: string;
  source: string;
  url: string;
  date: string;
  summary?: string;
}
export type LifeosSection = {
  items: LifeosItem[];
  source_status: "ok" | "unavailable" | "empty";
  errors?: string[];
};
export interface LifeosDigest {
  meta: {
    city: string;
    state: string;
    county?: string;
    zip?: string;
    region?: string;
    generated_at: string;
    sources_used: string[];
    sources_failed: string[];
    errors: string[];
    platform?: string;
    overview?: string;
  };
  construction: LifeosSection;
  crime: LifeosSection;
  business: LifeosSection;
  officials: LifeosSection;
  legislation: LifeosSection;
  elections: LifeosSection;
  arrests: LifeosSection;
  news: LifeosSection;
}

export function emptySection(): LifeosSection {
  return { items: [], source_status: "empty" };
}

function toLifeosItem(item: {
  title?: string;
  link?: string;
  pubDate?: string;
  date?: string;
  source?: string;
  content?: string;
}): LifeosItem | null {
  const title = (item.title ?? "").trim();
  const url = (item.link ?? "").trim();
  if (!title || !url) return null;
  return {
    title,
    source: (item.source ?? "crescent-city-intel").trim(),
    url,
    date: (item.pubDate ?? item.date ?? "").trim() || new Date().toISOString(),
    ...((item.content ?? "").trim() ? { summary: item.content!.trim().slice(0, 240) } : {}),
  };
}

/** Read the most recently modified JSON file in `dir` whose name starts with `prefix`. */
export async function loadLatestJson<T>(dir: string, prefix: string): Promise<T | null> {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith(".json"))
    .map(f => join(dir, f))
    .sort((a, b) => (a < b ? -1 : 1));
  if (candidates.length === 0) return null;
  try {
    return JSON.parse(await readFile(candidates[candidates.length - 1], "utf8")) as T;
  } catch {
    return null;
  }
}

/** Pure digest builder from this platform's outputs. Exported for tests. */
export async function buildDigest(options: {
  outputDir: string;
  generatedAt?: string;
}): Promise<LifeosDigest> {
  const { outputDir, generatedAt = new Date().toISOString() } = options;

  const newsDigest = await loadLatestJson<{ items?: Array<{ title: string; link: string; pubDate: string; content?: string; source?: string }> }>(join(outputDir, "news"), "news-");
  const meetings = await loadLatestJson<{ items?: Array<{ title: string; link: string; date: string; content?: string; source?: string }> }>(join(outputDir, "gov_meetings"), "gov_meetings-");

  const newsItems = (newsDigest?.items ?? []).map(toLifeosItem).filter((x): x is LifeosItem => x !== null);
  const meetingItems = (meetings?.items ?? []).map(toLifeosItem).filter((x): x is LifeosItem => x !== null);
  const officials = meetingItems.filter(m => /city council/i.test(m.source));
  const legislation = meetingItems.filter(m => /planning|harbor|commission/i.test(m.source));

  // Platform state: composite alert level + municipal-code section count.
  // Coverage is REGIONAL — the North Coast (Del Norte + Humboldt) — anchored on
  // Crescent City, not Crescent City only.
  let overview = "North Coast intelligence platform (crescent-city-intel) — anchors Crescent City, Del Norte County; covers Del Norte + Humboldt news, meetings, and alerts";
  try {
    const compositePath = join(outputDir, "alerts", "composite", "current.json");
    if (existsSync(compositePath)) {
      const composite = JSON.parse(await readFile(compositePath, "utf8"));
      overview += ` · composite alert: ${composite.level ?? "unknown"}` + (composite.reason ? ` (${composite.reason.slice(0, 80)})` : "");
    }
    const manifestPath = join(outputDir, "manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const sectionCount = manifest.sectionCount ?? manifest.articlePageCount ?? (Array.isArray(manifest.articles) ? manifest.articles.length : null);
      overview += ` · municipal code: ${sectionCount ?? "n/a"} sections`;
    }
  } catch { /* overview is best-effort */ }

  const used = [
    "crescent-city-intel:news (regional Del Norte + Humboldt feeds)",
    "crescent-city-intel:gov_meetings (Crescent City council/commissions)",
    "crescent-city-intel:alerts (Del Norte coast)",
  ];

  return {
    meta: {
      city: "Crescent City",
      state: "CA",
      county: "Del Norte",
      zip: "95531",
      region: "North Coast (Del Norte + Humboldt)",
      generated_at: generatedAt,
      sources_used: used,
      sources_failed: [],
      errors: [],
      platform: "crescent-city-intel",
      overview,
    },
    construction: emptySection(),
    crime: emptySection(),
    business: emptySection(),
    officials: { items: officials, source_status: officials.length ? "ok" : "empty" },
    legislation: { items: legislation, source_status: legislation.length ? "ok" : "empty" },
    elections: emptySection(),
    arrests: emptySection(),
    news: { items: newsItems, source_status: newsItems.length ? "ok" : "empty" },
  };
}

/** Write the digest to both latest.json paths the Pulse module reads, plus the dated file. */
export async function writeDigest(digest: LifeosDigest, customizationsDir: string, dataDir: string): Promise<{ datedPath: string; customLatest: string; dataLatest: string }> {
  const dateStr = digest.meta.generated_at.slice(0, 10);
  const json = JSON.stringify(digest, null, 2);
  await mkdir(customizationsDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const datedPath = join(dataDir, `${dateStr}_crescent-city_ca_digest.json`);
  const customLatest = join(customizationsDir, "latest.json");
  const dataLatest = join(dataDir, "latest.json");
  await writeFile(datedPath, json, "utf8");
  await writeFile(customLatest, json, "utf8");
  await writeFile(dataLatest, json, "utf8");
  return { datedPath, customLatest, dataLatest };
}

async function main() {
  const repoOutput = process.env.REPO_OUTPUT_DIR ?? join(process.cwd(), "output");
  const home = homedir();
  const customizationsDir =
    process.env.LIFEOS_CUSTOMIZATIONS_DIR ??
    join(home, ".claude", "LIFEOS", "USER", "CUSTOMIZATIONS", "SKILLS", "LocalIntelligence");
  const dataDir = process.env.LIFEOS_DATA_DIR ?? join(home, ".claude", "LIFEOS", "MEMORY", "DATA", "LocalIntelligence");

  const digest = await buildDigest({ outputDir: repoOutput });
  const { datedPath, customLatest, dataLatest } = await writeDigest(digest, customizationsDir, dataDir);
  const totals = Object.fromEntries(
    (["news", "officials", "legislation"] as const).map(k => [k, digest[k].items.length]),
  );
  console.log(`LifeOS digest written: news=${totals.news} officials=${totals.officials} legislation=${totals.legislation}`);
  console.log(`  dated:   ${datedPath}`);
  console.log(`  latest:  ${customLatest}`);
  console.log(`  latest:  ${dataLatest}`);
  console.log(`  overview: ${digest.meta.overview}`);
}

if (import.meta.main) {
  await main();
}
