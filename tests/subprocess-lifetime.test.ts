import { expect, test } from "bun:test";
import { runBoundedChild } from "../src/shared/subprocess.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("a real child and descendant holding its pipes are killed and the parent reaped", async () => {
  const root = await mkdtemp(join(tmpdir(), "bounded-child-")); const heartbeat = join(root, "heartbeat");
  const descendant = `import {writeFileSync} from 'node:fs'; setInterval(()=>writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20);`;
  const parent = `const child = Bun.spawn([process.execPath,'-e',${JSON.stringify(descendant)}],{stdout:'inherit',stderr:'inherit'}); console.log(child.pid); setInterval(()=>{},1000);`;
  try {
    const started = Date.now(); const result = await runBoundedChild([process.execPath, "-e", parent], { timeoutMs: 200 });
    expect(result.status).toBe("timeout"); expect(result.reaped).toBe(true); expect(Date.now() - started).toBeLessThan(2500);
    const first = await readFile(heartbeat, "utf8"); await new Promise(resolve => setTimeout(resolve, 80)); expect(await readFile(heartbeat, "utf8")).toBe(first);
    expect(() => process.kill(result.pid!, 0)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("real child output limits and cancellation terminate work", async () => {
  const oversized = await runBoundedChild([process.execPath, "-e", "setInterval(()=>console.log('x'.repeat(1000)),1)"], { maxBytes: 2000, timeoutMs: 1000 });
  expect(oversized.status).toBe("output-limit"); expect(oversized.reaped).toBe(true);
  const controller = new AbortController(); const pending = runBoundedChild([process.execPath, "-e", "setInterval(()=>{},1000)"], { signal: controller.signal, timeoutMs: 1000 });
  controller.abort(); const cancelled = await pending; expect(cancelled.status).toBe("cancelled"); expect(cancelled.reaped).toBe(true);
});
test("successful direct-child exit cleans descendants and preserves split UTF-8 bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "child-exit-")); const heartbeat = join(root, "heartbeat");
  const descendantPid = join(root, "descendant-pid");
  const descendant = `
    import {writeFileSync} from 'node:fs';
    // Make readiness later than the removed 100 ms parent-exit assumption.
    setTimeout(() => {
      writeFileSync(${JSON.stringify(descendantPid)}, String(process.pid));
      const beat = () => writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now()));
      beat();
      setInterval(beat, 10);
      process.stdout.write(String(process.pid) + '\\n');
    }, 125);
  `;
  const parent = `
    import {spawn} from 'node:child_process';
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: ['ignore', 'pipe', 'inherit']});
    child.unref();
    const readyDeadline = setTimeout(() => process.exit(2), 800);
    let readiness = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      readiness += chunk;
      if (readiness.length > 32) process.exit(3);
      if (!readiness.endsWith('\\n')) return;
      if (readiness !== String(child.pid) + '\\n') process.exit(3);
      clearTimeout(readyDeadline);
      child.stdout.destroy();
      process.stdout.write(Buffer.from([0xe2]));
      setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac]), () => process.exit(0)), 40);
    });
  `;
  try {
    const result = await runBoundedChild([process.execPath, "-e", parent], { timeoutMs: 1000 }); expect(result.status).toBe("ok"); expect(result.reaped).toBe(true);
    expect(result.stdout).toBe("€"); expect(result.exitCode).toBe(0);
    expect(Number(await readFile(descendantPid, "utf8"))).toBeGreaterThan(0);
    const first = await readFile(heartbeat, "utf8"); await new Promise(resolve => setTimeout(resolve, 80)); expect(await readFile(heartbeat, "utf8")).toBe(first);
    expect(() => process.kill(result.pid!, 0)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
