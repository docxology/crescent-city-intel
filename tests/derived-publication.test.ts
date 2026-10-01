import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureDerivedInputs, withCapturedDerivedInputs, retainDerivedOutput } from '../src/derived_publication.ts';
import { buildEventsArtifact, collectEvents, refreshEvents, canonicalPublicationDate } from '../src/events.ts';
import { replayArtifactCustody } from '../src/artifact_custody.ts';
import { buildAnalyticsOverview } from '../src/analytics_backend.ts';
const clock = '2026-09-30T12:00:00.000Z';
test('publication clocks normalize declared RSS offsets and upload days without inventing event times', () => {
  expect(canonicalPublicationDate('Tue, 29 Sep 2026 20:01:00 -0700')).toBe('2026-09-30T03:01:00.000Z');
  expect(canonicalPublicationDate('20261011')).toBe('2026-10-11');
  expect(canonicalPublicationDate('2026-09-30T12:00:00')).toBeNull();
  expect(canonicalPublicationDate('Tue, 30 Feb 2026 20:01:00 +0000')).toBeNull();
});
test('analytics seed fallback reads retained bytes and refuses a changed seed edition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cci-derived-seed-'));
  const original = process.env.CODE_SEED_PATH;
  const seedPath = join(root, 'seed.json'); process.env.CODE_SEED_PATH = seedPath;
  try {
    const seed = { articles: [{ title: 'Recorded code', sections: [{ guid: '1', number: '1.01.010', title: 'Purpose', text: 'Recorded words for this section.' }] }] };
    await writeFile(seedPath, JSON.stringify(seed));
    const evidence = await captureDerivedInputs(root, 'analytics', { generatedAt: clock });
    await writeFile(seedPath, JSON.stringify({ articles: [] }));
    const overview = await withCapturedDerivedInputs(evidence, stage => buildAnalyticsOverview({ generatedAt: clock, seedPath: join(stage, 'custody', 'municipal-code-seed.json') }));
    expect(overview.metrics.code.sections).toBe(1);
    await expect(retainDerivedOutput(root, 'analytics-overview', join(root, 'state', 'analytics-overview.json'), overview, evidence, clock)).rejects.toThrow('edition changed');
  } finally { if (original === undefined) delete process.env.CODE_SEED_PATH; else process.env.CODE_SEED_PATH = original; await rm(root, { recursive: true, force: true }); }
});
test('event facts replay from retained exact inputs and changed membership refuses publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cci-derived-replay-'));
  try {
    await mkdir(join(root, 'gov_meetings'));
    await writeFile(join(root, 'gov_meetings', 'batch.json'), JSON.stringify({ items: [{ title: 'Council meeting', date: '2026-10-05', link: 'https://www.crescentcity.org/events/5', source: 'City Council' }] }));
    const evidence = await captureDerivedInputs(root, 'events', { generatedAt: clock });
    const artifact = await withCapturedDerivedInputs(evidence, async stage => buildEventsArtifact(clock, await collectEvents(stage, new Date(clock))));
    const destination = join(root, 'events', 'events.json');
    await retainDerivedOutput(root, 'events', destination, artifact, evidence, clock);
    const bytes = await readFile(destination), receipt = JSON.parse(await readFile(destination + '.custody.json', 'utf8'));
    expect(await replayArtifactCustody(receipt, bytes, evidence, () => withCapturedDerivedInputs(evidence, async stage => new TextEncoder().encode(JSON.stringify(buildEventsArtifact(clock, await collectEvents(stage, new Date(clock))), null, 2) + '\n')))).toEqual([]);
    await writeFile(join(root, 'gov_meetings', 'new.json'), '{}');
    await expect(retainDerivedOutput(root, 'events', destination, artifact, evidence, clock)).rejects.toThrow('edition changed');
    expect(await readFile(destination)).toEqual(bytes);
    expect(artifact.events[0]!.status).toBe('scheduled');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('real event producer serializes same-root editions and commits paired JSON/ICS/custody', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cci-derived-producer-'));
  try {
    await Promise.all([refreshEvents([], { outputDir: root }), refreshEvents([], { outputDir: root })]);
    const value = JSON.parse(await readFile(join(root, 'events', 'events.json'), 'utf8'));
    expect(value.count).toBe(0);
    expect(await readFile(join(root, 'events', 'events.ics'), 'utf8')).toContain('END:VCALENDAR');
    expect(JSON.parse(await readFile(join(root, 'events', 'events.json.custody.json'), 'utf8')).family).toBe('events');
    const transactions = await readdir(join(root, 'state', 'artifact-transactions'));
    expect(transactions).toHaveLength(2);
    for (const id of transactions) expect(JSON.parse(await readFile(join(root, 'state', 'artifact-transactions', id, 'receipt.json'), 'utf8')).status).toBe('committed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
