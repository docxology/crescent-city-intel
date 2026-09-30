/** Deadline-bound Chroma operations and manifest-selected serving collections. */
import { ChromaClient, type Collection } from "chromadb";
import { llmConfig } from "./config.js";
import { paths } from "../shared/paths.js";
import { readFile } from "fs/promises";
import { boundedSignal, vectorGate } from "./runtime.js";
import { withFileLease } from "../shared/storage.js";
import { join } from "path";

export interface VectorOptions { signal?: AbortSignal; collection?: string; timeoutMs?: number }
export interface VectorDocuments { ids: string[]; embeddings: number[][]; documents: string[]; metadatas: Record<string, string>[] }

export async function servingCollectionName(): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(paths.indexManifest, "utf8"));
    if (typeof manifest.servingCollection === "string" && /^[a-zA-Z0-9_-]{3,128}$/.test(manifest.servingCollection)) return manifest.servingCollection;
  } catch { /* prior non-staged index or no index yet */ }
  return llmConfig.collectionName;
}
function client(signal: AbortSignal): ChromaClient {
  const endpoint = new URL(llmConfig.chromaUrl);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("Invalid vector service URL");
  return new ChromaClient({ host: endpoint.hostname, port: Number(endpoint.port) || (endpoint.protocol === "https:" ? 443 : 8000), ssl: endpoint.protocol === "https:", fetchOptions: { signal } });
}
async function operation<T>(options: VectorOptions, task: (c: ChromaClient, name: string) => Promise<T>): Promise<T> {
  const signal = boundedSignal(options.signal, options.timeoutMs ?? 15_000);
  const release = await vectorGate.acquire(signal);
  try { signal.throwIfAborted(); return await task(client(signal), options.collection ?? await servingCollectionName()); }
  finally { release(); }
}
async function collection(c: ChromaClient, name: string): Promise<Collection> {
  return c.getOrCreateCollection({ name, metadata: { "hnsw:space": "cosine" }, embeddingFunction: null });
}
/** Used by analytics; all requests on this collection share a finite deadline. */
export async function getOrCreateCollection(options: VectorOptions = {}): Promise<Collection> {
  return operation(options, collection);
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
