import { currentCivicProfile, assertCivicCorpusIdentity, isCrescentCityProfile } from "./civic_profile.js";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, lstat, writeFile, cp } from "node:fs/promises";
import { articleSetSha256 } from "./corpus_editions.js";
import type { ArticlePage, TocNode } from "./types.js";
import { getArticlePages, getSections } from "./toc.js";
import { withFileLease } from "./shared/storage.js";
import { writeJsonAtomic } from "./shared/source_health.js";
import { assertPublicMunicipalFile } from "./pages_public.js";
import { basename, dirname, join, resolve } from "node:path";

export const PUBLICATION_CORE_FILES = ["crescent-city-code.json", "toc.json", "manifest.json", "verification-report.json"] as const;
export function publicationCoreFiles(): string[] { return [`${currentCivicProfile().corpusSlug}.json`, "toc.json", "manifest.json", "verification-report.json"]; }
export const PUBLICATION_OPTIONAL_FILES = ["domain-coverage.json", "readability.json"] as const;
export interface PublicationReceipt {
  schemaVersion: "crescent-city-publication-input/v1"; editionId: string;
  selection: "verified-output" | "reviewed-seed" | "unavailable";
  reason: string; files: Record<string, { sha256: string; bytes: number }>;
  verification: "hash-bound-local" | "reviewed-historical" | "not-available";
  sourceVerifiedAt?: string | null; sourceExportedAt?: string | null;
}
export interface PublicationBundle { root: string | null; bytes: Record<string, string>; receipt: PublicationReceipt }
export function publicationHash(bytes: string | Uint8Array): string { return new Bun.CryptoHasher("sha256").update(bytes).digest("hex"); }

