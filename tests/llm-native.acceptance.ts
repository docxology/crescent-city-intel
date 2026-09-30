/** Explicit running-service acceptance; never collected by the offline suite. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { llmConfig } from "../src/llm/config.ts";
import { indexSections, isIndexed } from "../src/llm/embeddings.ts";
import { addDocuments, deleteDocuments, discardCollection, getDocumentIds, getDocuments, servingCollectionName } from "../src/llm/chroma.ts";
import { paths } from "../src/shared/paths.ts";
import { withEmptyCorpus } from "./helpers/output-root.ts";
import { retrieveRagContext, ragQuery } from "../src/llm/rag.ts";
import { createStreamingRagResponse } from "../src/llm/streaming_rag.ts";
import type { FlatSection } from "../src/types.ts";

export async function runNativeLlmAcceptance(): Promise<void> {
  const previous = { ...llmConfig }, owned = new Set<string>();
  Object.assign(llmConfig, { ollamaUrl: process.env.NATIVE_OLLAMA_URL ?? "http://127.0.0.1:11435", chromaUrl: process.env.NATIVE_CHROMA_URL ?? "http://127.0.0.1:18001", provider: "ollama", chatModel: "llama3.2:1b", collectionName: `cci-accept-${crypto.randomUUID()}` });
  owned.add(llmConfig.collectionName);
  const section: FlatSection = { guid: "native-s1", number: "8.04.010", title: "Rates", text: "Municipal collection rates are established by resolution of the City Council. The Council reviews the rates annually.", history: "", articleGuid: "native-a1", articleTitle: "Collection rates", articleNumber: "8.04" };
  let passed = 0;
  try {
    await withEmptyCorpus(async () => {
      await indexSections([section]); let active = await servingCollectionName(); owned.add(active);
      assert.equal(await isIndexed(), true); passed++;
      const vector = (await getDocuments((await getDocumentIds()).slice(0, 1))).embeddings[0]!;
      await addDocuments({ ids: ["youtube_abcdefghijk_0", "foreign-owned-by-other-index"], embeddings: [vector, vector], documents: ["A public meeting transcript", "An unrelated index record"], metadatas: [{ sourceType: "youtube_transcript", videoId: "abcdefghijk", videoTitle: "Council", timestamp: "00:00:00" }, { sourceType: "other-index" }] });
      await deleteDocuments(["native-s1_0"]); assert.equal(await isIndexed(), false);
      await indexSections([section]); active = await servingCollectionName(); owned.add(active);
      assert.equal(await isIndexed(), true); assert.equal((await getDocumentIds()).includes("youtube_abcdefghijk_0"), true); assert.equal((await getDocumentIds()).includes("foreign-owned-by-other-index"), false); passed++;
      const receipt = await readFile(paths.indexManifest, "utf8"), before = await getDocumentIds();
      llmConfig.embeddingModel = "cci-deliberately-missing-model";
      await assert.rejects(() => indexSections([{ ...section, text: "Changed rates need a fresh embedding." }]));
      assert.equal(await readFile(paths.indexManifest, "utf8"), receipt); assert.deepEqual(await getDocumentIds(), before); llmConfig.embeddingModel = previous.embeddingModel; passed++;
      await assert.rejects(() => indexSections([{ ...section, text: "Interrupted new edition." }], { signal: AbortSignal.timeout(1) }));
      assert.equal(await readFile(paths.indexManifest, "utf8"), receipt); passed++;
      llmConfig.chunkSize += 1; await indexSections([{ ...section, text: "The City Council establishes rates by resolution." }]);
      active = await servingCollectionName(); owned.add(active); assert.equal((await getDocumentIds()).includes("youtube_abcdefghijk_0"), false);
      assert.equal(JSON.parse(await readFile(paths.indexManifest, "utf8")).transcriptReindexRequired, true); passed++;
      const question = "How are collection rates established?", retrieved = await retrieveRagContext(question);
      const normal = await ragQuery(question), stream = await createStreamingRagResponse(question, retrieved, "llama3.2:1b").text();
      assert.equal(normal.metadata!.contextFingerprint, retrieved.contextFingerprint); assert.ok(stream.includes(retrieved.contextFingerprint));
      assert.equal((stream.match(/event: done/g) ?? []).length, 1); assert.equal((stream.match(/event: error/g) ?? []).length, 0);
      assert.equal(normal.evidence.verifiedSupport, false); assert.equal(normal.metadata!.grounded, false); passed++;
      console.log(JSON.stringify({ acceptance: "native-local-llm", passed, embeddingModel: llmConfig.embeddingModel, chatModel: llmConfig.chatModel, provider: llmConfig.provider, normalDisposition: normal.evidence.disposition, contextFingerprint: retrieved.contextFingerprint, scope: "isolated small fixture; not full-corpus retrieval quality or universal factuality" }));
    });
  } finally {
    for (const name of owned) await discardCollection(name).catch(() => {});
    Object.assign(llmConfig, previous);
  }
}
if (import.meta.main) await runNativeLlmAcceptance();
