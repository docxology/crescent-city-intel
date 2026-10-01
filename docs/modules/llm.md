# LLM Module

## `src/llm/config.ts` — Configuration

Centralized configuration for LLM services, with environment variable overrides.

| Property | Default | Env Var | Description |
|----------|---------|---------|-------------|
| `provider` | `ollama` | `LLM_PROVIDER` | Chat provider (`ollama` or `openrouter`) |
| `ollamaUrl` | `http://localhost:11434` | `OLLAMA_URL` | Ollama embedding/chat API base URL |
| `embeddingModel` | `nomic-embed-text` | `EMBEDDING_MODEL` | Model for embeddings |
| `chatModel` | `gemma3:4b` | `CHAT_MODEL` | Model for chat/summarization |
| `openrouterUrl` | `https://openrouter.ai/api/v1` | `OPENROUTER_URL` | OpenRouter API base URL |
| `openrouterModel` | `inclusionai/ling-3.0-flash:free` | `OPENROUTER_MODEL` | OpenRouter chat model |
| `providerPreflightTimeoutMs` | `5000` | `LLM_PREFLIGHT_TIMEOUT_MS` | Bounded provider health check |
| `chromaUrl` | `http://localhost:8001` | `CHROMA_URL` | ChromaDB server URL |
| `collectionName` | `crescent-city-code` | — | ChromaDB collection name |
| `chunkSize` | `1500` | — | Characters per text chunk |
| `chunkOverlap` | `150` | — | Overlap between chunks |
| `topK` | `10` | — | Top results for RAG retrieval |

---

## `src/llm/ollama.ts` — Ollama API Wrapper

| Function | Signature | Description |
|----------|-----------|-------------|
| `embed` | `(text) → Promise<number[]>` | Generate embedding for single text via `/api/embed` |
| `embedBatch` | `(texts) → Promise<number[][]>` | Batch embedding via `/api/embed` with multiple inputs |
| `chat` | `(messages, context?) → Promise<string>` | Chat completion via `/api/chat` (non-streaming). Injects system prompt with optional context. |
| `listModels` | `() → Promise<string[]>` | List available models via `/api/tags` |
| `isOllamaRunning` | `(timeoutMs?) → Promise<boolean>` | Bounded health check via `/api/tags` |

---

## Provider behavior

Ollama is the default local chat provider. Setting `LLM_PROVIDER=openrouter`
routes chat, section summarization, and curation through OpenRouter while
Ollama remains required for embeddings. The GUI and CLI report the selected
provider/model separately from the embedding dependency. The OpenRouter
preflight checks the non-generative `/models` endpoint without consuming a chat
completion; an unset key or unreachable endpoint is an explicit unavailable
state, not a silent fallback.

## `src/llm/chroma.ts` — ChromaDB Client

| Function | Signature | Description |
|----------|-----------|-------------|
| `servingCollectionName` | `() → Promise<string>` | Read the activated collection from the index receipt, with the configured initial name as fallback. |
| `withVectorCollection` | `(task, options?) → Promise<T>` | Hold vector admission and the total deadline through every SDK read in the supplied operation. |
| `addDocuments` | `(docs, options?) → Promise<void>` | Upsert bounded, equal-length document/vector/metadata batches. |
| `getDocumentIds` | `(options?) → Promise<string[]>` | Enumerate actual stored IDs, with a bounded collection size. |
| `query` | `(embedding, topK?, options?) → Promise<{ids, documents, metadatas, distances}>` | Query a selected collection by embedding vector. |
| `getStats` | `(options?) → Promise<{count, name}>` | Collection document count and name. |
| `isChromaRunning` | `(timeoutMs?, signal?) → Promise<boolean>` | Bounded health check via heartbeat. |

`VectorOptions` accepts `signal`, `collection`, `timeoutMs`, and
`maximumResponseBytes`. Vector requests share bounded admission and propagate
cancellation through the pinned SDK's fetch adapter. The adapter denies redirects
and caps declared and streamed response bytes before SDK JSON parsing (16 MiB
default, explicit maximum 64 MiB). Analytics retains admission through count and
all sampled reads, uses a total 30-second deadline, caps samples at 2000 vectors,
and yields during PCA iterations so caller cancellation can settle.

---

## `src/llm/embeddings.ts` — Indexing Pipeline

| Function | Signature | Description |
|----------|-----------|-------------|
| `isIndexed` | `() → Promise<boolean>` | Check receipt schema/configuration, source manifest identity when present, owned chunk count, and every owned ID in the serving collection. |
| `indexAllSections` | `(options?) → Promise<void>` | Load one source edition and stage a complete index before activating its receipt. |
| `indexSections` | `(sections, options?) → Promise<void>` | Index a supplied section set with a total deadline and exclusive writer lease. |

