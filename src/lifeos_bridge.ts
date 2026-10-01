/**
 * LifeOS / Pulse bridge — business logic for the LocalIntelligence digest
 * consumed by the Pulse LOCAL tab, built from THIS platform's real outputs
 * (news digests, government meetings, alert history, municipal-code stats).
 * Invoked by the thin orchestrator `scripts/lifeos-bridge.ts`.
 *
 * The digest follows the schema of `~/.claude/skills/LocalIntelligence/
 * Tools/Types.ts` (sections of {items, source_status, errors?} + meta).
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
 * Missing or invalid producer outputs are unavailable; their dates are never guessed.
 */
import { mkdir, readFile, unlink } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { parseEventDate, isCivilDate } from "./events.js";
import { custodyHash } from "./corpus_editions.js";
import { writeJsonAtomic, writeTextAtomic, sourceHealth, isSourceHealthReceipt } from "./shared/source_health.js";
import { redactUrl } from "./shared/transport.js";
import { acquireFileLease } from "./shared/storage.js";
import type { SourceHealth } from "./types.js";
import { readBoundedArtifact } from "./shared/artifact_transaction.js";

export interface LifeosItem {
  title: string;
  source: string;
  url: string;
  date: string;
  dateEvidence: "source-recorded" | "unknown";
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
    contract_version: "2.0.0";
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
  if (!item || typeof item !== "object") return null;
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const url = typeof item.link === "string" ? item.link.trim() : "";
  try { const destination = new URL(url); if (!/^https?:$/.test(destination.protocol) || destination.username || destination.password || redactUrl(url) !== destination.toString()) return null; } catch { return null; }
  if (!title || !url) return null;
  const date = parseEventDate(item.pubDate ?? item.date);
  return {
    title,
    source: typeof item.source === "string" ? item.source.trim() : "crescent-city-intel",
    url,
    date: date ?? "", dateEvidence: date ? "source-recorded" : "unknown",
    ...(typeof item.content === "string" && item.content.trim() ? { summary: item.content.trim().slice(0, 240) } : {}),
  };
}

/** Read the lexicographically latest producer-stamped JSON filename. */
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

