import { describe, test, expect } from "bun:test";
import {
  extractCitations,
  extractOrdinanceAmendments,
  extractDefinitions,
  extractEffectiveDate,
} from "../src/legal_parser.js";

describe("extractCitations", () => {
  test("extracts California Government Code citation", () => {
    const text = "This section is enacted pursuant to Government Code § 65850";
    const citations = extractCitations(text);
    expect(citations.length).toBeGreaterThanOrEqual(1);
    const govCode = citations.find(c => c.type === "ca-code");
    expect(govCode).toBeDefined();
    expect(govCode!.section).toBe("65850");
  });

  test("extracts Health and Safety Code citation", () => {
    const text = "See Health and Safety Code § 12095 for definitions.";
    const citations = extractCitations(text);
    expect(citations.some(c => c.codeName?.includes("Health"))).toBe(true);
  });

  test("extracts federal U.S.C. citation", () => {
    const text = "Compliance with 33 U.S.C. § 1342 is required for discharge permits.";
    const citations = extractCitations(text);
    const federal = citations.find(c => c.type === "federal");
    expect(federal).toBeDefined();
    expect(federal!.section).toContain("33");
  });

  test("extracts case law citation", () => {
    const text = "In Smith v. Jones, the court held that zoning requires notice.";
    const citations = extractCitations(text);
    const caseLaw = citations.find(c => c.type === "case-law");
    expect(caseLaw).toBeDefined();
    expect(caseLaw!.citation).toContain("v.");
  });

  test("returns empty for text with no citations", () => {
    expect(extractCitations("No legal references here.")).toEqual([]);
  });
});

describe("extractOrdinanceAmendments", () => {
  test("extracts single amendment", () => {
    const result = extractOrdinanceAmendments("Ord. No. 942 § 1, 2011");
    expect(result).toHaveLength(1);
    expect(result[0].ordinance).toBe("Ord. No. 942");
    expect(result[0].year).toBe(2011);
  });

  test("extracts multiple amendments", () => {
    const result = extractOrdinanceAmendments("Ord. No. 942 § 1, 2011; Ord. No. 723 § 1, 2004");
    expect(result).toHaveLength(2);
    expect(result[0].year).toBe(2011);
    expect(result[1].year).toBe(2004);
  });

  test("returns empty for null/empty", () => {
    expect(extractOrdinanceAmendments("")).toEqual([]);
    expect(extractOrdinanceAmendments(null as any)).toEqual([]);
  });
});

describe("extractDefinitions", () => {
  test("extracts 'shall mean' definition", () => {
    const text = "Building shall mean any structure used for human occupancy.";
    const defs = extractDefinitions(text, "1.04.010");
    expect(defs.length).toBeGreaterThanOrEqual(1);
    expect(defs.some(d => d.term.includes("Building"))).toBe(true);
  });

  test("extracts 'means' definition", () => {
    const text = "Dwelling means any building used for living purposes. It includes houses.";
    const defs = extractDefinitions(text, "1.04.020");
    expect(defs.length).toBeGreaterThanOrEqual(1);
  });

  test("skips false positive with skip word", () => {
    const text = "This means everything in the code is enforceable.";
    const defs = extractDefinitions(text, "1.04.030");
    // "This" should be skipped
    expect(defs.find(d => d.term.startsWith("This"))).toBeUndefined();
  });

  test("returns empty for text with no definitions", () => {
    expect(extractDefinitions("The city council meets monthly.", "2.04.010")).toEqual([]);
  });
});

describe("extractEffectiveDate", () => {
  test("returns most recent year from amendments", () => {
    const result = extractEffectiveDate("Ord. No. 942 § 1, 2011; Ord. No. 723 § 1, 2004");
    expect(result).toBe(2011);
  });

  test("returns single year", () => {
    const result = extractEffectiveDate("Ord. No. 500 enacted 1998");
    expect(result).toBe(1998);
  });

  test("returns null for empty history", () => {
    expect(extractEffectiveDate("")).toBeNull();
  });
});
