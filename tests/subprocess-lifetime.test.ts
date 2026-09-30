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
  const descendant = `import {writeFileSync} from 'node:fs'; setInterval(()=>writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),10);`;
  const parent = `import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}); child.unref(); setTimeout(()=>{console.log(child.pid);process.exit(0)},100);`;
  try {
    const result = await runBoundedChild([process.execPath, "-e", parent], { timeoutMs: 1000 }); expect(result.status).toBe("ok"); expect(result.reaped).toBe(true);
    const first = await readFile(heartbeat, "utf8"); await new Promise(resolve => setTimeout(resolve, 80)); expect(await readFile(heartbeat, "utf8")).toBe(first);
    const utf8 = await runBoundedChild([process.execPath, "-e", "process.stdout.write(Buffer.from([0xe2]));setTimeout(()=>process.stdout.write(Buffer.from([0x82,0xac])),40)"], { timeoutMs: 1000 });
    expect(utf8.stdout).toBe("€"); expect(utf8.status).toBe("ok");
  } finally { await rm(root, { recursive: true, force: true }); }
});