/** Validate one directory as one edition; never fill its gaps from another. */
export async function readPublicationBundle(directory: string, reviewedSeed = false): Promise<PublicationBundle> {
  const bytes: Record<string, string> = {};
  for (const file of publicationCoreFiles()) bytes[file] = await readFile(join(directory, file), "utf8");
  for (const file of PUBLICATION_OPTIONAL_FILES) {
    try { bytes[file] = await readFile(join(directory, file), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const values = Object.fromEntries(Object.entries(bytes).map(([file, text]) => [file, JSON.parse(text)])) as Record<string, Record<string, unknown>>;
  for (const [file, value] of Object.entries(values)) assertPublicMunicipalFile(file === `${currentCivicProfile().corpusSlug}.json` ? "crescent-city-code.json" : file, value);
  const code = values[`${currentCivicProfile().corpusSlug}.json`]!;
  const manifest = values["manifest.json"]!;
  const verification = values["verification-report.json"]!;
  if (!Array.isArray(code.articles) || !code.articles.length || !manifest.articles || typeof manifest.articles !== "object" || Array.isArray(manifest.articles) || !values["toc.json"]?.guid) throw new Error("Publication core shape is incomplete");
  assertCivicCorpusIdentity(values["toc.json"], manifest, code);
  if (verification.overallStatus !== "pass") throw new Error("Publication verification did not pass");
  const entries = manifest.articles as Record<string, Record<string, unknown>>;
  const articles = code.articles as Array<Record<string, unknown>>;
  const tocArticles = getArticlePages(values["toc.json"] as unknown as TocNode);
  const tocSections = new Map(tocArticles.map(article => [article.guid, new Set(getSections(article).map(section => section.guid))]));
  if (tocSections.size !== Object.keys(entries).length || Object.keys(entries).some(guid => !tocSections.has(guid))) throw new Error("Publication manifest membership differs from TOC");
  const seen = new Set<string>();
  let sections = 0;
  for (const article of articles) {
    const guid = typeof article.guid === "string" ? article.guid : "";
    const entry = entries[guid];
    if (!guid || seen.has(guid) || !entry || typeof article.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(article.sha256) || article.sha256 !== entry.sha256 || !Array.isArray(article.sections)) throw new Error("Code export does not match manifest article membership/hash");
    seen.add(guid);
    if (article.sections.length !== entry.sectionCount) throw new Error(`Code/manifest section mismatch for ${guid}`);
    const sectionIds = new Set<string>();
    for (const section of article.sections as Array<Record<string, unknown>>) {
      if (typeof section.guid !== "string" || !section.guid || sectionIds.has(section.guid) || !tocSections.get(guid)!.has(section.guid) || typeof section.text !== "string") throw new Error(`Invalid exported section for ${guid}`);
      sectionIds.add(String(section.guid));
    }
    if (sectionIds.size !== tocSections.get(guid)!.size) throw new Error("Publication section membership differs from TOC");
    sections += article.sections.length;
  }
  if (seen.size !== Object.keys(entries).length || articles.length !== manifest.articlePageCount || sections !== manifest.sectionCount) throw new Error("Publication corpus counts or membership do not match");
  const binding = verification.binding as Record<string, unknown> | undefined;
  const planes = verification.planes as Record<string, unknown> | undefined;
  const evidence = verification.evidence as Record<string, unknown> | undefined;
  const bound = verification.publicationEligible === true && planes?.local === "pass" && planes?.currentToc === "pass" && planes?.sample === "pass" && evidence?.currentToc === "ecode360-live" && evidence?.sample === "ecode360-live" && binding?.manifestSha256 === publicationHash(bytes["manifest.json"]!) && binding?.tocSha256 === publicationHash(bytes["toc.json"]!) && binding?.articleSetSha256 === articleSetSha256(articles as unknown as ArticlePage[]);
  if (!bound && !reviewedSeed) throw new Error("Current output requires hash-bound manifest/TOC verification");
  const files = Object.fromEntries(Object.entries(bytes).map(([file, text]) => [file, { sha256: publicationHash(text), bytes: Buffer.byteLength(text) }]));
  const editionId = publicationHash(JSON.stringify(files));
  return { root: resolve(directory), bytes, receipt: {
    schemaVersion: "crescent-city-publication-input/v1", editionId,
    selection: reviewedSeed ? "reviewed-seed" : "verified-output", files,
    reason: reviewedSeed ? "Reviewed tracked seed selected; this does not establish current live source acceptance" : "Complete same-directory edition bound to local verification",
    verification: bound ? "hash-bound-local" : "reviewed-historical",
    sourceVerifiedAt: typeof verification.verifiedAt === "string" && Number.isFinite(Date.parse(verification.verifiedAt)) ? verification.verifiedAt : null,
    sourceExportedAt: typeof code.exportedAt === "string" && Number.isFinite(Date.parse(code.exportedAt)) ? code.exportedAt : null,
  } };
}

export async function selectPublicationBundle(output: string, seed: string): Promise<PublicationBundle> {
  const failures: string[] = [];
  for (const [directory, reviewed] of (isCrescentCityProfile() ? [[output, false], [seed, true]] : [[output, false]]) as Array<[string, boolean]>) {
    try { const bundle = await readPublicationBundle(directory, reviewed); if (reviewed && failures.length) bundle.receipt.reason += "; current output rejected as incomplete or unbound"; return bundle; }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  return { root: null, bytes: {}, receipt: { schemaVersion: "crescent-city-publication-input/v1", editionId: publicationHash("unavailable"), selection: "unavailable", reason: "Neither current output nor reviewed seed supplied a complete eligible edition", verification: "not-available", files: {} } };
}

interface PromotionJournal { schemaVersion: "publication-promotion/v1"; destination: string; staging: string; previous: string; phase: "prepared" | "backed-up" | "committed" }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function promotionPaths(destination: string) {
  const target = resolve(destination); const parent = dirname(target); const name = basename(target);
  if (target === parent) throw new Error("A filesystem root cannot be a publication destination");
  return { target, parent, lock: join(parent, `.${name}.publication-lease`), journal: join(parent, `.${name}.publication-journal.json`), activation: join(parent, `.${name}.publication-activation.json`) };
}
async function recoverUnlocked(destination: string): Promise<void> {
  const config = promotionPaths(destination);
  const text = await readFile(config.journal, "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
  if (text === null) return;
  const journal = JSON.parse(text) as PromotionJournal;
  if (journal.schemaVersion !== "publication-promotion/v1" || journal.destination !== config.target || dirname(journal.previous) !== config.parent || !basename(journal.previous).startsWith(`.${basename(config.target)}.previous-`) || dirname(journal.staging) !== config.parent) throw new Error("Invalid publication recovery journal; manual review required");
  let restoredPrevious = false;
  if (!await exists(config.target) && await exists(journal.previous)) { await rename(journal.previous, config.target); restoredPrevious = true; }
  // A killed writer may have renamed the staged directory but not recorded activation.
  if (await exists(config.target)) {
    const hashes = await hashPublicationTree(config.target);
    await writeJsonAtomic(config.activation, { schemaVersion: "publication-activation/v1", recoveredAt: new Date().toISOString(), disposition: restoredPrevious ? "restored-previous" : "kept-active", editionId: publicationHash(JSON.stringify(hashes)), previous: await exists(journal.previous) ? journal.previous : null });
  }
  await rm(config.journal);
}

/** Recover a killed writer under the same cross-process owner/token lease. */
export async function recoverPublicationDirectory(destination: string): Promise<void> {
  const config = promotionPaths(destination);
  await withFileLease(config.lock, () => recoverUnlocked(config.target), { staleMs: 0 });
}

/** Same-filesystem promotion; killed writers leave a recoverable journal and prior bytes. */
export async function promotePublicationDirectory(staging: string, destination: string, options: { afterBackup?: () => Promise<void> } = {}): Promise<{ previous: string | null }> {
  const config = promotionPaths(destination); const stage = resolve(staging);
  if (dirname(stage) !== config.parent || stage === config.target) throw new Error("Publication staging must be a distinct sibling directory");
  return withFileLease(config.lock, async () => {
    await recoverUnlocked(config.target);
    await hashPublicationTree(stage); // Reject symlinks/invalid trees before touching the active edition.
    const previous = join(config.parent, `.${basename(config.target)}.previous-${crypto.randomUUID()}`);
    const journal: PromotionJournal = { schemaVersion: "publication-promotion/v1", destination: config.target, staging: stage, previous, phase: "prepared" };
    await writeJsonAtomic(config.journal, journal);
    const moved = await exists(config.target);
    try {
      if (moved) await rename(config.target, previous);
      journal.phase = "backed-up"; await writeJsonAtomic(config.journal, journal);
      await options.afterBackup?.();
      await rename(stage, config.target);
      journal.phase = "committed"; await writeJsonAtomic(config.journal, journal);
      const hashes = await hashPublicationTree(config.target);
      await writeJsonAtomic(config.activation, { schemaVersion: "publication-activation/v1", activatedAt: new Date().toISOString(), editionId: publicationHash(JSON.stringify(hashes)), previous: moved ? previous : null });
      await rm(config.journal);
      return { previous: moved ? previous : null };
    } catch (error) {
      try {
        if (moved && await exists(previous)) {
          if (await exists(config.target)) await rename(config.target, stage);
          await rename(previous, config.target);
        } else if (!moved && await exists(config.target) && !await exists(stage)) await rename(config.target, stage);
        await rm(config.journal);
      } catch (recoveryError) { throw new AggregateError([error, recoveryError], "Publication failed and rollback requires journal recovery"); }
      throw error;
    }
  }, { staleMs: 0 });
}

export async function writePublicationInputReceipt(directory: string, receipt: PublicationReceipt): Promise<void> {
  await writeFile(join(directory, "publication-input.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

/** Stages a seed while preserving unrelated reviewed files and prior bytes. */
export async function stagePublicationSeed(bundle: PublicationBundle, destination: string): Promise<string[]> {
  await mkdir(dirname(resolve(destination)), { recursive: true });
  const staging = await mkdtemp(join(dirname(resolve(destination)), ".seed-build-"));
  try {
    try { await cp(destination, staging, { recursive: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const [file, bytes] of Object.entries(bundle.bytes)) await writeFile(join(staging, file), bytes);
    await writePublicationInputReceipt(staging, bundle.receipt);
    await promotePublicationDirectory(staging, destination);
    return Object.keys(bundle.bytes);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

export async function hashPublicationTree(directory: string): Promise<Record<string, string>> {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Publication root must be a real directory");
  const hashes: Record<string, string> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error("Publication may not contain symbolic links");
      if (entry.isDirectory()) await walk(join(current, entry.name), `${key}/`);
      else if (key !== "publication-manifest.json") hashes[key] = publicationHash(await readFile(join(current, entry.name)));
    }
  }
  await walk(directory, ""); return hashes;
}
