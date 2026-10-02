import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDirectoryArtifact } from "../src/directory.ts";
import { createArtifactCustody, validateArtifactCustody, replayArtifactCustody, captureArtifactBytes, canonicalArtifactJson } from "../src/artifact_custody.ts";
import { runBoundedChild } from "../src/shared/subprocess.ts";

test("regular-file custody rejects a real FIFO before its opening can block", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-custody-fifo-")), fifo = join(root, "input.json");
  try {
    const made = await runBoundedChild(["/usr/bin/mkfifo", fifo], { timeoutMs: 2000 }); expect(made.status).toBe("ok");
    const module = new URL("../src/artifact_custody.ts", import.meta.url).href;
    const code = `const{captureArtifactBytes}=await import(${JSON.stringify(module)});try{await captureArtifactBytes(${JSON.stringify(fifo)},4096);process.exitCode=1;}catch(error){console.log(JSON.stringify({message:String(error.message)}));}`;
    const result = await runBoundedChild([process.execPath, "-e", code], { timeoutMs: 2000, maxBytes: 16 * 1024 });
    expect(result.status).toBe("ok"); expect(result.reaped).toBe(true);
    expect(JSON.parse(result.stdout).message).toContain("bounded regular file");
  } finally { await rm(root, { recursive: true, force: true }); }
});
import { exportPagesSnapshot } from "../src/pages_snapshot.ts";
import { validatePagesArtifact } from "../src/pages_validation.ts";
import { hashPublicationTree, publicationHash } from "../src/publication_bundle.ts";
import { writePublicationFixture } from "./helpers/publication-fixture.ts";
const bytes = (text: string) => new TextEncoder().encode(text);
const stamp = "2026-09-30T00:00:00Z";
const seed = bytes(JSON.stringify({ entries: [{ name: "Library", category: "Government", address: null, phone: null, website: null, description: null, source: "https://example.test/library" }] }));
const transform = (inputs: Readonly<Record<string, Uint8Array>>, config: unknown) => bytes(`${JSON.stringify(buildDirectoryArtifact((config as { generatedAt: string }).generatedAt, JSON.parse(new TextDecoder().decode(inputs["seed/directory.json"]))))}\n`);
test("derived directory receipt binds exact retained source, transform, configuration and deterministic replay", async () => {
  const evidence = { inputs: { "seed/directory.json": seed }, transforms: { "src/directory.ts": await captureArtifactBytes(join(process.cwd(), "src/directory.ts")), "src/artifact_contracts.ts": await captureArtifactBytes(join(process.cwd(), "src/artifact_contracts.ts")) }, configuration: { generatedAt: stamp } };
  const output = transform(evidence.inputs, evidence.configuration), receipt = createArtifactCustody("directory", output, evidence, stamp);
  expect(validateArtifactCustody(receipt, output, evidence)).toEqual([]);
  expect(await replayArtifactCustody(receipt, output, evidence, transform)).toEqual([]);
  expect(receipt.evidenceBoundary).toBe("byte-identity-and-replay-only");
  expect(JSON.stringify(receipt)).not.toContain("Library");
  for (const corrupt of [
    { ...evidence, inputs: { "seed/directory.json": bytes(`${new TextDecoder().decode(seed)} `) } },
    { ...evidence, inputs: { ...evidence.inputs, "seed/extra.json": seed } },
    { ...evidence, transforms: { ...evidence.transforms, "src/directory.ts": bytes("changed transformer") } },
    { ...evidence, configuration: { generatedAt: "2026-10-01T00:00:00Z" } },
  ]) expect(validateArtifactCustody(receipt, output, corrupt).length).toBeGreaterThan(0);
  expect(validateArtifactCustody(receipt, bytes(`${new TextDecoder().decode(output)} `), evidence).length).toBeGreaterThan(0);
  expect(await replayArtifactCustody(receipt, output, evidence, () => bytes("{}"))).toEqual(["custody: deterministic replay output mismatch"]);
  expect(validateArtifactCustody({ ...receipt, inputs: {} }, output, evidence).length).toBeGreaterThan(0);
  expect(() => createArtifactCustody("directory", output, { ...evidence, inputs: { "../private.json": seed } }, stamp)).toThrow();
});
test("real retained-file capture refuses symlink inputs; canonical config rejects non-JSON values", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-derived-custody-"));
  try {
    const source = join(root, "seed.json"), link = join(root, "link.json");
    await writeFile(source, seed); await symlink(source, link);
    expect(await captureArtifactBytes(source)).toEqual(seed);
    await expect(captureArtifactBytes(source, 1)).rejects.toThrow("bounded");
    await expect(captureArtifactBytes(link)).rejects.toThrow();
    for (const limit of [Infinity, NaN, 0, -1, 1.5, 64 * 1024 * 1024 + 1]) await expect(captureArtifactBytes(source, limit)).rejects.toThrow("byte bound");
  } finally { await rm(root, { recursive: true, force: true }); }
  expect(canonicalArtifactJson({ z: 1, a: [null, true] })).toBe('{"a":[null,true],"z":1}');
  expect(() => canonicalArtifactJson({ bad: Infinity })).toThrow();
  expect(() => canonicalArtifactJson({ bad: undefined })).toThrow();
});
test("actual Pages directory export requires seed/transform/output custody even after publication hashes are recomputed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-directory-pages-"));
  try {
    const output = join(root, "output"), publicSeed = join(root, "seed"), destination = join(root, "pages"), seedPath = join(publicSeed, "directory.json");
    await writePublicationFixture(output); await mkdir(publicSeed); await writeFile(seedPath, seed);
    const result = await exportPagesSnapshot({ outputDir: output, destination, seedDir: publicSeed, generatedAt: stamp });
    expect(result.files).toContain("data/directory-custody.json");
    expect(await validatePagesArtifact(destination, { sourceDirectorySeedPath: seedPath })).toEqual([]);
    const receiptPath = join(destination, "data/directory-custody.json"), outputPath = join(destination, "data/directory.json");
    const originalReceipt = await readFile(receiptPath, "utf8"), originalOutput = await readFile(outputPath, "utf8");
    const rehash = async () => {
      const path = join(destination, "publication-manifest.json"), manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.files = await hashPublicationTree(destination); manifest.editionId = publicationHash(JSON.stringify(manifest.files)); await writeFile(path, JSON.stringify(manifest));
    };
    for (const mutate of [(r: any) => r.inputs["seed/directory.json"].sha256 = "0".repeat(64), (r: any) => r.transforms["src/directory.ts"].sha256 = "0".repeat(64), (r: any) => r.configurationSha256 = "0".repeat(64)]) {
      const receipt = JSON.parse(originalReceipt); mutate(receipt); await writeFile(receiptPath, JSON.stringify(receipt)); await rehash();
      expect((await validatePagesArtifact(destination, { sourceDirectorySeedPath: seedPath })).join(";")).toContain("directory-custody");
    }
    await writeFile(receiptPath, originalReceipt); const changed = JSON.parse(originalOutput); changed.entries[0].name = "Invented Library"; await writeFile(outputPath, JSON.stringify(changed)); await rehash();
    expect((await validatePagesArtifact(destination, { sourceDirectorySeedPath: seedPath })).join(";")).toContain("output bytes mismatch");
    await writeFile(outputPath, originalOutput); await writeFile(seedPath, new Uint8Array([...seed, 32])); await rehash();
    expect((await validatePagesArtifact(destination, { sourceDirectorySeedPath: seedPath })).join(";")).toContain("input membership or bytes mismatch");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
