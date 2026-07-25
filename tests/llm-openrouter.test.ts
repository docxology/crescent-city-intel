import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chat,
  checkOpenRouterHealth,
  streamChat,
  getOpenRouterRequestCount,
  resetOpenRouterRequestCount,
} from "../src/llm/openrouter.ts";
import { llmConfig } from "../src/llm/config.ts";
import type { ChatMessage } from "../src/types.ts";

const messages: ChatMessage[] = [
  {
    role: "user",
    content: "What does the municipal code say about harbor operations?",
  },
];

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let requestCount = 0;
let lastChatBody: Record<string, unknown> | null = null;
let originalOpenRouterApiKey: string | undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/chat/completions" && req.method === "POST") {
        requestCount += 1;
        const body = await req.json() as Record<string, unknown>;
        lastChatBody = body;
        if (body.stream) {
          return new Response(
            'data: {"choices":[{"delta":{"content":"Fixture "}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"stream"}}]}\n\n' +
            "data: [DONE]\n\n",
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return Response.json({
          choices: [
            {
              message: {
                content: "Fixture answer from OpenRouter test server.",
              },
            },
          ],
        });
      }

      if (url.pathname === "/models" && req.method === "GET") {
        return Response.json({ data: [{ id: "fixture/model" }] });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  if (server) {
    server.stop();
  }
});

beforeEach(() => {
  originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
  requestCount = 0;
  lastChatBody = null;
  resetOpenRouterRequestCount();
});

afterEach(() => {
  if (originalOpenRouterApiKey === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
  }
});

describe("openrouter chat", () => {
  test("preflight verifies the configured endpoint without a chat completion", async () => {
    const health = await checkOpenRouterHealth({ baseUrl, apiKey: "test-key" });
    expect(health).toEqual({ reachable: true });
    expect(requestCount).toBe(0);
  });

  test("preflight reports an unavailable endpoint", async () => {
    const health = await checkOpenRouterHealth({ baseUrl: `${baseUrl}/missing`, apiKey: "test-key" });
    expect(health.reachable).toBe(false);
    expect(health.error).toMatch(/preflight/i);
  });

  test("returns the assistant content from an OpenRouter-shaped response", async () => {
    const response = await chat(messages, undefined, undefined, {
      baseUrl: baseUrl,
      apiKey: "test-key",
    });

    expect(response).toBe("Fixture answer from OpenRouter test server.");
    expect(requestCount).toBe(1);
    expect(getOpenRouterRequestCount()).toBe(1);
  });

  test("allows bounded tasks to replace the municipal-code system prompt", async () => {
    await chat(messages, undefined, undefined, {
      baseUrl,
      apiKey: "test-key",
      systemPrompt: "Summarize only the supplied public source.",
    });

    const sentMessages = lastChatBody?.messages as Array<{ role: string; content: string }>;
    expect(sentMessages[0]).toEqual({ role: "system", content: "Summarize only the supplied public source." });
  });

  test("fails fast when OPENROUTER_API_KEY is missing and does not make a request", async () => {
    delete process.env.OPENROUTER_API_KEY;

    await expect(
      chat(messages, undefined, undefined, { baseUrl: baseUrl })
    ).rejects.toThrow(/OPENROUTER_API_KEY/);

    expect(requestCount).toBe(0);
    expect(getOpenRouterRequestCount()).toBe(0);
  });

  test("parses native OpenRouter SSE deltas", async () => {
    const chunks: string[] = [];
    for await (const chunk of streamChat(messages, "Grounded context", undefined, {
      baseUrl,
      apiKey: "test-key",
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("Fixture stream");
    expect(requestCount).toBe(1);
    expect(getOpenRouterRequestCount()).toBe(1);
  });

  test("throws when the per-run OpenRouter request cap is exceeded", async () => {
    for (let i = 0; i < llmConfig.openrouterMaxRequestsPerRun; i += 1) {
      const response = await chat(messages, undefined, undefined, {
        baseUrl: baseUrl,
        apiKey: "test-key",
      });
      expect(response).toBe("Fixture answer from OpenRouter test server.");
    }

    await expect(
      chat(messages, undefined, undefined, {
        baseUrl: baseUrl,
        apiKey: "test-key",
      })
    ).rejects.toThrow(/OPENROUTER_MAX_REQUESTS/);

    expect(requestCount).toBe(llmConfig.openrouterMaxRequestsPerRun);
    expect(getOpenRouterRequestCount()).toBe(llmConfig.openrouterMaxRequestsPerRun);
  });
});
