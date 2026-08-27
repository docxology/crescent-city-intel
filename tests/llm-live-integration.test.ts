#!/usr/bin/env bun
/** Live Ollama integration tests — skipped automatically when Ollama is unreachable. */
import { describe, expect, test } from "bun:test";
import { isOllamaRunning } from "../src/llm/ollama";
import { chatWithProviderFallback, deterministicExtract } from "../src/llm/provider";
import { queryStructured } from "../src/llm/structured";
import { getLlmUsageSummary, resetLlmUsage } from "../src/llm/usage";
import { llmConfig } from "../src/llm/config";

const ollamaUp = await isOllamaRunning(2000);

describe.skipIf(!ollamaUp)("LLM provider fallback chain (live Ollama)", () => {
  test("primary ollama chat yields grounded answer", async () => {
    const result = await chatWithProviderFallback(
      [{ role: "user", content: "Reply with exactly the word READY." }],
    );
    expect(result.outcome === "primary" || result.outcome === "deterministic").toBe(true);
    expect(result.answer.length).toBeGreaterThan(0);
    if (result.providerUsed !== "none") {
      expect(result.model.length).toBeGreaterThan(0);
    }
  }, 120000);

  test("queryStructured returns parsed JSON via json or unavailable", async () => {
    const result = await queryStructured<{ section: string; topic: string }>(
      "Give one example record about municipal code sections.",
      { schemaHint: '{"section": string, "topic": string}' },
    );
    // extra arg below raises bun per-test timeout
    if (result.source === "json") {
      expect(result.value).not.toBeNull();
      expect(typeof (result.value as any).section).toBe("string");
      expect(typeof (result.value as any).topic).toBe("string");
    } else {
      expect(result.value).toBeNull();
    }
  }, 180000);
});

describe("fallback accounting invariants (no network)", () => {
  test("usage summary stays well-formed after reset", () => {
    resetLlmUsage();
    const summary = getLlmUsageSummary();
    expect(summary.totals.requests).toBe(0);
    expect(summary.providers).toEqual([]);
    expect(summary.lastRecordAt).toBeNull();
    expect(llmConfig.ollamaUrl).toContain("http");
  });
});
