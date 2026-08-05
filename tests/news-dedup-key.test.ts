/**
 * Regression test for the pagination-collapse dedup bug in src/news_monitor.ts.
 * A URL-only dedup key dropped distinct articles that share a canonical path
 * (e.g. paginated listings); the composite URL|title key keeps them distinct.
 * Zero-mock: tests the pure dedupKey() contract directly.
 */
import { describe, test, expect } from "bun:test";
import { dedupKey, normalizeUrl } from "../src/news_monitor.ts";

describe("normalizeUrl", () => {
  test("strips tracking params and trailing slash", () => {
    expect(normalizeUrl("https://example.com/a/?utm_source=x&ref=y")).toBe("https://example.com/a");
  });
});

describe("dedupKey", () => {
  test("same URL + different titles => DIFFERENT keys (distinct paginated articles kept)", () => {
    const url = "https://eureka.example.com/page/2";
    expect(dedupKey(url, "Council moves on harbor")).not.toBe(dedupKey(url, "Weather outlook for the coast"));
  });

  test("same URL + same title => SAME key (cross-feed dedup still works)", () => {
    const url = "https://eureka.example.com/story/123";
    expect(dedupKey(url, "Harbor Commission Agenda")).toBe(dedupKey(url, "  HARBOR COMMISSION AGENDA  "));
  });

  test("tracking-param variants of the same item collapse to one key", () => {
    const a = dedupKey("https://eureka.example.com/story/1?utm_campaign=x", "Tsunami drill");
    const b = dedupKey("https://eureka.example.com/story/1", "Tsunami drill");
    expect(a).toBe(b);
  });
});
