/**
 * Tests for the config-driven webhook notifier (src/alerts/notify.ts).
 * Zero-mock: spins a real local Bun.serve listener to capture the POST.
 */
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { maybeSendSeverityWebhook as productionNotify, sendWebhook as productionSend, isWebhookConfigured, webhookTimeoutMs } from "../src/alerts/notify.ts";
import { withTransportScope } from "../src/shared/transport.ts";
function maybeSendSeverityWebhook(report: Parameters<typeof productionNotify>[0]) {
  const value = process.env.ALERT_WEBHOOK_URL;
  return productionNotify(report, value ? { origin: new URL(value).origin } : undefined);
}
function sendWebhook(...args: Parameters<typeof productionSend>) {
  const origin = new URL(args[0]).origin;
  return withTransportScope({ fixture: { origin, allowedOrigins: [origin] } }, () => productionSend(...args));
}

let server: ReturnType<typeof Bun.serve> | null = null;
let captured: { body: unknown } | null = null;

/**
 * The notifier persists the last-notified level under `output/state/`. Scope
 * that to a temp dir for the whole file: the release gate's output-corpus fence
 * fails any test that writes into the real `output/` tree, because a test that
 * mutates the corpus is a mock on a path reachable from a reported result.
 */
let webhookRoot: string;
const prevOutputRoot = process.env.CC_OUTPUT_DIR;
beforeAll(() => {
  webhookRoot = mkdtempSync(join(tmpdir(), "cc-webhook-root-"));
  process.env.CC_OUTPUT_DIR = webhookRoot;
});
afterAll(() => {
  if (prevOutputRoot === undefined) delete process.env.CC_OUTPUT_DIR;
  else process.env.CC_OUTPUT_DIR = prevOutputRoot;
  rmSync(webhookRoot, { recursive: true, force: true });
});

