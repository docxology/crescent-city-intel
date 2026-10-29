import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBoundedChild, type ChildResult } from "../src/shared/subprocess.ts";
const modules = Object.fromEntries(["browser", "weekly_pipeline", "shared/paths", "shared/orchestration", "shared/transport", "source_registry", "shared/storage"].map(name => [name, new URL(`../src/${name}.ts`, import.meta.url).href]));
describe("real weekly SIGTERM after browser readiness", () => {
  let root: string, pending: Promise<ChildResult> | undefined, controller: AbortController;
  const retained = '{"retained":"last completed edition"}';
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "cci-weekly-interrupt-")); await mkdir(join(root, "state")); await writeFile(join(root, "state", "latest-pipeline-run.json"), retained);
    controller = new AbortController();
  const code = `process.env.HEADLESS_BROWSER='1';process.env.PAGES_BUILD='1';
    const{withOutputRoot}=await import(${JSON.stringify(modules["shared/paths"])});const{withTransportScope}=await import(${JSON.stringify(modules["shared/transport"])});const{SOURCE_REGISTRY}=await import(${JSON.stringify(modules.source_registry)});const{withTerminationSignal}=await import(${JSON.stringify(modules["shared/orchestration"])});const{runWeeklyCheck}=await import(${JSON.stringify(modules.weekly_pipeline)});const{newPage,ownedBrowserPid,closeBrowser}=await import(${JSON.stringify(modules.browser)});const{readFile}=await import('node:fs/promises');
    let requests=0,receivedSignal=false;process.once('SIGTERM',()=>{receivedSignal=true;});const server=Bun.serve({port:0,fetch(){requests++;if(requests===1)setTimeout(()=>process.kill(process.pid,'SIGTERM'),20);return new Promise(()=>{});}});
    const allowedOrigins=[...new Set(SOURCE_REGISTRY.flatMap(s=>[s.canonicalUrl,s.endpointUrl].filter(Boolean).map(u=>new URL(u).origin)))];
    try{await withOutputRoot(${JSON.stringify(root)},async()=>{const page=await newPage({signal:AbortSignal.timeout(20000),timeoutMs:20000});const pid=ownedBrowserPid();if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('Owned browser PID missing');await Bun.write(${JSON.stringify(join(root, "state", "fixture-browser-ready.json"))},JSON.stringify({pid}));const gate=Bun.file(${JSON.stringify(join(root, "state", "fixture-begin"))});const waiting=Date.now();while(!await Bun.file(gate.name).exists()){if(Date.now()-waiting>5000)throw new Error('Parent did not start the interruption check');await Bun.sleep(5);}let failed=false;try{await withTerminationSignal(signal=>withTransportScope({fixture:{origin:'http://127.0.0.1:'+server.port,allowedOrigins}},()=>runWeeklyCheck({outputDir:${JSON.stringify(root)},signal,deadlineMs:5000})));}catch{failed=true;}let browserAlive=true;try{process.kill(-pid,0);}catch{browserAlive=false;}const latest=JSON.parse(await readFile(${JSON.stringify(join(root, "state", "latest-pipeline-attempt.json"))},'utf8'));console.log('RECEIPT:'+JSON.stringify({failed,receivedSignal,requests,browserAlive,pageClosed:page.isClosed(),status:latest.status}));});}finally{server.stop(true);await withOutputRoot(${JSON.stringify(root)},()=>closeBrowser());}`;
    // Setup has its own finite prerequisite. The operation clock below starts
    // only after a real owned browser exists; a missing receipt fails setup.
    pending = runBoundedChild([process.execPath, "-e", code, "--no-notifications"], { timeoutMs: 35_000, maxBytes: 256_000, signal: controller.signal });
    let terminal: ChildResult | undefined;
    void pending.then(result => { terminal = result; });
    const ready = join(root, "state", "fixture-browser-ready.json");
    const started = Date.now();
    // Bun 1.4.2 caches an initial ENOENT on a BunFile; each handshake
    // observation (including the child's gate) needs a fresh file handle.
    while (!await Bun.file(ready).exists()) {
      if (terminal) throw new Error(`Child exited before browser readiness: ${JSON.stringify(terminal)}`);
      if (Date.now() - started > 20_000) throw new Error("Owned browser readiness exceeded its setup bound");
      await Bun.sleep(5);
    }
  }, 25_000);
  test("real SIGTERM during scoped HTTP work retains prior completion, records interruption, reaps browser and exits", async () => {
    const timer = setTimeout(() => controller.abort(new Error("Interruption operation exceeded 10 seconds")), 10_000);
    try {
    await writeFile(join(root, "state", "fixture-begin"), "start");
    const result = await pending!; expect(result.status).toBe("ok"); expect(result.exitCode).toBe(0); expect(result.reaped).toBe(true);
    const line = result.stdout.split(/\r?\n/).find(line => line.startsWith("RECEIPT:")); expect(line).toBeDefined(); const receipt = JSON.parse(line!.slice(8)); expect(receipt.failed).toBe(true); expect(receipt.receivedSignal).toBe(true); expect(receipt.requests).toBeGreaterThan(0); expect(receipt.browserAlive).toBe(false); expect(receipt.pageClosed).toBe(true); expect(receipt.status).toBe("interrupted"); expect(await readFile(join(root, "state", "latest-pipeline-run.json"), "utf8")).toBe(retained);
    expect(await Bun.file(join(root, "state", "weekly-check.lock")).exists()).toBe(false); const [id] = await readdir(join(root, "state", "pipeline-runs")); expect(JSON.parse(await readFile(join(root, "state", "pipeline-runs", id!, "browser-cleanup.json"), "utf8")).status).toBe("closed");
    } finally { clearTimeout(timer); }
  }, 15_000);
  afterAll(async () => {
    controller?.abort();
    await pending;
    if (root) await rm(root, { recursive: true, force: true });
  }, 5000);
});
test("a killed real weekly owner is recoverable; restart preserves interrupted evidence without replacing prior completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-weekly-restart-")); await mkdir(join(root, "state")); const retained = '{"retained":"prior complete"}'; await writeFile(join(root, "state", "latest-pipeline-run.json"), retained);
  const code = `process.env.PAGES_BUILD='1';const{runWeeklyCheck}=await import(${JSON.stringify(modules.weekly_pipeline)});const{withTransportScope}=await import(${JSON.stringify(modules["shared/transport"])});const{SOURCE_REGISTRY}=await import(${JSON.stringify(modules.source_registry)});let ready=false;const server=Bun.serve({port:0,fetch(){if(!ready){ready=true;console.log('READY');}return new Promise(()=>{});}});const allowedOrigins=[...new Set(SOURCE_REGISTRY.flatMap(s=>[s.canonicalUrl,s.endpointUrl].filter(Boolean).map(u=>new URL(u).origin)))];await withTransportScope({fixture:{origin:'http://127.0.0.1:'+server.port,allowedOrigins}},()=>runWeeklyCheck({outputDir:${JSON.stringify(root)},deadlineMs:5000}));`;
  const child = Bun.spawn([process.execPath, "-e", code, "--no-notifications"], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader(); let output = ""; while (!output.includes("READY")) { const part = await reader.read(); if (part.done) throw new Error("Weekly fixture exited before actual HTTP stage"); output += new TextDecoder().decode(part.value); } reader.releaseLock(); child.kill("SIGKILL"); await child.exited;
    const abandoned = JSON.parse(await readFile(join(root, "state", "latest-pipeline-attempt.json"), "utf8")); expect(abandoned.status).toBe("running"); expect(abandoned.owner.pid).toBe(child.pid);
    const controller = new AbortController(); const { runWeeklyCheck } = await import("../src/weekly_pipeline.ts"); const { withTransportScope } = await import("../src/shared/transport.ts"); const { SOURCE_REGISTRY } = await import("../src/source_registry.ts"); const priorPages = process.env.PAGES_BUILD; process.env.PAGES_BUILD = "1"; let requests = 0; const server = Bun.serve({ port: 0, fetch() { requests++; queueMicrotask(() => controller.abort()); return new Promise<Response>(() => {}); } });
    try { const allowedOrigins = [...new Set(SOURCE_REGISTRY.flatMap(source => [source.canonicalUrl, source.endpointUrl].filter((url): url is string => !!url).map(url => new URL(url).origin)))]; await expect(withTransportScope({ fixture: { origin: `http://127.0.0.1:${server.port}`, allowedOrigins } }, () => runWeeklyCheck({ outputDir: root, signal: controller.signal, deadlineMs: 2000 }))).rejects.toThrow(); expect(requests).toBeGreaterThan(0); }
    finally { server.stop(true); if (priorPages === undefined) delete process.env.PAGES_BUILD; else process.env.PAGES_BUILD = priorPages; }
    const current = JSON.parse(await readFile(join(root, "state", "latest-pipeline-attempt.json"), "utf8")); expect(current.runId).not.toBe(abandoned.runId); expect(current.status).toBe("interrupted"); const recovery = JSON.parse(await readFile(join(root, "state", "pipeline-runs", current.runId, "previous-attempt.json"), "utf8")); expect(recovery.runId).toBe(abandoned.runId); expect(recovery.status).toBe("interrupted"); expect(recovery.recoveredBy).toBe(current.runId); expect(await readFile(join(root, "state", "latest-pipeline-run.json"), "utf8")).toBe(retained); expect(await Bun.file(join(root, "state", "weekly-check.lock")).exists()).toBe(false);
  } finally { child.kill(); await child.exited; await rm(root, { recursive: true, force: true }); }
}, 15_000);
