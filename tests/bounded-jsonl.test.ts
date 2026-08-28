/**
 * Regression tests for the bounded JSONL history appenders (R7: per-monitor
 * alert history.jsonl files previously grew without bound and were re-read in
 * full every run). The tail-trim keeps a file to at most `maxLines` while
 * preserving the most-recent records that alert_analytics actually reads.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { appendBoundedJsonl, appendBoundedJsonlSync } from "../src/shared/source_health.ts";

const dir = join(process.cwd(), "output", "state", "bounded-jsonl-test");
const file = join(dir, "history.jsonl");

function lines(): string[] {
  return readFileSync(file, "utf-8").split("\n").filter(Boolean);
}

beforeAll(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("appendBoundedJsonl", () => {
  test("async appender trims to the most-recent tail when over the cap", async () => {
    for (let i = 0; i < 10; i++) await appendBoundedJsonl(file, { n: i }, 3);
    const l = lines();
    expect(l.length).toBe(3);
    // Must retain the LAST 3 records (most recent).
    expect(JSON.parse(l[0]).n).toBe(7);
    expect(JSON.parse(l[2]).n).toBe(9);
  });

  test("sync appender trims to the tail too", () => {
    const syncFile = join(dir, "sync-trim.jsonl");
    for (let i = 0; i < 6; i++) appendBoundedJsonlSync(syncFile, { m: i }, 2);
    const l = readFileSync(syncFile, "utf-8").split("\n").filter(Boolean);
    expect(l.length).toBe(2);
    expect(JSON.parse(l[0]).m).toBe(4);
    expect(JSON.parse(l[1]).m).toBe(5);
  });

  test("accepts a pre-serialized JSON string (monitor compat)", async () => {
    await appendBoundedJsonl(file, JSON.stringify({ s: "x" }), 10);
    const last = JSON.parse(lines().at(-1)!);
    expect(last.s).toBe("x");
  });

  test("a small file stays untrimmed", async () => {
    const small = join(dir, "small.jsonl");
    await appendBoundedJsonl(small, { a: 1 }, 100);
    await appendBoundedJsonl(small, { a: 2 }, 100);
    expect(readFileSync(small, "utf-8").split("\n").filter(Boolean).length).toBe(2);
  });
});
