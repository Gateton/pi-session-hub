/**
 * Scan orchestration.
 *
 * Walks the enabled adapters and folds their results into the local index.
 * JSONL-backed harnesses are skipped when their file fingerprint is unchanged,
 * so repeat scans are cheap.
 */

import type { ExternalSession, HarnessId } from "../types.ts";
import type { AdapterRegistry } from "../adapters/registry.ts";
import {
  indexCount,
  markIndexed,
  removeSessions,
  sourceFingerprint,
  setSourceFingerprint,
  transaction,
  upsertSessions,
  type IndexHandle,
} from "./db.ts";

export interface ScanProgress {
  phase: string;
  done: number;
  total: number;
  message?: string;
}

export interface ScanResult {
  total: number;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  perHarness: Record<string, number>;
  errors: { harness: HarnessId; message: string }[];
  /** Harnesses whose sessions were fully read this pass. */
  scanned: HarnessId[];
  /** Harnesses that failed. Their indexed sessions are preserved, not deleted. */
  failed: HarnessId[];
  durationMs: number;
}

export interface ScanOptions {
  /** Ignore fingerprints and re-read every source. */
  force?: boolean;
  maxPerHarness?: number;
  onProgress?: (p: ScanProgress) => void;
}

/**
 * Harnesses whose sessions live in one database. Their fingerprint is the
 * database file itself, so a full re-read is the only correct behaviour.
 */
const DB_BACKED: HarnessId[] = ["opencode", "crush"];

export async function scan(
  handle: IndexHandle,
  registry: AdapterRegistry,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const started = Date.now();
  const adapters = registry.active();
  const result: ScanResult = {
    total: 0,
    added: 0,
    updated: 0,
    removed: 0,
    skipped: 0,
    perHarness: {},
    errors: [],
    scanned: [],
    failed: [],
    durationMs: 0,
  };

  const seen = new Set<string>();
  const succeeded = new Set<HarnessId>();
  let done = 0;

  for (const adapter of adapters) {
    opts.onProgress?.({
      phase: "scan",
      done,
      total: adapters.length,
      message: `reading ${adapter.displayName}`,
    });

    let sessions: ExternalSession[] = [];
    try {
      sessions = await adapter.listSessions({ maxSessions: opts.maxPerHarness ?? 2000 });
      succeeded.add(adapter.id);
    } catch (err) {
      result.errors.push({
        harness: adapter.id,
        message: err instanceof Error ? err.message : String(err),
      });
      result.failed.push(adapter.id);
      done++;
      continue;
    }

    const toWrite: ExternalSession[] = [];
    for (const s of sessions) {
      seen.add(s.uid);
      if (!opts.force && !DB_BACKED.includes(adapter.id)) {
        const prev = sourceFingerprint(handle, adapter.id, s.path);
        if (prev && prev.mtime_ms === s.mtimeMs && prev.size === s.size) {
          result.skipped++;
          continue;
        }
      }
      toWrite.push(s);
    }

    const before = indexCount(handle);
    // One transaction per adapter: without it, each statement is its own
    // fsync and a full scan takes tens of seconds.
    transaction(handle, () => {
      for (const s of toWrite) {
        setSourceFingerprint(handle, adapter.id, s.path, s.mtimeMs, s.size);
      }
      upsertSessions(handle, toWrite);
    });
    const after = indexCount(handle);
    result.added += Math.max(0, after - before);
    result.updated += toWrite.length - Math.max(0, after - before);
    result.perHarness[adapter.id] = sessions.length;
    done++;
  }

  // Drop sessions that vanished from every source, but ONLY for harnesses that
  // were actually read this pass. Without this guard, a single transient adapter
  // failure would delete that harness's entire slice of the index.
  const stale = handle.db
    .all<{ uid: string; harness: HarnessId }>("select uid, harness from sessions")
    .filter((row) => succeeded.has(row.harness) && !seen.has(row.uid))
    .map((row) => row.uid);
  if (stale.length > 0) {
    transaction(handle, () => removeSessions(handle, stale));
    result.removed = stale.length;
  }

  result.scanned = [...succeeded];

  result.total = indexCount(handle);
  result.durationMs = Date.now() - started;
  markIndexed(handle, new Date().toISOString());
  opts.onProgress?.({ phase: "done", done: adapters.length, total: adapters.length });
  return result;
}

/** Detection only, without touching the index. */
export async function detectSources(registry: AdapterRegistry) {
  return registry.detectAll();
}
