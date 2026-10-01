#!/usr/bin/env bun
/**
 * YouTube meeting transcript pipeline for Crescent City.
 *
 * Lists recent videos from the city's official YouTube channel (city
 * council / planning commission / harbor commission meetings, town halls,
 * workshops) via yt-dlp, pulls auto-generated captions for new videos, and
 * indexes the transcript text into ChromaDB alongside municipal code chunks
 * so RAG chat can cite spoken meeting content.
 *
 * Requires the `yt-dlp` CLI on PATH (verified working: 2026.07.04+; an
 * older 2026.02.04 install failed YouTube's current JS challenge on real
 * target videos — see the extractor-args note on YT_DLP_EXTRACTOR_ARGS).
 *
 * Usage:
 *   bun run src/youtube_monitor.ts
 *   bun run youtube
 *
 * Output: JSON transcripts written to output/youtube/<video-id>.json
 */
import { createLogger } from './logger.js';
import { IdempotencyStore } from './shared/idempotency.js';
import { mkdir, writeFile, readFile, unlink, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { chunkText } from './llm/embeddings.js';
import { embedBatch } from './llm/ollama.js';
import { addDocuments, getDocuments, getDocumentIds, servingCollectionName, discardCollection } from './llm/chroma.js';
import { llmConfig } from './llm/config.js';
import { paths, outputRoot } from './shared/paths.js';
import { boundedHttpFetch, withinDeadline, throwIfAborted } from './shared/transport.js';
import { withFileLease } from './shared/storage.js';
import { indexConfigSignature, type IndexManifest, type PlannedChunk } from './llm/index_plan.js';
import { custodyHash } from './corpus_editions.js';
import { EMBED_BATCH_SIZE } from './constants.js';
import { runBoundedChild } from './shared/subprocess.js';
import { withProducerScope, currentRunSignal, type ProducerOptions } from './shared/run_scope.js';
import { sourceHealth, errorMessage, writeJsonAtomic } from './shared/source_health.js';
import { sourceIdForMonitor } from './source_registry.js';
import type { SourceHealth } from './types.js';
import { DOMParser } from '@xmldom/xmldom';

const logger = createLogger('youtube_monitor');

function youtubeSourceHealth(...args: Parameters<typeof sourceHealth>): SourceHealth {
  const [name, status, checkedAt, details] = args;
  return sourceHealth(name, status, checkedAt, { ...details, sourceId: sourceIdForMonitor('youtube') });
}

/** Official City of Crescent City, California YouTube channel — confirmed live 2026-07-23. */
export const YOUTUBE_CHANNEL_URL = 'https://www.youtube.com/c/CityofCrescentCityCalifornia/videos';
export const YOUTUBE_CHANNEL_ID = 'UCc8LIkDxscuciAFNB9yEEMA';
export const YOUTUBE_RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`;
const YOUTUBE_CHANNEL_NAME = 'City of Crescent City, California';

const youtubeOutputDir = () => join(outputRoot(), 'youtube');
/** Lives under output/state/, NOT output/youtube/ — keeps every consumer
 * that lists output/youtube/*.json (e.g. curation.ts's gatherYouTubeItems)
 * from having to remember to filter this state file out. */
const seenVideosPath = () => join(outputRoot(), 'state', 'youtube-seen-videos.json');
const YT_DLP_TIMEOUT_MS = Number(process.env.YT_DLP_TIMEOUT_MS ?? '45000');

/**
 * yt-dlp player-client extractor args required to avoid YouTube's current
 * "n challenge" / SABR-streaming gate. Empirically determined live
 * 2026-07-23 against a real target video (id 5FCYI7rt0_4, "07-08-26
 * Preferred Concepts Meeting - Town Hall") — without this flag, extraction
 * failed with "This video is not available" even on an up-to-date yt-dlp.
 * This WILL need updating again as YouTube's extraction internals evolve;
 * that's why every caller distinguishes extraction_failed from unavailable
 * rather than collapsing both into "no new content."
 */
const YT_DLP_EXTRACTOR_ARGS = 'youtube:player_client=tv,web_safari,android';
/** One retry per video: extraction is occasionally transient on CI runners. */
const YT_DLP_ATTEMPTS = 2;

export interface YouTubeVideoListing {
  id: string;
  title: string;
  uploadDate: string; // yt-dlp %(upload_date)s (YYYYMMDD), or 'NA' if unknown
}

export interface YouTubeListingResult {
  videos: YouTubeVideoListing[];
  health: SourceHealth;
}

export interface TranscriptSegment {
  /** VTT cue start timestamp, "HH:MM:SS.mmm" */
  start: string;
  text: string;
}

export type TranscriptStatus = 'ok' | 'unavailable' | 'extraction_failed';

export interface YouTubeTranscript {
  videoId: string;
  title: string;
  channel: string;
  uploadDate: string;
  fetchedAt: string;
  /**
   * 'unavailable' = yt-dlp ran successfully but the video has no captions.
   * 'extraction_failed' = yt-dlp itself errored (e.g. a JS-challenge
   * regression). These are deliberately distinct — collapsing them would
   * make a temporary extraction outage indistinguishable from "nothing new
   * to transcribe," silently hiding a pipeline break (Anti-criterion ISC-24).
   */
  status: TranscriptStatus;
  segments: TranscriptSegment[];
  fullText: string;
}

async function runYtDlp(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await runBoundedChild(['yt-dlp', ...args], { timeoutMs: YT_DLP_TIMEOUT_MS });
  return { stdout: result.stdout, stderr: result.status === 'timeout' ? `yt-dlp timed out after ${YT_DLP_TIMEOUT_MS}ms (process group reaped: ${result.reaped})` : result.stderr, exitCode: result.status === 'ok' || result.status === 'failed' ? result.exitCode : -2 };
}

async function listChannelVideosFromRss(
  channelUrl: string,
  limit: number,
): Promise<YouTubeListingResult> {
  const checkedAt = new Date().toISOString();
  const response = await boundedHttpFetch(YOUTUBE_RSS_URL, {
    headers: { Accept: 'application/atom+xml, application/xml' },
    signal: AbortSignal.timeout(YT_DLP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`YouTube channel RSS returned ${response.status}: ${response.statusText}`);
  const xml = await response.text();
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const entries = document.getElementsByTagName('entry');
  const videos: YouTubeVideoListing[] = [];
  for (let index = 0; index < entries.length && videos.length < limit; index += 1) {
    const entry = entries[index];
    const id = entry.getElementsByTagName('yt:videoId')[0]?.textContent?.trim() ?? '';
    const title = entry.getElementsByTagName('title')[0]?.textContent?.trim() ?? '';
    const published = entry.getElementsByTagName('published')[0]?.textContent?.trim() ?? '';
    if (!id) continue;
    const date = Date.parse(published);
    videos.push({
      id,
      title,
      uploadDate: Number.isFinite(date) ? new Date(date).toISOString().slice(0, 10).replaceAll('-', '') : 'NA',
    });
  }
  return {
    videos,
    health: youtubeSourceHealth('YouTube', videos.length > 0 ? 'ok' : 'empty', checkedAt, {
      url: channelUrl,
      fetchedAt: checkedAt,
      itemCount: videos.length,
      provenance: 'Official YouTube channel Atom feed fallback; transcript extraction remains a separate yt-dlp capability',
    }),
  };
}

/** List recent videos from the channel via `yt-dlp --flat-playlist` (no download). */
export async function listChannelVideos(
  channelUrl: string = YOUTUBE_CHANNEL_URL,
  limit = 15
): Promise<YouTubeVideoListing[]> {
  return (await listChannelVideosDetailed(channelUrl, limit)).videos;
}

/** List videos with an explicit source-health outcome for operators and reports. */
export async function listChannelVideosDetailed(
  channelUrl: string = YOUTUBE_CHANNEL_URL,
  limit = 15,
): Promise<YouTubeListingResult> {
  const checkedAt = new Date().toISOString();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(channelUrl);
  } catch {
    return {
      videos: [],
      health: youtubeSourceHealth('YouTube', 'unavailable', checkedAt, {
        url: channelUrl,
        itemCount: 0,
        error: 'Invalid YouTube channel URL',
        provenance: 'yt-dlp channel listing',
      }),
    };
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || !['youtube.com', 'www.youtube.com'].includes(parsedUrl.hostname)) {
    return {
      videos: [],
      health: youtubeSourceHealth('YouTube', 'unavailable', checkedAt, {
        url: channelUrl,
        itemCount: 0,
        error: 'Channel URL must be a public HTTPS YouTube URL without credentials',
        provenance: 'yt-dlp channel listing',
      }),
    };
  }
  const { stdout, exitCode, stderr } = await runYtDlp([
    '--flat-playlist',
    '--playlist-end', String(limit),
    '--print', '%(id)s\t%(title)s\t%(upload_date)s',
    channelUrl,
  ]);

  if (exitCode !== 0) {
    logger.error('yt-dlp channel listing failed', { exitCode, stderr: stderr.slice(0, 500) });
    try {
      const fallback = await listChannelVideosFromRss(channelUrl, limit);
      fallback.health.error = `yt-dlp listing unavailable; ${fallback.health.provenance}`;
      return fallback;
    } catch (fallbackError) {
      return {
        videos: [],
        health: youtubeSourceHealth('YouTube', 'unavailable', checkedAt, {
          url: channelUrl,
          itemCount: 0,
          error: `${stderr.trim().slice(0, 500) || `yt-dlp exited with code ${exitCode}`}; RSS fallback failed: ${errorMessage(fallbackError)}`,
          provenance: 'yt-dlp channel listing with official Atom feed fallback',
        }),
      };
    }
  }

  const videos = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, title, uploadDate] = line.split('\t');
      return { id: id ?? '', title: title ?? '', uploadDate: uploadDate || 'NA' };
    })
    .filter((v) => v.id);

  return {
    videos,
    health: youtubeSourceHealth('YouTube', videos.length > 0 ? 'ok' : 'empty', checkedAt, {
      url: channelUrl,
      fetchedAt: checkedAt,
      itemCount: videos.length,
      provenance: 'yt-dlp channel listing',
    }),
  };
}

/**
 * Parse a YouTube auto-caption VTT file's contents into plain-text segments.
 *
 * YouTube's auto-captions render as a rolling window: consecutive cues
 * repeat the prior cue's text and grow it word-by-word (inline `<c>` word
 * tags carry per-word timestamps). Naively joining every cue's text
 * produces heavily duplicated output. This collapses each growing group
 * down to its fullest cue (keeping the earliest start time of the group),
 * which is a solid approximation for search/citation purposes — not a
 * guaranteed byte-perfect reconstruction of a human-edited transcript.
 */
export function parseVtt(vttContent: string): TranscriptSegment[] {
  const lines = vttContent.split(/\r?\n/);
  const timeLineRe = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/;

  const rawCues: TranscriptSegment[] = [];
  let currentStart: string | null = null;
  let currentTextLines: string[] = [];

  const flush = () => {
    if (currentStart === null) return;
    const text = currentTextLines
      .join(' ')
      .replace(/<[^>]+>/g, '') // strip inline <c>word</c> / word-timestamp tags
      .replace(/\s+/g, ' ')
      .trim();
    if (text) rawCues.push({ start: currentStart, text });
    currentStart = null;
    currentTextLines = [];
  };

  for (const line of lines) {
    const m = line.match(timeLineRe);
    if (m) {
      flush();
      currentStart = m[1];
      continue;
    }
    if (line.trim() === '' || line.startsWith('WEBVTT') || line.startsWith('Kind:') || line.startsWith('Language:')) {
      continue;
    }
    if (currentStart !== null) currentTextLines.push(line);
  }
  flush();

  // Collapse growing-caption groups: if cue N's text is a superset (prefix
  // extension) of cue N-1's, replace N-1 with N but keep N-1's start time.
  // If cue N's text is a subset of what we already have, drop it.
  const segments: TranscriptSegment[] = [];
  for (const cue of rawCues) {
    const prev = segments[segments.length - 1];
    if (!prev) {
      segments.push(cue);
      continue;
    }
    if (cue.text === prev.text) continue; // exact duplicate
    if (cue.text.startsWith(prev.text)) {
      segments[segments.length - 1] = { start: prev.start, text: cue.text }; // fuller version, keep original start
      continue;
    }
    if (prev.text.startsWith(cue.text)) continue; // prev already more complete
    segments.push(cue);
  }
  return segments;
}

/**
 * Extract the auto-caption transcript for a single video via yt-dlp.
 * Never throws — every failure mode resolves to a status field the caller
 * can branch on (ISC-16, ISC-17).
 */
export async function extractTranscript(
  video: YouTubeVideoListing,
  outDir: string = youtubeOutputDir()
): Promise<YouTubeTranscript> {
  const fetchedAt = new Date().toISOString();
  const base = {
    videoId: video.id,
    title: video.title,
    channel: YOUTUBE_CHANNEL_NAME,
    uploadDate: video.uploadDate,
    fetchedAt,
  };

  await mkdir(outDir, { recursive: true });
  const outTemplate = join(outDir, `${video.id}.%(ext)s`);
  const vttPath = join(outDir, `${video.id}.en.vtt`);

  // Retry: extraction failures are occasionally transient (JS-challenge
  // rotation, runner egress); the second attempt distinguishes flaky from real.
  let exitCode = 1;
  let stderr = '';
  for (let attempt = 1; attempt <= YT_DLP_ATTEMPTS; attempt++) {
    const run = await runYtDlp([
      '--skip-download',
      '--write-auto-sub',
      '--sub-lang', 'en',
      '--sub-format', 'vtt',
      '--no-update',
      '--extractor-args', YT_DLP_EXTRACTOR_ARGS,
      '-o', outTemplate,
      `https://www.youtube.com/watch?v=${video.id}`,
    ]);
    exitCode = run.exitCode;
    stderr = run.stderr;
    if (exitCode === 0) break;
    logger.warn(`yt-dlp attempt ${attempt} failed for ${video.id}`, { exitCode });
  }

  if (exitCode !== 0) {
    logger.error(`yt-dlp extraction failed for video ${video.id}`, { exitCode, stderr: stderr.slice(0, 500) });
    return { ...base, status: 'extraction_failed', segments: [], fullText: '' };
  }

  if (!existsSync(vttPath)) {
    logger.warn(`No captions available for video ${video.id}`, { title: video.title });
    return { ...base, status: 'unavailable', segments: [], fullText: '' };
  }

  let vttContent: string;
  try {
    vttContent = await readFile(vttPath, 'utf-8');
  } catch (error) {
    logger.error(`Failed to read captions for video ${video.id}`, { error: String(error) });
    await unlink(vttPath).catch(() => {});
    return { ...base, status: 'extraction_failed', segments: [], fullText: '' };
  }
  const segments = parseVtt(vttContent);
  const fullText = segments.map((s) => s.text).join(' ');

  await unlink(vttPath).catch(() => {}); // structured JSON is the durable artifact, not the raw VTT

  return { ...base, status: 'ok', segments, fullText };
}

