import type { ChatMessage } from "../types.js";
import { llmConfig } from "./config.js";
import { chat as ollamaChat, isOllamaRunning } from "./ollama.js";
import { chat as openrouterChat, checkOpenRouterHealth, isOpenRouterConfigured } from "./openrouter.js";

export type ChatProvider = "ollama" | "openrouter";

export function configuredChatProvider(): ChatProvider {
  return llmConfig.provider;
}

export function configuredChatModel(modelOverride?: string): string {
  return modelOverride ?? (llmConfig.provider === "openrouter" ? llmConfig.openrouterModel : llmConfig.chatModel);
}

/** Route chat and summarization through the provider selected by LLM_PROVIDER. */
export async function chatWithProvider(
  messages: ChatMessage[],
  context?: string,
  modelOverride?: string,
): Promise<string> {
  if (llmConfig.provider === "openrouter") {
    return openrouterChat(messages, context, modelOverride);
  }
  return ollamaChat(messages, context, modelOverride);
}

export interface ProviderHealth {
  provider: ChatProvider;
  configured: boolean;
  reachable: boolean;
  model: string;
  error?: string;
}

/** Check only the selected chat provider. Embedding/Chroma checks are separate. */
export async function checkChatProvider(): Promise<ProviderHealth> {
  if (llmConfig.provider === "openrouter") {
    if (!isOpenRouterConfigured()) {
      return { provider: "openrouter", configured: false, reachable: false, model: llmConfig.openrouterModel, error: "OPENROUTER_API_KEY is not set" };
    }
    const health = await checkOpenRouterHealth();
    return {
      provider: "openrouter",
      configured: true,
      reachable: health.reachable,
      model: llmConfig.openrouterModel,
      ...(health.error ? { error: health.error } : {}),
    };
  }

  const reachable = await isOllamaRunning(llmConfig.providerPreflightTimeoutMs);
  return {
    provider: "ollama",
    configured: true,
    reachable,
    model: llmConfig.chatModel,
    ...(reachable ? {} : { error: `Ollama is not reachable at ${llmConfig.ollamaUrl}` }),
  };
}
