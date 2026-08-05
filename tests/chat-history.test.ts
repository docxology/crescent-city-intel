/**
 * Tests for the multi-turn conversation-history support (src/llm/rag.ts
 * buildChatMessages). Zero-mock: pure message-list builder.
 */
import { describe, test, expect } from "bun:test";
import { buildChatMessages, MAX_HISTORY_TURNS } from "../src/llm/rag.ts";

describe("buildChatMessages", () => {
  test("appends the user question after the bounded history tail", () => {
    const messages = buildChatMessages("What are the fees?", [
      { role: "user", content: "Tell me about the harbor." },
      { role: "assistant", content: "The harbor is regulated by Title 8." },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[2]).toEqual({ role: "user", content: "What are the fees?" });
  });

  test("bounds history to the most recent MAX_HISTORY_TURNS turns", () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ role: ("user" as const), content: `turn ${i}` }));
    const messages = buildChatMessages("final", history);
    expect(messages).toHaveLength(MAX_HISTORY_TURNS + 1);
    expect(messages[0].content).toBe(`turn ${20 - MAX_HISTORY_TURNS}`);
  });

  test("drops empty/whitespace turns", () => {
    const messages = buildChatMessages("q", [
      { role: "user", content: "  " },
      { role: "assistant", content: "" },
      { role: "user", content: "keep me" },
    ]);
    expect(messages.map(m => m.content)).toEqual(["keep me", "q"]);
  });

  test("empty or missing history yields just the user question", () => {
    expect(buildChatMessages("q").map(m => m.content)).toEqual(["q"]);
    expect(buildChatMessages("q", []).map(m => m.content)).toEqual(["q"]);
  });
});
