import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reindexRetainedYouTubeTranscripts, planTranscriptChunks, type YouTubeTranscript } from "../src/youtube_monitor.ts";
import { indexSections, indexAllSections } from "../src/llm/embeddings.ts";
import { addDocuments } from "../src/llm/chroma.ts";
import { llmConfig } from "../src/llm/config.ts";
import { indexConfigSignature } from "../src/llm/index_plan.ts";
import { custodyHash } from "../src/corpus_editions.ts";
import { paths, outputRoot } from "../src/shared/paths.ts";
import { withEmptyCorpus, writeSeedCorpus } from "./helpers/output-root.ts";
import { llmHttpFixture } from "./helpers/llm-http.ts";

function transcript(videoId = "abcdefghijk", text = "The Council discussed harbor access."): YouTubeTranscript {
  return { videoId, title: "Council meeting", channel: "City of Crescent City", uploadDate: "20260930", fetchedAt: "2026-09-30T12:00:00Z", status: "ok", segments: [{ start: "00:00:01.000", text }], fullText: text };
}
async function fixture(body: (http: ReturnType<typeof llmHttpFixture>, directory: string) => Promise<void>) {
  const http = llmHttpFixture(), previous = { ollamaUrl: llmConfig.ollamaUrl, chromaUrl: llmConfig.chromaUrl, embeddingModel: llmConfig.embeddingModel };
  Object.assign(llmConfig, { ollamaUrl: http.url, chromaUrl: http.url });
  try { await withEmptyCorpus(async root => {
    await indexSections([{ guid: "section1", number: "8.04.010", title: "Rates", text: "Original municipal rates.", history: "", articleGuid: "article1", articleTitle: "Rates", articleNumber: "8.04" }]);
    const directory = join(root, "youtube"); await mkdir(directory);
    await body(http, directory);
  }); } finally { Object.assign(llmConfig, previous); http.server.stop(true); }
}

test("retained transcript reindex stages exact source/geometry membership while preserving municipal vectors", () => fixture(async (http, directory) => {
  const source = transcript(), raw = JSON.stringify(source, null, 2);
  await writeFile(join(directory, `${source.videoId}.json`), raw);
  const before = JSON.parse(await readFile(paths.indexManifest, "utf8"));
  const codeBefore = structuredClone(http.collections.get(before.servingCollection)!.get("section1_0"));
  await addDocuments({ ids: ["youtube_abcdefghijk_7"], documents: ["Obsolete transcript chunk"], embeddings: [[7, 7, 7]], metadatas: [{ sourceType: "youtube_transcript" }] });
  const receipt = await reindexRetainedYouTubeTranscripts();
  const after = JSON.parse(await readFile(paths.indexManifest, "utf8")), vectors = http.collections.get(after.servingCollection)!;
  expect(receipt).toMatchObject({ transcriptCount: 1, chunkCount: 1, configSignature: indexConfigSignature(llmConfig) });
  expect(receipt.sources[0].sourceSha256).toBe(custodyHash(raw)); expect(receipt.sources[0].chunkIds).toEqual(["youtube_abcdefghijk_0"]);
  expect(vectors.get("section1_0")).toEqual(codeBefore); expect(vectors.size).toBe(2); expect(vectors.has("youtube_abcdefghijk_7")).toBe(false);
  expect(vectors.get("youtube_abcdefghijk_0")!.metadata.sourceSha256).toBe(custodyHash(raw));
  expect(vectors.get("youtube_abcdefghijk_0")!.metadata.configSignature).toBe(indexConfigSignature(llmConfig));
  expect(after.transcriptReindexRequired).toBe(false); expect(after.transcriptIndex).toEqual(receipt); expect(after.articles).toEqual(before.articles);
  expect(http.collections.get(before.servingCollection)!.has("youtube_abcdefghijk_7")).toBe(true);
  // Explicit reduced transcript text rebuilds ownership, so no old tail IDs survive.
  await writeFile(join(directory, `${source.videoId}.json`), JSON.stringify(transcript(source.videoId, "Short revised transcript.")));
  const revised = await reindexRetainedYouTubeTranscripts();
  expect(revised.sources[0].sourceSha256).not.toBe(receipt.sources[0].sourceSha256); expect(http.collections.get(revised.servingCollection)!.size).toBe(2);
}));

