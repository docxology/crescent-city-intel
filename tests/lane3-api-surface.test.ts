/**
 * Lane 3 — API surface contracts for GET /api/health and
 * GET /api/events/discover.
 *
 * Zero-mock policy: a real Bun.serve() instance in front of the real route
 * handlers, and real files on disk. Where a test needs a controlled corpus it
 * builds one in a temporary directory and points process.cwd() at it — the
 * same mechanism the production code uses to locate output/ — instead of
 * reaching for a stub.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleApiRoute, getHealthAlertTrends, _resetHealthTrendsCache } from "../src/gui/routes.ts";
import { computeAlertTypeTrends, summarizeAlertTypeTrends, type TimelineEntry } from "../src/alert_analytics.ts";
import { readFileSync } from "fs";

const REPO_ROOT = process.cwd();
const DAY = 24 * 60 * 60 * 1000;

let server: ReturnType<typeof Bun.serve>;
let BASE: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) return handleApiRoute(url, req);
      return new Response("Not found", { status: 404 });
    },
  });
  BASE = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
  process.chdir(REPO_ROOT);
});

/** Documented enum from openapi.yaml — the response must stay inside it. */
const TREND_VALUES = ["rising", "steady", "falling", "changed", "insufficient"];
const ALERT_TYPE_VALUES = ["tsunami", "earthquake", "weather", "tides", "airquality", "wildfire", "marine", "fishing"];

/** Make a temp root holding one alert history file with `count` tsunami records. */
function makeAlertRoot(count: number): string {
  const root = mkdtempSync(join(tmpdir(), "cci-lane3-alerts-"));
  const dir = join(root, "output", "alerts", "tsunami");
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: count }, (_, i) =>
    JSON.stringify({ fetchedAt: new Date(Date.now() - (i + 1) * DAY).toISOString(), severity: "WATCH", headline: `synthetic ${i}` }),
  );
  writeFileSync(join(dir, "history.jsonl"), lines.join("\n") + "\n");
  return root;
}

