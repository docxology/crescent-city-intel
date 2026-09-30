import type { ChatMessage } from "../types.js";
import { llmConfig } from "./config.js";
import { chat as ollamaChat, isOllamaRunning } from "./ollama.js";
import { chat as openrouterChat, checkOpenRouterHealth, isOpenRouterConfigured } from "./openrouter.js";
import { boundedSignal, generationGate } from "./runtime.js";

export type ChatProvider = "ollama" | "openrouter";

export interface ChatRequestOptions {
  signal?: AbortSignal;
  /** Override the default municipal-code system prompt for other bounded tasks. */
  systemPrompt?: string;
}

export function configuredChatProvider(): ChatProvider {
  return llmConfig.provider;
}

export function configuredChatModel(modelOverride?: string): string {
  return modelOverride ?? (llmConfig.provider === "openrouter" ? llmConfig.openrouterModel : llmConfig.chatModel);
}

export type FallbackOutcome = "primary" | "secondary" | "deterministic";

export interface ProviderFallbackResult {
  answer: string;
  outcome: FallbackOutcome;
  providerUsed: ChatProvider | "none";
  model: string;
  errors: string[];
  attempts: ChatProvider[];
}

/** Deterministic source-grounded extraction used when every provider is down. */
export function deterministicExtract(question: string, context?: string): string {
  const trimmedContext = (context ?? "").trim();
  const questionSentences = question
    .split(/[.?!\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 8);
  if (!trimmedContext) {
    return "No provider is available and no retrieved context was supplied; unable to answer deterministically. Question retained for retry: "
      + question.slice(0, 300);
  }
  // Grounded heuristic: return the most question-relevant sentences from the
  // provided context only — never synthesized content.
  const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "have", "has", "any", "what", "when", "where", "which", "does", "shall", "city"]);
  const keywords = new Set(
    question.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !STOP.has(w)),
  );
  const scored = trimmedContext
    .split(/(?<=[.!?])\s+/)
    .map(sentence => {
      const words = sentence.toLowerCase().split(/[^a-z0-9]+/);
      const hits = words.filter(w => keywords.has(w)).length;
      return { sentence: sentence.trim(), hits };
    })
    .filter(entry => entry.sentence.length > 20)
    .sort((a, b) => b.hits - a.hits || a.sentence.localeCompare(b.sentence))
    .slice(0, 3)
    .filter(entry => entry.hits > 0);
  const excerpt = scored.length > 0
    ? scored.map(entry => entry.sentence).join(" ")
    : trimmedContext.split(/\s+/).slice(0, 120).join(" ");
  return `[Provider unavailable — deterministic source extract]\n${excerpt}`.slice(0, 1200)
    + (questionSentences.length > 0 ? `\n[Re: ${questionSentences[0].slice(0, 200)}]` : "");
}

function primaryChain(): Array<{ provider: ChatProvider; chat: typeof ollamaChat }> {
  return llmConfig.provider === "openrouter"
    ? [
        { provider: "openrouter" as const, chat: openrouterChat },
        { provider: "ollama" as const, chat: ollamaChat },
      ]
    : [{ provider: "ollama" as const, chat: ollamaChat }];
}

/**
 * Chat with automatic fallback: configured provider first, then the other
 * provider when reachable, then a deterministic grounded extraction so every
 * call yields an answer. Each attempt is preflighted so a dead endpoint never
 * burns its full request timeout.
 */
export async function chatWithProviderFallback(
  messages: ChatMessage[],
  context?: string,
  modelOverride?: string,
  options?: ChatRequestOptions,
): Promise<ProviderFallbackResult> {
  const errors: string[] = [];
  const attempts: ChatProvider[] = [];
  const signal = boundedSignal(options?.signal, 120_000);
  for (const [index, step] of primaryChain().entries()) {
    try {
      signal.throwIfAborted();
      attempts.push(step.provider);
      const health = await checkChatProviderFor(step.provider, signal);
      if (!health.configured || !health.reachable) {
        errors.push(`${step.provider}: unavailable`);
        continue;
      }
      const model = modelOverride ?? health.model;
      const release = await generationGate.acquire(signal);
      let answer: string;
      try { answer = await step.chat(messages, context, model, { ...options, signal }); } finally { release(); }
      if (!answer.trim()) throw new Error("empty response");
      return { answer, outcome: index === 0 ? "primary" : "secondary", providerUsed: step.provider, model, errors, attempts };
    } catch (error) {
      signal.throwIfAborted();
      errors.push(`${step.provider}: unavailable`);
    }
  }
  return {
    answer: deterministicExtract(messages.filter(m => m.role === "user").map(m => m.content).join("\n"), context),
    outcome: "deterministic",
    providerUsed: "none",
    model: "deterministic-extract",
    errors,
    attempts,
  };
}

async function checkChatProviderFor(provider: ChatProvider, signal?: AbortSignal): Promise<ProviderHealth> {
  if (provider === "openrouter") {
    if (!isOpenRouterConfigured()) {
      return { provider, configured: false, reachable: false, model: llmConfig.openrouterModel, error: "OPENROUTER_API_KEY is not set" };
    }
    const health = await checkOpenRouterHealth({ signal });
    return { provider, configured: true, reachable: health.reachable, model: llmConfig.openrouterModel, ...(health.error ? { error: health.error } : {}) };
  }
  const reachable = await isOllamaRunning(llmConfig.providerPreflightTimeoutMs, signal);
  return { provider, configured: true, reachable, model: llmConfig.chatModel, ...(reachable ? {} : { error: `Ollama is not reachable at ${llmConfig.ollamaUrl}` }) };
}

/** Route chat and summarization through the provider selected by LLM_PROVIDER. */
export async function chatWithProvider(
  messages: ChatMessage[],
  context?: string,
  modelOverride?: string,
  options?: ChatRequestOptions,
): Promise<string> {
  const signal = boundedSignal(options?.signal, 120_000);
  const release = await generationGate.acquire(signal);
  try { return await (llmConfig.provider === "openrouter" ? openrouterChat : ollamaChat)(messages, context, modelOverride, { ...options, signal }); }
  finally { release(); }
}

export interface ProviderHealth {
  provider: ChatProvider;
  configured: boolean;
  reachable: boolean;
  model: string;
  error?: string;
}

/** Check only the selected chat provider. Embedding/Chroma checks are separate. */
export async function checkChatProvider(options: { signal?: AbortSignal } = {}): Promise<ProviderHealth> {
  return checkChatProviderFor(llmConfig.provider, options.signal);
}
