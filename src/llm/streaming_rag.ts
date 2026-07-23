/**
 * Streaming RAG pipeline — Server-Sent Events (SSE) for word-by-word
 * streaming of RAG answers.
 *
 * Reuses the existing RAG pipeline (rag.ts) for retrieval and context
 * assembly, but streams the Ollama generation token-by-token via SSE
 * to the GUI chat panel.
 *
 * Usage:
 *   POST /api/chat/stream  →  text/event-stream response
 */
import { createLogger } from "../logger.js";
import type { ChatMessage, RagSource } from "../types.js";

const log = createLogger("streaming_rag");

export interface StreamingRagOptions {
  /** Override default Ollama model */
  model?: string;
  /** Number of chunks to retrieve */
  topK?: number;
  /** SSE field name for data */
  eventField?: string;
}

export interface StreamingRagResult {
  /** Full accumulated answer */
  answer: string;
  /** Sources retrieved */
  sources: RagSource[];
  /** Model used */
  model: string;
  /** Total time in milliseconds */
  latencyMs: number;
}

/**
 * Create an SSE response stream for RAG chat.
 *
 * The stream sends:
 * 1. event: sources — JSON array of source sections
 * 2. event: token — each token of the generated answer
 * 3. event: done — final metadata (model, latency, sources)
 */
export function createStreamingRagResponse(
  question: string,
  retrievedContext: { sources: RagSource[]; context: string },
  model: string = "gemma3:4b",
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const startTime = performance.now();

      // 1. Send sources first
      controller.enqueue(
        encoder.encode(`event: sources\ndata: ${JSON.stringify(retrievedContext.sources)}\n\n`)
      );

      // 2. Build prompt and stream tokens from Ollama
      const systemPrompt = `You are a helpful assistant answering questions about the Crescent City, California municipal code. Use the following code sections as context. Always cite section numbers in your answer.

Context:
${retrievedContext.context}

Question: ${question}

Answer:`;

      try {
        const ollamaResponse = await fetch("http://localhost:11434/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: systemPrompt,
            stream: true,
          }),
        });

        if (!ollamaResponse.ok || !ollamaResponse.body) {
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "Ollama unavailable" })}\n\n`)
          );
          controller.close();
          return;
        }

        const reader = ollamaResponse.body.getReader();
        const decoder = new TextDecoder();
        let fullAnswer = "";
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Ollama sends newline-delimited JSON objects
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const chunk = JSON.parse(line);
              if (chunk.response) {
                fullAnswer += chunk.response;
                controller.enqueue(
                  encoder.encode(`event: token\ndata: ${JSON.stringify({ token: chunk.response })}\n\n`)
                );
              }
              if (chunk.done) {
                break;
              }
            } catch {
              // Skip malformed chunks
            }
          }
        }

        // 3. Send done event
        const latencyMs = performance.now() - startTime;
        const result: StreamingRagResult = {
          answer: fullAnswer,
          sources: retrievedContext.sources,
          model,
          latencyMs,
        };

        controller.enqueue(
          encoder.encode(`event: done\ndata: ${JSON.stringify(result)}\n\n`)
        );
      } catch (err: any) {
        log.error("Streaming RAG error", { error: err.message });
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`)
        );
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
