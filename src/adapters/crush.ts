/**
 * Crush adapter.
 *
 * Source: ~/.crush/crush.db (SQLite, goose-style schema)
 * Tables: sessions / messages / files / read_files
 *
 * This is the highest-fidelity external source in the hub: `files` gives
 * changed paths and `read_files` gives read paths as first-class columns.
 * Crush verifies `crush --session <id>` and `crush --continue`.
 */

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
import { openReadOnly } from "../sqlite.ts";
import {
  addSearchText,
  countTools,
  extractCommand,
  isoFromSec,
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
  message_count: number | null;
  created_at: number | null;
  updated_at: number | null;
}

export class CrushAdapter implements SessionAdapter {
  id = "crush" as const;
  displayName = "Crush";

  private readonly dbPath: string;

  constructor(home: string) {
    this.dbPath = path.join(home, ".crush", "crush.db");
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
    const row = db.get<{ n: number }>("select count(*) as n from sessions");
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
        `select id, title, message_count, created_at, updated_at
         from sessions order by updated_at desc limit ?`,
        [limit],
      );
      const stat = safeStat(this.dbPath);
      return rows.map((r) => this.toSession(db, r, stat));
    } finally {
      db.close();
    }
  }

  async getSession(nativeId: string): Promise<SessionDetail | null> {
    const db = await openReadOnly(this.dbPath);
    if (!db) return null;
    try {
      const row = db.get<SessionRow>(
        `select id, title, message_count, created_at, updated_at
         from sessions where id = ?`,
        [nativeId],
      );
      if (!row) return null;

      const messages: { role: string; text: string }[] = [];
      const toolNames: string[] = [];
      const commands: string[] = [];
      let hasToolResults = false;
      let hasReasoning = false;

      const rows = db.all<{ role: string; parts: string; model: string | null }>(
        `select role, parts, model from messages
         where session_id = ? order by created_at, id limit 4000`,
        [nativeId],
      );
      for (const m of rows) {
        let parts: unknown;
        try {
          parts = JSON.parse(m.parts);
        } catch {
          continue;
        }
        const { text, tools, reasoning, toolResult, command } = extractParts(parts);
        if (reasoning) hasReasoning = true;
        if (toolResult) hasToolResults = true;
        for (const t of tools) toolNames.push(t);
        pushCommand(commands, command);
        const clean = cleanText(text);
        if (clean) messages.push({ role: m.role, text: clip(clean, 4000) });
      }

      const stat = safeStat(this.dbPath);
      const base = this.toSession(db, row, stat);
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
        },
      };
    } finally {
      db.close();
    }
  }

  async buildNativeResume(nativeId: string): Promise<NativeResumeAction | null> {
    return {
      command: "crush",
      args: ["--session", nativeId],
      verificationBasis: "cli-help",
      verified: true,
      verificationNote: "flag documented in `crush --help` (-s, --session)",
      requiresConfirmation: true,
      description: `Continue session ${nativeId.slice(0, 8)} with Crush`,
    };
  }

  private toSession(
    db: ReturnType<typeof openReadOnly> extends Promise<infer T> ? T : never,
    r: SessionRow,
    stat: { mtimeMs: number; size: number } | null,
  ): ExternalSession {
    const modelRow = db.get<{ model: string | null }>(
      "select model from messages where session_id = ? and model is not null and model != '' limit 1",
      [r.id],
    );
    const model = modelRow?.model?.trim() ? modelRow.model.trim() : null;

    const changed = db
      .all<{ path: string }>("select distinct path from files where session_id = ?", [r.id])
      .map((x) => x.path);
    const read = db
      .all<{ path: string }>("select distinct path from read_files where session_id = ?", [r.id])
      .map((x) => x.path);

    // One bounded read of the opening turns: enough for a preview and for the
    // search index to cover the conversation, not just the title.
    const opening = db.all<{ role: string; parts: string }>(
      "select role, parts from messages where session_id = ? order by created_at, id limit 400",
      [r.id],
    );
    let preview: string | null = null;
    const searchAcc: string[] = [];
    for (const m of opening) {
      try {
        const { text } = extractParts(JSON.parse(m.parts));
        const clean = cleanText(text);
        if (!clean) continue;
        addSearchText(searchAcc, m.role, clean);
        if (!preview && m.role === "user") preview = clip(clean, 160);
      } catch {
        /* skip malformed parts */
      }
    }
    if (!preview && opening.length > 0) {
      try {
        const { text } = extractParts(JSON.parse(opening[0].parts));
        const clean = cleanText(text);
        if (clean) preview = clip(clean, 160);
      } catch {
        /* ignore */
      }
    }

    const title = (r.title ?? "").trim();
    return {
      uid: `crush:${r.id}`,
      harness: "crush",
      nativeId: r.id,
      path: this.dbPath,
      title: titleFromPreview(title || preview, `Crush session ${r.id.slice(0, 8)}`),
      createdAt: isoFromSec(r.created_at),
      updatedAt: isoFromSec(r.updated_at),
      // Crush's schema does not record a working directory for sessions.
      cwd: null,
      repo: null,
      model,
      messageCount: r.message_count ?? 0,
      toolCount: 0,
      preview,
      searchText: searchTextFrom(searchAcc),
      fidelity: {
        ...emptyFidelity(["Crush does not record the session working directory"]),
        hasToolCalls: true,
        hasToolResults: true,
        filesChanged: changed.length > 0 ? uniqSorted(changed) : [],
        filesRead: read.length > 0 ? uniqSorted(read) : [],
      },
      mtimeMs: stat?.mtimeMs ?? 0,
      size: stat?.size ?? 0,
    };
  }
}

/**
 * Crush parts look like `[{type:"text", data:{text:"..."}}, ...]`. The payload
 * is nested one level down under `data`, which is easy to get wrong.
 */
function extractParts(parts: unknown): {
  text: string;
  tools: string[];
  reasoning: boolean;
  toolResult: boolean;
  command: string | null;
} {
  const out = {
    text: "",
    tools: [] as string[],
    reasoning: false,
    toolResult: false,
    command: null as string | null,
  };
  if (typeof parts === "string") {
    out.text = parts;
    return out;
  }
  if (!Array.isArray(parts)) return out;
  const texts: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") {
      if (typeof p === "string") texts.push(p);
      continue;
    }
    const block = p as Record<string, unknown>;
    const type = typeof block.type === "string" ? block.type : "";
    const data =
      block.data && typeof block.data === "object"
        ? (block.data as Record<string, unknown>)
        : block;

    if (type === "reasoning" || type === "thinking") out.reasoning = true;
    if (type === "tool_result") {
      out.toolResult = true;
      if (typeof data.name === "string") out.tools.push(data.name);
      // Tool output is intentionally not treated as prose: it is usually a file
      // dump and would swamp both the preview and the search index.
      continue;
    }
    if (type === "tool_call" || type === "tool_use" || type === "tool") {
      const name = data.name ?? data.tool ?? data.toolName;
      if (typeof name === "string") {
        out.tools.push(name);
        out.command = extractCommand(name, data) ?? out.command;
      }
    }
    if (typeof data.text === "string") texts.push(data.text);
    else if (typeof data.content === "string") texts.push(data.content);
  }
  out.text = texts.join("\n");
  return out;
}

function summarize(names: string[]): ToolUseSummary[] {
  const map = countTools(names);
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}
