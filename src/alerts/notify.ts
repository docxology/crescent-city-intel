/**
 * Config-driven webhook notifier for high-severity composite alerts.
 *
 * When `ALERT_WEBHOOK_URL` is set and the run-alerts composite reaches
 * WARNING or EMERGENCY, a short JSON POST is fired at that URL. This is
 * fire-and-forget by contract: a webhook failure must never break an alert
 * run, and the notifier never throws out of `maybeSendSeverityWebhook`.
 *
 * Env: ALERT_WEBHOOK_URL (optional), ALERT_WEBHOOK_TIMEOUT_MS (optional,
 * default 5000).
 */
import { createLogger } from "../logger.js";

const log = createLogger("alert-webhook");

/** The configured webhook URL (empty when disabled). Reads env at call time for testability. */
export function webhookUrl(): string {
  return (process.env.ALERT_WEBHOOK_URL ?? "").trim();
}

export function isWebhookConfigured(): boolean {
  return webhookUrl().length > 0;
}

/**
 * Bounded webhook POST timeout in ms (`ALERT_WEBHOOK_TIMEOUT_MS`, default
 * 5000). Reads env at call time; invalid/non-positive values fall back to 5000.
 */
export function webhookTimeoutMs(): number {
  const parsed = Number((process.env.ALERT_WEBHOOK_TIMEOUT_MS ?? "").trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 5000;
}

export interface WebhookResult {
  ok: boolean;
  status: number;
}

/** POST a JSON payload to the given URL with a bounded timeout. */
export async function sendWebhook(url: string, payload: unknown, timeoutMs = 5000): Promise<WebhookResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: response.ok, status: response.status };
}

/**
 * Fire a severity webhook when the composite alert reaches WARNING or EMERGENCY.
 * Never throws. No-op when ALERT_WEBHOOK_URL is unset or the level is CALM/WATCH.
 */
export async function maybeSendSeverityWebhook(report: { level?: string; reason?: string; assessedAt?: string }): Promise<void> {
  const url = webhookUrl();
  if (!url) return;
  const level = report.level ?? "";
  if (level !== "WARNING" && level !== "EMERGENCY") return;
  try {
    const payload = {
      severity: level,
      reason: report.reason ?? "",
      assessedAt: report.assessedAt ?? new Date().toISOString(),
      source: "crescent-city-intel/alerts",
    };
    const result = await sendWebhook(url, payload, webhookTimeoutMs());
    log.info(`Webhook delivered (${result.status}) for ${level}`);
  } catch (error) {
    // A webhook failure must never fail the alert run.
    log.warn("Webhook delivery failed (non-fatal)", { error: error instanceof Error ? error.message : String(error) });
  }
}
