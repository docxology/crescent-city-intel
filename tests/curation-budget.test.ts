import { expect, test } from "bun:test";
import { runCuration, gatherCurationInputs, CURATION_PROMPT_VERSION } from "../src/curation.ts";
import { llmConfig } from "../src/llm/config.ts";
import { paths } from "../src/shared/paths.ts";
import { writeJsonAtomic } from "../src/shared/source_health.ts";
import { withEmptyCorpus } from "./helpers/output-root.ts";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { acquireFileLease } from "../src/shared/storage.ts";
import { computeSha256 } from "../src/utils.ts";

test("document listings replace old generation with source-only custody and make no provider requests", async () => {
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname; requests.push(path);
    if (path === "/api/tags") return Response.json({ models: [] });
    const body = await request.json() as { messages: Array<{ content: string }> };
    const content = body.messages.some(message => message.content.includes("Return ONLY valid JSON"))
      ? JSON.stringify({ entityTags: [], topicTags: ["meeting"], salience: 0.2, salienceRationale: "A retained excerpt.", neutralSummary: "A retained source excerpt." })
      : "A retained source excerpt.";
    return Response.json({ message: { content } });
  } });
  const previous = { ...llmConfig }; Object.assign(llmConfig, { provider: "ollama", ollamaUrl: `http://127.0.0.1:${server.port}`, chatModel: "fixture-model" });
  try { await withEmptyCorpus(async () => {
    const inputPath = join(paths.govMeetings, "gov_meetings-fixture.json");
    const batch = { items: [{ recordKind: "meeting-document", title: "Minutes archive 2032.pdf", content: "Archive entry: Minutes archive 2032.pdf", link: "https://agency.example/archive/2032.pdf" }] };
    await writeJsonAtomic(inputPath, batch);
    const input = (await gatherCurationInputs())[0]!;
    expect(input.contentKind).toBe("document-listing"); expect(input.fetchedAt).toBe("unknown");
    const oldFingerprint = await computeSha256(JSON.stringify({ id: input.id, source: input.source, title: input.title, text: input.text, provider: "ollama", model: "fixture-model", promptVersion: CURATION_PROMPT_VERSION }));
    await writeJsonAtomic(paths.curationSeen, { [input.id]: { hash: oldFingerprint, firstSeen: "2026-09-30T00:00:00Z", lastSeen: "2026-09-30T00:00:00Z", meta: { provider: "ollama", model: "fixture-model", promptVersion: CURATION_PROMPT_VERSION, summaryStatus: "ok" } } });
    const rows = await runCuration({ deadlineMs: 2000 });
    expect(requests).toEqual([]); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contentKind: "document-listing", title: input.title, summaryStatus: "source_only", provider: "none", model: "document-listing/v1", retryable: false, sourceExcerpt: input.text,
      citations: [{ url: input.link, label: input.title, source: "gov_meetings", fetchedAt: "unknown" }] });
    expect(rows[0]!.summary).toBe(`Document listing; linked content not reviewed. Title: ${input.title}\nSource excerpt: ${input.text}`);
    expect(rows[0]!.inputFingerprint).not.toBe(oldFingerprint);
    expect(rows[0]!.provenance).toContain("fetchedAt=unknown"); expect(rows[0]!.entityTags).toBeUndefined();
    expect(await Bun.file(paths.curationReport).json()).toMatchObject({ provider: "none", providerChecked: false, providerReachable: false, attemptedCount: 1, succeededCount: 0, sourceOnlyCount: 1, retryableCount: 0, reusedCount: 0 });
    llmConfig.chatModel = "changed-model";
    expect(await runCuration({ deadlineMs: 2000 })).toEqual([]); expect(requests).toEqual([]);
    await rm(paths.curationSeen);
    expect(await runCuration({ deadlineMs: 2000 })).toEqual([]);
    expect(await Bun.file(paths.curationReport).json()).toMatchObject({ reusedCount: 1, attemptedCount: 0 }); expect(requests).toEqual([]);
    const artifact = join(paths.curated, `${new Date().toISOString().slice(0, 10)}.json`);
    await rm(paths.curationSeen); await writeJsonAtomic(artifact, [{ ...rows[0], summary: "Unsupported meeting outcome." }]);
    expect(await runCuration({ deadlineMs: 2000 })).toHaveLength(1); expect(requests).toEqual([]);
    batch.items[0]!.recordKind = "meeting"; await writeJsonAtomic(inputPath, batch);
    const generated = await runCuration({ deadlineMs: 2000 });
    expect(generated[0]!.summaryStatus).toBe("ok"); expect(generated[0]!.contentKind).toBeUndefined();
    const unchangedOrdinaryFingerprint = await computeSha256(JSON.stringify({ id: input.id, source: input.source, title: input.title, text: input.text, provider: "ollama", model: "changed-model", promptVersion: CURATION_PROMPT_VERSION }));
    expect(generated[0]!.inputFingerprint).toBe(unchangedOrdinaryFingerprint);
    expect(requests).toEqual(["/api/tags", "/api/chat", "/api/chat"]);
    expect(await Bun.file(paths.curationReport).json()).toMatchObject({ succeededCount: 1, sourceOnlyCount: 0, reusedCount: 0, providerChecked: true });
  }); } finally { Object.assign(llmConfig, previous); server.stop(true); }
}, 5000);

