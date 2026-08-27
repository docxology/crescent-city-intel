/** Per-request token-usage accounting across LLM providers. */
export type UsageProvider = "ollama" | "openrouter";

export interface UsageRecord {
  provider: UsageProvider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** True when tokens were estimated from character counts (provider gave no counts). */
  estimated: boolean;
  at: string;
}

export interface ProviderUsageSummary {
  provider: UsageProvider;
  models: string[];
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmUsageSummary {
  schemaVersion: "1.0.0";
  generatedAt: string;
  totals: { requests: number; promptTokens: number; completionTokens: number; totalTokens: number };
  providers: ProviderUsageSummary[];
  lastRecordAt: string | null;
}

/** Rough token estimate (~4 chars/token) used when a provider omits usage counts. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

const MAX_RECORDS = 5000;
const records: UsageRecord[] = [];
let lastRecordAt: string | null = null;

/** Record one completed request. Non-finite/negative inputs are clamped to zero. */
export function recordLlmUsage(
  provider: UsageProvider,
  model: string,
  promptTokens: number,
  completionTokens: number,
  estimated = false,
): void {
  const safePrompt = Number.isFinite(promptTokens) && promptTokens > 0 ? Math.round(promptTokens) : 0;
  const safeCompletion = Number.isFinite(completionTokens) && completionTokens > 0 ? Math.round(completionTokens) : 0;
  const rec: UsageRecord = {
    provider,
    model,
    promptTokens: safePrompt,
    completionTokens: safeCompletion,
    estimated,
    at: new Date().toISOString(),
  };
  records[records.length] = rec;
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  lastRecordAt = rec.at;
}

/** Read-only copy of recent records (bounded window). */
export function getUsageRecords(): UsageRecord[] {
  return [...records];
}

/** Aggregate per-provider/per-model token usage over the retained window. */
export function getLlmUsageSummary(): LlmUsageSummary {
  const byKey = new Map<string, UsageRecord[]>();
  for (const rec of records) {
    const key = `${rec.provider}\u0000${rec.model}`;
    const list = byKey.get(key) ?? [];
    list[list.length] = rec;
    byKey.set(key, list);
  }
  const providers: ProviderUsageSummary[] = [...byKey.entries()]
    .map(([key, list]) => {
      const [provider] = key.split("\u0000");
      const models = [...new Set(list.map(r => r.model))].sort();
      const promptTokens = list.reduce((sum, r) => sum + r.promptTokens, 0);
      const completionTokens = list.reduce((sum, r) => sum + r.completionTokens, 0);
      return {
        provider: provider as UsageProvider,
        models,
        requests: list.length,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);
  const promptTokens = providers.reduce((s, p) => s + p.promptTokens, 0);
  const completionTokens = providers.reduce((s, p) => s + p.completionTokens, 0);
  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    totals: {
      requests: records.length,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
    providers,
    lastRecordAt,
  };
}

/** Clear recorded usage (used between batch runs and by tests). */
export function resetLlmUsage(): void {
  records.length = 0;
  lastRecordAt = null;
}
