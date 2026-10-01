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
import { IdempotencyStore, type IdempotencyRecord } from './shared/idempotency.js';
import { llmConfig } from './llm/config.js';
import { chatWithProvider, checkChatProvider, configuredChatModel } from './llm/provider.js';
import { domains } from './domains.js';
import { mkdir, open, readFile, readdir, stat, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, relative } from 'path';
import { paths } from './shared/paths.js';
import { isActiveNewsSource } from './news_monitor.js';
import { errorMessage, writeJsonAtomic } from './shared/source_health.js';
import { acquireFileLease } from './shared/storage.js';
import { createRunId } from './shared/orchestration.js';
import { computeSha256 } from './utils.js';
import { boundedSignal } from './llm/runtime.js';
import { withProviderBudget } from './llm/openrouter.js';
import { waitWithSignal } from './shared/transport.js';
import { withProducerScope, type ProducerOptions } from './shared/run_scope.js';
import type { CurationCitation, CurationRunReport } from './types.js';

const logger = createLogger('curation');

function curatedDir(): string { return paths.curated; }
function curationSeenPath(): string { return paths.curationSeen; }
function newsDir(): string { return paths.news; }
function meetingsDir(): string { return paths.govMeetings; }
function youtubeDir(): string { return paths.youtube; }
async function acquireCurationLock(signal?: AbortSignal): Promise<() => Promise<void>> {
  // Batch ownership and the store's read/merge/write lease have distinct scopes.
  return acquireFileLease(`${curationSeenPath()}.run.lock`, { waitMs: 1, staleMs: 30_000, signal });
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
  /** A link catalogue entry supplies no reviewed document body. */
  contentKind?: 'document-listing';
}

export interface CuratedItem {
  id: string;
  source: CurationInput['source'];
  contentKind?: CurationInput['contentKind'];
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
  // ── R2 additive LLM enrichment (optional for pre-R2 records) ──
  /** Per-item tags proposed by the structured LLM pass (entity-level). */
  entityTags?: string[];
  /** Per-item topics proposed by the structured LLM pass. */
  topicTags?: string[];
  /** 0..1 editorial importance with an LLM-written rationale. */
  salience?: number;
  salienceRationale?: string;
  /** One-line neutral summary from the same structured pass. */
  neutralSummary?: string;
}

export interface SummaryResult {
  summary: string;
  status: CuratedItem['summaryStatus'];
  provider: CuratedItem['provider'];
  model: string;
  error?: string;
  retryable: boolean;
}

/** Successful generation or the explicit completed listing policy may suppress future work. */
export function isCurationRecordComplete(
  record: IdempotencyRecord | undefined,
  expectedHash: string,
  provider: CuratedItem['provider'],
  model: string,
): boolean {
  return Boolean(
    record?.hash
      && record.hash === expectedHash
      && record.meta?.promptVersion === CURATION_PROMPT_VERSION
      && record.meta?.provider === provider
      && record.meta?.model === model
      && (provider === 'none' && model === DOCUMENT_LISTING_MODEL
        ? record.meta?.summaryStatus === 'source_only' && record.meta?.contentKind === 'document-listing' && record.meta?.retryable === false
        : record.meta?.summaryStatus === 'ok'),
  );
}

/** Deterministically replace visible records by source id without append-only duplicates. */
export function mergeCuratedItems(existing: CuratedItem[], incoming: CuratedItem[]): CuratedItem[] {
  const replacements = new Map<string, CuratedItem>();
  for (const item of incoming) replacements.set(item.id, item);
  return [...existing.filter(item => !replacements.has(item.id)), ...replacements.values()];
}

export const CURATION_PROMPT_VERSION = '2026-08-26-enriched-v3';
/** Schema shape version for the additive enrichment record (tags/salience/summary). */
export const CURATION_RECORD_SCHEMA_VERSION = '2.0.0';
const SUMMARY_MAX_CHARS = 900;
const DOCUMENT_LISTING_MODEL = 'document-listing/v1';
const CURATION_SYSTEM_PROMPT =
  'You are a source-grounded civic-news editor. Summarize only the supplied public source excerpt. ' +
  'Do not answer municipal-code questions, infer missing facts, add a cause, identify a person, or invent a date, location, agency, or outcome. ' +
  'Return plain text in at most two concise sentences with no heading, bullets, markdown, or preamble.';

