/**
 * Tests for the config-driven webhook notifier (src/alerts/notify.ts).
 * Zero-mock: spins a real local Bun.serve listener to capture the POST.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { maybeSendSeverityWebhook, sendWebhook, isWebhookConfigured, webhookTimeoutMs } from "../src/alerts/notify.ts";

let server: ReturnType<typeof Bun.serve> | null = null;
let captured: { body: unknown } | null = null;

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
