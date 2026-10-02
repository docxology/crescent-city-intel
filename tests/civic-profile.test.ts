import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCivicProfile, defaultCivicProfile, civicProfileFingerprint, currentCivicProfile, withCivicProfile, bindCivicOutputRoot, assertCivicCorpusIdentity, assertCivicProducerSupported } from "../src/civic_profile.ts";
import { withOutputRoot, paths, outputRoot } from "../src/shared/paths.ts";
import { getSourceRegistry, validateSourceRegistry } from "../src/source_registry.ts";
import { computeDomainCoverage } from "../src/domains/coverage.ts";
import { readPublicationBundle, selectPublicationBundle } from "../src/publication_bundle.ts";
import { buildConsolidatedJson } from "../src/export.ts";
import { exportPagesSnapshot } from "../src/pages_snapshot.ts";
import { renderSchedulerPlan } from "../src/scheduler.ts";
import { writePublicationFixture } from "./helpers/publication-fixture.ts";
import { writeSeedCorpus } from "./helpers/output-root.ts";
import { loadToc, loadAllArticles, loadAllSections, loadManifest, loadArticle, invalidateSectionsCache } from "../src/shared/data.ts";
import { runBoundedChild } from "../src/shared/subprocess.ts";

function example() { return validateCivicProfile({ ...structuredClone(defaultCivicProfile), id: "example-city", name: "Example City", municipality: "Example City, NY", county: "Example County", state: "New York", timeZone: "America/New_York", anchor: { latitude: 42.1, longitude: -73.2, bounds: { west: -74, south: 41, east: -72, north: 43 } }, code: { provider: "ecode360", municipalityCode: "EX1234" }, corpusSlug: "example-city-code", vectorNamespace: "example-city-code", calendar: { uidDomain: "example-city.test", productId: "-//Example City//Calendar//EN" }, publication: { title: "Example Civic Intelligence", description: "Synthetic offline acceptance only", siteUrl: "https://example.test", repositoryUrl: "https://github.com/example/civic" }, capabilities: ["ecode360", "news", "events", "analytics", "geo"] }); }
async function owned(run: (root: string) => Promise<void>) { const root = await mkdtemp(join(tmpdir(), "civic-profile-")); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }
describe("validated civic configuration and ownership", () => {
  test("canonical fingerprint ignores input key and capability order and freezes all descendants", () => {
    const p = example(), reordered = Object.fromEntries(Object.entries(p).reverse());
    reordered.capabilities = [...p.capabilities].reverse();
    expect(civicProfileFingerprint(validateCivicProfile(reordered))).toBe(civicProfileFingerprint(p));
    expect(Object.isFrozen(p.anchor.bounds)).toBe(true);
    expect(() => validateCivicProfile({ ...p, privateOutputPath: "/Users/operator/private" })).toThrow("fields");
  });
  test("malformed coordinates, timezone, provider, namespace and public URL fail admission", () => {
    const p = example();
    for (const change of [{ timeZone: "Mars/Olympus" }, { anchor: { ...p.anchor, latitude: 91 } }, { anchor: { ...p.anchor, bounds: { ...p.anchor.bounds, west: -70 } } }, { calendar: { ...p.calendar, uidDomain: "city\nBEGIN:VEVENT" } }, { publication: { ...p.publication, siteUrl: "https://user:secret@example.test" } }, { publication: { ...p.publication, siteUrl: "https://example.test/path" } }, { code: { provider: "arbitrary-url", municipalityCode: "EX1234" } }]) expect(() => validateCivicProfile({ ...p, ...change })).toThrow();
    expect(() => withCivicProfile({ ...p, vectorNamespace: defaultCivicProfile.vectorNamespace }, () => {})).toThrow("independent");
    expect(() => withCivicProfile({ ...p, capabilities: [...p.capabilities, "crescent-city-adapters"] }, () => {})).toThrow("unconfigured");
  });
  test("interleaved contexts retain profile and captured output roots", async () => owned(async root => {
    const p = example();
    const results = await Promise.all([p, defaultCivicProfile].map((profile, index) => withCivicProfile(profile, () => withOutputRoot(join(root, String(index)), async () => { await new Promise(resolve => setTimeout(resolve, index ? 2 : 15)); return [currentCivicProfile().id, paths.consolidatedJson]; }))));
    expect(results[0]).toEqual([p.id, join(root, "0", `${p.corpusSlug}.json`)]);
    expect(results[1]).toEqual([defaultCivicProfile.id, join(root, "1", "crescent-city-code.json")]);
  }));
  test("roots bind once, refuse foreign ownership and never adopt retained alternate data", async () => owned(async root => {
    const fresh = join(root, "fresh"); await mkdir(fresh);
    await withCivicProfile(example(), () => bindCivicOutputRoot(fresh));
    const before = await readFile(join(fresh, "state/civic-profile.json"), "utf8");
    await expect(bindCivicOutputRoot(fresh)).rejects.toThrow("different civic");
    expect(await readFile(join(fresh, "state/civic-profile.json"), "utf8")).toBe(before);
    const retained = join(root, "retained"); await mkdir(retained); await writeFile(join(retained, "toc.json"), "Crescent retained bytes");
    await expect(withCivicProfile(example(), () => bindCivicOutputRoot(retained))).rejects.toThrow("nonempty");
    expect(await readFile(join(retained, "toc.json"), "utf8")).toBe("Crescent retained bytes");
  }));
  test("output identity receipts reject oversized, linked and real FIFO inputs without blocking", async () => owned(async root => {
    const module = new URL("../src/civic_profile.ts", import.meta.url).href;
    for (const kind of ["oversized", "linked", "fifo"]) {
      const directory = join(root, kind); await mkdir(join(directory, "state"), { recursive: true });
      const receipt = join(directory, "state", "civic-profile.json");
      if (kind === "oversized") await writeFile(receipt, " ".repeat(4097));
      else if (kind === "linked") { const target = join(root, "target.json"); await writeFile(target, "{}"); await symlink(target, receipt); }
      else { const made = await runBoundedChild(["/usr/bin/mkfifo", receipt], { timeoutMs: 2000 }); expect(made.status).toBe("ok"); }
      const code = `const {bindCivicOutputRoot}=await import(${JSON.stringify(module)});try{await bindCivicOutputRoot(${JSON.stringify(directory)});process.exitCode=1;}catch(error){console.log(JSON.stringify({rejected:true,message:String(error.message)}));}`;
      const result = await runBoundedChild([process.execPath, "-e", code], { timeoutMs: 2000, maxBytes: 16 * 1024 });
      expect(result.status).toBe("ok"); expect(result.reaped).toBe(true);
      expect(JSON.parse(result.stdout).rejected).toBe(true);
    }
    expect(await readFile(join(root, "target.json"), "utf8")).toBe("{}");
  }));
  test("alternate profile has no implicit local source roster, domains or regional producers", async () => withCivicProfile(example(), async () => {
    expect(getSourceRegistry()).toEqual([]);
    const coverage = await computeDomainCoverage({ sections: [], outPath: null }); expect(coverage.domains).toEqual([]);
    expect(() => assertCivicProducerSupported("alert-calfire-wildfire")).toThrow("no configured adapter");
    expect(() => renderSchedulerPlan({ project: "/tmp/civic", bun: "/usr/local/bin/bun", platform: "linux" })).toThrow("ownership");
    await expect(exportPagesSnapshot()).rejects.toThrow("municipality-specific");
  }));
  test("wrong municipal corpus cannot be relabelled or selected as a reviewed alternate seed", async () => owned(async root => {
    const seed = join(root, "seed"), output = join(root, "output"); await mkdir(output); await writePublicationFixture(seed);
    await withCivicProfile(example(), async () => {
      expect(() => assertCivicCorpusIdentity({ guid: "CR4919" })).toThrow("differs");
      expect((await selectPublicationBundle(output, seed)).receipt.selection).toBe("unavailable");
      await writePublicationFixture(output);
      expect((await readPublicationBundle(output)).receipt.selection).toBe("verified-output");
      const code = JSON.parse(await readFile(join(output, "example-city-code.json"), "utf8")); code.source = "https://ecode360.com/CR4919"; await writeFile(join(output, "example-city-code.json"), JSON.stringify(code));
      await expect(readPublicationBundle(output)).rejects.toThrow("differs");
    });
  }));
  test("generic code export derives approved provider source from supplied TOC identity", () => {
    const code = buildConsolidatedJson({ guid: "EX1234", tocName: "Example City", children: [] } as never, []);
    expect(code.source).toBe("https://ecode360.com/EX1234");
  });
  test("a warm shared-data cache cannot expose another jurisdiction's corpus", async () => owned(async root => {
    await writeSeedCorpus(root, { articleCount: 1 }); invalidateSectionsCache();
    await withOutputRoot(root, async () => {
      expect((await loadAllSections()).length).toBeGreaterThan(0);
      await expect(withCivicProfile(example(), () => loadAllSections())).rejects.toThrow("differs");
      const manifest = await loadManifest(); const guid = Object.keys(manifest.articles)[0]!;
      for (const profile of [example(), validateCivicProfile({ ...example(), code: null, capabilities: example().capabilities.filter(c => c !== "ecode360") })]) {
        await expect(withCivicProfile(profile, () => loadManifest())).rejects.toThrow();
        await expect(withCivicProfile(profile, () => loadArticle(guid))).rejects.toThrow();
      }
    });
    invalidateSectionsCache();
  }));
  test("default readers reject a foreign TOC even beside a legacy unbound manifest", async () => owned(async root => {
    await writeSeedCorpus(root, { articleCount: 1 });
    await withOutputRoot(root, async () => {
      const toc = await loadToc(), manifest = await loadManifest(), guid = Object.keys(manifest.articles)[0]!;
      await writeFile(paths.toc, JSON.stringify({ ...toc, guid: "EX1234", tocName: "Example foreign municipality" }));
      for (const read of [loadToc, loadManifest, () => loadArticle(guid), () => loadAllArticles()]) await expect(read()).rejects.toThrow("differs");
      const legacy = { ...manifest }; delete (legacy as Partial<typeof manifest>).municipalityGuid; delete (legacy as Partial<typeof manifest>).sourceUrl;
      await writeFile(paths.manifest, JSON.stringify(legacy));
      for (const read of [loadManifest, () => loadArticle(guid), () => loadAllArticles()]) await expect(read()).rejects.toThrow("differs");
      await writeFile(paths.toc, JSON.stringify(toc));
      expect((await loadManifest()).articles[guid]).toBeDefined();
      expect((await loadArticle(guid)).guid).toBe(guid);
      expect(await loadAllArticles()).toHaveLength(1);
    });
  }));
  test("the actual process loader admits a bounded profile and rejects oversized bytes", async () => owned(async root => {
    const file = join(root, "profile.json"); await writeFile(file, JSON.stringify(example()));
    const result = await runBoundedChild(["/usr/bin/env", `CIVIC_PROFILE=${file}`, process.execPath, "run", "src/civic_profile.ts"], { timeoutMs: 5000, maxBytes: 128 * 1024 });
    expect(result.status).toBe("ok"); expect(JSON.parse(result.stdout).profile.id).toBe("example-city");
    await writeFile(file, " ".repeat(64 * 1024 + 1));
    const rejected = await runBoundedChild(["/usr/bin/env", `CIVIC_PROFILE=${file}`, process.execPath, "run", "src/civic_profile.ts"], { timeoutMs: 5000, maxBytes: 128 * 1024 });
    expect(rejected.status).not.toBe("ok"); expect(rejected.stdout).toBe("");
  }));
  test("source regions admit explicit jurisdictions without changing source custody", () => {
    const source = { ...getSourceRegistry()[0]!, id: "example-source", region: "Example County, NY", canonicalUrl: "https://example.test", endpointUrl: undefined, discoveredFrom: ["https://example.test/about"], provenance: "Synthetic source descriptor" };
    expect(validateSourceRegistry([source])).toEqual([]);
    expect(validateSourceRegistry([{ ...source, region: "region\nInjected" }])).toContain("invalid source region: example-source");
  });
});
