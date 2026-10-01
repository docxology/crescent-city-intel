/** Transition notifications: acknowledge only accepted HTTP; failures remain retryable. */
import { readFile } from "fs/promises";
import { join } from "path";
import { createLogger } from "../logger.js";
import { outputRoot } from "../shared/paths.js";
import { writeJsonAtomic } from "../shared/source_health.js";
import { withFileLease } from "../shared/storage.js";
import { computeSha256 } from "../utils.js";
import { boundedHttpFetch, waitWithSignal, currentTransportSignal, withTransportScope } from "../shared/transport.js";
const log = createLogger("alert-webhook");
export function webhookUrl(): string { return (process.env.ALERT_WEBHOOK_URL ?? "").trim(); }
export function isWebhookConfigured(): boolean { return webhookUrl().length > 0; }
export function webhookTimeoutMs(): number {
  const value = Number((process.env.ALERT_WEBHOOK_TIMEOUT_MS ?? "").trim());
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 30_000) : 5000;
}
export interface WebhookResult { ok: boolean; status: number }
export async function sendWebhook(url: string, payload: unknown, timeoutMs = 5000): Promise<WebhookResult> {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("Invalid webhook destination");
  const body = JSON.stringify(payload);
  if (body.length > 16_000) throw new Error("Webhook payload exceeds its limit");
  const response = await boundedHttpFetch(target.toString(), { method: "POST", maxRedirects: 0, maxBytes: 64_000, headers: { "Content-Type": "application/json" }, body, timeoutMs: Math.max(1, Math.min(30_000, timeoutMs)) });
  await response.body?.cancel();
  return { ok: response.ok, status: response.status };
}
/** Never throws; a failed POST never consumes the transition's dedupe receipt. */
export async function maybeSendSeverityWebhook(report: { level?: string; reason?: string; assessedAt?: string }, fixture?: { origin: string }): Promise<void> {
  const url = webhookUrl(); if (!url) return;
  if (fixture) return withTransportScope({ fixture: { origin: fixture.origin, allowedOrigins: [new URL(url).origin] } }, () => maybeSendSeverityWebhook(report));
  try {
    const statePath = join(outputRoot(), "state", "alert-webhook-level.json");
    await withFileLease(`${statePath}.lock`, async () => {
      const level = ["WARNING", "EMERGENCY"].includes(report.level ?? "") ? report.level! : null;
      const destination = await computeSha256(url);
      let previous: { level?: string | null; destination?: string } = {};
      try { previous = JSON.parse(await readFile(statePath, "utf8")); } catch { /* no accepted receipt */ }
      if (level === null) { await writeJsonAtomic(statePath, { level: null, destination, recordedAt: new Date().toISOString() }); return; }
      if (previous.level === level && previous.destination === destination) return;
      const payload = { severity: level, reason: (report.reason ?? "").slice(0, 2000), assessedAt: report.assessedAt ?? new Date().toISOString(), source: "crescent-city-intel/alerts" };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await sendWebhook(url, payload, webhookTimeoutMs());
          if (result.ok) {
            await writeJsonAtomic(statePath, { level, destination, recordedAt: new Date().toISOString(), acceptedStatus: result.status });
            log.info("Severity webhook accepted", { status: String(result.status), severity: level }); return;
          }
          if (result.status < 500 && result.status !== 429) break;
        } catch { /* bounded transport failure remains retryable */ }
        if (attempt < 2) await waitWithSignal(100 * (2 ** attempt), currentTransportSignal() ?? new AbortController().signal);
      }
      log.warn("Severity webhook not accepted; transition retained for retry");
    }, { waitMs: 1000, signal: currentTransportSignal() });
  } catch { log.warn("Severity webhook could not be completed; retry remains eligible"); }
}
