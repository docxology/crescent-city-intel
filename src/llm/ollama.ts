/** Ollama API wrapper for embeddings and chat */
import type { ChatMessage } from "../types.js";
import { llmConfig } from "./config.js";
import { OLLAMA_TIMEOUT_MS } from "../constants.js";
import { createLogger } from "../logger.js";
import type { ChatRequestOptions } from "./provider.js";

const log = createLogger("ollama");

const BASE = () => llmConfig.ollamaUrl;

/** Generate an embedding for a single text */
export async function embed(text: string): Promise<number[]> {
  const resp = await fetch(`${BASE()}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: llmConfig.embeddingModel,
      input: text,
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new Error(`Ollama embed failed (${resp.status}): ${await resp.text()}`);
  }

  const data = await resp.json() as { embeddings: number[][] };
  return data.embeddings[0];
}

/** Generate embeddings for a batch of texts */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const resp = await fetch(`${BASE()}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: llmConfig.embeddingModel,
      input: texts,
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new Error(`Ollama embedBatch failed (${resp.status}): ${await resp.text()}`);
  }

  const data = await resp.json() as { embeddings: number[][] };
  return data.embeddings;
}

/** Chat with the model, optionally injecting context into the system prompt */
export async function chat(
  messages: ChatMessage[],
  context?: string,
  modelOverride?: string,
  options?: ChatRequestOptions,
): Promise<string> {
  const model = modelOverride ?? llmConfig.chatModel;
  const systemPrompt = options?.systemPrompt ??
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

  log.debug(`Chat request to ${model}`, { messageCount: String(fullMessages.length) });
  const resp = await fetch(`${BASE()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model,
      messages: fullMessages,
      stream: false,
    }),
    signal: options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(OLLAMA_TIMEOUT_MS * 4)])
      : AbortSignal.timeout(OLLAMA_TIMEOUT_MS * 4), // Chat can take longer
  });

  if (!resp.ok) {
    throw new Error(`Ollama chat failed (${resp.status}): ${await resp.text()}`);
  }

  const data = await resp.json() as { message: { content: string } };
  return data.message.content;
}

/** List available models from Ollama */
export async function listModels(): Promise<string[]> {
  const resp = await fetch(`${BASE()}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
  if (!resp.ok) {
    throw new Error(`Ollama listModels failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json() as { models?: { name?: string }[] };
  return (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
}

/** Check if Ollama is reachable */
export async function isOllamaRunning(timeoutMs = OLLAMA_TIMEOUT_MS): Promise<boolean> {
  try {
    const resp = await fetch(`${BASE()}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    return resp.ok;
  } catch {
    return false;
  }
}
