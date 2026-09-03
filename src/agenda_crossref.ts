#!/usr/bin/env bun
/**
 * Agenda → municipal-code cross-reference (TODO Phase 4.2, part 2).
 *
 * For each agenda/minutes link-item title, run the real BM25 index over the
 * scraped municipal-code corpus and keep the top-k scoring sections. This
 * connects the civic meeting record (what the city discussed) to the legal
 * record (what the code says about it) without any LLM in the loop.
 *
 * Deterministic and offline: the index is built from the local scraped
 * corpus by `initSearch()`; no network calls are made here.
 */
import { htmlToText } from './utils.js';
import { initSearch, search } from './gui/search.js';
import { createLogger } from './logger.js';

const logger = createLogger('agenda-crossref');

/** One topic → code-section association. */
export interface AgendaCodeRef {
  topic: string;
  agendaUrl: string;
  guid: string;
  sectionNumber: string;
  sectionTitle: string;
  articleTitle: string;
  /** BM25 score of the association (higher = stronger topical match). */
  score: number;
}

/** Topics shorter than this cannot match the BM25 vocabulary meaningfully. */
const MIN_TOPIC_LENGTH = 4;
/** Hard bound on distinct topics processed per report (batch files repeat items). */
const MAX_TOPICS = 12;

/**
 * Cross-reference agenda topics to municipal-code sections.
 *
 * Deduplicates topics, bounds the work, then searches the real BM25 index.
 * A topic whose search throws is skipped (logged), never fatal. Returns []
 * when no usable topic is supplied — without touching the index.
 */
export async function crossReferenceAgendaTopics(
  topics: Array<{ title: unknown; url?: unknown }>,
  refsPerTopic = 3,
): Promise<AgendaCodeRef[]> {
  const seen = new Set<string>();
  const bounded: Array<{ title: string; url: string }> = [];
  for (const topic of topics ?? []) {
    if (bounded.length >= MAX_TOPICS) break;
    if (!topic || typeof topic.title !== 'string') continue;
    // Agenda links are often document titles ("August 20, 2026 Agenda.pdf")
    // carrying HTML entities — decode, drop the file suffix, collapse spaces.
    const title = htmlToText(topic.title)
      .replace(/\.(pdf|PDF)\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (title.length < MIN_TOPIC_LENGTH || seen.has(title)) continue;
    seen.add(title);
    bounded.push({ title, url: typeof topic.url === 'string' ? topic.url : '' });
  }
  if (bounded.length === 0) return [];

  await initSearch();
  const refs: AgendaCodeRef[] = [];
  for (const topic of bounded) {
    try {
      const { results } = search(topic.title, { limit: refsPerTopic });
      for (const result of results) {
        refs.push({
          topic: topic.title,
          agendaUrl: topic.url,
          guid: result.section.guid,
          sectionNumber: result.section.number,
          sectionTitle: result.section.title,
          articleTitle: result.section.articleTitle,
          score: result.matchCount,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Cross-ref search failed for topic "${topic.title}"`, { error: message });
    }
  }
  return refs;
}
