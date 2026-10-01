#!/usr/bin/env bun
/** LLM module CLI entry point */
import { indexAllSections, isIndexed } from "./embeddings.js";
import { ragQuery } from "./rag.js";
import { getStats, isChromaRunning, waitForChroma } from "./chroma.js";
import { isOllamaRunning, listModels } from "./ollama.js";
import { checkChatProvider } from "./provider.js";
import { llmConfig } from "./config.js";
import { createLogger } from "../logger.js";
import * as readline from "readline";

import { evaluateContextReplay } from "./benchmark.js";
import { buildSemanticReviewPackage, assessSemanticAnnotations, type SemanticReviewInput } from "./semantic_review.js";
import { open } from "node:fs/promises";
const log = createLogger("llm-cli");
const command = process.argv[2];

async function checkPrerequisites(): Promise<boolean> {
  if (llmConfig.provider === "openrouter" && !process.env.OPENROUTER_API_KEY) {
    log.error("LLM_PROVIDER=openrouter but OPENROUTER_API_KEY is not set.");
    log.error("Set it: export OPENROUTER_API_KEY=sk-or-... (get a key at https://openrouter.ai/keys)");
    log.error("Or use the default local provider: unset LLM_PROVIDER (defaults to ollama).");
    return false;
  }

  const ollama = await isOllamaRunning();
  const chroma = await isChromaRunning();

  if (!ollama) {
    log.error(`Ollama is not running at ${llmConfig.ollamaUrl}`);
    log.error("Start Ollama: ollama serve");
    log.error("Install on macOS: brew install ollama. Other platforms: https://docs.ollama.com/quickstart");
    log.error(`Pull models: ollama pull ${llmConfig.embeddingModel} && ollama pull ${llmConfig.chatModel}`);
    return false;
  }
  if (!chroma) {
    log.warn(`ChromaDB not responding at ${llmConfig.chromaUrl}, retrying...`);
    const ok = await waitForChroma(3, 1000);
    if (!ok) {
      log.error(`ChromaDB is not running at ${llmConfig.chromaUrl}`);
      log.error("Start the pinned local vector service: docker compose --profile llm up -d chroma");
      log.error("See docs/setup.md for the current optional-stack configuration.");
      return false;
    }
  }

  // Check if collection has documents
  try {
    const stats = await getStats();
    if (stats.count === 0) {
      log.warn(`ChromaDB collection "${llmConfig.collectionName}" is empty`);
      log.warn("Run: bun run index");
    } else {
      log.info(`ChromaDB collection has ${stats.count} documents`);
    }
  } catch {
    log.warn("Could not check ChromaDB collection status");
  }

  // List available models
  try {
    const models = await listModels();
    const hasEmbed = models.some(m => m.includes(llmConfig.embeddingModel.split(":")[0]));
    const hasChat = models.some(m => m.includes(llmConfig.chatModel.split(":")[0]));
    if (!hasEmbed) {
      log.warn(`Embedding model "${llmConfig.embeddingModel}" not found. Pull: ollama pull ${llmConfig.embeddingModel}`);
    }
    if (!hasChat) {
      log.warn(`Chat model "${llmConfig.chatModel}" not found. Pull: ollama pull ${llmConfig.chatModel}`);
    }
  } catch {
    // Non-fatal
  }

  return true;
}

async function runIndex() {
  log.info("=== Crescent City Municipal Code — Indexing Pipeline ===");
  if (!(await checkPrerequisites())) process.exit(1);
  const flag = process.argv.slice(3).find(arg => arg.startsWith("--deadline-ms="));
  const deadlineMs = flag ? Number(flag.slice("--deadline-ms=".length)) : 300_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 3_600_000) throw new Error("--deadline-ms must be an integer from 1 to 3600000");
  await indexAllSections({ deadlineMs });
}

async function runChat() {
  log.info("=== Crescent City Municipal Code — RAG Chat ===");
  if (!(await checkPrerequisites())) process.exit(1);

  const indexed = await isIndexed();
  if (!indexed) {
    log.error("No documents indexed. Run 'bun run index' first.");
    process.exit(1);
  }

  const stats = await getStats();
  log.info(`Collection: ${stats.name} (${stats.count} documents)`);
  log.info(`Chat model: ${llmConfig.chatModel}`);
  console.log('Type "exit" to quit.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = () => {
    rl.question("You: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed.toLowerCase() === "exit") {
        rl.close();
        return;
      }

      try {
        const response = await ragQuery(trimmed);
        console.log(`\nAssistant: ${response.answer}`);
        if (response.sources.length > 0) {
          console.log("\nSources:");
          for (const s of response.sources) {
            console.log(`  - ${s.sectionNumber}: ${s.sectionTitle} (score: ${s.score.toFixed(3)})`);
          }
        }
        console.log("");
      } catch (err: any) {
        log.error(`Query failed: ${err.message}`);
      }

      ask();
    });
  };

  ask();
}