// ─── ChromaDB indexing (labeled sibling source to municipal code) ────────

interface OffsetTimeline {
  text: string;
  offsets: number[];
  starts: string[];
}

function buildOffsetTimeline(segments: TranscriptSegment[]): OffsetTimeline {
  let text = '';
  const offsets: number[] = [];
  const starts: string[] = [];
  for (const seg of segments) {
    offsets.push(text.length);
    starts.push(seg.start);
    text += (text ? ' ' : '') + seg.text;
  }
  return { text, offsets, starts };
}

function timestampForOffset(offset: number, timeline: OffsetTimeline): string {
  let result = timeline.starts[0] ?? '00:00:00.000';
  for (let i = 0; i < timeline.offsets.length; i++) {
    if (timeline.offsets[i] <= offset) result = timeline.starts[i];
    else break;
  }
  return result;
}

/** Exact transcript chunks shared by the individual producer and local reindex. */
export function planTranscriptChunks(transcript: YouTubeTranscript, sourceSha256: string): PlannedChunk[] {
  if (transcript.status !== 'ok') return [];
  if (!/^[A-Za-z0-9_-]{11}$/.test(transcript.videoId) || !Array.isArray(transcript.segments) || !transcript.segments.length || typeof transcript.title !== 'string' || typeof transcript.uploadDate !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('Malformed successful transcript');
  for (const segment of transcript.segments) {
    if (!segment || typeof segment.text !== 'string' || !segment.text.trim() || typeof segment.start !== 'string' || !/^\d{2,}:([0-5]\d):([0-5]\d)\.\d{3}$/.test(segment.start)) throw new Error('Malformed transcript cue');
  }
  const timeline = buildOffsetTimeline(transcript.segments);
  const chunks = chunkText(timeline.text);
  const configSignature = indexConfigSignature(llmConfig);
  return chunks.map((text, i) => ({
    id: `youtube_${transcript.videoId}_${i}`, text,
    metadata: { sourceType: 'youtube_transcript', videoId: transcript.videoId, videoTitle: transcript.title,
      uploadDate: transcript.uploadDate, timestamp: timestampForOffset(i * (llmConfig.chunkSize - llmConfig.chunkOverlap), timeline),
      chunkIndex: String(i), sourceSha256, configSignature },
  }));
}

/**
 * Index one acquired transcript. The shared writer lease prevents a concurrent
 * municipal edition from activating while the serving collection is selected.
 */
export async function indexYouTubeTranscript(transcript: YouTubeTranscript, options: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<number> {
  if (transcript.status !== 'ok' || transcript.segments.length === 0) return 0;
  const chunks = planTranscriptChunks(transcript, custodyHash(JSON.stringify(transcript)));
  return withinDeadline(async signal => withFileLease(join(paths.state, 'index-writer.lock'), async () => {
    const collection = await servingCollectionName();
    const embeddings = await embedBatch(chunks.map(chunk => chunk.text), { signal });
    await addDocuments({ ids: chunks.map(chunk => chunk.id), embeddings, documents: chunks.map(chunk => chunk.text), metadatas: chunks.map(chunk => chunk.metadata) }, { signal, collection });
    return chunks.length;
  }, { signal, waitMs: 1000 }), options.deadlineMs ?? 300_000, options.signal);
}

export interface TranscriptReindexReceipt {
  schemaVersion: 'retained-transcript-index/v1'; generatedAt: string; configSignature: string;
  servingCollection: string; previousCollection: string; transcriptCount: number; chunkCount: number;
  sources: Array<{ file: string; videoId: string; sourceSha256: string; chunkIds: string[] }>;
  evidenceBoundary: string;
}

async function retainedTranscriptSources(directory: string, signal: AbortSignal): Promise<Array<{ file: string; rawSha256: string; transcript: YouTubeTranscript | null }>> {
  throwIfAborted(signal);
  const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => /^[A-Za-z0-9_-]{11}\.json$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > 200) throw new Error('Retained transcript inventory exceeds 200 files');
  const sources = []; let bytes = 0;
  for (const entry of entries) {
    throwIfAborted(signal);
    if (!entry.isFile()) throw new Error('Retained transcript source must be a regular file');
    const file = Bun.file(join(directory, entry.name));
    if (file.size > 8 * 1024 * 1024 || (bytes += file.size) > 64 * 1024 * 1024) throw new Error('Retained transcript inventory exceeds byte cap');
    const bytesRead = new Uint8Array(await file.arrayBuffer());
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytesRead); const parsed = JSON.parse(raw) as YouTubeTranscript;
    if (!parsed || parsed.videoId !== entry.name.slice(0, -5) || !['ok', 'unavailable', 'extraction_failed'].includes(parsed.status)) throw new Error('Retained transcript source identity/status mismatch');
    if (parsed.status === 'ok') planTranscriptChunks(parsed, custodyHash(bytesRead));
    sources.push({ file: entry.name, rawSha256: custodyHash(bytesRead), transcript: parsed.status === 'ok' ? parsed : null });
  }
  return sources;
}

