import { describe, expect, test } from "bun:test";
import { configuredChatProvider, configuredChatModel } from "../src/llm/provider";
import { llmConfig } from "../src/llm/config";

describe("LLM provider routing", () => {
  test("configuredProvider returns a valid provider", () => {
    const provider = configuredChatProvider();
    expect(["ollama", "openrouter"]).toContain(provider);
  });

  test("configuredModel returns a non-empty string", () => {
    expect(typeof configuredChatModel()).toBe("string");
    expect(configuredChatModel().length).toBeGreaterThan(0);
  });

  test("configuredModel honors modelOverride", () => {
    expect(configuredChatModel("custom-model")).toBe("custom-model");
  });
});

describe("LLM config", () => {
  test("provider is a valid value", () => {
    expect(["ollama", "openrouter"]).toContain(llmConfig.provider);
  });

  test("chromaUrl is defined", () => {
    expect(llmConfig.chromaUrl).toBeDefined();
    expect(llmConfig.collectionName).toBe("crescent-city-code");
  });

  test("chunkSize and overlap are positive", () => {
    expect(llmConfig.chunkSize).toBeGreaterThan(0);
    expect(llmConfig.chunkOverlap).toBeGreaterThan(0);
    expect(llmConfig.chunkOverlap).toBeLessThan(llmConfig.chunkSize);
  });

  test("openrouter has default free model set", () => {
    expect(llmConfig.openrouterModel).toBeDefined();
    expect(llmConfig.openrouterModel.length).toBeGreaterThan(0);
  });

  test("adaptive topK values are valid", () => {
    expect(llmConfig.adaptiveTopKMin).toBeGreaterThan(0);
    expect(llmConfig.adaptiveTopKMax).toBeGreaterThan(llmConfig.adaptiveTopKMin);
    expect(llmConfig.topK).toBeGreaterThanOrEqual(llmConfig.adaptiveTopKMin);
    expect(llmConfig.topK).toBeLessThanOrEqual(llmConfig.adaptiveTopKMax);
  });
});
