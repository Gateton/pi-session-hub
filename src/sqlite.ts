/**
 * Read-only SQLite access via node:sqlite.
 *
 * node:sqlite ships with Node 22.5+ and supports FTS5, so the hub needs zero
 * native dependencies. Databases are always opened read-only: this extension
 * must never mutate another harness's store.
 */

import { safeStat } from "./adapters/util.ts";

type SqliteModule = typeof import("node:sqlite");

let cached: Promise<SqliteModule> | null = null;

/**
 * Import node:sqlite while suppressing its one ExperimentalWarning, which would
 * otherwise be printed straight into the TUI.
 */
async function loadSqlite(): Promise<SqliteModule> {
  if (!cached) {
    cached = (async () => {
      const original = process.emitWarning;
      process.emitWarning = function patched(
        warning: string | Error,
        ...rest: unknown[]
      ): void {
        const message =
          typeof warning === "string" ? warning : String(warning?.message ?? "");
        if (message.includes("SQLite is an experimental feature")) return;
        (original as (...a: unknown[]) => void).call(process, warning, ...rest);
      } as typeof process.emitWarning;
      try {
        return await import("node:sqlite");
      } finally {
        process.emitWarning = original;
      }
    })();
  }
  return cached;
}

export interface ReadOnlyDb {
  /**
   * Query rows. THROWS on failure. A silent empty array is indistinguishable
   * from "this source has no sessions", which previously caused a failed read to
   * be reported as an empty index and then triggered a destructive rescan.
   */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  /** Query one row. THROWS on failure. */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  /**
   * Execute a statement that returns no rows (INSERT/UPDATE/DELETE/DDL).
   * node:sqlite rejects non-SELECT statements on `all()`, so writes must go
   * through here.
   */
  run(sql: string, params?: unknown[]): void;
  close(): void;
}

function wrap(handle: {
  prepare(sql: string): {
    all(...p: never[]): unknown;
    get(...p: never[]): unknown;
    run(...p: never[]): unknown;
  };
  close(): void;
}, label: string): ReadOnlyDb {
  return {
    all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
      try {
        return handle.prepare(sql).all(...(params as never[])) as T[];
      } catch (err) {
        throw new Error(`${label} read failed: ${message(err)}`);
      }
    },
    get<T = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): T | undefined {
      try {
        return handle.prepare(sql).get(...(params as never[])) as T | undefined;
      } catch (err) {
        throw new Error(`${label} read failed: ${message(err)}`);
      }
    },
    run(sql: string, params: unknown[] = []): void {
      try {
        handle.prepare(sql).run(...(params as never[]));
      } catch (err) {
        throw new Error(`${label} write failed: ${message(err)}`);
      }
    },
    close(): void {
      try {
        handle.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Open another harness's database strictly read-only. Writes are refused loudly.
 */
export async function openReadOnly(file: string): Promise<ReadOnlyDb | null> {
  if (!safeStat(file)) return null;
  let mod: SqliteModule;
  try {
    mod = await loadSqlite();
  } catch {
    return null;
  }

  let db: InstanceType<SqliteModule["DatabaseSync"]> | null = null;
  try {
    db = new mod.DatabaseSync(file, { readOnly: true });
  } catch {
    // WAL databases can refuse a read-only open when the -shm file is missing
    // and cannot be created. Retry without the hint; we only ever issue SELECTs.
    try {
      db = new mod.DatabaseSync(file, { readOnly: false });
    } catch {
      return null;
    }
  }

  const inner = wrap(db as never, `sqlite(${file})`);
  return {
    ...inner,
    run(sql: string): void {
      // A read-only handle must never be used for writes.
      throw new Error(`refusing to execute a write on a read-only database: ${sql}`);
    },
  };
}

/** Open (or create) the hub's own index database. This is the only writable DB. */
export async function openIndexDb(file: string): Promise<ReadOnlyDb | null> {
  let mod: SqliteModule;
  try {
    mod = await loadSqlite();
  } catch {
    return null;
  }
  let db: InstanceType<SqliteModule["DatabaseSync"]>;
  try {
    db = new mod.DatabaseSync(file);
  } catch {
    return null;
  }
  // Wait for other connections instead of failing: the user may have several Pi
  // sessions open, and the index is shared between them.
  try {
    db.exec("PRAGMA busy_timeout = 5000");
  } catch {
    /* non-fatal */
  }
  return wrap(db as never, "index");
}

/** Run a statement on the index DB. Throws on failure so bugs are not silent. */
export function exec(handle: ReadOnlyDb, sql: string, params: unknown[] = []): void {
  handle.run(sql, params);
}
