/** Derived-fact byte custody, independent of municipal-code publication eligibility. */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { ARTIFACT_CONTRACT_VERSION, assertArtifact, type ArtifactFamily } from "./artifact_contracts.js";
import { validateSchema } from "./schema_validation.js";

export const ARTIFACT_CUSTODY_SCHEMA = "crescent-city-derived-custody/v1";
export interface BoundBytes { sha256: string; bytes: number }
export interface ArtifactCustodyReceipt {
  schemaVersion: typeof ARTIFACT_CUSTODY_SCHEMA;
  contractVersion: typeof ARTIFACT_CONTRACT_VERSION;
  family: ArtifactFamily;
  generatedAt: string;
  output: BoundBytes;
  inputs: Record<string, BoundBytes>;
  transforms: Record<string, BoundBytes>;
  configurationSha256: string;
  bindingSha256: string;
  evidenceBoundary: "byte-identity-and-replay-only";
}
export interface ArtifactCustodyInputs {
  inputs: Record<string, Uint8Array>;
  transforms: Record<string, Uint8Array>;
  configuration: unknown;
}
const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
/** Stable configuration encoding rejects undefined, cycles and nonfinite values. */
export function canonicalArtifactJson(value: unknown): string {
  const seen = new Set<object>(); let nodes = 0;
  const encode = (item: unknown, depth: number): string => {
    if (++nodes > 100_000 || depth > 32 || typeof item === "string" && item.length > 65_536) throw new Error("Custody configuration exceeds bounds");
    if (item === null || typeof item === "boolean" || typeof item === "string" || typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || seen.has(item)) throw new Error("Custody configuration must be finite acyclic JSON");
    seen.add(item);
    try {
      if (Array.isArray(item)) return `[${item.map(child => encode(child, depth + 1)).join(",")}]`;
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("Custody configuration must use plain objects");
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
    } finally { seen.delete(item); }
  };
  const encoded = encode(value, 0);
  if (Buffer.byteLength(encoded, "utf8") > 1024 * 1024) throw new Error("Custody configuration exceeds bounds");
  return encoded;
}
const identity = { type: "string", minLength: 1, maxLength: 240, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[A-Za-z0-9_./-]+$" };
const bound = { type: "object", required: ["sha256", "bytes"], additionalProperties: false, properties: { sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, bytes: { type: "integer", minimum: 0, maximum: 64 * 1024 * 1024 } } };
const rows = { type: "object", minProperties: 1, maxProperties: 4096, propertyNames: identity, additionalProperties: bound };
const receiptSchema = { type: "object", additionalProperties: false, required: ["schemaVersion", "contractVersion", "family", "generatedAt", "output", "inputs", "transforms", "configurationSha256", "bindingSha256", "evidenceBoundary"], properties: {
  schemaVersion: { enum: [ARTIFACT_CUSTODY_SCHEMA] }, contractVersion: { enum: [ARTIFACT_CONTRACT_VERSION] }, family: { enum: ["events", "source-health", "source-health-report", "source-health-summary", "monthly-report", "pipeline-run", "curation-run", "weekly-summary", "analytics-overview", "directory", "corpus-lineage"] }, generatedAt: { type: "string", format: "date-time" }, output: bound, inputs: rows, transforms: rows, configurationSha256: bound.properties.sha256, bindingSha256: bound.properties.sha256, evidenceBoundary: { enum: ["byte-identity-and-replay-only"] },
} };
const bindings = (items: Record<string, Uint8Array>): Record<string, BoundBytes> => Object.fromEntries(Object.keys(items).sort().map(key => [key, { sha256: sha(items[key]!), bytes: items[key]!.byteLength }]));
const bindingHash = (receipt: Omit<ArtifactCustodyReceipt, "bindingSha256"> | ArtifactCustodyReceipt): string => {
  const { bindingSha256: _, ...payload } = receipt as ArtifactCustodyReceipt;
  return sha(canonicalArtifactJson(payload));
};
/** Bound regular-file read; no symlinks or changing snapshots become source evidence. */
export async function captureArtifactBytes(path: string, maxBytes = 64 * 1024 * 1024): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new Error("Custody byte bound must be an integer from 1 through 64 MiB");
  const { constants } = await import("node:fs");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error("Custody input is not a bounded regular file");
    const parts: Uint8Array[] = []; let size = 0;
    while (true) {
      const buffer = new Uint8Array(Math.min(65_536, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      size += bytesRead; if (size > maxBytes) throw new Error("Custody input exceeds byte bound");
      parts.push(buffer.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(parts); const after = await handle.stat();
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Custody input changed during capture");
    return bytes;
  } finally { await handle.close(); }
}
function evidenceWithinBounds(output: Uint8Array, evidence: ArtifactCustodyInputs): boolean {
  if (!(output instanceof Uint8Array) || output.byteLength > 64 * 1024 * 1024 || !evidence?.inputs || !evidence.transforms) return false;
  const groups = [evidence.inputs, evidence.transforms];
  if (groups.some(group => typeof group !== "object" || Array.isArray(group) || Object.keys(group).length === 0 || Object.keys(group).length > 4096)) return false;
  const rows = groups.flatMap(group => Object.values(group));
  return rows.every(row => row instanceof Uint8Array && row.byteLength <= 64 * 1024 * 1024) && rows.reduce((sum, row) => sum + row.byteLength, 0) <= 256 * 1024 * 1024;
}
export function createArtifactCustody(family: ArtifactFamily, output: Uint8Array, evidence: ArtifactCustodyInputs, generatedAt = new Date().toISOString()): ArtifactCustodyReceipt {
  if (!evidenceWithinBounds(output, evidence)) throw new Error("Custody evidence exceeds byte bound");
  assertArtifact(family, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output)));
  const receipt: ArtifactCustodyReceipt = { schemaVersion: ARTIFACT_CUSTODY_SCHEMA, contractVersion: ARTIFACT_CONTRACT_VERSION, family, generatedAt, output: { sha256: sha(output), bytes: output.byteLength }, inputs: bindings(evidence.inputs), transforms: bindings(evidence.transforms), configurationSha256: sha(canonicalArtifactJson(evidence.configuration)), bindingSha256: "", evidenceBoundary: "byte-identity-and-replay-only" };
  receipt.bindingSha256 = bindingHash(receipt);
  const errors = validateSchema(receipt, receiptSchema, "custody");
  if (errors.length) throw new Error(errors.join("; "));
  return receipt;
}
export function validateArtifactCustody(receipt: unknown, output: Uint8Array, evidence: ArtifactCustodyInputs): string[] {
  if (!evidenceWithinBounds(output, evidence)) return ["custody: evidence exceeds byte or membership bound"];
  const errors = validateSchema(receipt, receiptSchema, "custody");
  if (errors.length) return errors;
  const r = receipt as ArtifactCustodyReceipt;
  if (r.bindingSha256 !== bindingHash(r)) errors.push("custody: receipt binding mismatch");
  if (r.output.sha256 !== sha(output) || r.output.bytes !== output.byteLength) errors.push("custody: output bytes mismatch");
  if (canonicalArtifactJson(r.inputs) !== canonicalArtifactJson(bindings(evidence.inputs))) errors.push("custody: input membership or bytes mismatch");
  if (canonicalArtifactJson(r.transforms) !== canonicalArtifactJson(bindings(evidence.transforms))) errors.push("custody: transform membership or bytes mismatch");
  if (r.configurationSha256 !== sha(canonicalArtifactJson(evidence.configuration))) errors.push("custody: configuration mismatch");
  try { assertArtifact(r.family, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output))); } catch { errors.push("custody: output family contract failed"); }
  return errors;
}
/** Caller supplies the declared deterministic transformer; no receipt executes source code. */
export async function replayArtifactCustody(receipt: unknown, output: Uint8Array, evidence: ArtifactCustodyInputs, transform: (inputs: Readonly<Record<string, Uint8Array>>, configuration: unknown) => Promise<Uint8Array> | Uint8Array): Promise<string[]> {
  const errors = validateArtifactCustody(receipt, output, evidence);
  if (errors.length) return errors;
  const replay = await transform(evidence.inputs, evidence.configuration);
  return sha(replay) === (receipt as ArtifactCustodyReceipt).output.sha256 && replay.byteLength === output.byteLength ? [] : ["custody: deterministic replay output mismatch"];
}
