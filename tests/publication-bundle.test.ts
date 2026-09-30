import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPublicationBundle, selectPublicationBundle, promotePublicationDirectory, recoverPublicationDirectory, stagePublicationSeed } from "../src/publication_bundle.ts";
import { exportPagesSnapshot } from "../src/pages_snapshot.ts";
import { validatePagesArtifact } from "../src/pages_validation.ts";
import { writePublicationFixture } from "./helpers/publication-fixture.ts";

async function fixture(run: (root: string) => Promise<void>) { const root = await mkdtemp(join(tmpdir(), "publication-")); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }
describe("publication editions and promotion", () => {
  test("one complete edition binds exported text; partial current output cannot mix with seed", async () => fixture(async root => {
    const output = join(root, "output"); const seed = join(root, "seed");
    await writePublicationFixture(seed, "reviewed seed"); await mkdir(output);
    await writeFile(join(output, "manifest.json"), "{}");
    const selected = await selectPublicationBundle(output, seed);
    expect(selected.receipt.selection).toBe("reviewed-seed");
    expect(JSON.parse(selected.bytes["crescent-city-code.json"]!).articles[0].sections[0].text).toBe("reviewed seed");
    await writePublicationFixture(output);
    expect((await readPublicationBundle(output)).receipt.verification).toBe("hash-bound-local");
    const code = JSON.parse(await readFile(join(output, "crescent-city-code.json"), "utf8"));
    code.articles[0].sections[0].text = "tampered while raw hash metadata stayed unchanged";
    await writeFile(join(output, "crescent-city-code.json"), JSON.stringify(code));
    await expect(readPublicationBundle(output)).rejects.toThrow("hash-bound");
    expect((await selectPublicationBundle(output, seed)).receipt.selection).toBe("reviewed-seed");
  }));
  test("seed refresh preserves unrelated reviewed files and rollback bytes", async () => fixture(async root => {
    const source = join(root, "source"); const seed = join(root, "seed"); await writePublicationFixture(source); await mkdir(seed); await writeFile(join(seed, "directory.json"), "reviewed directory");
    await stagePublicationSeed(await readPublicationBundle(source), seed);
    expect(await readFile(join(seed, "directory.json"), "utf8")).toBe("reviewed directory");
    expect((await readPublicationBundle(seed)).receipt.selection).toBe("verified-output");
  }));
  test("unknown core fields cannot transfer operator records through a reviewed seed", async () => fixture(async root => {
    await writePublicationFixture(root);
    const code = JSON.parse(await readFile(join(root, "crescent-city-code.json"), "utf8"));
    code.articles[0].unreviewedFutureRecord = { personalNote: "plain private fixture text" };
    await writeFile(join(root, "crescent-city-code.json"), JSON.stringify(code));
    await expect(readPublicationBundle(root, true)).rejects.toThrow("unsupported field");
  }));
  test("reviewed seed still requires TOC/manifest/export section membership agreement", async () => fixture(async root => {
    await writePublicationFixture(root);
    const toc = JSON.parse(await readFile(join(root, "toc.json"), "utf8")); toc.children[0].children[0].guid = "other-section";
    await writeFile(join(root, "toc.json"), JSON.stringify(toc));
    await expect(readPublicationBundle(root, true)).rejects.toThrow("Invalid exported section");
  }));
  test("a killed real writer recovers the prior destination before a later promotion", async () => fixture(async root => {
    const destination = join(root, "pages"); const staging = join(root, "staging"); await mkdir(destination); await mkdir(staging); await writeFile(join(destination, "value"), "prior"); await writeFile(join(staging, "value"), "new");
    const module = join(process.cwd(), "src/publication_bundle.ts");
    const script = join(root, "child.ts");
    await writeFile(script, `import {promotePublicationDirectory} from ${JSON.stringify(module)}; await promotePublicationDirectory(${JSON.stringify(staging)},${JSON.stringify(destination)},{afterBackup:async()=>{console.log("backed-up"); await new Promise(()=>{setInterval(()=>{},1000);});}});`);
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader(); const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain("backed-up"); reader.releaseLock();
    child.kill("SIGKILL"); await child.exited;
    await recoverPublicationDirectory(destination);
    expect(await readFile(join(destination, "value"), "utf8")).toBe("prior");
    const activation = JSON.parse(await readFile(join(root, ".pages.publication-activation.json"), "utf8"));
    expect(activation.disposition).toBe("restored-previous"); expect(activation.previous).toBeNull();
    const next = await promotePublicationDirectory(staging, destination);
    expect(await readFile(join(destination, "value"), "utf8")).toBe("new");
    expect(await readFile(join(next.previous!, "value"), "utf8")).toBe("prior");
  }), 10000);
  test("a symlink stage is rejected before the active publication moves", async () => fixture(async root => {
    const destination = join(root, "pages"); const staging = join(root, "staging"); await mkdir(destination); await mkdir(staging); await writeFile(join(destination, "value"), "prior"); await symlink(join(destination, "value"), join(staging, "linked"));
    await expect(promotePublicationDirectory(staging, destination)).rejects.toThrow("symbolic links");
    expect(await readFile(join(destination, "value"), "utf8")).toBe("prior");
    const realStage = join(root, "real-staging"); const linkedStage = join(root, "linked-staging");
    await mkdir(realStage); await writeFile(join(realStage, "value"), "candidate"); await symlink(realStage, linkedStage, "dir");
    await expect(promotePublicationDirectory(linkedStage, destination)).rejects.toThrow("real directory");
    expect(await readFile(join(destination, "value"), "utf8")).toBe("prior");
    expect(await readFile(join(realStage, "value"), "utf8")).toBe("candidate");
  }));
  test("empty RSS validates, output hashes detect tampering, failed stage preserves publication", async () => fixture(async root => {
    const output = join(root, "output"); await mkdir(output);
    const destination = join(root, "pages");
    await exportPagesSnapshot({ outputDir: output, destination, seedDir: join(root, "absent") });
    expect(await validatePagesArtifact(destination)).toEqual([]);
    const original = await readFile(join(destination, "index.html"), "utf8");
    await mkdir(join(output, "news")); await writeFile(join(output, "news/news-fixture.json"), JSON.stringify({ items: [{ title: "private /Users/example/operator/file", link: "https://example.test/story", source: "Lost Coast Outpost" }] }));
    await expect(exportPagesSnapshot({ outputDir: output, destination, seedDir: join(root, "absent") })).rejects.toThrow("privacy");
    expect(await readFile(join(destination, "index.html"), "utf8")).toBe(original);
    await writeFile(join(destination, "index.html"), `${original}\n<!-- changed -->`);
    expect((await validatePagesArtifact(destination)).some(error => error.includes("hashes"))).toBe(true);
  }), 30000);
});
