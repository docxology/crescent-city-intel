import { describe, expect, test } from "bun:test";
import { buildRagSource, NoRetrievedContextError } from "../src/llm/rag.ts";
import { createStreamingRagResponse } from "../src/llm/streaming_rag.ts";

describe("RAG evidence and streaming contracts", () => {
  test("buildRagSource preserves municipal citation metadata", () => {
    const source = buildRagSource("A permit is required.", {
      sourceType: "municipal_code",
      sectionGuid: "ABC123",
      sectionNumber: "§ 8.04.010",
      sectionTitle: "Permits",
    }, 0.12);
    expect(source).toMatchObject({ sourceType: "municipal_code", sectionGuid: "ABC123", sectionNumber: "§ 8.04.010", score: 0.88 });
  });

  test("streaming RAG rejects empty context instead of emitting a successful answer", async () => {
    const response = createStreamingRagResponse("What is required?", { sources: [], context: "" });
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain('event: sources');
    expect(body).toContain('event: error');
    expect(body).not.toContain('event: done');
  });

  test("non-streaming RAG exposes empty retrieval as a retryable dependency error", () => {
    const error = new NoRetrievedContextError();
    expect(error.name).toBe("NoRetrievedContextError");
    expect(error.message).toContain("No retrieved context");
  });
});
