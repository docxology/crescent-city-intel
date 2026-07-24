#!/usr/bin/env bun
/**
 * Curation pipeline — unifies news, government-meeting, and YouTube-transcript
 * output into a single LLM-summarized, domain-tagged feed.
 *
 * Reads whatever each source monitor has already written to output/, does
 * NOT re-fetch from any upstream source itself (that stays each monitor's
 * job), summarizes each not-yet-curated item via the configured LLM
 * provider (Ollama or OpenRouter, per llmConfig.provider), tags it against
 * src/domains.ts by keyword overlap, and writes output/curated/<date>.json.
 *
 * Idempotent: curation keeps its OWN IdempotencyStore (independent of each
 * source's own dedup) so re-running never re-summarizes an item already
 * curated, regardless of which source-output batch file it came from.
 *
 * Usage:
 *   bun run src/curation.ts
 *   bun run curate
 */
import { createLogger } from './logger.js';
import { IdempotencyStore } from './shared/idempotency.js';
import { llmConfig } from './llm/config.js';
import { chat as ollamaChat } from './llm/ollama.js';
import { chat as openrouterChat } from './llm/openrouter.js';
import { domains } from './domains.js';
import { mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const logger = createLogger('curation');

const CURATED_OUTPUT_DIR = join(process.cwd(), 'output', 'curated');
/** Lives under output/state/, NOT output/curated/ — keeps every consumer
 * that lists output/curated/*.json (e.g. GET /api/curated) from having to
 * remember to filter this state file out. */
const CURATION_SEEN_PATH = join(process.cwd(), 'output', 'state', 'curation-seen.json');

const NEWS_DIR = join(process.cwd(), 'output', 'news');
const GOV_MEETINGS_DIR = join(process.cwd(), 'output', 'gov_meetings');
const YOUTUBE_DIR = join(process.cwd(), 'output', 'youtube');

export interface CurationInput {
  /** Stable id — must match the id each source's own IdempotencyStore uses, so citations line up */
  id: string;
  source: 'news' | 'gov_meetings' | 'youtube';
  title: string;
  text: string;
  link?: string;
  fetchedAt: string;
}

export interface CuratedItem {
  id: string;
  source: CurationInput['source'];
  title: string;
  link?: string;
  summary: string;
  tags: string[];
  curatedAt: string;
}

// ─── Gather already-fetched items from each source's output/ ─────────────

async function readJsonFilesInDir(dir: string): Promise<any[]> {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const parsed: any[] = [];
  for (const f of files) {
    try {
      const raw = await readFile(join(dir, f), 'utf-8');
      parsed.push(JSON.parse(raw));
    } catch (err: any) {
      logger.warn(`Skipping unreadable/corrupt file ${f} in ${dir}`, { error: err.message });
    }
  }
  return parsed;
}

/** Gather news items from every output/news/*.json batch file. */
async function gatherNewsItems(): Promise<CurationInput[]> {
  const batches = await readJsonFilesInDir(NEWS_DIR);
  const out: CurationInput[] = [];
  for (const batch of batches) {
    for (const item of batch.items ?? []) {
      if (!item.link || !item.title) continue;
      out.push({
        id: item.link,
        source: 'news',
        title: item.title,
        text: item.content ?? '',
        link: item.link,
        fetchedAt: item.fetchedAt ?? batch.fetchedAt ?? new Date().toISOString(),
      });
    }
  }
  return out;
}

/** Gather government meeting items from every output/gov_meetings/*.json batch file. */
async function gatherGovMeetingItems(): Promise<CurationInput[]> {
  const batches = await readJsonFilesInDir(GOV_MEETINGS_DIR);
  const out: CurationInput[] = [];
  for (const batch of batches) {
    for (const item of batch.items ?? []) {
      if (!item.link || !item.title) continue;
      out.push({
        id: item.link,
        source: 'gov_meetings',
        title: item.title,
        text: item.content ?? '',
        link: item.link,
        fetchedAt: item.fetchedAt ?? batch.fetchedAt ?? new Date().toISOString(),
      });
    }
  }
  return out;
}

/** Gather YouTube transcripts from every output/youtube/<video-id>.json file. */
async function gatherYouTubeItems(): Promise<CurationInput[]> {
  if (!existsSync(YOUTUBE_DIR)) return [];
  const files = (await readdir(YOUTUBE_DIR)).filter((f) => f.endsWith('.json'));
  const out: CurationInput[] = [];
  for (const f of files) {
    try {
      const raw = await readFile(join(YOUTUBE_DIR, f), 'utf-8');
      const t = JSON.parse(raw);
      if (t.status !== 'ok' || !t.fullText) continue; // nothing to summarize for unavailable/failed transcripts
      out.push({
        id: t.videoId,
        source: 'youtube',
        title: t.title,
        text: t.fullText,
        link: `https://www.youtube.com/watch?v=${t.videoId}`,
        fetchedAt: t.fetchedAt,
      });
    } catch (err: any) {
      logger.warn(`Skipping unreadable/corrupt YouTube transcript file ${f}`, { error: err.message });
    }
  }
  return out;
}

/** Gather every curatable item currently sitting in output/ across all sources. */
export async function gatherCurationInputs(): Promise<CurationInput[]> {
  const [news, gov, youtube] = await Promise.all([
    gatherNewsItems(),
    gatherGovMeetingItems(),
    gatherYouTubeItems(),
  ]);
  return [...news, ...gov, ...youtube];
}

// ─── Summarization (provider-agnostic: Ollama or OpenRouter) ─────────────

async function chatWithConfiguredProvider(prompt: string): Promise<string> {
  const messages = [{ role: 'user' as const, content: prompt }];
  if (llmConfig.provider === 'openrouter') {
    return openrouterChat(messages);
  }
  return ollamaChat(messages);
}

/**
 * Summarize a single item in 1-2 sentences. Never throws — a failed
 * summary degrades to a placeholder string rather than dropping the item
 * or failing the whole curation run (Anti-criterion ISC-52).
 */
/**
 * Bound how long a single summarization call may take. Ollama's chat()
 * (unlike openrouter.ts's fetch calls) carries no built-in timeout — under
 * concurrent load a hung request would otherwise stall curation
 * indefinitely, which is exactly what ISC-52 (curation must never block
 * the underlying monitor run) exists to prevent. try/catch alone does not
 * help against a genuine hang, since the awaited promise never settles;
 * this needs a real race against a timeout.
 */
const SUMMARY_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export async function summarizeItem(item: CurationInput): Promise<string> {
  try {
    const prompt =
      `Summarize the following in 1-2 sentences for a civic-intelligence briefing about ` +
      `Crescent City, CA. Be factual and concise, no preamble.\n\n` +
      `Title: ${item.title}\n\nContent:\n${item.text.slice(0, 4000)}`;
    const summary = await withTimeout(chatWithConfiguredProvider(prompt), SUMMARY_TIMEOUT_MS, `Summary for ${item.id}`);
    return summary.trim() || '(summary unavailable)';
  } catch (err: any) {
    logger.warn(`Summary unavailable for item ${item.id}`, { error: err.message, source: item.source });
    return '(summary unavailable)';
  }
}

// ─── Domain tagging (keyword overlap against src/domains.ts) ─────────────

/**
 * Tag an item with the names of every intelligence domain whose topic tags
 * appear (case-insensitive substring match) in the item's title+text.
 * Pure/synchronous — no LLM call, so tagging never depends on provider
 * availability and can't itself fail the curation run.
 */
export function tagWithDomains(item: CurationInput): string[] {
  const haystack = `${item.title} ${item.text}`.toLowerCase();
  const matched = new Set<string>();

  for (const domain of domains) {
    for (const topic of domain.topics) {
      for (const tag of topic.tags) {
        if (haystack.includes(tag.toLowerCase())) {
          matched.add(domain.name);
          break;
        }
      }
    }
  }

  return [...matched];
}

// ─── Main curation run ─────────────────────────────────────────────────

/**
 * Curate every not-yet-curated item currently in output/{news,gov_meetings,youtube}.
 * Idempotent — re-running with no new upstream items curates nothing.
 */
export async function runCuration(): Promise<CuratedItem[]> {
  logger.info('=== Starting Crescent City Curation ===');

  const idempotency = new IdempotencyStore(CURATION_SEEN_PATH);
  await idempotency.load();

  const inputs = await gatherCurationInputs();
  const toCurate = inputs.filter((item) => idempotency.seen(item.id).isNew);

  if (toCurate.length === 0) {
    logger.info('No new items to curate');
    return [];
  }

  const curated: CuratedItem[] = [];
  for (const [i, item] of toCurate.entries()) {
    // Space out requests when using OpenRouter so a burst of new items
    // doesn't blow through the free-tier per-minute rate limit and degrade
    // every item to "summary unavailable" (see openrouterMinRequestIntervalMs
    // doc comment in llm/config.ts). Ollama has no such external limit.
    if (i > 0 && llmConfig.provider === 'openrouter') {
      await new Promise((resolve) => setTimeout(resolve, llmConfig.openrouterMinRequestIntervalMs));
    }
    const summary = await summarizeItem(item);
    const tags = tagWithDomains(item);
    curated.push({
      id: item.id,
      source: item.source,
      title: item.title,
      link: item.link,
      summary,
      tags,
      curatedAt: new Date().toISOString(),
    });
  }

  await mkdir(CURATED_OUTPUT_DIR, { recursive: true });
  const dateStamp = new Date().toISOString().slice(0, 10);
  const outPath = join(CURATED_OUTPUT_DIR, `${dateStamp}.json`);

  // Append to today's file if it already exists (multiple curation runs per day)
  let existing: CuratedItem[] = [];
  if (existsSync(outPath)) {
    try {
      existing = JSON.parse(await readFile(outPath, 'utf-8'));
    } catch {
      existing = [];
    }
  }
  await writeFile(outPath, JSON.stringify([...existing, ...curated], null, 2));

  await idempotency.save();

  logger.info(`=== Curation Complete: ${curated.length} item(s) curated ===`);
  return curated;
}

if (import.meta.main) {
  runCuration().catch((error: any) => {
    logger.error('Curation failed', { error: error.message });
    process.exit(1);
  });
}