function normalizeSourceText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Display only retained listing text, with no claim about the linked document's contents. */
function documentListingSummary(item: CurationInput): SummaryResult {
  const title = normalizeSourceText(item.title).slice(0, 220);
  const excerpt = normalizeSourceText(item.text).slice(0, 600);
  return { summary: `Document listing; linked content not reviewed. Title: ${title}${excerpt ? `\nSource excerpt: ${excerpt}` : ''}`,
    status: 'source_only', provider: 'none', model: DOCUMENT_LISTING_MODEL, retryable: false };
}

function curationIdentity(item: CurationInput): { provider: CuratedItem['provider']; model: string } {
  return item.contentKind === 'document-listing'
    ? { provider: 'none', model: DOCUMENT_LISTING_MODEL }
    : { provider: llmConfig.provider, model: configuredChatModel() };
}

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
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
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

/** Remove visible summaries whose upstream item is no longer in the active inputs. */
async function pruneCuratedArtifacts(activeIds: Set<string>, signal?: AbortSignal): Promise<void> {
  if (!existsSync(curatedDir())) return;
  const files = (await readdir(curatedDir())).filter(file => file.endsWith('.json')).sort();
  for (const file of files) {
    signal?.throwIfAborted();
    const path = join(curatedDir(), file);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8'));
      if (!Array.isArray(parsed)) continue;
      const retained = parsed.filter(item => {
        const id = typeof item?.id === 'string' ? item.id : typeof item?.link === 'string' ? item.link : '';
        return activeIds.has(id);
      });
      if (retained.length !== parsed.length) { signal?.throwIfAborted(); await writeJsonAtomic(path, retained, { signal }); }
    } catch (error: any) {
      signal?.throwIfAborted();
      logger.warn(`Skipping curated-artifact pruning for ${file}`, { error: error.message });
    }
  }
}

/** Retained completed output is a recovery journal, never a license to trust arbitrary JSON. */
async function retainedCuratedRecords(signal: AbortSignal): Promise<Map<string, CuratedItem[]>> {
  const records = new Map<string, CuratedItem[]>();
  if (!existsSync(curatedDir())) return records;
  const files = (await readdir(curatedDir())).filter(file => file.endsWith('.json')).sort();
  if (files.length > 1000) throw new Error('Curated recovery file limit exceeded');
  let count = 0;
  for (const file of files) {
    signal.throwIfAborted();
    const path = join(curatedDir(), file);
    if ((await stat(path)).size > 8_000_000) throw new Error('Curated recovery artifact exceeds its size limit');
    let value: unknown;
    try { value = JSON.parse(await readFile(path, 'utf8')); }
    catch { throw new Error('Curated recovery artifact is corrupt; preserve it before repair'); }
    signal.throwIfAborted();
    if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string')) throw new Error('Curated recovery artifact has an invalid shape; preserve it before repair');
    for (const item of value as CuratedItem[]) {
      if (++count > 10_000) throw new Error('Curated recovery record limit exceeded');
      const candidates = records.get(item.id) ?? []; candidates.push(item); records.set(item.id, candidates);
    }
  }
  return records;
}

/** Exact lineage and source binding; this does not establish semantic factual support. */
export function isRetainedCurationComplete(record: CuratedItem, item: CurationInput, fingerprint: string, provider: CuratedItem['provider'], model: string): boolean {
  const evidence = buildCurationEvidence(item, fingerprint);
  const listing = item.contentKind === 'document-listing';
  return record.id === item.id && record.source === item.source && record.title === item.title && record.link === item.link
    && record.inputFingerprint === fingerprint && record.promptVersion === CURATION_PROMPT_VERSION
    && record.provider === provider && record.model === model && record.summaryStatus === (listing ? 'source_only' : 'ok') && record.retryable === false
    && (!listing || record.contentKind === item.contentKind && record.summary === documentListingSummary(item).summary)
    && typeof record.summary === 'string' && record.summary.trim().length > 0 && record.summary.length <= SUMMARY_MAX_CHARS
    && typeof record.curatedAt === 'string' && Number.isFinite(Date.parse(record.curatedAt))
    && (listing ? normalizeSourceText(item.title).length > 0 : normalizeSourceText(item.text).length > 0)
    && record.sourceExcerpt === normalizeSourceText(item.text).slice(0, 600)
    && record.provenance === evidence.provenance && JSON.stringify(record.citations) === JSON.stringify(evidence.citations);
}