/**
 * Re-embed retained successful artifacts without listing/fetching YouTube.
 * Municipal vectors and transcripts are staged together, verified by exact IDs,
 * then activated by one atomic serving receipt. Old serving bytes are retained.
 */
export async function reindexRetainedYouTubeTranscripts(options: { signal?: AbortSignal; deadlineMs?: number; sourceDirectory?: string } = {}): Promise<TranscriptReindexReceipt> {
  const deadlineMs = options.deadlineMs ?? 900_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 3_600_000) throw new Error('Invalid retained-transcript index deadline');
  return withinDeadline(async signal => withFileLease(join(paths.state, 'index-writer.lock'), async () => {
    const directory = options.sourceDirectory ?? youtubeOutputDir();
    const sources = await retainedTranscriptSources(directory, signal);
    const eligible = sources.filter((source): source is typeof source & { transcript: YouTubeTranscript } => source.transcript !== null);
    if (!eligible.length) throw new Error('No retained successful transcript sources; reindex remains required');
    const previousBytes = await readFile(paths.indexManifest, 'utf8');
    const previous = JSON.parse(previousBytes) as IndexManifest;
    const configSignature = indexConfigSignature(llmConfig);
    if (previous.schemaVersion !== 2 || previous.configSignature !== configSignature || !previous.articles) throw new Error('Municipal serving geometry is not current; rebuild it before transcripts');
    if (previous.corpusManifestSha256 && custodyHash(await readFile(paths.manifest)) !== previous.corpusManifestSha256) throw new Error('Municipal source edition changed; rebuild it before transcripts');
    const priorCollection = await servingCollectionName();
    const codeIds = Object.values(previous.articles).flatMap(article => article.chunkIds);
    if (!codeIds.length || codeIds.length !== previous.chunkCount || new Set(codeIds).size !== codeIds.length) throw new Error('Invalid municipal index membership receipt');
    const available = new Set(await getDocumentIds({ signal, collection: priorCollection }));
    if (codeIds.some(id => !available.has(id))) throw new Error('Serving municipal vectors are incomplete');
    const staged = `${llmConfig.collectionName}-stage-${crypto.randomUUID()}`;
    try {
      for (let offset = 0; offset < codeIds.length; offset += EMBED_BATCH_SIZE) {
        const requested = codeIds.slice(offset, offset + EMBED_BATCH_SIZE);
        const batch = await getDocuments(requested, { signal, collection: priorCollection });
        if (batch.ids.length !== requested.length || new Set(batch.ids).size !== requested.length || batch.ids.some(id => !requested.includes(id))) throw new Error('Serving municipal vectors changed during transcript staging');
        await addDocuments(batch, { signal, collection: staged });
      }
      const chunks = eligible.flatMap(source => planTranscriptChunks(source.transcript, source.rawSha256));
      for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH_SIZE) {
        throwIfAborted(signal);
        const batch = chunks.slice(offset, offset + EMBED_BATCH_SIZE);
        const embeddings = await embedBatch(batch.map(chunk => chunk.text), { signal });
        await addDocuments({ ids: batch.map(chunk => chunk.id), embeddings, documents: batch.map(chunk => chunk.text), metadatas: batch.map(chunk => chunk.metadata) }, { signal, collection: staged });
      }
      const expected = new Set([...codeIds, ...chunks.map(chunk => chunk.id)]);
      const actual = new Set(await getDocumentIds({ signal, collection: staged }));
      if (actual.size !== expected.size || [...expected].some(id => !actual.has(id))) throw new Error('Staged transcript membership is incomplete');
      for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH_SIZE) {
        const requested = chunks.slice(offset, offset + EMBED_BATCH_SIZE);
        const actualChunks = await getDocuments(requested.map(chunk => chunk.id), { signal, collection: staged });
        for (const chunk of requested) {
          const i = actualChunks.ids.indexOf(chunk.id);
          if (i < 0 || actualChunks.documents[i] !== chunk.text || actualChunks.metadatas[i]?.sourceSha256 !== chunk.metadata.sourceSha256 || actualChunks.metadatas[i]?.configSignature !== configSignature || !actualChunks.embeddings[i]?.every(Number.isFinite)) throw new Error('Staged transcript content/geometry receipt mismatch');
        }
      }
      const repeated = await retainedTranscriptSources(directory, signal);
      if (JSON.stringify(sources.map(source => [source.file, source.rawSha256])) !== JSON.stringify(repeated.map(source => [source.file, source.rawSha256]))) throw new Error('Retained transcript sources changed during indexing');
      if (await readFile(paths.indexManifest, 'utf8') !== previousBytes) throw new Error('Serving receipt changed during transcript indexing');
      if (previous.corpusManifestSha256 && custodyHash(await readFile(paths.manifest)) !== previous.corpusManifestSha256) throw new Error('Municipal source edition changed during transcript indexing');
      const receipt: TranscriptReindexReceipt = { schemaVersion: 'retained-transcript-index/v1', generatedAt: new Date().toISOString(), configSignature, servingCollection: staged, previousCollection: priorCollection,
        transcriptCount: eligible.length, chunkCount: chunks.length, sources: eligible.map(source => ({ file: source.file, videoId: source.transcript.videoId, sourceSha256: source.rawSha256, chunkIds: chunks.filter(chunk => chunk.metadata.videoId === source.transcript.videoId).map(chunk => chunk.id) })),
        evidenceBoundary: 'Vectors bind exact retained transcript bytes and current embedding/chunk geometry. No source re-fetch or independent spoken-content verification was performed.' };
      throwIfAborted(signal);
      await writeJsonAtomic(paths.indexManifest, { ...previous, servingCollection: staged, previousCollection: priorCollection, transcriptReindexRequired: false, transcriptIndex: receipt }, { signal });
      return receipt;
    } catch (error) {
      await discardCollection(staged, { timeoutMs: 1000 }).catch(() => undefined);
      throw error;
    }
  }, { signal, waitMs: 1000, staleMs: 30_000 }), deadlineMs, options.signal);
}