### Chunking Strategy

- Chunk size: 1500 characters
- Overlap: 150 characters
- Each chunk prefixed with `{sectionNumber}: {sectionTitle}`
- Metadata includes: `sectionGuid`, `sectionNumber`, `sectionTitle`, `articleGuid`, `articleTitle`, `chunkIndex`
- Batch size: 32 chunks per embedding request by default (`EMBED_BATCH_SIZE`)
- A failed embedding or incomplete staged collection prevents activation and retains the prior serving receipt.

---

## `src/llm/rag.ts` — RAG Pipeline

| Function | Signature | Description |
|----------|-----------|-------------|
| `ragQuery` | `(userQuestion) → Promise<RagResponse>` | Full RAG pipeline: embed → retrieve → generate. |

### Pipeline Steps

1. **Embed** question via `embed()`
2. **Retrieve** top-K similar chunks from ChromaDB via `query()`
3. **Build context** from retrieved documents with section citations
4. **Generate** answer via the configured provider with injected context
5. **Return** answer + sources (with similarity scores) plus provider/model,
   query ID, context fingerprint, latency, retrieval count, embedding model,
   Chroma collection, and `grounded: false`. Citation identity is checked against
   retrieved municipal records: missing or unknown citations produce an
   `abstained` disposition, while recognized citations produce
   `generated-unverified`. Semantic support, source independence, and legal
   currency are not evaluated. Empty or malformed retrieval
   raises a retryable `NoRetrievedContextError`; it is never returned as a
   successful answer.

Streaming responses emit the same lineage at the final `done` event and accept
cancellation through the request signal. The local GUI exposes a Cancel
control, so a user can stop a slow Ollama/OpenRouter request without leaving
the interface in a false “thinking” state.

### Curation evidence contract

Each curated item includes an `inputFingerprint` (SHA-256 of the stable source
ID, title, source text, provider, model, and prompt version), `promptVersion`,
source `citations`, provider and model metadata, `summaryStatus`, `retryable`,
and bounded source provenance. Curation uses a dedicated source-grounded
editor prompt, a bounded excerpt/output contract, and an abortable
`CURATION_SUMMARY_TIMEOUT_MS`; it never silently treats a source-only fallback
as a completed LLM summary. Triplicate is excluded before this pipeline begins
and cannot become a curation or embedding input through the public snapshot path.

---

## `src/llm/index.ts` — CLI Entry Point

| Command | Description |
|---------|-------------|
| `bun run index` | Index all sections into ChromaDB |
| `bun run chat` | Interactive REPL chat |
| `bun run query "..."` | Single RAG query |
| `bun run status` | Show Ollama/ChromaDB status and stats |
| `bun run src/llm/index.ts review-package INPUT OUTPUT` | Create a private byte-bound semantic review package; all judgments begin unassessed. |
| `bun run src/llm/index.ts review-assess PACKAGE OUTPUT [ANNOTATIONS]` | Validate explicitly supplied annotation spans and reviewer labels without authenticating reviewer identity. |
| `bun run src/llm/index.ts replay-context SUITE OUTPUT [--deadline-ms=N]` | Generate a bounded local replay over versioned retained diagnostic contexts. |

### RAG additions

- **Rerank** (`RERANK_ENABLED=true`): `rerankByQueryOverlap` reorders the post-retrieval
  chunks by a lexical-hybrid score (query-term overlap ⊕ vector similarity), keeping
  `RERANK_TOP_N`. Off by default so retrieval order is unchanged.
- **Conversation history**: `chatWithProvider`/`streamChat` accept prior turns via
  `buildChatMessages` (last 6), enabling multi-turn context on POST `/api/chat` and
  `/api/chat/stream`.

---

## `src/llm/provider.ts` — Automatic fallback chain

`chatWithProviderFallback(messages, context?, modelOverride?, options?)` tries
the provider chain under a shared deadline and caller cancellation:

1. **Primary provider** (per `LLM_PROVIDER`) — preflighted via the non-generative
   health check first so a dead endpoint costs no generation timeout.
2. **Secondary provider** — when the primary is openrouter and it is unconfigured
   or unreachable, Ollama is attempted next.
3. **Deterministic extract** — when every provider is down, `deterministicExtract`
   returns a clearly labeled extract built ONLY from the supplied retrieved
   context (or an explicit "unable to answer" note when no context exists). It
   copies source text rather than generating new claims. A cancelled or expired
   request throws instead of continuing through the fallback chain.

The result object carries `outcome` (`primary` | `secondary` | `deterministic`),
`providerUsed`, `model`, and any preflight/error strings for observability.

