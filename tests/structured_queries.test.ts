import { describe, test, expect } from "bun:test";
import {
  parseLegislativeHistory,
} from "../src/structured_queries.js";

describe("parseLegislativeHistory", () => {
  test("parses a single ordinance entry", () => {
    const result = parseLegislativeHistory("Ord. No. 942 § 1, 2011");
    expect(result).toHaveLength(1);
    expect(result[0].ordinance).toBe("Ord. No. 942");
    expect(result[0].action).toBe("amended");
    expect(result[0].date).toBe("2011");
  });

  test("parses multiple entries separated by semicolons", () => {
    const result = parseLegislativeHistory("Ord. No. 942 § 1, 2011; Ord. No. 723 § 1, 2004");
    expect(result).toHaveLength(2);
    expect(result[0].ordinance).toBe("Ord. No. 942");
    expect(result[1].ordinance).toBe("Ord. No. 723");
  });

  test("detects enacted action", () => {
    const result = parseLegislativeHistory("Ord. No. 500 enacted 1998");
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe("enacted");
  });

  test("detects repealed action", () => {
    const result = parseLegislativeHistory("Ord. No. 300 repealed 2001");
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe("repealed");
  });

  test("returns empty for empty string", () => {
    expect(parseLegislativeHistory("")).toEqual([]);
    expect(parseLegislativeHistory("   ")).toEqual([]);
  });

  test("handles null/undefined input", () => {
    expect(parseLegislativeHistory(null as any)).toEqual([]);
    expect(parseLegislativeHistory(undefined as any)).toEqual([]);
  });
});
