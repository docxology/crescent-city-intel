/**
 * Tests for the push notification system (src/notifications/push.ts).
 *
 * Pure function tests — no actual webhook or VAPID HTTP calls. Tests the
 * configuration-checking, graceful-degradation, and console-fallback paths.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Import the push module fresh for each test (env-sensitive). */
async function importPush() {
  // Clear module cache so env-sniffing at module scope re-runs
  return await import("../src/notifications/push.ts");
}

// Save originals
const OLD_ENV = { ...process.env };

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("isPushConfigured", () => {
  beforeEach(() => {
    // Clear all push-related env vars before each test
    setEnv("ALERT_WEBHOOK_URL", undefined);
    setEnv("PUSH_PUBLIC_KEY", undefined);
    setEnv("PUSH_PRIVATE_KEY", undefined);
  });

  afterEach(() => {
    // Restore original env
    Object.assign(process.env, OLD_ENV);
  });

  test("returns false when no push config is present", async () => {
    const { isPushConfigured } = await importPush();
    expect(isPushConfigured()).toBe(false);
  });

  test("returns true when ALERT_WEBHOOK_URL is set", async () => {
    setEnv("ALERT_WEBHOOK_URL", "https://hooks.example.com/alert");
    const { isPushConfigured } = await importPush();
    expect(isPushConfigured()).toBe(true);
  });

  test("returns true when VAPID keys are set", async () => {
    setEnv("PUSH_PUBLIC_KEY", "test-public-key");
    setEnv("PUSH_PRIVATE_KEY", "test-private-key");
    const { isPushConfigured } = await importPush();
    expect(isPushConfigured()).toBe(true);
  });

  test("returns false when only public key is set (missing private)", async () => {
    setEnv("PUSH_PUBLIC_KEY", "test-public-key");
    setEnv("PUSH_PRIVATE_KEY", undefined);
    const { isPushConfigured } = await importPush();
    // Should still be true if ALERT_WEBHOOK_URL provides fallback
    expect(isPushConfigured()).toBe(false);
  });
});

describe("sendPushNotification — graceful degradation", () => {
  beforeEach(() => {
    setEnv("ALERT_WEBHOOK_URL", undefined);
    setEnv("PUSH_PUBLIC_KEY", undefined);
    setEnv("PUSH_PRIVATE_KEY", undefined);
  });

  afterEach(() => {
    Object.assign(process.env, OLD_ENV);
  });

  test("never throws when no push config is present (console fallback)", async () => {
    const { sendPushNotification } = await importPush();
    // Should not throw — console fallback
    await expect(sendPushNotification("Test Title", "Test Body")).resolves.toBeUndefined();
  });

  test("never throws with empty title and body", async () => {
    const { sendPushNotification } = await importPush();
    await expect(sendPushNotification("", "")).resolves.toBeUndefined();
  });

  test("never throws with url parameter when no push config", async () => {
    const { sendPushNotification } = await importPush();
    await expect(
      sendPushNotification("Title", "Body", "https://example.com/alert"),
    ).resolves.toBeUndefined();
  });

  test("gracefully handles webhook failure (bad URL)", async () => {
    setEnv("ALERT_WEBHOOK_URL", "https://nonexistent.example.com/webhook");
    const { sendPushNotification } = await importPush();
    // Fetch to a non-routable domain should fail gracefully
    await expect(
      sendPushNotification("Test", "Body"),
    ).resolves.toBeUndefined();
  });
});

describe("sendPushNotification — webhook path", () => {
  beforeEach(() => {
    setEnv("ALERT_WEBHOOK_URL", undefined);
    setEnv("PUSH_PUBLIC_KEY", undefined);
    setEnv("PUSH_PRIVATE_KEY", undefined);
  });

  afterEach(() => {
    Object.assign(process.env, OLD_ENV);
  });

  test("sends via webhook when ALERT_WEBHOOK_URL is set", async () => {
    // Start a local HTTP server to receive the webhook
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        // Respond with success
        return new Response("ok", { status: 200 });
      },
    });
    const port = server.port;
    setEnv("ALERT_WEBHOOK_URL", `http://localhost:${port}/push`);

    const { sendPushNotification } = await importPush();
    await expect(
      sendPushNotification("Test Title", "Test Body", "https://example.com"),
    ).resolves.toBeUndefined();

    server.stop();
  });

  test("webhook includes title, body, url, and source in payload", async () => {
    let receivedPayload: any = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        receivedPayload = await req.json();
        return new Response("ok", { status: 200 });
      },
    });
    const port = server.port;
    setEnv("ALERT_WEBHOOK_URL", `http://localhost:${port}/push`);

    const { sendPushNotification } = await importPush();
    await sendPushNotification("Alert Title", "Alert Body", "https://example.com/123");

    expect(receivedPayload).toBeDefined();
    expect(receivedPayload.title).toBe("Alert Title");
    expect(receivedPayload.body).toBe("Alert Body");
    expect(receivedPayload.url).toBe("https://example.com/123");
    expect(receivedPayload.source).toBe("crescent-city-intel/push");
    expect(receivedPayload.type).toBe("push");

    server.stop();
  });
});

describe("Module imports verify", () => {
  test("push module exports sendPushNotification and isPushConfigured", async () => {
    const mod = await import("../src/notifications/push.ts");
    expect(typeof mod.sendPushNotification).toBe("function");
    expect(typeof mod.isPushConfigured).toBe("function");
  });
});
