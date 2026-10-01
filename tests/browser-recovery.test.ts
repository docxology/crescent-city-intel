import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createBrowserLauncher, terminateBrowserLauncher, recoverOwnedBrowsers } from "../src/browser_launcher.ts";
import { withOutputRoot } from "../src/shared/paths.ts";
import { withRunSignal } from "../src/shared/run_scope.ts";
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
    const reader = controller.stdout.getReader(); let output = ""; while (!/^READY:/m.test(output)) { const part = await reader.read(); if (part.done) throw new Error("Browser controller exited before ready"); output += new TextDecoder().decode(part.value); } reader.releaseLock(); pid = Number(/^READY:(\d+)/m.exec(output)![1]); expect(alive(pid, true)).toBe(true);
    // Keep the actual orphan group alive throughout the negative controls.
    // Chromium can otherwise exit naturally when its controller pipes close.
    process.kill(-pid, "SIGSTOP"); controller.kill("SIGKILL"); await controller.exited; expect(alive(pid, true)).toBe(true);
    const [name] = await readdir(join(root, "state", "browser-owners")); const path = join(root, "state", "browser-owners", name!); const record = JSON.parse(await readFile(path, "utf8")); await mkdir(join(other, "state", "browser-owners"), { recursive: true }); await writeFile(join(other, "state", "browser-owners", name!), JSON.stringify({ ...record, root: other }));
    await expect(recoverOwnedBrowsers(other)).rejects.toThrow("root ownership"); expect(alive(pid, true)).toBe(true);
    const privateOwner = join(dirname(record.executable), "owner.json"), original = await readFile(privateOwner, "utf8");
    const durableBytes = await readFile(path), wrapperBytes = await readFile(record.executable), identityPath = join(dirname(record.executable), "identity.json"), identityBytes = await readFile(identityPath);
    await rm(privateOwner); await expect(recoverOwnedBrowsers(root)).rejects.toThrow("Missing private browser launcher owner");
    expect(alive(pid, true)).toBe(true); expect(alive(unrelated.pid)).toBe(true); expect(await readFile(path)).toEqual(durableBytes);
    expect(await readFile(record.executable)).toEqual(wrapperBytes); expect(await readFile(identityPath)).toEqual(identityBytes);
    await writeFile(privateOwner, original);
    await writeFile(privateOwner, JSON.stringify({ ...JSON.parse(original), pid: unrelated.pid })); await expect(recoverOwnedBrowsers(root)).rejects.toThrow("launcher identity"); expect(alive(unrelated.pid)).toBe(true); expect(alive(pid, true)).toBe(true); await writeFile(privateOwner, original);
    const recovered = await recoverOwnedBrowsers(root); expect(recovered).toHaveLength(1); expect(recovered[0]).toMatchObject({ status: "recovered", recoveredPid: pid, processGroupGone: true }); expect(alive(pid, true)).toBe(false); expect(alive(unrelated.pid)).toBe(true); expect(await recoverOwnedBrowsers(root)).toHaveLength(0);
  } finally { controller.kill(); await controller.exited; if (pid && alive(pid, true)) process.kill(-pid, "SIGKILL"); unrelated.kill(); await unrelated.exited; await Promise.all([root, other].map(value => rm(value, { recursive: true, force: true }))); }
}, 15_000);
test("real detached launcher recovery refuses mismatched start identity and unrelated argv without touching either group", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-launcher-kernel-"));
  const launcherModule = new URL("../src/browser_launcher.ts", import.meta.url).href, paths = new URL("../src/shared/paths.ts", import.meta.url).href;
  const code = `const{spawn}=await import('node:child_process');const{withOutputRoot}=await import(${JSON.stringify(paths)});const{createBrowserLauncher}=await import(${JSON.stringify(launcherModule)});await withOutputRoot(${JSON.stringify(root)},async()=>{const launcher=await createBrowserLauncher(process.execPath);spawn(launcher.executable,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','ignore','ignore','pipe','pipe']});let pid;while(!(pid=await launcher.pid()))await new Promise(r=>setTimeout(r,5));console.log('READY:'+pid);});setInterval(()=>{},1000);`;
  const controller = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  let pid = 0;
  try {
    const reader = controller.stdout.getReader(); let output = ""; while (!/^READY:/m.test(output)) { const part = await reader.read(); if (part.done) throw new Error("Launcher controller exited before ready"); output += new TextDecoder().decode(part.value); } reader.releaseLock(); pid = Number(/^READY:(\d+)/m.exec(output)![1]);
    controller.kill("SIGKILL"); await controller.exited;
    const [name] = await readdir(join(root, "state", "browser-owners")); const receiptPath = join(root, "state", "browser-owners", name!); const receiptBytes = await readFile(receiptPath); const record = JSON.parse(receiptBytes.toString("utf8"));
    const ownerPath = join(dirname(record.executable), "owner.json"), ownerBytes = await readFile(ownerPath), owner = JSON.parse(ownerBytes.toString("utf8"));
    if (process.platform === "linux") {
      expect(owner.linuxStartTime).toMatch(/^\d+$/);
      await writeFile(ownerPath, JSON.stringify({ ...owner, linuxStartTime: String(BigInt(owner.linuxStartTime) + 1n) }));
      await expect(recoverOwnedBrowsers(root)).rejects.toThrow("launcher identity");
      expect(alive(pid, true)).toBe(true); expect(await readFile(receiptPath)).toEqual(receiptBytes);
      await writeFile(ownerPath, ownerBytes);
    }
    // This real unrelated group includes the authentic path only as an ordinary
    // data argument. It is not the kernel's script argv and grants no authority.
    const { spawn } = await import("node:child_process");
    const foreign = spawn(process.execPath, ["-e", "console.log('FOREIGN_READY');setInterval(()=>{},1000)", record.executable], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((resolve, reject) => { foreign.stdout!.once("data", () => resolve()); foreign.once("error", reject); });
      // A legacy record without a Linux start field still needs exact argv.
      await writeFile(ownerPath, JSON.stringify({ ...owner, pid: foreign.pid, linuxStartTime: undefined }));
      await expect(recoverOwnedBrowsers(root)).rejects.toThrow("launcher identity");
      expect(alive(foreign.pid!, true)).toBe(true); expect(alive(pid, true)).toBe(true); expect(await readFile(receiptPath)).toEqual(receiptBytes);
      await writeFile(ownerPath, ownerBytes);
    } finally {
      process.kill(-foreign.pid!, "SIGKILL"); await new Promise<void>(resolve => { if (foreign.exitCode !== null || foreign.signalCode !== null) resolve(); else foreign.once("exit", () => resolve()); });
    }
    const foreignExecutable = spawn("/usr/bin/yes", [record.executable], { detached: true, stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => { foreignExecutable.once("spawn", () => resolve()); foreignExecutable.once("error", reject); });
      await writeFile(ownerPath, JSON.stringify({ ...owner, pid: foreignExecutable.pid, linuxStartTime: undefined }));
      await expect(recoverOwnedBrowsers(root)).rejects.toThrow("launcher identity");
      expect(alive(foreignExecutable.pid!, true)).toBe(true); expect(alive(pid, true)).toBe(true); expect(await readFile(receiptPath)).toEqual(receiptBytes);
      await writeFile(ownerPath, ownerBytes);
    } finally {
      process.kill(-foreignExecutable.pid!, "SIGKILL"); await new Promise<void>(resolve => { if (foreignExecutable.exitCode !== null || foreignExecutable.signalCode !== null) resolve(); else foreignExecutable.once("exit", () => resolve()); });
    }
    const spoofedInterpreter = spawn("/usr/bin/yes", [record.executable], { argv0: process.execPath, detached: true, stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => { spoofedInterpreter.once("spawn", () => resolve()); spoofedInterpreter.once("error", reject); });
      await writeFile(ownerPath, JSON.stringify({ ...owner, pid: spoofedInterpreter.pid, linuxStartTime: undefined }));
      await expect(recoverOwnedBrowsers(root)).rejects.toThrow("launcher identity");
      expect(alive(spoofedInterpreter.pid!, true)).toBe(true); expect(alive(pid, true)).toBe(true); expect(await readFile(receiptPath)).toEqual(receiptBytes);
      await writeFile(ownerPath, ownerBytes);
    } finally {
      process.kill(-spoofedInterpreter.pid!, "SIGKILL"); await new Promise<void>(resolve => { if (spoofedInterpreter.exitCode !== null || spoofedInterpreter.signalCode !== null) resolve(); else spoofedInterpreter.once("exit", () => resolve()); });
    }
    const spoofedPrefix = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { argv0: `${process.execPath} ${record.executable}`, detached: true, stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => { spoofedPrefix.once("spawn", () => resolve()); spoofedPrefix.once("error", reject); });
      await writeFile(ownerPath, JSON.stringify({ ...owner, pid: spoofedPrefix.pid, linuxStartTime: undefined }));
      await expect(recoverOwnedBrowsers(root)).rejects.toThrow("launcher identity");
      expect(alive(spoofedPrefix.pid!, true)).toBe(true); expect(alive(pid, true)).toBe(true); expect(await readFile(receiptPath)).toEqual(receiptBytes);
      await writeFile(ownerPath, ownerBytes);
    } finally {
      process.kill(-spoofedPrefix.pid!, "SIGKILL"); await new Promise<void>(resolve => { if (spoofedPrefix.exitCode !== null || spoofedPrefix.signalCode !== null) resolve(); else spoofedPrefix.once("exit", () => resolve()); });
    }
    const recovered = await recoverOwnedBrowsers(root); expect(recovered).toHaveLength(1); expect(recovered[0]).toMatchObject({ recoveredPid: pid, processGroupGone: true }); expect(alive(pid, true)).toBe(false);
  } finally {
    controller.kill(); await controller.exited; if (pid && alive(pid, true)) process.kill(-pid, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
test("active launcher cleanup refuses PID substitution and reaps its stopped group after parent cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-launcher-active-"));
  const waitExit = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture child did not reap")), 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  };
  try { await withOutputRoot(root, async () => {
    const unused = await createBrowserLauncher(process.execPath);
    await expect(terminateBrowserLauncher(unused)).rejects.toThrow("Missing owned launcher receipt");
    // Only an explicit factory disposal can close a known never-spawned wrapper.
    await unused.dispose();
    const launcher = await createBrowserLauncher(process.execPath);
    const authentic = spawn(launcher.executable, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const foreign = spawn(process.execPath, ["-e", "console.log('FOREIGN_READY');setInterval(()=>{},1000)"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const ownerPath = join(dirname(launcher.executable), "owner.json"); let original: Buffer | undefined; let pid: number | null = null;
    try {
      await new Promise<void>((resolve, reject) => { foreign.stdout!.once("data", () => resolve()); foreign.once("error", reject); });
      const readyBy = Date.now() + 3000;
      while (!(pid = await launcher.pid()) && Date.now() < readyBy) await new Promise(resolve => setTimeout(resolve, 5));
      if (!pid || !foreign.pid) throw new Error("Fixture launchers did not become ready");
      expect(pid).toBe(authentic.pid!); expect(alive(pid, true)).toBe(true); expect(alive(foreign.pid, true)).toBe(true);
      original = await readFile(ownerPath); const owner = JSON.parse(original.toString("utf8"));
      const durablePath = join(root, "state", "browser-owners", `${owner.token}.json`), durable = await readFile(durablePath);
      const wrapperBytes = await readFile(launcher.executable), identityPath = join(dirname(launcher.executable), "identity.json"), identityBytes = await readFile(identityPath);
      await rm(ownerPath); await expect(terminateBrowserLauncher(launcher)).rejects.toThrow("Missing owned launcher receipt");
      expect(alive(pid, true)).toBe(true); expect(alive(foreign.pid, true)).toBe(true); expect(await readFile(durablePath)).toEqual(durable);
      expect(await readFile(launcher.executable)).toEqual(wrapperBytes); expect(await readFile(identityPath)).toEqual(identityBytes);
      await writeFile(ownerPath, original);
      const substituted = Buffer.from(JSON.stringify({ ...owner, pid: foreign.pid })); await writeFile(ownerPath, substituted);
      await expect(terminateBrowserLauncher(launcher)).rejects.toThrow("launcher identity");
      expect(alive(foreign.pid, true)).toBe(true); expect(alive(pid, true)).toBe(true);
      expect(await readFile(ownerPath)).toEqual(substituted); expect(await readFile(durablePath)).toEqual(durable);
      await writeFile(ownerPath, original);
      process.kill(-pid, "SIGSTOP");
      const parent = new AbortController();
      await withRunSignal(parent.signal, async () => {
        parent.abort(new Error("Interrupted producer"));
        await Promise.all([terminateBrowserLauncher(launcher), terminateBrowserLauncher(launcher), terminateBrowserLauncher(launcher)]);
      });
      await waitExit(authentic);
      expect(alive(pid)).toBe(false); expect(alive(pid, true)).toBe(false); expect(alive(foreign.pid, true)).toBe(true);
      expect(await readFile(durablePath)).toEqual(durable);
    } finally {
      if (original) await writeFile(ownerPath, original);
      for (const child of [authentic, foreign]) {
        if (child.pid && alive(child.pid, true)) process.kill(-child.pid, "SIGKILL");
        await waitExit(child);
        if (child.pid) expect(alive(child.pid, true)).toBe(false);
      }
      await launcher.dispose();
    }
  }); } finally { await rm(root, { recursive: true, force: true }); }
}, 10_000);
test("a naturally exited real launcher retains a recoverable receipt without signaling an unrelated process", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-launcher-natural-"));
  const launcherModule = new URL("../src/browser_launcher.ts", import.meta.url).href, paths = new URL("../src/shared/paths.ts", import.meta.url).href;
  const code = `const{spawn}=await import('node:child_process');const{withOutputRoot}=await import(${JSON.stringify(paths)});const{createBrowserLauncher}=await import(${JSON.stringify(launcherModule)});await withOutputRoot(${JSON.stringify(root)},async()=>{const launcher=await createBrowserLauncher(process.execPath);spawn(launcher.executable,['-e','setTimeout(()=>process.exit(0),300)'],{detached:true,stdio:['ignore','ignore','ignore','pipe','pipe']});let pid;while(!(pid=await launcher.pid()))await new Promise(r=>setTimeout(r,5));console.log('READY:'+pid);});setInterval(()=>{},1000);`;
  const controller = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" }); let pid = 0;
  try {
    const reader = controller.stdout.getReader(); let output = ""; while (!/^READY:/m.test(output)) { const part = await reader.read(); if (part.done) throw new Error("Natural-exit controller ended before ready"); output += new TextDecoder().decode(part.value); } reader.releaseLock(); pid = Number(/^READY:(\d+)/m.exec(output)![1]);
    expect(alive(pid, true)).toBe(true); controller.kill("SIGKILL"); await controller.exited;
    const until = Date.now() + 2000; while ((alive(pid) || alive(pid, true)) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    expect(alive(pid)).toBe(false); expect(alive(pid, true)).toBe(false);
    const recovered = await recoverOwnedBrowsers(root); expect(recovered).toHaveLength(1); expect(recovered[0]).toMatchObject({ status: "recovered", recoveredPid: pid, processGroupGone: true });
    expect(alive(unrelated.pid)).toBe(true); expect(await recoverOwnedBrowsers(root)).toHaveLength(0);
  } finally {
    controller.kill(); await controller.exited; if (pid && alive(pid, true)) process.kill(-pid, "SIGKILL"); unrelated.kill(); await unrelated.exited; await rm(root, { recursive: true, force: true });
  }
}, 10_000);
test("a missing real launcher leader grants no signal authority over surviving descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-launcher-exiting-"));
  const launcherModule = new URL("../src/browser_launcher.ts", import.meta.url).href, paths = new URL("../src/shared/paths.ts", import.meta.url).href;
  const code = `const{spawn}=await import('node:child_process');const{withOutputRoot}=await import(${JSON.stringify(paths)});const{createBrowserLauncher}=await import(${JSON.stringify(launcherModule)});await withOutputRoot(${JSON.stringify(root)},async()=>{const launcher=await createBrowserLauncher(process.execPath);spawn(launcher.executable,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','ignore','ignore','pipe','pipe']});let pid;while(!(pid=await launcher.pid()))await new Promise(r=>setTimeout(r,5));await new Promise(r=>setTimeout(r,50));console.log('READY:'+pid);});setInterval(()=>{},1000);`;
  const controller = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" }); let pid = 0;
  try {
    const reader = controller.stdout.getReader(); let output = ""; while (!/^READY:/m.test(output)) { const part = await reader.read(); if (part.done) throw new Error("Exiting controller ended before ready"); output += new TextDecoder().decode(part.value); } reader.releaseLock(); pid = Number(/^READY:(\d+)/m.exec(output)![1]);
    controller.kill("SIGKILL"); await controller.exited;
    const [name] = await readdir(join(root, "state", "browser-owners")); const receipt = join(root, "state", "browser-owners", name!), original = await readFile(receipt);
    process.kill(pid, "SIGKILL"); const until = Date.now() + 1000; while (alive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    expect(alive(pid)).toBe(false); expect(alive(pid, true)).toBe(true);
    const started = Date.now(); await expect(recoverOwnedBrowsers(root)).rejects.toThrow("cleanup bound"); expect(Date.now() - started).toBeLessThan(1500);
    expect(alive(pid, true)).toBe(true); expect(await readFile(receipt)).toEqual(original);
    process.kill(-pid, "SIGKILL"); const goneBy = Date.now() + 1000; while (alive(pid, true) && Date.now() < goneBy) await new Promise(resolve => setTimeout(resolve, 10));
    expect(alive(pid, true)).toBe(false); expect(await recoverOwnedBrowsers(root)).toHaveLength(1);
  } finally {
    controller.kill(); await controller.exited; if (pid && alive(pid, true)) process.kill(-pid, "SIGKILL"); await rm(root, { recursive: true, force: true });
  }
}, 10_000);
