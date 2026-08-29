/** API route handlers for the GUI server */
import { join } from "path";
import { loadToc, loadArticle, loadSection, loadManifest, loadAllSections } from "../shared/data.js";
import { search, logSearchQuery, getIndexedCount, type PagedSearchResult } from "./search.js";
import { createLogger } from "../logger.js";
import { llmConfig } from "../llm/config.js";
import { paths } from "../shared/paths.js";
import { completeSourceHealth, EXPECTED_SOURCE_HEALTH, summarizeSourceHealth } from "../shared/source_health.js";
import { buildSourceDiscoveryReport, getSourceRegistry, sourceRegistryFingerprint } from "../source_registry.js";
import { buildAnalyticsOverview, readAnalyticsOverview } from "../analytics_backend.js";
import { domains } from "../domains.js";
import { buildGeoIntel } from "../geo.js";
import { buildGeoIntelSurface } from "../geo_view.js";

const log = createLogger("routes");

// ─── Dynamic LLM imports (graceful degradation) ─────────────────

/** Lazily load LLM modules — returns null if dependencies are unavailable */
async function loadLlmModules() {
  try {
    const [rag, ollama, chroma, embeddings, provider, analytics] = await Promise.all([
      import("../llm/rag.js"),
      import("../llm/ollama.js"),
      import("../llm/chroma.js"),
      import("../llm/embeddings.js"),
      import("../llm/provider.js"),
      import("./analytics.js"),
    ]);
    return { rag, ollama, chroma, embeddings, provider, analytics };
  } catch (err: any) {
    log.warn("LLM modules unavailable — chat/analytics/summarize disabled", { error: err.message });
    return null;
  }
}

let llmModules: Awaited<ReturnType<typeof loadLlmModules>> = null;
let llmModulesLoaded = false;
/** Set true only on a SUCCESSFUL load, so a transient first-load failure
 * (e.g. chromadb unavailable for a moment) is retried on the next request
 * instead of permanently disabling chat/analytics for the server's lifetime. */
let llmModulesLoadedOk = false;

/** Get LLM modules, loading once lazily (retrying after a failed load). */
async function getLlm() {
  if (!llmModulesLoadedOk || !llmModules) {
    llmModules = await loadLlmModules();
    llmModulesLoaded = true;
    if (llmModules) llmModulesLoadedOk = true;
  }
  return llmModules;
}

/**
 * Reset the OpenRouter per-run request budget at each top-level GUI request.
 * The counter otherwise accumulates across the whole server lifetime and, at
 * the 100/run cap, permanently locks every later generation until restart.
 * Curation batches (a separate `bun run curate` process) still bind the whole
 * batch to one budget — only the shared server is scoped per-request. GUI
 * request volume is separately bounded by the rate limiter.
 */
async function resetProviderBudget(): Promise<void> {
  if (llmConfig.provider !== "openrouter") return;
  try {
    const m = await import("../llm/openrouter.js");
    m.resetOpenRouterRequestCount();
  } catch { /* module unavailable — nothing to reset */ }
}

// ─── Cached alert-trend diagnostics for GET /api/health ──────────

/**
 * GET /api/health is polled by uptime checks, so it must not do unbounded
 * blocking I/O per request. `buildAlertAnalytics()` synchronously reads eight
 * JSONL history files; caching its derived trend summary keeps the endpoint
 * O(1) between refreshes. The window it describes is 30 days wide, so a 60s
 * TTL costs nothing in freshness.
 */
const HEALTH_TRENDS_TTL_MS = 60_000;

let healthTrendsCache: { computedAt: number; value: import("../alert_analytics.js").AlertTypeTrendSummary[] } | null = null;

/**
 * Trend summary for /api/health, recomputed at most once per TTL.
 * Returns null when analytics are unavailable — diagnostics never break liveness.
 */
export async function getHealthAlertTrends(): Promise<import("../alert_analytics.js").AlertTypeTrendSummary[] | null> {
  const now = Date.now();
  if (healthTrendsCache && now - healthTrendsCache.computedAt < HEALTH_TRENDS_TTL_MS) {
    return healthTrendsCache.value;
  }
  try {
    const { buildAlertAnalytics, computeAlertTypeTrends, summarizeAlertTypeTrends } = await import("../alert_analytics.js");
    const analytics = buildAlertAnalytics();
    const value = summarizeAlertTypeTrends(
      computeAlertTypeTrends(analytics.timeline, new Date(), { retainedFrom: analytics.timelineRetainedFrom }),
    );
    healthTrendsCache = { computedAt: now, value };
    return value;
  } catch {
    return healthTrendsCache?.value ?? null;
  }
}

/** Test hook: drop the cached trend summary so the next call recomputes. */
export function _resetHealthTrendsCache(): void {
  healthTrendsCache = null;
}

// ─── Route handler ───────────────────────────────────────────────

/** Route an API request and return a Response */
export async function handleApiRoute(url: URL, req?: Request): Promise<Response> {
  const path = url.pathname;
  const start = performance.now();

  let response: Response;
  try {
    response = await routeRequest(path, url, req);
  } catch (err: any) {
    log.error(`Unhandled error on ${path}`, { error: err.message });
    response = json({ error: "Internal server error" }, 500);
  }

  const ms = (performance.now() - start).toFixed(1);
  log.debug(`${path} -> ${response.status} (${ms}ms)`);
  return response;
}

