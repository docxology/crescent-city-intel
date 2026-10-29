/** Executive digest over actual local provider HTTP; no ambient model calls.
 * Prompt inputs and mechanical attribution are checked, not semantic support.
 */
import { describe, expect, test } from "bun:test";
import { DIGEST_PROMPT_VERSION, generateExecutiveDigest } from "../src/monthly_report";
import { llmConfig } from "../src/llm/config.ts";
import { llmHttpFixture } from "./helpers/llm-http.ts";
async function provider(run: (http: ReturnType<typeof llmHttpFixture>) => Promise<void>) {
  const http = llmHttpFixture(), previous = { provider: llmConfig.provider, ollamaUrl: llmConfig.ollamaUrl };
  Object.assign(llmConfig, { provider: "ollama", ollamaUrl: http.url });
  try { await run(http); } finally { Object.assign(llmConfig, previous); await http.server.stop(true); }
}
describe("executive digest", () => {
  test("digest prompt version is pinned", () => { expect(DIGEST_PROMPT_VERSION).toBe("2026-08-26-digest-v1"); });
  test("empty/non-finite metrics yield null without any provider call", () => provider(async http => {
    expect(await generateExecutiveDigest({}, "August 2026")).toBeNull();
    expect(await generateExecutiveDigest({ bad: Number.NaN }, "August 2026")).toBeNull();
    expect(http.requests).toEqual([]);
  }));
  test("real HTTP proposals retain attribution and receive only the finite supplied metric lines", () => provider(async http => {
    const prose = "The month recorded 2 earthquakes and 3 weather alerts. News coverage included 12 items."; http.ollamaChat = prose;
    const result = await generateExecutiveDigest({ earthquakes: 2, weatherAlerts: 3, newsItems: 12, invalid: Infinity }, "August 2026");
    expect(result).toEqual({ prose, provider: "ollama", model: llmConfig.chatModel, promptVersion: DIGEST_PROMPT_VERSION });
    expect(http.requests.map(request => request.path)).toEqual(["/api/chat"]);
    const messages = http.requests[0]!.body.messages as Array<{ role: string; content: string }>;
    const prompt = messages.find(message => message.role === "user")!.content;
    expect(prompt).toContain("- earthquakes: 2\n- weatherAlerts: 3\n- newsItems: 12");
    expect(prompt).not.toContain("invalid"); expect(prompt).not.toContain("Infinity");
  }));
  test("actual HTTP failure omits the optional digest", () => provider(async http => {
    http.ollamaChatStatus = 503;
    expect(await generateExecutiveDigest({ newsItems: 12 }, "August 2026")).toBeNull();
    expect(http.requests.map(request => request.path)).toEqual(["/api/chat"]);
  }));
  test("empty provider output omits the optional digest", () => provider(async http => {
    http.ollamaChat = " ";
    expect(await generateExecutiveDigest({ newsItems: 12 }, "August 2026")).toBeNull();
    expect(http.requests.map(request => request.path)).toEqual(["/api/chat"]);
  }));
});
