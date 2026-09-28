/**
 * Tests for src/agenda_crossref.ts (TODO Phase 4.2 part 2 — BM25 cross-ref of
 * agenda items to code sections). Uses the REAL BM25 index over the REAL local
 * scraped corpus (same dependency pattern as tests/data-loaders.test.ts);
 * zero mocks, zero network.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { crossReferenceAgendaTopics } from '../src/agenda_crossref';
import { reloadSearch } from '../src/gui/search';
import { invalidateSectionsCache } from '../src/shared/data';
import { beginSeedCorpus, endCorpusCopy } from './helpers/output-root';

// These tests assert real BM25 associations, so they need a populated corpus.
// The real `output/` corpus is gitignored, so a clean clone (and CI) saw an
// empty index and every association came back empty — the 2026-09-28 release-
// gate failures. Seed the REAL tracked pages-data municipal code through the
// CC_OUTPUT_DIR seam instead: same corpus, present on every checkout.
beforeAll(async () => {
  await beginSeedCorpus();
  invalidateSectionsCache();
  await reloadSearch();
});
afterAll(async () => {
  await endCorpusCopy();
  invalidateSectionsCache();
  await reloadSearch();
});

describe('crossReferenceAgendaTopics', () => {
  test('associates agenda topics with municipal-code sections via real BM25', async () => {
    const refs = await crossReferenceAgendaTopics(
      [
        { title: 'tsunami preparedness', url: 'https://www.crescentcity.org/events/9/' },
        { title: 'harbor district', url: '' },
      ],
      2,
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(typeof ref.topic).toBe('string');
      expect(ref.sectionNumber.length).toBeGreaterThan(0);
      expect(ref.score).toBeGreaterThan(0);
      expect(['tsunami preparedness', 'harbor district']).toContain(ref.topic);
    }
    // refsPerTopic bounds the associations per distinct topic.
    const perTopic = new Map<string, number>();
    for (const ref of refs) perTopic.set(ref.topic, (perTopic.get(ref.topic) ?? 0) + 1);
    for (const count of perTopic.values()) expect(count).toBeLessThanOrEqual(2);
  }, 60_000);

  test('skips unusable topics and never searches for an empty set', async () => {
    expect(await crossReferenceAgendaTopics([])).toEqual([]);
    const refs = await crossReferenceAgendaTopics([
      { title: 'ab' },
      { title: null },
      { title: '   ' },
      { title: 'abc' },
      { title: 42 },
      { title: 'tsunami', url: 'https://www.crescentcity.org/events/1/' },
    ]);
    // Only the one usable topic survives the guard; short/malformed ones are
    // skipped without touching the index.
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every(ref => ref.topic === 'tsunami')).toBe(true);
    expect(refs.every(ref => ref.agendaUrl === 'https://www.crescentcity.org/events/1/')).toBe(true);
  }, 60_000);

  test('decodes HTML entities and strips document-file suffixes from titles', async () => {
    const refs = await crossReferenceAgendaTopics([{ title: 'Council&nbsp;Agendas.pdf', url: '' }], 1);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every(ref => ref.topic === 'Council Agendas')).toBe(true);
  }, 60_000);
});