test("cancelled real provider work records failure, releases ownership and remains retryable", async () => {
  let stall = true, requests = 0;
  let reachedChat!: () => void;
  const startedChat = new Promise<void>(resolve => { reachedChat = resolve; });
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/tags") return Response.json({ models: [] });
    if (path === "/api/chat") {
      const body = await request.json() as { messages: Array<{ content: string }> };
      requests++; reachedChat();
      if (stall) await new Promise(resolve => setTimeout(resolve, 200));
      const structured = body.messages.some(message => message.content.includes("Return ONLY valid JSON"));
      const content = structured ? JSON.stringify({ entityTags: [], topicTags: ["meeting"], salience: 0.2,
        salienceRationale: "The source records a meeting agenda.", neutralSummary: "The source records a fixture meeting agenda." })
        : "The source records a fixture meeting agenda.";
      return Response.json({ message: { content } });
    }
    return new Response(null, { status: 404 });
  } });
  const previous = { ...llmConfig }; Object.assign(llmConfig, { provider: "ollama", ollamaUrl: `http://127.0.0.1:${server.port}` });
  try { await withEmptyCorpus(async () => {
    await writeJsonAtomic(join(paths.govMeetings, "gov_meetings-2026-09-30.json"), { fetchedAt: "2026-09-30T00:00:00Z", items: [{ title: "Fixture agenda", link: "https://agency.example/agenda", content: "The source records a fixture meeting agenda." }] });
    const controller = new AbortController();
    const pending = runCuration({ signal: controller.signal, deadlineMs: 2000 });
    await startedChat; controller.abort(); await expect(pending).rejects.toThrow();
    const attempt = await Bun.file(join(paths.state, "latest-curation-attempt.json")).json();
    expect(attempt).toMatchObject({ status: "failed", completedCount: 0, reason: "cancelled-or-deadline" });
    expect(JSON.stringify(attempt)).not.toContain("Fixture agenda");
    expect(await Bun.file(paths.curationSeen).exists()).toBe(false);
    stall = false;
    const retry = await runCuration({ deadlineMs: 2000 });
    expect(retry).toHaveLength(1); expect(retry[0]!.summaryStatus).toBe("ok");
    expect((await Bun.file(join(paths.state, "latest-curation-attempt.json")).json()).status).toBe("complete");
    const requestsBeforeNoop = requests;
    expect(await runCuration({ deadlineMs: 2000 })).toEqual([]);
    expect(requests).toBe(requestsBeforeNoop);
    const artifactPath = join(paths.curated, `${new Date().toISOString().slice(0, 10)}.json`);
    const original = await Bun.file(artifactPath).json();
    await writeJsonAtomic(join(paths.govMeetings, "gov_meetings-2026-09-30.json"), { fetchedAt: "2026-10-01T00:00:00Z", items: [{ title: "Fixture agenda", link: "https://agency.example/agenda", content: "The source records a fixture meeting agenda." }] });
    expect(await runCuration({ deadlineMs: 2000 })).toEqual([]); expect(requests).toBe(requestsBeforeNoop);
    expect(await Bun.file(artifactPath).json()).toEqual(original);
    expect(original[0].citations[0].fetchedAt).toBe("2026-09-30T00:00:00Z");
    await rm(artifactPath);
    const regenerated = await runCuration({ deadlineMs: 2000 });
    expect(regenerated).toHaveLength(1); expect(requests).toBeGreaterThan(requestsBeforeNoop);
    expect(regenerated[0]!.citations[0]!.fetchedAt).toBe("2026-10-01T00:00:00Z");
    const beforeInvalid = requests;
    await writeJsonAtomic(artifactPath, [{ ...regenerated[0], citations: [{ ...regenerated[0]!.citations[0], fetchedAt: "unknown" }] }]);
    expect(await runCuration({ deadlineMs: 2000 })).toHaveLength(1); expect(requests).toBeGreaterThan(beforeInvalid);
    const beforeAmbiguous = requests;
    const complete = await Bun.file(artifactPath).json(); await writeJsonAtomic(artifactPath, [...complete, ...complete]);
    expect(await runCuration({ deadlineMs: 2000 })).toHaveLength(1); expect(requests).toBeGreaterThan(beforeAmbiguous);
  }); } finally { Object.assign(llmConfig, previous); server.stop(true); }
}, 5000);

