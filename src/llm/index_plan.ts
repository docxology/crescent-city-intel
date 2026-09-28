/**
 * Incremental index planning — pure, offline, and independent of ChromaDB.
 *
 * The TODO item this closes: `indexAllSections` skipped the rebuild only when
 * the WHOLE-corpus chunk fingerprint was unchanged, so a single changed article
 * re-embedded all 3,105 chunks of the municipal code. On a local embedder that
 * is minutes of work for a one-section edit.
 *
 * The unit of work is the ARTICLE, not the corpus, because an article is the
 * smallest unit whose sections always change together (a re-scrape rewrites an
 * article's sections as a group) and because chunk ids are already namespaced
 * per section. Planning is separated from execution so the decision — which
 * articles to re-embed, which chunks to delete — is testable with fixtures
 * instead of a live vector store.
 *
 * ## The invariant that matters: vectors from two models cannot be mixed
 *
 * A per-article fingerprint records "this article's text is unchanged". It says
 * nothing about WHICH EMBEDDER produced the stored vectors. Change
 * `EMBEDDING_MODEL` (or the chunking parameters, which change what a chunk *is*)
 * and every stored vector becomes wrong while its fingerprint still matches —
 * silently producing one cosine space holding two models' geometry.
 *
 * `configSignature` covers exactly those inputs, and any mismatch invalidates
 * every article entry. This is why the signature is part of the plan and not
 * just the manifest: an un-embedding model swap is a correctness bug, not a
 * performance regression.
 */
import { computeSha256 } from "../utils.js";
import type { FlatSection } from "../types.js";

/** Manifest version that introduced the per-article map. */
export const INDEX_MANIFEST_SCHEMA = 2;

/** One chunk as the planner sees it: an id and the text it embeds. */
export interface PlannedChunk {
  id: string;
  text: string;
  metadata: Record<string, string>;
}

/** What the manifest remembers about one article. */
export interface IndexArticleEntry {
  /** SHA-256 over this article's chunk ids and texts. */
  fingerprint: string;
  /** Chunk ids currently stored for this article, so a shrunk one is pruned. */
  chunkIds: string[];
}

export interface IndexManifest {
  schemaVersion: number;
  generatedAt: string;
  /** Whole-corpus fingerprint. A match is the fast path that skips everything. */
  fingerprint: string;
  chunkCount: number;
  source: string;
  embeddingModel: string;
  /**
   * Inputs that change what a stored vector MEANS: the embedding model and the
   * chunking parameters. A mismatch invalidates every per-article entry.
   */
  configSignature: string;
  /** Per-article state, keyed by `articleGuid`. */
  articles: Record<string, IndexArticleEntry>;
}

/**
 * Signature of everything that invalidates a stored vector.
 *
 * Kept as an explicit function so the manifest field and the comparison cannot
 * drift: callers never build this string by hand.
 */
export function indexConfigSignature(config: {
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
}): string {
  return `v${INDEX_MANIFEST_SCHEMA}:model=${config.embeddingModel}:chunk=${config.chunkSize}:overlap=${config.chunkOverlap}`;
}

/** Fingerprint of one article's chunks. Stable for identical id+text sequences. */
export async function fingerprintChunks(chunks: readonly PlannedChunk[]): Promise<string> {
  return computeSha256(chunks.map(chunk => `${chunk.id}\0${chunk.text}`).join("\n"));
}

/** The chunks of one article, built from the same text the indexer embeds. */
export function chunksForArticle(
  section: Pick<FlatSection, "guid" | "number" | "title" | "text" | "articleGuid" | "articleTitle">,
  chunkText: (text: string) => string[],
): PlannedChunk[] {
  const text = `${section.number}: ${section.title}\n${section.text}`;
  return chunkText(text).map((body, index) => ({
    id: `${section.guid}_${index}`,
    text: body,
    metadata: {
      sectionGuid: section.guid,
      sectionNumber: section.number,
      sectionTitle: section.title,
      articleGuid: section.articleGuid,
      articleTitle: section.articleTitle,
      chunkIndex: String(index),
    },
  }));
}

export interface ArticleChunkSet {
  articleGuid: string;
  chunks: PlannedChunk[];
  /** SHA-256 over this article's chunks. */
  fingerprint: string;
}

export interface IndexPlan {
  /** Articles whose stored chunks are still valid — skip re-embedding. */
  unchanged: string[];
  /** Articles whose text changed (or whose config signature moved). */
  changed: string[];
  /** Articles with no prior state. */
  added: string[];
  /** Articles present in the manifest but gone from the corpus. */
  removed: string[];
  /**
   * Chunk ids to delete before embedding. An article that grew needs no
   * deletion; one that shrank has trailing chunk ids that no longer exist.
   */
  staleChunkIds: string[];
  /** Every chunk in the desired end state. */
  totalChunks: number;
  /** Chunks that must actually be embedded. */
  chunksToEmbed: number;
  /** True when nothing at all needs doing. */
  noop: boolean;
  /** Why the plan is a full rebuild, when it is. */
  fullRebuildReason: string | null;
}

