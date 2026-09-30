import { describe, expect, test } from "bun:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { llmConfig } from "../src/llm/config.ts";
import { chatWithProviderFallback } from "../src/llm/provider.ts";
import { chat, streamChat, withProviderBudget, getOpenRouterRequestCount } from "../src/llm/openrouter.ts";
import { semanticSearch } from "../src/gui/semantic_search.ts";
import { indexSections } from "../src/llm/embeddings.ts";
import { llmHttpFixture } from "./helpers/llm-http.ts";
import { withEmptyCorpus, beginSeedCorpus, endCorpusCopy } from "./helpers/output-root.ts";
import { invalidateSectionsCache } from "../src/shared/data.ts";
import { reloadSearch, search } from "../src/gui/search.ts";
import { privateReceipt } from "../src/llm/privacy.ts";
import { queryStructured } from "../src/llm/structured.ts";
import { generationGate } from "../src/llm/runtime.ts";
import type { FlatSection } from "../src/types.ts";

async function providers<T>(task: (fixture: { bodies: Record<string, unknown>[]; setOpenRouter(status: number): void; setOllama(status: number): void; setStream(text: string): void }) => Promise<T>) {
  const bodies: Record<string, unknown>[] = []; let routerStatus = 200, ollamaStatus = 200, stream = "data: [DONE]";
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/models") return Response.json({ data: [{ id: "fixture-model" }] }, { status: routerStatus });
    if (path === "/api/tags") return Response.json({ models: [] }, { status: ollamaStatus });
    const body = await request.json() as Record<string, unknown>; bodies.push(body);
    if (path === "/chat/completions") return body.stream ? new Response(stream) : Response.json({ choices: [{ message: { content: "primary answer" } }] }, { status: routerStatus });
    if (path === "/api/chat") return Response.json({ message: { content: "secondary answer" } }, { status: ollamaStatus });
    return new Response(null, { status: 404 });
  } });
  const previous = { ...llmConfig }, key = process.env.OPENROUTER_API_KEY;
  Object.assign(llmConfig, { provider: "openrouter", openrouterUrl: `http://127.0.0.1:${server.port}`, ollamaUrl: `http://127.0.0.1:${server.port}`, openrouterMinRequestIntervalMs: 0 }); process.env.OPENROUTER_API_KEY = "local-fixture-key";
  try { return await withEmptyCorpus(() => task({ bodies, setOpenRouter: status => { routerStatus = status; }, setOllama: status => { ollamaStatus = status; }, setStream: text => { stream = text; } })); }
  finally { Object.assign(llmConfig, previous); if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key; server.stop(true); }
}

describe("provider outcome and operation budgets over real local HTTP", () => {
  test("cancelled structured work releases capacity without a repair request", async () => {
    let requests = 0, reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const server = Bun.serve({ port: 0, async fetch(request) {
      await request.json(); requests++; reached();
      await new Promise(resolve => setTimeout(resolve, 200));
      return Response.json({ message: { content: "malformed fixture response" } });
    } });
    const previous = { ...llmConfig }; Object.assign(llmConfig, { provider: "ollama", ollamaUrl: `http://127.0.0.1:${server.port}` });
    const controller = new AbortController();
    try {
      const pending = queryStructured("private fixture", { schemaHint: '{"ok":true}', signal: controller.signal });
      await started; controller.abort(); await expect(pending).rejects.toThrow();
      expect(requests).toBe(1); expect(generationGate.state).toEqual({ active: 0, queued: 0 });
    } finally { Object.assign(llmConfig, previous); server.stop(true); }
  });
  test("primary, secondary and deterministic outcomes identify the actual model and safe attempt chain", () => providers(async fixture => {
    const messages = [{ role: "user" as const, content: "What rates apply?" }];
    const first = await withProviderBudget(() => chatWithProviderFallback(messages, "Rates apply by council resolution.", "requested-model"));
    expect(first).toMatchObject({ outcome: "primary", providerUsed: "openrouter", model: "requested-model", attempts: ["openrouter"] });
    expect(fixture.bodies.at(-1)!.model).toBe("requested-model");
    fixture.setOpenRouter(503);
    const second = await withProviderBudget(() => chatWithProviderFallback(messages, "Rates apply by council resolution.", "secondary-override"));
    expect(second).toMatchObject({ outcome: "secondary", providerUsed: "ollama", model: "secondary-override", attempts: ["openrouter", "ollama"] });
    fixture.setOllama(503);
    const third = await withProviderBudget(() => chatWithProviderFallback(messages, "Rates apply by council resolution."));
    expect(third).toMatchObject({ outcome: "deterministic", providerUsed: "none", model: "deterministic-extract", attempts: ["openrouter", "ollama"] });
    expect(third.errors).toEqual(["openrouter: unavailable", "ollama: unavailable"]);
  }));
  test("concurrent API operations each own a request cap and one cannot reset another", () => providers(async () => {
    llmConfig.openrouterMaxRequestsPerRun = 1;
    const counts = await Promise.all(Array.from({ length: 3 }, () => withProviderBudget(async () => {
      await chat([{ role: "user", content: "first" }]);
      await expect(chat([{ role: "user", content: "second" }])).rejects.toThrow("cap exceeded");
      return getOpenRouterRequestCount();
    })));
    expect(counts).toEqual([1, 1, 1]);
  }));
  test("OpenRouter requires a terminal marker and accepts a final marker without newline", () => providers(async fixture => {
    for (const [row, completes] of [["data: [DONE]", true], ['data: {"choices":[{"delta":{"content":"partial"}}]}', false], ["data: invalid-json", false], ['data: {"error":{"message":"private secret"}}', false]] as const) {
      fixture.setStream(row);
      const consume = () => withProviderBudget(async () => { let text = ""; for await (const token of streamChat([{ role: "user", content: "question" }])) text += token; return text; });
      if (completes) expect(await consume()).toBe(""); else await expect(consume()).rejects.toThrow();
    }
  }));
});