/** Pure digest builder from this platform's outputs. */
export async function buildDigest(options: {
  outputDir: string;
  generatedAt?: string;
}): Promise<LifeosDigest> {
  const { outputDir, generatedAt = new Date().toISOString() } = options;
  if (!Number.isFinite(Date.parse(generatedAt)) || !isCivilDate(generatedAt.slice(0, 10))) throw new Error("Invalid digest generatedAt");

  const newsDigest = await loadLatestJson<{ items?: Array<{ title: string; link: string; pubDate: string; content?: string; source?: string }> }>(join(outputDir, "news"), "news-");
  const meetings = await loadLatestJson<{ items?: Array<{ title: string; link: string; date: string; content?: string; source?: string }> }>(join(outputDir, "gov_meetings"), "gov_meetings-");

  const validNews = Array.isArray(newsDigest?.items); const validMeetings = Array.isArray(meetings?.items);
  const rawNews = validNews ? newsDigest!.items! : []; const rawMeetings = validMeetings ? meetings!.items! : [];
  const newsItems = rawNews.map(toLifeosItem).filter((x): x is LifeosItem => x !== null);
  const meetingItems = rawMeetings.map(toLifeosItem).filter((x): x is LifeosItem => x !== null);
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
      const level = ["CALM", "WATCH", "WARNING", "EMERGENCY"].includes(composite.level) ? composite.level : "unknown";
      overview += ` · composite alert: ${level}` + (typeof composite.reason === "string" ? ` (${composite.reason.slice(0, 80)})` : "");
    }
    const manifestPath = join(outputDir, "manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const sectionCount = Number.isSafeInteger(manifest.sectionCount) && manifest.sectionCount >= 0 ? manifest.sectionCount : null;
      overview += ` · municipal code: ${sectionCount ?? "n/a"} sections`;
    }
  } catch { /* overview is best-effort */ }

  const failed: string[] = [];
  const errors: string[] = [];
  const used: string[] = [];
  const healthByProducer = new Map<string, SourceHealth[]>();
  for (const [name, available, dropped] of [["news", validNews, rawNews.length - newsItems.length], ["gov_meetings", validMeetings, rawMeetings.length - meetingItems.length]] as const) {
    if (available) used.push(`crescent-city-intel:${name}`); else { failed.push(name); errors.push(`${name}: no readable producer batch`); }
    if (dropped) errors.push(`${name}: ${dropped} malformed or unsafe item(s) excluded`);
    try {
      const health: unknown = JSON.parse(await readFile(join(outputDir, name, "source-health.json"), "utf8"));
      const rawSources = health && typeof health === "object" ? (health as Record<string, unknown>).sources : null;
      if (!Array.isArray(rawSources) || !rawSources.length) throw new Error("No source-health receipts");
      const sources: SourceHealth[] = [];
      for (const raw of rawSources) {
        if (!isSourceHealthReceipt(raw)) throw new Error("Invalid source-health fields");
        const original = raw;
        const { source, status, checkedAt, ...details } = original;
        const reassessed = sourceHealth(source, status, generatedAt, details);
        reassessed.checkedAt = original.checkedAt;
        if (Date.parse(checkedAt) > Date.parse(generatedAt)) { reassessed.status = "unavailable"; reassessed.error = "Source check timestamp is in the future"; }
        if (!original.fetchedAt && (reassessed.status === "ok" || reassessed.status === "empty")) { reassessed.status = "unavailable"; reassessed.error = "No acquisition timestamp in source-health receipt"; }
        sources.push(reassessed);
        if (["unavailable", "stale"].includes(reassessed.status)) { failed.push(reassessed.source); errors.push(`${reassessed.source}: ${reassessed.error ?? reassessed.status}`); }
      }
      healthByProducer.set(name, sources);
    } catch (error) { failed.push(name); errors.push(`${name}: ${error instanceof Error ? error.message : "Unreadable source-health receipt"}`); }
  }
  function section(items: LifeosItem[], producer: string, valid: boolean): LifeosSection {
    const sources = healthByProducer.get(producer) ?? [];
    const available = valid && sources.some(source => source.status === "ok" || source.status === "empty");
    const sectionErrors = errors.filter(error => error.startsWith(`${producer}:`) || sources.some(source => error.startsWith(`${source.source}:`)));
    return { items, source_status: !available ? "unavailable" : items.length ? "ok" : "empty", ...(sectionErrors.length ? { errors: sectionErrors } : {}) };
  }

  return {
    meta: {
      city: "Crescent City",
      state: "CA",
      county: "Del Norte",
      zip: "95531",
      region: "North Coast (Del Norte + Humboldt)",
      generated_at: generatedAt,
      contract_version: "2.0.0",
      sources_used: used,
      sources_failed: [...new Set(failed)],
      errors,
      platform: "crescent-city-intel",
      overview,
    },
    construction: emptySection(),
    crime: emptySection(),
    business: emptySection(),
    officials: section(officials, "gov_meetings", validMeetings),
    legislation: section(legislation, "gov_meetings", validMeetings),
    elections: emptySection(),
    arrests: emptySection(),
    news: section(newsItems, "news", validNews),
  };
}