describe("GET /api/health — alert trend diagnostics are cached and bounded", () => {
  test("two consecutive requests return a byte-identical alertTrends30d block", async () => {
    const first = await fetch(`${BASE}/api/health`);
    const second = await fetch(`${BASE}/api/health`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = await first.json() as Record<string, unknown>;
    const b = await second.json() as Record<string, unknown>;
    expect(JSON.stringify(a.alertTrends30d)).toBe(JSON.stringify(b.alertTrends30d));
  });

  test("alertTrends30d matches the openapi schema and omits the per-event stamp arrays", async () => {
    const body = await (await fetch(`${BASE}/api/health`)).json() as {
      alertTrends30d?: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(body.alertTrends30d)).toBe(true);
    const trends = body.alertTrends30d!;
    expect(trends.map(t => t.type)).toEqual(ALERT_TYPE_VALUES);
    for (const trend of trends) {
      expect(TREND_VALUES).toContain(trend.trend as string);
      expect(typeof trend.count30d).toBe("number");
      expect(typeof trend.countPrevious30d).toBe("number");
      expect(typeof trend.delta).toBe("number");
      expect(typeof trend.futureDated).toBe("number");
      expect(typeof trend.truncated).toBe("boolean");
      expect(typeof trend.eventsPerDay30d).toBe("object");
      // The ~25KB per-response payload the cap exists to remove.
      expect(trend).not.toHaveProperty("eventTimestamps30d");
      // A 30-day window cannot span more than 31 UTC days.
      expect(Object.keys(trend.eventsPerDay30d as object).length).toBeLessThanOrEqual(31);
    }
  });

  test("the cache serves stale counts until it expires, and fresh counts after a reset", async () => {
    const root = makeAlertRoot(3);
    try {
      process.chdir(root);
      _resetHealthTrendsCache();

      const before = await getHealthAlertTrends();
      const beforeCount = before!.find(t => t.type === "tsunami")!.count30d;
      expect(beforeCount).toBe(3);

      // Grow the underlying history. A cached read must not see it.
      appendFileSync(
        join(root, "output", "alerts", "tsunami", "history.jsonl"),
        JSON.stringify({ fetchedAt: new Date().toISOString(), severity: "WATCH", headline: "synthetic new" }) + "\n",
      );
      const cached = await getHealthAlertTrends();
      expect(cached!.find(t => t.type === "tsunami")!.count30d).toBe(beforeCount);

      // Negative control: without the cache the very same call sees the file.
      _resetHealthTrendsCache();
      const refreshed = await getHealthAlertTrends();
      expect(refreshed!.find(t => t.type === "tsunami")!.count30d).toBe(beforeCount + 1);
    } finally {
      process.chdir(REPO_ROOT);
      _resetHealthTrendsCache();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("computeAlertTypeTrends — truncation, future stamps, and the 0<->1 boundary", () => {
  const now = new Date("2026-08-28T12:00:00Z");
  const entry = (ageDays: number): TimelineEntry => ({
    timestamp: new Date(now.getTime() - ageDays * DAY).toISOString(),
    type: "tsunami",
    severity: "WATCH",
    description: "synthetic",
    record: {},
  });

  test("a timeline truncated inside the 60-day span reports insufficient, not a trend", () => {
    const entries = [entry(1), entry(2), entry(3), entry(4)];
    const confident = computeAlertTypeTrends(entries, now).find(t => t.type === "tsunami")!;
    expect(confident.trend).toBe("rising");
    expect(confident.truncated).toBe(false);

    // Same entries, but the caller declares the history was cut at 10 days ago:
    // the previous window is unobservable, so the rise is not assertable.
    const truncated = computeAlertTypeTrends(entries, now, {
      retainedFrom: new Date(now.getTime() - 10 * DAY).toISOString(),
    }).find(t => t.type === "tsunami")!;
    expect(truncated.truncated).toBe(true);
    expect(truncated.trend).toBe("insufficient");

    // Negative control: a floor older than the full 60-day span is no constraint.
    const covered = computeAlertTypeTrends(entries, now, {
      retainedFrom: new Date(now.getTime() - 90 * DAY).toISOString(),
    }).find(t => t.type === "tsunami")!;
    expect(covered.truncated).toBe(false);
    expect(covered.trend).toBe("rising");
  });

  test("future-dated stamps are excluded from both windows and counted, not silently dropped", () => {
    const future: TimelineEntry = { ...entry(0), timestamp: new Date(now.getTime() + 2 * DAY).toISOString() };
    const trend = computeAlertTypeTrends([entry(1), future], now).find(t => t.type === "tsunami")!;
    expect(trend.count30d).toBe(1);
    expect(trend.countPrevious30d).toBe(0);
    expect(trend.futureDated).toBe(1);
  });

  test("0 <-> 1 is reported as changed; 1 <-> 2 inside the same band stays steady", () => {
    const appeared = computeAlertTypeTrends([entry(1)], now).find(t => t.type === "tsunami")!;
    expect(appeared.delta).toBe(1);
    expect(appeared.trend).toBe("changed");

    const disappeared = computeAlertTypeTrends([entry(45)], now).find(t => t.type === "tsunami")!;
    expect(disappeared.delta).toBe(-1);
    expect(disappeared.trend).toBe("changed");

    const steady = computeAlertTypeTrends([entry(1), entry(2), entry(45)], now).find(t => t.type === "tsunami")!;
    expect(steady.delta).toBe(1);
    expect(steady.trend).toBe("steady");
  });

  test("an entry with a null timestamp is excluded, not bucketed at the epoch", () => {
    const undatedEntry = { ...entry(1), timestamp: null } as unknown as TimelineEntry;
    const trend = computeAlertTypeTrends([entry(1), undatedEntry], now).find(t => t.type === "tsunami")!;
    expect(trend.count30d).toBe(1);
    expect(trend.countPrevious30d).toBe(0);
  });

  test("summarizeAlertTypeTrends folds the stamp array into a bounded per-day histogram", () => {
    const trends = computeAlertTypeTrends([entry(1), entry(1.2), entry(5)], now);
    const summary = summarizeAlertTypeTrends(trends).find(t => t.type === "tsunami")!;
    expect(summary).not.toHaveProperty("eventTimestamps30d");
    const total = Object.values(summary.eventsPerDay30d).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(3);
    expect(Object.keys(summary.eventsPerDay30d).length).toBe(2);
  });
});

describe("GET /api/events/discover — persisted by default, validated pagination", () => {
  /** Temp root holding a known persisted discovery artifact. */
  function makeDiscoveryRoot(eventCount: number): { root: string; generatedAt: string } {
    const root = mkdtempSync(join(tmpdir(), "cci-lane3-discover-"));
    const dir = join(root, "output", "events");
    mkdirSync(dir, { recursive: true });
    const generatedAt = "2026-01-02T03:04:05.000Z";
    const artifact = {
      schemaVersion: "crescent-city-events-discovery/v1",
      generatedAt,
      counts: { sourcesOk: 2, sourcesErrored: 0, fetched: eventCount, droppedAmbiguous: 0, droppedUndated: 0, conflictsFlagged: 0, reconciled: 0, count: eventCount },
      sources: [],
      provenance: { groundRules: [], reconciledAgainst: "output/events/events.json" },
      events: Array.from({ length: eventCount }, (_, i) => ({ id: `persisted-${i}`, title: `Persisted event ${i}` })),
    };
    writeFileSync(join(dir, "event_discovery.json"), JSON.stringify(artifact));
    return { root, generatedAt };
  }

  test("the default response is read from disk — no source is fetched", async () => {
    const { root, generatedAt } = makeDiscoveryRoot(7);
    try {
      process.chdir(root);
      const res = await fetch(`${BASE}/api/events/discover`);
      expect(res.status).toBe(200);
      const body = await res.json() as { source: string; generatedAt: string; events: unknown[]; counts: { count: number } };
      expect(body.source).toBe("persisted");
      // Proof it is the file and not a rebuild: a live build would stamp
      // generatedAt with the request instant and would not find these ids.
      expect(body.generatedAt).toBe(generatedAt);
      expect(body.events.length).toBe(7);
      expect(body.counts.count).toBe(7);
      expect((body.events as Array<{ id: string }>)[0].id).toBe("persisted-0");
    } finally {
      process.chdir(REPO_ROOT);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("limit is honored over the persisted artifact and pages the envelope", async () => {
    const { root } = makeDiscoveryRoot(7);
    try {
      process.chdir(root);
      const body = await (await fetch(`${BASE}/api/events/discover?limit=1`)).json() as {
        source: string; total: number; offset: number; limit: number; count: number; events: Array<{ id: string }>; counts: { count: number };
      };
      expect(body.source).toBe("persisted");
      expect(body.limit).toBe(1);
      expect(body.offset).toBe(0);
      expect(body.count).toBe(1);
      expect(body.total).toBe(7);
      // Top-level count is the page; counts.count remains the artifact total.
      expect(body.counts.count).toBe(7);
      expect(body.events.map(e => e.id)).toEqual(["persisted-0"]);

      const offsetPage = await (await fetch(`${BASE}/api/events/discover?limit=3&offset=5`)).json() as { count: number; events: Array<{ id: string }> };
      expect(offsetPage.count).toBe(2);
      expect(offsetPage.events.map(e => e.id)).toEqual(["persisted-5", "persisted-6"]);
    } finally {
      process.chdir(REPO_ROOT);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("limit=0 is a 400, not a silent page of 50", async () => {
    const res = await fetch(`${BASE}/api/events/discover?limit=0`);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("limit");
  });

  test("non-integer limit and offset are 400s; limit=1 is the negative control", async () => {
    expect((await fetch(`${BASE}/api/events/discover?limit=abc`)).status).toBe(400);
    expect((await fetch(`${BASE}/api/events/discover?offset=abc`)).status).toBe(400);
    expect((await fetch(`${BASE}/api/events/discover?offset=-1`)).status).toBe(400);
    expect((await fetch(`${BASE}/api/events/discover?limit=1`)).status).toBe(200);
  });

  test("with no persisted artifact the offline shell is served, never a network fan-out", async () => {
    const root = mkdtempSync(join(tmpdir(), "cci-lane3-empty-"));
    try {
      process.chdir(root);
      const body = await (await fetch(`${BASE}/api/events/discover`)).json() as { source: string; events: unknown[] };
      expect(body.source).toBe("offline-shell");
      expect(Array.isArray(body.events)).toBe(true);
    } finally {
      process.chdir(REPO_ROOT);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("openapi documents the parameters and count fields this route now serves", () => {
    const spec = readFileSync(join(REPO_ROOT, "openapi.yaml"), "utf-8");
    const section = spec.slice(spec.indexOf("  /api/events/discover:"), spec.indexOf("  /api/alerts/recent:"));
    expect(section).toContain("name: refresh");
    expect(section).toContain("'400':");
    expect(section).toContain("enum: [persisted, network, offline-shell]");
    // The count/counts.count ambiguity the R3 audit flagged must be spelled out.
    expect(section).toContain("counts.count");
  });
});
