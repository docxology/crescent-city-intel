import { test, expect } from "bun:test";
import { getStats, addDocuments } from "../src/llm/chroma.ts";
import { getEmbeddingProjection } from "../src/gui/analytics.ts";
import { vectorGate } from "../src/llm/runtime.ts";
import { llmConfig } from "../src/llm/config.ts";
import { llmHttpFixture } from "./helpers/llm-http.ts";
import { withEmptyCorpus } from "./helpers/output-root.ts";

async function fixture(task: (setMode: (value: string) => void, reached: () => number) => Promise<void>) {
  const backend = llmHttpFixture(); let mode = "normal", reached = 0;
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (/\/(count|get)$/.test(url.pathname) && mode !== "normal") {
      reached++;
      if (mode === "redirect") return new Response(null, {status:302,headers:{Location:backend.url+url.pathname}});
      if (mode === "headers") return new Response(" ".repeat(4096), { headers: { "Content-Length": "4096" } });
      if (mode === "chunks") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(" ".repeat(4096))); controller.close(); } }));
      if (mode === "slow-headers") await Bun.sleep(250);
      if (mode === "slow-body") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(" ")); const timer = setTimeout(() => { try { controller.close(); } catch {} }, 250); request.signal.addEventListener("abort", () => clearTimeout(timer), { once: true }); } }));
    }
    return fetch(new Request(`${backend.url}${url.pathname}${url.search}`, request));
  } });
  const previous = { ...llmConfig }; llmConfig.chromaUrl = `http://127.0.0.1:${server.port}`;
  try { await withEmptyCorpus(() => task(value => { mode = value; }, () => reached)); }
  finally { Object.assign(llmConfig, previous); server.stop(true); backend.server.stop(true); }
}

test("actual SDK bounds chunked and declared response bytes before JSON parsing", () => fixture(async setMode => {
  const nativeFetch = globalThis.fetch;
  for (const mode of ["headers", "chunks"]) {
    setMode(mode); await expect(getStats({ collection: "fixture", maximumResponseBytes: 512 })).rejects.toThrow("byte limit");
    expect(vectorGate.state).toEqual({ active: 0, queued: 0 });
  }
  setMode("redirect"); await expect(getStats({ collection: "fixture" })).rejects.toThrow(); expect(globalThis.fetch).toBe(nativeFetch);
  setMode("normal"); expect(await getStats({ collection: "fixture" })).toMatchObject({ count: 0 });
}));

test("actual SDK header/body deadlines and parent abort settle before followup work", () => fixture(async (setMode, reached) => {
  for (const mode of ["slow-headers", "slow-body"]) {
    setMode(mode); const started = Date.now();
    await expect(getStats({ collection: "fixture", timeoutMs: 70 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(230); expect(vectorGate.state).toEqual({ active: 0, queued: 0 });
  }
  setMode("slow-body"); const controller = new AbortController(); const before = reached();
  const pending = getStats({ collection: "fixture", signal: controller.signal });
  while (reached() === before) await Bun.sleep(5);
  controller.abort(); await expect(pending).rejects.toThrow(); expect(vectorGate.state).toEqual({ active: 0, queued: 0 });
  setMode("normal"); expect((await getStats({ collection: "fixture" })).count).toBe(0);
}));

test("analytics holds admission through count and sampled SDK reads, and cancels queued callers", () => fixture(async setMode => {
  await addDocuments({ ids: ["s1"], embeddings: [[1, 2]], documents: ["Rates apply"], metadatas: [{ sectionGuid: "s1", sectionNumber: "8.04.010", sectionTitle: "Rates", articleTitle: "Rates" }] }, { collection: llmConfig.collectionName });
  const normal = await getEmbeddingProjection(); expect(normal.points).toHaveLength(1); expect(normal.totalVectors).toBe(1); expect(normal.points[0]!.sectionNumber).toBe("8.04.010");
  setMode("slow-body"); const controller = new AbortController();
  const pending = Array.from({ length: 21 }, () => getEmbeddingProjection({ signal: controller.signal }));
  const settled = Promise.allSettled(pending);
  await Bun.sleep(35); expect(vectorGate.state).toEqual({ active: 4, queued: 16 });
  controller.abort(); const results = await settled;
  expect(results.every(row => row.status === "rejected")).toBe(true);
  expect(results.some(row => row.status === "rejected" && String(row.reason).includes("busy"))).toBe(true);
  expect(vectorGate.state).toEqual({ active: 0, queued: 0 });
}));