/**
 * Why a prior manifest cannot be trusted, or null when it can.
 *
 * Returns a reason string instead of a type predicate: the "cannot be trusted"
 * branch still needs to READ the manifest (to recover its recorded chunk ids
 * for cleanup), and a predicate would narrow it to `never` there.
 */
function unusableReason(manifest: IndexManifest | null | undefined, configSignature: string): string | null {
  if (!manifest) return "no prior index manifest";
  if (manifest.schemaVersion !== INDEX_MANIFEST_SCHEMA) {
    return `manifest schema ${manifest.schemaVersion} predates per-article indexing`;
  }
  if (manifest.configSignature !== configSignature) {
    return "embedding model or chunking parameters changed since the last index";
  }
  if (!manifest.articles || typeof manifest.articles !== "object") {
    return "index manifest has no per-article map";
  }
  return null;
}

/**
 * Decide what to re-embed.
 *
 * `existingIds` is the id set actually present in the store, used only to avoid
 * planning a deletion for a chunk that is already gone. Passing it is optional;
 * when omitted, every recorded chunk id is treated as present, which is the safe
 * direction (a redundant delete is a no-op in Chroma).
 */
export function planIncrementalIndex(
  articles: readonly ArticleChunkSet[],
  previous: IndexManifest | null | undefined,
  configSignature: string,
  existingIds?: ReadonlySet<string>,
): IndexPlan {
  const totalChunks = articles.reduce((sum, article) => sum + article.chunks.length, 0);
  const plan: IndexPlan = {
    unchanged: [],
    changed: [],
    added: [],
    removed: [],
    staleChunkIds: [],
    totalChunks,
    chunksToEmbed: 0,
    noop: true,
    fullRebuildReason: null,
  };

  const prior = previous ?? null;
  const reason = unusableReason(prior, configSignature);

  // No usable prior state -> everything is new, and the recorded chunk ids for
  // any dead article are still ours to clean up.
  if (reason !== null) {
    plan.fullRebuildReason = reason;
    const current = new Set(articles.map(article => article.articleGuid));
    for (const [articleGuid, entry] of Object.entries(prior?.articles ?? {})) {
      if (current.has(articleGuid)) continue;
      plan.removed.push(articleGuid);
      plan.staleChunkIds.push(...entry.chunkIds);
    }
    for (const article of articles) plan.added.push(article.articleGuid);
    plan.chunksToEmbed = totalChunks;
    plan.noop = false;
    if (existingIds) plan.staleChunkIds = plan.staleChunkIds.filter(id => existingIds.has(id));
    return dedupeStale(plan);
  }

  const priorArticles = prior!.articles;
  const current = new Set(articles.map(article => article.articleGuid));

  for (const article of articles) {
    const before = priorArticles[article.articleGuid];
    if (!before) {
      plan.added.push(article.articleGuid);
      continue;
    }
    if (before.fingerprint === article.fingerprint) {
      plan.unchanged.push(article.articleGuid);
      // The article's text is identical, so its chunk ids are identical too
      // (ids are derived from guid + index). Nothing to delete.
      continue;
    }
    plan.changed.push(article.articleGuid);
    const desired = new Set(article.chunks.map(chunk => chunk.id));
    // Chunks that no longer exist because the article shrank. A changed
    // article is deleted wholesale before re-embedding, so trailing ids are
    // listed here for the caller's bookkeeping and the id set is rebuilt.
    plan.staleChunkIds.push(...before.chunkIds.filter(id => !desired.has(id)));
  }

  for (const articleGuid of Object.keys(priorArticles)) {
    if (current.has(articleGuid)) continue;
    plan.removed.push(articleGuid);
    plan.staleChunkIds.push(...priorArticles[articleGuid]!.chunkIds);
  }

  plan.chunksToEmbed = articles
    .filter(article => plan.changed.includes(article.articleGuid) || plan.added.includes(article.articleGuid))
    .reduce((sum, article) => sum + article.chunks.length, 0);
  plan.noop = plan.chunksToEmbed === 0 && plan.staleChunkIds.length === 0;
  if (existingIds) plan.staleChunkIds = plan.staleChunkIds.filter(id => existingIds.has(id));
  return dedupeStale(plan);
}

function dedupeStale(plan: IndexPlan): IndexPlan {
  const seen = new Set<string>();
  plan.staleChunkIds = [...new Set(plan.staleChunkIds)].filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return plan;
}

/** Build the manifest that describes the corpus as it is now. */
export async function buildIndexManifest(input: {
  articles: readonly ArticleChunkSet[];
  configSignature: string;
  embeddingModel: string;
  source: string;
  generatedAt?: string;
}): Promise<IndexManifest> {
  const articles: Record<string, IndexArticleEntry> = {};
  for (const article of input.articles) {
    articles[article.articleGuid] = {
      fingerprint: article.fingerprint,
      chunkIds: article.chunks.map(chunk => chunk.id),
    };
  }
  const allChunks = input.articles.flatMap(article => article.chunks);
  return {
    schemaVersion: INDEX_MANIFEST_SCHEMA,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    fingerprint: await fingerprintChunks(allChunks),
    chunkCount: allChunks.length,
    source: input.source,
    embeddingModel: input.embeddingModel,
    configSignature: input.configSignature,
    articles,
  };
}