async function runQuery() {
  const question = process.argv.slice(3).join(" ");
  if (!question) {
    log.error('Usage: bun run src/llm/index.ts query "your question here"');
    process.exit(1);
  }

  if (!(await checkPrerequisites())) process.exit(1);

  const indexed = await isIndexed();
  if (!indexed) {
    log.error("No documents indexed. Run 'bun run index' first.");
    process.exit(1);
  }

  const response = await ragQuery(question);
  console.log(`\nAnswer: ${response.answer}\n`);

  if (response.sources.length > 0) {
    console.log("Sources:");
    for (const s of response.sources) {
      console.log(`  - ${s.sectionNumber}: ${s.sectionTitle} (score: ${s.score.toFixed(3)})`);
    }
  }
}

async function runStatus() {
  log.info("=== Crescent City Municipal Code — LLM Status ===");

  const provider = await checkChatProvider();
  log.info(`Chat provider (${provider.provider}): ${provider.reachable ? "✅ READY" : "❌ UNAVAILABLE"}`);
  log.info(`  Chat model: ${provider.model}`);
  if (provider.error) log.warn(`  Provider detail: ${provider.error}`);

  const ollama = await isOllamaRunning();
  log.info(`Ollama (${llmConfig.ollamaUrl}): ${ollama ? "✅ RUNNING" : "❌ NOT RUNNING"}`);

  if (ollama) {
    try {
      const models = await listModels();
      log.info(`  Models: ${models.join(", ") || "none"}`);
      log.info(`  Embedding model: ${llmConfig.embeddingModel}`);
    } catch {}
  }

  const chroma = await isChromaRunning();
  log.info(`ChromaDB (${llmConfig.chromaUrl}): ${chroma ? "✅ RUNNING" : "❌ NOT RUNNING"}`);

  if (chroma) {
    try {
      const stats = await getStats();
      log.info(`  Collection: ${stats.name}`);
      log.info(`  Documents: ${stats.count}`);
    } catch {}
  }
}

async function runSemanticReview() {
  const [inputPath, outputPath, annotationPath, ...extra] = process.argv.slice(3);
  if (!inputPath || !outputPath || extra.length || command === "review-package" && annotationPath || command === "replay-context" && annotationPath && !/^--deadline-ms=\d+$/.test(annotationPath) || command === "review-assess" && annotationPath?.startsWith("--")) throw new Error("Usage: review-package INPUT OUTPUT | review-assess PACKAGE OUTPUT [ANNOTATIONS] | replay-context SUITE OUTPUT [--deadline-ms=N]");
  const readJson = async (path: string) => {
    const file = await open(path, "r");
    try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 4_000_000) throw new Error("Review input must be a regular JSON file of at most 4 MB"); const bytes = Buffer.alloc(4_000_001); let length = 0; while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length); if (!read.bytesRead) break; length += read.bytesRead; } if (length > 4_000_000) throw new Error("Review input exceeded its byte limit"); return JSON.parse(bytes.subarray(0, length).toString("utf8")); }
    finally { await file.close(); }
  };
  const input = await readJson(inputPath);
  const deadlineMs = annotationPath?.startsWith("--deadline-ms=") ? Number(annotationPath.slice(14)) : undefined;
  const result = command === "replay-context" ? await evaluateContextReplay(input, {deadlineMs}) : command === "review-package" ? buildSemanticReviewPackage(input as SemanticReviewInput) : assessSemanticAnnotations(input, annotationPath ? await readJson(annotationPath) : undefined);
  const file = await open(outputPath, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(result, null, 2) + "\n"); } finally { await file.close(); }
  console.log("Private review artifact written; supplied annotations do not verify reviewer identity or factuality.");
}

switch (command) {
  case "replay-context":
  case "review-package":
  case "review-assess":
    await runSemanticReview();
    break;
  case "index":
    await runIndex();
    break;
  case "chat":
    await runChat();
    break;
  case "query":
    await runQuery();
    break;
  case "status":
    await runStatus();
    break;
  default:
    console.log("Crescent City Municipal Code — LLM Module\n");
    console.log("Commands:");
    console.log("  review-package INPUT OUTPUT | review-assess PACKAGE OUTPUT [ANNOTATIONS] | replay-context SUITE OUTPUT [--deadline-ms=N]");
    console.log("  bun run src/llm/index.ts index    Index all sections into ChromaDB [--deadline-ms=300000]");
    console.log("  bun run src/llm/index.ts chat     Interactive RAG chat");
    console.log('  bun run src/llm/index.ts query "question"  Single query');
    console.log("  bun run src/llm/index.ts status   Show index stats and model info");
    break;
}
