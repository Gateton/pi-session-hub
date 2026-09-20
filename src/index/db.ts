/**
 * Local index.
 *
 * The only place this extension writes. Everything else in the harness stores is
 * opened read-only. Uses SQLite via node:sqlite with an FTS5 table for search,
 * so there are no native dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExternalSession, HarnessId, SessionDetail } from "../types.ts";
import { exec, openIndexDb, type ReadOnlyDb } from "../sqlite.ts";

export const SCHEMA_VERSION = "1";

export interface IndexedSessionRow {
  uid: string;
  harness: HarnessId;
  native_id: string;
  path: string;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
  cwd: string | null;
  repo: string | null;
  model: string | null;
  message_count: number;
  tool_count: number;
  preview: string | null;
  fidelity: string;
  mtime_ms: number;
  size: number;
}

export interface IndexHandle {
  db: ReadOnlyDb;
  close(): void;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     uid TEXT PRIMARY KEY,
     harness TEXT NOT NULL,
     native_id TEXT NOT NULL,
     path TEXT NOT NULL,
     title TEXT,
     created_at TEXT,
     updated_at TEXT,
     cwd TEXT,
     repo TEXT,
     model TEXT,
     message_count INTEGER DEFAULT 0,
     tool_count INTEGER DEFAULT 0,
     preview TEXT,
     fidelity TEXT,
     mtime_ms REAL DEFAULT 0,
     size INTEGER DEFAULT 0,
     indexed_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_harness ON sessions(harness)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo)`,
  `CREATE TABLE IF NOT EXISTS files (
     uid TEXT NOT NULL,
     path TEXT NOT NULL,
     kind TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_files_uid ON files(uid)`,
  `CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)`,
  `CREATE TABLE IF NOT EXISTS sources (
     harness TEXT NOT NULL,
     path TEXT NOT NULL,
     mtime_ms REAL,
     size INTEGER,
     PRIMARY KEY (harness, path)
   )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
     uid UNINDEXED,
     title,
     body,
     tokenize='unicode61 remove_diacritics 2'
   )`,
];

export async function openIndex(dbPath: string): Promise<IndexHandle | null> {
  // Create the parent directory so this works from any caller, not just the
  // extension (which creates it separately). Without this, pointing the index at
  // a fresh home silently fails and looks like "no sessions found".
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch {
    return null;
  }
  const db = await openIndexDb(dbPath);
  if (!db) return null;
  // WAL plus relaxed fsync keeps bulk indexing fast without risking corruption
  // for a rebuildable cache. If the index is lost, it is simply rescanned.
  exec(db, "PRAGMA journal_mode = WAL");
  exec(db, "PRAGMA synchronous = NORMAL");
  for (const sql of SCHEMA) exec(db, sql);
  exec(db, `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`, [
    SCHEMA_VERSION,
  ]);
  // Drop any FTS rows whose session no longer exists. REPLACE on the sessions
  // table allocates a fresh rowid, so orphans accumulate without this sweep.
  exec(
    db,
    "DELETE FROM search WHERE uid NOT IN (SELECT uid FROM sessions)",
  );
  return {
    db,
    close() {
      db.close();
    },
  };
}

/** Run a batch of writes inside one transaction. */
export function transaction(handle: IndexHandle, fn: () => void): void {
  exec(handle.db, "BEGIN");
  try {
    fn();
    exec(handle.db, "COMMIT");
  } catch (err) {
    try {
      exec(handle.db, "ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function indexCount(handle: IndexHandle): number {
  const row = handle.db.get<{ n: number }>("select count(*) as n from sessions");
  return row?.n ?? 0;
}

export function lastIndexedAt(handle: IndexHandle): string | null {
  const row = handle.db.get<{ v: string }>(
    "select value as v from meta where key = 'last_indexed_at'",
  );
  return row?.v ?? null;
}

export function markIndexed(handle: IndexHandle, when: string): void {
  exec(handle.db, "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_indexed_at', ?)", [when]);
}

/** Source fingerprint per file, so unchanged files can be skipped. */
export function sourceFingerprint(
  handle: IndexHandle,
  harness: HarnessId,
  path: string,
): { mtime_ms: number; size: number } | null {
  const row = handle.db.get<{ mtime_ms: number; size: number }>(
    "select mtime_ms, size from sources where harness = ? and path = ?",
    [harness, path],
  );
  return row ?? null;
}

export function setSourceFingerprint(
  handle: IndexHandle,
  harness: HarnessId,
  path: string,
  mtimeMs: number,
  size: number,
): void {
  exec(handle.db,
    "INSERT OR REPLACE INTO sources (harness, path, mtime_ms, size) VALUES (?, ?, ?, ?)",
    [harness, path, mtimeMs, size],
  );
}

/**
 * The text that goes into FTS. Kept deliberately small: title, preview and the
 * session's identifying metadata. Full transcripts are not indexed, which keeps
 * the index tiny and avoids hoarding conversation content on disk.
 */
export function ftsBody(session: ExternalSession): string {
  const parts = [
    session.title ?? "",
    session.preview ?? "",
    session.searchText ?? "",
    session.repo ?? "",
    session.cwd ?? "",
    session.model ?? "",
    session.harness,
    session.nativeId,
  ];
  return parts.filter(Boolean).join("\n");
}

export function upsertSessions(handle: IndexHandle, sessions: ExternalSession[]): void {
  const now = new Date().toISOString();
  for (const s of sessions) {
    exec(handle.db,
      `INSERT OR REPLACE INTO sessions
        (uid, harness, native_id, path, title, created_at, updated_at, cwd, repo, model,
         message_count, tool_count, preview, fidelity, mtime_ms, size, indexed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        s.uid,
        s.harness,
        s.nativeId,
        s.path,
        s.title,
        s.createdAt,
        s.updatedAt,
        s.cwd,
        s.repo,
        s.model,
        s.messageCount,
        s.toolCount,
        s.preview,
        JSON.stringify(s.fidelity),
        s.mtimeMs,
        s.size,
        now,
      ],
    );

    exec(handle.db, "DELETE FROM files WHERE uid = ?", [s.uid]);
    for (const p of s.fidelity.filesChanged ?? []) {
      exec(handle.db, "INSERT INTO files (uid, path, kind) VALUES (?,?,?)", [s.uid, p, "changed"]);
    }
    for (const p of s.fidelity.filesRead ?? []) {
      exec(handle.db, "INSERT INTO files (uid, path, kind) VALUES (?,?,?)", [s.uid, p, "read"]);
    }

    const rowid = handle.db.get<{ rowid: number }>(
      "select rowid from sessions where uid = ?",
      [s.uid],
    )?.rowid;
    if (typeof rowid === "number") {
      // Delete by uid, not just rowid: REPLACE on sessions allocates a new
      // rowid, so a rowid-only delete would leave the previous FTS row behind.
      exec(handle.db, "DELETE FROM search WHERE uid = ?", [s.uid]);
      exec(handle.db, "INSERT INTO search (rowid, uid, title, body) VALUES (?,?,?,?)", [
        rowid,
        s.uid,
        s.title ?? "",
        ftsBody(s),
      ]);
    }
  }
}

export function removeSessions(handle: IndexHandle, uids: string[]): void {
  for (const uid of uids) {
    exec(handle.db, "DELETE FROM search WHERE uid = ?", [uid]);
    exec(handle.db, "DELETE FROM files WHERE uid = ?", [uid]);
    exec(handle.db, "DELETE FROM sessions WHERE uid = ?", [uid]);
  }
}

export function allUids(handle: IndexHandle): string[] {
  return handle.db
    .all<{ uid: string }>("select uid from sessions")
    .map((r) => r.uid);
}

export interface QueryOptions {
  text?: string;
  harness?: HarnessId | null;
  repo?: string | null;
  filePath?: string | null;
  changedOnly?: boolean;
  limit?: number;
}

export function querySessions(
  handle: IndexHandle,
  opts: QueryOptions,
): IndexedSessionRow[] {
  const limit = opts.limit ?? 300;
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.harness) {
    where.push("s.harness = ?");
    params.push(opts.harness);
  }
  if (opts.repo) {
    where.push("s.repo = ?");
    params.push(opts.repo);
  }
  if (opts.filePath) {
    where.push(
      "exists (select 1 from files f where f.uid = s.uid and f.path like ?" +
        (opts.changedOnly ? " and f.kind = 'changed'" : "") +
        ")",
    );
    params.push(`%${opts.filePath}%`);
  }

  const fts = opts.text ? toFtsQuery(opts.text) : null;
  if (fts) {
    where.push("s.rowid in (select rowid from search where search match ?)");
    params.push(fts);
  }

  const sql =
    `select s.* from sessions s` +
    (where.length ? ` where ${where.join(" and ")}` : "") +
    ` order by coalesce(s.updated_at, s.created_at) desc limit ?`;
  params.push(limit);

  return handle.db.all<IndexedSessionRow>(sql, params);
}

export function filesFor(handle: IndexHandle, uid: string): { path: string; kind: string }[] {
  return handle.db.all<{ path: string; kind: string }>(
    "select path, kind from files where uid = ? order by kind, path",
    [uid],
  );
}

export function distinctRepos(handle: IndexHandle): { repo: string; n: number }[] {
  return handle.db.all<{ repo: string; n: number }>(
    `select repo, count(*) as n from sessions
     where repo is not null and repo != ''
     group by repo order by n desc limit 200`,
  );
}

export function harnessCounts(handle: IndexHandle): { harness: HarnessId; n: number }[] {
  return handle.db.all<{ harness: HarnessId; n: number }>(
    "select harness, count(*) as n from sessions group by harness order by n desc",
  );
}

export function rowToSession(row: IndexedSessionRow): ExternalSession {
  let fidelity: ExternalSession["fidelity"];
  try {
    fidelity = JSON.parse(row.fidelity) as ExternalSession["fidelity"];
  } catch {
    fidelity = {
      hasToolCalls: false,
      hasToolResults: false,
      hasReasoning: false,
      filesChanged: null,
      filesRead: null,
      notes: [],
    };
  }
  return {
    uid: row.uid,
    harness: row.harness,
    nativeId: row.native_id,
    path: row.path,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cwd: row.cwd,
    repo: row.repo,
    model: row.model,
    messageCount: row.message_count,
    toolCount: row.tool_count,
    preview: row.preview,
    fidelity,
    mtimeMs: row.mtime_ms,
    size: row.size,
  };
}

export function toDetail(session: ExternalSession, detail: SessionDetail): SessionDetail {
  return { ...session, ...detail };
}

/**
 * Translate user input into an FTS5 MATCH expression.
 *
 * Supports quoted phrases (exact) and `-term` negation. Unquoted terms use
 * prefix matching so partial words match while typing.
 */
export function toFtsQuery(input: string): string | null {
  const positives: string[] = [];
  const negatives: string[] = [];
  const re = /(-?)"([^"]+)"|(-?)(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(input)) !== null) {
    const negative = (match[1] ?? match[3]) === "-";
    const raw = (match[2] ?? match[4] ?? "").trim();
    if (!raw) continue;
    const isPhrase = match[2] !== undefined;
    const cleaned = raw.replace(/["'^*():]/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const expr = isPhrase ? `"${cleaned}"` : `"${cleaned}"*`;
    if (negative) negatives.push(expr);
    else positives.push(expr);
  }

  if (positives.length === 0 && negatives.length === 0) return null;
  // FTS5 NOT is a binary operator, so a bare leading negation is not valid.
  // Without a positive term we fall back to browsing rather than erroring.
  if (positives.length === 0) return null;

  let expr = positives.join(" AND ");
  for (const n of negatives) expr += ` NOT ${n}`;
  return expr;
}
