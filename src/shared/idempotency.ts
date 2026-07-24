/**
 * Shared idempotency store.
 *
 * A single (id, contentHash)-keyed, JSON-persisted, atomic-write store used
 * by every monitor — news, government meetings, YouTube, Triplicate, and
 * beyond — instead of each source reinventing its own persistence shape.
 *
 * Replaces two prior bespoke implementations:
 * - news_monitor.ts's loadSeenIds/saveSeenIds (a bare string[] of normalized
 *   URLs at the legacy output/news/seen-ids.json path) — load() transparently recognizes
 *   and migrates that legacy array shape on first read, so no separate
 *   one-shot migration script is needed and no history is lost.
 * - gov_meeting_monitor.ts's PROCESSED_MEETING_CACHE — an in-memory-only
 *   Map that was never persisted to disk, so every separate CLI invocation
 *   silently started from empty and treated everything as new. Using this
 *   store instead of that Map is a real idempotency fix, not just a refactor.
 */
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { computeSha256 } from "../utils.js";
import { createLogger } from "../logger.js";

const logger = createLogger("idempotency");

export interface IdempotencyRecord {
  /** Content hash at last observation. Empty string if the caller doesn't track content changes (presence-only dedup). */
  hash: string;
  /** ISO timestamp of first observation. */
  firstSeen: string;
  /** ISO timestamp of most recent observation. */
  lastSeen: string;
  /** Arbitrary caller-supplied metadata (e.g. title, source name). */
  meta?: Record<string, unknown>;
}

export interface SeenResult {
  /** True if this id has never been recorded before. */
  isNew: boolean;
  /** True if isNew, or if a non-empty hash differs from the previously recorded hash. */
  changed: boolean;
}

/** Compute SHA-256 hash of a string — re-exported so callers only import from one place. */
export const hashContent = computeSha256;

export class IdempotencyStore {
  private readonly path: string;
  private readonly cap: number;
  private records = new Map<string, IdempotencyRecord>();
  private loaded = false;

  constructor(path: string, cap = 10_000) {
    this.path = path;
    this.cap = cap;
  }

  /** Load persisted state from disk. Safe to call multiple times (no-op after first). */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;

    try {
      const raw = await readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw);

      // Legacy shape migration: a bare string[] of ids (news_monitor.ts's
      // original seen-ids.json). Treated as presence-only records so none
      // of that history is lost and nothing gets reprocessed as "new".
      if (Array.isArray(parsed)) {
        const now = new Date().toISOString();
        for (const id of parsed) {
          if (typeof id === "string") {
            this.records.set(id, { hash: "", firstSeen: now, lastSeen: now });
          }
        }
        logger.info(`Migrated ${this.records.size} legacy string[] id(s) from ${this.path}`);
        return;
      }

      for (const [id, rec] of Object.entries(parsed as Record<string, IdempotencyRecord>)) {
        this.records.set(id, rec);
      }
    } catch (err: any) {
      // Corrupt or unreadable — start empty rather than crash the calling monitor.
      logger.warn(`Failed to load idempotency store at ${this.path}, starting empty`, { error: err.message });
      this.records = new Map();
    }
  }

  /** True if this id has ever been recorded. Does not mutate state. */
  has(id: string): boolean {
    return this.records.has(id);
  }

  /** Read a retained record without mutating the store. */
  get(id: string): IdempotencyRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Check-and-record in one step. Always records the current observation
   * (new id, or an updated hash/lastSeen for an existing id).
   *
   * @param hash - Content hash for change detection. Omit (or pass "") for
   *   presence-only dedup (news-style: "have we seen this URL", never re-flag).
   */
  seen(id: string, hash: string = "", meta?: Record<string, unknown>): SeenResult {
    const now = new Date().toISOString();
    const existing = this.records.get(id);

    if (!existing) {
      this.records.set(id, { hash, firstSeen: now, lastSeen: now, meta });
      this.cleanup();
      return { isNew: true, changed: true };
    }

    const changed = hash !== "" && existing.hash !== hash;
    this.records.set(id, {
      hash: hash || existing.hash,
      firstSeen: existing.firstSeen,
      lastSeen: now,
      meta: meta ?? existing.meta,
    });
    return { isNew: false, changed };
  }

  /** Record an observation without needing the isNew/changed classification back. */
  record(id: string, hash: string = "", meta?: Record<string, unknown>): void {
    this.seen(id, hash, meta);
  }

  /** Number of ids currently retained. */
  get size(): number {
    return this.records.size;
  }

  /** Cap retained entries, dropping the oldest-firstSeen first (mirrors prior per-source caps). */
  private cleanup(): void {
    if (this.records.size <= this.cap) return;
    const entries = [...this.records.entries()].sort(
      (a, b) => new Date(a[1].firstSeen).getTime() - new Date(b[1].firstSeen).getTime()
    );
    const toDrop = entries.length - this.cap;
    for (let i = 0; i < toDrop; i++) this.records.delete(entries[i][0]);
  }

  /** Persist current state to disk via a temp-file-then-rename atomic write. */
  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const obj: Record<string, IdempotencyRecord> = {};
    for (const [id, rec] of this.records) obj[id] = rec;

    const tmpPath = `${this.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmpPath, JSON.stringify(obj, null, 2));
    await rename(tmpPath, this.path);
  }
}