## `src/llm/structured.ts` — Structured output

```bash
# From TypeScript:
# const { value, source } = await queryStructured<T>(prompt, {
#   schemaHint: '{"section": string, "topic": string}',
# }, isMyType);
```

`queryStructured<T>(prompt, options, validate?)` requests strict JSON, extracts
the outermost JSON object/array (tolerating prose and markdown fences), parses
it, optionally type-guards with `validate`, retries once on malformed output
with a repair prompt, and returns `{ value: null }` otherwise so callers can
fall back deterministically. Usage example: see
`tests/llm-live-integration.test.ts`.

## `src/llm/usage.ts` — Token-usage accounting

Every `chat()` call in `ollama.ts` / `openrouter.ts` records provider, model,
prompt/completion tokens (`prompt_eval_count`/`eval_count` or OpenRouter
`usage`; character-estimated with an `estimated` flag when a provider omits
counts) into a bounded in-memory window (5000 requests). The GUI server exposes:

```bash
curl -s http://localhost:3000/api/llm/usage | jq .
```

Response shape: `{ schemaVersion, generatedAt, totals: {requests,
promptTokens, completionTokens, totalTokens}, providers: [...], lastRecordAt }`.
Counters reset on process restart; batch scripts keep their own window per run.

## Verification commands

```bash
bun test tests/llm-usage-and-fallback.test.ts   # deterministic accounting/parse/fallback tests
bun run test:llm-native                       # optional real Ollama/Chroma acceptance; requires both services
bun run index                                # stage and activate a reconciled RAG index
bun run query "tsunami hazard zone regulations" # end-to-end semantic search check
ollama pull nomic-embed-text                   # configured embedding model
ollama pull gemma3:4b                         # configured local chat model
```

---

## `src/llm/validate.ts` — Literal Quote Diagnostics

Checks whether proposed quote spans occur in supplied snippets. Every returned
claim has `verdict: "unassessed"`, `verifiedSupport: false`,
`semanticSupport: "not-evaluated"`, and `sourceIndependence: "not-evaluated"`.
The legacy classification names appear only in
`proposedQuoteClassification`, a diagnostic of proposed labels and quote counts.

| Export | Kind | Description |
|--------|------|-------------|
| `validateClaims(claim, snippets)` | async | Ask the provider for proposed quotes, check their literal presence, and return an unassessed claim receipt. |
| `verifiedBySubstring(span, text)` | pure | Literal substring match modulo casing/whitespace/quote glyphs. |
| `classifySupportFromCounts(supportingSources, contradictingSpans)` | pure | Compute the proposed quote-label diagnostic; it does not certify claim support. |
| `buildClaimValidation(...)` | pure | Assemble quote-presence provenance while leaving semantic support unassessed. |
| `extractQuoteSpans(text)` | pure | Pulls `"..."`-quoted spans from model/snippet text. |
| `normalizeForSubstringMatch(text)` | pure | Normalization shared by the verifier. |

**Quote-presence invariant:** `verifiedBySubstring` must confirm a proposed span
appears literally inside a supplied snippet. Nonmatching spans land in
`rejectedSpans` (`reason: "not_found"`). A matching span still cannot raise the
claim verdict above `unassessed`.

### Event integration boundary

`src/events.ts` does not call `validateClaims`. A standalone diagnostic caller
can supply `CorroborationSnippet[]` from retained source records and call the
canonical validator. This example supplies quote-presence provenance for review;
it does not alter the event artifact or establish support. URL distinctness alone
does not establish source independence:

```ts
const validation = await validateClaims(eventFact.claimText, snippets);
// Retain quote-presence provenance for a separate semantic-support assessment.
// validation.verdict remains "unassessed"; it cannot authorize publication.
```

Literal quote presence establishes that a span occurs in a supplied snippet;
it does not prove that the span entails the claim or that sources are
independent. The diagnostic classifications cannot certify an event as verified.
Future integration must preserve provenance and evaluate claim support before
publication; unsupported facts stay unknown rather than guessed.

---

## `src/llm/dedupe.ts` — Embedding Near-Duplicate Detection

Cosine similarity over nomic-embed-text vectors; pure core tested with tiny synthetic vectors.

| Export | Kind | Description |
|--------|------|-------------|
| `cosineSimilarity(a, b)` | pure | Cosine of two equal-length vectors (0 for zero-magnitude inputs). |
| `findNearDuplicates(candidate, existing, threshold?)` | pure | Matches at or above `NEAR_DUPLICATE_COSINE_THRESHOLD` (0.92), sorted by similarity then id. |
| `nearDuplicateClusters(items, threshold?)` | pure | Greedy single-linkage clusters with first-seen canonical ids; deterministic. |
| `isNearDuplicateOfExisting(text, id, items, threshold?)` | async | Provider-backed wrapper: embeds via Ollama and reuses the pure core. |