/** A no-op retains the original observation receipt instead of inventing a fresh citation. */
function isRetainedCurationVisible(record: CuratedItem, item: CurationInput, fingerprint: string, provider: CuratedItem['provider'], model: string): boolean {
  const prefix = `${item.source}:${item.sourceUrl ?? item.link ?? item.id}; fetchedAt=`;
  if (typeof record.provenance !== 'string' || !record.provenance.startsWith(prefix)) return false;
  const fetchedAt = record.provenance.slice(prefix.length);
  if (fetchedAt !== 'unknown' && !Number.isFinite(Date.parse(fetchedAt))) return false;
  return isRetainedCurationComplete(record, { ...item, fetchedAt }, fingerprint, provider, model);
}

/** Gather news items from every output/news/*.json batch file. */
async function gatherNewsItems(): Promise<CurationInput[]> {
  const batches = await readJsonFilesInDir(newsDir());
  const out: CurationInput[] = [];
  for (const batch of batches) {
    for (const item of batch.items ?? []) {
      if (!item.link || !item.title || !isActiveNewsSource(item.source)) continue;
      out.push({
        id: item.link,
        source: 'news',
        title: item.title,
        text: item.content ?? '',
        link: item.link,
        fetchedAt: item.fetchedAt ?? batch.fetchedAt ?? 'unknown',
      });
    }
  }
  return out;
}

/** Gather government meeting items from every output/gov_meetings/*.json batch file. */
async function gatherGovMeetingItems(): Promise<CurationInput[]> {
  const batches = await readJsonFilesInDir(meetingsDir());
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
        fetchedAt: item.fetchedAt ?? batch.fetchedAt ?? 'unknown',
        ...(item.recordKind === 'meeting-document' ? { contentKind: 'document-listing' as const } : {}),
      });
    }
  }
  return out;
}