// ─── Main monitor ──────────────────────────────────────────────────────

/**
 * Main YouTube monitoring function.
 *
 * Lists recent channel videos, idempotency-keys by video ID (a video's
 * caption availability doesn't change what "new" means — once processed,
 * never reprocessed, matching every other monitor's semantics), extracts
 * + indexes transcripts for new videos, and persists per-video JSON output.
 */
export async function monitorYouTube(limit = 15, options: ProducerOptions = {}): Promise<YouTubeTranscript[]> {
  return withProducerScope('youtube', options, () => monitorYouTubeOwned(limit));
}
async function monitorYouTubeOwned(limit: number): Promise<YouTubeTranscript[]> {
  logger.info('=== Starting Crescent City YouTube Meeting Monitoring ===');

  const idempotency = new IdempotencyStore(seenVideosPath());
  await idempotency.load();

  const listing = await listChannelVideosDetailed(YOUTUBE_CHANNEL_URL, limit);
  const videos = listing.videos;
  const results: YouTubeTranscript[] = [];
  let newCount = 0;
  let extractionFailures = 0;
  let indexingFailures = 0;

  for (const video of videos) {
    currentRunSignal()?.throwIfAborted();
    if (idempotency.has(video.id)) continue;
    // Defensive validation: video ids are used verbatim in file paths and the
    // yt-dlp `-o` template below. They originate from the official channel's
    // listing (trusted), but an unexpected malformed id must not escape the
    // output directory or be spliced into the subprocess template.
    if (!/^[A-Za-z0-9_-]{6,24}$/.test(video.id)) {
      logger.warn("Skipping video with invalid id", { id: video.id, title: video.title });
      continue;
    }
    newCount++;

    const transcript = await extractTranscript(video);
    results.push(transcript);

    await mkdir(youtubeOutputDir(), { recursive: true });
    await writeJsonAtomic(join(youtubeOutputDir(), `${video.id}.json`), transcript);

    if (transcript.status === 'ok') {
      const indexed = await indexYouTubeTranscript(transcript, { signal: currentRunSignal() }).catch((err: any) => {
        logger.error(`Failed to index transcript for video ${video.id}`, { error: err.message });
        indexingFailures++;
        return 0;
      });
      if (indexed > 0) idempotency.seen(video.id, '', { title: video.title, uploadDate: video.uploadDate, status: 'ok' });
      logger.info(`Transcribed video ${video.id}: ${video.title}`, {
        segments: transcript.segments.length,
        chunksIndexed: indexed,
      });
    } else if (transcript.status === 'unavailable') {
      // No captions is a terminal source fact; extraction failures remain
      // retryable so a transient yt-dlp/YouTube challenge is not lost.
      idempotency.seen(video.id, '', { title: video.title, uploadDate: video.uploadDate, status: transcript.status });
      logger.warn(`Video ${video.id} transcript ${transcript.status}`, { title: video.title });
    } else {
      extractionFailures++;
      logger.error(`Video ${video.id} transcript extraction failed; leaving it retryable`, { title: video.title });
    }
  }

  if (newCount > 0) {
    await idempotency.save({ signal: currentRunSignal() });
  }

  // Health semantics: the LISTING is the source of truth for freshness (fresh
  // video metadata = a healthy check). Transcript extraction failures are an
  // enrichment gap, not staleness — the previously indexed transcripts remain
  // valid and the failure count stays visible in the error field. Marking the
  // source stale here was the 2026-08-31 defect: fresh listings were reported
  // stale solely because YouTube JS-challenges the runner's transcript fetch.
  const transcriptGap = extractionFailures > 0 || indexingFailures > 0;
  const health: SourceHealth = listing.health.status === 'unavailable'
    ? listing.health
    : transcriptGap
      ? youtubeSourceHealth('YouTube', 'ok', new Date().toISOString(), {
        url: YOUTUBE_CHANNEL_URL,
        fetchedAt: listing.health.fetchedAt,
        itemCount: videos.length,
        error: `${extractionFailures} transcript extraction failure(s), ${indexingFailures} indexing failure(s) (transcript enrichment gap; listing fresh, prior transcripts intact)`,
        provenance: 'yt-dlp listing plus transcript/index pipeline',
      })
      : listing.health;
  await writeJsonAtomic(paths.youtubeHealth, {
    schemaVersion: 'crescent-city-source-health/v1',
    checkedAt: new Date().toISOString(),
    sources: [health],
  });

  logger.info(`=== YouTube Monitoring Complete: ${newCount} new video(s) processed ===`);
  return results;
}

if (import.meta.main) {
  monitorYouTube().catch((error: any) => {
    logger.error('YouTube monitoring failed', { error: error.message });
    process.exit(1);
  });
}
