import { describe, test, expect } from "bun:test";
import { readFile, readdir, writeFile } from "fs/promises";
import { llmConfig } from "../src/llm/config.ts";
import { indexSections, indexAllSections, isIndexed } from "../src/llm/embeddings.ts";
import { query, isChromaRunning, addDocuments, discardCollection } from "../src/llm/chroma.ts";
import { createStreamingRagResponse } from "../src/llm/streaming_rag.ts";
import { retrieveRagContext, ragQuery, buildChatMessages } from "../src/llm/rag.ts";
import { AdmissionGate } from "../src/llm/runtime.ts";
import { privateReceipt, deletePrivateReceipts } from "../src/llm/privacy.ts";
import { assessAnswerEvidence, evaluateLiteralSpan } from "../src/llm/evidence.ts";
import { paths, outputRoot } from "../src/shared/paths.ts";
import { resolve } from "node:path";
import { withEmptyCorpus, writeSeedCorpus } from "./helpers/output-root.ts";
import { llmHttpFixture } from "./helpers/llm-http.ts";
import type { FlatSection, RagSource } from "../src/types.ts";

const section = (guid: string, text: string): FlatSection => ({ guid, text, number: "8.04.010", title: "Rates", articleGuid: "a1", articleTitle: "Rates", articleNumber: "8.04", history: "" });
const source: RagSource = { sourceType: "municipal_code", sectionGuid: "s1", sectionNumber: "8.04.010", sectionTitle: "Rates", snippet: "Rates apply.", score: 1 };
async function fixture<T>(body: (http: ReturnType<typeof llmHttpFixture>) => Promise<T>) {
  const http = llmHttpFixture(), previous = { ollamaUrl: llmConfig.ollamaUrl, chromaUrl: llmConfig.chromaUrl, provider: llmConfig.provider, embeddingModel: llmConfig.embeddingModel };
  Object.assign(llmConfig, { ollamaUrl: http.url, chromaUrl: http.url, provider: "ollama" });
  try { return await withEmptyCorpus(() => body(http)); }
  finally { Object.assign(llmConfig, previous); http.server.stop(true); }
}

