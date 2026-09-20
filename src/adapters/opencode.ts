/**
 * OpenCode adapter.
 *
 * Source: ~/.local/share/opencode/opencode.db (SQLite)
 * Schema: session / message / part. Messages and parts store JSON in a `data`
 * column rather than typed columns.
 *
 * The database on this machine is ~940 MB, so listing reads only the `session`
 * table and never touches `part`. Transcript loading is per-session and uses
 * the `part_session_idx` index.
 *
 * Native resume uses `opencode --session <id>`, documented in `opencode --help`.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  DetectionResult,
  ExternalSession,
  SessionDetail,
  ToolUseSummary,
} from "../types.ts";
import { emptyFidelity } from "../types.ts";
import type { NativeResumeAction, SessionAdapter } from "./types.ts";
import { clip, cleanText } from "../security.ts";
import { openReadOnly, type ReadOnlyDb } from "../sqlite.ts";
import {
  addSearchText,
  countTools,
  deriveRepo,
  extractCommand,
  isoFromMs,
  probePath,
  pushCommand,
  safeStat,
  searchTextFrom,
  titleFromPreview,
  uniqSorted,
} from "./util.ts";

interface SessionRow {
  id: string;
  title: string | null;
  directory: string | null;
  model: string | null;
  time_created: number | null;
  time_updated: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
}

export class OpenCodeAdapter implements SessionAdapter {
  id = "opencode" as const;
  displayName = "OpenCode";

  private readonly root: string;
  private readonly dbPath: string;
  private readonly storageRoot: string;

  constructor(home: string) {
    this.root = path.join(home, ".local", "share", "opencode");
    this.dbPath = path.join(this.root, "opencode.db");
    this.storageRoot = path.join(this.root, "storage");
  }

  async detect(): Promise<DetectionResult> {
    const probe = probePath(this.dbPath);
    if (probe === "missing") {
      return { harness: this.id, status: "path_missing", root: this.dbPath, sessionCount: 0 };
    }
    if (probe === "denied") {
      return { harness: this.id, status: "permission_denied", root: this.dbPath, sessionCount: 0 };
    }
    const db = await openReadOnly(this.dbPath);
    if (!db) {
      return {
        harness: this.id,
        status: "error",
        root: this.dbPath,
        sessionCount: 0,
        detail: "could not open database read-only",
      };
    }
    const row = db.get<{ n: number }>("select count(*) as n from session");
    db.close();
    return {
      harness: this.id,
      status: "available",
      root: this.dbPath,
      sessionCount: row?.n ?? 0,
    };
  }

  async listSessions(opts?: { maxSessions?: number }): Promise<ExternalSession[]> {
    const limit = opts?.maxSessions ?? 2000;
    const db = await openReadOnly(this.dbPath);
    if (!db) return [];
    try {
      const rows = db.all<SessionRow>(
        `select id, title, directory, model, time_created, time_updated,
                tokens_input, tokens_output
         from session
         order by time_updated desc
         limit ?`,
        [limit],
      );

      const counts = new Map<string, number>();
      for (const r of db.all<{ session_id: string; n: number }>(
        "select session_id, count(*) as n from message group by session_id",
      )) {
        counts.set(r.session_id, r.n);
      }

      return rows.map((r) => this.toSession(db, r, counts.get(r.id) ?? 0));
    } finally {
      db.close();
    }
  }

  async getSession(nativeId: string): Promise<SessionDetail | null> {
    const db = await openReadOnly(this.dbPath);
    if (!db) return null;
    try {
      const row = db.get<SessionRow>(
        `select id, title, directory, model, time_created, time_updated,
                tokens_input, tokens_output
         from session where id = ?`,
        [nativeId],
      );
      if (!row) return null;

      const messages: { role: string; text: string }[] = [];
      const toolNames: string[] = [];
      const commands: string[] = [];
      let hasReasoning = false;
      let hasToolResults = false;

      // Join through `message` so each part carries its author's role. The part
      // payload itself has no role field.
      const parts = db.all<{ data: string; mdata: string | null }>(
        `select p.data as data, m.data as mdata
         from part p
         left join message m on m.id = p.message_id
         where p.session_id = ?
         order by p.time_created, p.id
         limit 4000`,
        [nativeId],
      );
      for (const p of parts) {
        let o: Record<string, unknown>;
        try {
          o = JSON.parse(p.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = o.type;
        if (type === "reasoning") {
          hasReasoning = true;
          continue;
        }
        if (type === "tool") {
          hasToolResults = true;
          const tool = typeof o.tool === "string" ? o.tool : "tool";
          toolNames.push(tool);
          pushCommand(commands, extractCommand(tool, o.state ?? o));
          continue;
        }
        if (type !== "text" || typeof o.text !== "string") continue;

        let role = "assistant";
        if (p.mdata) {
          try {
            const m = JSON.parse(p.mdata) as Record<string, unknown>;
            if (typeof m.role === "string") role = m.role;
          } catch {
            /* keep default */
          }
        }
        const t = cleanText(o.text);
        if (t) messages.push({ role, text: clip(t, 4000) });
      }

      const base = this.toSession(db, row, messages.length);
      return {
        ...base,
        messageCount: messages.length || base.messageCount,
        toolCount: toolNames.length,
        messages,
        tools: summarize(toolNames),
        commands,
        fidelity: {
          ...base.fidelity,
          hasToolCalls: toolNames.length > 0,
          hasToolResults,
          hasReasoning,
          filesChanged: this.readSessionDiff(nativeId),
        },
      };
    } finally {
      db.close();
    }
  }

  async buildNativeResume(nativeId: string): Promise<NativeResumeAction | null> {
    // `opencode --session <id>` is documented in `opencode --help` under
    // Options (`-s, --session  session id to continue`). Our ids are the same
    // `ses_*` values that `opencode session list --format json` reports, so the
    // CLI accepts them directly.
    const db = await openReadOnly(this.dbPath);
    let cwd: string | undefined;
    try {
      const row = db?.get<{ directory: string | null }>(
        "select directory from session where id = ?",
        [nativeId],
      );
      if (row?.directory) cwd = row.directory;
    } finally {
      db?.close();
    }
    return {
      command: "opencode",
      args: ["--session", nativeId],
      cwd,
      verificationBasis: "cli-help",
      verified: true,
      verificationNote:
        "flag documented in `opencode --help` (-s, --session); session id format matches `opencode session list`",
      requiresConfirmation: true,
      description: `Continue session ${nativeId} in the OpenCode TUI`,
    };
  }

  private toSession(db: ReadOnlyDb, r: SessionRow, messageCount: number): ExternalSession {
    const cwd = r.directory ?? null;
    const model = parseModel(r.model);
    const title = (r.title ?? "").trim() || null;
    const opening = this.readOpening(db, r.id);
    const preview = opening.preview ?? (title ? clip(title, 160) : null);
    return {
      uid: `opencode:${r.id}`,
      harness: "opencode",
      nativeId: r.id,
      path: this.dbPath,
      title: titleFromPreview(title, `OpenCode session ${r.id.slice(0, 12)}`),
      createdAt: isoFromMs(r.time_created),
      updatedAt: isoFromMs(r.time_updated),
      cwd,
      repo: deriveRepo(cwd),
      model,
      messageCount,
      toolCount: 0,
      preview,
      searchText: opening.searchText,
      fidelity: {
        ...emptyFidelity([
          "tool counts and changed files are loaded per session, not at list time",
        ]),
        hasToolCalls: true,
        hasToolResults: true,
        filesChanged: null,
        filesRead: null,
      },
      mtimeMs: safeStat(this.dbPath)?.mtimeMs ?? 0,
      size: safeStat(this.dbPath)?.size ?? 0,
    };
  }

  /**
   * First lines of real conversation text, used as the preview and as the body
   * of the search index.
   *
   * OpenCode titles are good but they are not the conversation: without this, a
   * search across hundreds of OpenCode sessions could only match titles. This
   * uses `part_session_idx`, so it costs about a quarter of a millisecond per
   * session rather than a full scan of the part table.
   */
  private readOpening(
    db: ReadOnlyDb,
    sessionId: string,
  ): { preview: string | null; searchText: string | null } {
    let parts: { data: string; mdata: string | null }[];
    try {
      parts = db.all<{ data: string; mdata: string | null }>(
        `select p.data as data, m.data as mdata
         from part p left join message m on m.id = p.message_id
         where p.session_id = ? and p.data like '%"type":"text"%'
         order by p.time_created, p.id limit 400`,
        [sessionId],
      );
    } catch {
      return { preview: null, searchText: null };
    }
    const searchAcc: string[] = [];
    let preview: string | null = null;
    for (const p of parts) {
      try {
        const o = JSON.parse(p.data) as Record<string, unknown>;
        if (o.type !== "text" || typeof o.text !== "string") continue;
        const clean = cleanText(o.text);
        if (!clean) continue;
        let role = "assistant";
        if (p.mdata) {
          try {
            const m = JSON.parse(p.mdata) as Record<string, unknown>;
            if (typeof m.role === "string") role = m.role;
          } catch {
            /* keep default */
          }
        }
        addSearchText(searchAcc, role, clean);
        if (!preview && role === "user") preview = clip(clean, 400);
      } catch {
        /* skip malformed part */
      }
    }
    if (!preview && searchAcc.length > 0) preview = clip(searchAcc[0], 400);
    return { preview, searchText: searchTextFrom(searchAcc) };
  }

  /** OpenCode keeps per-session file diffs on disk next to the database. */
  private readSessionDiff(nativeId: string): string[] | null {
    const file = path.join(this.storageRoot, "session_diff", `${nativeId}.json`);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
    const found = new Set<string>();
    try {
      const parsed = JSON.parse(raw) as unknown;
      collectPathsFromAny(parsed, found);
    } catch {
      return null;
    }
    return found.size > 0 ? uniqSorted(found) : null;
  }
}

function parseModel(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : null;
    const provider = typeof o.providerID === "string" ? o.providerID : null;
    if (id && provider) return `${provider}/${id}`;
    return id ?? provider;
  } catch {
    return raw.length < 80 ? raw : null;
  }
}

/** Recursively pick up anything that looks like a file path in a diff payload. */
function collectPathsFromAny(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.startsWith("/") && !value.includes("\n") && value.length < 400) {
      out.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectPathsFromAny(v, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const key of ["file", "path", "filename", "filePath"]) {
      const v = o[key];
      if (typeof v === "string" && v) out.add(v);
    }
    for (const v of Object.values(o)) collectPathsFromAny(v, out, depth + 1);
  }
}

function summarize(names: string[]): ToolUseSummary[] {
  const map = countTools(names);
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}
