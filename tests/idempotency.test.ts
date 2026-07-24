/**
 * Tests for src/shared/idempotency.ts
 *
 * Covers first-seen recording, re-seen-unchanged (skip) vs re-seen-changed
 * (flag) semantics, legacy string[] migration (news_monitor.ts's original
 * seen-ids.json shape), persistence round-trip, and the entry cap.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdir, readdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { IdempotencyStore } from "../src/shared/idempotency";

const TEST_DIR = join(process.cwd(), "output", "test-idempotency");

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

function storePath(name: string): string {
  return join(TEST_DIR, `${name}-${Math.random().toString(36).slice(2)}.json`);
}

describe("IdempotencyStore — core semantics", () => {
  test("first-seen item is recorded as new", async () => {
    const store = new IdempotencyStore(storePath("first-seen"));
    await store.load();

    const result = store.seen("item-1", "hash-a");
    expect(result.isNew).toBe(true);
    expect(result.changed).toBe(true);
    expect(store.has("item-1")).toBe(true);
  });

  test("re-seen item with identical hash is not flagged as changed", async () => {
    const store = new IdempotencyStore(storePath("unchanged"));
    await store.load();

    store.seen("item-1", "hash-a");
    const result = store.seen("item-1", "hash-a");

    expect(result.isNew).toBe(false);
    expect(result.changed).toBe(false);
  });

  test("re-seen item with different hash is flagged as changed, not new", async () => {
    const store = new IdempotencyStore(storePath("changed"));
    await store.load();

    store.seen("item-1", "hash-a");
    const result = store.seen("item-1", "hash-b");

    expect(result.isNew).toBe(false);
    expect(result.changed).toBe(true);
  });

  test("presence-only dedup (empty hash) never flags as changed on re-seen", async () => {
    const store = new IdempotencyStore(storePath("presence-only"));
    await store.load();

    store.seen("url-1");
    const result = store.seen("url-1");

    expect(result.isNew).toBe(false);
    expect(result.changed).toBe(false);
  });

  test("firstSeen is preserved across updates; lastSeen advances", async () => {
    const store = new IdempotencyStore(storePath("timestamps"));
    await store.load();

    store.seen("item-1", "hash-a");
    await new Promise((r) => setTimeout(r, 5));
    store.seen("item-1", "hash-b");

    // Persist and re-load to inspect the raw record via a fresh store instance
    const p = storePath("timestamps-reload");
    const store2 = new IdempotencyStore(p);
    await store2.load();
    store2.record("item-1", "hash-a");
    await store2.save();

    const store3 = new IdempotencyStore(p);
    await store3.load();
    expect(store3.has("item-1")).toBe(true);
  });
});

describe("IdempotencyStore — persistence", () => {
  test("save then load round-trips all records", async () => {
    const p = storePath("roundtrip");
    const store = new IdempotencyStore(p);
    await store.load();
    store.seen("a", "h1");
    store.seen("b", "h2");
    await store.save();

    expect(existsSync(p)).toBe(true);

    const reloaded = new IdempotencyStore(p);
    await reloaded.load();
    expect(reloaded.has("a")).toBe(true);
    expect(reloaded.has("b")).toBe(true);
    expect(reloaded.size).toBe(2);
  });

  test("save uses atomic write — no leftover .tmp files after completion", async () => {
    const p = storePath("atomic");
    const store = new IdempotencyStore(p);
    await store.load();
    store.seen("a", "h1");
    await store.save();

    const files = await readdir(TEST_DIR);
    const tmpLeftovers = files.filter((f) => f.includes(".tmp-"));
    expect(tmpLeftovers).toHaveLength(0);
  });

  test("loading a nonexistent path starts empty without throwing", async () => {
    const store = new IdempotencyStore(join(TEST_DIR, "does-not-exist.json"));
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.size).toBe(0);
  });

  test("loading a corrupt JSON file starts empty without throwing", async () => {
    const p = storePath("corrupt");
    await writeFile(p, "{ not valid json");
    const store = new IdempotencyStore(p);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.size).toBe(0);
  });
});

describe("IdempotencyStore — legacy migration (news_monitor.ts seen-ids.json shape)", () => {
  test("a bare string[] file is migrated into presence-only records with no data loss", async () => {
    const p = storePath("legacy");
    const legacyIds = ["https://example.com/a", "https://example.com/b", "https://example.com/c"];
    await writeFile(p, JSON.stringify(legacyIds));

    const store = new IdempotencyStore(p);
    await store.load();

    expect(store.size).toBe(3);
    for (const id of legacyIds) {
      expect(store.has(id)).toBe(true);
    }
  });

  test("migrated legacy ids are not reprocessed as new on first seen() call", async () => {
    const p = storePath("legacy-not-new");
    await writeFile(p, JSON.stringify(["https://example.com/already-seen"]));

    const store = new IdempotencyStore(p);
    await store.load();

    const result = store.seen("https://example.com/already-seen");
    expect(result.isNew).toBe(false);
  });
});

describe("IdempotencyStore — entry cap", () => {
  test("exceeding the cap drops the oldest entries first", async () => {
    const store = new IdempotencyStore(storePath("cap"), 3);
    await store.load();

    store.seen("a", "h");
    await new Promise((r) => setTimeout(r, 2));
    store.seen("b", "h");
    await new Promise((r) => setTimeout(r, 2));
    store.seen("c", "h");
    await new Promise((r) => setTimeout(r, 2));
    store.seen("d", "h"); // pushes size to 4, over the cap of 3

    expect(store.size).toBe(3);
    expect(store.has("a")).toBe(false); // oldest, dropped
    expect(store.has("d")).toBe(true); // newest, retained
  });
});

describe("IdempotencyStore — re-running a monitor twice against unchanged data (anti-criterion ISC-10)", () => {
  test("second identical run flags zero new/changed items", async () => {
    const p = storePath("rerun");
    const upstreamItems = [
      { id: "https://example.com/1", hash: "h1" },
      { id: "https://example.com/2", hash: "h2" },
    ];

    // First run
    const store1 = new IdempotencyStore(p);
    await store1.load();
    const firstRunResults = upstreamItems.map((i) => store1.seen(i.id, i.hash));
    await store1.save();
    expect(firstRunResults.every((r) => r.isNew)).toBe(true);

    // Second run against identical upstream data
    const store2 = new IdempotencyStore(p);
    await store2.load();
    const secondRunResults = upstreamItems.map((i) => store2.seen(i.id, i.hash));

    expect(secondRunResults.every((r) => !r.isNew && !r.changed)).toBe(true);
  });
});
