/** OpenRouter API wrapper for chat */
import type { ChatMessage } from "../types.js";
import { llmConfig } from "./config.js";
import { createLogger } from "../logger.js";
import type { ChatRequestOptions } from "./provider.js";

const log = createLogger("openrouter");

type OpenRouterRequestOptions = {
  baseUrl?: string;
  apiKey?: string;
  signal?: AbortSignal;
  systemPrompt?: string;
};

export interface OpenRouterHealthCheck {
  reachable: boolean;
  error?: string;
}

type OpenRouterChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type OpenRouterChatResponseWithContent = {
  choices: [{
    message: {
      content: string;
    };
  }, ...Array<{
    message?: {
      content?: string;
    };
  }>];
};

type OpenRouterModelsResponse = {
  data?: Array<{
    id?: string;
  }>;
};

type OpenRouterModelsResponseWithIds = {
  data: Array<{
    id: string;
  }>;
};

let openRouterRequestCount = 0;

function formatResponseSnippet(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return String(value).slice(0, 200);
  }
}

function resolveApiKey(apiKeyOverride?: string): string {
  const apiKey = apiKeyOverride ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error("OPENROUTER_API_KEY is not set. Set it in your environment to use the OpenRouter provider.");
  }
  return apiKey;
}

function isOpenRouterChatResponse(value: unknown): value is OpenRouterChatResponseWithContent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return false;
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    return false;
  }

  const message = (firstChoice as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    return false;
  }

  return typeof (message as { content?: unknown }).content === "string";
}

function isOpenRouterModelsResponse(value: unknown): value is OpenRouterModelsResponseWithIds {
  if (!value || typeof value !== "object") {
    return false;
  }

  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return false;
  }

  return data.every((model) => {
    if (!model || typeof model !== "object") {
      return false;
    }

    return typeof (model as { id?: unknown }).id === "string";
  });
}

function incrementRequestCount(): void {
  const next = openRouterRequestCount + 1;
  if (next > llmConfig.openrouterMaxRequestsPerRun) {
    throw new Error(
      `OpenRouter request cap exceeded (${llmConfig.openrouterMaxRequestsPerRun} per run). Raise OPENROUTER_MAX_REQUESTS to allow more requests.`
    );
  }
  openRouterRequestCount = next;
}

function buildMessages(messages: ChatMessage[], context?: string, systemPromptOverride?: string): ChatMessage[] {
  const systemPrompt = systemPromptOverride ??
    "You are a helpful assistant that answers questions about the Crescent City Municipal Code. " +
    "Use only the provided context to answer. Cite section numbers when possible. " +
    "If the context doesn't contain enough information, say so.";
  return [
    {
      role: "system",
      content: context
        ? `${systemPrompt}\n\nContext from the municipal code:\n${context}`
        : systemPrompt,
    },
    ...messages,
  ];
}

/** Chat with the model, optionally injecting context into the system prompt */
export async function chat(
  messages: ChatMessage[],
  context?: string,
  modelOverride?: string,
  options?: OpenRouterRequestOptions & ChatRequestOptions,
): Promise<string> {
  const apiKey = resolveApiKey(options?.apiKey);
  incrementRequestCount();

  const model = modelOverride ?? llmConfig.openrouterModel;
  const fullMessages = buildMessages(messages, context, options?.systemPrompt);

  const base = options?.baseUrl ?? llmConfig.openrouterUrl;
  log.debug(`Chat request to ${model}`, { messageCount: String(fullMessages.length) });

  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model,
      messages: fullMessages,
      max_tokens: llmConfig.openrouterMaxTokens,
    }),
    signal: options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(llmConfig.openrouterTimeoutMs)])
      : AbortSignal.timeout(llmConfig.openrouterTimeoutMs),
  });

  if (!resp.ok) {
    throw new Error(`OpenRouter chat failed (${resp.status}): ${await resp.text()}`);
  }

  const data = await resp.json() as OpenRouterChatResponse;
  if (!isOpenRouterChatResponse(data)) {
    throw new Error(`OpenRouter returned an unexpected response shape: ${formatResponseSnippet(data)}`);
  }

  return data.choices[0].message.content;
}

