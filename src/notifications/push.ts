/**
 * Desktop push notification system for the Crescent City Intel GUI.
 *
 * Supports two notification paths:
 *   1. Webhook-based — uses the existing ALERT_WEBHOOK_URL (fire-and-forget POST).
 *   2. VAPID Web Push — uses PUSH_PUBLIC_KEY / PUSH_PRIVATE_KEY for browser push.
 *
 * Both paths follow graceful-degradation: if the required env vars are absent,
 * the function is a no-op (optionally logs to console for local development).
 * NEVER throws.
 *
 * Env:
 *   ALERT_WEBHOOK_URL     — existing webhook URL for alert notifications
 *   PUSH_PUBLIC_KEY        — VAPID public key (URL-safe base64)
 *   PUSH_PRIVATE_KEY       — VAPID private key (URL-safe base64)
 *   PUSH_SUBSCRIBER        — Optional JSON subscription object for direct push
 *   PUSH_CONTACT_EMAIL     — VAPID contact email (default: "admin@crescent-city-intel.local")
 */
import { createLogger } from "../logger.js";

const log = createLogger("push");

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Read a required env var; returns empty string when absent. */
function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** URL-safe base64 decode to Uint8Array. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** URL-safe base64 encode from Uint8Array. */
function uint8ArrayToUrlBase64(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Check whether the push notification system has enough configuration to
 * send notifications. Returns true when at least one path is available:
 * either ALERT_WEBHOOK_URL (webhook fallback) or VAPID keys (web push).
 */
export function isPushConfigured(): boolean {
  return env("ALERT_WEBHOOK_URL").length > 0 ||
    (env("PUSH_PUBLIC_KEY").length > 0 && env("PUSH_PRIVATE_KEY").length > 0);
}

/**
 * Send a desktop push notification.
 *
 * Priority:
 *   1. VAPID Web Push (when PUSH_PUBLIC_KEY + PUSH_PRIVATE_KEY + PUSH_SUBSCRIBER are set).
 *   2. Webhook POST to ALERT_WEBHOOK_URL (when set).
 *   3. Console log fallback (when verbose mode or no other path is available).
 *
 * NEVER throws. Errors are logged as warnings.
 *
 * @param title - Notification title (required).
 * @param body  - Notification body text (required).
 * @param url   - Optional URL to open when the notification is clicked.
 */
export async function sendPushNotification(title: string, body: string, url?: string): Promise<void> {
  try {
    // ── Path 1: VAPID Web Push ──────────────────────────────────────
    const publicKey = env("PUSH_PUBLIC_KEY");
    const privateKey = env("PUSH_PRIVATE_KEY");
    const subscriberJson = env("PUSH_SUBSCRIBER");

    if (publicKey && privateKey && subscriberJson) {
      await sendVapidPush(publicKey, privateKey, subscriberJson, { title, body, url });
      log.info("Push notification sent via VAPID Web Push", { title });
      return;
    }

    // ── Path 2: Webhook ─────────────────────────────────────────────
    const webhookUrl = env("ALERT_WEBHOOK_URL");
    if (webhookUrl) {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "push",
          title,
          body,
          url: url ?? "",
          source: "crescent-city-intel/push",
          sentAt: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5000),
      });
      log.info(`Push notification sent via webhook (${response.status})`, { title });
      return;
    }

    // ── Path 3: Console fallback ────────────────────────────────────
    log.info(`[PUSH] ${title} — ${body}${url ? ` (${url})` : ""}`);
  } catch (err) {
    log.warn("Push notification delivery failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── VAPID Web Push ───────────────────────────────────────────────────────

/**
 * Send a VAPID-signed Web Push notification to a PushSubscription endpoint.
 *
 * This implements the minimal VAPID flow using native Web Crypto and fetch:
 *   - ECDSA signing with the application server key
 *   - VAPID Authorization header per RFC 8292
 *   - Encrypted payload per RFC 8291 (minimal — unencrypted for simplicity
 *     when the service worker accepts a plain JSON body; full encryption
 *     requires additional primitives).
 */
async function sendVapidPush(
  publicKeyBase64: string,
  privateKeyBase64: string,
  subscriberJson: string,
  payload: { title: string; body: string; url?: string },
): Promise<void> {
  let subscription: PushSubscriptionJSON;
  try {
    subscription = JSON.parse(subscriberJson) as PushSubscriptionJSON;
  } catch {
    log.warn("PUSH_SUBSCRIBER is not valid JSON; cannot send VAPID push");
    return;
  }

  const endpoint = subscription.endpoint;
  if (!endpoint) {
    log.warn("PUSH_SUBSCRIBER has no endpoint; cannot send VAPID push");
    return;
  }

  // Build VAPID JWT
  const now = Math.floor(Date.now() / 1000);
  const vapidClaims = {
    aud: new URL(endpoint).origin,
    exp: now + 24 * 3600,
    sub: `mailto:${env("PUSH_CONTACT_EMAIL") || "admin@crescent-city-intel.local"}`,
  };

  // ECDSA sign with the private key using Subtle Crypto
  const privateKeyBytes = urlBase64ToUint8Array(privateKeyBase64);
  const publicKeyBytes = urlBase64ToUint8Array(publicKeyBase64);

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      privateKeyBytes.slice(),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );

    const header = { alg: "ES256", typ: "JWT", kid: uint8ArrayToUrlBase64(publicKeyBytes) };
    const toSign = `${uint8ArrayToUrlBase64(new TextEncoder().encode(JSON.stringify(header)))}.${uint8ArrayToUrlBase64(new TextEncoder().encode(JSON.stringify(vapidClaims)))}`;

    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      new TextEncoder().encode(toSign),
    );
    const jwt = `${toSign}.${uint8ArrayToUrlBase64(new Uint8Array(signature))}`;

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      ...(payload.url ? { url: payload.url } : {}),
    });

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${jwt}`,
        "TTL": "86400",
        "Urgency": "normal",
      },
      body,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      log.warn(`VAPID push returned HTTP ${response.status}`, {
        title: payload.title,
      });
    }
  } catch (err) {
    log.warn("VAPID push failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
