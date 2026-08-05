/**
 * Tests for the rate-limiter diagnostics (getRateLimitStats) surfaced in
 * /api/health (Phase 1.1). Zero-mock: real middleware + real route handler.
 */
import { describe, test, expect } from "bun:test";
import { rateLimitMiddleware, getRateLimitStats, _testHooks } from "../src/api/middleware.ts";
import { handleApiRoute } from "../src/gui/routes.ts";

describe("rate-limit diagnostics", () => {
  test("getRateLimitStats reflects tracked IPs, peak usage, and 429 block count", async () => {
    _testHooks.resetAll();
    _testHooks.resetBlockedCount();
    const mw = rateLimitMiddleware();
    const ip = "203.0.113.77";
    const req = () => new Request("http://localhost:3000/api/search?q=x", { method: "GET" });
    const limit = _testHooks.getPublicLimit();
    for (let i = 0; i < limit; i++) {
      expect(await mw(req(), ip)).toBeNull();
    }
    const blocked = await mw(req(), ip);
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
    const stats = getRateLimitStats();
    expect(stats.trackedIps).toBe(1);
    expect(stats.peakUsage).toBe(limit + 1);
    expect(stats.blocked).toBe(1);
  });
});

describe("/api/health rate-limit block", () => {
  test("health payload includes a rateLimit diagnostics object", async () => {
    const res = await handleApiRoute(new URL("http://localhost:3000/api/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("rateLimit");
    expect(typeof body.rateLimit.trackedIps).toBe("number");
    expect(typeof body.rateLimit.peakUsage).toBe("number");
    expect(typeof body.rateLimit.blocked).toBe("number");
  });
});