describe("staged serving index over actual client HTTP", () => {
  test("readiness cancellation stops real vector requests and leaves capacity reusable", () => fixture(async http => {
    await indexSections([section("s1", "Rates apply.")]);
    const before = http.requests.length;
    await expect(isIndexed({ signal: AbortSignal.abort() })).rejects.toThrow();
    expect(http.requests.length).toBe(before);
    let reachedCount!: () => void;
    const started = new Promise<void>(resolve => { reachedCount = resolve; });
    const proxy = Bun.serve({ port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/count")) { reachedCount(); await new Promise(resolve => setTimeout(resolve, 200)); }
      return fetch(`${http.url}${path}`, { method: request.method, body: request.method === "POST" ? await request.text() : undefined, headers: { "Content-Type": "application/json" }, signal: request.signal });
    } });
    llmConfig.chromaUrl = `http://127.0.0.1:${proxy.port}`;
    try {
      const controller = new AbortController(), pending = isIndexed({ signal: controller.signal });
      await started; const cancelledAt = Date.now(); controller.abort();
      await expect(pending).rejects.toThrow(); expect(Date.now() - cancelledAt).toBeLessThan(150);
    } finally { llmConfig.chromaUrl = http.url; proxy.stop(true); }
    expect(await isIndexed()).toBe(true);
  }));
  test("failed stage deletion accepts an independent deadline after parent cancellation", async () => {
    const requests: string[] = [];
    const server = Bun.serve({ port: 0, async fetch(request) { requests.push(request.method); await new Promise(resolve => setTimeout(resolve, 150)); return Response.json({}); } });
    const original = llmConfig.chromaUrl; llmConfig.chromaUrl = `http://127.0.0.1:${server.port}`;
    try {
      const cancelled = AbortSignal.abort();
      await expect(discardCollection("fixture-stage", { signal: cancelled })).rejects.toThrow();
      expect(requests).toEqual([]);
      const start = Date.now();
      await expect(discardCollection("fixture-stage", { signal: AbortSignal.timeout(30), timeoutMs: 50 })).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(140);
      expect(requests).toEqual(["DELETE"]);
    } finally { llmConfig.chromaUrl = original; server.stop(true); }
  });
  test("source edition changes invalidate readiness and rebind unchanged vectors without re-embedding", () => fixture(async http => {
    await writeSeedCorpus(outputRoot(), { articleCount: 1 });
    await indexAllSections();
    expect(await isIndexed()).toBe(true);
    const initial = JSON.parse(await readFile(paths.indexManifest, "utf8"));
    const embeds = http.embedRequests;
    const sourceEdition = JSON.parse(await readFile(paths.manifest, "utf8"));
    sourceEdition.completedAt = "2026-09-30T00:00:00.000Z";
    await writeFile(paths.manifest, JSON.stringify(sourceEdition));
    expect(await isIndexed()).toBe(false);
    await indexAllSections();
    const rebound = JSON.parse(await readFile(paths.indexManifest, "utf8"));
    expect(await isIndexed()).toBe(true);
    expect(rebound.corpusManifestSha256).not.toBe(initial.corpusManifestSha256);
    expect(rebound.servingCollection).not.toBe(initial.servingCollection);
    expect(http.embedRequests).toBe(embeds);
  }));
  test("missing actual IDs repair an otherwise identical manifest", () => fixture(async http => {
    await indexSections([section("s1", "Rates apply.")]);
    const initial = JSON.parse(await readFile(paths.indexManifest, "utf8"));
    expect(await isIndexed()).toBe(true);
    http.collections.get(initial.servingCollection)!.clear();
    expect(await isIndexed()).toBe(false);
    await indexSections([section("s1", "Rates apply.")]);
    expect(await isIndexed()).toBe(true);
    expect(http.embedRequests).toBe(2);
  }));
  test("mid-batch embed and partial-upsert failure preserve the previous complete serving receipt", () => fixture(async http => {
    await indexSections([section("s1", "Original rates apply.")]);
    const previous = await readFile(paths.indexManifest, "utf8");
    http.failEmbedAfter = http.embedRequests + 1;
    await expect(indexSections(Array.from({ length: 30 }, (_, i) => section(`s${i}`, "Changed rates.".repeat(200))))).rejects.toThrow();
    expect(await readFile(paths.indexManifest, "utf8")).toBe(previous);
    expect((await query([1, 1, 1])).documents[0]).toContain("Original rates");
    http.failEmbedAfter = Infinity; http.omitLastUpsert = true;
    await expect(indexSections([section("s1", "Changed rates.")])).rejects.toThrow("incomplete");
    expect(await readFile(paths.indexManifest, "utf8")).toBe(previous);
  }));
  test("model swap and shrinking do not mix geometry; transcript ownership remains explicit", () => fixture(async http => {
    await indexSections([section("s1", "Long rates.".repeat(400))]);
    await addDocuments({ ids: ["youtube_abcdefghijk_0"], embeddings: [[1, 1, 1]], documents: ["Public meeting transcript"], metadatas: [{ sourceType: "youtube_transcript", videoId: "abcdefghijk", videoTitle: "Council", timestamp: "00:00:00.000" }] });
    const before = JSON.parse(await readFile(paths.indexManifest, "utf8"));
    llmConfig.embeddingModel = "changed-model";
    await indexSections([section("s1", "Short rates.")]);
    const after = JSON.parse(await readFile(paths.indexManifest, "utf8"));
    expect(http.collections.get(after.servingCollection)!.size).toBe(1);
    expect(http.collections.get(before.servingCollection)!.has("youtube_abcdefghijk_0")).toBe(true);
    expect(after.transcriptReindexRequired).toBe(true);
  }));
});

test("a killed real index writer cannot activate its incomplete stage", () => fixture(async http => {
  await indexSections([section("s1", "Original rates apply.")]);
  const receipt = await readFile(paths.indexManifest, "utf8"); http.stalledEmbedMatch = "Kill edition";
  const code = `import {indexSections} from ${JSON.stringify(resolve("src/llm/embeddings.ts"))}; import {llmConfig} from ${JSON.stringify(resolve("src/llm/config.ts"))}; Object.assign(llmConfig,${JSON.stringify({ ollamaUrl: http.url, chromaUrl: http.url })}); await indexSections(${JSON.stringify([section("s1", "Kill edition changes rates.")])});`;
  const child = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, CC_OUTPUT_DIR: outputRoot() }, stdout: "ignore", stderr: "ignore" });
  try {
    const deadline = Date.now() + 3000;
    while (!http.requests.some(row => row.path === "/api/embed" && JSON.stringify(row.body).includes("Kill edition"))) {
      if (Date.now() >= deadline) throw new Error("Child did not reach its staged embedding request");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    child.kill("SIGKILL"); await child.exited;
    expect(await readFile(paths.indexManifest, "utf8")).toBe(receipt);
    expect(await isIndexed()).toBe(true); expect((await query([1, 1, 1])).documents[0]).toContain("Original rates");
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
}), 5000);