async function routeRequest(path: string, url: URL, req?: Request): Promise<Response> {
  // GET /api/toc
  if (path === "/api/toc") {
    try {
      const toc = await loadToc();
      return jsonWithETag(toc, req);
    } catch {
      return json({ error: "TOC not found. Run the scraper first." }, 404);
    }
  }

  // GET /api/article/:guid
  const articleMatch = path.match(/^\/api\/article\/([a-zA-Z0-9_-]+)$/);
  if (articleMatch) {
    try {
      const article = await loadArticle(articleMatch[1]);
      return json(article);
    } catch (err) {
      log.error(`Error loading article ${articleMatch[1]}`, { error: String(err) });
      return json({ error: "Article not found" }, 404);
    }
  }

  // GET /api/section/:guid
  const sectionMatch = path.match(/^\/api\/section\/([a-zA-Z0-9_-]+)$/);
  if (sectionMatch) {
    try {
      const section = await loadSection(sectionMatch[1]);
      if (!section) return json({ error: "Section not found" }, 404);
      return json(section);
    } catch (err) {
      log.error(`Error loading section ${sectionMatch[1]}`, { error: String(err) });
      return json({ error: "Section not found" }, 404);
    }
  }

  // GET /api/search — BM25 full-text search with pagination
  if (path === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10) || 50;
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10) || 0;
    const titleFilter = url.searchParams.get("title") ?? undefined;
    const highlight = url.searchParams.get("highlight") === "true";
    const typeFilter = url.searchParams.get("type") as "article" | "section" | undefined;
    const field = url.searchParams.get("field") as "number" | "text" | "title" | undefined;
    const paged: PagedSearchResult = search(q, { limit, offset, titleFilter, highlight, typeFilter, field });
    // Query logging is an HTTP-layer concern (see src/gui/search.ts): a library
    // call must not append to the analytics corpus.
    logSearchQuery(q, paged.total);
    return json({
      query: q,
      total: paged.total,
      offset: paged.offset,
      limit: paged.limit,
      count: paged.results.length,
      results: paged.results,
    });
  }

  // GET /api/search/semantic — embedding search with graceful BM25 fallback.
  // Uses the vector stack (Ollama embed + ChromaDB) when running; degrades to
  // the BM25 index when it is not, so the endpoint never hard-fails.
  if (path === "/api/search/semantic") {
    const q = url.searchParams.get("q") ?? "";
    if (!q.trim()) return json({ error: "No query provided" }, 400);
    try {
      const { semanticSearch } = await import("./semantic_search.js");
      const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20);
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
      const result = await semanticSearch(q, { limit, offset });
      return json(result);
    } catch (err: any) {
      return json({ error: `Semantic search failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/sections — hierarchical section listing with optional title/chapter filter
  if (path === "/api/sections") {
    try {
      const titleParam = url.searchParams.get("title"); // e.g. "8"
      const chapterParam = url.searchParams.get("chapter"); // e.g. "04"
      const limitParam = Math.min(500, parseInt(url.searchParams.get("limit") ?? "100", 10));

      const all = await loadAllSections();
      let filtered = all;

      if (titleParam) {
        filtered = filtered.filter(s => {
          const num = s.number.replace(/§\s*/, "").trim();
          return num.startsWith(titleParam + ".") || num.startsWith(titleParam + " ");
        });
      }

      if (chapterParam) {
        filtered = filtered.filter(s => {
          const num = s.number.replace(/§\s*/, "").trim();
          // Match e.g. "8.04." — title.chapter prefix
          const prefix = titleParam ? `${titleParam}.${chapterParam}` : chapterParam;
          return num.startsWith(prefix + ".") || num.startsWith(prefix + " ");
        });
      }

      const page = filtered.slice(0, limitParam);
      return json({
        title: titleParam ?? null,
        chapter: chapterParam ?? null,
        total: filtered.length,
        count: page.length,
        sections: page.map(s => ({
          guid: s.guid,
          number: s.number,
          title: s.title,
          articleTitle: s.articleTitle,
          textLength: s.text.length,
        })),
      });
    } catch (err: any) {
      return json({ error: `Failed to load sections: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/stats
  if (path === "/api/stats") {
    try {
      const manifest = await loadManifest();
      const statsData = {
        municipality: manifest.municipality,
        articleCount: Object.keys(manifest.articles).length,
        sectionCount: manifest.sectionCount,
        tocNodeCount: manifest.tocNodeCount,
        indexedSections: getIndexedCount(),
        scrapedAt: manifest.scrapedAt,
        completedAt: manifest.completedAt,
      };
      return jsonWithETag(statsData, req);
    } catch {
      return json({ error: "Manifest not found. Run the scraper first." }, 404);
    }
  }

  // GET /api/analytics/overview — shared deterministic analytics envelope.
  // Prefer the durable weekly artifact; a read-only fallback keeps the local
  // GUI useful before the first scheduled run without invoking an LLM from a
  // GET request.
  if (path === "/api/analytics/overview") {
    try {
      const overview = await readAnalyticsOverview() ?? await buildAnalyticsOverview();
      return jsonWithETag(overview, req);
    } catch (err: any) {
      log.error("[analytics] Overview error", { error: err.message });
      return json({ error: `Failed to build analytics overview: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/stats/count — lightweight section count (no full section load)
  if (path === "/api/stats/count") {
    try {
      const manifest = await loadManifest();
      return json({ count: manifest.sectionCount });
    } catch {
      return json({ error: "Manifest not found. Run the scraper first." }, 404);
    }
  }

  // GET /api/llm/usage — token-usage accounting summary (no LLM call)
  if (path === "/api/llm/usage") {
    try {
      const usage = await import("../llm/usage.js");
      return json(usage.getLlmUsageSummary());
    } catch (err: any) {
      log.error("[llm-usage] failed", { error: err.message });
      return json({ error: "LLM usage module unavailable" }, 503);
    }
  }

  // ─── LLM-dependent routes ────────────────────────────────────

  // GET /api/chat — RAG query (with optional model override)
  // Note: must not match POST /api/chat below — that path carries a JSON body,
  // not a `q` query param, and needs its own handler further down.
  if (path === "/api/chat" && req?.method !== "POST") {
    await resetProviderBudget();
    const q = url.searchParams.get("q") ?? "";
    const modelOverride = url.searchParams.get("model") ?? undefined;
    if (!q.trim()) {
      return json({ error: "No question provided" }, 400);
    }

    const llm = await getLlm();
    if (!llm) {
      return json({ error: "LLM modules unavailable. Install chromadb package and restart." }, 503);
    }

    try {
      const provider = await llm.provider.checkChatProvider();
      if (!provider.configured || !provider.reachable) {
        return json({ error: provider.error ?? `${provider.provider} chat provider is unavailable`, provider: provider.provider, model: provider.model }, 503);
      }
      const ollama = await llm.ollama.isOllamaRunning();
      if (!ollama) {
        return json({ error: "Ollama is not running. Start it with: ollama serve" }, 503);
      }
      const chroma = await llm.chroma.isChromaRunning();
      if (!chroma) {
        return json({ error: "ChromaDB is not running. Start it with: chroma run --path chroma_data" }, 503);
      }
      const indexed = await llm.embeddings.isIndexed();
      if (!indexed) {
        return json({ error: "No documents indexed. Run: bun run index" }, 503);
      }

      log.info(`[chat] Query: ${q}`);
      const result = await llm.rag.ragQuery(q, modelOverride);

      return json({
        answer: result.answer,
        sources: result.sources,
        model: result.model,
        provider: result.provider,
        queryId: result.queryId,
        metadata: result.metadata,
      });
    } catch (err: any) {
      log.error("[chat] RAG error", { error: err.message });
      return json({ error: `RAG query failed: ${publicApiDetail(err.message)}` }, dependencyFailureStatus(err.message));
    }
  }
  // POST /api/chat — RAG query via JSON body (for longer questions)
  if (path === "/api/chat" && req?.method === "POST") {
    await resetProviderBudget();
    let body: { q?: string; context?: string; model?: string; history?: Array<{ role: "user" | "assistant"; content: string }> } = {};
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const q = (body.q ?? "").trim();
    if (!q) return json({ error: "No question provided (field 'q' required)" }, 400);

    const llm = await getLlm();
    if (!llm) return json({ error: "LLM modules unavailable" }, 503);

    try {
      const provider = await llm.provider.checkChatProvider();
      if (!provider.configured || !provider.reachable) {
        return json({ error: provider.error ?? `${provider.provider} chat provider is unavailable`, provider: provider.provider, model: provider.model }, 503);
      }
      const ollama = await llm.ollama.isOllamaRunning();
      if (!ollama) return json({ error: "Ollama is not running. Start: ollama serve" }, 503);
      const chroma = await llm.chroma.isChromaRunning();
      if (!chroma) return json({ error: "ChromaDB is not running. Start: chroma run --path chroma_data" }, 503);
      const indexed = await llm.embeddings.isIndexed();
      if (!indexed) return json({ error: "No documents indexed. Run: bun run index" }, 503);

      log.info(`[chat POST] Query: ${q.substring(0, 80)}`);
      const result = await llm.rag.ragQuery(q, body.model, body.history);
      return json({ answer: result.answer, sources: result.sources, model: result.model, provider: result.provider, queryId: result.queryId, metadata: result.metadata });
    } catch (err: any) {
      log.error("[chat POST] RAG error", { error: err.message });
      return json({ error: `RAG query failed: ${publicApiDetail(err.message)}` }, dependencyFailureStatus(err.message));
    }
  }


  if (path === "/api/analytics/stats") {
    const llm = await getLlm();
    if (!llm) {
      return json({ error: "Analytics modules unavailable" }, 503);
    }
    try {
      log.info("[analytics] Computing code stats...");
      const stats = await llm.analytics.getCodeStats();
      log.info(`[analytics] Stats computed: ${stats.totalSections} sections, ${stats.totalWords} words`);
      return json(stats);
    } catch (err: any) {
      log.error("[analytics] Stats error", { error: err.message });
      return json({ error: `Failed to compute stats: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/analytics/embeddings — PCA projection
  if (path === "/api/analytics/embeddings") {
    const llm = await getLlm();
    if (!llm) {
      return json({ error: "Analytics modules unavailable" }, 503);
    }
    try {
      const chroma = await llm.chroma.isChromaRunning();
      if (!chroma) {
        return json({ error: "ChromaDB is not running" }, 503);
      }
      log.info("[analytics] Computing PCA projection...");
      const projection = await llm.analytics.getEmbeddingProjection();
      log.info(`[analytics] PCA computed: ${projection.points.length} points`);
      return json(projection);
    } catch (err: any) {
      log.error("[analytics] Embeddings error", { error: err.message });
      return json({ error: `Failed to compute projection: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // POST /api/summarize — summarize a section using Ollama
  if (path === "/api/summarize") {
    await resetProviderBudget();
    const llm = await getLlm();
    if (!llm) {
      return json({ error: "LLM modules unavailable" }, 503);
    }
    try {
      const provider = await llm.provider.checkChatProvider();
      if (!provider.configured || !provider.reachable) {
        return json({ error: provider.error ?? `${provider.provider} chat provider is unavailable`, provider: provider.provider, model: provider.model }, 503);
      }

      const body = req ? await req.json() : {};
      const { text, number, title } = body;
      if (!text || !text.trim()) {
        return json({ error: "No text provided to summarize" }, 400);
      }

      log.info(`[summarize] Summarizing: ${number} — ${title}`);

      const summary = await llm.provider.chatWithProvider(
        [{ role: "user", content: `Summarize the following municipal code section comprehensively.\n\nSection: ${number}: ${title}\n\nText:\n${text.substring(0, 8000)}` }],
        "You are a legal analysis assistant specializing in municipal code. " +
        "Provide a clear, comprehensive summary that covers: " +
        "(1) Key provisions and requirements, " +
        "(2) Practical implications for residents, businesses, or developers, " +
        "(3) Enforcement mechanisms or penalties if applicable, " +
        "(4) Notable definitions or exceptions. " +
        "Be thorough but concise. Use bullet points where appropriate.",
      );

      log.info(`[summarize] Summary generated for ${number} (${summary.length} chars)`);
      return json({ summary, model: llm.provider.configuredChatModel(), provider: llm.provider.configuredChatProvider() });
    } catch (err: any) {
      log.error("[summarize] Error", { error: err.message });
      return json({ error: `Summarization failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // ─── Intelligence Domain routes ──────────────────────────────

  // GET /api/readability — Flesch-Kincaid grade level for all sections
  if (path === "/api/readability") {
    try {
      const { existsSync } = await import("fs");
      const { readFile } = await import("fs/promises");
      if (existsSync("output/readability.json")) {
        return jsonWithETag(
          JSON.parse(await readFile("output/readability.json", "utf-8")),
          req
        );
      }
      const { scoreCorpusReadability } = await import("../shared/readability.js");
      const all = await loadAllSections();
      const scored = scoreCorpusReadability(all);
      const avg = scored.length > 0
        ? Math.round(scored.reduce((s, r) => s + r.score.gradeLevel, 0) / scored.length * 10) / 10
        : 0;
      const payload = {
        computedAt: new Date().toISOString(),
        totalSections: all.length,
        scored: scored.length,
        averageGradeLevel: avg,
        hardestSections: scored.slice(0, 10),
        easiestSections: scored.slice(-10).reverse(),
      };
      return jsonWithETag(payload, req);
    } catch (err: any) {
      return json({ error: `Readability scoring failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/domains/coverage — domain cross-reference coverage metrics
  if (path === "/api/domains/coverage") {
    try {
      const { existsSync } = await import("fs");
      const { readFile } = await import("fs/promises");
      if (existsSync("output/domain-coverage.json")) {
        return jsonWithETag(
          JSON.parse(await readFile("output/domain-coverage.json", "utf-8")),
          req
        );
      }
      const { computeDomainCoverage } = await import("../domains/coverage.js");
      return jsonWithETag(await computeDomainCoverage(), req);
    } catch (err: any) {
      return json({ error: `Coverage computation failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/domains — list all intelligence domains
  if (path === "/api/domains") {
    const { getDomainSummaries } = await import("../domains.js");
    return json(getDomainSummaries());
  }

  // GET /api/geo-intel — Crescent City civic + hazard geo-intel contract and
  // its map-ready feature view. Built purely from the in-repo 12-domain surface
  // (no output/ or scraper run required), so it is always available and
  // deterministic. The `view` field is `buildGeoView` output: a Del Norte
  // bounds polygon + city anchor + one point per hazard-relevant domain +
  // aggregated municipal-code section refs — renderable without a tiles provider.
  if (path === "/api/geo-intel") {
    const contract = buildGeoIntel(domains);
    return json(buildGeoIntelSurface(contract));
  }

  // GET /api/domain/:id — get a specific domain with all topics
  const domainMatch = path.match(/^\/api\/domain\/([a-z-]+)$/);
  if (domainMatch) {
    const { getDomainById } = await import("../domains.js");
    const domain = getDomainById(domainMatch[1]);
    if (!domain) {
      return json({ error: `Domain "${domainMatch[1]}" not found` }, 404);
    }
    return json(domain);
  }

  // GET /api/domains/search?q=... — search across domains
  if (path === "/api/domains/search") {
    const q = url.searchParams.get("q") ?? "";
    if (!q.trim()) return json({ error: "No query" }, 400);
    const { searchDomains } = await import("../domains.js");
    const results = searchDomains(q);
    return json({ query: q, count: results.length, domains: results });
  }

  // GET /api/toc/breadcrumb?guid=... — return full ancestry path for a TOC node
  if (path === "/api/toc/breadcrumb") {
    const guid = url.searchParams.get("guid") ?? "";
    if (!guid.trim()) return json({ error: "No guid provided" }, 400);
    try {
      const toc = await loadToc();

      type Crumb = { guid: string; title: string; type: string; level: number };

      /** Recursively find the path from root to target guid */
      function findPath(
        nodes: any[],
        targetGuid: string,
        path: Crumb[],
        level: number
      ): Crumb[] | null {
        for (const node of nodes) {
          const current: Crumb = {
            guid: node.guid ?? node.id ?? "",
            title: node.title ?? node.label ?? "(untitled)",
            type: node.type ?? "node",
            level,
          };
          if (current.guid === targetGuid) return [...path, current];
          if (node.children?.length > 0) {
            const found = findPath(node.children, targetGuid, [...path, current], level + 1);
            if (found) return found;
          }
        }
        return null;
      }

      const rootNodes = Array.isArray(toc) ? toc : (toc.children ?? [toc]);
      const breadcrumb = findPath(rootNodes, guid, [], 0);

      if (!breadcrumb) {
        return json({ error: `GUID "${guid}" not found in TOC` }, 404);
      }

      return json({ guid, breadcrumb, depth: breadcrumb.length });
    } catch (err: any) {
      log.error("[toc] breadcrumb failed", { error: err.message });
      // A missing TOC artifact is an absent input, not a server defect: 503 says
      // "this edition cannot answer that", which is what is actually true.
      const absent = /enoent|no such file|not found|missing/i.test(String(err?.message ?? ""));
      return json({ error: `TOC breadcrumb unavailable: ${publicApiDetail(err.message)}` }, absent ? 503 : 500);
    }
  }

  // GET /api/domain/:id/search?q=... — BM25 search scoped to a domain's sections
  const domainSearchMatch = path.match(/^\/api\/domain\/([a-z-]+)\/search$/);
  if (domainSearchMatch) {
    const q = url.searchParams.get("q") ?? "";
    if (!q.trim()) return json({ error: "No query provided" }, 400);
    const domainId = domainSearchMatch[1];
    const { getDomainById } = await import("../domains.js");
    const domain = getDomainById(domainId);
    if (!domain) return json({ error: `Domain "${domainId}" not found` }, 404);

    // Build allowlist of section number prefixes from domain topic sources
    const sectionPrefixes = new Set<string>(
      domain.topics.flatMap(t =>
        t.sources.map(s => s.sectionNumber.replace(/[§\s]/g, "").trim())
      )
    );

    // Run BM25 search then filter to domain sections
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "20", 10));
    const highlight = url.searchParams.get("highlight") === "true";
    const paged = search(q, { limit: 500, highlight });

    // Filter results to those whose section number matches a domain source prefix
    const domainResults = paged.results.filter(r => {
      const num = r.section.number.replace(/[§\s]/g, "").trim();
      return [...sectionPrefixes].some(p => num.startsWith(p.split(".").slice(0, 2).join(".")));
    }).slice(0, limit);

    return json({
      domain: domainId,
      query: q,
      total: domainResults.length,
      results: domainResults,
    });
  }

  // GET /api/domain/:id/sections — cross-reference domain topics to code sections
  const domainSectionsMatch = path.match(/^\/api\/domain\/([a-z-]+)\/sections$/);
  if (domainSectionsMatch) {
    const { getDomainById } = await import("../domains.js");
    const domain = getDomainById(domainSectionsMatch[1]);
    if (!domain) return json({ error: `Domain "${domainSectionsMatch[1]}" not found` }, 404);

    // Gather all unique section numbers referenced by this domain's topics
    const sectionNumbers = new Set<string>();
    for (const topic of domain.topics) {
      for (const src of topic.sources) sectionNumbers.add(src.sectionNumber);
    }

    // Build a cross-reference map: sectionNumber → topics that reference it
    const xref: Array<{ sectionNumber: string; topics: string[]; relevance: string[] }> = [];
    for (const num of [...sectionNumbers].sort()) {
      const refs = domain.topics.flatMap(t =>
        t.sources
          .filter(s => s.sectionNumber === num)
          .map(s => ({ topic: t.name, relevance: s.relevance }))
      );
      xref.push({
        sectionNumber: num,
        topics: refs.map(r => r.topic),
        relevance: refs.map(r => r.relevance),
      });
    }

    return json({
      domainId: domain.id,
      domainName: domain.name,
      sectionCount: sectionNumbers.size,
      crossReferences: xref,
    });
  }

  // GET /api/monitor/status — last change-detection report
  if (path === "/api/monitor/status") {
    try {
      const { readFile } = await import("fs/promises");
      const { existsSync } = await import("fs");
      const reportPath = paths.monitorReport;
      if (!existsSync(reportPath)) {
        return json({ error: "No monitor report. Run: bun run monitor" }, 404);
      }
      const report = JSON.parse(await readFile(reportPath, "utf-8"));
      return json(report);
    } catch (err: any) {
      return json({ error: `Failed to read monitor report: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/curated — recent LLM-curated items across news/gov-meetings/youtube
  if (path === "/api/curated") {
    try {
      const { readFile, readdir } = await import("fs/promises");
      const { existsSync } = await import("fs");
      const curatedDir = "output/curated";
      if (!existsSync(curatedDir)) {
        return json({ items: [], count: 0, error: "No curated output yet. Run: bun run curate" });
      }

      const files = (await readdir(curatedDir))
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse(); // most recent date first

      const limit = Math.min(200, parseInt(url.searchParams.get("limit") ?? "50", 10));
      const items: any[] = [];
      for (const f of files) {
        if (items.length >= limit) break;
        const raw = await readFile(`${curatedDir}/${f}`, "utf-8");
        const dayItems = JSON.parse(raw);
        if (!Array.isArray(dayItems)) continue; // defensive: skip a malformed/unexpected file rather than 500
        items.push(...dayItems.slice().reverse()); // most recent within a day first
      }

      return json({ items: items.slice(0, limit), count: items.length });
    } catch (err: any) {
      return json({ error: `Failed to read curated output: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/curation/status — last batch metadata, provider state, and retry counts
  if (path === "/api/curation/status") {
    const { existsSync, readFileSync } = await import("fs");
    if (!existsSync(paths.curationReport)) {
      return json({ status: "unavailable", error: "No curation run metadata. Run: bun run curate" }, 404);
    }
    try {
      return json(JSON.parse(readFileSync(paths.curationReport, "utf8")));
    } catch (err: any) {
      return json({ error: `Failed to read curation metadata: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/monitor/history — historical monitor runs (appended JSONL)
  if (path === "/api/monitor/history") {
    try {
      const { readFile } = await import("fs/promises");
      const { existsSync } = await import("fs");
      const histPath = `${paths.output}/monitor-history.jsonl`;
      if (!existsSync(histPath)) return json({ history: [], count: 0 });

      const raw = await readFile(histPath, "utf-8");
      const history = raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .reverse(); // most recent first

      const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "20", 10));
      return json({ history: history.slice(0, limit), count: history.length });
    } catch (err: any) {
      return json({ error: `Failed to read monitor history: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/monitor/alerts — latest entry from each of 8 alert monitors
  if (path === "/api/monitor/alerts") {
    const { existsSync } = await import("fs");
    const { readdir, readFile } = await import("fs/promises");
    const alertTypes = ["tsunami", "earthquake", "weather", "tides", "fishing", "airquality", "wildfire", "marine"];
    const alerts: Record<string, unknown> = {};

    for (const type of alertTypes) {
      const searchDir = type === "tides" ? "output/tides" : type === "fishing" ? "output/fishing" : `output/alerts/${type}`;
      if (!existsSync(searchDir)) { alerts[type] = null; continue; }
      try {
        const files = (await readdir(searchDir))
          .filter(f => f.endsWith(".json"))
          .sort()
          .reverse();
        if (files.length === 0) { alerts[type] = null; continue; }
        alerts[type] = JSON.parse(await readFile(`${searchDir}/${files[0]}`, "utf-8"));
      } catch {
        alerts[type] = null;
      }
    }

    // Also include composite severity if available
    const compositePath = "output/alerts/composite/current.json";
    if (existsSync(compositePath)) {
      try {
        alerts["composite"] = JSON.parse(await readFile(compositePath, "utf-8"));
      } catch { alerts["composite"] = null; }
    }

    if (existsSync(paths.alertsHealth)) {
      try { alerts["sourceHealth"] = JSON.parse(await readFile(paths.alertsHealth, "utf-8")); }
      catch { alerts["sourceHealth"] = null; }
    }

    return json({ fetchedAt: new Date().toISOString(), alerts });
  }

  // GET /api/alerts/airquality — current air quality reading
  if (path === "/api/alerts/airquality") {
    const { existsSync, readFileSync } = await import("fs");
    const filePath = "output/alerts/airquality/current.json";
    if (!existsSync(filePath)) return json({ error: "No air quality data. Run: bun run alerts:airquality" }, 404);
    try { return json(JSON.parse(readFileSync(filePath, "utf-8"))); }
    catch (err: any) { return json({ error: `Failed to read: ${publicApiDetail(err.message)}` }, 500); }
  }

  // GET /api/alerts/wildfire — current wildfire report
  if (path === "/api/alerts/wildfire") {
    const { existsSync, readFileSync } = await import("fs");
    const filePath = "output/alerts/wildfire/current.json";
    if (!existsSync(filePath)) return json({ error: "No wildfire data. Run: bun run alerts:wildfire" }, 404);
    try { return json(JSON.parse(readFileSync(filePath, "utf-8"))); }
    catch (err: any) { return json({ error: `Failed to read: ${publicApiDetail(err.message)}` }, 500); }
  }

  // GET /api/alerts/marine — current marine buoy report
  if (path === "/api/alerts/marine") {
    const { existsSync, readFileSync } = await import("fs");
    const filePath = "output/alerts/marine/current.json";
    if (!existsSync(filePath)) return json({ error: "No marine data. Run: bun run alerts:marine" }, 404);
    try { return json(JSON.parse(readFileSync(filePath, "utf-8"))); }
    catch (err: any) { return json({ error: `Failed to read: ${publicApiDetail(err.message)}` }, 500); }
  }

  // GET /api/alerts/composite — composite 8-monitor severity
  if (path === "/api/alerts/composite") {
    const { existsSync, readFileSync } = await import("fs");
    const filePath = "output/alerts/composite/current.json";
    if (!existsSync(filePath)) return json({ error: "No composite severity. Run: bun run alerts" }, 404);
    try { return json(JSON.parse(readFileSync(filePath, "utf-8"))); }
    catch (err: any) { return json({ error: `Failed to read: ${publicApiDetail(err.message)}` }, 500); }
  }

  // GET /api/openapi.yaml — OpenAPI specification
  if (path === "/api/openapi.yaml") {
    try {
      const { readFile } = await import("fs/promises");
      const { existsSync } = await import("fs");
      const specPath = join(process.cwd(), "openapi.yaml");
      if (!existsSync(specPath)) {
        return json({ error: "OpenAPI specification not found" }, 404);
      }
      const spec = await readFile(specPath, "utf-8");
      return new Response(spec, {
        headers: {
          "Content-Type": "application/yaml",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } catch (err: any) {
      return json({ error: `Failed to read OpenAPI specification: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/docs — Swagger UI
  if (path === "/api/docs" || path === "/api/docs/") {
    try {
      const { readFile } = await import("fs/promises");
      const { existsSync } = await import("fs");
      const htmlPath = new URL("./static/docs.html", import.meta.url).pathname;
      if (!existsSync(htmlPath)) {
        return json({ error: "Swagger UI not found" }, 404);
      }
      const html = await readFile(htmlPath, "utf-8");
      return new Response(html, {
        headers: {
          "Content-Type": "text/html",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } catch (err: any) {
      return json({ error: `Failed to serve Swagger UI: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/metadata — build, provider, artifact, and source-lineage metadata
  // GET /api/sources — canonical source inventory plus latest operational joins
  if (path === "/api/sources") {
    const { existsSync, readFileSync } = await import("fs");
    const registry = getSourceRegistry();
    const sourceHealth: import("../types.js").SourceHealth[] = [];
    for (const healthPath of [paths.newsHealth, paths.govMeetingsHealth, paths.youtubeHealth, paths.triplicateHealth, paths.alertsHealth]) {
      if (!existsSync(healthPath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(healthPath, "utf8"));
        if (Array.isArray(parsed.sources)) sourceHealth.push(...parsed.sources);
      } catch { /* one corrupt diagnostic must not hide the registry */ }
    }
    const completeHealth = completeSourceHealth(sourceHealth);
    const discovery = existsSync(paths.sourceDiscovery)
      ? (() => { try { return JSON.parse(readFileSync(paths.sourceDiscovery, "utf8")); } catch { return null; } })()
      : await buildSourceDiscoveryReport({ health: completeHealth, registry });
    const payload = {
      schemaVersion: "1.0.0",
      registryFingerprint: await sourceRegistryFingerprint(registry),
      registry,
      discovery,
      sourceHealth: summarizeSourceHealth(completeHealth),
    };
    if (url.searchParams.get("format") === "csv") {
      const records = Array.isArray(discovery?.sources) ? discovery.sources : registry.map(source => ({ ...source, operationalStatus: "not-checked", itemCount: 0 }));
      const columns = ["id", "name", "kind", "automation", "operationalStatus", "region", "authority", "canonicalUrl", "itemCount", "checkedAt", "error"];
      const cell = (value: unknown) => { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
      const csv = [columns.join(","), ...records.map((record: Record<string, unknown>) => columns.map(column => cell(record[column])).join(","))].join("\n") + "\n";
      return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=crescent-city-source-coverage.csv", "Access-Control-Allow-Origin": "*" } });
    }
    return json(payload);
  }

  // GET /api/source-discovery — compact inventory/coverage report for clients
  if (path === "/api/source-discovery") {
    const { existsSync, readFileSync } = await import("fs");
    if (existsSync(paths.sourceDiscovery)) {
      try { return jsonWithETag(JSON.parse(readFileSync(paths.sourceDiscovery, "utf8")), req); }
      catch { return json({ error: "Source discovery artifact is malformed" }, 500); }
    }
    return json(await buildSourceDiscoveryReport({ registry: getSourceRegistry() }));
  }

  if (path === "/api/metadata") {
    const { existsSync, readFileSync } = await import("fs");
    const sourceHealth: import("../types.js").SourceHealth[] = [];
    for (const healthPath of [paths.newsHealth, paths.govMeetingsHealth, paths.youtubeHealth, paths.triplicateHealth, paths.alertsHealth]) {
      if (!existsSync(healthPath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(healthPath, "utf8"));
        if (Array.isArray(parsed.sources)) sourceHealth.push(...parsed.sources);
      } catch { /* metadata remains available even if one diagnostic is corrupt */ }
    }
    const completeHealth = completeSourceHealth(sourceHealth);
    return json({
      schemaVersion: "1.0.0",
      generatedAt: new Date().toISOString(),
      application: {
        name: "crescent-city-intel",
        version: process.env.APP_VERSION ?? "2.5.1",
        commit: process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? null,
        runtime: `bun/${process.versions.bun ?? "unknown"}`,
      },
      llm: {
        provider: llmConfig.provider,
        chatModel: llmConfig.provider === "openrouter" ? llmConfig.openrouterModel : llmConfig.chatModel,
        embeddingProvider: "ollama",
        embeddingModel: llmConfig.embeddingModel,
        vectorStore: "chroma",
        collection: llmConfig.collectionName,
      },
      artifacts: {
        weeklySummary: existsSync(paths.weeklyCheckSummary) ? paths.weeklyCheckSummary : null,
        pipelineRun: existsSync(paths.pipelineRun) ? paths.pipelineRun : null,
        analyticsOverview: existsSync(paths.analyticsOverview) ? paths.analyticsOverview : null,
        curation: existsSync(paths.curationReport) ? paths.curationReport : null,
        reportMetadata: existsSync(paths.latestReportMetadata) ? paths.latestReportMetadata : null,
        sourceRegistry: existsSync(paths.sourceRegistry) ? paths.sourceRegistry : null,
        sourceDiscovery: existsSync(paths.sourceDiscovery) ? paths.sourceDiscovery : null,
      },
      sourceHealth: summarizeSourceHealth(completeHealth),
      sourceCoverage: {
        registryFingerprint: await sourceRegistryFingerprint(),
        registryCount: getSourceRegistry().length,
        monitoredCount: getSourceRegistry().filter(source => source.automation === "monitored").length,
        discoveryOnlyCount: getSourceRegistry().filter(source => source.automation === "discovery-only").length,
        referenceOnlyCount: getSourceRegistry().filter(source => source.automation === "reference-only").length,
      },
    });
  }

  // GET /api/health — liveness probe with optional composite status
  if (path === "/api/health") {
    const { existsSync, readFileSync } = await import("fs");
    const health: Record<string, any> = {
      status: "ok",
      timestamp: new Date().toISOString(),
      chatProvider: llmConfig.provider,
      chatModel: llmConfig.provider === "openrouter" ? llmConfig.openrouterModel : llmConfig.chatModel,
      embeddingProvider: {
        provider: "ollama",
        model: llmConfig.embeddingModel,
        url: llmConfig.ollamaUrl,
      },
      vectorStore: {
        provider: "chroma",
        collection: llmConfig.collectionName,
        url: llmConfig.chromaUrl,
      },
    };

    try {
      const llm = await getLlm();
      if (llm) {
        const providerHealth = await llm.provider.checkChatProvider();
        health.providerHealth = providerHealth;
        if (!providerHealth.configured || !providerHealth.reachable) health.status = "degraded";
      }
    } catch (error: unknown) {
      health.status = "degraded";
      health.providerHealth = {
        provider: llmConfig.provider,
        configured: false,
        reachable: false,
        model: llmConfig.provider === "openrouter" ? llmConfig.openrouterModel : llmConfig.chatModel,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // Include manifest staleness info if available
    const manifestPath = paths.manifest;
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const completedAt = manifest.completedAt ?? manifest.scrapedAt;
        if (completedAt) {
          const ageDays = (Date.now() - new Date(completedAt).getTime()) / (1000 * 60 * 60 * 24);
          health.manifest = {
            completedAt,
            ageDays: Math.round(ageDays),
            stale: ageDays > 30,
            sectionCount: manifest.sectionCount ?? null,
          };
        }
      } catch { /* ignore */ }
    }

    // Per-type 30-day alert trend summary, computed from the bounded history
    // JSONL files (same data source as /api/alerts/timeline) and cached for
    // HEALTH_TRENDS_TTL_MS so health polling does not re-read them every hit.
    // Compact projection: per-UTC-day counts, not one ISO stamp per event —
    // the raw stamps stay on GET /api/alerts/timeline. Diagnostics-only: a
    // failure here never breaks liveness.
    const alertTrends30d = await getHealthAlertTrends();
    if (alertTrends30d) health.alertTrends30d = alertTrends30d;

    // Include composite alert severity if available
    const compositePath = "output/alerts/composite/current.json";
    if (existsSync(compositePath)) {
      try {
        health.alertLevel = JSON.parse(readFileSync(compositePath, "utf-8")).level;
      } catch { /* ignore */ }
    }

    for (const [key, healthPath] of [
      ["news", paths.newsHealth],
      ["meetings", paths.govMeetingsHealth],
      ["youtube", paths.youtubeHealth],
      ["triplicate", paths.triplicateHealth],
    ] as const) {
      if (!existsSync(healthPath)) continue;
      try {
        const sourceReport = JSON.parse(readFileSync(healthPath, "utf-8"));
        health[`${key}Sources`] = sourceReport.sources ?? [];
      } catch { /* diagnostics never break liveness */ }
    }

    if (existsSync(paths.alertsHealth)) {
      try {
        const alertHealth = JSON.parse(readFileSync(paths.alertsHealth, "utf-8"));
        health.alertSources = alertHealth.sources ?? [];
      } catch { /* diagnostics never break liveness */ }
    }

    const allSourceHealth = [
      health.newsSources,
      health.meetingsSources,
      health.youtubeSources,
      health.triplicateSources,
      health.alertSources,
    ].flatMap(rows => Array.isArray(rows) ? rows : []) as import("../types.js").SourceHealth[];
    const completeHealth = completeSourceHealth(allSourceHealth);
    const expectedMonitor = new Map(EXPECTED_SOURCE_HEALTH.map(expected => [expected.source, expected.monitor]));
    for (const monitor of ["news", "meetings", "youtube", "triplicate", "alerts"] as const) {
      health[`${monitor === "alerts" ? "alert" : monitor}Sources`] = completeHealth.filter(source => expectedMonitor.get(source.source) === monitor);
    }
    health.sourceCoverage = summarizeSourceHealth(completeHealth);

    const { getRateLimitStats } = await import("../api/middleware.js");
    health.rateLimit = getRateLimitStats();

    return json(health);
  }

  // GET /api/report/latest — serve most recent monthly civic health report
  if (path === "/api/report/latest") {
    const { existsSync, readdirSync, readFileSync } = await import("fs");
    const reportsDir = "output/reports";
    if (!existsSync(reportsDir)) return json({ error: "No reports generated. Run: bun run report" }, 404);
    try {
      const files = readdirSync(reportsDir)
        .filter(f => f.startsWith("monthly-") && f.endsWith(".md"))
        .sort()
        .reverse();
      if (files.length === 0) return json({ error: "No monthly reports found" }, 404);
      const content = readFileSync(`${reportsDir}/${files[0]}`, "utf-8");
      return new Response(content, {
        headers: {
          "Content-Type": "text/markdown",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err: any) {
      return json({ error: `Failed to read report: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/report/latest.json — machine-readable metadata for the latest report
  if (path === "/api/report/latest.json") {
    const { existsSync, readdirSync, readFileSync } = await import("fs");
    const reportsDir = "output/reports";
    if (!existsSync(reportsDir)) return json({ error: "No reports generated. Run: bun run report" }, 404);
    const files = readdirSync(reportsDir).filter(f => f.startsWith("monthly-") && f.endsWith(".json")).sort().reverse();
    if (files.length === 0) return json({ error: "No report metadata found" }, 404);
    try {
      return jsonWithETag(JSON.parse(readFileSync(`${reportsDir}/${files[0]}`, "utf8")), req);
    } catch (err: any) {
      return json({ error: `Failed to read report metadata: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/search/analytics — most-queried search terms
  if (path === "/api/search/analytics") {
    const { existsSync, readFileSync } = await import("fs");
    const logPath = paths.searchQueryLog;
    if (!existsSync(logPath)) return json({ totalQueries: 0, topTerms: [] });
    try {
      const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
      const termCounts = new Map<string, number>();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const q = entry.query ?? entry.q ?? "";
          if (q) {
            const words = q.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
            for (const w of words) {
              termCounts.set(w, (termCounts.get(w) ?? 0) + 1);
            }
          }
        } catch { /* skip */ }
      }
      const topTerms = [...termCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([term, count]) => ({ term, count }));
      return json({ totalQueries: lines.length, topTerms });
    } catch (err: any) {
      return json({ error: `Search analytics failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/domains/:id/coverage — per-domain coverage metrics
  const domainCoverageMatch = path.match(/^\/api\/domains\/([a-z0-9-]+)\/coverage$/);
  if (domainCoverageMatch) {
    try {
      const domainId = domainCoverageMatch[1];
      const { computeDomainCoverage } = await import("../domains/coverage.js");
      const report = await computeDomainCoverage();
      const domain = report.domains?.find((d: any) => d.domainId === domainId);
      if (!domain) return json({ error: `Domain "${domainId}" not found` }, 404);
      return json({ domain: domainId, ...domain, totalSections: report.totalSections });
    } catch (err: any) {
      return json({ error: `Coverage failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // ─── v2.0 Intelligence Endpoints ──────────────────────────────────

  // GET /api/history/:guid — legislative history for a section
  const historyMatch = path.match(/^\/api\/history\/([a-zA-Z0-9_-]+)$/);
  if (historyMatch) {
    try {
      const { getSectionHistory } = await import("../structured_queries.js");
      const history = await getSectionHistory(historyMatch[1]);
      if (!history) return json({ error: "Section not found" }, 404);
      return json(history);
    } catch (err: any) {
      return json({ error: `History lookup failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/compare?guid1=...&guid2=... — diff two sections
  if (path === "/api/compare") {
    const guid1 = url.searchParams.get("guid1");
    const guid2 = url.searchParams.get("guid2");
    if (!guid1 || !guid2) return json({ error: "Both guid1 and guid2 required" }, 400);
    try {
      const { compareSections } = await import("../structured_queries.js");
      const diff = await compareSections(guid1, guid2);
      if (!diff) return json({ error: "One or both sections not found" }, 404);
      return json(diff);
    } catch (err: any) {
      return json({ error: `Compare failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/similar/:guid?limit=N — find semantically similar sections
  const similarMatch = path.match(/^\/api\/similar\/([a-zA-Z0-9_-]+)$/);
  if (similarMatch) {
    try {
      const limit = parseInt(url.searchParams.get("limit") ?? "10", 10) || 10;
      const { findSimilarSections } = await import("../structured_queries.js");
      const similar = await findSimilarSections(similarMatch[1], limit);
      return json({ guid: similarMatch[1], limit, results: similar, count: similar.length });
    } catch (err: any) {
      return json({ error: `Similarity search failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/citations/:guid — extract legal citations from a section
  const citationsMatch = path.match(/^\/api\/citations\/([a-zA-Z0-9_-]+)$/);
  if (citationsMatch) {
    try {
      const { extractCitations, extractOrdinanceAmendments } = await import("../legal_parser.js");
      const section = await loadSection(citationsMatch[1]);
      if (!section) return json({ error: "Section not found" }, 404);
      const citations = extractCitations(section.text);
      const amendments = extractOrdinanceAmendments(section.history);
      return json({ guid: section.guid, number: section.number, citations, amendments });
    } catch (err: any) {
      return json({ error: `Citation extraction failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/glossary — definition glossary from entire code corpus
  if (path === "/api/glossary") {
    try {
      const { buildGlossary } = await import("../legal_parser.js");
      const sections = await loadAllSections();
      const glossary = buildGlossary(sections);
      return json({ total: glossary.length, entries: glossary });
    } catch (err: any) {
      return json({ error: `Glossary build failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/cross-refs/validate — validate all internal cross-references
  if (path === "/api/cross-refs/validate") {
    try {
      const { validateAllCrossReferences } = await import("../structured_queries.js");
      const result = await validateAllCrossReferences();
      return json(result);
    } catch (err: any) {
      return json({ error: `Cross-ref validation failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/alerts/timeline — unified alert event timeline
  if (path === "/api/alerts/timeline") {
    try {
      const { buildAlertAnalytics } = await import("../alert_analytics.js");
      const report = buildAlertAnalytics();
      return json(report);
    } catch (err: any) {
      return json({ error: `Alert analytics failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/alerts/recent?limit=N — most recent alert events
  if (path === "/api/alerts/recent") {
    try {
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10) || 20;
      const { getRecentAlerts } = await import("../alert_analytics.js");
      const recent = getRecentAlerts(limit);
      return json({ limit, count: recent.length, alerts: recent });
    } catch (err: any) {
      return json({ error: `Recent alerts failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/events/discover - community-event discovery artifact
  //
  // Reads the persisted artifact by default. Fanning out to every registered
  // event source costs a full network round of third-party fetches, so it is
  // not something an arbitrary caller gets to trigger by asking for one event:
  // `?refresh=1` is the only path that touches the network, and the route is
  // API-key gated (it is absent from PUBLIC_PATHS in api/middleware.ts) and
  // rate limited by the same middleware.
  //
  // Supports ?limit=&offset= pagination over artifact.events, matching the
  // alerts/history pattern ({total, offset, limit, count}). Without either the
  // full unpaginated artifact is returned (backwards compatible).
  if (path === "/api/events/discover") {
    try {
      const refresh = ["1", "true"].includes((url.searchParams.get("refresh") ?? "").toLowerCase());
      // Legacy parameter: live=false meant "build the offline shell". Preserved
      // so existing callers keep their documented behaviour.
      const liveParam = url.searchParams.get("live");

      // Pagination parameters are validated BEFORE any work: rejecting
      // limit=0 after a network fan-out would still have paid for it. `0 || 50`
      // previously turned limit=0 into a silent 50, contradicting the published
      // `minimum: 1`.
      const limitParam = url.searchParams.get("limit");
      const offsetParam = url.searchParams.get("offset");
      const paginated = limitParam !== null || offsetParam !== null;
      let limit = 50;
      let offset = 0;
      if (paginated) {
        if (limitParam !== null) {
          if (!/^\d+$/.test(limitParam.trim())) {
            return json({ error: "limit must be an integer between 1 and 500" }, 400);
          }
          limit = parseInt(limitParam, 10);
          if (limit < 1) return json({ error: "limit must be at least 1" }, 400);
          if (limit > 500) limit = 500;
        }
        if (offsetParam !== null) {
          if (!/^\d+$/.test(offsetParam.trim())) {
            return json({ error: "offset must be a non-negative integer" }, 400);
          }
          offset = parseInt(offsetParam, 10);
        }
      }

      let artifact: import("../event_discovery.js").DiscoveryArtifact | null = null;
      let source: "persisted" | "network" | "offline-shell";

      if (refresh) {
        const { buildDiscoveryArtifact } = await import("../event_discovery.js");
        artifact = await buildDiscoveryArtifact(new Date().toISOString(), process.cwd(), { includeNetwork: true });
        source = "network";
      } else if (liveParam === "false") {
        const { buildDiscoveryArtifact } = await import("../event_discovery.js");
        artifact = await buildDiscoveryArtifact(new Date().toISOString(), process.cwd(), { includeNetwork: false });
        source = "offline-shell";
      } else {
        const { existsSync, readFileSync } = await import("fs");
        const persistedPath = join(process.cwd(), "output", "events", "event_discovery.json");
        if (existsSync(persistedPath)) {
          try {
            artifact = JSON.parse(readFileSync(persistedPath, "utf-8")) as import("../event_discovery.js").DiscoveryArtifact;
          } catch { artifact = null; }
        }
        if (artifact && Array.isArray(artifact.events)) {
          source = "persisted";
        } else {
          // No usable artifact on disk: return the deterministic offline shell
          // rather than silently escalating to a network fan-out.
          const { buildDiscoveryArtifact } = await import("../event_discovery.js");
          artifact = await buildDiscoveryArtifact(new Date().toISOString(), process.cwd(), { includeNetwork: false });
          source = "offline-shell";
        }
      }

      const body = { ...artifact, source };
      if (!paginated) return json(body);
      const total = artifact.events.length;
      const page = artifact.events.slice(offset, offset + limit);
      return json({ ...body, total, offset, limit, count: page.length, events: page });
    } catch (err: any) {
      return json({ error: `Event discovery failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // POST /api/chat/stream — streaming RAG via Server-Sent Events
  if (path === "/api/chat/stream" && req?.method === "POST") {
    await resetProviderBudget();
    try {
      const body = await req.json();
      const q = body.q;
      if (!q) return json({ error: "No question provided (field 'q' required)" }, 400);

      const llm = await getLlm();
      if (!llm) return json({ error: "LLM modules unavailable" }, 503);

      // Retrieve context from ChromaDB
      const { ollama, chroma } = llm;
      const provider = await llm.provider.checkChatProvider();
      if (!provider.configured || !provider.reachable) {
        return json({ error: provider.error ?? `${provider.provider} chat provider is unavailable`, provider: provider.provider, model: provider.model }, 503);
      }
      const ollamaHealthy = await ollama.isOllamaRunning();
      if (!ollamaHealthy) return json({ error: "Ollama is not running" }, 503);

      const queryEmbedding = await ollama.embed(q);
      const chromaResult = await chroma.query(queryEmbedding, llmConfig.topK);

      const { buildRagSource } = await import("../llm/rag.js");
      const documents = chromaResult.documents ?? [];
      if (documents.length === 0) return json({ error: "No retrieved context is available" }, 503);
      const sources: import("../types.js").RagSource[] = documents.map((doc: string, i: number) =>
        buildRagSource(doc, chromaResult.metadatas?.[i] ?? {}, chromaResult.distances?.[i] ?? 0)
      );

      const context = documents.map((doc: string, i: number) => {
        const meta = chromaResult.metadatas?.[i] ?? {};
        const label = meta.sourceType === "youtube_transcript"
          ? `[YouTube: ${meta.videoTitle ?? "unknown"} @ ${meta.timestamp ?? "unknown"}]`
          : `[${meta.sectionNumber ?? "unknown section"}: ${meta.sectionTitle ?? ""}]`;
        return `${label}\n${doc}`;
      }).join("\n\n");

      const { createStreamingRagResponse } = await import("../llm/streaming_rag.js");
      return createStreamingRagResponse(q, { sources, context }, body.model, body.history);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Streaming chat failed`, { error: message });
      return json({ error: `Streaming chat failed: ${message}` }, 500);
    }
  }

  // GET /api/fuzzy?q=... — fuzzy search suggestions
  if (path === "/api/fuzzy") {
    try {
      const q = url.searchParams.get("q");
      if (!q) return json({ error: "No query provided" }, 400);
      const { expandQueryFuzzy } = await import("../shared/fuzzy.js");
      const sections = await loadAllSections();
      const vocab = new Set<string>();
      for (const s of sections) {
        for (const w of s.text.toLowerCase().split(/\s+/)) {
          if (w.length > 3) vocab.add(w);
        }
      }
      const result = expandQueryFuzzy(q, vocab);
      return json({ original: q, expanded: result.query, corrections: result.corrections });
    } catch (err: any) {
      return json({ error: `Fuzzy search failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/alerts/:type/history?limit=&offset= — paginated history for one alert type
  const alertHistoryMatch = path.match(/^\/api\/alerts\/([a-z]+)\/history$/);
  if (alertHistoryMatch) {
    const { getAlertsByType, ALERT_TYPES } = await import("../alert_analytics.js");
    const type = alertHistoryMatch[1] as import("../alert_analytics.js").AlertType;
    if (!ALERT_TYPES.includes(type)) {
      return json({ error: `Unknown alert type "${type}"` }, 400);
    }
    try {
      const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
      const typed = getAlertsByType(type);
      const page = typed.slice(offset, offset + limit);
      return json({ type, total: typed.length, offset, limit, count: page.length, alerts: page });
    } catch (err: any) {
      return json({ error: `Alert history failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/alerts/correlation — detect correlated alert sequences
  if (path === "/api/alerts/correlation") {
    try {
      const { buildAlertAnalytics } = await import("../alert_analytics.js");
      const report = buildAlertAnalytics();
      const correlations: Array<{ type: string; description: string; events: any[] }> = [];

      // Detect earthquake → tsunami sequences (within 1 hour)
      const earthquakes = report.timeline.filter(e => e.type === "earthquake" && (e.severity === "WARNING" || e.severity === "EMERGENCY"));
      const tsunamis = report.timeline.filter(e => e.type === "tsunami");
      for (const eq of earthquakes) {
        const eqTime = new Date(eq.timestamp).getTime();
        for (const ts of tsunamis) {
          const tsTime = new Date(ts.timestamp).getTime();
          const diffMin = (tsTime - eqTime) / (1000 * 60);
          if (diffMin > 0 && diffMin < 60) {
            correlations.push({
              type: "earthquake-tsunami",
              description: `Earthquake "${eq.description}" followed by tsunami alert ${diffMin.toFixed(0)} min later`,
              events: [eq, ts],
            });
          }
        }
      }

      // Detect wildfire → air quality sequences (within 6 hours)
      const wildfires = report.timeline.filter(e => e.type === "wildfire" && e.severity !== "CALM");
      const aqSpikes = report.timeline.filter(e => e.type === "airquality" && (e.severity === "WARNING" || e.severity === "EMERGENCY"));
      for (const wf of wildfires) {
        const wfTime = new Date(wf.timestamp).getTime();
        for (const aq of aqSpikes) {
          const aqTime = new Date(aq.timestamp).getTime();
          const diffHr = (aqTime - wfTime) / (1000 * 60 * 60);
          if (diffHr > 0 && diffHr < 6) {
            correlations.push({
              type: "wildfire-airquality",
              description: `Wildfire "${wf.description}" followed by AQI spike ${diffHr.toFixed(1)} hr later`,
              events: [wf, aq],
            });
          }
        }
      }

      return json({ totalCorrelations: correlations.length, correlations });
    } catch (err: any) {
      return json({ error: `Correlation failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/ordinal-check — detect gaps in section numbering
  if (path === "/api/ordinal-check") {
    try {
      const sections = await loadAllSections();
      const byTitle = new Map<string, string[]>();
      for (const s of sections) {
        const title = s.number.split(".")[0];
        if (!byTitle.has(title)) byTitle.set(title, []);
        byTitle.get(title)!.push(s.number);
      }
      const gaps: Array<{ title: string; missing: string[] }> = [];
      for (const [title, numbers] of byTitle) {
        const sorted = numbers.sort((a, b) => {
          const aParts = a.split(".").map(Number);
          const bParts = b.split(".").map(Number);
          for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
            if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i];
          }
          return aParts.length - bParts.length;
        });
        // Check for gaps in the sequence
        const missing: string[] = [];
        for (let i = 1; i < sorted.length; i++) {
          const prev = sorted[i - 1].split(".").map(Number);
          const curr = sorted[i].split(".").map(Number);
          if (prev.length >= 2 && curr.length >= 2 && prev[1] !== curr[1]) {
            // Gap detected in chapter numbering
            for (let ch = prev[1] + 1; ch < curr[1]; ch++) {
              missing.push(`${title}.${String(ch).padStart(2, "0")}`);
            }
          }
        }
        if (missing.length > 0) gaps.push({ title, missing });
      }
      return json({ totalGaps: gaps.length, gaps });
    } catch (err: any) {
      return json({ error: `Ordinal check failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  // GET /api/definitions/conflicts — find conflicting definitions
  if (path === "/api/definitions/conflicts") {
    try {
      const { buildGlossary } = await import("../legal_parser.js");
      const sections = await loadAllSections();
      const glossary = buildGlossary(sections);
      // Group by term (case-insensitive)
      const byTerm = new Map<string, Array<{ term: string; definition: string; sectionNumber: string }>>();
      for (const entry of glossary) {
        const key = entry.term.toLowerCase();
        if (!byTerm.has(key)) byTerm.set(key, []);
        byTerm.get(key)!.push(entry);
      }
      // Find terms with conflicting definitions
      const conflicts: Array<{ term: string; definitions: any[] }> = [];
      for (const [term, entries] of byTerm) {
        if (entries.length > 1) {
          // Check if definitions differ
          const uniqueDefs = new Set(entries.map(e => e.definition.substring(0, 100).toLowerCase()));
          if (uniqueDefs.size > 1) {
            conflicts.push({ term, definitions: entries });
          }
        }
      }
      return json({ totalConflicts: conflicts.length, conflicts });
    } catch (err: any) {
      return json({ error: `Conflict detection failed: ${publicApiDetail(err.message)}` }, 500);
    }
  }

  return json({ error: "Not found" }, 404);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** Provider, vector-store, and network failures are retryable dependencies. */
/**
 * Map a thrown message onto a public API detail (R3 P0.6, API surface).
 *
 * A thrown Error carries the operator's machine in it: absolute paths, provider
 * endpoints, ports, parser internals. Those belong in the server log — which
 * every call site here already writes — not in a response body a browser or a
 * third-party client will render. The public detail keeps the FACT of the
 * failure and its kind, and nothing else; an unrecognised message is never
 * passed through, and no failure is ever reported as a success.
 */
export function publicApiDetail(message: unknown): string {
  const raw = String(message ?? "").trim();
  if (!raw) return "the request did not succeed";
  if (/timed? ?out|timeout|abort/i.test(raw)) return "the dependency did not respond before the request timed out";
  const httpStatus = /\b([45]\d{2})\b/.exec(raw);
  if (httpStatus) return `an upstream dependency returned HTTP ${httpStatus[1]}`;
  if (/enoent|no such file|not found|missing/i.test(raw)) return "the artifact this endpoint reads is not present in this edition";
  if (/parse|json|xml|unexpected token|syntaxerror/i.test(raw)) return "an artifact this endpoint reads could not be parsed";
  if (/econnrefused|econnreset|enotfound|network|fetch failed|socket|tls|certificate/i.test(raw)) return "a dependency could not be reached";
  if (/ollama|openrouter|chroma|provider|embedding|model/i.test(raw)) return "a model or vector-store dependency is unavailable";
  return "the request did not succeed";
}

function dependencyFailureStatus(message: string): number {
  return /ollama|openrouter|chroma|provider\s+(error|unavailable|not|failed)|request cap|timed? ?out|embedding model|retrieved context|(index|collection).*(empty|missing|not found)/i.test(message) ? 503 : 500;
}


/** Compute a short hash-based ETag for a JSON payload */
export function etag(payload: string): string {
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    hash = Math.imul(31, hash) + payload.charCodeAt(i) | 0;
  }
  return `"${(hash >>> 0).toString(16)}"`;
}

/** Return JSON response with ETag and optional 304 shortcircuit for static endpoints */
export function jsonWithETag(data: unknown, req: Request | undefined, status = 200): Response {
  const payload = JSON.stringify(data);
  const tag = etag(payload);
  const ifNoneMatch = req?.headers.get("If-None-Match");
  if (ifNoneMatch === tag) {
    return new Response(null, {
      status: 304,
      headers: { "ETag": tag, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60" },
    });
  }
  return new Response(payload, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "ETag": tag,
      "Vary": "Accept-Encoding",
      "Cache-Control": "public, max-age=60",
    },
  });
}
