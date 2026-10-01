import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { boundedHttpFetch, redactUrl, validateDestination, redirectHeaders, withTransportScope, withinDeadline } from "../src/shared/transport.ts";
import { boundedFetchText, resetConnectorState } from "../src/alerts/connector.ts";
import { runBoundedChild } from "../src/shared/subprocess.ts";

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
  test("admission cannot dispatch twice, escape settlement or retain a failed request", async () => {
    let requests = 0; let heldStart: (() => void) | undefined;
    let bodyClosed!: () => void;
    const closed = new Promise<void>(resolve => { bodyClosed = resolve; });
    let arrived!: () => void;
    const arrival = new Promise<void>(resolve => { arrived = resolve; });
    const server = Bun.serve({ port: 0, fetch: req => {
      requests++;
      if (new URL(req.url).pathname === "/held") {
        arrived();
        return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel() { bodyClosed(); } }));
      }
      return new Response("ok");
    } });
    try {
      const base = `http://localhost:${server.port}`;
      await expect(boundedHttpFetch(base, { ...fixturePolicy, admitRequest: async (_url, _signal, start) => { heldStart = start; } })).rejects.toThrow("did not dispatch");
      expect(() => heldStart!()).toThrow("already settled");
      expect(requests).toBe(0);
      await expect(boundedHttpFetch(base, { ...fixturePolicy, admitRequest: async (_url, _signal, start) => { start(); start(); } })).rejects.toThrow("more than once");
      // Observe real request admission before causing the callback failure.
      const failed = boundedHttpFetch(base + "/held", { ...fixturePolicy, admitRequest: async (_url, _signal, start) => { start(); await arrival; throw new Error("admission failed"); } });
      await expect(failed).rejects.toMatchObject({ kind: "network" });
      await withinDeadline(async () => closed, 500);
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
  test("late timers do not release expired host slots together", async () => {
    const times: number[] = [];
    const server = Bun.serve({ port: 0, fetch: () => {
      times.push(Date.now());
      if (times.length === 1) {
        // An actual handler stalls the same event loop past both old reservations.
        const until = Date.now() + 150;
        while (Date.now() < until) { /* real event-loop contention */ }
      }
      return new Response("ok");
    } });
    try {
      resetConnectorState();
      expect(await Promise.all([1, 2, 3].map(() => boundedFetchText(`http://localhost:${server.port}/`, {
        ...fixturePolicy, label: "late admission", minIntervalMs: 60, skipRobots: true, retry: false,
      })))).toEqual(["ok", "ok", "ok"]);
      expect(times[1] - times[0]).toBeGreaterThanOrEqual(45);
      expect(times[2] - times[1]).toBeGreaterThanOrEqual(45);
    } finally { server.stop(true); resetConnectorState(); }
  });
  test("caller policy completes before actual host admission", async () => {
    const times: number[] = []; let policies = 0;
    let releasePolicy!: () => void;
    const policyReady = new Promise<void>(resolve => { releasePolicy = resolve; });
    const server = Bun.serve({ port: 0, fetch: () => { times.push(Date.now()); return new Response("ok"); } });
    try {
      resetConnectorState();
      await Promise.all([1, 2, 3].map(() => boundedFetchText(`http://localhost:${server.port}/`, {
        ...fixturePolicy, label: "delayed policy", minIntervalMs: 60, skipRobots: true, retry: false,
        beforeRequest: async () => {
          if (++policies === 3) setTimeout(releasePolicy, 80);
          await policyReady;
        },
      })));
      expect(policies).toBe(3);
      expect(times[1] - times[0]).toBeGreaterThanOrEqual(45);
      expect(times[2] - times[1]).toBeGreaterThanOrEqual(45);
    } finally { server.stop(true); resetConnectorState(); }
  });
  test("deferred caller microtasks cannot invalidate dispatch spacing at an independent receiver", async () => {
    const receiver = `
      let count = 0;
      const server = Bun.serve({port: 0, fetch: () => {
        console.log(Date.now());
        if (++count === 3) setTimeout(() => { server.stop(true); process.exit(0); }, 30);
        return new Response('ok');
      }});
      console.log(JSON.stringify({port: server.port}));
      setTimeout(() => process.exit(2), 3000);
    `;
    const client = `
      import {boundedFetchText} from ${JSON.stringify(new URL("../src/alerts/connector.ts", import.meta.url).href)};
      const child = Bun.spawn([process.execPath, '--eval', ${JSON.stringify(receiver)}], {stdout: 'pipe', stderr: 'pipe'});
      try {
        const reader = child.stdout.getReader(); let first = '';
        while (!first.includes('\\n')) { const next = await reader.read(); if (next.done) throw new Error('Receiver exited before ready'); first += new TextDecoder().decode(next.value); }
        const split = first.indexOf('\\n'), port = JSON.parse(first.slice(0, split)).port;
        const output = (async () => { let text = ''; try { for (;;) { const next = await reader.read(); if (next.done) return text; text += new TextDecoder().decode(next.value); } } finally { reader.releaseLock(); } })();
        const errors = new Response(child.stderr).text();
        let scheduled = false;
        const payloads = await Promise.all([1, 2, 3].map(() => boundedFetchText('http://localhost:' + port + '/', {
          allowPrivateHosts: ['localhost'], timeoutMs: 2000, maxBytes: 1000, label: 'independent receiver', minIntervalMs: 60, skipRobots: true, retry: false,
          beforeRequest: async () => {
            if (scheduled) return; scheduled = true;
            const stall = remaining => remaining > 0 ? queueMicrotask(() => stall(remaining - 1)) : (() => { const until = Date.now() + 150; while (Date.now() < until) {} })();
            queueMicrotask(() => stall(2));
          },
        })));
        const timestamps = (first.slice(split + 1) + await output).trim().split('\\n').map(Number);
        const exitCode = await child.exited; const stderr = await errors;
        if (exitCode !== 0 || stderr || timestamps.length !== 3 || timestamps.some(t => !Number.isFinite(t))) throw new Error('Receiver evidence invalid');
        console.log(JSON.stringify({payloads, gaps: timestamps.slice(1).map((t, i) => t - timestamps[i]), receiverExitCode: exitCode}));
      } finally { child.kill(); await child.exited; }
    `;
    const result = await runBoundedChild([process.execPath, "--eval", client], { timeoutMs: 4000, maxBytes: 16_000 });
    expect(result.stderr).toBe(""); expect(result.status).toBe("ok"); expect(result.reaped).toBe(true);
    const evidence = JSON.parse(result.stdout);
    expect(evidence.payloads).toEqual(["ok", "ok", "ok"]); expect(evidence.receiverExitCode).toBe(0);
    for (const gap of evidence.gaps) expect(gap).toBeGreaterThanOrEqual(45);
  });
  test("scope cancellation removes a queued admission without waiting for a stalled response", async () => {
    const paths: string[] = []; const owner = new AbortController(); const queued = new AbortController();
    let ownerArrived!: () => void;
    const ready = new Promise<void>(resolve => { ownerArrived = resolve; });
    const server = Bun.serve({ port: 0, fetch: req => {
      const path = new URL(req.url).pathname; paths.push(path);
      if (path === "/owner") { ownerArrived(); return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } })); }
      return new Response("ok");
    } });
    const options = { ...fixturePolicy, label: "cancellation", minIntervalMs: 60, skipRobots: true, retry: false };
    try {
      resetConnectorState();
      const running = boundedFetchText(`http://localhost:${server.port}/owner`, { ...options, signal: owner.signal });
      const ownerResult = running.then(value => ({ value }), error => ({ error }));
      await ready;
      const cancelled = withTransportScope({ signal: queued.signal }, () => boundedFetchText(`http://localhost:${server.port}/cancelled`, options));
      const queuedResult = cancelled.then(value => ({ value }), error => ({ error }));
      const later = boundedFetchText(`http://localhost:${server.port}/later`, options);
      queued.abort();
      expect(await queuedResult).toMatchObject({ error: { kind: "timeout" } });
      expect(await later).toBe("ok");
      expect(paths).toEqual(["/owner", "/later"]);
      owner.abort(); expect(await ownerResult).toMatchObject({ error: { kind: "timeout" } });
    } finally { owner.abort(); queued.abort(); server.stop(true); resetConnectorState(); }
  });
  test("robots misses and cross-host redirects use separate dispatch admissions", async () => {
    const starts = new Map<string, number[]>();
    const record = (req: Request) => {
      const url = new URL(req.url); const times = starts.get(url.host) ?? [];
      times.push(Date.now()); starts.set(url.host, times); return url;
    };
    const target = Bun.serve({ port: 0, fetch: req => new Response(record(req).pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : "target") });
    const origin = Bun.serve({ port: 0, fetch: req => {
      const url = record(req);
      return url.pathname === "/robots.txt" ? new Response("User-agent: *\nAllow: /")
        : url.pathname === "/redirect" ? new Response(null, { status: 302, headers: { Location: `http://localhost:${target.port}/final` } }) : new Response("origin");
    } });
    try {
      resetConnectorState();
      const options = { ...fixturePolicy, label: "robots redirect", minIntervalMs: 25, retry: false };
      expect(await Promise.all(["redirect", "other"].map(path => boundedFetchText(`http://localhost:${origin.port}/${path}`, options)))).toEqual(["target", "origin"]);
      for (const times of starts.values()) for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(15);
      expect(starts.get(`localhost:${target.port}`)?.length).toBe(2);
    } finally { origin.stop(true); target.stop(true); resetConnectorState(); }
  });
});