---

## Curation enrichment & Monthly-report executive digest

- `src/curation.ts`: structured enrichment pass over each curated item — per-item entity/topic
  tags, salience 0..1 with rationale, one-line neutral summary (`CurationEnrichment`). Additive
  optional fields on `CuratedItem`; enrichment failure never blocks or downgrades the record.
  `CURATION_PROMPT_VERSION` identifies the prompt in provenance and idempotency receipts.
- `src/monthly_report.ts`: `generateExecutiveDigest(metrics, monthLabel)` gives the LLM ONLY
  data-derived numbers and asks it to write connective prose between them. Unavailable provider →
  null and the report omits the Executive Digest section with a warning line (silent fallback;
  the report itself never fails because of the digest).

## `src/llm/index_plan.ts` — Incremental Index Planning

Pure, offline planner that selects articles to re-embed from their content
fingerprints. A `configSignature` over the embedding model and chunking
parameters requests a full re-embed when those settings change. Planning also
reconciles actual stored IDs: missing owned chunks request repair, removed or
shrunk articles lose obsolete chunks, and an empty store cannot be treated as
a no-op merely because its prior fingerprint matches. The executor copies
unchanged chunks into a separate collection, embeds changed chunks, compares
the complete expected and actual ID sets, rechecks the source manifest, and
atomically activates one receipt naming the serving collection. Failure keeps
the prior serving edition. Same-model transcript chunks can be retained; a
model/chunking change marks transcript reindexing explicitly.

Tests: `tests/index-plan.test.ts`, `tests/index-plan-corpus.test.ts`, and the
real local transport fixtures in `tests/llm-reliability.test.ts`. Native backend
acceptance is a separate run and does not establish answer factuality.

## Runtime, privacy, and evaluation

`src/llm/runtime.ts` bounds model/vector admission, request deadlines, response
bytes, and streamed lines. Caller cancellation closes the model stream and
releases admission after the underlying operation settles.

`src/llm/privacy.ts` stores no questions, answers, or conversation history.
`CC_QUERY_LOGGING=metadata` opts into bounded allowlisted receipts under
`output/private/`; `CC_QUERY_RETENTION_DAYS` defaults to seven days and is capped
at thirty. `deletePrivateReceipts()` removes the receipt file under its writer
lease. These private records are excluded from public Pages projections.

`src/llm/evidence.ts` checks cited section identity against retrieved records,
with an explicit unverified or abstained disposition. `src/llm/benchmark.ts`
and `bun run rag:benchmark` evaluate a bounded versioned case set and bind the
case, corpus, index, model, and collection identities. Listed-ID recall and
citation/abstention behavior are diagnostics; semantic entailment, independent
corroboration, legal currency, and general factual accuracy remain unassessed.

`src/llm/semantic_review.ts` binds claim offsets, exact source text and hashes,
source observation clocks, and declared dependency relationships into a private
package. Supplied support annotations must bind the package fingerprint, claim
hash, source hash, and exact evidence span. Review timestamps cannot precede the
package or exceed the assessment clock. Stale/unknown clocks and dependent
sources stay visible. An annotation records a supplied label; it does not prove
reviewer identity, source independence, legal currency, or factuality.

`tests/fixtures/semantic-review-v1.json` contains 16 explicitly synthetic cases:
useful answers and abstentions, negation, quantities, scope, conditions, stale
and unknown source clocks, injected instructions, dependent copies, and literal
quotes or citations that do not support the claim. `evaluateContextReplay()`
uses actual provider generation with a total deadline and records suite/context/
answer/prompt/client-source hashes, selected provider/model and request settings.
Backend sampling defaults and model artifact bytes are explicitly uncaptured.
This replay isolates generation from retrieval; full-corpus retrieval has its
separate benchmark. Human annotation and independent source assessment remain
required before making semantic-support claims.

Run `bun test tests/vector-sdk-boundary.test.ts tests/semantic-review.test.ts`
for actual local HTTP/SDK boundary and review mechanics coverage. Native cached
Ollama generation is a separate operator-run acceptance; it is never implied by
the offline protocol fixtures.

The [2026-10-01 native diagnostic receipt](../evidence/rag-native-2026-10-01.json)
records the precise v3.1.0 run: 6/6 applicable listed-section retrieval hits, 6/8
mechanical disposition matches and zero errors; retained-context generation was
16/16 with 14/16 expected diagnostics. Two retrieval/disposition and two context
mismatches remain retained. These observations do not establish semantic support,
independence, legal currency or civic usefulness, and are not an 8/8 semantic pass.
