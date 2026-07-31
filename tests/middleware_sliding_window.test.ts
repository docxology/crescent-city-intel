import { describe, test, expect, beforeEach } from "bun:test";
import { rateLimitMiddleware, resolveIp, _testHooks, _getNow } from "../src/api/middleware";

/**
 * Rate-limit sliding-window exhaustion tests.
 *
 * Users the test clock hooks (_getNow / _testHooks.setNow) to freeze time
 * and exhaust the rate-limit window deterministically, without waiting for
 * real wall-clock time to pass.
 */
describe("rate limiter exhaustion", () => {
  beforeEach(() => {
    _testHooks.clearNow();
    _testHooks.resetAll();
  });

  test("allows requests up to the public limit then blocks the next", async () => {
    const baseTime = 1700000000000;
    _testHooks.setNow(baseTime);

    const middleware = rateLimitMiddleware();
    const limit = _testHooks.getPublicLimit();

    // Exhaust the window (use public IP to avoid loopback bypass)
    for (let i = 0; i < limit; i++) {
      const result = await middleware(new Request("http://localhost/api/search?q=test"), "203.0.113.1");
      expect(result).toBeNull();
    }

    // One more should 429
    const blocked = await middleware(new Request("http://localhost/api/search?q=test"), "203.0.113.1");
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
    const body = await blocked!.json();
    expect(body.error).toBe("Rate limit exceeded");
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  test("bypass paths are never rate limited", async () => {
    const baseTime = 1700000000000;
    _testHooks.setNow(baseTime);

    const middleware = rateLimitMiddleware();
    const limit = _testHooks.getPublicLimit();

    // Exhaust the window on /api/search (public IP to avoid loopback bypass)
    for (let i = 0; i < limit; i++) {
      await middleware(new Request("http://localhost/api/search?q=test"), "203.0.113.1");
    }

    // /api/health should still pass
    const healthCheck = await middleware(new Request("http://localhost/api/health"), "1.2.3.4");
    expect(healthCheck).toBeNull();
  });

  test("stricter per-endpoint limits are enforced", async () => {
    const baseTime = 1700000000000;
    _testHooks.setNow(baseTime);

    const middleware = rateLimitMiddleware();
    // /api/chat has a 20-request limit (use public IP)

    for (let i = 0; i < 20; i++) {
      const result = await middleware(new Request("http://localhost/api/chat"), "203.0.113.1");
      expect(result).toBeNull();
    }

    const blocked = await middleware(new Request("http://localhost/api/chat"), "203.0.113.1");
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
  });

  test("requests expire after the sliding window", async () => {
    const baseTime = 1700000000000;
    _testHooks.setNow(baseTime);

    const middleware = rateLimitMiddleware();
    const limit = _testHooks.getPublicLimit();

    // Exhaust the window (public IP)
    for (let i = 0; i < limit; i++) {
      await middleware(new Request("http://localhost/api/search?q=test"), "203.0.113.1");
    }

    // 429 at baseTime
    let blocked = await middleware(new Request("http://localhost/api/search?q=test"), "203.0.113.1");
    expect(blocked!.status).toBe(429);

    // Advance past the window (1 hour + 1 ms)
    _testHooks.setNow(baseTime + _testHooks.getWindowMs() + 1);

    // Should be allowed again
    const allowed = await middleware(new Request("http://localhost/api/search?q=test"), "203.0.113.1");
    expect(allowed).toBeNull();
  });

  test("different IPs have independent rate limits", async () => {
    const baseTime = 1700000000000;
    _testHooks.setNow(baseTime);

    const middleware = rateLimitMiddleware();
    const limit = _testHooks.getPublicLimit();

    // Use public IPs (private IPs bypass rate limiting entirely)
    // Exhaust for IP A
    for (let i = 0; i < limit; i++) {
      await middleware(new Request("http://localhost/api/search?q=test"), "203.0.113.1");
    }

    // IP A is blocked
    const blockedA = await middleware(new Request("http://localhost/api/search?q=test"), "203.0.113.1");
    expect(blockedA!.status).toBe(429);

    // IP B is still allowed
    const allowedB = await middleware(new Request("http://localhost/api/search?q=test"), "203.0.113.2");
    expect(allowedB).toBeNull();
  });
});

describe("resolveIp", () => {
  test("falls back to socket IP when headers absent", () => {
    const req = new Request("http://localhost/api/search");
    expect(resolveIp(req, "192.168.1.1")).toBe("192.168.1.1");
  });

  test("prefers x-forwarded-for over socket", () => {
    const req = new Request("http://localhost/api/search", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    expect(resolveIp(req, "192.168.1.1")).toBe("10.0.0.1");
  });

  test("falls back to unknown when nothing available", () => {
    const req = new Request("http://localhost/api/search");
    expect(resolveIp(req)).toBe("unknown");
  });
});

describe("_getNow", () => {
  test("returns Date.now() when no clock override is set", () => {
    _testHooks.clearNow();
    const result = _getNow();
    expect(result).toBeGreaterThan(1700000000000);
    expect(result).toBeLessThan(Date.now() + 1000);
  });

  test("returns the injected value when setNow is active", () => {
    _testHooks.setNow(1700000000000);
    expect(_getNow()).toBe(1700000000000);
  });
});
