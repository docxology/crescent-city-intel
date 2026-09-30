#!/usr/bin/env bun
/** Explicit reproducible retrieval/generation evaluation; no automatic provider spend. */
import { evaluateRagBenchmark, validateRagBenchmarkSuite } from "../src/llm/benchmark.js";
import { writeJsonAtomic } from "../src/shared/source_health.js";
import { paths } from "../src/shared/paths.js";
import { join } from "node:path";
const args = Bun.argv.slice(2);
const value = (name: string, fallback: string) => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
if (args.some(arg => !["--generate"].includes(arg) && !["--suite=", "--output=", "--deadline-ms="].some(prefix => arg.startsWith(prefix)))) throw new Error("Supported arguments: --generate --suite=path --output=path --deadline-ms=N");
const suite = validateRagBenchmarkSuite(await Bun.file(value("--suite", "tests/fixtures/rag-benchmark-v1.json")).json());
const receipt = await evaluateRagBenchmark({ suite, generate: args.includes("--generate"), deadlineMs: Number(value("--deadline-ms", "300000")), onCase: id => console.log(`Evaluating ${id}`) });
const destination = value("--output", join(paths.state, "rag-benchmark.json"));
await writeJsonAtomic(destination, receipt);
console.log(JSON.stringify({ artifact: destination, receipt }));
