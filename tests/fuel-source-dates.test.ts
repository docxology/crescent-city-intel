import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEiaWeeklyPrices, appendFuelHistory } from '../src/alerts/fuel.ts';
import { withOutputRoot } from '../src/shared/paths.ts';
test('primary EIA month/day cells preserve distinct civil week dates and reject rollover', () => {
  const row = `<tr><td class='B6'>&nbsp;&nbsp;2026-Sep</td><td class='B5'>09/07&nbsp;</td><td class='B3'>5.787&nbsp;</td><td class='B5'>09/28&nbsp;</td><td class='B3'>6.300&nbsp;</td></tr>`;
  expect(parseEiaWeeklyPrices(row)).toEqual([{ weekOf: '2026-09-07', pricePerGallon: 5.787 }, { weekOf: '2026-09-28', pricePerGallon: 6.3 }]);
  expect(() => parseEiaWeeklyPrices(row.replace('09/28', '09/31'))).toThrow('invalid');
  expect(() => parseEiaWeeklyPrices(row.replace('09/28', '08/28'))).toThrow('mismatched');
});
test('fuel history preserves unverified original bytes before activating corrected primary dates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cci-fuel-history-recovery-'));
  try {
    await mkdir(join(root, 'alerts', 'fuel'), { recursive: true });
    const path = join(root, 'alerts', 'fuel', 'history.jsonl');
    const prior = Buffer.from(JSON.stringify({ weekOf: '2026-09-09T00:00:00.000Z', pricePerGallon: 6.3 }) + '\n'); await writeFile(path, prior);
    await withOutputRoot(root, () => appendFuelHistory([{ weekOf: '2026-09-28', pricePerGallon: 6.3 }], '2026-10-01T12:00:00Z'));
    const files = await readdir(join(root, 'state', 'history-evidence', 'fuel'));
    expect(await readFile(join(root, 'state', 'history-evidence', 'fuel', files.find(file => file.endsWith('.jsonl'))!))).toEqual(prior);
    const current = JSON.parse((await readFile(path, 'utf8')).trim()); expect(current.weekOf).toBe('2026-09-28'); expect(current.dateBasis).toBe('eia-weekly-end-date/v2');
    await withOutputRoot(root, async () => { await expect(appendFuelHistory([{ weekOf: '2026-02-31', pricePerGallon: 6.3 }])).rejects.toThrow('civil dates'); await expect(appendFuelHistory([{ weekOf: '2026-09-28', pricePerGallon: NaN }])).rejects.toThrow('finite'); });
    await withOutputRoot(root, () => appendFuelHistory([{ weekOf: '2026-09-28', pricePerGallon: 6.3 }]));
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
