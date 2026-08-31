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
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { chunkText } from './llm/embeddings.js';
import { embedBatch } from './llm/ollama.js';
import { addDocuments } from './llm/chroma.js';
import { llmConfig } from './llm/config.js';
import { paths } from './shared/paths.js';
import { sourceHealth, errorMessage, writeJsonAtomic } from './shared/source_health.js';
import type { SourceHealth } from './types.js';
import { DOMParser } from '@xmldom/xmldom';

const logger = createLogger('youtube_monitor');

/** Official City of Crescent City, California YouTube channel — confirmed live 2026-07-23. */
export const YOUTUBE_CHANNEL_URL = 'https://www.youtube.com/c/CityofCrescentCityCalifornia/videos';
export const YOUTUBE_CHANNEL_ID = 'UCc8LIkDxscuciAFNB9yEEMA';
export const YOUTUBE_RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`;
const YOUTUBE_CHANNEL_NAME = 'City of Crescent City, California';

const YOUTUBE_OUTPUT_DIR = join(process.cwd(), 'output', 'youtube');
/** Lives under output/state/, NOT output/youtube/ — keeps every consumer
 * that lists output/youtube/*.json (e.g. curation.ts's gatherYouTubeItems)
 * from having to remember to filter this state file out. */
const SEEN_VIDEOS_PATH = join(process.cwd(), 'output', 'state', 'youtube-seen-videos.json');
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
  try {
    const proc = Bun.spawn(['yt-dlp', ...args], { stdout: 'pipe', stderr: 'pipe' });
    type Completed = { stdout: string; stderr: string; exitCode: number };
    const completed = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode } satisfies Completed));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<Completed>((resolve) => {
      timer = setTimeout(() => {
        // Kill immediately and resolve independently of pipe closure. Some
        // yt-dlp failure paths leave a descendant holding stdout/stderr open;
        // waiting for those streams would defeat the timeout contract.
        try { proc.kill(9); } catch { /* process already exited */ }
        resolve({
          stdout: '',
          stderr: `yt-dlp timed out after ${YT_DLP_TIMEOUT_MS}ms`,
          exitCode: -2,
        });
      }, YT_DLP_TIMEOUT_MS);
    });
    const result = await Promise.race([completed, timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  } catch (err: any) {
    // yt-dlp not on PATH, or spawn failure
    return { stdout: '', stderr: err.message ?? String(err), exitCode: -1 };
  }
}

async function listChannelVideosFromRss(
  channelUrl: string,
  limit: number,
): Promise<YouTubeListingResult> {
  const checkedAt = new Date().toISOString();
  const response = await fetch(YOUTUBE_RSS_URL, {
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
    health: sourceHealth('YouTube', videos.length > 0 ? 'ok' : 'empty', checkedAt, {
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
      health: sourceHealth('YouTube', 'unavailable', checkedAt, {
        url: channelUrl,
        itemCount: 0,
        error: 'Invalid YouTube channel URL',
        provenance: 'yt-dlp channel listing',
      }),
    };
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return {
      videos: [],
      health: sourceHealth('YouTube', 'unavailable', checkedAt, {
        url: channelUrl,
        itemCount: 0,
        error: `Unsupported channel URL protocol: ${parsedUrl.protocol}`,
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
        health: sourceHealth('YouTube', 'unavailable', checkedAt, {
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
    health: sourceHealth('YouTube', videos.length > 0 ? 'ok' : 'empty', checkedAt, {
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
  outDir: string = YOUTUBE_OUTPUT_DIR
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

/**
 * Chunk and index a transcript into ChromaDB, tagged `sourceType:
 * "youtube_transcript"` so RAG citations can distinguish it from municipal
 * code chunks (ISC-19, ISC-20). No-op (returns 0) for a non-'ok' transcript.
 */
export async function indexYouTubeTranscript(transcript: YouTubeTranscript): Promise<number> {
  if (transcript.status !== 'ok' || transcript.segments.length === 0) return 0;

  const timeline = buildOffsetTimeline(transcript.segments);
  const chunks = chunkText(timeline.text);
  if (chunks.length === 0) return 0;

  const ids: string[] = [];
  const metadatas: Record<string, string>[] = [];
  let cursor = 0;
  for (let i = 0; i < chunks.length; i++) {
    ids.push(`youtube_${transcript.videoId}_${i}`);
    metadatas.push({
      sourceType: 'youtube_transcript',
      videoId: transcript.videoId,
      videoTitle: transcript.title,
      uploadDate: transcript.uploadDate,
      timestamp: timestampForOffset(cursor, timeline),
      chunkIndex: String(i),
    });
    cursor += Math.max(1, chunks[i].length - llmConfig.chunkOverlap);
  }

  const embeddings = await embedBatch(chunks);
  await addDocuments({ ids, embeddings, documents: chunks, metadatas });
  return chunks.length;
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
export async function monitorYouTube(limit = 15): Promise<YouTubeTranscript[]> {
  logger.info('=== Starting Crescent City YouTube Meeting Monitoring ===');

  const idempotency = new IdempotencyStore(SEEN_VIDEOS_PATH);
  await idempotency.load();

  const listing = await listChannelVideosDetailed(YOUTUBE_CHANNEL_URL, limit);
  const videos = listing.videos;
  const results: YouTubeTranscript[] = [];
  let newCount = 0;
  let extractionFailures = 0;
  let indexingFailures = 0;

  for (const video of videos) {
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

    await mkdir(YOUTUBE_OUTPUT_DIR, { recursive: true });
    await writeFile(join(YOUTUBE_OUTPUT_DIR, `${video.id}.json`), JSON.stringify(transcript, null, 2));

    if (transcript.status === 'ok') {
      const indexed = await indexYouTubeTranscript(transcript).catch((err: any) => {
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
    await idempotency.save();
  }

  const health: SourceHealth = listing.health.status === 'unavailable'
    ? listing.health
    : extractionFailures > 0 || indexingFailures > 0
      ? sourceHealth('YouTube', 'stale', new Date().toISOString(), {
        url: YOUTUBE_CHANNEL_URL,
        fetchedAt: listing.health.fetchedAt,
        itemCount: videos.length,
        error: `${extractionFailures} transcript extraction failure(s), ${indexingFailures} indexing failure(s)`,
        provenance: 'yt-dlp listing plus transcript/index pipeline',
      })
      : listing.health;
  await writeJsonAtomic(paths.youtubeHealth, {
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
