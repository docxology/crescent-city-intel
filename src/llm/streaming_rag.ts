/** Provider-aware SSE generation for retrieved municipal-code context. */
import { createLogger } from "../logger.js";
import type { ChatMessage, RagSource } from "../types.js";
import { OLLAMA_TIMEOUT_MS } from "../constants.js";
import { llmConfig } from "./config.js";
import { configuredChatModel } from "./provider.js";
import { streamChat as streamOpenRouterChat } from "./openrouter.js";
import { computeSha256 } from "../utils.js";

const log = createLogger("streaming_rag");

export interface StreamingRagOptions {
  model?: string;
  topK?: number;
  eventField?: string;
}

export interface StreamingRagResult {
  answer: string;
  sources: RagSource[];
  model: string;
  latencyMs: number;
  provider: "ollama" | "openrouter";
  queryId: string;
  contextFingerprint: string;
  grounded: boolean;
}

function event(encoder: TextEncoder, name: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Create an SSE response. Ollama uses its NDJSON stream and OpenRouter uses
 * the provider's native SSE delta stream. Both are cancellation-aware.
 */
export function createStreamingRagResponse(
  question: string,
  retrievedContext: { sources: RagSource[]; context: string },
  modelOverride?: string,
): Response {
  const encoder = new TextEncoder();
  const model = configuredChatModel(modelOverride);
  const queryId = `rag-stream-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const requestAbort = new AbortController();

  const stream = new ReadableStream({
    async start(controller) {
      const startTime = performance.now();
      const contextFingerprint = await computeSha256(retrievedContext.context);
      controller.enqueue(event(encoder, "sources", retrievedContext.sources));

      if (retrievedContext.sources.length === 0 || !retrievedContext.context.trim()) {
        controller.enqueue(event(encoder, "error", { error: "No retrieved context is available" }));
        controller.close();
        return;
      }

      const systemPrompt = `You are a helpful assistant answering questions about the Crescent City, California municipal code. Use only the supplied context. Always cite section numbers when possible. If the context is insufficient, say so.\n\nContext:\n${retrievedContext.context}`;
      let fullAnswer = "";

      try {
        if (llmConfig.provider === "openrouter") {
          for await (const token of streamOpenRouterChat(
            [{ role: "user", content: question }],
            systemPrompt,
            model,
            { signal: requestAbort.signal },
          )) {
            fullAnswer += token;
            controller.enqueue(event(encoder, "token", { token }));
          }
        } else {
          const ollamaResponse = await fetch(`${llmConfig.ollamaUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, prompt: `${systemPrompt}\n\nQuestion: ${question}\n\nAnswer:`, stream: true }),
            signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(OLLAMA_TIMEOUT_MS * 4)]),
          });

          if (!ollamaResponse.ok || !ollamaResponse.body) {
            throw new Error(`Ollama streaming request failed (${ollamaResponse.status})`);
          }

          const reader = ollamaResponse.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const chunk = JSON.parse(line) as { response?: string; done?: boolean };
                if (chunk.response) {
                  fullAnswer += chunk.response;
                  controller.enqueue(event(encoder, "token", { token: chunk.response }));
                }
              } catch (error) {
                log.warn("Skipping malformed Ollama stream chunk", { error: String(error) });
              }
            }
          }
        }

        if (!fullAnswer.trim()) throw new Error(`${llmConfig.provider} returned an empty answer`);
        const result: StreamingRagResult = {
          answer: fullAnswer,
          sources: retrievedContext.sources,
          model,
          latencyMs: performance.now() - startTime,
          provider: llmConfig.provider,
          queryId,
          contextFingerprint,
          grounded: true,
        };
        controller.enqueue(event(encoder, "done", result));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Streaming RAG error", { error: message });
        controller.enqueue(event(encoder, "error", { error: message }));
      }

      controller.close();
    },
    cancel(reason) {
      requestAbort.abort(reason instanceof Error ? reason : new Error(String(reason ?? "stream cancelled")));
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
