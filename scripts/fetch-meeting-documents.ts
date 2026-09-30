#!/usr/bin/env bun
/** Explicit bounded acquisition; retained bytes and parsing live in src/. */
import { captureMeetingDocuments } from "../src/meeting_documents.js";
const args = Bun.argv.slice(2);
if (args.some(arg => !/^--(?:limit|deadline-ms)=\d+$/.test(arg))) throw new Error("Supported arguments: --limit=N --deadline-ms=N");
const value = (flag: string, fallback: number) => Number(args.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? fallback);
console.log(JSON.stringify(await captureMeetingDocuments({ limit: value("--limit", 10), deadlineMs: value("--deadline-ms", 300000) }), null, 2));
