/**
 * Connector-level tests for the bounded live-fetch layer
 * (src/alerts/connector.ts) and the five expansion monitors' live wiring.
 *
 * Every fetch in these tests hits a real local Bun.serve HTTP server — no
 * mocks, no public-network dependence — so the timeout, size-cap, rate-limit,
 * robots-gate and degradation behaviors are exercised through the real fetch
 * path the monitors use in live mode.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  BoundedFetchError,
  CONNECTOR_USER_AGENT,
  boundedFetchText,
  resetConnectorState,
  robotsAllowsPath,
  setHostRateLimit,
} from "../src/alerts/connector";
import {
  AIS_MAX_BYTES,
  AIS_REQUEST_HEADERS,
  parseAisLocations,
} from "../src/alerts/ais";
import { PERMITS_MAX_BYTES } from "../src/alerts/permits";
import { FUEL_MAX_BYTES } from "../src/alerts/fuel";
import { PACFIN_MAX_BYTES } from "../src/alerts/pacfin";
import { CCHARBOR_SITEMAP_MAX_BYTES } from "../src/alerts/dredging";

interface TestServer {
  port: number;
  stop: () => void;
  requests: Array<{ path: string; userAgent: string | null; acceptEncoding: string | null }>;
}

function startServer(
  handler: (request: Request, server: TestServer) => Response | Promise<Response>,
): TestServer {
  const state: TestServer = {
    port: 0,
    stop: () => {},
    requests: [],
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      state.requests.push({
        path: new URL(request.url).pathname,
        userAgent: request.headers.get("user-agent"),
        acceptEncoding: request.headers.get("accept-encoding"),
      });
      return handler(request, state);
    },
  });
  state.port = server.port;
  state.stop = () => server.stop(true);
  return state;
}

const permitsServerBody = '<div class="template-element" data-category="cat" data-id="1" data-name="Over the Counter Permit" data-module="pi"><div class="template-department">Building Department</div><div class="template-description">Minor Electrical</div></div>';
const aisServerBody = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      mmsi: 230000001,
      timestampExternal: 1727500000000,
      geometry: { type: "Point", coordinates: [21.1, 60.5] },
      properties: { sog: 5.5, cog: 180, heading: 175 },
    },
  ],
});

afterAll(() => resetConnectorState());

describe("boundedFetchText — timeout bound", () => {
  test("aborts a hung response and reports a typed timeout failure", { timeout: 15_000 }, async () => {
    resetConnectorState();
    const server = startServer((request) => {
      if (request.url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n");
      return new Promise<Response>(() => {});
    });
    try {
      const t0 = Date.now();
      let error: BoundedFetchError | undefined;
      try {
        await boundedFetchText(`http://localhost:${server.port}/hung`, {
          label: "hung source",
          maxBytes: 100_000,
          timeoutMs: 250,
          minIntervalMs: 0,
          retry: false,
        });
      } catch (err) {
        error = err as BoundedFetchError;
      }
      const elapsed = Date.now() - t0;
      expect(error).toBeInstanceOf(BoundedFetchError);
      expect(error!.kind).toBe("timeout");
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      server.stop();
    }
  });
});

describe("boundedFetchText — size bound", () => {
  test("rejects a body streaming past the byte cap (no Content-Length)", async () => {
    resetConnectorState();
    const server = startServer(async () => {
      const stream = new ReadableStream({
        async start(controller) {
          const chunk = "x".repeat(64 * 1024);
          for (let i = 0; i < 40; i += 1) {
            controller.enqueue(new TextEncoder().encode(chunk));
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/html" },
      });
    });
    try {
      let error: BoundedFetchError | undefined;
      try {
        await boundedFetchText(`http://localhost:${server.port}/huge`, {
          label: "oversized source",
          maxBytes: 128 * 1024,
          timeoutMs: 5_000,
          minIntervalMs: 0,
          retry: false,
        });
      } catch (err) {
        error = err as BoundedFetchError;
      }
      expect(error).toBeInstanceOf(BoundedFetchError);
      expect(error!.kind).toBe("size");
      expect(error!.message).toContain("size cap");
    } finally {
      server.stop();
    }
  });
});

describe("boundedFetchText — rate bound", () => {
  test("a second fetch to the same host waits for the per-host interval", async () => {
    resetConnectorState();
    const server = startServer(() => new Response("ok"));
    try {
      const url = `http://localhost:${server.port}/rate-limited`;
      await boundedFetchText(url, {
        label: "rate source",
        maxBytes: 1000,
        minIntervalMs: 700,
        retry: false,
      });
      const secondStarted = Date.now();
      await boundedFetchText(url, {
        label: "rate source",
        maxBytes: 1000,
        minIntervalMs: 700,
        retry: false,
      });
      const gap = Date.now() - secondStarted;
      expect(gap).toBeGreaterThanOrEqual(500);
      expect(server.requests.filter(req => req.path === "/rate-limited").length).toBe(2);
    } finally {
      server.stop();
    }
  });

  test("setHostRateLimit defers a fetch to a future instant", async () => {
    resetConnectorState();
    const server = startServer(() => new Response("ok"));
    try {
      setHostRateLimit(`localhost:${server.port}`, Date.now() + 400);
      const started = Date.now();
      await boundedFetchText(`http://localhost:${server.port}/deferred`, {
        label: "deferred source",
        maxBytes: 1000,
        minIntervalMs: 0,
        retry: false,
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    } finally {
      server.stop();
    }
  });
});

describe("boundedFetchText — robots gate", () => {
  test("a User-agent: * Disallow: / host is declined with a typed robots error, before any page fetch", async () => {
    resetConnectorState();
    const server = startServer((request) => {
      if (request.url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /\n", { status: 200 });
      }
      return new Response("the page itself");
    });
    try {
      let error: BoundedFetchError | undefined;
      try {
        await boundedFetchText(`http://localhost:${server.port}/pacfin/`, {
          label: "blocked source",
          maxBytes: 1000,
          minIntervalMs: 0,
          retry: false,
        });
      } catch (err) {
        error = err as BoundedFetchError;
      }
      expect(error).toBeInstanceOf(BoundedFetchError);
      expect(error!.kind).toBe("robots");
      expect(error!.message).toContain("source declined, not scraped");
      expect(server.requests.map(req => req.path)).toEqual(["/robots.txt"]);
    } finally {
      server.stop();
    }
  });

  test("a host with no matching Disallow fetches normally and sends the repo UA", async () => {
    resetConnectorState();
    const server = startServer((request) => {
      if (request.url.endsWith("/robots.txt")) {
        return new Response("User-agent: SemrushBot\nDisallow: /\n", { status: 200 });
      }
      return new Response(permitsServerBody);
    });
    try {
      const text = await boundedFetchText(`http://localhost:${server.port}/module?module=pi`, {
        label: "allowed source",
        maxBytes: 1000,
        minIntervalMs: 0,
        retry: false,
      });
      expect(text).toContain("template-element");
      expect(server.requests[0]!.userAgent).toBe(CONNECTOR_USER_AGENT);
      expect(server.requests.filter(req => req.path === "/robots.txt").length).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("robotsAllowsPath applies the longest matching Disallow of the * group only", () => {
    const robots = [
      "User-agent: other-bot",
      "Disallow: /everything",
      "",
      "User-agent: *",
      "Disallow: /api/",
      "Allow: /api/public",
      "# comment",
      "Disallow: /private/nested/path",
    ].join("\n");
    expect(robotsAllowsPath(robots, "/api/locations").allowed).toBe(false);
    expect(robotsAllowsPath(robots, "/private/nested/path/x").allowed).toBe(false);
    expect(robotsAllowsPath(robots, "/public/page").allowed).toBe(true);
    expect(robotsAllowsPath("", "/anything").allowed).toBe(true);
  });

  test("a 403 robots endpoint denies by default — a wall must not widen permissions", async () => {
    resetConnectorState();
    const server = startServer(() => new Response("forbidden", { status: 403 }));
    try {
      let error: BoundedFetchError | undefined;
      try {
        await boundedFetchText(`http://localhost:${server.port}/page`, {
          label: "walled source",
          maxBytes: 1000,
          minIntervalMs: 0,
          retry: false,
        });
      } catch (err) {
        error = err as BoundedFetchError;
      }
      expect(error!.kind).toBe("robots");
      expect(error!.message).toContain("robots.txt unreachable (HTTP 403)");
    } finally {
      server.stop();
    }
  });
});

describe("boundedFetchText — status and degradation", () => {
  test("a 503 surfaces as a typed status error", async () => {
    resetConnectorState();
    const server = startServer(() => new Response("down", { status: 503 }));
    try {
      let error: BoundedFetchError | undefined;
      try {
        await boundedFetchText(`http://localhost:${server.port}/down`, {
          label: "dead source",
          maxBytes: 1000,
          minIntervalMs: 0,
          retry: false,
        });
      } catch (err) {
        error = err as BoundedFetchError;
      }
      expect(error!.kind).toBe("status");
      expect(error!.message).toContain("503");
    } finally {
      server.stop();
    }
  });

  test("an empty 200 body is an error, not a silent empty success", async () => {
    resetConnectorState();
    const server = startServer(() => new Response("   "));
    try {
      let error: BoundedFetchError | undefined;
      try {
        await boundedFetchText(`http://localhost:${server.port}/blank`, {
          label: "empty source",
          maxBytes: 1000,
          minIntervalMs: 0,
          retry: false,
        });
      } catch (err) {
        error = err as BoundedFetchError;
      }
      expect(error!.kind).toBe("status");
      expect(error!.message).toContain("empty body");
    } finally {
      server.stop();
    }
  });

  test("a malformed payload reaches the parser and the parser throws (drift stays loud)", async () => {
    resetConnectorState();
    const server = startServer(() => new Response("this is not a FeatureCollection"));
    try {
      const body = await boundedFetchText(`http://localhost:${server.port}/ais-bad`, {
        label: "drifted source",
        maxBytes: 1000,
        minIntervalMs: 0,
        retry: false,
      });
      expect(() => parseAisLocations(body)).toThrow("source format changed");
    } finally {
      server.stop();
    }
  });
});

describe("live wiring — per-connector bound configs and headers", () => {
  test("every expansion monitor declares a positive body cap", () => {
    expect(PERMITS_MAX_BYTES).toBeGreaterThan(0);
    expect(CCHARBOR_SITEMAP_MAX_BYTES).toBeGreaterThan(0);
    expect(FUEL_MAX_BYTES).toBeGreaterThan(0);
    expect(PACFIN_MAX_BYTES).toBeGreaterThan(0);
    expect(AIS_MAX_BYTES).toBeGreaterThan(0);
  });

  test("the AIS connector sends the gzip Accept-Encoding digitraffic requires (bare requests 406)", async () => {
    resetConnectorState();
    let seenEncoding: string | null = null;
    const server = startServer((request) => {
      seenEncoding = request.headers.get("accept-encoding");
      return new Response(aisServerBody, { headers: { "content-type": "application/json" } });
    });
    try {
      const body = await boundedFetchText(`http://localhost:${server.port}/api/ais/v1/locations`, {
        label: "AIS locations feed",
        maxBytes: AIS_MAX_BYTES,
        headers: { ...AIS_REQUEST_HEADERS },
        skipRobots: true,
        minIntervalMs: 0,
        retry: false,
      });
      expect(seenEncoding).toContain("gzip");
      expect(parseAisLocations(body)[0]!.mmsi).toBe(230000001);
    } finally {
      server.stop();
    }
  });
});
