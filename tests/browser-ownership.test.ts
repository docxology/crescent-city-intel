import { expect, test } from "bun:test";
import { newPage, navigateWithCloudflare, closeBrowser, ownedBrowserPid, launchBrowser, withPageDeadline } from "../src/browser.ts";
import { mkdtemp, rm, writeFile, readFile, chmod, readdir, rename, mkdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { stopOwnedProcess } from "../src/shared/process_ownership.ts";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { withOutputRoot } from "../src/shared/paths.ts";
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function installedChromium(): Promise<string> {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (process.platform === "darwin") {
    const cache = join(homedir(), "Library", "Caches", "ms-playwright");
    for (const name of (await readdir(cache)).sort().reverse()) {
      if (!name.startsWith("chromium-")) continue;
      const candidate = join(cache, name, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
      try { await access(candidate); return candidate; } catch { /* inspect the next installed build */ }
    }
  }
  return chromium.executablePath();
}
test("real stalled Chromium navigation kills and reaps only the owned process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-chrome-owner-")); const prior = process.env.HEADLESS_BROWSER; process.env.HEADLESS_BROWSER = "1";
  const server = Bun.serve({ port: 0, fetch: () => new Response('<title>Just a moment</title><body>Checking your browser</body>', { headers: { "content-type": "text/html" } }) });
  const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" });
  const load = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, "-e", "console.log('READY'); const until=Date.now()+5000; let sum=0; while(Date.now()<until){for(let i=0;i<10000;i++)sum+=Math.sqrt(i);} console.log(sum);"], { stdout: "pipe", stderr: "ignore" }));
  try { await withOutputRoot(root, async () => {
    await Promise.all(load.map(async child => { const reader = child.stdout.getReader(); try { expect(new TextDecoder().decode((await reader.read()).value)).toContain("READY"); } finally { reader.releaseLock(); } }));
    const page = await newPage(); const pid = ownedBrowserPid()!; expect(alive(pid)).toBe(true);
    const started = Date.now(); await expect(navigateWithCloudflare(page, `http://127.0.0.1:${server.port}`, { timeout: 600, renderMs: 0 })).rejects.toThrow("parent deadline");
    expect(Date.now() - started).toBeLessThan(900); expect(page.isClosed()).toBe(true); expect(alive(pid)).toBe(false); expect(alive(unrelated.pid)).toBe(true); expect(ownedBrowserPid()).toBeUndefined();
  }); } finally { server.stop(true); unrelated.kill(); await unrelated.exited; for (const child of load) child.kill(); await Promise.all(load.map(child => child.exited)); await withOutputRoot(root, () => closeBrowser()); if (prior === undefined) delete process.env.HEADLESS_BROWSER; else process.env.HEADLESS_BROWSER = prior; await rm(root, { recursive: true, force: true }); }
}, 10_000);
test("an unreaped real owned zombie is reaped before its process group is declared gone", async () => {
  const child = spawn(process.execPath, ["-e", "console.log('READY');setInterval(()=>{},1000)"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); });
    const pid = child.pid!; process.kill(-pid, "SIGKILL");
    // Hold this parent's event loop until the child is a zombie, so the exit
    // event cannot certify reaping before cleanup starts. Darwin reports EPERM.
    const until = Date.now() + 40; while (Date.now() < until) { /* real event-loop contention */ }
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
    let groupError: string | undefined; try { process.kill(-pid, 0); } catch (error) { groupError = (error as NodeJS.ErrnoException).code; }
    if (process.platform === "darwin") expect(groupError).toBe("EPERM");
    expect(await stopOwnedProcess(child, 500)).toMatchObject({ pid, directChildReaped: true, processGroupGone: true });
    expect(alive(pid)).toBe(false); expect(alive(unrelated.pid)).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) await stopOwnedProcess(child, 1000);
    unrelated.kill(); await unrelated.exited;
  }
}, 5000);
test("timing out an externally created page preserves this root's unrelated owned browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-external-page-")); const prior = process.env.HEADLESS_BROWSER; process.env.HEADLESS_BROWSER = "1";
  let external: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try { external = await chromium.launch({ headless: true, executablePath: await installedChromium() }); await withOutputRoot(root, async () => {
    const modulePage = await newPage(); const pid = ownedBrowserPid()!; const externalPage = await external!.newPage();
    const externalClosed = externalPage.waitForEvent("close", { timeout: 1000 });
    await expect(withPageDeadline(externalPage, () => new Promise<never>(() => {}), 300)).rejects.toThrow("parent deadline");
    expect(modulePage.isClosed()).toBe(false); expect(alive(pid)).toBe(true); expect(ownedBrowserPid()).toBe(pid);
    // This caller-owned browser may complete its bounded page-close request
    // after the operation rejects; it grants no process-reaping authority.
    await externalClosed; expect(externalPage.isClosed()).toBe(true);
  }); } finally { await external?.close(); await withOutputRoot(root, () => closeBrowser()); if (prior === undefined) delete process.env.HEADLESS_BROWSER; else process.env.HEADLESS_BROWSER = prior; await rm(root, { recursive: true, force: true }); }
}, 10_000);
test("failed launcher receipt cleanup is retained and retried before a replacement launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-close-retry-")); const prior = process.env.HEADLESS_BROWSER; process.env.HEADLESS_BROWSER = "1";
  try { await withOutputRoot(root, async () => {
    await newPage(); const priorPid = ownedBrowserPid()!; const owners = join(root, "state", "browser-owners"); const [name] = await readdir(owners); const receipt = join(owners, name!); const backup = `${receipt}.preserved`;
    const original = await readFile(receipt); await rename(receipt, backup); await mkdir(receipt); await writeFile(join(receipt, "sentinel"), "retain failed cleanup");
    await expect(closeBrowser()).rejects.toThrow(); expect(alive(priorPid)).toBe(false);
    await expect(newPage()).rejects.toThrow(); expect(await readFile(backup)).toEqual(original); expect(await readFile(join(receipt, "sentinel"), "utf8")).toBe("retain failed cleanup"); expect((await readdir(owners)).sort()).toEqual([name!, `${name}.preserved`].sort());
    await rm(receipt, { recursive: true }); await rename(backup, receipt);
    const replacement = await newPage(); expect(replacement.isClosed()).toBe(false); expect(ownedBrowserPid()).not.toBe(priorPid);
    expect(JSON.parse(await readFile(receipt, "utf8")).status).toBe("closed");
  }); } finally { await withOutputRoot(root, () => closeBrowser()); if (prior === undefined) delete process.env.HEADLESS_BROWSER; else process.env.HEADLESS_BROWSER = prior; await rm(root, { recursive: true, force: true }); }
}, 10_000);
test("real launch protocol stall obeys the owned setup watchdog and leaves no child", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-chrome-launch-")); const prior = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const executable = join(root, "stalled-browser"); const pidFile = join(root, "pid");
  await writeFile(executable, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`); await chmod(executable, 0o700);
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = executable;
  try { await withOutputRoot(root, async () => {
    const started = Date.now(); await expect(launchBrowser({ timeoutMs: 400 })).rejects.toThrow(); expect(Date.now() - started).toBeLessThan(1000);
    const pid = Number(await readFile(pidFile, "utf8")); expect(alive(pid)).toBe(false); expect(ownedBrowserPid()).toBeUndefined();
  }); } finally { if (prior === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE; else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = prior; await withOutputRoot(root, () => closeBrowser()); await rm(root, { recursive: true, force: true }); }
}, 5000);
test("different captured roots own separate Chromium sessions", async () => {
  const a = await mkdtemp(join(tmpdir(), "cci-browser-a-")), b = await mkdtemp(join(tmpdir(), "cci-browser-b-")); const prior = process.env.HEADLESS_BROWSER; process.env.HEADLESS_BROWSER = "1";
  try {
    const [left, right] = await Promise.all([withOutputRoot(a, () => newPage()), withOutputRoot(b, () => newPage())]);
    const leftPid = withOutputRoot(a, () => ownedBrowserPid()), rightPid = withOutputRoot(b, () => ownedBrowserPid()); expect(leftPid).not.toBe(rightPid);
    const receipt = await withOutputRoot(a, () => closeBrowser()); expect(receipt).toMatchObject({ directChildReaped: true, processGroupGone: true }); expect(left.isClosed()).toBe(true); expect(right.isClosed()).toBe(false);
  } finally { await Promise.all([withOutputRoot(a, () => closeBrowser()), withOutputRoot(b, () => closeBrowser())]); if (prior === undefined) delete process.env.HEADLESS_BROWSER; else process.env.HEADLESS_BROWSER = prior; await rm(a, { recursive: true, force: true }); await rm(b, { recursive: true, force: true }); }
}, 10_000);
test("parent cancellation reaps an actually SIGSTOP-wedged Chromium group", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-chrome-wedged-")); const prior = process.env.HEADLESS_BROWSER; process.env.HEADLESS_BROWSER = "1"; const controller = new AbortController();
  const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" });
  try { await withOutputRoot(root, async () => {
    const page = await newPage(); const pid = ownedBrowserPid()!; process.kill(-pid, "SIGSTOP");
    const pending = navigateWithCloudflare(page, "http://127.0.0.1:1/never", { timeout: 1500, signal: controller.signal, renderMs: 0 }); const started = Date.now(); setTimeout(() => controller.abort(new Error("Operator interrupted fixture")), 50);
    await expect(pending).rejects.toThrow(); expect(Date.now() - started).toBeLessThan(800); expect(alive(pid)).toBe(false); expect(alive(unrelated.pid)).toBe(true); expect(ownedBrowserPid()).toBeUndefined();
  }); } finally { unrelated.kill(); await unrelated.exited; await withOutputRoot(root, () => closeBrowser()); if (prior === undefined) delete process.env.HEADLESS_BROWSER; else process.env.HEADLESS_BROWSER = prior; await rm(root, { recursive: true, force: true }); }
}, 10_000);
test("page creation under a SIGSTOP-wedged existing browser obeys parent cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-chrome-page-create-")); const prior = process.env.HEADLESS_BROWSER; process.env.HEADLESS_BROWSER = "1"; const controller = new AbortController();
  try { await withOutputRoot(root, async () => {
    await launchBrowser(); const pid = ownedBrowserPid()!; process.kill(-pid, "SIGSTOP"); const started = Date.now(); const pending = newPage({ signal: controller.signal }); setTimeout(() => controller.abort(), 40);
    await expect(pending).rejects.toThrow(); expect(Date.now() - started).toBeLessThan(800); expect(alive(pid)).toBe(false); expect(ownedBrowserPid()).toBeUndefined();
  }); } finally { await withOutputRoot(root, () => closeBrowser()); if (prior === undefined) delete process.env.HEADLESS_BROWSER; else process.env.HEADLESS_BROWSER = prior; await rm(root, { recursive: true, force: true }); }
}, 10_000);
