/**
 * Regression tests for the bounded JSONL history appenders (R7: per-monitor
 * alert history.jsonl files previously grew without bound and were re-read in
 * full every run). The tail-trim keeps a file to at most `maxLines` while
 * preserving the most-recent records that alert_analytics actually reads.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
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
    mkdirSync(dir, { recursive: true });
    rmSync(file, { force: true });
    for (let i = 0; i < 10; i++) await appendBoundedJsonl(file, { n: i }, 3);
    const l = lines();
    expect(l.length).toBe(3);
    // Must retain the LAST 3 records (most recent).
    expect(JSON.parse(l[0]).n).toBe(7);
    expect(JSON.parse(l[2]).n).toBe(9);
  }, 60000);

  test("sync appender trims to the tail too", async () => {
    const syncFile = join(dir, "sync-trim.jsonl");
    mkdirSync(dir, { recursive: true });
    rmSync(syncFile, { force: true });
    for (let i = 0; i < 6; i++) appendBoundedJsonlSync(syncFile, { m: i }, 2);
    const l = readFileSync(syncFile, "utf-8").split("\n").filter(Boolean);
    expect(l.length).toBe(2);
    expect(JSON.parse(l[0]).m).toBe(4);
    expect(JSON.parse(l[1]).m).toBe(5);
  }, 60000);

  test("accepts a pre-serialized JSON string (monitor compat)", async () => {
    mkdirSync(dir, { recursive: true });
    rmSync(file, { force: true });
    await appendBoundedJsonl(file, JSON.stringify({ s: "x" }), 10);
    const last = JSON.parse(lines().at(-1)!);
    expect(last.s).toBe("x");
  }, 60000);

  test("a small file stays untrimmed", async () => {
    mkdirSync(dir, { recursive: true });
    const small = join(dir, "small.jsonl");
    rmSync(small, { force: true });
    await appendBoundedJsonl(small, { a: 1 }, 100);
    await appendBoundedJsonl(small, { a: 2 }, 100);
    expect(readFileSync(small, "utf-8").split("\n").filter(Boolean).length).toBe(2);
  }, 60000);
});
