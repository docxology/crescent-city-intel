/** Deadline-bound Chroma operations and manifest-selected serving collections. */
import { ChromaClient, ChromaClientError, ChromaUnauthorizedError, ChromaForbiddenError, ChromaNotFoundError, ChromaUniqueError, ChromaRateLimitError, ChromaServerError, type Collection } from "chromadb";
import { llmConfig } from "./config.js";
import { paths } from "../shared/paths.js";
import { readFile } from "fs/promises";
import { boundedSignal, vectorGate } from "./runtime.js";
import { withFileLease } from "../shared/storage.js";
import { join } from "path";

export interface VectorOptions { signal?: AbortSignal; collection?: string; timeoutMs?: number; maximumResponseBytes?: number }
export interface VectorDocuments { ids: string[]; embeddings: number[][]; documents: string[]; metadatas: Record<string, string>[] }
export const VECTOR_RESPONSE_BYTES = 16 * 1024 * 1024;

/** The SDK consumes JSON only after the entire native stream passes this boundary. */
function vectorFetch(signal: AbortSignal, maximumBytes: number): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    signal.throwIfAborted();
    const response = await fetch(input, { ...init, signal, redirect: "error" });
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) { await response.body?.cancel(); throw new Error("Vector response exceeded its byte limit"); }
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body?.getReader();
    const cancel = () => { void reader?.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (reader) while (true) {
        signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > maximumBytes) throw new Error("Vector response exceeded its byte limit");
        chunks.push(value);
      }
    } finally { signal.removeEventListener("abort", cancel); await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    signal.throwIfAborted();
    // Preserve SDK error classes without exposing response bodies or service URLs.
    if (!response.ok) {
      if (response.status === 401) throw new ChromaUnauthorizedError("Vector authentication failed");
      if (response.status === 403) throw new ChromaForbiddenError("Vector access denied");
      if (response.status === 404) throw new ChromaNotFoundError("Vector record not found");
      if (response.status === 409) throw new ChromaUniqueError("Vector record already exists");
      if (response.status === 429) throw new ChromaRateLimitError("Vector service is busy");
      if (response.status < 500) throw new ChromaClientError("Vector request rejected");
      throw new ChromaServerError("Vector service unavailable");
    }
    const body = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
    const headers = new Headers(response.headers); headers.delete("content-encoding"); headers.set("content-length", String(size));
    return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers });
  }) as typeof fetch;
}

