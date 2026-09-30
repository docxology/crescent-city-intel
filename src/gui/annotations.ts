/**
 * Phase 9 GUI surfaces — user-anchored map annotations (persistence layer).
 *
 * The wildfire map is the annotated surface (see modules/145-phase9-hazards.js):
 * users anchor a note to a point on the distance-band wildfire map, and the note
 * is persisted server-side in a bounded JSON artifact under output/state/,
 * following the bounded-storage precedent of readability_history.ts.
 *
 * Storage contract:
 * - `output/state/annotations.json`, written atomically (writeJsonAtomic).
 * - Bounded to ANNOTATION_MAX_COUNT entries; the OLDEST notes are dropped when
 *   the bound is exceeded, and the response reports the drop explicitly so
 *   "missing old notes" is never silently read as "none existed".
 * - `CC_OUTPUT_DIR` (paths.outputRoot()) scopes writes, so tests write to
 *   os.tmpdir() and the output-corpus fence stays clean.
 */
import { existsSync, readFileSync, mkdirSync } from "fs";
import { mkdir } from "fs/promises";
import { join, dirname } from "path";
import { writeJsonAtomic } from "../shared/source_health.js";
import { withFileLease } from "../shared/storage.js";
import { randomUUID } from "node:crypto";
import { paths } from "../shared/paths.js";

/** The surface these annotations anchor to. Extending this is a contract change. */
export const ANNOTATION_SURFACE = "wildfire-map";
export const ANNOTATION_MAX_COUNT = 200;
export const ANNOTATION_TEXT_MAX = 500;
export const ANNOTATION_TEXT_MIN = 1;

export interface MapAnnotation {
  id: string;
  surface: "wildfire-map";
  /** Map position, percent of canvas width/height (0-100). */
  x: number;
  y: number;
  /** Note text, trimmed, 1..ANNOTATION_TEXT_MAX chars. */
  text: string;
  createdAt: string;
}

export interface AnnotationStore {
  /** Schema version, bumped on any breaking change to this file's shape. */
  schemaVersion: "1.0.0";
  annotations: MapAnnotation[];
  /** How many entries have been dropped past the bound since first write. */
  droppedPastBound: number;
}

export type AnnotationValidationResult =
  | { ok: true; value: { x: number; y: number; text: string } }
  | { ok: false; error: string };

/** Parse + validate an annotation payload from an HTTP JSON body. */
export function validateAnnotationInput(body: unknown): AnnotationValidationResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const { x, y, text } = body as Record<string, unknown>;
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 100) {
    return { ok: false, error: "x must be a number between 0 and 100" };
  }
  if (typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > 100) {
    return { ok: false, error: "y must be a number between 0 and 100" };
  }
  if (typeof text !== "string" || text.trim().length < ANNOTATION_TEXT_MIN) {
    return { ok: false, error: "text must be a non-empty string" };
  }
  if (text.trim().length > ANNOTATION_TEXT_MAX) {
    return { ok: false, error: `text must be at most ${ANNOTATION_TEXT_MAX} characters` };
  }
  return { ok: true, value: { x, y, text: text.trim() } };
}

function annotationsFilePath(): string {
  return join(paths.state, "annotations.json");
}

function emptyStore(): AnnotationStore {
  return { schemaVersion: "1.0.0", annotations: [], droppedPastBound: 0 };
}

/** Read the annotation store; a missing or corrupt file is an explicit empty store. */
export function readAnnotationStore(): AnnotationStore {
  const file = annotationsFilePath();
  if (!existsSync(file)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as AnnotationStore;
    if (parsed?.schemaVersion !== "1.0.0" || !Array.isArray(parsed.annotations) || parsed.annotations.length > ANNOTATION_MAX_COUNT || !Number.isSafeInteger(parsed.droppedPastBound) || parsed.droppedPastBound < 0) throw new Error("Invalid annotation store");
    const ids = new Set<string>();
    for (const annotation of parsed.annotations) {
      if (!isWellFormedAnnotationId(annotation?.id) || ids.has(annotation.id) || annotation.surface !== ANNOTATION_SURFACE || !validateAnnotationInput(annotation).ok || !Number.isFinite(Date.parse(annotation.createdAt))) throw new Error("Invalid annotation record");
      ids.add(annotation.id);
    }
    return { schemaVersion: "1.0.0", annotations: parsed.annotations, droppedPastBound: parsed.droppedPastBound ?? 0 };
  } catch {
    throw new Error("Annotation store is malformed; preserve it for repair");
  }
}

/** Persist an annotation; returns the stored record (id assigned here). */
export async function addAnnotation(input: { x: number; y: number; text: string }): Promise<MapAnnotation> {
  return withFileLease(`${annotationsFilePath()}.lock`, async () => {
  const store = readAnnotationStore();
  const annotation: MapAnnotation = {
    id: `ann-${Date.now()}-${randomUUID().replace(/-/g, "")}`,
    surface: ANNOTATION_SURFACE,
    x: input.x,
    y: input.y,
    text: input.text,
    createdAt: new Date().toISOString(),
  };
  const annotations = [...store.annotations, annotation];
  let droppedPastBound = store.droppedPastBound;
  // Oldest-first eviction keeps the artifact bounded; the count is reported so
  // the GUI can state "N older notes were dropped by the 200-note bound".
  while (annotations.length > ANNOTATION_MAX_COUNT) {
    annotations.shift();
    droppedPastBound += 1;
  }
  const file = annotationsFilePath();
  await mkdir(dirname(file), { recursive: true });
  await writeJsonAtomic(file, { schemaVersion: "1.0.0", annotations, droppedPastBound });
  return annotation;
  });
}

/** Remove one annotation by id; returns false when the id is unknown. */
export async function deleteAnnotation(id: string): Promise<boolean> {
  return withFileLease(`${annotationsFilePath()}.lock`, async () => {
  const store = readAnnotationStore();
  const before = store.annotations.length;
  const annotations = store.annotations.filter(a => a.id !== id);
  if (annotations.length === before) return false;
  const file = annotationsFilePath();
  await mkdir(dirname(file), { recursive: true });
  await writeJsonAtomic(file, { schemaVersion: "1.0.0", annotations, droppedPastBound: store.droppedPastBound });
  return true;
  });
}

/** Safe id check: ids are server-generated `ann-<ts>-<rand>`. */
export function isWellFormedAnnotationId(id: string): boolean {
  return /^ann-\d+-[a-z0-9]+$/.test(id);
}