/** Gather YouTube transcripts from every output/youtube/<video-id>.json file. */
async function gatherYouTubeItems(): Promise<CurationInput[]> {
  if (!existsSync(youtubeDir())) return [];
  const files = (await readdir(youtubeDir())).filter((f) => f.endsWith('.json')).sort();
  const out: CurationInput[] = [];
  for (const f of files) {
    try {
      const raw = await readFile(join(youtubeDir(), f), 'utf-8');
      const t = JSON.parse(raw);
      if (t.status !== 'ok' || !t.fullText) continue; // nothing to summarize for unavailable/failed transcripts
      out.push({
        id: t.videoId,
        source: 'youtube',
        title: t.title,
        text: t.fullText,
        link: `https://www.youtube.com/watch?v=${t.videoId}`,
        fetchedAt: t.fetchedAt ?? 'unknown',
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

async function chatWithConfiguredProvider(prompt: string, signal: AbortSignal): Promise<string> {
  const messages = [{ role: 'user' as const, content: prompt }];
  return chatWithProvider(messages, undefined, undefined, { signal, systemPrompt: CURATION_SYSTEM_PROMPT });
}

/**
 * Summarize a single item in 1-2 sentences. Never throws — a failed
 * summary degrades to a placeholder string rather than dropping the item
 * or failing the whole curation run (Anti-criterion ISC-52).
 */
/** The per-item cancellation deadline also inherits the total curation budget. */
const configuredSummaryTimeout = Number(process.env.CURATION_SUMMARY_TIMEOUT_MS ?? '15000');
const SUMMARY_TIMEOUT_MS = Number.isFinite(configuredSummaryTimeout) && configuredSummaryTimeout > 0 ? configuredSummaryTimeout : 15000;

async function withAbortTimeout<T>(task: (signal: AbortSignal) => Promise<T>, ms: number, label: string, parentSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  try {
    parentSignal?.throwIfAborted();
    const result = await task(parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal);
    parentSignal?.throwIfAborted();
    if (timedOut) throw new Error(`${label} timed out after ${ms}ms`);
    return result;
  } catch (error) {
    if (timedOut) throw new Error(`${label} timed out after ${ms}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function cleanSummary(raw: string): string {
  return raw.trim()
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^summary\s*:\s*/i, '')
    .trim();
}

export async function summarizeItemDetailed(item: CurationInput, parentSignal?: AbortSignal): Promise<SummaryResult> {
  parentSignal?.throwIfAborted();
  if (item.contentKind === 'document-listing') return documentListingSummary(item);
  const provider = llmConfig.provider;
  const model = provider === 'openrouter' ? llmConfig.openrouterModel : llmConfig.chatModel;
  const sourceExcerpt = normalizeSourceText(item.text).slice(0, 600);
  try {
    const prompt =
      `Summarize the following in 1-2 sentences for a civic-intelligence briefing about ` +
      `Crescent City, CA. Use ONLY facts explicitly present in the source. ` +
      `Do not infer identities, dates, causes, locations, or agencies. If the ` +
      `source lacks enough information, say that it is a limited source excerpt. ` +
      `Be factual and concise, with no preamble.\n\n` +
      `Title: ${item.title}\n\nSource excerpt:\n${normalizeSourceText(item.text).slice(0, 4000) || '(no article body was supplied by the feed)'}`;
    const summary = cleanSummary(await withAbortTimeout(signal => chatWithConfiguredProvider(prompt, signal), SUMMARY_TIMEOUT_MS, `Summary for ${item.id}`, parentSignal));
    if (!summary) throw new Error('Provider returned an empty summary');
    if (summary.length > SUMMARY_MAX_CHARS) throw new Error(`Provider returned a summary longer than ${SUMMARY_MAX_CHARS} characters`);
    return { summary, status: 'ok', provider, model, retryable: false };
  } catch (err: unknown) {
    parentSignal?.throwIfAborted();
    logger.warn(`Summary unavailable for item ${item.id}`, { error: errorMessage(err), source: item.source });
    return {
      summary: sourceExcerpt ? `Source-only excerpt: ${sourceExcerpt}` : 'Summary unavailable: the source did not provide article text.',
      status: sourceExcerpt ? 'source_only' : 'unavailable',
      provider,
      model,
      error: errorMessage(err),
      retryable: true,
    };
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

// ─── Structured enrichment (per-item tags, salience, neutral summary) ─────

/** Deterministic output contract of the structured enrichment pass. */
export interface CurationEnrichment {
  entityTags: string[];
  topicTags: string[];
  salience: number;
  salienceRationale: string;
  neutralSummary: string;
}

const ENRICHMENT_SCHEMA_HINT =
  '{"entityTags": ["<proper-noun entities: people, places, agencies>"], '
  + '"topicTags": ["<short lowercase topical keywords>"], '
  + '"salience": <number 0..1>, '
  + '"salienceRationale": "<one sentence why this matters or does not>", '
  + '"neutralSummary": "<one-sentence strictly source-grounded summary>"}';

const ENRICHMENT_SYSTEM_PROMPT =
  'You are a source-grounded civic-news indexer. Use ONLY facts explicitly present in the supplied excerpt. Never invent entities, dates, locations, or outcomes.';

/**
 * Validate a parsed structured value against the CurationEnrichment contract.
 * Exported so the recorded-fixture tests can exercise exactly what production runs.
 */
export function isCurationEnrichment(value: unknown): value is CurationEnrichment {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.entityTags) && v.entityTags.every(t => typeof t === 'string')
    && Array.isArray(v.topicTags) && v.topicTags.every(t => typeof t === 'string')
    && typeof v.salience === 'number' && Number.isFinite(v.salience) && v.salience >= 0 && v.salience <= 1
    && typeof v.salienceRationale === 'string'
    && typeof v.neutralSummary === 'string' && v.neutralSummary.trim().length > 0
    && v.neutralSummary.length <= SUMMARY_MAX_CHARS;
}

/**
 * Structured per-item enrichment via queryStructured: entity/topic tags,
 * 0-1 salience with rationale, and one-line neutral summary. Returns null on
 * provider failure or malformed output — callers keep the deterministic
 * keyword tags already computed by tagWithDomains and simply omit the
 * enrichment fields (additive, never blocking).
 */
export async function enrichCurationInput(item: CurationInput, signal?: AbortSignal): Promise<CurationEnrichment | null> {
  signal?.throwIfAborted();
  if (item.contentKind === 'document-listing') return null;
  try {
    const { queryStructured } = await import('./llm/structured.js');
    const prompt =
      `Index the following civic item about Crescent City, CA.\n\n`
      + `Title: ${item.title}\n\nSource excerpt:\n`
      + `${normalizeSourceText(item.text).slice(0, 4000) || '(no article body was supplied by the feed)'}`;
    const result = await queryStructured<CurationEnrichment>(prompt, {
      schemaHint: ENRICHMENT_SCHEMA_HINT,
      systemPrompt: ENRICHMENT_SYSTEM_PROMPT,
      signal,
    }, isCurationEnrichment);
    signal?.throwIfAborted();
    return result.value;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

// ─── Main curation run ─────────────────────────────────────────────────

/**
 * Curate every not-yet-curated item currently in output/{news,gov_meetings,youtube}.
 * Idempotent — re-running with no new upstream items curates nothing.
 */
/** Select the newest retained source revision; unknown acquisition dates never outrank recorded ones. */
export function selectCurationRevisions(inputs: readonly CurationInput[]): CurationInput[] {
  const timestamp = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : Number.NEGATIVE_INFINITY;
  const selected = new Map<string, CurationInput>();
  for (const item of [...inputs].sort((a, b) => a.id.localeCompare(b.id)
    || (timestamp(b.fetchedAt) === timestamp(a.fetchedAt) ? 0 : timestamp(b.fetchedAt) - timestamp(a.fetchedAt))
    || b.text.length - a.text.length || a.title.localeCompare(b.title) || a.text.localeCompare(b.text))) {
    if (!selected.has(item.id)) selected.set(item.id, item);
  }
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}
export async function runCuration(options: ProducerOptions = {}): Promise<CuratedItem[]> {
  const deadlineMs = options.deadlineMs ?? 3_600_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 3_600_000) throw new Error('Curation deadline must be 1..3600000 ms');
  const signal = boundedSignal(options.signal, deadlineMs);
  signal.throwIfAborted();
  return withProducerScope('curation', { ...options, signal, deadlineMs }, () => withProviderBudget(() => runCurationWithinBudget(signal)));
}
async function runCurationWithinBudget(signal: AbortSignal): Promise<CuratedItem[]> {
  logger.info('=== Starting Crescent City Curation ===');
  const startedAt = new Date().toISOString();
  const runId = createRunId('curation', startedAt);
  const releaseLock = await acquireCurationLock(signal);

  const attemptPath = join(paths.state, 'latest-curation-attempt.json');
  let completedCount = 0;
  let reusedCount = 0;
  try {
    signal.throwIfAborted();
    await writeJsonAtomic(attemptPath, { schemaVersion: 'curation-attempt/v1', runId, startedAt, status: 'running', completedCount, reusedCount }, { signal });
    const idempotency = new IdempotencyStore(curationSeenPath());
    await idempotency.load();

    const inputs = await gatherCurationInputs();
    // Historical batches can contain the same item more than once. Collapse
    // before scheduling provider work so one run cannot issue duplicate LLM
    // requests for an unchanged source record.
    // Pick one deterministic representation when the same source appears in
    // several historical batches: newest fetchedAt wins, with stable ties.
    const uniqueInputs = selectCurationRevisions(inputs);
    const retained = await retainedCuratedRecords(signal);
    const inputFingerprints = new Map<string, string>();
    for (const item of uniqueInputs) {
      const { provider, model } = curationIdentity(item);
      inputFingerprints.set(item.id, await computeSha256(JSON.stringify({
        id: item.id,
        source: item.source,
        title: normalizeSourceText(item.title),
        text: normalizeSourceText(item.text),
        provider,
        model,
        promptVersion: CURATION_PROMPT_VERSION,
        ...(item.contentKind ? { contentKind: item.contentKind } : {}),
      })));
    }
    // A crash after artifact promotion but before store persistence must not
    // repeat completed provider work. Reconcile only one exact source-bound
    // record; ambiguity, altered lineage and degraded records require a retry.
    for (const item of uniqueInputs) {
      signal.throwIfAborted();
      const fingerprint = inputFingerprints.get(item.id) ?? '';
      const { provider, model } = curationIdentity(item);
      if (isCurationRecordComplete(idempotency.get(item.id), fingerprint, provider, model)) continue;
      const matches = (retained.get(item.id) ?? []).filter(record => isRetainedCurationComplete(record, item, fingerprint, provider, model));
      if (matches.length !== 1) continue;
      idempotency.seen(item.id, fingerprint, { source: item.source, promptVersion: CURATION_PROMPT_VERSION, provider, model, summaryStatus: item.contentKind ? 'source_only' : 'ok', ...(item.contentKind ? { contentKind: item.contentKind, retryable: false } : {}) });
      reusedCount++;
    }
    if (reusedCount) await idempotency.save({ signal });
    await pruneCuratedArtifacts(new Set(uniqueInputs.map(item => item.id)), signal);
    const toCurate = uniqueInputs.filter((item) => {
      const record = idempotency.get(item.id);
      const { provider, model } = curationIdentity(item);
      const fingerprint = inputFingerprints.get(item.id) ?? '';
      const visible = (retained.get(item.id) ?? []).filter(row => isRetainedCurationVisible(row, item, fingerprint, provider, model));
      return !isCurationRecordComplete(record, fingerprint, provider, model) || visible.length !== 1;
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
        reusedCount,
        outputPath: null,
        providerChecked: false,
        providerReachable: false,
      };
      await idempotency.publish(paths.output, [
        { path: relative(paths.output, paths.curationReport), text: `${JSON.stringify(emptyReport, null, 2)}\n` },
        { path: relative(paths.output, attemptPath), text: `${JSON.stringify({ schemaVersion: 'curation-attempt/v1', runId, startedAt, completedAt: emptyReport.completedAt, status: 'complete', completedCount, reusedCount }, null, 2)}\n` },
      ], { signal });
      logger.info('No new items to curate');
      return [];
    }

    // Check the selected provider once before a batch. Without this guard, an
    // unreachable OpenRouter endpoint would spend the per-item summary timeout
    // on every input even though the whole run is already known to be degraded.
    // Items remain retryable because unavailable summaries are never recorded
    // as successfully curated below.
    const providerChecked = toCurate.some(item => item.contentKind !== 'document-listing');
    const providerHealth = providerChecked ? await checkChatProvider({ signal }) : { provider: 'none' as const, model: DOCUMENT_LISTING_MODEL, configured: true, reachable: false, error: undefined };
    signal.throwIfAborted();
    const providerError = providerChecked && (!providerHealth.configured || !providerHealth.reachable)
      ? providerHealth.error ?? `${providerHealth.provider} chat provider is unavailable`
      : undefined;
    if (providerError) logger.warn('Curation provider preflight failed; retaining source-only items for retry', { error: providerError });

    const curated: CuratedItem[] = [];
    let succeededCount = 0;
    let retryableCount = 0;
    let sourceOnlyCount = 0;
    for (const [i, item] of toCurate.entries()) {
      signal.throwIfAborted();
      // Space out requests when using OpenRouter so a burst of new items
      // doesn't blow through the free-tier per-minute rate limit and degrade
      // every item to "summary unavailable". Ollama has no such external limit.
      if (i > 0 && item.contentKind !== 'document-listing' && !providerError && llmConfig.provider === 'openrouter') {
        await waitWithSignal(llmConfig.openrouterMinRequestIntervalMs, signal);
      }
      const summary = item.contentKind === 'document-listing' ? documentListingSummary(item) : providerError
        ? {
            summary: normalizeSourceText(item.text)
              ? `Source-only excerpt: ${normalizeSourceText(item.text).slice(0, 600)}`
              : 'Summary unavailable: the source did not provide article text.',
            status: normalizeSourceText(item.text) ? 'source_only' as const : 'unavailable' as const,
            provider: providerHealth.provider,
            model: providerHealth.model,
            error: providerError,
            retryable: true,
          }
        : await summarizeItemDetailed(item, signal);
      if (summary.status === 'ok') succeededCount++;
      if (summary.retryable) retryableCount++;
      if (summary.status === 'source_only') sourceOnlyCount++;
      const inputFingerprint = inputFingerprints.get(item.id) ?? await computeSha256(item.text);
      const evidence = buildCurationEvidence(item, inputFingerprint);
      const tags = tagWithDomains(item);
      // Structured enrichment is best-effort and additive: a failed/null
      // enrichment never downgrades or blocks the curation record itself.
      const enrichment = summary.status === 'ok' ? await enrichCurationInput(item, signal) : null;
      curated.push({
        id: item.id,
        source: item.source,
        ...(item.contentKind ? { contentKind: item.contentKind } : {}),
        title: item.title,
        link: item.link,
        summary: summary.summary,
        tags,
        curatedAt: new Date().toISOString(),
        summaryStatus: summary.status,
        provider: summary.provider,
        model: summary.model,
        sourceExcerpt: normalizeSourceText(item.text).slice(0, 600),
        provenance: evidence.provenance,
        inputFingerprint: evidence.inputFingerprint,
        promptVersion: CURATION_PROMPT_VERSION,
        citations: evidence.citations,
        retryable: summary.retryable,
        ...(summary.error ? { error: summary.error } : {}),
        ...(enrichment ? {
          entityTags: enrichment.entityTags,
          topicTags: enrichment.topicTags,
          salience: enrichment.salience,
          salienceRationale: enrichment.salienceRationale,
          neutralSummary: enrichment.neutralSummary,
        } : {}),
      });
      // A failed provider call stays retryable. The source-only fallback is
      // retained as evidence for this run but is not treated as a successful
      // LLM curation result.
      signal.throwIfAborted();
      completedCount++;
      await writeJsonAtomic(attemptPath, { schemaVersion: 'curation-attempt/v1', runId, startedAt, status: 'running', completedCount, reusedCount, inputCount: toCurate.length }, { signal });
      if (summary.status === 'ok' || item.contentKind === 'document-listing' && !summary.retryable) {
        idempotency.seen(item.id, inputFingerprint, { source: item.source, promptVersion: CURATION_PROMPT_VERSION, provider: summary.provider, model: summary.model, summaryStatus: summary.status, ...(item.contentKind ? { contentKind: item.contentKind, retryable: false } : {}) });
      }
    }

    signal.throwIfAborted();
    await mkdir(curatedDir(), { recursive: true });
    const dateStamp = new Date().toISOString().slice(0, 10);
    const outPath = join(curatedDir(), `${dateStamp}.json`);

    // Upsert by stable source id. Failed/provider-unavailable attempts remain
    // retryable, but repeated runs must not append identical visible records.
    let existing: CuratedItem[] = [];
    if (existsSync(outPath)) {
      try {
        existing = JSON.parse(await readFile(outPath, 'utf-8'));
      } catch {
        throw new Error('Curated artifact became corrupt during this run; preserve it before repair');
      }
      if (!Array.isArray(existing)) throw new Error('Curated artifact became invalid during this run');
    }
    signal.throwIfAborted();
    signal.throwIfAborted();

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
      reusedCount,
      outputPath: outPath,
      providerChecked,
      providerReachable: providerHealth.reachable,
      ...(providerError ? { providerError } : {}),
    };
    signal.throwIfAborted();
    await idempotency.publish(paths.output, [
      { path: relative(paths.output, outPath), text: `${JSON.stringify(mergeCuratedItems(existing, curated), null, 2)}\n` },
      { path: relative(paths.output, paths.curationReport), text: `${JSON.stringify(curationReport, null, 2)}\n` },
      { path: relative(paths.output, attemptPath), text: `${JSON.stringify({ schemaVersion: 'curation-attempt/v1', runId, startedAt, completedAt: new Date().toISOString(), status: 'complete', completedCount, reusedCount }, null, 2)}\n` },
    ], { signal });
    logger.info('Curation complete', { generatedCount: succeededCount, sourceOnlyCount, reusedCount, retryableCount });
    return curated;
  } catch (error) {
    await writeJsonAtomic(attemptPath, { schemaVersion: 'curation-attempt/v1', runId, startedAt, completedAt: new Date().toISOString(), status: signal.aborted ? 'interrupted' : 'failed', completedCount, reusedCount, reason: signal.aborted ? 'cancelled-or-deadline' : 'run-failed' }, { signal: null });
    throw error;
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
