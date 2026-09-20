/**
 * JCode adapter.
 *
 * Source: ~/.jcode/sessions/<id>.json (plus imported_<harness>_<hash>.json)
 * Format: a single JSON document per session with a `messages` array whose
 * entries carry typed content blocks (text, tool_use, tool_result, reasoning).
 *
 * JCode is a closed-source binary, so this adapter was written against the
 * on-disk session files it produces, not against any implementation detail of
 * the binary itself. `jcode --resume <id>` is documented in `jcode --help`.
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

const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "apply_patch",
  "notebook_edit",
]);
const READ_TOOLS = new Set(["read", "notebook_read"]);

export class JCodeAdapter implements SessionAdapter {
  id = "jcode" as const;
  displayName = "JCode";

  private readonly root: string;

  constructor(home: string) {
    this.root = path.join(home, ".jcode", "sessions");
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
    // maxDepth 0 keeps us in the sessions root only. Subdirectories such as
    // `edit-stats/` hold per-session statistics with the same filename shape and
    // must not be mistaken for transcripts.
    return walkFiles(this.root, { exts: [".json"], maxDepth: 0, maxFiles: 20000 }).filter(
      (f) => {
        const base = path.basename(f);
        return (
          (base.startsWith("session_") || base.startsWith("imported_")) &&
          !base.endsWith(".bak")
        );
      },
    );
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
      const base = path.basename(file, ".json");
      if (base !== nativeId) continue;
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
      command: "jcode",
      args: ["--resume", nativeId],
      verificationBasis: "cli-help",
      verified: true,
      verificationNote: "flag documented in `jcode --help` (--resume [<RESUME>])",
      requiresConfirmation: true,
      description: `Resume session ${nativeId} with JCode`,
    };
  }

  private parse(file: string, withMessages: boolean): Parsed | null {
    const stat = safeStat(file);
    if (!stat) return null;
    const text = readTextCapped(file);
    if (!text) return null;

    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }

    const nativeId =
      typeof doc.id === "string" && doc.id
        ? doc.id
        : path.basename(file, ".json");

    const cwd = typeof doc.working_dir === "string" ? doc.working_dir : null;
    const title = typeof doc.title === "string" && doc.title.trim() ? doc.title.trim() : null;
    const model = typeof doc.model === "string" ? doc.model : null;
    const providerKey = typeof doc.provider_key === "string" ? doc.provider_key : null;
    const importedFrom = nativeId.startsWith("imported_")
      ? nativeId.split("_")[1] ?? null
      : null;

    const messages: { role: string; text: string }[] = [];
    const searchAcc: string[] = [];
    const toolNames: string[] = [];
    const commands: string[] = [];
    const filesChanged = new Set<string>();
    const filesRead = new Set<string>();
    let hasToolResults = false;
    let hasReasoning = false;
    let messageCount = 0;

    const rawMessages = Array.isArray(doc.messages) ? doc.messages : [];
    for (const m of rawMessages) {
      if (!m || typeof m !== "object") continue;
      const msg = m as Record<string, unknown>;
      const role = typeof msg.role === "string" ? msg.role : "unknown";
      messageCount++;

      const content = msg.content;
      const prose: string[] = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          const t = b.type;
          if (t === "text" && typeof b.text === "string") prose.push(b.text);
          else if (t === "reasoning" || t === "reasoning_trace" || t === "open_a_i_reasoning") {
            hasReasoning = true;
          } else if (t === "tool_use") {
            const name = typeof b.name === "string" ? b.name : "tool";
            toolNames.push(name);
            collectPaths(b.input, name, filesChanged, filesRead);
            pushCommand(commands, extractCommand(name, b.input));
          } else if (t === "tool_result") {
            hasToolResults = true;
          }
        }
      } else if (typeof content === "string") {
        prose.push(content);
      }

      const joined = cleanText(prose.join("\n"));
      if (joined) addSearchText(searchAcc, role, joined);
      if (!withMessages && role === "user" && messages.length >= 3) continue;
      if (joined) messages.push({ role, text: clip(joined, 4000) });
    }

    const preview = messages.find((m) => m.role === "user")?.text ?? null;
    const label = importedFrom
      ? `JCode (imported from ${importedFrom}) session ${nativeId.slice(0, 12)}`
      : `JCode session ${nativeId.slice(0, 12)}`;

    const notes: string[] = [];
    if (importedFrom) {
      notes.push(
        `this session was imported into JCode from ${importedFrom}; the original transcript may have had more detail`,
      );
    }
    if (providerKey) notes.push(`provider: ${providerKey}`);

    return {
      session: {
        uid: `jcode:${nativeId}`,
        harness: "jcode",
        nativeId,
        path: file,
        title: titleFromPreview(title ?? preview, label),
        createdAt: parseIso(doc.created_at),
        updatedAt: parseIso(doc.updated_at) ?? parseIso(doc.created_at),
        cwd,
        repo: deriveRepo(cwd),
        model,
        messageCount,
        toolCount: toolNames.length,
        preview: preview ? clip(preview, 160) : null,
        searchText: searchTextFrom(searchAcc),
        fidelity: {
          ...emptyFidelity(notes),
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

interface Parsed {
  session: ExternalSession;
  messages: { role: string; text: string }[];
  tools: Map<string, number>;
  commands: string[];
}

function collectPaths(
  input: unknown,
  toolName: string,
  changed: Set<string>,
  read: Set<string>,
): void {
  if (!input || typeof input !== "object") return;
  const a = input as Record<string, unknown>;
  const target = toolName.toLowerCase();
  const candidates: string[] = [];
  for (const key of ["file_path", "filePath", "path", "notebook_path", "file"]) {
    const v = a[key];
    if (typeof v === "string" && v) candidates.push(v);
  }
  if (Array.isArray(a.paths)) {
    for (const p of a.paths) if (typeof p === "string" && p) candidates.push(p);
  }
  for (const p of candidates) {
    if (WRITE_TOOLS.has(target)) changed.add(p);
    else if (READ_TOOLS.has(target)) read.add(p);
  }
}

function toSummaries(map: Map<string, number>): ToolUseSummary[] {
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}
