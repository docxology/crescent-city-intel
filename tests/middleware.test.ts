/**
 * Tests for API middleware: sliding-window rate limiter, API key auth.
 * Zero-mock — tests actual middleware functions with no stubs.
 */
import { describe, test, expect, beforeEach } from "bun:test";

// We test the exported pure functions directly, not over HTTP.
// Import after the module is loaded so the in-memory store is fresh for each test.

describe("middleware — sliding window rate limiter", () => {
  test("reloadApiKeys reads CRESCENT_CITY_API_KEY env var", async () => {
    const { reloadApiKeys } = await import("../src/api/middleware.ts");
    // Should not throw; simply reloads from env
    expect(() => reloadApiKeys()).not.toThrow();
  });

  test("applyMiddleware returns null for /api/health (bypass)", async () => {
    const { applyMiddleware } = await import("../src/api/middleware.ts");
    const req = new Request("http://localhost:3000/api/health", { method: "GET" });
    const result = await applyMiddleware(req);
    // Health bypass + public path → null (continue to handler)
    expect(result).toBeNull();
  });

  test("applyMiddleware returns null for localhost IP (rate limit bypass)", async () => {
    const { applyMiddleware } = await import("../src/api/middleware.ts");
    const req = new Request("http://localhost:3000/api/stats", {
      method: "GET",
      headers: { "x-real-ip": "127.0.0.1" },
    });
    const result = await applyMiddleware(req);
    // localhost bypasses rate limit; /api/stats is public → should be null
    expect(result).toBeNull();
  });

  test("applyMiddleware returns 401 for protected endpoint without API key", async () => {
    const { applyMiddleware } = await import("../src/api/middleware.ts");
    // /api/chat is NOT in public paths
    const req = new Request("http://localhost:3000/api/chat?q=test", {
      method: "GET",
      headers: { "x-real-ip": "127.0.0.1" }, // bypass rate limit
    });
    const result = await applyMiddleware(req);
    // Expecting 401 (no API key provided)
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test("applyMiddleware returns 403 for invalid API key", async () => {
    const { applyMiddleware } = await import("../src/api/middleware.ts");
    const req = new Request("http://localhost:3000/api/chat?q=test", {
      method: "GET",
      headers: {
        "x-real-ip": "127.0.0.1",
        "x-api-key": "wrong-key-xyz",
      },
    });
    const result = await applyMiddleware(req);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("applyMiddleware accepts valid API key", async () => {
    const { applyMiddleware, getPrimaryApiKey } = await import("../src/api/middleware.ts");
    const req = new Request("http://localhost:3000/api/chat?q=test", {
      method: "GET",
      headers: {
        "x-real-ip": "127.0.0.1",
        "x-api-key": getPrimaryApiKey(),
      },
    });
    const result = await applyMiddleware(req);
    // Valid key + localhost IP → null (continue)
    expect(result).toBeNull();
  });

  test("a public socket IP cannot bypass rate limiting with a spoofed loopback header", async () => {
    // Regression test for the 2026-07-24 finding: `resolveIp` prefers
    // client-supplied x-forwarded-for/x-real-ip, so a remote requester whose
    // REAL socket address is public must NOT be handed an unlimited rate-limit
    // bucket merely by sending `X-Forwarded-For: 127.0.0.1`. The bypass is now
    // decided on the socket address when one is present.
    const { rateLimitMiddleware, _testHooks } = await import("../src/api/middleware.ts");
    _testHooks.clearNow();
    _testHooks.resetAll();
    const middleware = rateLimitMiddleware();
    const req = (n: number) =>
      new Request("http://localhost:3000/api/search?q=test", {
        method: "GET",
        headers: { "x-forwarded-for": `127.0.0.${n}` }, // spoofed loopback
      });
    const limit = _testHooks.getPublicLimit();
    // Exhaust the window: socket address is a public IP, so each request is
    // bucketed (spoofed value) and the NEXT identical-blade request is blocked.
    for (let i = 0; i < limit; i++) {
      expect(await middleware(req(1), "203.0.113.42")).toBeNull();
    }
    const blocked = await middleware(req(1), "203.0.113.42");
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
  });
});

describe("middleware — path helpers", () => {
  test("public search endpoint requires no API key", async () => {
    const { applyMiddleware } = await import("../src/api/middleware.ts");
    const req = new Request("http://localhost:3000/api/search?q=tsunami", {
      method: "GET",
      headers: { "x-real-ip": "127.0.0.1" },
    });
    const result = await applyMiddleware(req);
    expect(result).toBeNull();
  });

  test("public stats endpoint requires no API key", async () => {
    const { applyMiddleware } = await import("../src/api/middleware.ts");
    const req = new Request("http://localhost:3000/api/stats", {
      method: "GET",
      headers: { "x-real-ip": "127.0.0.1" },
    });
    const result = await applyMiddleware(req);
    expect(result).toBeNull();
  });
});

describe("middleware — isTrustedLocalIp (gates whether gui/server.ts hands the real API key to a requester)", () => {
  test("loopback and private-LAN addresses are trusted", async () => {
    const { isTrustedLocalIp } = await import("../src/api/middleware.ts");
    expect(isTrustedLocalIp("127.0.0.1")).toBe(true);
    expect(isTrustedLocalIp("::1")).toBe(true);
    expect(isTrustedLocalIp("192.168.1.50")).toBe(true);
    expect(isTrustedLocalIp("10.0.0.5")).toBe(true);
  });

  test("a public IP is not trusted", async () => {
    const { isTrustedLocalIp } = await import("../src/api/middleware.ts");
    expect(isTrustedLocalIp("203.0.113.42")).toBe(false);
    expect(isTrustedLocalIp("unknown")).toBe(false);
  });
});

describe("middleware — resolveIp", () => {
  test("proxy headers take priority over the socket fallback", async () => {
    const { resolveIp } = await import("../src/api/middleware.ts");
    const req = new Request("http://localhost:3000/api/stats", {
      headers: { "x-real-ip": "203.0.113.42" },
    });
    expect(resolveIp(req, "127.0.0.1")).toBe("203.0.113.42");
  });

  test("falls back to the socket address when no proxy header is present", async () => {
    const { resolveIp } = await import("../src/api/middleware.ts");
    const req = new Request("http://localhost:3000/api/stats");
    expect(resolveIp(req, "127.0.0.1")).toBe("127.0.0.1");
  });

  test("falls back to 'unknown' when neither a header nor a socket address is available", async () => {
    const { resolveIp } = await import("../src/api/middleware.ts");
    const req = new Request("http://localhost:3000/api/stats");
    expect(resolveIp(req, undefined)).toBe("unknown");
  });
});

describe("middleware — header-only API key auth", () => {
  test("a VALID key sent via ?api_key= query parameter is REJECTED (header-only)", async () => {
    const { applyMiddleware, getPrimaryApiKey } = await import("../src/api/middleware.ts");
    // Real valid key, but in the query string with no header; public socket IP so
    // the local bypass does not short-circuit before auth.
    const req = new Request("http://localhost:3000/api/chat?" + new URLSearchParams({ api_key: getPrimaryApiKey() }), {
      method: "GET",
    });
    const result = await applyMiddleware(req, "203.0.113.42");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test("the 401 message advertises the X-API-Key header only", async () => {
    const { applyMiddleware } = await import("../src/api/middleware.ts");
    const req = new Request("http://localhost:3000/api/chat", { method: "GET" });
    const result = await applyMiddleware(req, "203.0.113.42")!;
    const body = await result!.json();
    expect(body.message).toContain("X-API-Key header");
    expect((body.message as string).toLowerCase()).not.toContain("query");
  });

  test("a valid X-API-Key header still authenticates", async () => {
    const { applyMiddleware, getPrimaryApiKey } = await import("../src/api/middleware.ts");
    const req = new Request("http://localhost:3000/api/chat", {
      headers: { "x-api-key": getPrimaryApiKey() },
    });
    const result = await applyMiddleware(req, "198.51.100.7");
    expect(result).toBeNull();
  });
});
