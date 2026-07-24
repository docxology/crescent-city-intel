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
import { chatWithProvider, checkChatProvider } from './llm/provider.js';
import { domains } from './domains.js';
import { mkdir, open, readFile, readdir, stat, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { paths } from './shared/paths.js';
import { errorMessage, writeJsonAtomic } from './shared/source_health.js';
import { createRunId } from './shared/orchestration.js';
import { computeSha256 } from './utils.js';
import type { CurationCitation, CurationRunReport } from './types.js';

const logger = createLogger('curation');

const CURATED_OUTPUT_DIR = paths.curated;
/** Lives under output/state/, NOT output/curated/ — keeps every consumer
 * that lists output/curated/*.json (e.g. GET /api/curated) from having to
 * remember to filter this state file out. */
const CURATION_SEEN_PATH = paths.curationSeen;
const CURATION_LOCK_PATH = `${CURATION_SEEN_PATH}.lock`;
const CURATION_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

const NEWS_DIR = join(process.cwd(), 'output', 'news');
const GOV_MEETINGS_DIR = join(process.cwd(), 'output', 'gov_meetings');
const YOUTUBE_DIR = join(process.cwd(), 'output', 'youtube');

/** Acquire an exclusive curation-run lock; stale locks from terminated runs are recoverable. */
async function acquireCurationLock(): Promise<() => Promise<void>> {
  await mkdir(join(process.cwd(), 'output', 'state'), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(CURATION_LOCK_PATH, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      return async () => { await unlink(CURATION_LOCK_PATH).catch(() => undefined); };
    } catch (error: any) {
      if (error?.code !== 'EEXIST' || attempt > 0) {
        throw new Error('A curation run is already in progress; retry after it completes.');
      }
      const lockStats = await stat(CURATION_LOCK_PATH).catch(() => null);
      if (!lockStats || Date.now() - lockStats.mtimeMs <= CURATION_LOCK_STALE_MS) {
        throw new Error('A curation run is already in progress; retry after it completes.');
      }
      await unlink(CURATION_LOCK_PATH).catch(() => undefined);
    }
  }
  throw new Error('Unable to acquire curation run lock');
}

export interface CurationInput {
  /** Stable id — must match the id each source's own IdempotencyStore uses, so citations line up */
  id: string;
  source: 'news' | 'gov_meetings' | 'youtube';
  title: string;
  text: string;
  link?: string;
  fetchedAt: string;
  /** Explicit source URL used for citations and provenance checks. */
  sourceUrl?: string;
}

export interface CuratedItem {
  id: string;
  source: CurationInput['source'];
  title: string;
  link?: string;
  summary: string;
  tags: string[];
  curatedAt: string;
  summaryStatus: 'ok' | 'source_only' | 'unavailable';
  provider: 'ollama' | 'openrouter' | 'none';
  model: string;
  sourceExcerpt: string;
  provenance: string;
  inputFingerprint: string;
  promptVersion: string;
  citations: CurationCitation[];
  retryable: boolean;
  error?: string;
}

export interface SummaryResult {
  summary: string;
  status: CuratedItem['summaryStatus'];
  provider: CuratedItem['provider'];
  model: string;
  error?: string;
  retryable: boolean;
}

export const CURATION_PROMPT_VERSION = '2026-07-24-grounded-v2';

/** Build deterministic citation/provenance fields before any provider call. */
export function buildCurationEvidence(item: CurationInput, inputFingerprint: string): {
  inputFingerprint: string;
  citations: CurationCitation[];
  provenance: string;
} {
  const sourceUrl = item.sourceUrl ?? item.link;
  const citations: CurationCitation[] = sourceUrl && /^https?:\/\//i.test(sourceUrl)
    ? [{ url: sourceUrl, label: item.title, source: item.source, fetchedAt: item.fetchedAt }]
    : [];
  return {
    inputFingerprint,
    citations,
    provenance: `${item.source}:${sourceUrl ?? item.id}; fetchedAt=${item.fetchedAt}`,
  };
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
  return chatWithProvider(messages);
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

export async function summarizeItemDetailed(item: CurationInput): Promise<SummaryResult> {
  const provider = llmConfig.provider;
  const model = provider === 'openrouter' ? llmConfig.openrouterModel : llmConfig.chatModel;
  const sourceExcerpt = item.text.trim().slice(0, 600);
  try {
    const prompt =
      `Summarize the following in 1-2 sentences for a civic-intelligence briefing about ` +
      `Crescent City, CA. Use ONLY facts explicitly present in the source. ` +
      `Do not infer identities, dates, causes, locations, or agencies. If the ` +
      `source lacks enough information, say that it is a limited source excerpt. ` +
      `Be factual and concise, with no preamble.\n\n` +
      `Title: ${item.title}\n\nSource excerpt:\n${item.text.slice(0, 4000) || '(no article body was supplied by the feed)'}`;
    const summary = await withTimeout(chatWithConfiguredProvider(prompt), SUMMARY_TIMEOUT_MS, `Summary for ${item.id}`);
    if (!summary.trim()) throw new Error('Provider returned an empty summary');
    return { summary: summary.trim(), status: 'ok', provider, model, retryable: false };
  } catch (err: unknown) {
    logger.warn(`Summary unavailable for item ${item.id}`, { error: errorMessage(err), source: item.source });
    return {
      summary: sourceExcerpt ? `Source-only excerpt: ${sourceExcerpt}` : 'Summary unavailable: the source did not provide article text.',
      status: 'unavailable',
      provider,
      model,
      error: errorMessage(err),
      retryable: true,
    };
  }
}

/** Backwards-compatible string summary API. */
export async function summarizeItem(item: CurationInput): Promise<string> {
  return (await summarizeItemDetailed(item)).summary;
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
  const startedAt = new Date().toISOString();
  const runId = createRunId('curation', startedAt);
  const releaseLock = await acquireCurationLock();

  try {
    const idempotency = new IdempotencyStore(CURATION_SEEN_PATH);
    await idempotency.load();

    const inputs = await gatherCurationInputs();
    // Historical batches can contain the same item more than once. Collapse
    // before scheduling provider work so one run cannot issue duplicate LLM
    // requests for an unchanged source record.
    const uniqueInputs = [...new Map(inputs.map(item => [item.id, item])).values()];
    const inputFingerprints = new Map<string, string>();
    for (const item of uniqueInputs) {
      inputFingerprints.set(item.id, await computeSha256(JSON.stringify({ id: item.id, title: item.title, text: item.text })));
    }
    const toCurate = uniqueInputs.filter((item) => {
      const record = idempotency.get(item.id);
      // Legacy presence-only records have an empty hash and remain valid. New
      // records re-run when the source content or grounding prompt changes.
      if (!record || !record.hash) return !record;
      return record.hash !== inputFingerprints.get(item.id) || record.meta?.promptVersion !== CURATION_PROMPT_VERSION;
    });

    if (toCurate.length === 0) {
      const emptyReport: CurationRunReport = {
        schemaVersion: '1.0.0',
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        provider: llmConfig.provider,
        model: llmConfig.provider === 'openrouter' ? llmConfig.openrouterModel : llmConfig.chatModel,
        inputCount: uniqueInputs.length,
        attemptedCount: 0,
        succeededCount: 0,
        retryableCount: 0,
        sourceOnlyCount: 0,
        outputPath: null,
        providerChecked: false,
        providerReachable: false,
      };
      await writeJsonAtomic(paths.curationReport, emptyReport);
      logger.info('No new items to curate');
      return [];
    }

    // Check the selected provider once before a batch. Without this guard, an
    // unreachable OpenRouter endpoint would spend the per-item summary timeout
    // on every input even though the whole run is already known to be degraded.
    // Items remain retryable because unavailable summaries are never recorded
    // as successfully curated below.
    const providerHealth = await checkChatProvider();
    const providerError = !providerHealth.configured || !providerHealth.reachable
      ? providerHealth.error ?? `${providerHealth.provider} chat provider is unavailable`
      : undefined;
    if (providerError) logger.warn('Curation provider preflight failed; retaining source-only items for retry', { error: providerError });

    const curated: CuratedItem[] = [];
    let succeededCount = 0;
    let retryableCount = 0;
    let sourceOnlyCount = 0;
    for (const [i, item] of toCurate.entries()) {
      // Space out requests when using OpenRouter so a burst of new items
      // doesn't blow through the free-tier per-minute rate limit and degrade
      // every item to "summary unavailable". Ollama has no such external limit.
      if (i > 0 && !providerError && llmConfig.provider === 'openrouter') {
        await new Promise((resolve) => setTimeout(resolve, llmConfig.openrouterMinRequestIntervalMs));
      }
      const summary = providerError
        ? {
            summary: item.text.trim()
              ? `Source-only excerpt: ${item.text.trim().slice(0, 600)}`
              : 'Summary unavailable: the source did not provide article text.',
            status: 'unavailable' as const,
            provider: providerHealth.provider,
            model: providerHealth.model,
            error: providerError,
            retryable: true,
          }
        : await summarizeItemDetailed(item);
      if (summary.status === 'ok') succeededCount++;
      if (summary.retryable) retryableCount++;
      if (summary.status === 'source_only') sourceOnlyCount++;
      const inputFingerprint = inputFingerprints.get(item.id) ?? await computeSha256(item.text);
      const evidence = buildCurationEvidence(item, inputFingerprint);
      const tags = tagWithDomains(item);
      curated.push({
        id: item.id,
        source: item.source,
        title: item.title,
        link: item.link,
        summary: summary.summary,
        tags,
        curatedAt: new Date().toISOString(),
        summaryStatus: summary.status,
        provider: summary.provider,
        model: summary.model,
        sourceExcerpt: item.text.slice(0, 600),
        provenance: evidence.provenance,
        inputFingerprint: evidence.inputFingerprint,
        promptVersion: CURATION_PROMPT_VERSION,
        citations: evidence.citations,
        retryable: summary.retryable,
        ...(summary.error ? { error: summary.error } : {}),
      });
      // A failed provider call stays retryable. The source-only fallback is
      // retained as evidence for this run but is not treated as a successful
      // LLM curation result.
      if (summary.status === 'ok' || summary.status === 'source_only') {
        idempotency.seen(item.id, inputFingerprint, { source: item.source, promptVersion: CURATION_PROMPT_VERSION });
      }
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
    await writeJsonAtomic(outPath, [...existing, ...curated]);

    await idempotency.save();

    const curationReport: CurationRunReport = {
      schemaVersion: '1.0.0',
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      provider: providerHealth.provider,
      model: providerHealth.model,
      inputCount: uniqueInputs.length,
      attemptedCount: toCurate.length,
      succeededCount,
      retryableCount,
      sourceOnlyCount,
      outputPath: outPath,
      providerChecked: true,
      providerReachable: providerHealth.reachable,
      ...(providerError ? { providerError } : {}),
    };
    await writeJsonAtomic(paths.curationReport, curationReport);

    logger.info(`=== Curation Complete: ${curated.length} item(s) curated ===`);
    return curated;
  } finally {
    await releaseLock();
  }
}

if (import.meta.main) {
  runCuration().catch((error: any) => {
    logger.error('Curation failed', { error: error.message });
    process.exit(1);
  });
}
