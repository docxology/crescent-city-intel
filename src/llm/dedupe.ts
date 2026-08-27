/**
 * Embedding near-duplicate detection — cosine similarity over nomic-embed
 * vectors from the configured Ollama embedding endpoint.
 *
 * The math core (`cosineSimilarity`, `findNearDuplicates`, `nearDuplicateClusters`)
 * is pure and unit-tested with tiny synthetic vectors (real arithmetic, no
 * provider). The provider-backed wrapper `isNearDuplicateOfExisting` fetches
 * real embeddings and reuses the same pure core.
 */

export const NEAR_DUPLICATE_COSINE_THRESHOLD = 0.92;

/** Cosine of the angle between two equal-length vectors; 0 for zero-magnitude inputs. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / Math.sqrt(magA * magB);
}

export interface NearDuplicateCandidate {
  id: string;
  /** Embedding vector (e.g. nomic-embed-text output) for the candidate text. */
  vector: readonly number[];
}

export interface NearDuplicateMatch<T extends NearDuplicateCandidate> {
  candidateId: string;
  existingId: string;
  similarity: number;
}

/**
 * Pure: every existing item whose cosine similarity with the candidate is at
 * or above `threshold` (default `NEAR_DUPLICATE_COSINE_THRESHOLD`).
 */
export function findNearDuplicates<T extends NearDuplicateCandidate>(
  candidate: NearDuplicateCandidate,
  existing: T[],
  threshold: number = NEAR_DUPLICATE_COSINE_THRESHOLD,
): NearDuplicateMatch<T>[] {
  const matches: NearDuplicateMatch<T>[] = [];
  for (const item of existing) {
    const similarity = cosineSimilarity(candidate.vector, item.vector);
    if (similarity >= threshold) {
      matches.push({ candidateId: candidate.id, existingId: item.id, similarity });
    }
  }
  return matches.sort((a, b) => b.similarity - a.similarity || a.existingId.localeCompare(b.existingId));
}

/**
 * Pure: group items into near-duplicate clusters via greedy single-linkage —
 * first-come canonical assignment; deterministic order in, deterministic
 * clusters out. Returns clusters with their canonical representative id.
 */
export function nearDuplicateClusters<T extends NearDuplicateCandidate>(
  items: T[],
  threshold: number = NEAR_DUPLICATE_COSINE_THRESHOLD,
): Array<{ canonicalId: string; memberIds: string[] }> {
  const clusters: { canonicalId: string; vectors: number[][]; memberIds: string[] }[] = [];
  for (const item of items) {
    const home = clusters.find(cluster =>
      cluster.vectors.some(vector => cosineSimilarity(item.vector, vector) >= threshold));
    if (home) {
      home.memberIds.push(item.id);
      home.vectors.push(Array.from(item.vector));
    } else {
      clusters.push({ canonicalId: item.id, vectors: [Array.from(item.vector)], memberIds: [item.id] });
    }
  }
  return clusters.map(({ canonicalId, memberIds }) => ({ canonicalId, memberIds }));
}

// ─── Provider-backed wrapper ───────────────────────────────────────────

/** Fetch a real nomic-embed-text vector for one text via the configured Ollama endpoint. */
async function embedForDedupe(text: string): Promise<number[]> {
  const { embed } = await import("./ollama.js");
  return embed(text);
}

/**
 * Provider-backed check: embed the candidate text and compare against stored
 * embeddings computed on demand. Callers bundling many texts should batch via
 * `embedBatch` themselves and call the pure `findNearDuplicates` instead.
 */
export async function isNearDuplicateOfExisting(
  candidateText: string,
  candidateId: string,
  existingItems: Array<{ id: string; text: string }>,
  threshold: number = NEAR_DUPLICATE_COSINE_THRESHOLD,
): Promise<{ isNearDuplicate: boolean; best?: NearDuplicateMatch<NearDuplicateCandidate> }> {
  if (existingItems.length === 0) return { isNearDuplicate: false };
  const [{ embedBatch }] = await Promise.all([import("./ollama.js")]);
  const vectors = await embedBatch(existingItems.map(item => item.text));
  const candidateVector = await embedForDedupe(candidateText);
  const matches = findNearDuplicates(
    { id: candidateId, vector: candidateVector },
    existingItems.map((item, i) => ({ id: item.id, vector: vectors[i] })),
    threshold,
  );
  return matches.length > 0 ? { isNearDuplicate: true, best: matches[0] } : { isNearDuplicate: false };
}
