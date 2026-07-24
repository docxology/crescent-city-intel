/** OpenRouter API wrapper for chat */
import type { ChatMessage } from "../types.js";
import { llmConfig } from "./config.js";
import { createLogger } from "../logger.js";

const log = createLogger("openrouter");

type OpenRouterRequestOptions = {
  baseUrl?: string;
  apiKey?: string;
};

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
    throw new Error("OPENROUTER_API_KEY is not set. Set it in your environment to use the OpenRouter provider, e.g. export OPENROUTER_API_KEY=sk-or-...");
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
  const nextRequestCount = openRouterRequestCount + 1;
  if (nextRequestCount > llmConfig.openrouterMaxRequestsPerRun) {
    throw new Error(
      `OpenRouter request cap exceeded (${llmConfig.openrouterMaxRequestsPerRun} per run). Raise OPENROUTER_MAX_REQUESTS to allow more requests.`
    );
  }

  openRouterRequestCount = nextRequestCount;
}

/** Chat with the model, optionally injecting context into the system prompt */
export async function chat(
  messages: ChatMessage[],
  context?: string,
  modelOverride?: string,
  options?: OpenRouterRequestOptions
): Promise<string> {
  const apiKey = resolveApiKey(options?.apiKey);
  incrementRequestCount();

  const model = modelOverride ?? llmConfig.openrouterModel;
  const systemPrompt =
    "You are a helpful assistant that answers questions about the Crescent City Municipal Code. " +
    "Use only the provided context to answer. Cite section numbers when possible. " +
    "If the context doesn't contain enough information, say so.";

  const fullMessages: ChatMessage[] = [
    {
      role: "system",
      content: context
        ? `${systemPrompt}\n\nContext from the municipal code:\n${context}`
        : systemPrompt,
    },
    ...messages,
  ];

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
    signal: AbortSignal.timeout(llmConfig.openrouterTimeoutMs),
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

/** Reset the OpenRouter request counter */
export function resetOpenRouterRequestCount(): void {
  openRouterRequestCount = 0;
}

/** Get the OpenRouter request counter */
export function getOpenRouterRequestCount(): number {
  return openRouterRequestCount;
}
