import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { boundedHttpFetch, redactUrl, validateDestination, redirectHeaders } from "../src/shared/transport.ts";
import { boundedFetchText, resetConnectorState } from "../src/alerts/connector.ts";

const fixturePolicy = { allowPrivateHosts: ["localhost"], timeoutMs: 500, maxBytes: 1000 };
describe("bounded destination and representation", () => {
  test("cross-origin real redirect strips credentials and policy rejects HTTPS downgrade", async () => {
    let received: Headers | null = null;
    const target = Bun.serve({ port: 0, fetch: req => { received = req.headers; return new Response("target"); } });
    const origin = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 302, headers: { Location: `http://localhost:${target.port}/` } }) });
    try {
      expect(await (await boundedHttpFetch(`http://localhost:${origin.port}/`, { ...fixturePolicy, headers: { Authorization: "Bearer private", Cookie: "private=1", "X-API-Key": "private", "X-Public": "retained" } })).text()).toBe("target");
      const headers = received as Headers | null;
      expect(headers?.get("authorization")).toBeNull(); expect(headers?.get("cookie")).toBeNull(); expect(headers?.get("x-api-key")).toBeNull(); expect(headers?.get("x-public")).toBe("retained");
      expect(() => redirectHeaders(new URL("https://example.com/"), new URL("http://example.com/"), {})).toThrow("downgrade");
    } finally { origin.stop(true); target.stop(true); }
  });
  test("rejects private DNS, mapped IPv6 and credentials by default", async () => {
    for (const url of ["http://localhost/a", "http://[::1]/", "http://[::ffff:7f00:1]/", "http://user:secret@example.com/"]) {
      await expect(validateDestination(url)).rejects.toMatchObject({ kind: "destination" });
    }
    expect(redactUrl("https://example.com/feed?api_key=secret&name=public")).not.toContain("secret");
  });
  test("OAuth/router fragment credentials are denied and redacted while numeric source fragments remain valid", async () => {
    let requests = 0;
    const server = Bun.serve({ port: 0, fetch: () => { requests++; return new Response("public source"); } });
    const base = `http://localhost:${server.port}/source`;
    try {
      for (const fragment of ["#access_token=private-fixture-token", "#/login?api_key=private-fixture-token", "#access%5Ftoken%3Dprivate-fixture-token", "#auth=private-fixture-token", "#public=1;sig=private-fixture-token", "#bearer=private-fixture-token", "#jwt=private-fixture-token"]) {
        const url = base + fragment;
        expect(redactUrl(url)).not.toContain("private-fixture-token");
        await expect(boundedHttpFetch(url, fixturePolicy)).rejects.toMatchObject({ kind: "destination" });
      }
      expect(requests).toBe(0);
      expect(redactUrl(base + "#44236217")).toBe(base + "#44236217");
      expect(await (await boundedHttpFetch(base + "#44236217", fixturePolicy)).text()).toBe("public source");
      expect(requests).toBe(1);
    } finally { server.stop(true); }
  });
  test("counts UTF-8 bytes and inflated gzip bytes", async () => {
    const server = Bun.serve({ port: 0, fetch: req => req.url.endsWith("gzip")
      ? new Response(gzipSync("a".repeat(10000)), { headers: { "Content-Encoding": "gzip" } })
      : new Response("🌊".repeat(300)) });
    try {
      for (const path of ["utf8", "gzip"]) await expect(boundedHttpFetch(`http://localhost:${server.port}/${path}`, fixturePolicy)).rejects.toMatchObject({ kind: "size" });
    } finally { server.stop(true); }
  });
  test("revalidates redirect target and caps loops", async () => {
    const server: ReturnType<typeof Bun.serve> = Bun.serve({ port: 0, fetch: (req): Response => new Response(null, { status: 302, headers: {
      Location: req.url.endsWith("private") ? `http://127.0.0.1:${server.port}/destination` : "/loop",
    } }) });
    try {
      await expect(boundedHttpFetch(`http://localhost:${server.port}/private`, fixturePolicy)).rejects.toMatchObject({ kind: "destination" });
      await expect(boundedHttpFetch(`http://localhost:${server.port}/loop`, { ...fixturePolicy, maxRedirects: 1 })).rejects.toMatchObject({ kind: "redirect" });
    } finally { server.stop(true); }
  });
  test("body stall cannot outlive the total request deadline", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } })) });
    try {
      const started = Date.now();
      await expect(boundedHttpFetch(`http://localhost:${server.port}/`, { ...fixturePolicy, timeoutMs: 80 })).rejects.toMatchObject({ kind: "timeout" });
      expect(Date.now() - started).toBeLessThan(1000);
    } finally { server.stop(true); }
  });
});

describe("robots and concurrent host policy", () => {
  test("cached policy is evaluated separately for allowed and denied paths in both orders", async () => {
    const requests: string[] = [];
    const server = Bun.serve({ port: 0, fetch: req => {
      const path = new URL(req.url).pathname; requests.push(path);
      return new Response(path === "/robots.txt" ? "User-agent: *\nDisallow: /private\nAllow: /private/public\n" : "real payload");
    } });
    const options = { ...fixturePolicy, label: "fixture", retry: false, minIntervalMs: 0 };
    try {
      for (const reverse of [false, true]) {
        resetConnectorState(); requests.length = 0;
        if (!reverse) expect(await boundedFetchText(`http://localhost:${server.port}/private/public`, options)).toBe("real payload");
        await expect(boundedFetchText(`http://localhost:${server.port}/private/data`, options)).rejects.toMatchObject({ kind: "robots" });
        if (reverse) expect(await boundedFetchText(`http://localhost:${server.port}/private/public`, options)).toBe("real payload");
        expect(requests).toEqual(["/robots.txt", "/private/public"]);
      }
    } finally { server.stop(true); resetConnectorState(); }
  });
  test("parallel fetches reserve different host slots under one budget", async () => {
    const times: number[] = [];
    const server = Bun.serve({ port: 0, fetch: () => { times.push(Date.now()); return new Response("ok"); } });
    try {
      resetConnectorState();
      await Promise.all([1, 2, 3].map(() => boundedFetchText(`http://localhost:${server.port}/`, {
        ...fixturePolicy, label: "spacing", minIntervalMs: 60, skipRobots: true, retry: false,
      })));
      expect(times[1] - times[0]).toBeGreaterThanOrEqual(45);
      expect(times[2] - times[1]).toBeGreaterThanOrEqual(45);
      await expect(boundedFetchText(`http://localhost:${server.port}/`, { ...fixturePolicy, label: "budget", minIntervalMs: 1000, timeoutMs: 20, skipRobots: true })).rejects.toMatchObject({ kind: "timeout" });
    } finally { server.stop(true); resetConnectorState(); }
  });
});
