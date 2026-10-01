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
import { withFileLease, assertSafeFilesystemPath } from "./storage.js";
import { writeJsonAtomic } from "./source_health.js";
import { replaceArtifacts, recoverArtifactTransactions, readBoundedArtifact, type ArtifactReplacement, type ArtifactTransactionReceipt } from "./artifact_transaction.js";
import { currentRunSignal } from "./run_scope.js";
import { relative } from "node:path";
import { computeSha256 } from "../utils.js";
import { createLogger } from "../logger.js";
import { throwIfAborted } from "./transport.js";

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
  private dirty = new Set<string>();
  private loadFailure: Error | null = null;

  constructor(path: string, cap = 10_000) {
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 100_000) throw new Error("Invalid idempotency retention cap");
    this.path = path;
    this.cap = cap;
  }

  /** Load persisted state from disk. Safe to call multiple times (no-op after first). */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      await assertSafeFilesystemPath(this.path);
      const bytes = await readBoundedArtifact(this.path, 8_000_000); if (bytes === null) return;
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = JSON.parse(raw);

      // Legacy shape migration: a bare string[] of ids (news_monitor.ts's
      // original seen-ids.json). Treated as presence-only records so none
      // of that history is lost and nothing gets reprocessed as "new".
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === "string") {
            this.records.set(id, { hash: "", firstSeen: "", lastSeen: "", meta: { dateEvidence: "legacy-unknown" } });
          }
        }
        // A migrated legacy array larger than the cap must be trimmed now,
        // not left over-cap in memory until the next new-id insert.
        this.cleanup();
        logger.info(`Migrated ${this.records.size} legacy string[] id(s) from ${this.path}`);
        return;
      }

      if (!parsed || typeof parsed !== "object") throw new Error("Malformed idempotency store");
      for (const [id, rec] of Object.entries(parsed as Record<string, IdempotencyRecord>)) {
        if (!rec || typeof rec !== "object" || typeof rec.hash !== "string" || typeof rec.firstSeen !== "string" || typeof rec.lastSeen !== "string") throw new Error("Malformed idempotency record");
        this.records.set(id, rec);
      }
      this.cleanup();
    } catch (err: any) {
      // Corrupt or unreadable — start empty rather than crash the calling monitor.
      logger.warn(`Failed to load idempotency store at ${this.path}, starting empty`, { error: err.message });
      this.records = new Map();
      this.loadFailure = err instanceof Error ? err : new Error(String(err));
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
    this.dirty.add(id);
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
      (a, b) => (Date.parse(a[1].firstSeen) || 0) - (Date.parse(b[1].firstSeen) || 0)
    );
    const toDrop = entries.length - this.cap;
    for (let i = 0; i < toDrop; i++) this.records.delete(entries[i][0]);
  }
  private serialized(): string {
    const text = JSON.stringify(Object.fromEntries(this.records), null, 2);
    if (Buffer.byteLength(text, 'utf8') > 8_000_000) throw new Error('Idempotency evidence exceeds persisted byte bound');
    return text;
  }

  /** Commit new identity records and their source artifacts as one recoverable byte bundle. */
  async publish(root: string, artifacts: ArtifactReplacement[], options: { signal?: AbortSignal; onProgress?: (receipt: ArtifactTransactionReceipt) => Promise<void> } = {}): Promise<void> {
    options = { ...options, signal: options.signal ?? currentRunSignal() };
    if (options.signal) throwIfAborted(options.signal);
    if (this.loadFailure) throw new Error("Refusing to replace corrupt idempotency evidence");
    await withFileLease(`${this.path}.lock`, async () => {
      if (options.signal) throwIfAborted(options.signal);
      await recoverArtifactTransactions(root);
      const disk = new IdempotencyStore(this.path, this.cap); await disk.load();
      if (disk.loadFailure) throw new Error("Refusing to replace corrupt idempotency evidence");
      for (const [id, record] of this.records) {
        if (!this.dirty.has(id) && disk.records.has(id)) continue;
        const previous = disk.records.get(id);
        if (!previous || (Date.parse(record.lastSeen) || 0) >= (Date.parse(previous.lastSeen) || 0)) disk.records.set(id, { ...record, firstSeen: previous ? previous.firstSeen : record.firstSeen });
      }
      disk.cleanup();
      await replaceArtifacts(root, [...artifacts, { path: relative(root, this.path), text: disk.serialized() }], options);
      this.records = disk.records; this.dirty.clear();
    }, { signal: options.signal, staleMs: 0 });
  }

  /** Persist current state to disk via a temp-file-then-rename atomic write. */
  async save(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (options.signal) throwIfAborted(options.signal);
    if (this.loadFailure) throw new Error("Refusing to replace corrupt idempotency evidence; preserve/quarantine the original first");
    await withFileLease(`${this.path}.lock`, async () => {
      if (options.signal) throwIfAborted(options.signal);
      const disk = new IdempotencyStore(this.path, this.cap);
      await disk.load();
      if (options.signal) throwIfAborted(options.signal);
      if (disk.loadFailure) throw new Error("Refusing to replace corrupt idempotency evidence");
      for (const [id, record] of this.records) {
        if (!this.dirty.has(id) && disk.records.has(id)) continue;
        const existing = disk.records.get(id);
        if (!existing || (Date.parse(record.lastSeen) || 0) >= (Date.parse(existing.lastSeen) || 0)) disk.records.set(id, { ...record, firstSeen: existing ? existing.firstSeen : record.firstSeen });
      }
      disk.cleanup();
      if (options.signal) throwIfAborted(options.signal);
      await writeJsonAtomic(this.path, JSON.parse(disk.serialized()), options);
      this.records = disk.records; this.dirty.clear();
      if (options.signal) throwIfAborted(options.signal);
    }, options);
  }
}