describe("shared retrieval and truthful streaming", () => {
  test("normal and streaming use the same source/context receipt and common bounded history", () => fixture(async () => {
    await indexSections([section("s1", "Rates apply.")]);
    const context = await retrieveRagContext("rates");
    const normal = await ragQuery("rates");
    const text = await createStreamingRagResponse("rates", context).text();
    expect(normal.metadata!.contextFingerprint).toBe(context.contextFingerprint);
    expect(text).toContain(context.contextFingerprint);
    expect(text.match(/event: done/g)).toHaveLength(1); expect(text).not.toContain("event: error");
    expect(normal.evidence.verifiedSupport).toBe(false); expect(normal.metadata!.grounded).toBe(false);
    const turns = buildChatMessages("rates", Array.from({ length: 20 }, () => ({ role: "user" as const, content: "rates" })));
    expect(turns.length).toBeLessThanOrEqual(7);
    expect(turns.at(-1)!.content).toBe("rates");
  }));
  test("prefixed and plain source numbers have one citation sign and the same exact-syntax instruction", () => fixture(async http => {
    for (const number of ["8.04.010", "§\u00a08.04.010"]) {
      await indexSections([{ ...section("s1", "Rates apply."), number }]);
      const context = await retrieveRagContext("rates");
      expect(context.context.startsWith("[§ 8.04.010: Rates]\n")).toBe(true);
      expect(context.context).not.toContain("[§ §");
      await ragQuery("rates");
      await createStreamingRagResponse("rates", context).text();
      const chats = http.requests.filter(row => row.path === "/api/chat").slice(-2);
      for (const row of chats) {
        const messages = row.body.messages as Array<{ role: string; content: string }>;
        const prompt = messages.find(message => message.role === "system")!.content;
        expect(prompt).toContain("exact syntax § 8.08.010");
        expect(prompt).not.toContain("§ §");
      }
    }
  }));
  test("final row without newline completes; abrupt EOF, malformed and provider error rows fail exactly once", () => fixture(async http => {
    for (const row of ['{"message":{"content":"§ 8.04.010"},"done":true}', '{"message":{"content":"partial"}}', 'not-json', '{"error":"private/path/secret"}']) {
      http.ollamaStream = row;
      const text = await createStreamingRagResponse("rates", { sources: [source], context: "Rates apply." }).text();
      if (row.includes('"done":true')) expect(text.match(/event: done/g)).toHaveLength(1);
      else { expect(text.match(/event: error/g)).toHaveLength(1); expect(text).not.toContain("event: done"); }
      expect(text).not.toContain("private/path/secret");
    }
  }));
  test("accepting-but-stalled heartbeat is finite and capacity returns after queued cancellation", async () => {
    const server = Bun.serve({ port: 0, async fetch() { await new Promise(resolve => setTimeout(resolve, 200)); return Response.json({ "nanosecond heartbeat": 1 }); } });
    const original = llmConfig.chromaUrl; llmConfig.chromaUrl = `http://127.0.0.1:${server.port}`;
    try { const start = Date.now(); expect(await isChromaRunning(30)).toBe(false); expect(Date.now() - start).toBeLessThan(180); }
    finally { llmConfig.chromaUrl = original; server.stop(true); }
    const gate = new AdmissionGate(1, 1), release = await gate.acquire(), abort = new AbortController();
    const queued = gate.acquire(abort.signal); abort.abort(); await expect(queued).rejects.toThrow(); release();
    expect(gate.state).toEqual({ active: 0, queued: 0 });
  });
});

describe("private receipts and evidence boundaries", () => {
  test("logging is opt-in, bounded, content-free, and deletable under the output seam", () => withEmptyCorpus(async root => {
    const previous = process.env.CC_QUERY_LOGGING;
    try {
      delete process.env.CC_QUERY_LOGGING;
      await privateReceipt("search", { resultCount: 1 }); expect(await readdir(root)).toEqual([]);
      process.env.CC_QUERY_LOGGING = "metadata";
      await privateReceipt("rag", { resultCount: 2, queryId: "q1" });
      const text = await readFile(`${root}/private/request-receipts.jsonl`, "utf8");
      expect(text).not.toMatch(/question|answer|content/); expect(text).toContain('"resultCount":2');
      await deletePrivateReceipts(); expect(await readdir(`${root}/private`)).toEqual([]);
    } finally { if (previous === undefined) delete process.env.CC_QUERY_LOGGING; else process.env.CC_QUERY_LOGGING = previous; }
  }));
  test("known citations, valid quotations beside negation and dependent sources never establish verified support", () => {
    expect(assessAnswerEvidence("Rates apply under § 8.04.010.", [source]).disposition).toBe("generated-unverified");
    expect(assessAnswerEvidence("Imagined rule under § 99.99.999.", [source]).disposition).toBe("abstained");
    for (const [claim, passage] of [["Rates apply", "It is false that Rates apply"], ["rates apply", "The unrelated discussion quotes rates apply"], ["Rates apply", "Copied source says Rates apply"]]) {
      expect(evaluateLiteralSpan(claim!, passage!).verifiedSupport).toBe(false);
      expect(evaluateLiteralSpan(claim!, passage!).semanticSupport).toBe("not-evaluated");
    }
  });
});
