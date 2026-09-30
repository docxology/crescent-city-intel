/** SSE has exactly one success, abstention, error or cancellation terminal. */
import type { RagSource } from "../types.js";
import { llmConfig } from "./config.js";
import { configuredChatModel } from "./provider.js";
import { streamChat as openrouterStream } from "./openrouter.js";
import { streamChat as ollamaStream } from "./ollama.js";
import { computeSha256 } from "../utils.js";
import { buildChatMessages, RAG_SYSTEM_PROMPT } from "./rag.js";
import { boundedSignal, generationGate, LlmOverloadedError } from "./runtime.js";
import { assessAnswerEvidence, type EvidenceAssessment } from "./evidence.js";

export interface StreamingRagResult {
  status: "complete" | "abstained";
  answer: string; sources: RagSource[]; model: string; latencyMs: number;
  provider: "ollama" | "openrouter"; queryId: string; contextFingerprint: string;
  grounded: false; evidence: EvidenceAssessment;
}

export function createStreamingRagResponse(question: string, retrievedContext: { sources: RagSource[]; context: string }, modelOverride?: string, history?: Array<{ role: "user" | "assistant"; content: string }>, signal?: AbortSignal): Response {
  const encoder = new TextEncoder(), abort = new AbortController();
  const requestSignal = boundedSignal(signal ? AbortSignal.any([signal, abort.signal]) : abort.signal, 120_000);
  const model = configuredChatModel(modelOverride), queryId = `rag-stream-${crypto.randomUUID()}`;
  let disconnected = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const start = Date.now();
      let release: (() => void) | undefined, terminal = false;
      const emit = (name: string, data: unknown) => {
        if (!disconnected) controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const finish = (name: string, data: unknown) => { if (!terminal) { terminal = true; emit(name, data); } };
      try {
        requestSignal.throwIfAborted();
        const contextFingerprint = await computeSha256(retrievedContext.context);
        emit("sources", retrievedContext.sources);
        if (!retrievedContext.sources.length || !retrievedContext.context.trim()) throw new Error("Missing context");
        release = await generationGate.acquire(requestSignal);
        let answer = "";
        const generate = llmConfig.provider === "openrouter" ? openrouterStream : ollamaStream;
        for await (const token of generate(buildChatMessages(question, history), retrievedContext.context, model, { signal: requestSignal, systemPrompt: RAG_SYSTEM_PROMPT })) {
          requestSignal.throwIfAborted(); answer += token; emit("token", { token });
        }
        if (!answer.trim()) throw new Error("Empty provider answer");
        const evidence = assessAnswerEvidence(answer, retrievedContext.sources);
        const result: StreamingRagResult = { status: evidence.disposition === "abstained" ? "abstained" : "complete", answer: evidence.disposition === "abstained" ? "The retrieved sources do not establish an answer with valid citations. Please inspect the source sections or refine the question." : answer, sources: retrievedContext.sources, model, latencyMs: Date.now() - start, provider: llmConfig.provider, queryId, contextFingerprint, grounded: false, evidence };
        finish("done", result);
      } catch (error) {
        const cancelled = requestSignal.aborted && requestSignal.reason?.name !== "TimeoutError";
        finish("error", { status: cancelled ? "cancelled" : "failed", code: cancelled ? "cancelled" : error instanceof LlmOverloadedError ? "overloaded" : requestSignal.aborted ? "timeout" : "provider_unavailable", error: cancelled ? "Request cancelled" : "Optional AI service could not complete this answer", queryId });
      } finally {
        release?.(); abort.abort();
        if (!disconnected) controller.close();
      }
    },
    cancel() { disconnected = true; abort.abort(new DOMException("Client disconnected", "AbortError")); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Content-Type-Options": "nosniff" } });
}
