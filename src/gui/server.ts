#!/usr/bin/env bun
/** GUI server — lightweight HTML viewer served by Bun.serve() */
import { handleApiRoute } from "./routes.js";
import { initSearch } from "./search.js";
import { createLogger } from "../logger.js";
import { applyMiddleware } from "../api/middleware.ts";

const log = createLogger("gui");

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const STATIC_DIR = new URL("static/", import.meta.url).pathname;

/** Minimum byte size to bother compressing (4 KB) */
const GZIP_THRESHOLD = 4096;

/**
 * Transparently gzip-compress a Response if the client supports it
 * and the response body is larger than GZIP_THRESHOLD bytes.
 */
async function maybeCompress(res: Response, acceptEncoding: string | null): Promise<Response> {
  if (!acceptEncoding?.includes("gzip")) return res;
  const ct = res.headers.get("Content-Type") ?? "";
  if (!ct.startsWith("application/json") && !ct.startsWith("text/")) return res;

  const body = await res.arrayBuffer();
  if (body.byteLength < GZIP_THRESHOLD) return new Response(body, res);

  const compressed = Bun.gzipSync(Buffer.from(body));
  const headers = new Headers(res.headers);
  headers.set("Content-Encoding", "gzip");
  headers.set("Content-Length", String(compressed.byteLength));
  headers.set("Vary", "Accept-Encoding");
  return new Response(compressed, { status: res.status, headers });
}

// Pre-load search index
await initSearch();

const server = Bun.serve({
  port: PORT,
  // Bun's default idleTimeout is 10s. The non-streaming RAG endpoints
  // (GET/POST /api/chat, /api/summarize) hold the connection open with zero
  // bytes flowing for the entire embed+retrieve+generate round-trip against a
  // real local Ollama model, which routinely exceeds 10s — Bun was silently
  // killing the socket mid-generation ("[Bun.serve]: request timed out after
  // 10 seconds"), making chat effectively unusable for any real query.
  // Confirmed live: curl to /api/chat hung/dropped every time until this was
  // raised. 120s covers a slow cold-start model load plus generation.
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    // API routes — middleware (rate limiting / API key auth) applies only here.
    // It must not run for static asset / SPA requests below: PUBLIC_PATHS and
    // BYPASS_PATHS are both "/api/..."-scoped, so applying it unconditionally
    // (as before) 401'd every page load, including "/" itself.
    if (url.pathname.startsWith("/api/")) {
      const middlewareResponse = await applyMiddleware(req);
      if (middlewareResponse !== null) {
        return middlewareResponse;
      }
      const apiRes = await handleApiRoute(url, req);
      return maybeCompress(apiRes, req.headers.get("Accept-Encoding"));
    }

    // Static files
    let filePath = `${STATIC_DIR}${url.pathname === "/" ? "index.html" : url.pathname}`;
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    // SPA fallback
    return new Response(Bun.file(`${STATIC_DIR}index.html`));
  },
  error(err) {
    // Catch EADDRINUSE (port already in use) and give a helpful message
    if ((err as any).code === 'EADDRINUSE') {
      log.error(`Port ${PORT} is already in use.`, {
        suggestion: `Run with a different port: PORT=${PORT + 1} bun run gui`,
      });
      process.exit(1);
    }
    throw err;
  },
});

log.info(`Municipal Code Viewer running at http://localhost:${server.port}`);