function startServer(): void {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.method === "POST") {
        if (new URL(req.url).pathname === "/fail") return new Response("boom", { status: 500 });
        captured = { body: await req.json() };
        return new Response("ok", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
}
startServer();

const url = `http://127.0.0.1:${server!.port}`;
const prevUrl = process.env.ALERT_WEBHOOK_URL;
const prevTimeout = process.env.ALERT_WEBHOOK_TIMEOUT_MS;

describe("alert webhook", () => {
  test("WARNING severity fires a webhook with the expected payload", async () => {
    captured = null;
    process.env.ALERT_WEBHOOK_URL = url;
    expect(isWebhookConfigured()).toBe(true);
    await maybeSendSeverityWebhook({ level: "WARNING", reason: "Large fire", assessedAt: "2026-01-01T00:00:00.000Z" });
    expect(captured).not.toBeNull();
    const body = captured!.body as any;
    expect(body.severity).toBe("WARNING");
    expect(body.reason).toBe("Large fire");
    expect(body.source).toContain("crescent-city-intel");
  });

  test("EMERGENCY fires too", async () => {
    captured = null;
    process.env.ALERT_WEBHOOK_URL = url;
    await maybeSendSeverityWebhook({ level: "EMERGENCY", reason: "Tsunami warning" });
    expect((captured!.body as any).severity).toBe("EMERGENCY");
  });

  test("CALM does NOT fire a webhook", async () => {
    captured = null;
    process.env.ALERT_WEBHOOK_URL = url;
    await maybeSendSeverityWebhook({ level: "CALM", reason: "All nominal" });
    expect(captured).toBeNull();
  });

  test("no-op (no throw) when ALERT_WEBHOOK_URL is unset", async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    await expect(maybeSendSeverityWebhook({ level: "WARNING", reason: "x" })).resolves.toBeUndefined();
  });

  test("a persistently WARNING composite notifies once, not on every run", async () => {
    // The defect: the notifier was purely level-triggered with no memory, so a
    // chronic WARNING — which a multi-year drought or a persistent air-quality
    // band produces on its own — POSTed on every run forever. A notifier that
    // is always firing trains the operator to ignore the endpoint.
    captured = null;
    process.env.ALERT_WEBHOOK_URL = url;
    await maybeSendSeverityWebhook({ level: "WARNING", reason: "chronic drought" });
    expect(captured).not.toBeNull();
    captured = null;
    await maybeSendSeverityWebhook({ level: "WARNING", reason: "chronic drought" });
    await maybeSendSeverityWebhook({ level: "WARNING", reason: "chronic drought" });
    // Suppressed: the level has not changed since the last notification.
    expect(captured).toBeNull();

    // A drop below the threshold clears the memory...
    await maybeSendSeverityWebhook({ level: "CALM", reason: "all nominal" });
    // ...so a later rise notifies again.
    captured = null;
    await maybeSendSeverityWebhook({ level: "WARNING", reason: "chronic drought" });
    expect(captured).not.toBeNull();

    // An escalation within the notified range still fires.
    captured = null;
    await maybeSendSeverityWebhook({ level: "EMERGENCY", reason: "tsunami warning" });
    expect((captured!.body as any).severity).toBe("EMERGENCY");
  });

  test("sendWebhook reports a non-2xx status without throwing", async () => {
    const result = await sendWebhook(`${url}/fail`, { a: 1 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });

  test("webhookTimeoutMs honors ALERT_WEBHOOK_TIMEOUT_MS and falls back to 5000", () => {
    delete process.env.ALERT_WEBHOOK_TIMEOUT_MS;
    expect(webhookTimeoutMs()).toBe(5000);
    process.env.ALERT_WEBHOOK_TIMEOUT_MS = "1200";
    expect(webhookTimeoutMs()).toBe(1200);
    process.env.ALERT_WEBHOOK_TIMEOUT_MS = "-5";
    expect(webhookTimeoutMs()).toBe(5000);
    process.env.ALERT_WEBHOOK_TIMEOUT_MS = "0";
    expect(webhookTimeoutMs()).toBe(5000);
    process.env.ALERT_WEBHOOK_TIMEOUT_MS = "12.5";
    expect(webhookTimeoutMs()).toBe(5000);
    process.env.ALERT_WEBHOOK_TIMEOUT_MS = "1200ms";
    expect(webhookTimeoutMs()).toBe(5000);
    process.env.ALERT_WEBHOOK_TIMEOUT_MS = "not-a-number";
    expect(webhookTimeoutMs()).toBe(5000);
  });
});

afterAll(() => {
  if (prevUrl === undefined) delete process.env.ALERT_WEBHOOK_URL;
  else process.env.ALERT_WEBHOOK_URL = prevUrl;
  if (prevTimeout === undefined) delete process.env.ALERT_WEBHOOK_TIMEOUT_MS;
  else process.env.ALERT_WEBHOOK_TIMEOUT_MS = prevTimeout;
  server?.stop(true);
});

describe("failed transitions remain retryable", () => {
  test("HTTP 500 does not consume the next successful WARNING transition", async () => {
    process.env.ALERT_WEBHOOK_URL = `${url}/fail`;
    await maybeSendSeverityWebhook({ level: "WARNING", reason: "fixture failure" });
    captured = null;
    process.env.ALERT_WEBHOOK_URL = url;
    await maybeSendSeverityWebhook({ level: "WARNING", reason: "retry after failure" });
    expect(captured).not.toBeNull();
  });
  test("a slow local endpoint times out under the configured transport budget", async () => {
    const slow = Bun.serve({ port: 0, async fetch() { await new Promise(resolve => setTimeout(resolve, 150)); return new Response("ok"); } });
    try {
      const start = Date.now();
      await expect(sendWebhook(`http://127.0.0.1:${slow.port}`, {}, 20)).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(100);
    } finally { slow.stop(true); }
  });
});

test("same-destination HTTP failures retry without a success receipt and then dedupe accepted delivery", async () => {
  let calls = 0;
  const transient = Bun.serve({ port: 0, fetch() { calls++; return new Response("", { status: calls <= 3 ? 503 : 202 }); } });
  process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${transient.port}`;
  try {
    await maybeSendSeverityWebhook({ level: "WARNING" }); expect(calls).toBe(3);
    await maybeSendSeverityWebhook({ level: "WARNING" }); expect(calls).toBe(4);
    await maybeSendSeverityWebhook({ level: "WARNING" }); expect(calls).toBe(4);
  } finally { transient.stop(true); }
});
