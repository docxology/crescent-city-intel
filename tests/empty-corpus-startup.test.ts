import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAllArticles } from "../src/shared/data.ts";
import { runBoundedChild } from "../src/shared/subprocess.ts";

const serverPath = new URL("../src/gui/server.ts", import.meta.url).pathname;
interface StartupReceipt { started: boolean; exitCode?: number; searchStatus?: number; total?: number; count?: number; statsStatus?: number }

/** An actual GUI entrypoint in a bounded owned group, with no provider calls. */
async function startGui(root: string): Promise<StartupReceipt> {
  const code = `
    const {spawn}=await import('node:child_process');
    const child=spawn(process.execPath,['run',${JSON.stringify(serverPath)}],{env:{...process.env,CC_OUTPUT_DIR:${JSON.stringify(root)},PORT:'0',LOG_LEVEL:'info',CRESCENT_CITY_API_KEY:'owned-empty-corpus-fixture',PAGES_BUILD:'1'},stdio:['ignore','pipe','pipe']});
    let output='',errors='',timer;const exited=new Promise(resolve=>child.once('close',resolve));
    child.stderr.on('data',chunk=>{errors+=chunk.toString();if(errors.length>65536)child.kill('SIGKILL');});
    try{
      const url=await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('startup timeout')),4000);child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>65536){child.kill('SIGKILL');reject(new Error('startup output limit'));}const port=parseInt(output.split('running at http://localhost:')[1]??'',10);if(Number.isInteger(port))resolve('http://127.0.0.1:'+port);});child.once('close',code=>reject(new Error('GUI exited '+code)));});
      clearTimeout(timer);const search=await fetch(url+'/api/search?q=harbor',{headers:{'x-api-key':'owned-empty-corpus-fixture'},signal:AbortSignal.timeout(2000)});const data=await search.json();const stats=await fetch(url+'/api/stats',{signal:AbortSignal.timeout(2000)});
      console.log('RECEIPT:'+JSON.stringify({started:true,searchStatus:search.status,total:data.total,count:data.count,statsStatus:stats.status}));
    }catch(error){clearTimeout(timer);child.kill('SIGKILL');const exitCode=await exited;console.log('RECEIPT:'+JSON.stringify({started:false,exitCode}));}
    finally{clearTimeout(timer);child.kill('SIGKILL');await exited;}
  `;
  const result = await runBoundedChild([process.execPath, "-e", code], { timeoutMs: 8000, maxBytes: 128_000 });
  if (result.status !== "ok") throw new Error(`GUI fixture owner failed: ${result.status}: ${result.stderr}`);
  expect(result.status).toBe("ok"); expect(result.exitCode).toBe(0); expect(result.reaped).toBe(true);
  const line = result.stdout.split(/\r?\n/).find(line => line.startsWith("RECEIPT:"));
  expect(line).toBeDefined(); return JSON.parse(line!.slice(8)) as StartupReceipt;
}

test("real GUI starts with an absent root or a genuinely empty articles directory", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "cci-empty-startup-"));
  try {
    for (const root of [join(fixture, "absent"), join(fixture, "empty")]) {
      if (root.endsWith("empty")) await mkdir(join(root, "articles"), { recursive: true });
      expect(await loadAllArticles(root)).toEqual([]);
      expect(await startGui(root)).toMatchObject({ started: true, searchStatus: 200, total: 0, count: 0, statsStatus: 404 });
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
}, 20_000);

test("real GUI refuses orphan article bytes and malformed manifests without altering them", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "cci-corrupt-startup-"));
  try {
    const orphan = join(fixture, "orphan"); await mkdir(join(orphan, "articles"), { recursive: true });
    const sentinel = '{"retained":"partial source edition"}'; const articlePath = join(orphan, "articles", "sentinel.json"); await writeFile(articlePath, sentinel);
    await expect(loadAllArticles(orphan)).rejects.toThrow("without a manifest");
    const orphanReceipt = await startGui(orphan); expect(orphanReceipt.started).toBe(false); expect(orphanReceipt.exitCode).toBeGreaterThan(0); expect(await readFile(articlePath, "utf8")).toBe(sentinel);
    const malformed = join(fixture, "malformed"); await mkdir(join(malformed, "articles"), { recursive: true });
    const manifestPath = join(malformed, "manifest.json"); await writeFile(manifestPath, '{"articles":');
    await expect(loadAllArticles(malformed)).rejects.toThrow(); const malformedReceipt = await startGui(malformed);
    expect(malformedReceipt.started).toBe(false); expect(malformedReceipt.exitCode).toBeGreaterThan(0); expect(await readFile(manifestPath, "utf8")).toBe('{"articles":');
  } finally { await rm(fixture, { recursive: true, force: true }); }
}, 20_000);

test("missing articles never conceal declared, malformed, linked or orphan core corpus data", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "cci-empty-boundary-"));
  try {
    await writeFile(join(fixture, "manifest.json"), "null"); await expect(loadAllArticles(fixture)).rejects.toThrow("Invalid corpus manifest");
    await writeFile(join(fixture, "manifest.json"), JSON.stringify({ articles: { declared: { sha256: "0".repeat(64), sectionCount: 1 } } }));
    await expect(loadAllArticles(fixture)).rejects.toThrow("corpus is incomplete"); await rm(join(fixture, "manifest.json"));
    await writeFile(join(fixture, "toc.json"), "{}"); await expect(loadAllArticles(fixture)).rejects.toThrow("without a manifest"); await rm(join(fixture, "toc.json"));
    await mkdir(join(fixture, "elsewhere")); await symlink(join(fixture, "elsewhere"), join(fixture, "articles"));
    await expect(loadAllArticles(fixture)).rejects.toThrow("symlinks");
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
