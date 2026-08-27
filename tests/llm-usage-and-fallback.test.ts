import { describe, expect, test } from "bun:test";
import {
  estimateTokens,
  getLlmUsageSummary,
  getUsageRecords,
  recordLlmUsage,
  resetLlmUsage,
} from "../src/llm/usage";
import { extractJsonCandidate } from "../src/llm/structured";
import { deterministicExtract } from "../src/llm/provider";

describe("LLM token-usage accounting", () => {
  test("estimateTokens is monotonic and positive", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("a".repeat(800))).toBeGreaterThan(estimateTokens("a".repeat(400)));
  });

  test("recordLlmUsage clamps invalid inputs", () => {
    resetLlmUsage();
    recordLlmUsage("ollama", "gemma3:4b", Number.NaN, -5);
    const rec = getUsageRecords()[0];
    expect(rec.promptTokens).toBe(0);
    expect(rec.completionTokens).toBe(0);
  });

  test("summary aggregates per provider/model", () => {
    resetLlmUsage();
    recordLlmUsage("ollama", "gemma3:4b", 10, 20);
    recordLlmUsage("ollama", "gemma3:4b", 1, 2);
    recordLlmUsage("openrouter", "test-model", 5, 7);
    const summary = getLlmUsageSummary();
    expect(summary.totals.requests).toBe(3);
    expect(summary.totals.promptTokens).toBe(16);
    expect(summary.totals.completionTokens).toBe(29);
    expect(summary.totals.totalTokens).toBe(45);
    expect(summary.providers.length).toBe(2);
    const top = summary.providers[0];
    expect(top.provider).toBe("ollama");
    expect(top.requests).toBe(2);
    expect(top.totalTokens).toBe(33);
    expect(top.models).toEqual(["gemma3:4b"]);
    expect(summary.lastRecordAt).not.toBeNull();
  });
});

describe("extractJsonCandidate", () => {
  test("parses plain object", () => {
    expect(JSON.parse(extractJsonCandidate("{\"a\": 1}") ?? "")).toEqual({ a: 1 });
  });
  test("parses fenced json with prose around it", () => {
    const raw = 'Sure!\n```json\n{"tags": ["x"]}\n```\nDone.';
    expect(JSON.parse(extractJsonCandidate(raw) ?? "")).toEqual({ tags: ["x"] });
  });
  test("handles nested braces inside strings", () => {
    const raw = String.raw`{"text": "has \n brace } inside", "n": 2}`;

    expect(JSON.parse(extractJsonCandidate(raw) ?? "")).toEqual({ text: "has \n brace } inside", n: 2 });

  });
  test("returns null for non-json prose", () => {
    expect(extractJsonCandidate("no structure here at all")).toBeNull();
  });
});

describe("deterministicExtract", () => {
  test("empty context yields explicit unavailable message without fabrication", () => {
    const out = deterministicExtract("What are the parking rules downtown?");
    expect(out).toContain("No provider is available");
    expect(out).toContain("parking rules");
  });
  test("with context returns only source sentences containing question terms", () => {
    const context = "Section 12.3 regulates parking permits downtown. The weather committee meets quarterly. "
      + "Parking permits expire annually on January first.";
    const out = deterministicExtract("Where do parking permits expire?", context);
    expect(out).toContain("[Provider unavailable — deterministic source extract]");
    expect(out).toContain("expire annually");
    expect(out).not.toContain("weather committee");
  });
});