describe("bounded search universe and diagnostic retention", () => {
  test("cancelled dependency preflights cannot silently start lexical fallback", async () => {
    const server = Bun.serve({ port: 0, async fetch() { await new Promise(resolve => setTimeout(resolve, 200)); return Response.json({ models: [] }); } });
    const previous = { ...llmConfig }; Object.assign(llmConfig, { chromaUrl: `http://127.0.0.1:${server.port}`, ollamaUrl: `http://127.0.0.1:${server.port}` });
    const controller = new AbortController();
    try {
      const pending = semanticSearch("private cancelled query", { signal: controller.signal });
      controller.abort(); await expect(pending).rejects.toThrow();
    } finally { Object.assign(llmConfig, previous); server.stop(true); }
  });
  test("semantic pages partition the same candidate set beyond default topK, with section dedupe", async () => {
    const http = llmHttpFixture(), previous = { ...llmConfig }; Object.assign(llmConfig, { chromaUrl: http.url, ollamaUrl: http.url });
    try { await withEmptyCorpus(async () => {
      const sections: FlatSection[] = Array.from({ length: 24 }, (_, i) => ({ guid: `s${i}`, number: `8.04.${String(i).padStart(3, "0")}`, title: "Rates", text: "Rates apply by resolution.", history: "", articleGuid: "a1", articleTitle: "Rates", articleNumber: "8.04" }));
      await indexSections(sections);
      const first = await semanticSearch("rates", { limit: 10 }), second = await semanticSearch("rates", { limit: 10, offset: 10 }), third = await semanticSearch("rates", { limit: 10, offset: 20 });
      expect(first.mode).toBe("semantic"); expect(first.total).toBe(24); expect(second.total).toBe(24); expect(third.results).toHaveLength(4);
      expect(new Set([...first.results, ...second.results, ...third.results].map(hit => hit.guid)).size).toBe(24);
      expect(first.totalKind).toBe("bounded-candidates"); expect(first.scoreSemantics).toContain("not probability");
    }); } finally { Object.assign(llmConfig, previous); http.server.stop(true); }
  });
  test("field selectors honor the same title/type filters over reviewed municipal text", async () => {
    // One zoning chapter and one competing title preserve filter discrimination
    // without materializing all 245 chapters for a field-selector contract.
    await beginSeedCorpus({ articleGuids: ["44241193", "44236160"] }); invalidateSectionsCache();
    try {
      await reloadSearch();
      for (const field of ["number", "title", "text"] as const) {
        const result = search(field === "number" ? "17" : "permit", { field, titleFilter: "17", typeFilter: "section", limit: 100 });
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.results.every(hit => /^17\./.test(hit.section.number.replace(/^§\s*/, "")))).toBe(true);
        expect(result.results.every(hit => hit.section.number.replace(/^§\s*/, "").split(".").length >= 3)).toBe(true);
      }
    } finally { await endCorpusCopy(); invalidateSectionsCache(); }
  });
  test("metadata receipt pruning caps history, removes expired/malformed records, and rejects extra content fields", () => withEmptyCorpus(async root => {
    const previous = process.env.CC_QUERY_LOGGING; process.env.CC_QUERY_LOGGING = "metadata";
    try {
      const path = `${root}/private/request-receipts.jsonl`; await mkdir(`${root}/private`);
      await writeFile(path, [JSON.stringify({ ts: "2000-01-01", kind: "rag", model: "expired" }), "malformed", ...Array.from({ length: 1005 }, (_, i) => JSON.stringify({ ts: new Date().toISOString(), kind: "search", resultCount: i }))].join("\n") + "\n");
      await privateReceipt("rag", { resultCount: 4, ...({ question: "private question" } as object) });
      const text = await readFile(path, "utf8"); expect(text.trim().split("\n")).toHaveLength(1000); expect(text).not.toMatch(/expired|malformed|private question/);
      expect(JSON.parse(text.trim().split("\n").at(-1)!)).toMatchObject({ kind: "rag", resultCount: 4 });
    } finally { if (previous === undefined) delete process.env.CC_QUERY_LOGGING; else process.env.CC_QUERY_LOGGING = previous; }
  }));
});
