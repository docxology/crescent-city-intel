import { expect, test } from "bun:test";
import { installScheduler, removeScheduler, rotateSchedulerLog } from "../src/scheduler.ts";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireFileLease } from "../src/shared/storage.ts";
test("isolated cron installation/update/removal preserve unrelated jobs and refuse changed ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-scheduler-")), targetPath = join(root, "crontab"), stateDirectory = join(root, "state"); const original = "CRON_TZ=UTC\n# unrelated operator job\n5 1 * * * /usr/bin/true\n"; await writeFile(targetPath, original);
  const job = { project: join(root, "project with 'quotes' & XML"), bun: process.execPath, platform: "linux" as const };
  try {
    const first = await installScheduler({ job, targetPath, stateDirectory }); expect(first.nativeActivation).toBe(false); expect(first.status).toBe("installed-file"); const initial = await readFile(targetPath, "utf8"); expect(initial.startsWith(original)).toBe(true); expect(initial).toContain("'\"'\"'");
    await installScheduler({ job, targetPath, stateDirectory }); expect(await readFile(targetPath, "utf8")).toBe(initial);
    await writeFile(targetPath, initial + "# newly added unrelated job\n0 0 * * * /usr/bin/false\n"); await removeScheduler({ targetPath, stateDirectory }); expect(await readFile(targetPath, "utf8")).toBe(original + "# newly added unrelated job\n0 0 * * * /usr/bin/false\n");
    await installScheduler({ job, targetPath, stateDirectory }); await writeFile(targetPath, (await readFile(targetPath, "utf8")).replace("0 7 * * 0", "0 8 * * 0")); await expect(removeScheduler({ targetPath, stateDirectory })).rejects.toThrow("changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("isolated launchd file requires its own receipt and keeps adjacent jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-launchd-")), targetPath = join(root, "weekly.plist"), stateDirectory = join(root, "state"); const unrelated = join(root, "other.plist"); await writeFile(unrelated, "operator's unrelated plist");
  try {
    const job = { project: join(root, "A&B<'project'"), bun: process.execPath, platform: "darwin" as const };
    await writeFile(targetPath, "unowned plist"); await expect(installScheduler({ job, targetPath, stateDirectory })).rejects.toThrow("ownership"); await rm(targetPath);
    await installScheduler({ job, targetPath, stateDirectory }); expect(await readFile(targetPath, "utf8")).toContain("A&amp;B&lt;&apos;project&apos;"); await removeScheduler({ targetPath, stateDirectory }); expect(await Bun.file(targetPath).exists()).toBe(false); expect(await readFile(unrelated, "utf8")).toBe("operator's unrelated plist");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("rotation is bounded and refuses a live producer lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-rotate-")), path = join(root, "weekly.log"), producerLease = join(root, "state", "weekly-check.lock"); await mkdir(join(root, "state")); await writeFile(path, "first bytes");
  try { const owner = await acquireFileLease(producerLease); try { await expect(rotateSchedulerLog({ path, producerLease, maxBytes: 2 })).rejects.toThrow("unavailable"); expect(await readFile(path, "utf8")).toBe("first bytes"); } finally { await owner(); }
    expect(await rotateSchedulerLog({ path, producerLease, maxBytes: 2, keep: 2 })).toMatchObject({ rotated: true, bytes: 11 }); expect(await readFile(`${path}.1`, "utf8")).toBe("first bytes");
    await writeFile(path, "second bytes"); await rotateSchedulerLog({ path, producerLease, maxBytes: 2, keep: 2 }); expect(await readFile(`${path}.2`, "utf8")).toBe("first bytes"); expect(await readFile(`${path}.1`, "utf8")).toBe("second bytes"); expect(await readFile(path, "utf8")).toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
});
