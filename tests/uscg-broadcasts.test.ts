/**
 * Tests for src/alerts/uscg_broadcasts.ts — the 15th alert monitor (USCG
 * District 11 Broadcast Notices to Mariners). Pure classifiers over real
 * captured NAVCEN pages (tests/fixtures/uscg/, verbatim USCG public-domain
 * content, captured live 2026-09-08) plus the roster/source-health wiring
 * contracts in composite.ts, source_health.ts and alert_analytics.ts.
 * No network, no mocks.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendUscgHistory,
  buildUscgBroadcastReport,
  classifyUscgBroadcast,
  isNorthCoastBroadcast,
  parseBnmListing,
  parseBnmMessage,
  parseBnmTimestamp,
  uscgHistoryPath,
  USCG_SOURCE_NAME,
  type UscgBnmRow,
} from "../src/alerts/uscg_broadcasts";
import {
  buildExtendedMonitorDefinitions,
  classifySourceHealth,
  EXTENDED_MONITOR_SPECS,
  MONITOR_KEYS,
  NULL_ON_FAILURE_MONITORS,
} from "../src/alerts/composite";
import { ALERT_TYPES } from "../src/alert_analytics";
import { EXPECTED_SOURCE_HEALTH } from "../src/shared/source_health";

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "uscg");
const listingFixture = readFileSync(join(FIXTURE_DIR, "bnm-d11-listing.html"), "utf-8");
const messageFixture = readFileSync(join(FIXTURE_DIR, "bnm-message-68955277.html"), "utf-8");

describe("parseBnmListing", () => {
  test("extracts every data row from the real District 11 listing", () => {
    const rows = parseBnmListing(listingFixture);
    expect(rows.length).toBe(10);
    // Every row carries a guid + detail URL; headers/sort/pagination rows are skipped.
    for (const row of rows) {
      expect(row.guid).toMatch(/^\d+$/);
      expect(row.url).toBe(`https://www.navcen.uscg.gov/broadcast-notice-to-mariners-message?guid=${row.guid}`);
    }
    expect(new Set(rows.map(r => r.guid)).size).toBe(rows.length);
  });

  test("reads the full field shape of a real row", () => {
    const rows = parseBnmListing(listingFixture);
    const first = rows[0]!;
    expect(first.guid).toBe("69756777");
    expect(first.originator).toBe("D11");
    expect(first.criticality).toBe("SAFETY");
    expect(first.location).toBe("Pacific ocean");
    expect(first.descriptor).toBe("SPACE OPERATIONS");
    expect(first.msgId).toBe("CGD-SW BNM 9105-26");
    expect(first.publishedAt).toBe("2026-09-04T11:03:12.000Z"); // 07:03:12 -0400
    expect(first.synopsis).toBeNull();
  });

  test("an empty or alien page yields no rows instead of garbage", () => {
    expect(parseBnmListing("")).toEqual([]);
    expect(parseBnmListing("<html><body><table><tr><td>no notices here</td></tr></table></body></html>")).toEqual([]);
  });
});

describe("parseBnmTimestamp", () => {
  test("normalizes NAVCEN listing stamps to ISO", () => {
    expect(parseBnmTimestamp("2026-09-04 07:03:12 -0400")).toBe("2026-09-04T11:03:12.000Z");
    expect(parseBnmTimestamp("2026-06-15 17:13:53 -0400")).toBe("2026-06-15T21:13:53.000Z");
  });

  test("returns null for unparseable input", () => {
    expect(parseBnmTimestamp("")).toBeNull();
    expect(parseBnmTimestamp("not a date")).toBeNull();
  });
});

describe("parseBnmMessage", () => {
  test("extracts the full broadcast text from the real message page", () => {
    const synopsis = parseBnmMessage(messageFixture);
    expect(synopsis).not.toBeNull();
    expect(synopsis).toContain("HUMBOLDT BAY LIGHTED BELL BUOY 10 (LLNR 8200)");
    expect(synopsis).toContain("DREDGING OPERATIONS");
    expect(synopsis).toContain("40-45-29.072N 124-13-09.721W");
    // The NOS "BT" terminator is stripped, not carried into the synopsis.
    expect(synopsis!.includes("BT")).toBe(false);
    expect(synopsis).not.toContain("Message Originator");
  });

  test("returns null when the page no longer carries the message block", () => {
    expect(parseBnmMessage("")).toBeNull();
    expect(parseBnmMessage("<html><body>maintenance page</body></html>")).toBeNull();
  });
});

describe("isNorthCoastBroadcast relevance filter", () => {
  const base = { originator: "D11", location: "Pacific ocean", descriptor: "SPACE OPERATIONS", msgId: "CGD-SW BNM 9105-26" };

  test("far-field district traffic is filtered out", () => {
    expect(isNorthCoastBroadcast(base)).toBe(false);
    expect(isNorthCoastBroadcast({ ...base, synopsis: "ROCKET LAUNCH HAZARD AREA OFF CENTRAL CALIFORNIA" })).toBe(false);
  });

  test("North Coast place names are relevant", () => {
    expect(isNorthCoastBroadcast({ ...base, location: "HUMBOLDT BAY", descriptor: "ATON", msgId: "SEC SHB BNM 0011-26", originator: "Humboldt Bay" })).toBe(true);
    expect(isNorthCoastBroadcast({ ...base, descriptor: "BAR", msgId: "CGD-SW BNM 0001-26", location: "Crescent City" })).toBe(true);
    expect(isNorthCoastBroadcast({ ...base, location: "Del Norte County", descriptor: "ATON" })).toBe(true);
  });

  test("the synopsis is searched too when one was fetched", () => {
    expect(isNorthCoastBroadcast({ ...base, synopsis: "BUOY 10 OFF CRESCENT CITY RELOCATED FOR DREDGING" })).toBe(true);
  });

  test("matching is case-insensitive", () => {
    expect(isNorthCoastBroadcast({ ...base, location: "hUmBoLdT bAy" })).toBe(true);
  });
});

describe("classifyUscgBroadcast", () => {
  test("informational criticalities map onto the two-level scale", () => {
    expect(classifyUscgBroadcast("SAFETY")).toBe("ADVISORY");
    expect(classifyUscgBroadcast("safety")).toBe("ADVISORY");
    expect(classifyUscgBroadcast("CANCELLATION")).toBe("CALM");
    expect(classifyUscgBroadcast("SUMMARY")).toBe("CALM");
    expect(classifyUscgBroadcast("")).toBe("ADVISORY");
    expect(classifyUscgBroadcast("SOMETHING NEW")).toBe("ADVISORY");
  });
});

describe("buildUscgBroadcastReport", () => {
  test("an empty listing produces an empty-but-present report", () => {
    const report = buildUscgBroadcastReport([], "2026-09-08T12:00:00.000Z");
    expect(report.items).toEqual([]);
    expect(report.totalBroadcasts).toBe(0);
    expect(report.relevantCount).toBe(0);
    expect(report.worstLevel).toBe("CALM");
    expect(report.summary).toContain("No Del Norte / North Coast broadcasts");
  });

  test("keeps only relevant items and reports the district-wide scan count", () => {
    const rows = parseBnmListing(listingFixture);
    rows.push({
      guid: "1",
      msgId: "SEC SHB BNM 0011-26",
      originator: "Humboldt Bay",
      criticality: "SAFETY",
      location: "HUMBOLDT BAY",
      descriptor: "ATON",
      publishedAt: "2026-06-15T21:13:53.000Z",
      url: "https://www.navcen.uscg.gov/broadcast-notice-to-mariners-message?guid=1",
      synopsis: null,
    });
    const report = buildUscgBroadcastReport(rows, "2026-09-08T12:00:00.000Z");
    expect(report.totalBroadcasts).toBe(rows.length);
    expect(report.relevantCount).toBe(1);
    expect(report.items.map(item => item.guid)).toEqual(["1"]);
    expect(report.worstLevel).toBe("ADVISORY");
    expect(report.summary).toContain("SEC SHB BNM 0011-26");
  });
});

describe("history append (artifact-root seam, tmp dir only)", () => {
  let root: string;
  let previousEnv: string | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cci-uscg-test-"));
    previousEnv = process.env.CC_OUTPUT_DIR;
    process.env.CC_OUTPUT_DIR = root;
  });
  afterAll(() => {
    if (previousEnv === undefined) delete process.env.CC_OUTPUT_DIR;
    else process.env.CC_OUTPUT_DIR = previousEnv;
    rmSync(root, { recursive: true, force: true });
  });

  const row = (guid: string): UscgBnmRow => ({
    guid,
    msgId: `SEC SHB BNM 00${guid}-26`,
    originator: "Humboldt Bay",
    criticality: "SAFETY",
    location: "HUMBOLDT BAY",
    descriptor: "ATON",
    publishedAt: "2026-06-15T21:13:53.000Z",
    url: `https://www.navcen.uscg.gov/broadcast-notice-to-mariners-message?guid=${guid}`,
    synopsis: "BUOY RELOCATED",
  });

  test("writes to output/alerts/uscg/history.jsonl under the seam, deduplicated by guid", () => {
    appendUscgHistory([row("1"), row("2")], "2026-09-08T12:00:00.000Z");
    const file = join(root, "alerts", "uscg", "history.jsonl");
    expect(uscgHistoryPath()).toBe(file);
    expect(existsSync(file)).toBe(true);
    const lines = () => readFileSync(file, "utf-8").split("\n").filter(Boolean);
    expect(lines().length).toBe(2);

    // Same guids again: no duplicate history rows.
    appendUscgHistory([row("1"), row("2")], "2026-09-08T13:00:00.000Z");
    expect(lines().length).toBe(2);

    // A new guid appends exactly one record.
    appendUscgHistory([row("3")], "2026-09-08T14:00:00.000Z");
    expect(lines().length).toBe(3);

    const last = JSON.parse(lines().at(-1)!);
    expect(last).toMatchObject({
      id: "uscg-3",
      guid: "3",
      level: "ADVISORY",
      summary: "BUOY RELOCATED",
      fetchedAt: "2026-09-08T14:00:00.000Z",
    });
  });
});

describe("monitor wiring contracts (15th monitor)", () => {
  test("uscg is registered as the last MONITOR_KEY and in the null-on-failure family", () => {
    expect(MONITOR_KEYS.length).toBe(15);
    expect(MONITOR_KEYS[MONITOR_KEYS.length - 1]).toBe("uscg");
    expect(NULL_ON_FAILURE_MONITORS.has("uscg")).toBe(true);
  });

  test("the extended-monitor spec carries the NAVCEN listing URL and source name", () => {
    const spec = EXTENDED_MONITOR_SPECS.find(([, key]) => key === "uscg");
    expect(spec).toBeDefined();
    expect(spec![0]).toBe(USCG_SOURCE_NAME);
    expect(spec![2]).toBe("items");
    expect(spec![3]).toContain("broadcast-notice-to-mariners-search-results");
  });

  test("empty report reads as present/empty source health; a null read is unavailable", () => {
    const settled = (
      value: unknown,
      status: "fulfilled" | "rejected" = "fulfilled",
    ): PromiseSettledResult<unknown> => (status === "fulfilled" ? { status, value } : { status, reason: new Error("fixture") });
    // Default `now` (real clock) keeps fetchedAt inside the freshness window,
    // so the empty item count reads as "empty", not "stale".
    const emptyReport = buildUscgBroadcastReport([]);
    const monitorErrors = new Map<string, string>();

    const definitions = buildExtendedMonitorDefinitions({ uscg: settled(emptyReport) });
    const emptyHealth = classifySourceHealth(definitions.find(d => d.key === "uscg")!, settled(emptyReport), monitorErrors);
    expect(emptyHealth.status).toBe("empty");
    expect(emptyHealth.source).toBe(USCG_SOURCE_NAME);
    expect(emptyHealth.itemCount).toBe(0);

    const unavailableHealth = classifySourceHealth(
      buildExtendedMonitorDefinitions({ uscg: settled(null) }).find(d => d.key === "uscg")!,
      settled(null),
      monitorErrors.set("uscg", "monitor returned no report"),
    );
    expect(unavailableHealth.status).toBe("unavailable");
  });

  test("alert analytics and expected source health include the new type", () => {
    expect(ALERT_TYPES).toContain("uscg");
    expect(EXPECTED_SOURCE_HEALTH.some(entry => entry.source === USCG_SOURCE_NAME)).toBe(true);
    expect(EXPECTED_SOURCE_HEALTH.find(entry => entry.source === USCG_SOURCE_NAME)?.monitor).toBe("alerts");
  });
});
