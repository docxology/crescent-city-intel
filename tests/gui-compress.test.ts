/**
 * Regression test for the SSE streaming killer in src/gui/server.ts.
 *
 * Before this fix, `maybeCompress` treated `text/event-stream` like any other
 * text response: it called `res.arrayBuffer()` on the live ReadableStream,
 * which consumes the ENTIRE SSE stream (blocking until the RAG generation
 * finishes) and returns the whole body as a single buffered Response. Because
 * every browser sends `Accept-Encoding: gzip`, `/api/chat/stream` delivered
 * the answer all at once instead of token-by-token. The fix passes any
 * `text/event-stream` response through UNTOUCHED — the same Response object —
 * so the stream stays alive and `controller.enqueue()` reaches the client as
 * it happens.
 */
import { describe, test, expect } from "bun:test";
import { maybeCompress } from "../src/gui/server.ts";

const encoder = new TextEncoder();

/** A live SSE-style streaming response that produces three spaced events. */
function sseResponse(): Response {
  const stream = new ReadableStream({
    async start(controller) {
      for (const token of ["alpha", "beta", "gamma"]) {
        controller.enqueue(encoder.encode(`event: token\ndata: ${JSON.stringify({ token })}\n\n`));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

describe("maybeCompress — SSE streaming integrity", () => {
  test("a text/event-stream response passes through as the SAME object (never buffered/gzipped)", async () => {
    const sse = sseResponse();
    const out = await maybeCompress(sse, "gzip");
    // Identity means we never arrayBuffer()'d the live stream — the client's
    // reader keeps receiving controller.enqueue() events in real time.
    expect(out).toBe(sse);
    expect(out.headers.get("Content-Type")).toBe("text/event-stream");
    expect(out.headers.get("Content-Encoding")).toBeNull();
  });

  test("an SSE response without a gzip Accept-Encoding is also passed through", async () => {
    const sse = sseResponse();
    expect(await maybeCompress(sse, null)).toBe(sse);
  });
});

describe("maybeCompress — ordinary JSON compression still works", () => {
  test("a large JSON response (> threshold) is gzip-encoded", async () => {
    const big = "x".repeat(20_000);
    const res = new Response(JSON.stringify({ big }), {
      headers: { "Content-Type": "application/json" },
    });
    const out = await maybeCompress(res, "gzip");
    expect(out.headers.get("Content-Encoding")).toBe("gzip");
    const body = await out.arrayBuffer();
    // gzip of 20KB of 'x' compresses far below the original byte length.
    expect(new TextDecoder().decode(body)).not.toContain("xxxx");
  });

  test("a small JSON response is NOT gzip-encoded (below threshold)", async () => {
    const res = new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
    const out = await maybeCompress(res, "gzip");
    expect(out.headers.get("Content-Encoding")).toBeNull();
    expect(await out.text()).toBe('{"ok":true}');
  });
});