test("failed or incomplete real HTTP staging retains the previous serving receipt and collection", () => fixture(async (http, directory) => {
  const source = transcript("abcdefghijk", "Recorded harbor access. ".repeat(400));
  await writeFile(join(directory, `${source.videoId}.json`), JSON.stringify(source));
  const before = await readFile(paths.indexManifest, "utf8"), priorCollection = JSON.parse(before).servingCollection, collectionsBefore = [...http.collections.keys()];
  http.failEmbedAfter = http.embedRequests;
  await expect(reindexRetainedYouTubeTranscripts()).rejects.toThrow();
  expect(await readFile(paths.indexManifest, "utf8")).toBe(before); expect(http.collections.get(priorCollection)!.size).toBe(1);
  http.failEmbedAfter = Infinity; http.omitLastUpsert = true;
  await expect(reindexRetainedYouTubeTranscripts()).rejects.toThrow("incomplete");
  expect(await readFile(paths.indexManifest, "utf8")).toBe(before); expect([...http.collections.keys()]).toEqual(collectionsBefore);
}));

test("source-byte change during actual embedding refuses activation", () => fixture(async (http, directory) => {
  const source = transcript(), file = join(directory, `${source.videoId}.json`);
  await writeFile(file, JSON.stringify(source)); const before = await readFile(paths.indexManifest, "utf8");
  const proxy = Bun.serve({ port: 0, async fetch(request): Promise<Response> {
    if (new URL(request.url).pathname === "/api/embed") await writeFile(file, JSON.stringify({ ...source, title: "Changed source edition" }));
    return fetch(`${http.url}${new URL(request.url).pathname}`, { method: request.method, body: request.method === "POST" ? await request.text() : undefined, headers: { "Content-Type": "application/json" } });
  } });
  llmConfig.ollamaUrl = `http://127.0.0.1:${proxy.port}`;
  try { await expect(reindexRetainedYouTubeTranscripts()).rejects.toThrow("sources changed"); expect(await readFile(paths.indexManifest, "utf8")).toBe(before); }
  finally { llmConfig.ollamaUrl = http.url; proxy.stop(true); }
}));

test("unknown/malformed sources do not clear the reindex requirement or produce a vector", () => fixture(async (http, directory) => {
  const before = await readFile(paths.indexManifest, "utf8"), embeds = http.embedRequests;
  await expect(reindexRetainedYouTubeTranscripts()).rejects.toThrow("No retained");
  await writeFile(join(directory, "abcdefghijk.json"), JSON.stringify({ ...transcript(), videoId: "mismatched01" }));
  await expect(reindexRetainedYouTubeTranscripts()).rejects.toThrow("identity/status");
  await writeFile(join(directory, "abcdefghijk.json"), JSON.stringify({ ...transcript(), segments: [{ start: "00:99:00.000", text: "Invalid cue" }] }));
  await expect(reindexRetainedYouTubeTranscripts()).rejects.toThrow("cue");
  expect(await readFile(paths.indexManifest, "utf8")).toBe(before); expect(http.embedRequests).toBe(embeds);
  expect(planTranscriptChunks({ ...transcript(), status: "unavailable" }, custodyHash(""))).toEqual([]);
}));

test("a bound municipal source edition change before or during transcript embedding refuses activation", () => fixture(async (http, directory) => {
  await writeSeedCorpus(outputRoot(), { articleCount: 1 }); await indexAllSections();
  const source = transcript(); await writeFile(join(directory, `${source.videoId}.json`), JSON.stringify(source));
  const before = await readFile(paths.indexManifest, "utf8"), corpusBefore = await readFile(paths.manifest, "utf8");
  const changeEdition = () => writeFile(paths.manifest, JSON.stringify({ ...JSON.parse(corpusBefore), completedAt: "2026-09-30T22:00:00Z" }));
  await changeEdition();
  await expect(reindexRetainedYouTubeTranscripts()).rejects.toThrow("source edition changed");
  expect(await readFile(paths.indexManifest, "utf8")).toBe(before);
  await writeFile(paths.manifest, corpusBefore);
  const proxy = Bun.serve({ port: 0, async fetch(request): Promise<Response> {
    if (new URL(request.url).pathname === "/api/embed") await changeEdition();
    return fetch(`${http.url}${new URL(request.url).pathname}`, { method: request.method, body: request.method === "POST" ? await request.text() : undefined, headers: { "Content-Type": "application/json" } });
  } });
  llmConfig.ollamaUrl = `http://127.0.0.1:${proxy.port}`;
  try { await expect(reindexRetainedYouTubeTranscripts()).rejects.toThrow("source edition changed during"); expect(await readFile(paths.indexManifest, "utf8")).toBe(before); }
  finally { llmConfig.ollamaUrl = http.url; proxy.stop(true); }
}));
