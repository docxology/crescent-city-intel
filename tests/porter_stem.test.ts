import { describe, test, expect } from "bun:test";
import { stem, stemTokens, stemSet } from "../src/shared/porter_stem";

describe("Porter stemmer", () => {
  // Step 1a: -sses → -ss, -ies → -i, -ss → -ss, -s → ""
  test("Step 1a: plural removal", () => {
    expect(stem("caresses")).toBe("caress");
    expect(stem("ponies")).toBe("poni");
    expect(stem("ties")).toBe("ti");
    expect(stem("caress")).toBe("caress");
    expect(stem("cats")).toBe("cat");
  });

  // Step 1b: -ed, -ing removal
  test("Step 1b: past tense and gerund", () => {
    expect(stem("agreed")).toBe("agre");
    expect(stem("plastered")).toBe("plaster");
    expect(stem("fishing")).toBe("fish");
    expect(stem("zoning")).toBe("zone");
  });

  // Step 1c: -y → -i
  test("Step 1c: y to i", () => {
    expect(stem("happily")).toBe("happili");
    expect(stem("sky")).toBe("sky");
  });

  // Step 2: -ational → -ate, -tional → -tion, etc.
  test("Step 2: suffix transformations", () => {
    expect(stem("relational")).toBe("relat");
    expect(stem("conditional")).toBe("condit");
    expect(stem("rational")).toBe("ration");
    expect(stem("valenci")).toBe("valenc");
  });

  // Known Crescent City municipal code terms
  test("municipal code vocabulary", () => {
    expect(stem("evacuation")).toBe("evacu");
    expect(stem("zones")).toBe("zone");
    expect(stem("emergencies")).toBe("emerg");
    expect(stem("permits")).toBe("permit");
    expect(stem("ordinance")).toBe("ordin");
    expect(stem("regulations")).toBe("regul");
    expect(stem("harbor")).toBe("harbor");
    expect(stem("fishing")).toBe("fish");
    expect(stem("provisions")).toBe("provis");
    expect(stem("requirements")).toBe("requir");
    expect(stem("applications")).toBe("applic");
    expect(stem("commercial")).toBe("commerci");
  });

  test("stemTokens processes arrays", () => {
    expect(stemTokens(["zones", "fishing", "permits"])).toEqual(["zone", "fish", "permit"]);
    expect(stemTokens(["the", "and", "of"])).toEqual(["the", "and", "of"]);
    expect(stemTokens([])).toEqual([]);
  });

  test("stemSet deduplicates stems", () => {
    const result = stemSet("zones zone zoned zoning");
    expect(result.size).toBe(1);
    expect(result.has("zone")).toBe(true);
  });

  test("stemSet filters short tokens", () => {
    const result = stemSet("a b c the zone");
    expect(result.has("zone")).toBe(true);
    expect(result.has("th")).toBe(false);
  });

  test("empty string returns empty string", () => {
    expect(stem("")).toBe("");
  });
});
