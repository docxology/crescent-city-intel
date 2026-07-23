import { describe, test, expect } from "bun:test";

describe("content extraction from fixture HTML", () => {
  // Test htmlToText utility with fixture data
  const fixtureHtml = `
    <html>
      <body>
        <div id="codeContent">
          <div class="section">
            <h3>§ 8.04.010 Purpose.</h3>
            <p>The purpose of this chapter is to provide for the public health and safety.</p>
            <div class="history">Ord. No. 942 § 1, 2011</div>
          </div>
          <div class="section">
            <h3>§ 8.04.020 Definitions.</h3>
            <p>Building shall mean any structure used for human occupancy.</p>
            <div class="history">Ord. No. 723 § 1, 2004</div>
          </div>
        </div>
      </body>
    </html>
  `;

  test("htmlToText strips HTML tags", async () => {
    const { htmlToText } = await import("../src/utils.js");
    const text = htmlToText(fixtureHtml);
    expect(text).toContain("Purpose");
    expect(text).toContain("public health");
    expect(text).not.toContain("<html>");
    expect(text).not.toContain("<div");
  });

  test("htmlToText preserves section content", async () => {
    const { htmlToText } = await import("../src/utils.js");
    const text = htmlToText(fixtureHtml);
    expect(text).toContain("§ 8.04.010");
    expect(text).toContain("§ 8.04.020");
    expect(text).toContain("Building shall mean");
  });

  test("htmlToText preserves history lines", async () => {
    const { htmlToText } = await import("../src/utils.js");
    const text = htmlToText(fixtureHtml);
    expect(text).toContain("Ord. No. 942");
    expect(text).toContain("Ord. No. 723");
  });

  test("fixture sections have expected structure", () => {
    // Simulate parsing sections from fixture HTML
    const sectionPattern = /§\s*(\d+\.\d+\.\d+)\s+(.+?)\./g;
    const matches = [...fixtureHtml.matchAll(sectionPattern)];
    expect(matches).toHaveLength(2);
    expect(matches[0][1]).toBe("8.04.010");
    expect(matches[0][2]).toBe("Purpose");
    expect(matches[1][1]).toBe("8.04.020");
    expect(matches[1][2]).toBe("Definitions");
  });

  test("fixture definitions can be extracted", async () => {
    const { extractDefinitions } = await import("../src/legal_parser.js");
    const text = "Building shall mean any structure used for human occupancy.";
    const defs = extractDefinitions(text, "8.04.020");
    expect(defs.length).toBeGreaterThanOrEqual(1);
    expect(defs.some(d => d.term.includes("Building"))).toBe(true);
  });

  test("fixture history can be parsed", async () => {
    const { parseLegislativeHistory } = await import("../src/structured_queries.js");
    const history = parseLegislativeHistory("Ord. No. 942 § 1, 2011");
    expect(history).toHaveLength(1);
    expect(history[0].ordinance).toBe("Ord. No. 942");
    expect(history[0].date).toBe("2011");
  });

  test("fixture HTML has expected div structure", () => {
    expect(fixtureHtml).toContain('id="codeContent"');
    expect(fixtureHtml).toContain('class="section"');
    expect(fixtureHtml).toContain('class="history"');
  });

  test("fixture SHA-256 hash is deterministic", async () => {
    const { computeSha256 } = await import("../src/utils.js");
    const hash1 = await computeSha256(fixtureHtml);
    const hash2 = await computeSha256(fixtureHtml);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });
});
