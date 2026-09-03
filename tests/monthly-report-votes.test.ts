/**
 * Tests for the monthly-report meeting-votes + document-drift surface
 * (TODO Phase 4.2 part-2 acceptance: vote tables + PDF hash drift surfaced
 * in the meeting report). Pure builders only — filesystem use is confined
 * to a per-test temp directory; no live network, no mocks.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildMeetingVoteRows,
  collectDocumentDrift,
  renderMeetingVotesSection,
} from '../src/monthly_report';
import type { DocumentDrift } from '../src/minutes_extraction';

describe('buildMeetingVoteRows', () => {
  test('flattens item-level votes and voteTable entries', () => {
    const rows = buildMeetingVoteRows([
      {
        link: 'https://www.crescentcity.org/events/1/',
        date: '2026-09-01',
        title: 'City Council Meeting',
        source: 'City Council',
        vote: { yea: 5, nay: 0, abstain: 1, absent: 0, passed: true, inferred: false },
        voteTable: [
          { yea: 4, nay: 1, abstain: 0, absent: 1, passed: true, inferred: true },
        ],
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ yea: 5, nay: 0, abstain: 1, absent: 0, passed: true, inferred: false });
    expect(rows[1]).toMatchObject({ yea: 4, nay: 1, absent: 1, inferred: true });
  });

  test('deduplicates the same item seen in every monthly batch file', () => {
    const item = {
      link: 'https://www.crescentcity.org/events/2/',
      date: '2026-09-02',
      title: 'Planning Commission',
      vote: { yea: 3, nay: 2, abstain: 0, absent: 0, passed: true, inferred: true },
    };
    // The same item is repeated once per batch file in the month.
    expect(buildMeetingVoteRows([item, item, item])).toHaveLength(1);
  });

  test('drops rows without a finite yea/nay pair and non-object votes', () => {
    const rows = buildMeetingVoteRows([
      { link: 'a', vote: null },
      { link: 'b', vote: { yea: 'many', nay: undefined } },
      { link: 'c', vote: { yea: 2, nay: 1 } },
      'not-an-item',
      null,
      { voteTable: [{ yea: 1, nay: 0 }] },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ link: 'c', abstain: 0, absent: 0, passed: false });
    expect(rows[1]).toMatchObject({ link: '', title: 'Untitled', yea: 1 });
  });
});

describe('collectDocumentDrift', () => {
  const driftA: DocumentDrift = {
    url: 'https://www.crescentcity.org/documents/agenda.pdf',
    changed: true,
    isNew: false,
    previousHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    currentHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
  const driftB: DocumentDrift = {
    url: 'https://www.crescentcity.org/documents/minutes.pdf',
    changed: false,
    isNew: true,
    previousHash: null,
    currentHash: 'cccccccccccccccccccccccccccccccccccccccc',
  };

  test('unions month-matching batch drift with health-artifact drift, deduplicated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cci-monthly-drift-'));
    try {
      writeFileSync(
        join(dir, 'gov_meetings-in-month.json'),
        JSON.stringify({ fetchedAt: '2026-09-01T12:00:00.000Z', documentDrift: [driftA] }),
      );
      writeFileSync(
        join(dir, 'gov_meetings-other-month.json'),
        JSON.stringify({ fetchedAt: '2026-08-01T12:00:00.000Z', documentDrift: [driftB] }),
      );
      writeFileSync(join(dir, 'not-a-batch.json'), JSON.stringify([1, 2, 3]));
      // Health artifact repeats driftA (latest run = the in-month batch) and adds driftB.
      const drift = collectDocumentDrift(dir, '2026-09', [driftA, driftB]);
      expect(drift).toHaveLength(2);
      expect(drift.map(d => d.url).sort()).toEqual([driftA.url, driftB.url].sort());
      expect(drift.find(d => d.url === driftA.url)?.previousHash).toBe(driftA.previousHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing directory yields health drift only; malformed entries dropped', () => {
    const drift = collectDocumentDrift('/nonexistent/cci-drift-path', '2026-09', [driftB, { url: '' }, null]);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ url: driftB.url, isNew: true });
    expect(collectDocumentDrift('/nonexistent/cci-drift-path', '2026-09', 'not-an-array')).toEqual([]);
  });
});

describe('renderMeetingVotesSection', () => {
  test('renders the vote table with pass/fail and the inferred marker', () => {
    const lines = renderMeetingVotesSection(
      [
        {
          link: 'https://www.crescentcity.org/events/1/',
          date: '2026-09-01',
          title: 'City Council Meeting',
          source: 'City Council',
          yea: 5, nay: 0, abstain: 1, absent: 0,
          passed: true, inferred: false,
        },
        {
          link: '',
          date: '',
          title: 'Special Meeting | Budget',
          source: 'City Council',
          yea: 2, nay: 3, abstain: 0, absent: 0,
          passed: false, inferred: true,
        },
      ],
      [],
    );
    const text = lines.join('\n');
    expect(text).toContain('### 🏛️ Recorded votes');
    expect(text).toContain('2 vote records');
    expect(text).toContain('| 2026-09-01 | [City Council Meeting](https://www.crescentcity.org/events/1/) | 5 | 0 | 1 | 0 | Passed |');
    // Pipes inside cell text are escaped so the table cannot break.
    expect(text).toContain('Special Meeting / Budget');
    expect(text).toContain('| 2 | 3 | 0 | 0 | Failed (inferred) |');
    expect(text).toContain('verify against the linked minutes');
    expect(text).toContain('No agenda/minutes documents were added or changed');
  });

  test('renders empty states for a month with no votes or drift', () => {
    const lines = renderMeetingVotesSection([], []);
    const text = lines.join('\n');
    expect(text).toContain('No parseable vote tallies');
    expect(text).toContain('No agenda/minutes documents were added or changed');
  });

  test('caps long tables and drift lists while keeping true totals', () => {
    const manyRows = Array.from({ length: 15 }, (_, i) => ({
      link: `https://example.gov/events/${i}/`,
      date: '2026-09-01',
      title: `Meeting ${i}`,
      source: 'City Council',
      yea: 1, nay: 0, abstain: 0, absent: 0,
      passed: true, inferred: false,
    }));
    const manyDrift: DocumentDrift[] = Array.from({ length: 13 }, (_, i) => ({
      url: `https://example.gov/doc-${i}.pdf`,
      changed: true,
      isNew: false,
      previousHash: `aaaaaaaaaaaaaaaa${i}`,
      currentHash: `bbbbbbbbbbbbbbbb${i}`,
    }));
    const text = renderMeetingVotesSection(manyRows, manyDrift).join('\n');
    expect(text).toContain('15 vote records');
    expect(text).toContain('... and 3 more');
    expect(text).toContain('13 document events');
    expect(text).toContain('... and 3 more');
    // The capped view renders exactly 12 vote rows.
    expect((text.match(/\| 2026-09-01 \|/g) ?? []).length).toBe(12);
  });
});

describe('renderMeetingVotesSection agenda cross-references', () => {
  test('renders topic → section associations and escapes cell text', () => {
    const lines = renderMeetingVotesSection([], [], [
      {
        topic: 'Harbor | Committee',
        agendaUrl: 'https://www.crescentcity.org/events/1/',
        guid: 'guid-1',
        sectionNumber: '§ 12.08.010',
        sectionTitle: 'Harbor use permits',
        articleTitle: 'Title 12 — Harbor',
        score: 3.5,
      },
    ]);
    const text = lines.join('\n');
    expect(text).toContain('### 📎 Agenda topics → municipal code');
    expect(text).toContain('[Harbor / Committee](https://www.crescentcity.org/events/1/) → § 12.08.010 Harbor use permits — Title 12 — Harbor');
    expect(text).toContain('Topical matches only — not legal advice');
  });

  test('renders the empty state when no topics were cross-referenced', () => {
    const text = renderMeetingVotesSection([], [], []).join('\n');
    expect(text).toContain('No agenda items were cross-referenced to code sections');
  });
});
