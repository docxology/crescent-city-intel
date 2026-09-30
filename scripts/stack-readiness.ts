#!/usr/bin/env bun
import { waitForStackReadiness } from "../src/stack_readiness.js";
const receipt = await waitForStackReadiness({ ollama: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434", chroma: process.env.CHROMA_URL ?? "http://127.0.0.1:8001", models: [process.env.EMBEDDING_MODEL ?? "nomic-embed-text", process.env.CHAT_MODEL ?? "gemma3:4b"] });
console.log(JSON.stringify(receipt, null, 2));
if (!receipt.ready) process.exitCode = 1;
