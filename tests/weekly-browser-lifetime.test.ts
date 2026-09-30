import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedChild } from "../src/shared/subprocess.ts";

test("weekly early write failure closes a real Chromium session before releasing its run lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "weekly-browser-lifetime-"));
  const browserModule = new URL("../src/browser.ts", import.meta.url).href;
  const weeklyModule = new URL("../src/weekly_pipeline.ts", import.meta.url).href;
  const storageModule = new URL("../src/shared/storage.ts", import.meta.url).href;
  const pathsModule = new URL("../src/shared/paths.ts", import.meta.url).href;
  const code = `
    process.env.CC_OUTPUT_DIR = ${JSON.stringify(root)};
    process.env.HEADLESS_BROWSER = '1';
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { newPage, closeBrowser } = await import(${JSON.stringify(browserModule)});
    const { runWeeklyCheck } = await import(${JSON.stringify(weeklyModule)});
    const { acquireFileLease } = await import(${JSON.stringify(storageModule)});
    const { paths } = await import(${JSON.stringify(pathsModule)});
    if (paths.output !== ${JSON.stringify(root)}) throw new Error('Fixture root must match before all filesystem operations');
    // A real filesystem collision makes the attempt's atomic rename fail before
    // any source producer runs. The browser is an actual blank Chromium page.
    await mkdir(join(paths.state, 'latest-pipeline-attempt.json'), { recursive: true });
    const page = await newPage();
    let failed = false;
    try {
      try { await runWeeklyCheck(); } catch { failed = true; }
      const browserClosedAtReturn = page.isClosed();
      const release = await acquireFileLease(join(paths.state, 'weekly-check.lock'), { waitMs: 100 });
      await release();
      console.log('RECEIPT:' + JSON.stringify({ failed, browserClosedAtReturn, leaseReacquired: true, root: paths.output }));
    } finally { await closeBrowser(); }
  `;
  try {
    const result = await runBoundedChild([process.execPath, "-e", code], { timeoutMs: 15_000, maxBytes: 64 * 1024 });
    expect(result.status).toBe("ok"); expect(result.exitCode).toBe(0); expect(result.reaped).toBe(true);
    const receipt = result.stdout.split(/\r?\n/).find(line => line.startsWith("RECEIPT:"));
    expect(receipt).toBeDefined(); expect(JSON.parse(receipt!.slice("RECEIPT:".length))).toEqual({ failed: true, browserClosedAtReturn: true, leaseReacquired: true, root });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);
