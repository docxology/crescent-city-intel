import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, cp, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPublicationBundle, selectPublicationBundle, promotePublicationDirectory, recoverPublicationDirectory, stagePublicationSeed, hashPublicationTree, publicationHash } from "../src/publication_bundle.ts";
import { exportPagesSnapshot, PAGES_STATIC_PAGES, type PagesSnapshot } from "../src/pages_snapshot.ts";
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
  test("sitemap provenance survives another checkout's mtimes and still binds source bytes", async () => fixture(async root => {
    const output = join(root, "output"); const destination = join(root, "pages"); const checkout = join(root, "other-checkout");
    await mkdir(output); await mkdir(checkout);
    await exportPagesSnapshot({ outputDir: output, destination, seedDir: join(root, "absent") });
    const snapshot = JSON.parse(await readFile(join(destination, "data/snapshot.json"), "utf8")) as PagesSnapshot;
    expect(snapshot.sitemapProvenance?.dateOrigin).toBe("exporter-template-filesystem-mtime");
    expect(Object.keys(snapshot.sitemapProvenance!.templates).sort()).toEqual(["index.html", ...PAGES_STATIC_PAGES.map(page => page.file)].sort());
    expect(snapshot.publication).not.toHaveProperty("sitemapProvenance");
    for (const file of Object.keys(snapshot.sitemapProvenance!.templates)) {
      const original = join(process.cwd(), "src/pages/static", file); const copied = join(checkout, file);
      const bytes = await readFile(original); const metadata = await stat(original);
      expect(snapshot.sitemapProvenance!.templates[file]?.sourceSha256).toBe(publicationHash(bytes));
      expect(snapshot.sitemapProvenance!.templates[file]?.mtimeUtcDate).toBe(metadata.mtime.toISOString().slice(0, 10));
      await cp(original, copied); await utimes(copied, new Date("2010-01-01T00:00:00Z"), new Date("2010-01-01T00:00:00Z"));
      expect((await stat(copied)).mtime.toISOString().slice(0, 10)).toBe("2010-01-01");
    }
    expect(await validatePagesArtifact(destination, { sourceTemplateDir: checkout })).toEqual([]);
    await writeFile(join(checkout, "news.html"), (await readFile(join(checkout, "news.html"), "utf8")) + "\n<!-- changed source bytes -->");
    expect((await validatePagesArtifact(destination, { sourceTemplateDir: checkout })).join()).toContain("template source bytes do not match receipt: news.html");
  }), 30000);
  test("rehashed artifacts cannot hide missing, corrupt or future sitemap provenance", async () => fixture(async root => {
    const output = join(root, "output"); const destination = join(root, "pages"); await mkdir(output);
    await exportPagesSnapshot({ outputDir: output, destination, seedDir: join(root, "absent") });
    const snapshotFile = join(destination, "data/snapshot.json"); const sitemapFile = join(destination, "sitemap.xml");
    const originalSnapshot = await readFile(snapshotFile, "utf8"); const originalSitemap = await readFile(sitemapFile, "utf8");
    const check = async (change: (snapshot: PagesSnapshot) => void, sitemap = originalSitemap) => {
      const snapshot = JSON.parse(originalSnapshot) as PagesSnapshot; change(snapshot);
      await writeFile(snapshotFile, JSON.stringify(snapshot)); await writeFile(sitemapFile, sitemap);
      const manifestFile = join(destination, "publication-manifest.json"); const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      // Deliberately satisfy tree hashes: semantic receipt checks must still fail.
      manifest.files = await hashPublicationTree(destination); manifest.editionId = publicationHash(JSON.stringify(manifest.files));
      await writeFile(manifestFile, JSON.stringify(manifest));
      return (await validatePagesArtifact(destination)).join("; ");
    };
    expect(await check(snapshot => { snapshot.sitemapProvenance = null; })).toContain("sitemap provenance is missing or invalid");
    expect(await check(snapshot => { snapshot.sitemapProvenance!.templates["news.html"]!.sourceSha256 = "0".repeat(64); })).toContain("template source bytes do not match receipt: news.html");
    expect(await check(snapshot => { snapshot.sitemapProvenance!.templates["news.html"]!.mtimeUtcDate = "2010-01-01"; })).toContain("lastmod does not match recorded exporter date: news.html");
    expect(await check(snapshot => { snapshot.sitemapProvenance!.templates["news.html"]!.mtimeUtcDate = "9999-12-31"; }, originalSitemap.replace(/(<loc>https:\/\/quadruplicate\.org\/news.html<\/loc><lastmod>)[^<]+/, (_match, prefix: string) => `${prefix}9999-12-31`))).toContain("sitemap source date is invalid or future: news.html");
    expect(await check(snapshot => { snapshot.sitemapProvenance!.templates["news.html"]!.mtimeUtcDate = "2026-02-30"; })).toContain("sitemap source date is invalid or future: news.html");
    expect(await check(snapshot => { delete snapshot.sitemapProvenance!.templates["news.html"]; })).toContain("template membership differs");
    expect(await check(snapshot => { snapshot.sitemapProvenance!.templates["../unreviewed"] = snapshot.sitemapProvenance!.templates["news.html"]!; })).toContain("template membership differs");
    expect(await check(snapshot => { (snapshot.sitemapProvenance as unknown as Record<string, unknown>).dateOrigin = "content-change-history"; })).toContain("unsupported schema, origin or field");
    expect(await check(() => {}, originalSitemap.replace(/(<loc>https:\/\/quadruplicate\.org\/news.html<\/loc>)<lastmod>[^<]+<\/lastmod>/, "$1"))).toContain("lastmod does not match recorded exporter date: news.html");
    expect(await check(() => {}, originalSitemap.replace(/(<loc>https:\/\/quadruplicate\.org\/news.html<\/loc>)/, "$1\n"))).toBe("");
    for (const extra of [
      "<url><loc>https://quadruplicate.org/extra.html</loc><lastmod>2026-09-30</lastmod><priority>1</priority></url>",
      "<lastmod>2999-01-01</lastmod>",
      "<url><loc>https://quadruplicate.org/broken.html</loc>",
    ]) expect(await check(() => {}, originalSitemap.replace("</urlset>", `${extra}</urlset>`))).toContain("sitemap XML has invalid syntax or unsupported shape");
    expect(await check(() => {}, originalSitemap.replace("<urlset ", '<urlset unreviewed="1" '))).toContain("sitemap XML has invalid syntax or unsupported shape");
    expect(await check(() => {}, originalSitemap + "<extra/>")).toContain("sitemap XML has invalid syntax or unsupported shape");
    expect(await check(() => {}, originalSitemap.replace("<urlset", '<!DOCTYPE urlset [<!ENTITY fixture "date">]><urlset'))).toContain("sitemap XML has invalid syntax or unsupported shape");
    expect(await check(() => {}, originalSitemap.replace("</urlset>", `<!--${"bounded ".repeat(10000)}--></urlset>`))).toContain("sitemap XML has invalid syntax or unsupported shape");
    expect(await check(() => {}, originalSitemap.replace("</urlset>", "\n<!-- legitimate whitespace and comment -->\n</urlset>"))).toBe("");
  }), 30000);
});
