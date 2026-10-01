import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { recoverOwnedBrowsers } from "../src/browser_launcher.ts";
function alive(pid: number, group = false): boolean { try { process.kill(group ? -pid : pid, 0); return true; } catch { return false; } }
test("a missing private identity cannot authorize deletion of an unrelated launcher-named directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-browser-missing-identity-")), unrelated = await mkdtemp(join(tmpdir(), "cci-browser-launch-unowned-")); const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" }); await dead.exited; const token = crypto.randomUUID(); await mkdir(join(root, "state", "browser-owners"), { recursive: true }); await writeFile(join(unrelated, "sentinel"), "operator-owned bytes"); await writeFile(join(root, "state", "browser-owners", `${token}.json`), JSON.stringify({ schemaVersion: "browser-owner/v1", root, token, parentPid: dead.pid, executable: join(unrelated, "launch"), createdAt: new Date().toISOString(), status: "pending" }));
  try { await expect(recoverOwnedBrowsers(root)).rejects.toThrow("preserve ambiguous"); expect(await readFile(join(unrelated, "sentinel"), "utf8")).toBe("operator-owned bytes"); }
  finally { await Promise.all([root, unrelated].map(value => rm(value, { recursive: true, force: true }))); }
});
test("killed real browser controller recovers only authenticated root and current launcher identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-browser-recovery-")), other = await mkdtemp(join(tmpdir(), "cci-browser-recovery-other-")); const browser = new URL("../src/browser.ts", import.meta.url).href, paths = new URL("../src/shared/paths.ts", import.meta.url).href;
  const code = `process.env.HEADLESS_BROWSER='1';const{withOutputRoot}=await import(${JSON.stringify(paths)});const{newPage,ownedBrowserPid}=await import(${JSON.stringify(browser)});await withOutputRoot(${JSON.stringify(root)},async()=>{await newPage();console.log('READY:'+ownedBrowserPid());});setInterval(()=>{},1000);`;
  const controller = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" }); const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" }); let pid = 0;
  try {
    const reader = controller.stdout.getReader(); let output = ""; while (!/^READY:/m.test(output)) { const part = await reader.read(); if (part.done) throw new Error("Browser controller exited before ready"); output += new TextDecoder().decode(part.value); } reader.releaseLock(); pid = Number(/^READY:(\d+)/m.exec(output)![1]); expect(alive(pid, true)).toBe(true); controller.kill("SIGKILL"); await controller.exited; expect(alive(pid, true)).toBe(true);
    const [name] = await readdir(join(root, "state", "browser-owners")); const path = join(root, "state", "browser-owners", name!); const record = JSON.parse(await readFile(path, "utf8")); await mkdir(join(other, "state", "browser-owners"), { recursive: true }); await writeFile(join(other, "state", "browser-owners", name!), JSON.stringify({ ...record, root: other }));
    await expect(recoverOwnedBrowsers(other)).rejects.toThrow("root ownership"); expect(alive(pid, true)).toBe(true);
    const privateOwner = join(dirname(record.executable), "owner.json"), original = await readFile(privateOwner, "utf8"); await writeFile(privateOwner, JSON.stringify({ ...JSON.parse(original), pid: unrelated.pid })); await expect(recoverOwnedBrowsers(root)).rejects.toThrow("launcher identity"); expect(alive(unrelated.pid)).toBe(true); expect(alive(pid, true)).toBe(true); await writeFile(privateOwner, original);
    const recovered = await recoverOwnedBrowsers(root); expect(recovered).toHaveLength(1); expect(recovered[0]).toMatchObject({ status: "recovered", recoveredPid: pid, processGroupGone: true }); expect(alive(pid, true)).toBe(false); expect(alive(unrelated.pid)).toBe(true); expect(await recoverOwnedBrowsers(root)).toHaveLength(0);
  } finally { controller.kill(); await controller.exited; if (pid && alive(pid, true)) process.kill(-pid, "SIGKILL"); unrelated.kill(); await unrelated.exited; await Promise.all([root, other].map(value => rm(value, { recursive: true, force: true }))); }
}, 15_000);
