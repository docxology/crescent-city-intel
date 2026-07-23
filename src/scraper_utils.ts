/**
 * Scraper robustness utilities.
 *
 * - Cloudflare stall detection
 * - Network error retry with exponential backoff
 * - HTTP 503/redirect detection
 * - Progress bar for terminal output
 * - Per-article timing metrics
 */

export interface ScrapeMetrics {
  guid: string;
  title: string;
  durationMs: number;
  sectionCount: number;
  success: boolean;
  error?: string;
  retried?: boolean;
}

export interface ScrapeProgress {
  total: number;
  scraped: number;
  skipped: number;
  failed: number;
  current: string;
  startTime: number;
}

/** Detect if Cloudflare Turnstile challenge is stuck */
export function detectCloudflareStall(startTime: number, maxWaitMs: number = 10_000): boolean {
  return Date.now() - startTime > maxWaitMs;
}

/** Retry wrapper with exponential backoff */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 2000,
): Promise<{ result: T; retried: boolean; attempts: number }> {
  let lastError: Error | null = null;
  let attempts = 0;

  for (let i = 0; i <= maxRetries; i++) {
    attempts = i + 1;
    try {
      const result = await fn();
      return { result, retried: i > 0, attempts };
    } catch (err: any) {
      lastError = err;
      if (i < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, i);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError!;
}

/** Check for HTTP 503 maintenance mode or redirect */
export function isMaintenanceMode(status: number, url: string, finalUrl: string): boolean {
  return status === 503 || (status >= 300 && status < 400 && finalUrl !== url);
}

/** Format a progress bar string */
export function formatProgressBar(current: number, total: number, width: number = 30): string {
  const pct = total > 0 ? current / total : 0;
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pctStr = (pct * 100).toFixed(0).padStart(3, " ");
  return `[${bar}] ${pctStr}% (${current}/${total})`;
}

/** Record per-article scrape timing */
export class ScrapeMetricsCollector {
  private metrics: ScrapeMetrics[] = [];

  record(metric: ScrapeMetrics): void {
    this.metrics.push(metric);
  }

  getMetrics(): ScrapeMetrics[] {
    return [...this.metrics];
  }

  getSummary(): {
    total: number;
    succeeded: number;
    failed: number;
    avgDurationMs: number;
    maxDurationMs: number;
    minDurationMs: number;
  } {
    const succeeded = this.metrics.filter(m => m.success);
    const durations = succeeded.map(m => m.durationMs);
    return {
      total: this.metrics.length,
      succeeded: succeeded.length,
      failed: this.metrics.filter(m => !m.success).length,
      avgDurationMs: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      maxDurationMs: durations.length > 0 ? Math.max(...durations) : 0,
      minDurationMs: durations.length > 0 ? Math.min(...durations) : 0,
    };
  }

  toJSON(): ScrapeMetrics[] {
    return this.metrics;
  }
}
