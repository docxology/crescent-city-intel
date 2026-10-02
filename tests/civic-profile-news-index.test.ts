/** Synthetic second-locality diagnostics over real production HTTP/filesystem clients. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultCivicProfile, bindCivicOutputRoot, validateCivicProfile, withCivicProfile, civicProfileFingerprint } from "../src/civic_profile.ts";
import { withOutputRoot, paths } from "../src/shared/paths.ts";
import { llmConfig, currentIndexProfileIdentity } from "../src/llm/config.ts";
import { servingCollectionName, query, addDocuments, getDocuments } from "../src/llm/chroma.ts";
import { indexSections, indexAllSections, isIndexed } from "../src/llm/embeddings.ts";
import { buildIndexManifest, chunksForArticle, fingerprintChunks, indexConfigSignature, planIncrementalIndex, validateIndexProfileIdentity } from "../src/llm/index_plan.ts";
import { configuredNewsFeeds, fetchRSSFeedDetailed, monitorNews } from "../src/news_monitor.ts";
import { chat } from "../src/llm/ollama.ts";
import { initSearch, reloadSearch, search, getIndexedCount } from "../src/gui/search.ts";
import { bindArticleExtraction, custodyHash } from "../src/corpus_editions.ts";
import { invalidateSectionsCache, loadAllSections } from "../src/shared/data.ts";
import { llmHttpFixture } from "./helpers/llm-http.ts";
import { writeSeedCorpus } from "./helpers/output-root.ts";
import type { ArticlePage, FlatSection } from "../src/types.ts";

const second = validateCivicProfile({ ...defaultCivicProfile, id: "synthetic-river", name: "Synthetic River", municipality: "Synthetic River, IL", county: "Synthetic County", state: "Illinois", timeZone: "America/Chicago", anchor: { latitude: 41.5, longitude: -89, bounds: { west: -90, east: -88, south: 41, north: 42 } }, code: { provider: "ecode360", municipalityCode: "SY1234" }, corpusSlug: "synthetic-river-code", vectorNamespace: "synthetic-river-vectors", calendar: { uidDomain: "synthetic-river.example", productId: "-//Synthetic River Diagnostics//Events//EN" }, publication: { title: "Synthetic Civic Diagnostics", description: "Offline synthetic locality diagnostics", siteUrl: "https://synthetic.example", repositoryUrl: "https://example.org/synthetic" }, capabilities: ["ecode360", "news"] });
const section = (text: string): FlatSection => ({ guid: "shared-section", text, number: "1.2.3", title: "Rates", articleGuid: "shared-article", articleTitle: "Rates", articleNumber: "1.2", history: "" });
async function ownedRoots<T>(body: (first: string, alternate: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "cci-profile-index-")), first = join(root, "first"), alternate = join(root, "alternate");
  await mkdir(first); await mkdir(alternate);
  try { return await body(first, alternate); } finally { await rm(root, { recursive: true, force: true }); }
}
async function localVectors<T>(body: (http: ReturnType<typeof llmHttpFixture>) => Promise<T>): Promise<T> {
  const http = llmHttpFixture(), previous = { ollamaUrl: llmConfig.ollamaUrl, chromaUrl: llmConfig.chromaUrl };
  llmConfig.ollamaUrl = http.url; llmConfig.chromaUrl = http.url;
  try { return await body(http); } finally { Object.assign(llmConfig, previous); http.server.stop(true); }
}
const rss = '<rss><channel><item><title>Orchards restoration approved</title><link>https://synthetic.example/orchards</link><description>Fruit trees approved.</description></item><item><title>Crescent City harbor work</title><link>https://synthetic.example/harbor</link><description>Harbor maintenance.</description></item></channel></rss>';
async function writeSearchCorpus(root: string, text: string, municipalityCode: string): Promise<void> {
  await writeSeedCorpus(root, { articleCount: 1 });
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const guid = Object.keys(manifest.articles)[0], source = JSON.parse(await readFile(join(root, "articles", `${guid}.json`), "utf8")) as ArticlePage;
  const one = { ...source.sections[0], text, title: "Rates", history: "", html: `<span>${text}</span><div class="history"></div>` };
  const rawHtml = `<h2>Rates</h2><h3 id="${one.guid}_title">Rates</h3><div id="${one.guid}_content">${one.html}</div>`;
  const article = bindArticleExtraction({ ...source, title: "Rates", sections: [one], rawHtml, sha256: custodyHash(rawHtml) });
  await writeFile(join(root, "articles", `${guid}.json`), JSON.stringify(article));
  const municipality = municipalityCode === second.code!.municipalityCode ? second.municipality : defaultCivicProfile.municipality;
  await writeFile(join(root, "manifest.json"), JSON.stringify({ ...manifest, municipality, municipalityGuid: municipalityCode, sourceUrl: `https://ecode360.com/${municipalityCode}`, articlePageCount: 1, sectionCount: 1, articles: { [guid]: { ...manifest.articles[guid], sha256: article.sha256, sectionCount: 1 } } }));
  const toc = JSON.parse(await readFile(join(root, "toc.json"), "utf8"));
  await writeFile(join(root, "toc.json"), JSON.stringify({ ...toc, guid: municipalityCode, tocName: municipality }));
}

describe("context-owned search indexes", () => {
  test("a second-profile reader refuses a real foreign root even when its sections were cached", () => ownedRoots(async (first) => {
    await writeSearchCorpus(first, "firsttoken retained local fixture", "CR4919");
    invalidateSectionsCache();
    await withOutputRoot(first, async () => {
      expect(await loadAllSections()).toHaveLength(1);
      await withCivicProfile(second, async () => { await expect(loadAllSections()).rejects.toThrow(); await expect(initSearch()).rejects.toThrow(); });
      expect(await loadAllSections()).toHaveLength(1);
    });
    invalidateSectionsCache();
  }));
  test("interleaved real corpus loads with the same section IDs preserve each root/profile", () => ownedRoots(async (first, alternate) => {
    await writeSearchCorpus(first, "firsttoken distinct local text", "CR4919");
    await writeSearchCorpus(alternate, "secondtoken distinct local text", "SY1234");
    invalidateSectionsCache();
    let ready = 0, release!: () => void;
    const bothLoaded = new Promise<void>(resolve => { release = resolve; });
    const run = async (term: string, other: string) => {
      await initSearch(); if (++ready === 2) release(); await bothLoaded;
      expect(getIndexedCount()).toBe(1);
      expect(search(term).results[0].section.text).toContain(term);
      expect(search(other).results).toEqual([]);
      return search(term).results[0].section.guid;
    };
    const ids = await Promise.all([withOutputRoot(first, () => run("firsttoken", "secondtoken")), withCivicProfile(second, () => withOutputRoot(alternate, () => run("secondtoken", "firsttoken")))]);
    expect(ids[0]).toBe(ids[1]);
    await withOutputRoot(first, async () => {
      await withCivicProfile(second, () => withOutputRoot(alternate, () => reloadSearch()));
      expect(search("firsttoken").results[0].section.text).toContain("firsttoken");
    });
    invalidateSectionsCache();
  }));
});

describe("civic profile vector custody", () => {
  test("profile context changes namespace/signature without changing the default", () => {
    const signature = indexConfigSignature(llmConfig);
    expect(llmConfig.collectionName).toBe(defaultCivicProfile.vectorNamespace);
    withCivicProfile(second, () => {
      expect(llmConfig.collectionName).toBe(second.vectorNamespace);
      expect(indexConfigSignature(llmConfig)).not.toBe(signature);
      expect(() => { llmConfig.collectionName = defaultCivicProfile.vectorNamespace; }).toThrow("declared vector namespace");
    });
    expect(llmConfig.collectionName).toBe(defaultCivicProfile.vectorNamespace);
    expect(indexConfigSignature(llmConfig)).toBe(signature);
  });

  test("equal article IDs/text cannot make a different profile a planner no-op", async () => {
    const chunks = chunksForArticle(section("Identical fixture text."), text => [text]);
    const articles = [{ articleGuid: "shared-article", chunks, fingerprint: await fingerprintChunks(chunks) }];
    const previous = await buildIndexManifest({ articles, embeddingModel: llmConfig.embeddingModel, source: "synthetic-diagnostics", configSignature: indexConfigSignature(llmConfig), profileIdentity: currentIndexProfileIdentity() });
    withCivicProfile(second, () => {
      expect(validateIndexProfileIdentity(previous, currentIndexProfileIdentity())).toHaveLength(1);
      const plan = planIncrementalIndex(articles, previous, indexConfigSignature(llmConfig));
      expect(plan.noop).toBe(false); expect(plan.unchanged).toEqual([]); expect(plan.chunksToEmbed).toBe(1);
    });
  });

  test("real indexes with identical IDs keep separate text, receipts and records", () => ownedRoots((first, alternate) => localVectors(async http => {
    await withOutputRoot(first, () => indexSections([section("Crescent fixture rate is one.")]));
    const crescent = JSON.parse(await readFile(join(first, "state/index-manifest.json"), "utf8"));
    const beforeAlternate = http.requests.length;
    await withCivicProfile(second, () => withOutputRoot(alternate, async () => {
      await indexSections([section("Synthetic fixture rate is two.")]);
      const receipt = JSON.parse(await readFile(paths.indexManifest, "utf8"));
      expect(receipt).toMatchObject({ civicProfileId: second.id, civicProfileSha256: civicProfileFingerprint(second), vectorNamespace: second.vectorNamespace });
      expect(receipt.servingCollection).toStartWith(`${second.vectorNamespace}-stage-`);
      expect(receipt.servingCollection).not.toBe(crescent.servingCollection);
      expect((await query([1, 1, 1])).documents).toEqual(["1.2.3: Rates\nSynthetic fixture rate is two."]);
      expect((await getDocuments(["shared-section_0"])).metadatas[0]).toMatchObject({ civicProfileId: second.id, civicProfileSha256: civicProfileFingerprint(second) });
      expect(await isIndexed()).toBe(true);
      await indexSections([section("Synthetic fixture rate is three.")]);
      expect((await query([1, 1, 1])).documents[0]).toContain("three");
    }));
    expect(http.requests.slice(beforeAlternate).some(row => row.path.includes(crescent.servingCollection) || row.body.name === defaultCivicProfile.vectorNamespace)).toBe(false);
    expect(http.collections.get(crescent.servingCollection)!.get("shared-section_0")!.document).toContain("one");
    await withOutputRoot(first, async () => { expect((await query([1, 1, 1])).documents[0]).toContain("one"); expect(await isIndexed()).toBe(true); });
  })));

  test("wrong-profile receipt and explicit foreign collection fail before network", () => ownedRoots((first, alternate) => localVectors(async http => {
    await withOutputRoot(first, () => indexSections([section("Crescent fixture.")]));
    const foreignReceipt = await readFile(join(first, "state/index-manifest.json"), "utf8");
    await withCivicProfile(second, () => bindCivicOutputRoot(alternate)); await writeFile(join(alternate, "state/index-manifest.json"), foreignReceipt);
    const before = http.requests.length;
    await withCivicProfile(second, () => withOutputRoot(alternate, async () => {
      await expect(servingCollectionName()).rejects.toThrow("another civic profile");
      expect(await isIndexed()).toBe(false);
      await expect(query([1, 1, 1])).rejects.toThrow("another civic profile");
      await expect(indexSections([section("Synthetic fixture.")])).rejects.toThrow("another civic profile");
      await expect(query([1, 1, 1], 1, { collection: defaultCivicProfile.vectorNamespace })).rejects.toThrow("selected civic profile");
      await expect(addDocuments({ ids: ["foreign"], documents: ["Foreign fixture"], embeddings: [[1]], metadatas: [{ civicProfileId: defaultCivicProfile.id }] })).rejects.toThrow("another civic profile");
    }));
    expect(http.requests.length).toBe(before); expect(await readFile(join(alternate, "state/index-manifest.json"), "utf8")).toBe(foreignReceipt);
  })));

  test("a matching receipt cannot select a collection outside its namespace", () => ownedRoots((_first, alternate) => localVectors(async http => {
    await withCivicProfile(second, () => withOutputRoot(alternate, async () => {
      await bindCivicOutputRoot(alternate); await writeFile(paths.indexManifest, JSON.stringify({ ...currentIndexProfileIdentity(), servingCollection: defaultCivicProfile.vectorNamespace }));
      const before = http.requests.length;
      await expect(servingCollectionName()).rejects.toThrow("selected civic profile namespace");
      await expect(query([1])).rejects.toThrow("selected civic profile namespace");
      expect(http.requests.length).toBe(before);
    }));
  })));

  test("shared indexing refuses a bound foreign root before any provider request", () => ownedRoots((first) => localVectors(async http => {
    await bindCivicOutputRoot(first); const before = http.requests.length;
    await withCivicProfile(second, () => withOutputRoot(first, () => expect(indexSections([section("Foreign fixture.")])).rejects.toThrow("different civic profile")));
    expect(http.requests.length).toBe(before);
    expect(JSON.parse(await readFile(join(first, "state/civic-profile.json"), "utf8")).profileId).toBe(defaultCivicProfile.id);
  })));

  test("default readers reject explicitly foreign metadata while retaining legacy unbound records", () => ownedRoots((first) => localVectors(async http => {
    await withOutputRoot(first, async () => {
      await indexSections([section("Default fixture.")]);
      const active = await servingCollectionName(), record = http.collections.get(active)!.get("shared-section_0")!;
      const original = { ...record.metadata }; record.metadata = { ...original, civicProfileId: second.id, civicProfileSha256: civicProfileFingerprint(second), vectorNamespace: second.vectorNamespace };
      await expect(query([1])).rejects.toThrow("another civic profile");
      await expect(getDocuments([record.id])).rejects.toThrow("another civic profile");
      expect(await isIndexed()).toBe(false);
      record.metadata = { ...original }; delete record.metadata.civicProfileId; delete record.metadata.civicProfileSha256; delete record.metadata.vectorNamespace;
      expect((await query([1])).documents[0]).toContain("Default fixture.");
      expect(await isIndexed()).toBe(true);
    });
  })));

  test("stored foreign metadata is rejected rather than copied or returned", () => ownedRoots((_first, alternate) => localVectors(async http => {
    await withCivicProfile(second, () => withOutputRoot(alternate, async () => {
      await indexSections([section("Synthetic fixture.")]);
      const active = await servingCollectionName(), record = http.collections.get(active)!.get("shared-section_0")!;
      record.metadata = { ...record.metadata, civicProfileId: defaultCivicProfile.id };
      await expect(query([1])).rejects.toThrow("another civic profile");
      await expect(getDocuments([record.id])).rejects.toThrow("another civic profile");
      const previous = await readFile(paths.indexManifest, "utf8");
      await expect(indexSections([section("Synthetic fixture."), { ...section("Added synthetic fixture."), guid: "added", articleGuid: "added-article" }])).rejects.toThrow("another civic profile");
      expect(await readFile(paths.indexManifest, "utf8")).toBe(previous);
    }));
  })));

  test("default legacy receipt remains readable and is upgraded on the next index", () => ownedRoots((first) => localVectors(async http => {
    await withOutputRoot(first, async () => {
      await indexSections([section("Default compatibility fixture.")]);
      const receipt = JSON.parse(await readFile(paths.indexManifest, "utf8")), embeds = http.embedRequests;
      delete receipt.civicProfileId; delete receipt.civicProfileSha256; delete receipt.vectorNamespace;
      await writeFile(paths.indexManifest, JSON.stringify(receipt));
      expect(await servingCollectionName()).toBe(receipt.servingCollection);
      await indexSections([section("Default compatibility fixture.")]);
      const upgraded = JSON.parse(await readFile(paths.indexManifest, "utf8"));
      expect(upgraded).toMatchObject(currentIndexProfileIdentity()); expect(upgraded.servingCollection).not.toBe(receipt.servingCollection);
      expect(http.embedRequests).toBe(embeds);
    });
  })));

  test("a foreign municipal corpus is refused before any embed/vector request", () => ownedRoots((_first, alternate) => localVectors(async http => {
    await writeSeedCorpus(alternate, { articleCount: 1 });
    await withCivicProfile(second, () => withOutputRoot(alternate, async () => {
      await expect(indexAllSections()).rejects.toThrow("selected civic profile municipal-code adapter");
      expect(http.requests).toEqual([]);
    }));
  })));

  test("the direct local chat default names the selected municipality", () => localVectors(async http => {
    await withCivicProfile(second, () => chat([{ role: "user", content: "Synthetic fixture question" }], "Synthetic fixture context"));
    const messages = http.requests.at(-1)!.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain(second.municipality); expect(messages[0].content).not.toContain("Crescent City");
    expect(messages[0].content).toContain("Use only the provided context");
  }));
});

describe("explicit generic news policy", () => {
  test("a second profile has no implicit Crescent feed roster", () => ownedRoots((_first, alternate) => withCivicProfile(second, () => withOutputRoot(alternate, async () => {
    expect(configuredNewsFeeds()).toEqual({}); expect(await monitorNews()).toEqual([]);
    expect(JSON.parse(await readFile(paths.newsHealth, "utf8")).sources).toEqual([]);
  }))));

  test("custom feed URLs cannot borrow canonical source names or legacy identity", () => ownedRoots((first) => {
    let requests = 0; const server = Bun.serve({ port: 0, fetch: () => { requests++; return new Response(rss); } });
    return withOutputRoot(first, async () => {
      try {
        const url = `http://localhost:${server.port}/foreign-feed`, transport = { allowPrivateHosts: ["localhost"] };
        await expect(monitorNews(undefined, { feeds: { "Lost Coast Outpost": url }, transport })).rejects.toThrow("reviewed endpoint");
        await expect(fetchRSSFeedDetailed(url, "Lost Coast Outpost", transport)).rejects.toThrow("reviewed endpoint");
        expect(requests).toBe(0);
        const custom = await fetchRSSFeedDetailed(url, "City Council", transport, { keywords: ["orchards"] });
        expect(custom.health.sourceId).toStartWith("crescent-city-news-");
        expect(custom.health.sourceId).not.toBe("city-meetings-evogov");
      } finally { server.stop(true); }
    });
  }));

  test("custom additional keywords reach extraction and explicit keyword policy can replace defaults", () => ownedRoots((first) => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(rss) });
    const options = { feeds: { "Synthetic RSS diagnostics": `http://localhost:${server.port}/feed` }, transport: { allowPrivateHosts: ["localhost"] }, noDedup: true };
    return withOutputRoot(first, async () => {
      try {
        const additional = await monitorNews(["orchards"], options);
        expect(additional.map(item => item.title).sort()).toEqual(["Crescent City harbor work", "Orchards restoration approved"]);
        const explicit = await monitorNews(undefined, { ...options, keywords: ["orchards"] });
        expect(explicit.map(item => item.title)).toEqual(["Orchards restoration approved"]);
      } finally { server.stop(true); }
    });
  }));

  test("second-profile RSS and HTML fallback use the same configured keyword policy", () => ownedRoots((_first, alternate) => {
    const requests: string[] = [];
    const server = Bun.serve({ port: 0, fetch(request) {
      const path = new URL(request.url).pathname; requests.push(path);
      return path === "/feed" ? new Response(rss) : path === "/failure" ? new Response("unavailable", { status: 503 }) : new Response('<html><a href="/updates/orchards">Orchards restoration approved</a><a href="/updates/harbor">Crescent City harbor work</a></html>');
    } });
    return withCivicProfile(second, () => withOutputRoot(alternate, async () => {
      try {
        const transport = { allowPrivateHosts: ["localhost"] };
        const result = await fetchRSSFeedDetailed(`http://localhost:${server.port}/feed`, "Synthetic diagnostics", transport, { keywords: ["orchards"] });
        expect(result.items.map(item => item.title)).toEqual(["Orchards restoration approved"]); expect(result.health.status).toBe("ok"); expect(result.health.sourceId).toStartWith(`${second.id}-news-`);
        const fallback = await fetchRSSFeedDetailed(`http://localhost:${server.port}/failure`, "Synthetic diagnostics", transport, { keywords: ["orchards"], htmlFallback: { url: `http://localhost:${server.port}/listing`, articlePathIncludes: "/updates/" } });
        expect(fallback.items).toHaveLength(1); expect(fallback.items[0].link).toBe(`http://localhost:${server.port}/updates/orchards`); expect(fallback.health.status).toBe("ok"); expect(fallback.health.provenance).toContain("Configured HTML");
        expect(requests).toEqual(["/feed", "/failure", "/listing"]);
        const monitored = await monitorNews(undefined, { feeds: { "Synthetic diagnostics": `http://localhost:${server.port}/feed` }, keywords: ["orchards"], transport });
        expect(monitored.map(item => item.title)).toEqual(["Orchards restoration approved"]);
      } finally { server.stop(true); }
    }));
  }));

  test("explicit disabled feeds and cancellation do not make any requests", () => ownedRoots((_first, alternate) => {
    let requests = 0; const server = Bun.serve({ port: 0, fetch() { requests++; return new Response(rss); } });
    return withCivicProfile(second, () => withOutputRoot(alternate, async () => {
      try {
        const options = { feeds: { "Synthetic diagnostics": `http://localhost:${server.port}/feed` }, transport: { allowPrivateHosts: ["localhost"] }, disabledSources: ["Synthetic diagnostics"] };
        expect(await monitorNews(undefined, options)).toEqual([]);
        const health = JSON.parse(await readFile(paths.newsHealth, "utf8")); expect(health.sources[0].status).toBe("unavailable");
        await expect(monitorNews(undefined, { ...options, disabledSources: [], signal: AbortSignal.abort() })).rejects.toThrow();
        expect(requests).toBe(0);
      } finally { server.stop(true); }
    }));
  }));
});