test("a real interrupted store commit recovers only exact retained lineage without another generation", async () => {
  let requests = 0;
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/tags") return Response.json({ models: [] });
    if (path === "/models") return Response.json({ data: [{ id: "fixture-model" }] });
    if (!["/api/chat", "/chat/completions"].includes(path)) return new Response(null, { status: 404 });
    const body = await request.json() as { messages: Array<{ content: string }> };
    requests++;
    const content = body.messages.some(message => message.content.includes("Return ONLY valid JSON"))
      ? JSON.stringify({ entityTags: [], topicTags: ["meeting"], salience: 0.2, salienceRationale: "A recorded agenda.", neutralSummary: "The source records a fixture agenda." })
      : "The source records a fixture agenda.";
    return path === "/api/chat" ? Response.json({ message: { content } }) : Response.json({ choices: [{ message: { content } }] });
  } });
  const previous = { ...llmConfig }, previousKey = process.env.OPENROUTER_API_KEY;
  Object.assign(llmConfig, { provider: "ollama", ollamaUrl: `http://127.0.0.1:${server.port}`, openrouterUrl: `http://127.0.0.1:${server.port}`, chatModel: "fixture-model", openrouterModel: "fixture-model", openrouterMinRequestIntervalMs: 0 });
  try { await withEmptyCorpus(async () => {
    const inputPath = join(paths.govMeetings, "gov_meetings-2026-09-30.json"), batch = { fetchedAt: "2026-09-30T00:00:00Z", items: [{ title: "Fixture agenda", link: "https://agency.example/agenda", content: "The source records a fixture agenda." }] };
    await writeJsonAtomic(inputPath, batch);
    const release = await acquireFileLease(`${paths.curationSeen}.lock`);
    try { await expect(runCuration({ deadlineMs: 250 })).rejects.toThrow(); } finally { await release(); }
    const artifactPath = join(paths.curated, `${new Date().toISOString().slice(0, 10)}.json`);
    const produced = await Bun.file(artifactPath).json();
    expect(produced).toHaveLength(1); expect(produced[0].summaryStatus).toBe("ok");
    expect(await Bun.file(paths.curationSeen).exists()).toBe(false);
    const beforeRecovery = requests;
    expect(await runCuration({ deadlineMs: 2000 })).toEqual([]);
    expect(requests).toBe(beforeRecovery);
    expect((await Bun.file(paths.curationReport).json())).toMatchObject({ reusedCount: 1, attemptedCount: 0, providerChecked: false });
    expect((await Bun.file(join(paths.state, "latest-curation-attempt.json")).json())).toMatchObject({ status: "complete", reusedCount: 1 });
    expect(await Bun.file(artifactPath).json()).toEqual(produced);

    for (const mutate of [
      (row: Record<string, unknown>) => { row.citations = [{ url: "https://other.example/changed" }]; },
      (row: Record<string, unknown>) => { row.summaryStatus = "source_only"; row.retryable = true; },
      (row: Record<string, unknown>) => { row.summary = ""; },
      (row: Record<string, unknown>) => { row.provenance = "changed provenance"; },
      (row: Record<string, unknown>) => { row.sourceExcerpt = "altered source text"; },
      (row: Record<string, unknown>) => { row.title = "altered source title"; },
      (row: Record<string, unknown>) => { row.source = "youtube"; },
      (row: Record<string, unknown>) => { row.promptVersion = "other-prompt-version"; },
    ]) {
      await rm(paths.curationSeen); const rows = structuredClone(produced); mutate(rows[0]); await writeJsonAtomic(artifactPath, rows);
      const before = requests; expect(await runCuration({ deadlineMs: 2000 })).toHaveLength(1); expect(requests).toBeGreaterThan(before);
      expect((await Bun.file(paths.curationReport).json()).reusedCount).toBe(0);
    }
    await rm(paths.curationSeen); await writeJsonAtomic(artifactPath, [...produced, { ...produced[0], summary: "A conflicting completed summary." }]);
    const ambiguousRequests = requests; expect(await runCuration({ deadlineMs: 2000 })).toHaveLength(1); expect(requests).toBeGreaterThan(ambiguousRequests);
    await rm(paths.curationSeen); await writeJsonAtomic(artifactPath, produced);
    batch.items[0]!.content = "The source records a changed fixture agenda."; await writeJsonAtomic(inputPath, batch);
    const changedRequests = requests; expect(await runCuration({ deadlineMs: 2000 })).toHaveLength(1); expect(requests).toBeGreaterThan(changedRequests);
    batch.items[0]!.content = "The source records a fixture agenda."; await writeJsonAtomic(inputPath, batch);
    await rm(paths.curationSeen); await writeJsonAtomic(artifactPath, produced); llmConfig.chatModel = "changed-model";
    const modelRequests = requests; expect(await runCuration({ deadlineMs: 2000 })).toHaveLength(1); expect(requests).toBeGreaterThan(modelRequests);
    await rm(paths.curationSeen); await writeJsonAtomic(artifactPath, produced); llmConfig.provider = "openrouter"; process.env.OPENROUTER_API_KEY = "local-fixture-key";
    const providerRequests = requests; expect(await runCuration({ deadlineMs: 2000 })).toHaveLength(1); expect(requests).toBeGreaterThan(providerRequests);
    await rm(paths.curationSeen); await Bun.write(artifactPath, "corrupt retained bytes");
    const corruptRequests = requests; await expect(runCuration({ deadlineMs: 2000 })).rejects.toThrow("corrupt"); expect(requests).toBe(corruptRequests);
    expect(await Bun.file(artifactPath).text()).toBe("corrupt retained bytes");
  }); } finally {
    Object.assign(llmConfig, previous); if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
    server.stop(true);
  }
}, 5000);
