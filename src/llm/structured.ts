/** Structured-output support: strict JSON requests, parse validation, repair retry. */
import type { ChatMessage } from "../types.js";
import { createLogger } from "../logger.js";
import { chatWithProvider } from "./provider.js";

const log = createLogger("structured");

export interface StructuredOptions {
  /** Free-text schema hint appended to the prompt (e.g. expected keys and types). */
  schemaHint: string;
  systemPrompt?: string;
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  value: T | null;
  /** "json" — provider output parsed after <=1 repair retry; "deterministic" — extractor fallback. */
  source: "json" | "deterministic" | "unavailable";
  error?: string;
}

/** Extract the outermost JSON object or array from arbitrary model text. */
export function extractJsonCandidate(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : text;
  for (const [startChar, endChar] of [["{", "}"], ["[", "]"]] as const) {
    const start = source.indexOf(startChar);
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === startChar) depth++;
      else if (ch === endChar) {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Query the configured provider for strict JSON matching schemaHint.
 * One repair retry on malformed output; null when nothing parseable is
 * produced (caller decides on a deterministic fallback).
 */
export async function queryStructured<T>(
  prompt: string,
  options: StructuredOptions,
  validate?: (value: unknown) => value is T,
): Promise<StructuredResult<T>> {
  const baseMessages: ChatMessage[] = [{ role: "user", content: `${prompt}\n\nReturn ONLY valid JSON matching this shape: ${options.schemaHint}. No prose, no markdown fences.` }];
  const attempt = async (messages: ChatMessage[]): Promise<T | null> => {
    try {
      const raw = await chatWithProvider(messages, undefined, undefined, { signal: options.signal, systemPrompt: options.systemPrompt });
      const candidate = extractJsonCandidate(raw);
      if (!candidate) return null;
      const parsed: unknown = JSON.parse(candidate);
      if (validate && !validate(parsed)) return null;
      return parsed as T;
    } catch {
      return null;
    }
  };

  const first = await attempt(baseMessages);
  if (first !== null) return { value: first, source: "json" };

  log.warn("Structured query returned malformed JSON; issuing one repair request");
  const repaired = await attempt([
    ...baseMessages,
    { role: "assistant", content: "(malformed output)" },
    { role: "user", content: `That was not valid JSON for schema: ${options.schemaHint}. Reply again with ONLY corrected valid JSON.` },
  ]);
  if (repaired !== null) return { value: repaired, source: "json" };
  return { value: null, source: "unavailable", error: "Model did not produce schema-valid JSON after one repair retry" };
}