/** Stream OpenRouter SSE deltas for the provider-aware RAG endpoint. */
export async function* streamChat(
  messages: ChatMessage[],
  context?: string,
  modelOverride?: string,
  options?: OpenRouterRequestOptions,
): AsyncGenerator<string> {
  const apiKey = resolveApiKey(options?.apiKey);
  incrementRequestCount();
  const model = modelOverride ?? llmConfig.openrouterModel;
  const base = options?.baseUrl ?? llmConfig.openrouterUrl;
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: buildMessages(messages, context),
      max_tokens: llmConfig.openrouterMaxTokens,
      stream: true,
    }),
    signal: options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(llmConfig.openrouterTimeoutMs)])
      : AbortSignal.timeout(llmConfig.openrouterTimeoutMs),
  });

  if (!response.ok || !response.body) {
    throw new Error(`OpenRouter streaming request failed (${response.status}): ${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const payload = line.trim();
      if (!payload.startsWith("data:")) continue;
      const data = payload.slice(5).trim();
      if (data === "[DONE]") return;
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch (error) {
        log.warn("Skipping malformed OpenRouter stream chunk", { error: String(error) });
        continue;
      }
      if (parsed.error?.message) throw new Error(`OpenRouter stream error: ${parsed.error.message}`);
      const token = parsed.choices?.[0]?.delta?.content;
      if (typeof token === "string" && token.length > 0) yield token;
    }
  }
}

/** List available models from OpenRouter */
export async function listModels(): Promise<string[]> {
  const apiKey = resolveApiKey();
  const resp = await fetch(`${llmConfig.openrouterUrl}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(llmConfig.openrouterTimeoutMs),
  });

  if (!resp.ok) {
    throw new Error(`OpenRouter listModels failed (${resp.status}): ${await resp.text()}`);
  }

  const data = await resp.json() as OpenRouterModelsResponse;
  if (!isOpenRouterModelsResponse(data)) {
    throw new Error(`OpenRouter returned an unexpected response shape: ${formatResponseSnippet(data)}`);
  }

  return data.data.map((model) => model.id);
}

/** Check if OpenRouter has been configured */
export function isOpenRouterConfigured(): boolean {
  return typeof process.env.OPENROUTER_API_KEY === "string" && process.env.OPENROUTER_API_KEY.trim().length > 0;
}

/**
 * Perform a bounded, non-generative OpenRouter preflight. `/models` verifies
 * the configured URL, credentials, and response shape without consuming a
 * chat completion or the per-run generation request cap.
 */
export async function checkOpenRouterHealth(options: OpenRouterRequestOptions = {}): Promise<OpenRouterHealthCheck> {
  try {
    const apiKey = resolveApiKey(options.apiKey);
    const base = options.baseUrl ?? llmConfig.openrouterUrl;
    const response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(llmConfig.providerPreflightTimeoutMs)])
        : AbortSignal.timeout(llmConfig.providerPreflightTimeoutMs),
    });
    if (!response.ok) {
      return { reachable: false, error: `OpenRouter preflight failed (${response.status}): ${(await response.text()).slice(0, 300)}` };
    }
    const data = await response.json() as OpenRouterModelsResponse;
    if (!isOpenRouterModelsResponse(data)) {
      return { reachable: false, error: "OpenRouter preflight returned an unexpected /models response shape" };
    }
    return { reachable: true };
  } catch (error: unknown) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Reset the OpenRouter request counter */
export function resetOpenRouterRequestCount(): void {
  openRouterRequestCount = 0;
}

/** Get the OpenRouter request counter */
export function getOpenRouterRequestCount(): number {
  return openRouterRequestCount;
}
