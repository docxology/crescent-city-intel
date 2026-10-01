/** Exact, bounded Pages inputs. Public receipts commit bytes; private archives permit replay. */
import { lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { captureArtifactBytes, canonicalArtifactJson, type BoundBytes } from "./artifact_custody.js";
import { publicationHash, PUBLICATION_CORE_FILES, PUBLICATION_OPTIONAL_FILES, type PublicationReceipt } from "./publication_bundle.js";
import { validateSchema } from "./schema_validation.js";
import { withOutputRoot } from "./shared/paths.js";
import { assertSafeFilesystemPath } from "./shared/storage.js";

const MAX_FILE = 64 * 1024 * 1024, MAX_TOTAL = 256 * 1024 * 1024, MAX_ROWS = 4096;
export const PAGES_FACT_INPUT_RECEIPT = "data/public-fact-inputs.json";
const SCHEMA = "crescent-city-pages-fact-inputs/v1";
const DIRECTORIES = ["news", "gov_meetings", "youtube", "triplicate", "curated", "alerts", "tides", "fishing", "reports", "events"];
const SINGLES = ["source-registry.json", "source-discovery.json", "weekly-check-summary.json", "geo-intel.json", "geo-observations.json", "directory.json", "state/latest-pipeline-run.json", "state/curation-report.json", "state/analytics-overview.json", "state/source-discovery-seen.json", ...PUBLICATION_CORE_FILES, ...PUBLICATION_OPTIONAL_FILES];
const CORE = [...PUBLICATION_CORE_FILES, ...PUBLICATION_OPTIONAL_FILES];
const safePath = (key: string) => key.length <= 240 && !key.includes("//") && /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_./-]+$/.test(key);
function approvedInput(key: string): boolean {
  if (key === "capture/membership.json") return true;
  if (!safePath(key)) return false;
  const slash = key.indexOf("/"), group = key.slice(0, slash), file = key.slice(slash + 1);
  return group === "municipal" ? (CORE as readonly string[]).includes(file)
    : ["output", "seed"].includes(group) && (SINGLES.includes(file) || DIRECTORIES.some(dir => file.startsWith(`${dir}/`) && /\.(?:json|jsonl|md)$/.test(file) && !file.endsWith(".custody.json")));
}
const approvedTransform = (key: string) => safePath(key) && (["package.json", "bun.lock", "CNAME"].includes(key) || /^src\/.+\.ts$/.test(key) || /^src\/pages\/static\/(?!.*(?:^|\/)\.claude\/).+\.(?:html|js|css)$/.test(key));
function captureMembership(capture: PagesInputCapture): Record<string, boolean> {
  const bytes = capture.inputs["capture/membership.json"];
  if (!bytes || bytes.byteLength > 2 * 1024 * 1024) throw new Error("Pages capture membership metadata exceeds bounds");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 10_000) throw new Error("Pages capture membership metadata is invalid");
  for (const [key, present] of Object.entries(value)) {
    const directory = key.endsWith("/");
    const safeDirectory = safePath(key) && (["output/", "seed/"].includes(key) || ["output", "seed"].some(group => DIRECTORIES.some(dir => key === `${group}/${dir}/` || key.startsWith(`${group}/${dir}/`))));
    if (typeof present !== "boolean" || !(directory ? safeDirectory : approvedInput(key) && key !== "capture/membership.json")) throw new Error("Pages capture membership metadata is invalid");
    if (!directory && present !== Object.hasOwn(capture.inputs, key)) throw new Error("Pages capture membership differs from retained files");
  }
  for (const key of Object.keys(capture.inputs)) if (key !== "capture/membership.json" && !Object.hasOwn(value, key)) throw new Error("Pages capture file is absent from membership metadata");
  for (const group of ["output", "seed"]) for (const key of [`${group}/`, ...DIRECTORIES.map(dir => `${group}/${dir}/`), ...SINGLES.map(file => `${group}/${file}`)]) if (!Object.hasOwn(value, key)) throw new Error("Pages capture declaration is absent from membership metadata");
  if (capture.municipalInputPrefix === "municipal") for (const file of CORE) if (!Object.hasOwn(value, `municipal/${file}`)) throw new Error("Pages municipal capture declaration is absent from membership metadata");
  return value as Record<string, boolean>;
}
const bindings = (rows: Record<string, Uint8Array>): Record<string, BoundBytes> => Object.fromEntries(Object.keys(rows).sort().map(key => [key, { sha256: publicationHash(rows[key]!), bytes: rows[key]!.byteLength }]));
export interface PagesInputCapture {
  inputs: Record<string, Uint8Array>; transforms: Record<string, Uint8Array>;
  municipalInputPrefix: "output" | "municipal";
  originalRoots?: { output: string; seed: string; municipal: string; source: string };
}
export interface PagesFactInputReceipt {
  schemaVersion: typeof SCHEMA; generatedAt: string; commit: string | null;
  snapshot: BoundBytes; inputs: Record<string, BoundBytes>; transforms: Record<string, BoundBytes>;
  configurationSha256: string; municipalInputPrefix: "output" | "seed" | "municipal" | null;
  captureRootSelection: "output" | "municipal";
  municipal: PublicationReceipt; bindingSha256: string;
  evidenceBoundary: "captured-byte-identity-and-local-replay-not-semantic-support";
}
function assertCaptureBounds(capture: PagesInputCapture, snapshot?: Uint8Array): void {
  if (!capture || !["output", "municipal"].includes(capture.municipalInputPrefix)) throw new Error("Invalid Pages capture root selection");
  for (const [group, approved] of [[capture.inputs, approvedInput], [capture.transforms, approvedTransform]] as const) {
    if (!group || typeof group !== "object" || Array.isArray(group) || Object.keys(group).length < 1 || Object.keys(group).length > MAX_ROWS || Object.keys(group).some(key => !approved(key))) throw new Error("Unapproved Pages capture membership");
    if (Object.values(group).some(bytes => !(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FILE)) throw new Error("Pages capture byte bounds exceeded");
  }
  if (!Object.hasOwn(capture.inputs, "capture/membership.json") || [...Object.values(capture.inputs), ...Object.values(capture.transforms)].reduce((sum, bytes) => sum + bytes.byteLength, 0) > MAX_TOTAL || snapshot !== undefined && (!(snapshot instanceof Uint8Array) || snapshot.byteLength > MAX_FILE)) throw new Error("Pages capture aggregate or snapshot bounds exceeded");
  captureMembership(capture);
}
async function directoryExists(path: string): Promise<boolean> {
  try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Pages input directory is not an owned regular directory"); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Reject intermediate symlinks as well as leaf symlinks; names never escape the selected root. */
async function safeParents(root: string, file: string): Promise<boolean> {
  const pieces = file.split("/"); pieces.pop(); let current = root;
  if (!await directoryExists(root)) return false;
  for (const piece of pieces) { current = join(current, piece); if (!await directoryExists(current)) return false; }
  return true;
}
async function captureSourceTransforms(source: string): Promise<Record<string, Uint8Array>> {
  const rows: Record<string, Uint8Array> = {}; let total = 0;
  const add = async (key: string) => {
    if (Object.keys(rows).length >= MAX_ROWS || total >= MAX_TOTAL) throw new Error("Pages transformation capture exceeds bounds");
    rows[key] = await captureArtifactBytes(join(source, key), Math.min(MAX_FILE, MAX_TOTAL - total)); total += rows[key]!.byteLength;
  };
  async function walk(key: string, depth = 0): Promise<void> {
    if (depth > 12) throw new Error("Pages transformation nesting exceeds bounds");
    if (!await directoryExists(join(source, key))) return;
    const entries = await readdir(join(source, key), { withFileTypes: true });
    if (entries.length > MAX_ROWS) throw new Error("Pages transformation directory exceeds bounds");
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const child = `${key}/${entry.name}`;
      if (!safePath(child)) throw new Error("Pages transformation path is unsafe");
      if (entry.isSymbolicLink()) throw new Error("Pages transformation symlink is not allowed");
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (approvedTransform(child)) await add(child);
    }
  }
  await directoryExists(source); await walk("src");
  for (const key of ["package.json", "bun.lock", "CNAME"]) {
    try { await add(key); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || key !== "CNAME") throw error; }
  }
  return rows;
}
export async function capturePagesPublicationInputs(output: string, seed: string, municipal = output, source = resolve(import.meta.dir, "..")): Promise<PagesInputCapture> {
  const roots = { output: resolve(output), seed: resolve(seed), municipal: resolve(municipal), source: resolve(source) };
  for (const root of Object.values(roots)) await assertSafeFilesystemPath(root);
  const inputs: Record<string, Uint8Array> = {}, membership: Record<string, boolean> = {}; let total = 0, directories = 0;
  const add = async (group: string, root: string, file: string) => {
    const key = `${group}/${file}`;
    if (!approvedInput(key)) throw new Error("Unapproved Pages input path");
    if (Object.keys(inputs).length >= MAX_ROWS - 1 || total >= MAX_TOTAL) throw new Error("Pages input capture exceeds bounds");
    if (!await safeParents(root, file)) { membership[key] = false; return; }
    try { inputs[key] = await captureArtifactBytes(join(root, file), Math.min(MAX_FILE, MAX_TOTAL - total)); total += inputs[key]!.byteLength; membership[key] = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; membership[key] = false; }
  };
  async function walk(group: string, root: string, directory: string, depth = 0): Promise<void> {
    if (depth > 8 || ++directories > MAX_ROWS) throw new Error("Pages input nesting or directory count exceeds bounds");
    const present = await directoryExists(join(root, directory)); membership[`${group}/${directory}/`] = present;
    if (!present) return;
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    if (entries.length > MAX_ROWS) throw new Error("Pages producer directory exceeds bounds");
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${directory}/${entry.name}`;
      if (!safePath(file)) throw new Error("Pages producer input path is unsafe");
      // Raw custody trees, private browser state and temporary files are not producer inputs.
      if (entry.name.startsWith(".") || ["raw", "archive", "archives", "documents", "meeting_documents"].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error("Pages producer input symlink is not allowed");
      if (entry.isDirectory()) await walk(group, root, file, depth + 1);
      else if (approvedInput(`${group}/${file}`)) await add(group, root, file);
    }
  }
  for (const group of ["output", "seed"] as const) {
    const root = roots[group]; const present = await directoryExists(root); membership[`${group}/`] = present;
    for (const dir of DIRECTORIES) if (present) await walk(group, root, dir); else membership[`${group}/${dir}/`] = false;
    for (const file of SINGLES) await add(group, root, file);
  }
  const municipalInputPrefix = roots.municipal === roots.output ? "output" : "municipal";
  if (municipalInputPrefix === "municipal") for (const file of CORE) await add("municipal", roots.municipal, file);
  inputs["capture/membership.json"] = new TextEncoder().encode(canonicalArtifactJson(membership));
  if (inputs["capture/membership.json"]!.byteLength + total > MAX_TOTAL) throw new Error("Pages input capture exceeds bounds");
  const transforms = await captureSourceTransforms(roots.source);
  if (Object.values(transforms).reduce((sum, bytes) => sum + bytes.byteLength, total) > MAX_TOTAL) throw new Error("Pages capture aggregate exceeds bounds");
  return { inputs, transforms, municipalInputPrefix, originalRoots: roots };
}
export async function assertPagesInputsUnchanged(capture: PagesInputCapture): Promise<void> {
  if (!capture.originalRoots) return;
  const roots = capture.originalRoots, current = await capturePagesPublicationInputs(roots.output, roots.seed, roots.municipal, roots.source);
  if (canonicalArtifactJson(bindings(current.inputs)) !== canonicalArtifactJson(bindings(capture.inputs)) || canonicalArtifactJson(bindings(current.transforms)) !== canonicalArtifactJson(bindings(capture.transforms))) throw new Error("Pages inputs or transformations changed during export");
}
export async function withCapturedPagesInputs<T>(capture: PagesInputCapture, task: (roots: { output: string; seed: string; municipal: string }) => Promise<T>): Promise<T> {
  assertCaptureBounds(capture);
  const temporary = await mkdtemp(join(tmpdir(), "cci-pages-inputs-"));
  try {
    for (const [key, present] of Object.entries(captureMembership(capture))) if (key.endsWith("/") && present) await mkdir(join(temporary, key), { recursive: true, mode: 0o700 });
    for (const [key, bytes] of Object.entries(capture.inputs)) {
      if (!approvedInput(key)) throw new Error("Unapproved Pages replay input");
      if (key.startsWith("capture/")) continue;
      await mkdir(dirname(join(temporary, key)), { recursive: true, mode: 0o700 }); await writeFile(join(temporary, key), bytes, { mode: 0o600, flag: "wx" });
    }
    for (const group of ["output", "seed", "municipal"]) await mkdir(join(temporary, group), { recursive: true, mode: 0o700 });
    const roots = { output: join(temporary, "output"), seed: join(temporary, "seed"), municipal: join(temporary, capture.municipalInputPrefix) };
    return await withOutputRoot(roots.output, () => task(roots));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
const hashSchema = { type: "string", pattern: "^[a-f0-9]{64}$" };
const boundSchema = { type: "object", required: ["sha256", "bytes"], additionalProperties: false, properties: { sha256: hashSchema, bytes: { type: "integer", minimum: 0, maximum: MAX_FILE } } };
const mapSchema = { type: "object", minProperties: 1, maxProperties: MAX_ROWS, propertyNames: { type: "string", maxLength: 240 }, additionalProperties: boundSchema };
const municipalSchema = { type: "object", required: ["schemaVersion", "editionId", "selection", "reason", "files", "verification"], additionalProperties: false, properties: {
  schemaVersion: { enum: ["crescent-city-publication-input/v1"] }, editionId: hashSchema, selection: { enum: ["verified-output", "reviewed-seed", "unavailable"] }, reason: { type: "string", minLength: 1, maxLength: 4096 }, files: { type: "object", maxProperties: 6, propertyNames: { enum: CORE }, additionalProperties: boundSchema }, verification: { enum: ["hash-bound-local", "reviewed-historical", "not-available"] }, sourceVerifiedAt: { type: ["string", "null"], format: "date-time" }, sourceExportedAt: { type: ["string", "null"], format: "date-time" },
} };
const receiptSchema = { type: "object", additionalProperties: false, required: ["schemaVersion", "generatedAt", "commit", "snapshot", "inputs", "transforms", "configurationSha256", "municipalInputPrefix", "captureRootSelection", "municipal", "bindingSha256", "evidenceBoundary"], properties: {
  schemaVersion: { enum: [SCHEMA] }, generatedAt: { type: "string", format: "date-time" }, commit: { type: ["string", "null"], maxLength: 40, pattern: "^[0-9a-f]{7,40}$" }, snapshot: boundSchema, inputs: mapSchema, transforms: mapSchema, configurationSha256: hashSchema, municipalInputPrefix: { enum: ["output", "seed", "municipal", null] }, captureRootSelection: { enum: ["output", "municipal"] }, municipal: municipalSchema, bindingSha256: hashSchema, evidenceBoundary: { enum: ["captured-byte-identity-and-local-replay-not-semantic-support"] },
} };
function receiptBinding(receipt: PagesFactInputReceipt): string { const { bindingSha256: _, ...payload } = receipt; return publicationHash(canonicalArtifactJson(payload)); }
export function createPagesFactInputReceipt(capture: PagesInputCapture, snapshot: Uint8Array, configuration: unknown, municipal: PublicationReceipt, generatedAt: string, commit: string | null): PagesFactInputReceipt {
  assertCaptureBounds(capture, snapshot);
  canonicalArtifactJson(configuration); // Validate finite bounded JSON before preserving its insertion order.
  const receipt: PagesFactInputReceipt = { schemaVersion: SCHEMA, generatedAt, commit, snapshot: { sha256: publicationHash(snapshot), bytes: snapshot.byteLength }, inputs: bindings(capture.inputs), transforms: bindings(capture.transforms), configurationSha256: publicationHash(JSON.stringify(configuration)), municipalInputPrefix: municipal.selection === "unavailable" ? null : municipal.selection === "reviewed-seed" ? "seed" : capture.municipalInputPrefix, captureRootSelection: capture.municipalInputPrefix, municipal, bindingSha256: "", evidenceBoundary: "captured-byte-identity-and-local-replay-not-semantic-support" };
  receipt.bindingSha256 = receiptBinding(receipt);
  const errors = validatePagesFactInputReceipt(receipt, snapshot, municipal);
  if (errors.length) throw new Error(errors.join("; "));
  return receipt;
}
/** Without the private archive this validates commitments, not independently recovered input contents. */
export function validatePagesFactInputReceipt(value: unknown, snapshot: Uint8Array, municipal: PublicationReceipt): string[] {
  const errors = validateSchema(value, receiptSchema, "public-fact-inputs"); if (errors.length) return errors;
  const r = value as PagesFactInputReceipt;
  if (municipal.selection !== "unavailable" && PUBLICATION_CORE_FILES.some(file => !Object.hasOwn(municipal.files, file))) errors.push("public-fact-inputs: municipal core membership incomplete");
  if (r.bindingSha256 !== receiptBinding(r)) errors.push("public-fact-inputs: receipt binding mismatch");
  if (r.snapshot.sha256 !== publicationHash(snapshot) || r.snapshot.bytes !== snapshot.byteLength) errors.push("public-fact-inputs: final snapshot bytes mismatch");
  if (!Object.hasOwn(r.inputs, "capture/membership.json") || Object.keys(r.inputs).some(key => !approvedInput(key)) || Object.keys(r.transforms).some(key => !approvedTransform(key))) errors.push("public-fact-inputs: unsupported input or transformation membership");
  const all = [...Object.values(r.inputs), ...Object.values(r.transforms)];
  if (all.reduce((sum, row) => sum + row.bytes, 0) > MAX_TOTAL) errors.push("public-fact-inputs: aggregate byte limit exceeded");
  if (canonicalArtifactJson(r.municipal) !== canonicalArtifactJson(municipal)) errors.push("public-fact-inputs: municipal selection differs from publication input");
  const prefix = municipal.selection === "unavailable" ? null : municipal.selection === "reviewed-seed" ? "seed" : r.captureRootSelection;
  if (r.municipalInputPrefix !== prefix || municipal.selection === "verified-output" && !["output", "municipal"].includes(prefix ?? "")) errors.push("public-fact-inputs: municipal input selection mismatch");
  for (const [file, binding] of Object.entries(municipal.files ?? {})) {
    const captured = r.inputs[`${prefix}/${file}`];
    if (!captured || captured.sha256 !== binding.sha256 || captured.bytes !== binding.bytes) errors.push(`public-fact-inputs: municipal input bytes mismatch: ${file}`);
  }
  return errors;
}
export async function validatePagesFactTransformIdentity(receipt: PagesFactInputReceipt, source = resolve(import.meta.dir, "..")): Promise<string[]> {
  const current = await captureSourceTransforms(source);
  return canonicalArtifactJson(bindings(current)) === canonicalArtifactJson(receipt.transforms) ? [] : ["public-fact-inputs: current transformation source identity mismatch"];
}
export async function retainPagesInputArchive(root: string, capture: PagesInputCapture, configuration: unknown, receipt: PagesFactInputReceipt, snapshot: Uint8Array): Promise<string> {
  // The public helper is an admission boundary too: no path, mkdir or write precedes exact evidence validation.
  assertCaptureBounds(capture, snapshot);
  canonicalArtifactJson(configuration);
  const errors = validatePagesFactInputReceipt(receipt, snapshot, receipt?.municipal);
  if (errors.length || receipt.captureRootSelection !== capture.municipalInputPrefix || canonicalArtifactJson(bindings(capture.inputs)) !== canonicalArtifactJson(receipt.inputs) || canonicalArtifactJson(bindings(capture.transforms)) !== canonicalArtifactJson(receipt.transforms) || publicationHash(JSON.stringify(configuration)) !== receipt.configurationSha256) throw new Error("Pages archive admission requires exact valid receipt and evidence binding");
  await assertSafeFilesystemPath(root);
  const base = join(resolve(root), "state", "pages-publication");
  for (const path of [resolve(root), join(resolve(root), "state"), base]) { if (!await directoryExists(path)) await mkdir(path, { recursive: true, mode: 0o700 }); }
  const stage = await mkdtemp(join(base, ".capture-")), target = join(base, `${receipt.bindingSha256}-${crypto.randomUUID()}`);
  try {
    for (const [group, rows] of [["inputs", capture.inputs], ["transforms", capture.transforms]] as const) for (const [key, bytes] of Object.entries(rows)) {
      await mkdir(dirname(join(stage, group, key)), { recursive: true, mode: 0o700 }); await writeFile(join(stage, group, key), bytes, { mode: 0o600, flag: "wx" });
    }
    for (const [file, value] of [["receipt.json", receipt], ["configuration.json", configuration]] as const) {
      canonicalArtifactJson(value);
      await writeFile(join(stage, file), `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    }
    await writeFile(join(stage, "snapshot.json"), snapshot, { mode: 0o600, flag: "wx" }); await rename(stage, target); return target;
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}
export async function readPagesInputArchive(path: string): Promise<{ capture: PagesInputCapture; configuration: unknown; receipt: PagesFactInputReceipt; snapshot: Uint8Array }> {
  const root = await assertSafeFilesystemPath(path); await directoryExists(root);
  const read = async (key: string, limit = MAX_FILE) => { if (!await safeParents(root, key)) throw new Error("Pages archive member is absent"); return captureArtifactBytes(join(root, key), limit); };
  const receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read("receipt.json", 2 * 1024 * 1024))) as PagesFactInputReceipt;
  const configuration = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read("configuration.json", 1024 * 1024)));
  const snapshot = await read("snapshot.json");
  const errors = validatePagesFactInputReceipt(receipt, snapshot, JSON.parse(new TextDecoder().decode(snapshot)).publication);
  if (errors.length) throw new Error(errors.join("; "));
  const rootEntries = await readdir(root, { withFileTypes: true });
  if (rootEntries.length !== 5 || rootEntries.some(entry => entry.isSymbolicLink() || !["inputs", "transforms", "receipt.json", "configuration.json", "snapshot.json"].includes(entry.name))) throw new Error("Pages archive root membership mismatch");
  let visited = 0;
  async function inventory(group: "inputs" | "transforms", directory = "", depth = 0): Promise<string[]> {
    if (++visited > MAX_ROWS * 2 || depth > 16 || !await directoryExists(join(root, group, directory))) throw new Error("Pages archive directory exceeds bounds");
    const entries = await readdir(join(root, group, directory), { withFileTypes: true });
    if (entries.length > MAX_ROWS) throw new Error("Pages archive directory exceeds bounds");
    const files: string[] = [];
    for (const entry of entries) {
      const key = directory ? `${directory}/${entry.name}` : entry.name;
      if (!safePath(key) || entry.isSymbolicLink()) throw new Error("Pages archive path is unsafe");
      if (entry.isDirectory()) files.push(...await inventory(group, key, depth + 1));
      else if (entry.isFile()) files.push(key);
      else throw new Error("Pages archive member must be a regular file");
      if (files.length > MAX_ROWS) throw new Error("Pages archive file count exceeds bounds");
    }
    return files;
  }
  for (const group of ["inputs", "transforms"] as const) if (JSON.stringify((await inventory(group)).sort()) !== JSON.stringify(Object.keys(receipt[group]).sort())) throw new Error("Pages archive input membership mismatch");
  const capture: PagesInputCapture = { inputs: {}, transforms: {}, municipalInputPrefix: receipt.captureRootSelection };
  for (const [group, expected] of [["inputs", receipt.inputs], ["transforms", receipt.transforms]] as const) for (const [key, binding] of Object.entries(expected)) {
    const bytes = await read(`${group}/${key}`, Math.max(1, binding.bytes));
    if (bytes.byteLength !== binding.bytes || publicationHash(bytes) !== binding.sha256) throw new Error("Pages archive input identity mismatch");
    capture[group][key] = bytes;
  }
  canonicalArtifactJson(configuration);
  if (publicationHash(JSON.stringify(configuration)) !== receipt.configurationSha256) throw new Error("Pages archive configuration identity mismatch");
  assertCaptureBounds(capture, snapshot);
  return { capture, configuration, receipt, snapshot };
}
