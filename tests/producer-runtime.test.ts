import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { monitorNews, NEWS_FEEDS } from "../src/news_monitor.ts";
import { withTransportScope, boundedHttpFetch } from "../src/shared/transport.ts";
import { executePipelineStep } from "../src/shared/orchestration.ts";
import { acquireFileLease } from "../src/shared/storage.ts";
import { monitorGovMeetings } from "../src/gov_meeting_monitor.ts";
import { OFFICIAL_MEETING_SOURCES } from "../src/official_meetings.ts";
import { buildDigest } from "../src/lifeos_bridge.ts";
const origins = [...new Set(Object.values(NEWS_FEEDS).map(value => new URL(value).origin))];
const rss = (label: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Captured local fixture</title><item><title>Crescent City ${label} announcement</title><link>https://example.test/crescent-city-${label}</link><pubDate>${new Date().toUTCString()}</pubDate><description>Del Norte civic fixture.</description></item></channel></rss>`;
async function waitFor(task: () => boolean): Promise<void> { const deadline = Date.now() + 2000; while (!task()) { if (Date.now() >= deadline) throw new Error("Fixture did not enter real HTTP request"); await new Promise(resolve => setTimeout(resolve, 5)); } }
test("transactional meeting producer preserves the canonical batch prefix consumed by the digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-meetings-reader-")); const server = Bun.serve({ port: 0, fetch(request) { if (new URL(request.url).pathname === "/meetings/get_list") return Response.json([{ id: 112, title: "City Council regular meeting", start_date_short: "2026-09-30", description: "Public civic fixture" }]); return new Response("unavailable fixture subfeed", { status: 404 }); } });
  const fixture = { origin: `http://127.0.0.1:${server.port}`, allowedOrigins: [...new Set(["https://www.crescentcity.org", ...OFFICIAL_MEETING_SOURCES.map(source => new URL(source.url).origin)])] };
  try {
    const produced = await withTransportScope({ fixture }, () => monitorGovMeetings({ outputDir: root })); expect(produced).toHaveLength(1); expect((await readdir(join(root, "gov_meetings"))).filter(name => /^gov_meetings-.*\.json$/.test(name))).toHaveLength(1);
    const digest = await buildDigest({ outputDir: root }); expect(digest.officials.items).toHaveLength(1); expect(digest.officials.items[0]!.title).toBe(produced[0]!.title); expect(digest.officials.items[0]!.url).toBe(produced[0]!.link); expect(digest.officials.items[0]!.date).toBe("2026-09-30");
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});
test("overlapping real HTTP news producers retain captured roots across environment mutation", async () => {
  const a = await mkdtemp(join(tmpdir(), "cci-producer-a-")), b = await mkdtemp(join(tmpdir(), "cci-producer-b-")), third = await mkdtemp(join(tmpdir(), "cci-producer-third-")); const previous = process.env.CC_OUTPUT_DIR;
  let enteredA = 0, enteredB = 0; let releaseA!: () => void, releaseB!: () => void;
  const gateA = new Promise<void>(resolve => { releaseA = resolve; }), gateB = new Promise<void>(resolve => { releaseB = resolve; });
  const left = Bun.serve({ port: 0, async fetch() { enteredA++; await gateA; return new Response(rss("alpha"), { headers: { "content-type": "application/rss+xml" } }); } });
  const right = Bun.serve({ port: 0, async fetch() { enteredB++; await gateB; return new Response(rss("beta"), { headers: { "content-type": "application/rss+xml" } }); } });
  try {
    const first = withTransportScope({ fixture: { origin: `http://127.0.0.1:${left.port}`, allowedOrigins: origins } }, () => monitorNews(undefined, { outputDir: a }));
    const second = withTransportScope({ fixture: { origin: `http://127.0.0.1:${right.port}`, allowedOrigins: origins } }, () => monitorNews(undefined, { outputDir: b }));
    await waitFor(() => enteredA === Object.keys(NEWS_FEEDS).length && enteredB === Object.keys(NEWS_FEEDS).length); process.env.CC_OUTPUT_DIR = third;
    releaseB(); const beta = await second; releaseA(); const alpha = await first; expect(alpha).toHaveLength(1); expect(beta).toHaveLength(1); expect(alpha[0]!.title).toContain("alpha"); expect(beta[0]!.title).toContain("beta");
    for (const [root, label] of [[a, "alpha"], [b, "beta"]] as const) { const files = (await readdir(join(root, "news"))).filter(name => name !== "source-health.json" && !name.endsWith(".jsonl")); expect(files).toHaveLength(1); expect(await readFile(join(root, "news", files[0]!), "utf8")).toContain(label); expect(await readFile(join(root, "state", "news-seen-ids.json"), "utf8")).toContain(label); }
    expect(await readdir(third)).toHaveLength(0);
  } finally { releaseA(); releaseB(); left.stop(true); right.stop(true); if (previous === undefined) delete process.env.CC_OUTPUT_DIR; else process.env.CC_OUTPUT_DIR = previous; await Promise.all([a, b, third].map(root => rm(root, { recursive: true, force: true }))); }
});
test("a stage deadline cancels inherited HTTP work, preserves prior news artifacts and releases the producer lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-producer-abort-")); await mkdir(join(root, "news")); await mkdir(join(root, "state")); const original = '{"retained":"prior-health"}'; await writeFile(join(root, "news", "source-health.json"), original); await writeFile(join(root, "state", "news-seen-ids.json"), "{}"); let entered = 0;
  const server = Bun.serve({ port: 0, fetch() { entered++; return new Promise<Response>(() => {}); } });
  try {
    const started = Date.now(); const result = await withTransportScope({ fixture: { origin: `http://127.0.0.1:${server.port}`, allowedOrigins: origins } }, () => executePipelineStep("captured-news", () => monitorNews(undefined, { outputDir: root }), { timeoutMs: 100, receiptPath: join(root, "state", "step.json") }));
    expect(entered).toBe(Object.keys(NEWS_FEEDS).length); expect(result.report.status).toBe("failed"); expect(Date.now() - started).toBeLessThan(700);
    await new Promise(resolve => setTimeout(resolve, 30)); expect(await readFile(join(root, "news", "source-health.json"), "utf8")).toBe(original); expect(await readFile(join(root, "state", "news-seen-ids.json"), "utf8")).toBe("{}"); expect(await readdir(join(root, "news"))).toEqual(["source-health.json"]);
    const release = await acquireFileLease(join(root, "state", "producers", "news.lock"), { waitMs: 100 }); await release(); expect(JSON.parse(await readFile(join(root, "state", "step.json"), "utf8")).status).toBe("failed");
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});
test("transport fixtures deny unnamed origins, linked child cancellation wins over a request's own timeout", async () => {
  let requests = 0; const server = Bun.serve({ port: 0, fetch() { requests++; return new Promise<Response>(() => {}); } }); const origin = `http://127.0.0.1:${server.port}`; const controller = new AbortController();
  try {
    await expect(withTransportScope({ fixture: { origin, allowedOrigins: ["https://official.example"] } }, () => boundedHttpFetch("https://unlisted.example/path"))).rejects.toThrow("roster"); expect(requests).toBe(0);
    const pending = withTransportScope({ signal: controller.signal, fixture: { origin, allowedOrigins: ["https://official.example"] } }, () => boundedHttpFetch("https://official.example/path", { signal: AbortSignal.timeout(10_000) })); await waitFor(() => requests === 1); controller.abort(); await expect(pending).rejects.toThrow("cancelled");
  } finally { server.stop(true); }
});
test("real news publication disk denial restores health and seen bytes; restart still publishes the unsaved story", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-news-bundle-denial-")); const fs = await import("node:fs/promises"); await mkdir(join(root, "news")); await mkdir(join(root, "state")); const priorHealth = '{"retained":"previous complete news health"}', priorSeen = '{}'; await writeFile(join(root, "news", "source-health.json"), priorHealth); await writeFile(join(root, "state", "news-seen-ids.json"), priorSeen);
  const server = Bun.serve({ port: 0, fetch() { return new Response(rss("retry-after-failure"), { headers: { "content-type": "application/rss+xml" } }); } }); const fixture = { origin: `http://127.0.0.1:${server.port}`, allowedOrigins: origins };
  try {
    await fs.chmod(join(root, "news"), 0o555); await expect(withTransportScope({ fixture }, () => monitorNews(undefined, { outputDir: root }))).rejects.toThrow(); expect(await readFile(join(root, "news", "source-health.json"), "utf8")).toBe(priorHealth); expect(await readFile(join(root, "state", "news-seen-ids.json"), "utf8")).toBe(priorSeen); expect((await readdir(join(root, "news"))).filter(name => name.startsWith("news-"))).toHaveLength(0);
    await fs.chmod(join(root, "news"), 0o755); const restarted = await withTransportScope({ fixture }, () => monitorNews(undefined, { outputDir: root })); expect(restarted).toHaveLength(1); expect(restarted[0]!.title).toContain("retry-after-failure"); const repeated = await withTransportScope({ fixture }, () => monitorNews(undefined, { outputDir: root })); expect(repeated).toHaveLength(0); expect((await readdir(join(root, "news"))).filter(name => name.startsWith("news-"))).toHaveLength(1); expect(await readFile(join(root, "state", "news-seen-ids.json"), "utf8")).toContain("retry-after-failure");
  } finally { server.stop(true); await fs.chmod(join(root, "news"), 0o755); await rm(root, { recursive: true, force: true }); }
});
