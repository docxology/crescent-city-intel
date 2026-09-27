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
import { mkdir, readFile } from "fs/promises";
import { dirname, join } from "path";
import { createLogger } from "../logger.js";
import { outputRoot } from "../shared/paths.js";
import { writeJsonAtomic } from "../shared/source_health.js";

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
 *
 * Fires on a tier TRANSITION, not on every run at that tier. The notifier was
 * purely level-triggered with no memory, so a persistently-WARNING composite —
 * which a multi-year drought or a chronic air-quality band produces on its own
 * — POSTed on every single run forever. A notifier that is always firing is not
 * an alert; it is noise that trains the operator to ignore the endpoint. The
 * last-sent level is persisted under `output/state/`, and a repeat at the same
 * tier (or a drop) does not re-notify. A transition in either direction is
 * recorded, so a WARNING -> EMERGENCY escalation still fires.
 */
export async function maybeSendSeverityWebhook(report: { level?: string; reason?: string; assessedAt?: string }): Promise<void> {
  const url = webhookUrl();
  if (!url) return;
  const level = report.level ?? "";
  const next = level === "EMERGENCY" ? "EMERGENCY" : level === "WARNING" ? "WARNING" : null;
  if (next === null) {
    // Below the notify threshold: clear the memory so a later rise to WARNING
    // is correctly seen as a fresh transition.
    await recordNotifiedLevel(null);
    return;
  }
  if (await recordNotifiedLevel(next) === false) {
    log.info(`Webhook suppressed: already notified at ${next} and the level has not changed`);
    return;
  }
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

/** The severity levels that are worth notifying on, weakest first. */
const NOTIFY_LEVELS = ["WARNING", "EMERGENCY"] as const;

/** Where the last-notified level is remembered, via the shared output seam. */
function lastNotifiedPath(): string {
  return join(outputRoot(), "state", "alert-webhook-level.json");
}

/**
 * Record `level` as the last-notified tier, returning whether it is a CHANGE.
 *
 * Returns true when a notification should be sent (the level differs from the
 * remembered one), false when this is a repeat. Any read/parse failure is
 * treated as "no memory" and notifies — a persistence problem must not silence
 * a real escalation.
 */
async function recordNotifiedLevel(level: string | null): Promise<boolean> {
  let previous: string | null = null;
  try {
    const previousText = await readFile(lastNotifiedPath(), "utf-8");
    const parsed = JSON.parse(previousText) as { level?: unknown };
    if (typeof parsed.level === "string" && NOTIFY_LEVELS.includes(parsed.level as never)) {
      previous = parsed.level;
    }
  } catch {
    // No memory yet, or unreadable: treat as first notification.
  }
  if (previous === level) return false;
  try {
    await mkdir(dirname(lastNotifiedPath()), { recursive: true });
    await writeJsonAtomic(lastNotifiedPath(), { level, recordedAt: new Date().toISOString() });
  } catch (error) {
    log.warn("Could not persist the last-notified alert level", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
