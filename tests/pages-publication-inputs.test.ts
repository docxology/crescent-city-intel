import { test, expect } from "bun:test";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capturePagesPublicationInputs, assertPagesInputsUnchanged, withCapturedPagesInputs, readPagesInputArchive, createPagesFactInputReceipt, retainPagesInputArchive, PAGES_FACT_INPUT_RECEIPT } from "../src/pages_publication_inputs.ts";
import { exportPagesSnapshot, replayPagesPublicationArchive, buildPagesSnapshot } from "../src/pages_snapshot.ts";
import { canonicalArtifactJson } from "../src/artifact_custody.ts";
import { hashPublicationTree, publicationHash } from "../src/publication_bundle.ts";
import { validatePagesArtifact } from "../src/pages_validation.ts";
import { paths } from "../src/shared/paths.ts";
import { writePublicationFixture } from "./helpers/publication-fixture.ts";

const stamp = "2026-10-01T00:00:00Z";
const news = (title: string) => `${JSON.stringify({ items: [{ id: "public-1", title, link: "https://example.test/civic", source: "Lost Coast Outpost", pubDate: stamp }] })}\n`;
async function fixture(task: (root: string, output: string, seed: string, destination: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cci-pages-fact-input-"));
  try {
    const output = join(root, "output"), seed = join(root, "seed"), destination = join(root, "public");
    await writePublicationFixture(output); await mkdir(seed); await mkdir(join(output, "news")); await writeFile(join(output, "news", "news-fixture.json"), news("Retained public council update"));
    await task(root, output, seed, destination);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test("actual Pages export commits exact producer/core inputs and replays final snapshot after originals disappear", async () => fixture(async (_root, output, seed, destination) => {
  await mkdir(join(output, "state")); await writeFile(join(output, "state", "search-queries.jsonl"), "PRIVATE-SEARCH-SENTINEL\n");
  await mkdir(join(output, "youtube", "raw"), { recursive: true }); await writeFile(join(output, "youtube", "raw", "private.json"), '{"raw":"PRIVATE-RAW-SENTINEL"}');
  const result = await exportPagesSnapshot({ outputDir: output, seedDir: seed, destination, generatedAt: stamp });
  expect(result.files).toContain(PAGES_FACT_INPUT_RECEIPT);
  expect(await validatePagesArtifact(destination)).toEqual([]);
  const receipt = JSON.parse(await readFile(join(destination, PAGES_FACT_INPUT_RECEIPT), "utf8"));
  expect(receipt.inputs["output/news/news-fixture.json"].sha256).toBe(publicationHash(news("Retained public council update")));
  expect(receipt.municipalInputPrefix).toBe("output");
  expect(Object.keys(receipt.transforms)).toContain("src/pages/static/assets/site.js");
  expect(Object.keys(receipt.transforms)).toContain("bun.lock");
  expect(Object.keys(receipt.inputs).join()).not.toContain("search-queries");
  expect(Object.keys(receipt.inputs).join()).not.toContain("/raw/");
  expect(JSON.stringify(receipt)).not.toContain("Retained public council update");
  expect(receipt.evidenceBoundary).toContain("not-semantic-support");
  const archives = join(output, "state", "pages-publication"), archive = join(archives, (await readdir(archives))[0]!);
  const retained = await readPagesInputArchive(archive);
  expect(await validatePagesArtifact(destination, { inputArchive: archive })).toEqual([]);
  expect(new TextDecoder().decode(retained.capture.inputs["output/news/news-fixture.json"])).toBe(news("Retained public council update"));
  expect((await stat(join(archive, "inputs/output/news/news-fixture.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(archive)).mode & 0o777).toBe(0o700);
  expect(JSON.parse(new TextDecoder().decode(retained.snapshot)).files.codeSearchBodyIndex).toMatch(/^data\/code-search-x\.[0-9a-f]{8}\.json$/);
  // Replay cannot consult the original producer or municipal files.
  await rm(join(output, "news"), { recursive: true }); await rm(join(output, "manifest.json"));
  expect(await replayPagesPublicationArchive(archive)).toEqual([]);
  const forgedSnapshot = JSON.parse(new TextDecoder().decode(retained.snapshot)); forgedSnapshot.news[0].title = "Invented archive claim";
  const forgedBytes = new TextEncoder().encode(`${JSON.stringify(forgedSnapshot, null, 2)}\n`);
  const forgedReceipt = createPagesFactInputReceipt(retained.capture, forgedBytes, retained.configuration, retained.receipt.municipal, stamp, retained.receipt.commit);
  const forgedArchive = await retainPagesInputArchive(output, retained.capture, retained.configuration, forgedReceipt, forgedBytes);
  // Even completely recomputed archive hashes cannot certify an output the actual transformer did not make.
  expect((await replayPagesPublicationArchive(forgedArchive)).join()).toContain("deterministic snapshot replay mismatch (news)");
  expect((await validatePagesArtifact(destination, { inputArchive: forgedArchive })).join()).toContain("belongs to another publication");
  const extra = join(archive, "inputs/output/news/news-undeclared.json"); await writeFile(extra, news("Undeclared archive member"));
  await expect(readPagesInputArchive(archive)).rejects.toThrow("membership mismatch"); await rm(extra);
  await writeFile(join(archive, "inputs/output/news/news-fixture.json"), news("Changed private archive"));
  await expect(readPagesInputArchive(archive)).rejects.toThrow("identity mismatch");
}), 30000);

test("captured reconstruction owns its root and membership changes cannot pass admission", async () => fixture(async (root, output, seed) => {
  await mkdir(join(output, "reports"));
  const capture = await capturePagesPublicationInputs(output, seed);
  expect(await withCapturedPagesInputs(capture, async roots => {
    expect(paths.output).toBe(roots.output);
    expect((await stat(join(roots.output, "reports"))).isDirectory()).toBe(true);
    const snapshot = await buildPagesSnapshot(roots.output, stamp, roots.seed);
    return snapshot.news[0]?.title;
  })).toBe("Retained public council update");
  await assertPagesInputsUnchanged(capture);
  await writeFile(join(output, "news", "news-new.json"), news("New public membership"));
  await expect(assertPagesInputsUnchanged(capture)).rejects.toThrow("changed during export");
  await rm(join(output, "news", "news-new.json")); await mkdir(join(output, "events"));
  await expect(assertPagesInputsUnchanged(capture)).rejects.toThrow("changed during export");
  await symlink(output, join(root, "output-link"));
  await expect(capturePagesPublicationInputs(join(root, "output-link"), seed)).rejects.toThrow("symlinks");
  await symlink(join(output, "news"), join(seed, "news"));
  await expect(capturePagesPublicationInputs(output, seed)).rejects.toThrow("directory");
}), 15000);

test("direct archive helper refuses escaping or unbound evidence before any owned or outside writes", async () => fixture(async (root, output, seed, destination) => {
  await exportPagesSnapshot({ outputDir: output, seedDir: seed, destination, generatedAt: stamp });
  const base = join(output, "state", "pages-publication"), archive = join(base, (await readdir(base))[0]!);
  const retained = await readPagesInputArchive(archive), before = await readdir(base);
  const outside = join(base, "escaped.json"); await writeFile(outside, "preserved outside bytes");
  const escaping = { ...retained.capture, inputs: { ...retained.capture.inputs, "../../escaped.json": new TextEncoder().encode("attacker bytes") } };
  await expect(retainPagesInputArchive(output, escaping, retained.configuration, retained.receipt, retained.snapshot)).rejects.toThrow("membership");
  await expect(withCapturedPagesInputs(escaping, async () => undefined)).rejects.toThrow("membership");
  const badMetadata = { ...retained.capture, inputs: { ...retained.capture.inputs, "capture/membership.json": new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(retained.capture.inputs["capture/membership.json"])), "../../escaped/": true })) } };
  await expect(retainPagesInputArchive(output, badMetadata, retained.configuration, retained.receipt, retained.snapshot)).rejects.toThrow("metadata is invalid");
  for (const changed of [
    { ...retained.capture, inputs: { ...retained.capture.inputs, "output/news/news-fixture.json": new TextEncoder().encode(news("Changed admission bytes")) } },
    { ...retained.capture, transforms: { ...retained.capture.transforms, "src/pages_snapshot.ts": new TextEncoder().encode("changed transform") } },
  ]) await expect(retainPagesInputArchive(output, changed, retained.configuration, retained.receipt, retained.snapshot)).rejects.toThrow("exact valid receipt");
  await expect(retainPagesInputArchive(join(root, "never-created"), retained.capture, retained.configuration, {} as any, retained.snapshot)).rejects.toThrow();
  expect((await readdir(base)).sort()).toEqual([...before, "escaped.json"].sort());
  expect(await readFile(outside, "utf8")).toBe("preserved outside bytes");
  await expect(stat(join(root, "never-created"))).rejects.toThrow();
}), 15000);

test("a sparse oversized producer file is rejected before allocating its contents", async () => fixture(async (_root, output, seed) => {
  const handle = await open(join(output, "news", "news-oversized.json"), "wx");
  try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await expect(capturePagesPublicationInputs(output, seed)).rejects.toThrow("bounded regular file");
}), 10000);

test("external municipal selection and reviewed fallback retain their distinct declared roots during actual replay", async () => fixture(async (root, output, seed, destination) => {
  await writePublicationFixture(seed, "Reviewed fallback municipal text");
  const external = join(root, "external-partial"); await mkdir(external); await writeFile(join(external, "manifest.json"), "{}");
  await exportPagesSnapshot({ outputDir: output, municipalDir: external, seedDir: seed, destination, generatedAt: stamp });
  const receipt = JSON.parse(await readFile(join(destination, PAGES_FACT_INPUT_RECEIPT), "utf8"));
  expect(receipt.captureRootSelection).toBe("municipal"); expect(receipt.municipalInputPrefix).toBe("seed"); expect(receipt.municipal.selection).toBe("reviewed-seed");
  expect(receipt.inputs["municipal/manifest.json"].sha256).toBe(publicationHash("{}"));
  const base = join(output, "state", "pages-publication"), archive = join(base, (await readdir(base))[0]!);
  expect((await readPagesInputArchive(archive)).capture.municipalInputPrefix).toBe("municipal");
  expect(await replayPagesPublicationArchive(archive)).toEqual([]);
}), 15000);

test("a real producer change after input capture rejects export and preserves active publication bytes", async () => fixture(async (_root, output, seed, destination) => {
  await exportPagesSnapshot({ outputDir: output, seedDir: seed, destination, generatedAt: stamp });
  const before = await hashPublicationTree(destination); let changes = 0;
  const producer = join(output, "news", "news-fixture.json"), changedBytes = news("Raced public update");
  const options = {
    outputDir: output, seedDir: seed, generatedAt: stamp,
    // The exporter reads destination when forwarding options after exact input
    // capture/reconstruction. This real write completes at that boundary;
    // filesystem notification scheduling cannot move it beyond the final guard.
    get destination(): string {
      changes++;
      if (changes === 1) writeFileSync(producer, changedBytes);
      return destination;
    },
  };
  await expect(exportPagesSnapshot(options)).rejects.toThrow("changed during export");
  expect(changes).toBe(1); expect(await readFile(producer, "utf8")).toBe(changedBytes);
  expect(await hashPublicationTree(destination)).toEqual(before);
  expect(JSON.parse(await readFile(join(destination, "data/snapshot.json"), "utf8")).news[0].title).toBe("Retained public council update");
}), 15000);

test("rehashed tree and receipt cannot hide forbidden inputs, source identity or final snapshot changes", async () => fixture(async (_root, output, seed, destination) => {
  await exportPagesSnapshot({ outputDir: output, seedDir: seed, destination, generatedAt: stamp });
  const receiptPath = join(destination, PAGES_FACT_INPUT_RECEIPT), original = await readFile(receiptPath, "utf8");
  const rehash = async () => {
    const path = join(destination, "publication-manifest.json"), manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.files = await hashPublicationTree(destination); manifest.editionId = publicationHash(JSON.stringify(manifest.files)); await writeFile(path, JSON.stringify(manifest));
  };
  for (const mutate of [
    (r: any) => r.inputs["output/state/search-queries.jsonl"] = { sha256: "0".repeat(64), bytes: 1 },
    (r: any) => r.inputs["output/news/../private.json"] = { sha256: "0".repeat(64), bytes: 1 },
    (r: any) => r.inputs["output/news//alias.json"] = { sha256: "0".repeat(64), bytes: 1 },
    (r: any) => r.transforms["src/pages_snapshot.ts"].sha256 = "0".repeat(64),
    (r: any) => r.inputs["output/manifest.json"].sha256 = "0".repeat(64),
    (r: any) => r.inputs["output/news/news-fixture.json"].bytes = 64 * 1024 * 1024 + 1,
    (r: any) => { for (let i = 0; i < 5; i++) r.inputs[`output/news/news-large-${i}.json`] = { sha256: "0".repeat(64), bytes: 64 * 1024 * 1024 }; },
    (r: any) => r.evidenceBoundary = "verified-factuality",
  ]) {
    const receipt = JSON.parse(original); mutate(receipt); const { bindingSha256: _, ...payload } = receipt;
    receipt.bindingSha256 = publicationHash(canonicalArtifactJson(payload)); await writeFile(receiptPath, JSON.stringify(receipt)); await rehash();
    expect((await validatePagesArtifact(destination)).join()).toContain("public-fact-inputs");
  }
  await writeFile(receiptPath, original);
  const snapshotPath = join(destination, "data/snapshot.json"), snapshot = JSON.parse(await readFile(snapshotPath, "utf8")); snapshot.news[0].title = "Invented council update";
  await writeFile(snapshotPath, JSON.stringify(snapshot)); await rehash();
  expect((await validatePagesArtifact(destination)).join()).toContain("final snapshot bytes mismatch");
}), 20000);
