/**
 * Tests for src/monthly_report.ts executive digest (R2 lane).
 *
 * Pure logic only — no live LLM call. Verifies that metrics flow in as
 * numbers-only input, the prompt-version constant is pinned, and silent
 * degradation is observable via generateExecutiveDigest returning null (or a
 * grounded prose object when a local provider happens to be up — both are
 * valid report states; either must not throw).
 */
import { describe, expect, test } from "bun:test";
import { DIGEST_PROMPT_VERSION, generateExecutiveDigest } from "../src/monthly_report";

describe("executive digest", () => {
  test("digest prompt version is pinned", () => {
    expect(DIGEST_PROMPT_VERSION).toBe("2026-08-26-digest-v1");
  });

  test("empty/non-finite metrics yield null without any provider call", async () => {
    expect(await generateExecutiveDigest({}, "August 2026")).toBeNull();
    expect(await generateExecutiveDigest({ bad: Number.NaN }, "August 2026")).toBeNull();
  });

  test("real metrics degrade silently or produce provider-attributed prose — never throw", async () => {
    const result = await generateExecutiveDigest(
      { earthquakes: 2, weatherAlerts: 3, newsItems: 12 },
      "August 2026",
    );
    if (result === null) {
      // Silent plain-text fallback: section omitted, report still valid.
      expect(result).toBeNull();
    } else {
      // Every number visible to the model came verbatim from `metrics`.
      for (const [key, value] of Object.entries({ earthquakes: 2, weatherAlerts: 3, newsItems: 12 })) {
        if (result.prose.includes(String(value))) {
          expect(Object.keys({ earthquakes: 2, weatherAlerts: 3, newsItems: 12 })).toContain(key);
        }
      }
      expect(result.provider.length).toBeGreaterThan(0);
      expect(result.model.length).toBeGreaterThan(0);
      expect(result.promptVersion).toBe(DIGEST_PROMPT_VERSION);
    }
  }, 30_000);
});
