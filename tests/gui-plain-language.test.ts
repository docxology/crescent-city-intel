/**
 * Phase 7 plain-language rewrite — string contracts for user-facing GUI copy.
 *
 * The GUI is a no-build SPA whose markup lives in src/gui/static/index.html
 * and whose JS lives in src/gui/static/assets/modules/*.js (v2.7.0 asset
 * split), so string contracts are the only deterministic offline assertions
 * available; the live path is covered by `bun run test:browser`. These tests
 * lock the Phase 7 rewrite of the TODO.md Deferred GUI/UX set: headings,
 * button/label tooltips, alert-state wording, empty states, and legends must
 * read as plain English for a Crescent City resident — not a civic-data
 * engineer. Internal stack names (RAG, Ollama, Chroma, BM25, GUID, tf-idf)
 * never appear in end-user copy, and every rewritten surface carries an
 * explicit empty state.
 *
 * Zero-mock: real files, no fixtures, no network.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(process.cwd(), "src", "gui", "static");
const html = readFileSync(join(root, "index.html"), "utf-8");
const mod = (name: string) => readFileSync(join(root, "assets", "modules", name), "utf-8");

const core = mod("10-core.js");
const search = mod("30-search.js");
const chat = mod("50-chat.js");
const alerts = mod("60-alerts.js");
const analytics = mod("70-analytics.js");
const feeds = mod("110-feeds.js");
const panels = mod("90-intel-panels.js");
const readability = mod("130-readability.js");

describe("Phase 7 plain language — welcome and header surface", () => {
  test("the code-coverage metrics read as words, not acronyms", () => {
    expect(html).toContain("contents headings");
    expect(html).not.toContain("TOC nodes");
    expect(core).toContain("Contents headings: ${stats.tocNodeCount}");
    expect(core).not.toContain("TOC nodes: ");
  });

  test("the table-of-contents failure is an explicit empty state in plain words", () => {
    expect(core).toContain("Could not load the table of contents. Run the scraper first");
  });

  test("the chat welcome card drops internal stack names", () => {
    expect(html).toContain("Ask plain-language questions and get answers that cite the code, when the optional AI helper is available.");
    expect(html).not.toContain("RAG chat");
    expect(html).not.toContain("Ollama");
    expect(html).not.toContain("Chroma");
  });
});

describe("Phase 7 plain language — chat surface", () => {
  test("the chat system message explains what it needs without stack jargon", () => {
    expect(html).toContain("Answers cite the code");
    expect(html).toContain("optional AI helper service");
    expect(html).not.toContain("Requires Ollama + LLM module");
    expect(html).toContain('title="Ask questions about the code or news transcripts — answers cite their sources"');
    expect(html).not.toContain("RAG-powered");
  });

  test("chat failure and empty answers are explicit states", () => {
    expect(chat).toContain("Could not reach the chat helper. Check that the optional AI service is running.");
    expect(chat).toContain("No answer was returned.");
    expect(chat).not.toContain("Failed to connect to chat service");
  });
});

describe("Phase 7 plain language — alerts surface", () => {
  test("the dashboard heading matches the real 15-monitor roster", () => {
    expect(html).toContain("🚨 Live Safety Alerts");
    expect(html).not.toContain("8-Monitor Alert Dashboard");
    expect(alerts).not.toContain("8-monitor");
  });

  test("the alert-state legend reads as plain English", () => {
    for (const chip of [
      "All clear — reported as calm",
      "All clear — checked, nothing found",
      "Out of date",
      "Could not be reached",
      "No events recorded in this window",
    ]) {
      expect(html).toContain(chip);
    }
    expect(html).not.toContain("Calm: explicit level");
    expect(html).not.toContain("Empty: checked, no match");
    expect(html).not.toContain("Zero cells");
  });

  test("correlation copy avoids statistics jargon", () => {
    expect(alerts).toContain("× more often than chance");
    expect(html).not.toContain("uniform-rate expectation");
    expect(html).toContain("Rows marked cadence-sensitive may reflect how often each monitor runs, not cause and effect");
  });

  test("every alerts empty state is explicit", () => {
    expect(alerts).toContain(">No data yet</div>");
    expect(alerts).toContain("No alert data available yet. Run: bun run alerts");
    expect(alerts).toContain("Could not load alerts. Is the server running?");
    expect(alerts).toContain("No correlation pairs are being tracked yet.");
    expect(alerts).not.toContain("No correlation pairs configured.");
    expect(alerts).not.toContain(">Failed to load alerts");
  });

  test("per-monitor health wording avoids status vocabulary", () => {
    expect(alerts).toContain("source data is out of date");
    expect(alerts).toContain("source could not be reached");
    expect(alerts).not.toContain("source data is stale");
    expect(alerts).not.toContain("'source unavailable'");
  });
});

describe("Phase 7 plain language — analytics surface", () => {
  test("the PCA view is introduced in plain words", () => {
    expect(analytics).toContain("Topic Map — How Sections Relate (PCA)");
    expect(analytics).not.toContain("Embedding Space");
    expect(analytics).toContain("sections mapped • PC");
    expect(analytics).toContain("% of variation");
    expect(analytics).not.toContain("% var");
    expect(analytics).toContain("Grouped by similarity (K-Means)");
    expect(analytics).toContain("Top Words for PC${pcIndex + 1}");
    expect(analytics).not.toContain("Word Loadings");
    expect(analytics).toContain("Word Biplot — Terms Driving the Two Axes");
    expect(analytics).not.toContain("Terms in PC1/PC2 Space");
  });

  test("the topic map carries explicit empty and error states", () => {
    expect(analytics).toContain("No topic map yet — the code has not been indexed. Run: bun run index.");
    expect(analytics).not.toContain('No embeddings indexed yet');
    expect(analytics).toContain("Could not load the topic map:");
  });
});

describe("Phase 7 plain language — corpus analysis panels", () => {
  test("section inputs ask for IDs, not GUIDs", () => {
    for (const marker of [
      'placeholder="Section ID 1"',
      'placeholder="Section ID 2"',
      'placeholder="Section ID (e.g. 12345...)"',
      "placeholder=\"Section ID (optional — one section's links)\"",
      "placeholder=\"Section ID (optional — one section's trail)\"",
    ]) {
      expect(html).toContain(marker);
    }
    expect(html).not.toContain("Section GUID");
    expect(html).toContain("Paste two section IDs to compare.");
    expect(html).toContain("Paste a section ID to see the ordinances that shaped it:");
  });

  test("word-frequency copy explains salience without the formula", () => {
    expect(html).toContain("<strong>Salience</strong> rewards words that appear often here but rarely elsewhere");
    expect(html).not.toContain("tf&middot;idf");
    expect(panels).toContain("Most distinctive terms (salience)");
    expect(panels).not.toContain("tf&middot;idf");
    expect(panels).toContain("<h4>Word variety</h4>");
    expect(panels).toContain("<h4>Words counted</h4>");
    expect(panels).toContain("<h4>Avg words per section</h4>");
    expect(panels).not.toContain("Type/token ratio");
  });

  test("graph copy names unresolved citations in plain words", () => {
    expect(panels).toContain("<h4>Citations pointing nowhere</h4>");
    expect(panels).not.toContain("Dangling citations");
    expect(html).toContain("drawn as arrows from the citing section to the cited one");
  });
});

describe("Phase 7 plain language — news & feeds surface", () => {
  test("the curated feed intro explains provenance in plain words", () => {
    expect(html).toContain("each item shows where it came from and whether an AI summary was applied");
    expect(html).toContain("Triplicate newspaper items are listed for reference only and are never summarized or indexed");
    expect(html).not.toContain("provider-labeled");
    expect(html).not.toContain("embedding index");
  });

  test("the insights brief intro drops artifact vocabulary", () => {
    expect(html).toContain("Civic Insight Brief — how civic topics are trending");
    expect(html).not.toContain("cross-artifact domain trends");
    expect(html).toContain("A topic with too little data reads <em>insufficient</em>");
  });

  test("feed empty states are explicit and instructive", () => {
    expect(feeds).toContain("No alert events recorded yet. Run: bun run alerts");
    expect(feeds).toContain("No monthly report has been generated yet. Run: bun run report to create one.");
    expect(feeds).toContain("No curated items yet. Run: bun run curate to refresh.");
    expect(feeds).toContain("No data available yet.");
    expect(feeds).not.toContain("No reports generated.");
    expect(feeds).toContain("<h4>AI briefs</h4>");
    expect(feeds).not.toContain("<h4>LLM briefs</h4>");
  });

  test("the API explorer descriptions avoid search jargon and stale monitor counts", () => {
    expect(feeds).toContain("Full-text search with typo tolerance");
    expect(feeds).toContain("Current EPA air-quality index (AQI)");
    expect(feeds).toContain("Streaming chat answers (server-sent events)");
    expect(feeds).toContain("Reading-difficulty scores (Flesch-Kincaid, Gunning Fog)");
    expect(feeds).toContain("15-monitor alert aggregation + composite");
    expect(feeds).toContain("15-monitor composite severity");
    expect(feeds).not.toContain("BM25 search with fuzzy fallback");
    expect(feeds).not.toContain("Streaming RAG chat");
    expect(feeds).not.toContain("8-monitor");
  });
});

describe("Phase 7 plain language — sources surface", () => {
  test("the source panel intro explains not-checked as an explicit gap", () => {
    expect(html).toContain("Where our information comes from");
    expect(html).toContain("an explicit gap, not a clean bill of health");
    expect(html).not.toContain("Canonical online source coverage");
    expect(html).not.toContain("Operational state is joined to the canonical registry");
  });

  test("the structured-data tab is named and explained plainly", () => {
    expect(html).toContain("🧾 Structured Data</button>");
    expect(html).toContain("Structured source data (JSON)");
    expect(html).toContain("Safe to copy into other tools without losing fingerprints");
    expect(html).not.toContain("Structured source output</div>");
    expect(html).not.toContain("downstream analysis without losing fingerprints or explicit unavailable states");
  });
});

describe("Phase 7 plain language — search and readability surfaces", () => {
  test("the empty search result guides the next attempt", () => {
    expect(search).toContain("No matching sections found. Try fewer words, or a section number like 12.04.");
    expect(search).not.toContain(">No results found</div>");
  });

  test("readability columns and empty states use plain labels", () => {
    expect(readability).toContain("<th>Reading ease</th><th>Reading fog</th>");
    expect(readability).not.toContain("<th>Flesch ease</th>");
    expect(readability).not.toContain("<th>Gunning fog</th>");
    expect(readability).toContain("No readability scores yet. Run: bun run readability");
    expect(readability).toContain("Could not load readability scores.");
    expect(readability).not.toContain(">Failed to load readability<");
  });
});

describe("Phase 7 — every rewritten surface has an explicit empty state", () => {
  test("glossary: initial, no-match, and failure states all exist", () => {
    expect(html).toContain("Definitions load when this tab opens.");
    expect(feeds).toContain("No definitions match that search.</p>");
    expect(feeds).toContain("Could not load the glossary.");
  });

  test("compare: the untouched panel says what to do", () => {
    expect(html).toContain("Choose two sections and press Compare.");
    expect(feeds).toContain("Could not compare those sections.");
  });

  test("legislative history: the untouched panel says what to do", () => {
    expect(html).toContain("Enter a section ID above and choose Load.");
    expect(feeds).toContain("Could not load history.");
  });
});