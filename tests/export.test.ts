/**
 * Dedicated test file for the export builders (src/export.ts).
 *
 * Historically src/export.ts ran its whole export `main()` at module load, so
 * it could not be imported safely — this is the "export.test.ts absent"
 * deferred Minor. The builders are now PURE (return data / strings, no I/O)
 * and main() is guarded by import.meta.main, so the four output formats
 * (consolidated JSON, markdown files, plain text, section CSV) are directly
 * testable. Zero-mock: real builders, synthetic-but-realistic fixtures.
 */
import { describe, test, expect } from "bun:test";
import type { TocNode, ArticlePage, SectionContent } from "../src/types.ts";
import {
  buildConsolidatedJson,
  buildMarkdownFiles,
  buildPlainText,
  buildSectionIndexCsv,
} from "../src/export.ts";

function section(number: string, title: string, text: string, history?: string): SectionContent {
  return { guid: `g-${number}`, number, title, text, html: `<div class="para">${text}</div>`, history: history ?? "" };
}

function article(number: string, title: string, sections: SectionContent[], guid = `art-${number}`): ArticlePage {
  return { guid, url: `https://ecode360.com/${guid}`, title, number, rawHtml: "<html></html>", sections, sha256: "x".repeat(64), scrapedAt: "2026-01-01T00:00:00.000Z" };
}

function tocFixture(chapterGuid = "chap-8", appendixGuid = "appx-A"): TocNode {
  const chapter: TocNode = {
    prefix: "", tocName: "Code", guid: chapterGuid, parent: "title-8", href: "",
    title: "General Provisions", number: "04", indexNum: "8.04", type: "article", label: "Chapter", hideNumber: false, children: [],
  };
  const title: TocNode = {
    prefix: "", tocName: "Code", guid: "title-8", parent: "code", href: "",
    title: "General Provisions", number: "8", indexNum: "8", type: "chapter", label: "Title", hideNumber: false, children: [chapter],
  };
  const appendix: TocNode = {
    prefix: "", tocName: "Code", guid: appendixGuid, parent: "code", href: "",
    title: "Appendix A", number: "A", indexNum: "Appendix A", type: "article", label: "Appendix", hideNumber: false, children: [],
  };
  return {
    prefix: "", tocName: "Crescent City Municipal Code", guid: "code", parent: null, href: "",
    title: "Code", number: "", indexNum: "", type: "code", label: "Code", hideNumber: false, children: [title, appendix],
  };
}

describe("buildConsolidatedJson", () => {
  test("wraps the municipality envelope and projects every article/section", () => {
    const arts = [
      article("8.04", "General Provisions", [
        section("8.04.010", "Definitions", "As used in this code."),
        section("8.04.020", "Title", "This title shall govern.", "Amended by Ord. No. 100 (2020)"),
      ]),
    ];
    const out = buildConsolidatedJson(tocFixture(), arts);
    expect(out.municipality).toBe("Crescent City Municipal Code");
    expect(out.source).toBe("https://ecode360.com/CR4919");
    expect(out.articles).toHaveLength(1);
    const a = (out.articles as any[])[0];
    expect(a.guid).toBe("art-8.04");
    expect(a.sha256).toBe("x".repeat(64));
    expect(a.sections).toHaveLength(2);
    expect(a.sections[0]).toMatchObject({ number: "8.04.010", title: "Definitions" });
    expect(a.sections[1].history).toContain("Ord. No. 100");
  });
});

describe("buildSectionIndexCsv", () => {
  test("emits a header + one row per section", () => {
    const arts = [
      article("8.04", "General Provisions", [
        section("8.04.010", "A, B & C", "text"),
        section("8.04.020", "Definitions", "text"),
      ]),
    ];
    const lines = buildSectionIndexCsv(arts).split("\n");
    expect(lines[0]).toBe("guid,number,title,chapter_guid,chapter_number,chapter_title,history");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("art-8.04");
  });

  test("csv-escapes titles/fields containing commas and quotes", () => {
    const arts = [
      article("8.04", "General, Provisions", [section("8.04.010", 'Zoning "Overlay"', "text")]),
    ];
    const csv = buildSectionIndexCsv(arts);
    expect(csv).toContain('"General, Provisions"');
    expect(csv).toContain('"Zoning ""Overlay"""');
  });
});

describe("buildPlainText", () => {
  test("orders articles by number and includes chapter/section lines + history", () => {
    const arts = [
      article("9", "Title 9", [section("9.02", "Z", "later text")]),
      article("8", "Title 8", [section("8.01", "A", "first text", "Amended 2021")]),
    ];
    const text = buildPlainText(arts);
    // Numeric (and lexicographic) ordering: Chapter 8 before Chapter 9.
    expect(text.indexOf("CHAPTER 8:")).toBeLessThan(text.indexOf("CHAPTER 9:"));
    expect(text).toContain("\n8.01: A\n");
    expect(text).toContain("first text");
    expect(text).toContain("[Amended 2021]");
  });
});

describe("buildMarkdownFiles", () => {
  test("produces a title README linking chapters and per-chapter files", () => {
    const toc = tocFixture("art-8.04");
    const arts = [article("8.04", "General Provisions", [section("8.04.010", "Definitions", "text", "Amended by Ord. No. 100")], "art-8.04")];
    const files = buildMarkdownFiles(toc, arts);
    const readme = files.find((f) => f.relPath.endsWith("README.md"));
    expect(readme).toBeDefined();
    expect(readme!.content).toContain("# Title 8: General Provisions");
    expect(readme!.content).toContain("## Chapter 04: General Provisions");
    expect(readme!.content).toContain("(04.md#8.04.010)");
    const chapter = files.find((f) => f.relPath.endsWith("04.md"));
    expect(chapter).toBeDefined();
    expect(chapter!.content).toContain("# Chapter 04: General Provisions");
    expect(chapter!.content).toContain("## 8.04.010: Definitions");
    expect(chapter!.content).toContain("*Amended by Ord. No. 100*");
  });

  test("files not nested under a Title chapter go to an Other/ appendix folder", () => {
    const toc = tocFixture("art-8.04", "art-A");
    const arts = [article("A", "Appendix A", [section("A.1", "Zoning Map", "map text")], "art-A")];
    const files = buildMarkdownFiles(toc, arts);
    expect(files.some((f) => f.relPath.startsWith("Other/"))).toBe(true);
    expect(files.some((f) => f.relPath.startsWith("Other/") && f.content.includes("Appendix A"))).toBe(true);
  });
});
