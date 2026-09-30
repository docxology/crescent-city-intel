import { describe, test, expect } from "bun:test";
import {
  detectCloudflareStall,
  withRetry,
  isArticleArtifactShapeValid,
  isTocShapeValid,
} from "../src/scraper_utils.js";

const validToc = {
  type: "code",
  guid: "root",
  tocName: "Crescent City",
  children: [{ type: "article", guid: "article-1", children: [{ type: "section", guid: "section-1", children: [] }] }],
};

describe("isTocShapeValid", () => {
  test("accepts a recursive TOC with sections", () => {
    expect(isTocShapeValid(validToc)).toBe(true);
  });

  test("rejects an empty, duplicate, or non-TOC payload", () => {
    expect(isTocShapeValid({ type: "code", guid: "root", tocName: "Crescent City", children: [] })).toBe(false);
    expect(isTocShapeValid({ ...validToc, children: [{ ...validToc.children[0], children: [{ type: "section", guid: "section-1", children: [] }, { type: "section", guid: "section-1", children: [] }] }] })).toBe(false);
    expect(isTocShapeValid({ error: "challenge" })).toBe(false);
  });
});

describe("detectCloudflareStall", () => {
  test("returns true when elapsed time exceeds maxWait", () => {
    const past = Date.now() - 15_000;
    expect(detectCloudflareStall(past, 10_000)).toBe(true);
  });

  test("returns false when elapsed time is under maxWait", () => {
    const recent = Date.now() - 5_000;
    expect(detectCloudflareStall(recent, 10_000)).toBe(false);
  });

  test("returns false for just-started timer", () => {
    expect(detectCloudflareStall(Date.now(), 10_000)).toBe(false);
  });
});

describe("isArticleArtifactShapeValid", () => {
  test("rejects an empty or partial article artifact before resume-skip", () => {
    expect(isArticleArtifactShapeValid({ guid: "a", rawHtml: "", sha256: "a".repeat(64), sections: [] }, ["section-1"])).toBe(false);
    expect(isArticleArtifactShapeValid({ guid: "a", rawHtml: "", sha256: "a".repeat(64), sections: [{ guid: "section-1" }] }, ["section-1"])).toBe(false);
    const section = { guid: "section-1", number: "1", title: "Title", html: "<p>Text</p>", text: "Text", history: "" };
    const valid = { guid: "a", url: "https://ecode360.com/a", title: "Article", number: "1", scrapedAt: "2026-09-30T00:00:00Z", rawHtml: "<p>Text</p>", sha256: "a".repeat(64), sections: [section] };
    expect(isArticleArtifactShapeValid(valid, ["section-1"], true)).toBe(true);
    expect(isArticleArtifactShapeValid({ ...valid, sections: [section, section] }, ["section-1"], true)).toBe(false);
  });

  test("rejects malformed hashes and non-object sections", () => {
    expect(isArticleArtifactShapeValid({ guid: "a", rawHtml: "html", sha256: "bad", sections: [{ guid: "section-1" }] }, ["section-1"])).toBe(false);
    expect(isArticleArtifactShapeValid({ guid: "a", rawHtml: "html", sha256: "a".repeat(64), sections: [null] }, ["section-1"])).toBe(false);
  });

  test("can reject stale extra sections after TOC drift", () => {
    const artifact = { guid: "a", rawHtml: "html", sha256: "a".repeat(64), sections: [{ guid: "section-1" }, { guid: "old-section" }] };
    expect(isArticleArtifactShapeValid(artifact, ["section-1"], true)).toBe(false);
  });
});

describe("withRetry", () => {
  test("succeeds on first try", async () => {
    let calls = 0;
    const { result, retried, attempts } = await withRetry(async () => {
      calls++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(retried).toBe(false);
    expect(attempts).toBe(1);
    expect(calls).toBe(1);
  });

  test("retries on failure and eventually succeeds", async () => {
    let calls = 0;
    const { result, retried, attempts } = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error("fail");
      return "ok";
    }, 3, 10); // 10ms base delay for fast tests
    expect(result).toBe("ok");
    expect(retried).toBe(true);
    expect(attempts).toBe(3);
    expect(calls).toBe(3);
  });

  test("throws after max retries", async () => {
    let calls = 0;
    try {
      await withRetry(async () => {
        calls++;
        throw new Error("always fail");
      }, 2, 10);
      expect(false).toBe(true); // should not reach
    } catch (err: any) {
      expect(err.message).toBe("always fail");
      expect(calls).toBe(3); // initial + 2 retries
    }
  });
});
