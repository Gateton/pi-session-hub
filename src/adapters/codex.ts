/**
 * Codex adapter.
 *
 * Source: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * Format: undocumented JSONL with `type` + `payload`. Session metadata lives in
 * the `session_meta` record; model comes from `turn_context`; conversation
 * messages are `response_item` records with `payload.type === "message"`.
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
import {
  addSearchText,
  countTools,
  deriveRepo,
  extractCommand,
  isoFromMs,
  parseIso,
  probePath,
  pushCommand,
  readTextCapped,
  safeStat,
  searchTextFrom,
  titleFromPreview,
  uniqSorted,
  walkFiles,
} from "./util.ts";

interface Parsed {
  session: ExternalSession;
  messages: { role: string; text: string }[];
  tools: Map<string, number>;
  commands: string[];
}

export class CodexAdapter implements SessionAdapter {
  id = "codex" as const;
  displayName = "Codex";

  private readonly root: string;

  constructor(home: string) {
    this.root = path.join(home, ".codex", "sessions");
  }

  async detect(): Promise<DetectionResult> {
    const probe = probePath(this.root);
    if (probe === "missing") {
      return { harness: this.id, status: "path_missing", root: this.root, sessionCount: 0 };
    }
    if (probe === "denied") {
      return { harness: this.id, status: "permission_denied", root: this.root, sessionCount: 0 };
    }
    return {
      harness: this.id,
      status: "available",
      root: this.root,
      sessionCount: this.files().length,
    };
  }

  private files(): string[] {
    return walkFiles(this.root, { exts: [".jsonl"], maxDepth: 5, maxFiles: 20000 });
  }

  async listSessions(opts?: { maxSessions?: number }): Promise<ExternalSession[]> {
    const limit = opts?.maxSessions ?? 5000;
    const out: ExternalSession[] = [];
    for (const file of this.files()) {
      if (out.length >= limit) break;
      const parsed = this.parse(file, false);
      if (parsed) out.push(parsed.session);
    }
    return out;
  }

  async getSession(nativeId: string): Promise<SessionDetail | null> {
    for (const file of this.files()) {
      if (!file.includes(nativeId)) continue;
      const parsed = this.parse(file, true);
      if (!parsed) continue;
      return {
        ...parsed.session,
        messages: parsed.messages,
        tools: toSummaries(parsed.tools),
        commands: parsed.commands,
      };
    }
    return null;
  }

  async buildNativeResume(nativeId: string): Promise<NativeResumeAction | null> {
    return {
      command: "codex",
      args: ["resume", nativeId],
      verificationBasis: "cli-help",
      verified: true,
      verificationNote: "subcommand documented in `codex resume --help`",
      requiresConfirmation: true,
      description: `Resume session ${nativeId.slice(0, 8)} with Codex`,
    };
  }

  private parse(file: string, withMessages: boolean): Parsed | null {
    const stat = safeStat(file);
    if (!stat) return null;
    const text = readTextCapped(file);
    if (!text) return null;

    let id: string | null = null;
    let cwd: string | null = null;
    let createdAt: string | null = null;
    let updatedAt: string | null = null;
    let model: string | null = null;
    let cliVersion: string | null = null;

    const messages: { role: string; text: string }[] = [];
    const searchAcc: string[] = [];
    const toolNames: string[] = [];
    const commands: string[] = [];
    const filesChanged = new Set<string>();
    const filesRead = new Set<string>();
    let hasToolResults = false;
    let hasReasoning = false;
    let messageCount = 0;

    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const ts = parseIso(e.timestamp);
      if (ts) updatedAt = ts;
      const type = e.type;
      const payload = (e.payload ?? {}) as Record<string, unknown>;

      if (type === "session_meta") {
        const sid = payload.session_id ?? payload.id;
        if (typeof sid === "string") id = sid;
        if (typeof payload.cwd === "string") cwd = payload.cwd;
        if (typeof payload.cli_version === "string") cliVersion = payload.cli_version;
        if (typeof payload.timestamp === "string") createdAt = parseIso(payload.timestamp);
        continue;
      }
      if (type === "turn_context") {
        if (typeof payload.model === "string") model = payload.model;
        if (typeof payload.cwd === "string" && !cwd) cwd = payload.cwd;
        continue;
      }
      if (type !== "response_item") continue;

      const ptype = payload.type;
      if (ptype === "reasoning") {
        hasReasoning = true;
        continue;
      }
      if (ptype === "custom_tool_call" || ptype === "function_call") {
        const name = typeof payload.name === "string" ? payload.name : "tool";
        toolNames.push(name);
        const rawArgs = payload.arguments ?? payload.input;
        collectPaths(rawArgs, filesChanged, filesRead);
        pushCommand(commands, extractCommand(name, rawArgs));
        continue;
      }
      if (ptype === "custom_tool_call_output" || ptype === "function_call_output") {
        hasToolResults = true;
        continue;
      }
      if (ptype !== "message") continue;

      const role = typeof payload.role === "string" ? payload.role : "";
      if (role !== "user" && role !== "assistant") continue;
      const prose = proseOnly(payload.content);
      if (!prose) continue;
      addSearchText(searchAcc, role, prose);
      messageCount++;

      // Boilerplate-only turns (environment_context, skills_instructions) clean
      // down to an empty string. Keep them out of the preview and search body.
      const clean = clip(cleanText(prose), 4000);
      if (!clean) continue;

      if (withMessages) {
        messages.push({ role, text: clean });
      } else if (role === "user" && messages.length < 3) {
        messages.push({ role, text: clean });
      }
    }

    if (!id) {
      const m = /rollout-.*?-([0-9a-f-]{36})\.jsonl$/.exec(path.basename(file));
      id = m ? m[1] : path.basename(file, ".jsonl");
    }

    const preview = messages.find((m) => m.role === "user")?.text ?? null;
    const fallback = `Codex session ${id.slice(0, 8)}`;

    return {
      session: {
        uid: `codex:${id}`,
        harness: "codex",
        nativeId: id,
        path: file,
        title: titleFromPreview(preview ? clip(preview, 160) : null, fallback),
        createdAt: createdAt ?? isoFromMs(stat.mtimeMs),
        updatedAt: updatedAt ?? isoFromMs(stat.mtimeMs),
        cwd,
        repo: deriveRepo(cwd),
        model,
        messageCount,
        toolCount: toolNames.length,
        preview: preview ? clip(preview, 160) : null,
        searchText: searchTextFrom(searchAcc),
        fidelity: {
          ...emptyFidelity(),
          hasToolCalls: toolNames.length > 0,
          hasToolResults,
          hasReasoning,
          filesChanged: uniqSorted(filesChanged),
          filesRead: uniqSorted(filesRead),
        },
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      },
      messages,
      tools: countTools(toolNames),
      commands,
    };
  }
}

function proseOnly(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const t = b.type;
    if (t === "input_text" || t === "output_text" || t === "text") {
      if (typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/**
 * Codex tool arguments are usually a JSON string. Pull out file paths when the
 * shape matches; otherwise record nothing rather than guessing.
 */
function collectPaths(
  args: unknown,
  changed: Set<string>,
  read: Set<string>,
): void {
  let parsed: unknown = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      return;
    }
  }
  if (!parsed || typeof parsed !== "object") return;
  const a = parsed as Record<string, unknown>;
  const cmd = typeof a.command === "string" ? a.command : "";
  const paths: string[] = [];
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = a[key];
    if (typeof v === "string" && v) paths.push(v);
  }
  for (const p of paths) {
    if (/\b(read|cat|open)\b/.test(cmd)) read.add(p);
    else changed.add(p);
  }
}

function toSummaries(map: Map<string, number>): ToolUseSummary[] {
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}