export async function servingCollectionName(): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(paths.indexManifest, "utf8"));
    if (typeof manifest.servingCollection === "string" && /^[a-zA-Z0-9_-]{3,128}$/.test(manifest.servingCollection)) return manifest.servingCollection;
  } catch { /* prior non-staged index or no index yet */ }
  return llmConfig.collectionName;
}
function client(signal: AbortSignal, maximumBytes: number): ChromaClient {
  const endpoint = new URL(llmConfig.chromaUrl);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("Invalid vector service URL");
  const result = new ChromaClient({ host: endpoint.hostname, port: Number(endpoint.port) || (endpoint.protocol === "https:" ? 443 : 8000), ssl: endpoint.protocol === "https:", fetchOptions: { signal } });
  // This lockfile-selected SDK replaces fetchOptions.fetch. Its generated client
  // exposes setConfig at runtime; fail closed if that integration shape changes.
  const transport: unknown = Reflect.get(result, "apiClient");
  if (!transport || typeof transport !== "object" || typeof Reflect.get(transport, "setConfig") !== "function") throw new Error("Unsupported vector SDK transport configuration");
  Reflect.get(transport, "setConfig").call(transport, { fetch: vectorFetch(signal, maximumBytes) });
  return result;
}
async function operation<T>(options: VectorOptions, task: (c: ChromaClient, name: string, signal: AbortSignal) => Promise<T>): Promise<T> {
  const maximumBytes = options.maximumResponseBytes ?? VECTOR_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * 1024 * 1024) throw new Error("Invalid vector response byte limit");
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 3_600_000)) throw new Error("Invalid vector deadline");
  const signal = boundedSignal(options.signal, options.timeoutMs ?? 15_000);
  const release = await vectorGate.acquire(signal);
  try { signal.throwIfAborted(); const name = options.collection ?? await servingCollectionName(); signal.throwIfAborted(); const result = await task(client(signal, maximumBytes), name, signal); signal.throwIfAborted(); return result; }
  finally { release(); }
}
async function collection(c: ChromaClient, name: string): Promise<Collection> {
  return c.getOrCreateCollection({ name, metadata: { "hnsw:space": "cosine" }, embeddingFunction: null });
}
/** Keep admission and one deadline until all direct SDK work has settled. */
export async function withVectorCollection<T>(task: (collection: Collection, signal: AbortSignal) => Promise<T>, options: VectorOptions = {}): Promise<T> {
  return operation(options, async (c, name, signal) => task(await collection(c, name), signal));
}
export async function addDocuments(docs: VectorDocuments, options: VectorOptions = {}): Promise<void> {
  if (docs.ids.length > 1000 || docs.ids.length !== docs.embeddings.length || docs.ids.length !== docs.documents.length || docs.ids.length !== docs.metadatas.length) throw new Error("Invalid vector batch");
  const write = () => operation(options, async (c, name) => { await (await collection(c, name)).upsert(docs); });
  if (options.collection) await write();
  else await withFileLease(join(paths.state, "index-writer.lock"), write, { waitMs: 1000 });
}
export async function getDocumentIds(options: VectorOptions = {}): Promise<string[]> {
  return operation(options, async (c, name) => {
    const coll = await collection(c, name), count = await coll.count();
    if (count > 100_000) throw new Error("Vector collection exceeds the bounded index size");
    const ids: string[] = [];
    for (let offset = 0; offset < count; offset += 1000) ids.push(...(await coll.get({ limit: 1000, offset, include: [] })).ids);
    return ids;
  });
}
export async function getDocuments(ids: string[], options: VectorOptions = {}): Promise<VectorDocuments> {
  if (ids.length > 1000) throw new Error("Vector read batch exceeds its limit");
  return operation(options, async (c, name) => {
    const records = await (await collection(c, name)).get({ ids, include: ["documents", "metadatas", "embeddings"] });
    return { ids: records.ids, documents: records.documents as string[], metadatas: records.metadatas as Record<string, string>[], embeddings: records.embeddings as number[][] };
  });
}
export async function deleteDocuments(ids: string[], options: VectorOptions = {}): Promise<void> {
  if (ids.length) await operation(options, async (c, name) => { await (await collection(c, name)).delete({ ids }); });
}
export async function discardCollection(name: string, options: VectorOptions = {}): Promise<void> {
  await operation({ ...options, collection: name }, async c => { await c.deleteCollection({ name }); });
}
export async function query(embedding: number[], topK = llmConfig.topK, options: VectorOptions = {}): Promise<{ ids: string[]; documents: string[]; metadatas: Record<string, string>[]; distances: number[] }> {
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > 1000) throw new Error("Invalid vector result limit");
  return operation(options, async (c, name) => {
    const results = await (await collection(c, name)).query({ queryEmbeddings: [embedding], nResults: topK });
    return { ids: results.ids[0] ?? [], documents: (results.documents?.[0] ?? []) as string[], metadatas: (results.metadatas?.[0] ?? []) as Record<string, string>[], distances: (results.distances?.[0] ?? []) as number[] };
  });
}
export async function getStats(options: VectorOptions = {}): Promise<{ count: number; name: string }> {
  return operation(options, async (c, name) => ({ count: await (await collection(c, name)).count(), name }));
}
export async function isChromaRunning(timeoutMs = 2000, signal?: AbortSignal): Promise<boolean> {
  try { await operation({ signal, timeoutMs }, async c => { await c.heartbeat(); }); return true; }
  catch { return false; }
}
export async function waitForChroma(maxRetries = 3, delayMs = 1000): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (await isChromaRunning()) return true;
    if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
  }
  return false;
}
