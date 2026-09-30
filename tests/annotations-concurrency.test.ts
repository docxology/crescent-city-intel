import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAnnotation, deleteAnnotation, readAnnotationStore } from "../src/gui/annotations.js";
test("concurrent annotation transactions preserve each record and reject corrupt custody", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cci-annotations-"));
  const original = process.env.CC_OUTPUT_DIR;
  process.env.CC_OUTPUT_DIR = directory;
  try {
    const records = await Promise.all(Array.from({ length: 12 }, (_, index) => addAnnotation({ x: index, y: 5, text: `Note ${index}` })));
    expect(readAnnotationStore().annotations.length).toBe(12);
    expect(new Set(records.map(record => record.id)).size).toBe(12);
    await Promise.all(records.slice(0, 6).map(record => deleteAnnotation(record.id)));
    expect(readAnnotationStore().annotations.map(record => record.id).sort()).toEqual(records.slice(6).map(record => record.id).sort());
    const file = join(directory, "state", "annotations.json");
    await writeFile(file, '{"schemaVersion":"1.0.0","annotations":[{"id":"malformed"}]}');
    const bytes = await readFile(file, "utf8");
    await expect(addAnnotation({ x: 1, y: 1, text: "New" })).rejects.toThrow("preserve it for repair");
    expect(await readFile(file, "utf8")).toBe(bytes);
  } finally { if (original === undefined) delete process.env.CC_OUTPUT_DIR; else process.env.CC_OUTPUT_DIR = original; await rm(directory, { recursive: true, force: true }); }
});
