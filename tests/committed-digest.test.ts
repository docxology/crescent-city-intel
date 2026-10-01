import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDigest, writeDigest, readCommittedDigest } from '../src/lifeos_bridge.ts';
test('consumer reads one committed retained version during a partial latest replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cci-digest-consumer-')), custom = join(root, 'custom'), data = join(root, 'data');
  try {
    const digest = await buildDigest({ outputDir: root, generatedAt: '2026-09-30T12:00:00Z' });
    const receipt = await writeDigest(digest, custom, data);
    expect(await readCommittedDigest(data)).toEqual(digest);
    await writeFile(join(data, 'latest.json'), JSON.stringify({ partial: 'next edition' }));
    expect(await readCommittedDigest(data)).toEqual(digest);
    await writeFile(join(data, 'versions', receipt.sha256, 'digest.json'), JSON.stringify({ forged: true }));
    await expect(readCommittedDigest(data)).rejects.toThrow('byte custody');
  } finally { await rm(root, { recursive: true, force: true }); }
});