/** Write the digest to both latest.json paths the Pulse module reads, plus the dated file. */
export async function writeDigest(digest: LifeosDigest, customizationsDir: string, dataDir: string): Promise<{ datedPath: string; customLatest: string; dataLatest: string; receiptPath: string; sha256: string }> {
  if (!Number.isFinite(Date.parse(digest.meta.generated_at)) || !isCivilDate(digest.meta.generated_at.slice(0, 10))) throw new Error("Invalid digest generated_at");
  const dateStr = digest.meta.generated_at.slice(0, 10); const json = JSON.stringify(digest, null, 2); const sha256 = custodyHash(json);
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const directory of [...new Set([resolve(customizationsDir), resolve(dataDir)])].sort()) releases.push(await acquireFileLease(join(directory, "digest.lock")));
    const datedPath = join(dataDir, `${dateStr}_crescent-city_ca_digest.json`);
    const customLatest = join(customizationsDir, "latest.json"); const dataLatest = join(dataDir, "latest.json");
    const receiptPath = join(dataDir, "digest-receipt.json"); const journalPath = join(dataDir, "digest-transfer-journal.json");
    const destinationFingerprint = custodyHash(JSON.stringify([resolve(customizationsDir), resolve(dataDir)]));
    type Journal = { schemaVersion: "lifeos-transfer-journal/v1"; state: "pending" | "committed" | "rolled-back"; destinationFingerprint: string; date: string; sha256: string; before: Array<string | null> };
    const targets = (date: string) => [join(dataDir, `${date}_crescent-city_ca_digest.json`), customLatest, dataLatest];
    const restore = async (journal: Journal) => {
      for (const [index, path] of targets(journal.date).entries()) {
        const previous = journal.before[index]; if (previous === null) { try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
        else await writeTextAtomic(path, previous!);
      }
      await writeJsonAtomic(journalPath, { ...journal, state: "rolled-back" });
    };
    let pending: Journal | null = null;
    try { pending = JSON.parse(await readFile(journalPath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Digest transfer journal is unreadable; preserve it before recovery"); }
    if (pending?.state === "pending") {
      if (pending.schemaVersion !== "lifeos-transfer-journal/v1" || pending.destinationFingerprint !== destinationFingerprint || !isCivilDate(pending.date) || !Array.isArray(pending.before) || pending.before.length !== 3 || pending.before.some(value => value !== null && typeof value !== "string") || !/^[a-f0-9]{64}$/.test(pending.sha256)) throw new Error("Invalid digest transfer recovery journal");
      let committed = false;
      try { const receipt = JSON.parse(await readFile(receiptPath, "utf8")); committed = receipt.sha256 === pending.sha256 && (await Promise.all(targets(pending.date).map(async path => custodyHash(await readFile(path, "utf8"))))).every(hash => hash === pending!.sha256); } catch { /* Incomplete copies need restoration. */ }
      if (committed) await writeJsonAtomic(journalPath, { ...pending, state: "committed" }); else await restore(pending);
    }
    const before: Array<string | null> = [];
    for (const path of [datedPath, customLatest, dataLatest]) {
      try { const previous = await readFile(path, "utf8"); before.push(previous); await writeTextAtomic(join(dataDir, "versions", custodyHash(previous), "digest.json"), previous); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; before.push(null); }
    }
    await writeTextAtomic(join(dataDir, "versions", sha256, "digest.json"), json);
    const journal: Journal = { schemaVersion: "lifeos-transfer-journal/v1", state: "pending", destinationFingerprint, date: dateStr, sha256, before };
    await writeJsonAtomic(journalPath, journal);
    let committed = false;
    try {
      for (const path of [datedPath, customLatest, dataLatest]) await writeTextAtomic(path, json);
      if (!(await Promise.all([datedPath, customLatest, dataLatest].map(async path => custodyHash(await readFile(path, "utf8"))))).every(hash => hash === sha256)) throw new Error("Digest copies differ from transfer receipt");
      await writeJsonAtomic(receiptPath, { schemaVersion: "lifeos-digest-transfer/v2", sha256, generatedAt: digest.meta.generated_at, completedAt: new Date().toISOString(), copies: ["dated", "custom-latest", "data-latest"], sourceEvidence: "producer-artifacts; missing dates stay unknown", atomicity: "individual replacements; consumers must verify committed receipt" });
      committed = true; await writeJsonAtomic(journalPath, { ...journal, state: "committed" });
    } catch (error) { if (!committed) await restore(journal); throw error; }
    return { datedPath, customLatest, dataLatest, receiptPath, sha256 };
  } finally { for (const release of releases.reverse()) await release(); }
}

/** Atomic receipt selects retained bytes, so partially replaced latest copies are never consumed. */
export async function readCommittedDigest(dataDir: string): Promise<LifeosDigest> {
  const bytes = await readBoundedArtifact(join(dataDir, 'digest-receipt.json'), 16_384);
  if (!bytes) throw new Error('No committed digest receipt');
  const receipt = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  if (receipt.schemaVersion !== 'lifeos-digest-transfer/v2' || typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256) || typeof receipt.generatedAt !== 'string') throw new Error('Invalid committed digest receipt');
  const version = await readBoundedArtifact(join(dataDir, 'versions', receipt.sha256, 'digest.json'), 4_000_000);
  if (!version || custodyHash(version) !== receipt.sha256) throw new Error('Committed digest version failed byte custody');
  const digest = JSON.parse(version.toString('utf8')) as LifeosDigest;
  if (digest.meta?.contract_version !== '2.0.0' || digest.meta.generated_at !== receipt.generatedAt) throw new Error('Unsupported committed digest contract');
  return digest;
}
