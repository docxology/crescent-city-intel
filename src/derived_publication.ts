import { isCrescentCityProfile, currentCivicProfile, civicProfileFingerprint, validateCivicProfile, withCivicProfile } from "./civic_profile.js";
/** Retain derived producer inputs before computing, refuse changed editions, then bind exact output. */
import { readdir, mkdir, mkdtemp, rm, lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { captureArtifactBytes, createArtifactCustody, canonicalArtifactJson, type ArtifactCustodyInputs } from "./artifact_custody.js";
import { custodyHash } from "./corpus_editions.js";
import type { ArtifactFamily } from "./artifact_contracts.js";
import { writeTextAtomic, writeJsonAtomic } from "./shared/source_health.js";
import { currentRunSignal } from "./shared/run_scope.js";
import { withOutputRoot } from "./shared/paths.js";
import { replaceArtifacts, type ArtifactReplacement } from "./shared/artifact_transaction.js";

export type DerivedProfile = "events" | "analytics" | "monthly";
const directories: Record<DerivedProfile, readonly string[]> = {
  events: ["news", "gov_meetings", "youtube"],
  analytics: ["news", "gov_meetings", "youtube", "triplicate", "curated", "articles", "tides", "fishing", "alerts", "reports"],
  monthly: ["news", "gov_meetings", "youtube", "triplicate", "curated", "articles", "tides", "fishing", "alerts", "reports"],
};
const singles = ["manifest.json", "toc.json", "readability.json", "domain-coverage.json", "source-registry.json", "source-discovery.json", "search-queries.jsonl", "events/event_discovery.json", "state/latest-pipeline-run.json", "state/curation-report.json", "state/analytics-overview.json"];
async function capture(root: string, profile: DerivedProfile): Promise<Record<string, Uint8Array>> {
  root = resolve(root);
  const result: Record<string, Uint8Array> = {}; let total = 0;
  const safePath = async (path: string): Promise<void> => {
    let current = root;
    for (const segment of ['', ...relative(root, path).split('/').filter(Boolean)]) {
      current = segment ? join(current, segment) : current;
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Derived input path cannot traverse symlinks');
    }
  };
  const add = async (path: string): Promise<void> => {
    currentRunSignal()?.throwIfAborted();
    await safePath(path);
    if (Object.keys(result).length >= 4095) throw new Error("Derived inputs exceed membership bound");
    const bytes = await captureArtifactBytes(path, 32 * 1024 * 1024); total += bytes.byteLength;
    if (total > 128 * 1024 * 1024) throw new Error("Derived inputs exceed total byte bound");
    result[relative(root, path).replaceAll("\\", "/")] = bytes;
  };
  const walk = async (path: string): Promise<void> => {
    let rows; try { await safePath(path); rows = await readdir(path, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const row of rows.sort((a, b) => a.name.localeCompare(b.name))) {
      if (row.isSymbolicLink()) throw new Error("Derived input tree contains a symlink");
      if (row.isDirectory()) await walk(join(path, row.name));
      else if (row.isFile() && /\.(?:json|jsonl)$/.test(row.name) && !/\.custody\.json$/.test(row.name)) await add(join(path, row.name));
    }
  };
  for (const directory of directories[profile]) await walk(join(root, directory));
  for (const single of singles) { try { await add(join(root, single)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  if (profile === 'analytics' && isCrescentCityProfile()) {
    const seedPath = resolve(process.env.CODE_SEED_PATH ?? join(import.meta.dir, '..', 'pages-data', 'crescent-city-code.json'));
    try {
      const bytes = await captureArtifactBytes(seedPath, 32 * 1024 * 1024); total += bytes.byteLength;
      if (total > 128 * 1024 * 1024) throw new Error('Derived inputs exceed total byte bound');
      result['custody/municipal-code-seed.json'] = bytes;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  // Absence and exact membership are inputs too; this is not fabricated source data.
  result["custody/input-membership.json"] = new TextEncoder().encode(canonicalArtifactJson({ profile, files: Object.keys(result).sort(), declaredDirectories: directories[profile], declaredFiles: singles }));
  return result;
}
function fingerprint(inputs: Record<string, Uint8Array>): string { return custodyHash(canonicalArtifactJson(Object.fromEntries(Object.keys(inputs).sort().map(path => [path, custodyHash(inputs[path]!)])))); }
export async function captureDerivedInputs(root: string, profile: DerivedProfile, configuration: unknown): Promise<ArtifactCustodyInputs & { profile: DerivedProfile; fingerprint: string }> {
  const inputs = await capture(root, profile), transforms: Record<string, Uint8Array> = {};
  const sourceRoot = join(import.meta.dir, "..");
  const walk = async (path: string): Promise<void> => { for (const entry of await readdir(path, { withFileTypes: true })) { if (entry.isSymbolicLink()) throw new Error('Derived transform tree cannot contain symlinks'); if (entry.isDirectory()) await walk(join(path, entry.name)); else if (entry.isFile() && entry.name.endsWith(".ts")) transforms[relative(sourceRoot, join(path, entry.name)).replaceAll("\\", "/")] = await captureArtifactBytes(join(path, entry.name)); } };
  await walk(join(sourceRoot, "src"));
  transforms["package.json"] = await captureArtifactBytes(join(sourceRoot, "package.json"));
  transforms["bun.lock"] = await captureArtifactBytes(join(sourceRoot, "bun.lock"));
  return { inputs, transforms, configuration: { civicProfile: currentCivicProfile(), civicProfileSha256: civicProfileFingerprint(), producerConfiguration: configuration }, profile, fingerprint: fingerprint(inputs) };
}
/** Immutable private evidence archive + public-safe hash receipt; activation remains the producer's responsibility. */
export async function retainDerivedOutput(root: string, family: ArtifactFamily, destination: string, value: unknown, evidence: Awaited<ReturnType<typeof captureDerivedInputs>>, generatedAt: string, siblings: ArtifactReplacement[] = []): Promise<void> {
  const configured = evidence.configuration as { civicProfile: unknown; civicProfileSha256: string };
  if (civicProfileFingerprint(validateCivicProfile(configured.civicProfile)) !== configured.civicProfileSha256 || civicProfileFingerprint() !== configured.civicProfileSha256) throw new Error("Derived publication civic profile changed; refusing activation");
  if (fingerprint(await capture(root, evidence.profile)) !== evidence.fingerprint) throw new Error("Derived input edition changed during computation; refusing publication");
  currentRunSignal()?.throwIfAborted();
  const bytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  const receipt = createArtifactCustody(family, bytes, evidence, generatedAt);
  const directory = join(root, "state", "derived", family, receipt.bindingSha256);
  await mkdir(directory, { recursive: true });
  for (const [path, input] of Object.entries(evidence.inputs)) {
    const archive = join(directory, "inputs", path); await mkdir(join(archive, ".."), { recursive: true });
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    await writeTextAtomic(archive, text);
  }
  for (const [path, transform] of Object.entries(evidence.transforms)) await writeTextAtomic(join(directory, "transforms", path), new TextDecoder("utf-8", { fatal: true }).decode(transform));
  await writeJsonAtomic(join(directory, "configuration.json"), evidence.configuration);
  await writeTextAtomic(join(directory, "output.json"), new TextDecoder().decode(bytes));
  await writeJsonAtomic(join(directory, "custody.json"), receipt);
  // Roll back an interrupted replacement. Consumers accept only matching output/sidecar hashes.
  await replaceArtifacts(root, [
    ...siblings,
    { path: `${relative(root, destination)}.custody.json`, text: `${JSON.stringify(receipt, null, 2)}\n` },
    { path: relative(root, destination), bytes },
  ], { signal: currentRunSignal() });
}
/** Producers read exactly the captured bytes; a later input race cannot alter their facts. */
export async function withCapturedDerivedInputs<T>(evidence: Awaited<ReturnType<typeof captureDerivedInputs>>, task: (root: string) => Promise<T>): Promise<T> {
  const configured = evidence.configuration as { civicProfile: unknown; civicProfileSha256: string };
  const profile = validateCivicProfile(configured.civicProfile);
  if (civicProfileFingerprint(profile) !== configured.civicProfileSha256) throw new Error("Captured derived civic profile identity mismatch");
  const stage = await mkdtemp(join(tmpdir(), "cci-derived-inputs-"));
  try {
    for (const [path, bytes] of Object.entries(evidence.inputs)) await writeTextAtomic(join(stage, path), new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return await withCivicProfile(profile, () => withOutputRoot(stage, () => task(stage)));
  } finally { await rm(stage, { recursive: true, force: true }); }
}
