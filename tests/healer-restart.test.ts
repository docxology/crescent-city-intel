import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHealingCycle } from '../src/alerts/healer.ts';
import { MONITOR_KEYS, ALERT_MONITOR_SOURCE_NAMES } from '../src/alerts/composite.ts';
test('durable healer restart deduplicates attempts, expires advisory backoff and records real recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cci-healer-restart-')), previous = process.env.HEALER_OUTPUT_DIR;
  process.env.HEALER_OUTPUT_DIR = root; const start = Date.parse('2026-09-30T12:00:00Z'); const name = 'NWS Marine Forecast';
  const write = async (runId: string, status: string) => {
    const checkedAt = new Date(start).toISOString();
    await writeFile(join(root, 'alerts', 'source-health.json'), JSON.stringify({ schemaVersion: 'crescent-city-source-health/v1', runId, checkedAt, sources: [{ source: name, status, checkedAt, itemCount: 0 }], attempts: MONITOR_KEYS.map((key, index) => ({ key, requested: ALERT_MONITOR_SOURCE_NAMES[index] === name })) }));
  };
  try {
    await mkdir(join(root, 'alerts'));
    for (let n = 0; n < 3; n++) { await write(crypto.randomUUID(), 'unavailable'); await runHealingCycle({ nowMs: start + n }); }
    const prior = JSON.parse(await readFile(join(root, 'state', 'healer-state.json'), 'utf8'));
    expect(prior.monitors[name].consecutiveFailures).toBe(3); expect(prior.monitors[name].retryCount).toBe(1);
    const child = Bun.spawnSync(['bun', '-e', 'import {getHealerState} from "./src/alerts/healer.ts"; console.log(JSON.stringify(await getHealerState()))'], { env: { ...process.env, HEALER_OUTPUT_DIR: root }, stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode).toBe(0); expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual(prior);
    const repeat = await runHealingCycle({ nowMs: start + 10 }); expect(repeat.monitorsChecked).toBe(0); expect(repeat.state.monitors[name]!.consecutiveFailures).toBe(3);
    const expiry = await runHealingCycle({ nowMs: start + 300_100 }); expect(expiry.monitorsRetried).toEqual([name]); expect(expiry.state.monitors[name]!.consecutiveFailures).toBe(3); expect(expiry.state.monitors[name]!.retryCount).toBe(2);
    await write(crypto.randomUUID(), 'empty'); const recovered = await runHealingCycle({ nowMs: start + 300_101 }); expect(recovered.monitorsRecovered).toEqual([name]); expect(recovered.state.monitors[name]!.retryCount).toBe(0);
    await writeFile(join(root, 'state', 'healer-state.json'), '{corrupt'); await runHealingCycle(); expect(await readFile(join(root, 'state', 'healer-state.json'), 'utf8')).toBe('{corrupt');
  } finally { if (previous === undefined) delete process.env.HEALER_OUTPUT_DIR; else process.env.HEALER_OUTPUT_DIR = previous; await rm(root, { recursive: true, force: true }); }
});
