/**
 * Pi adapter.
 *
 * Source: ~/.pi/agent/sessions/--<slug>--/<timestamp>_<uuid>.jsonl
 * Format: JSONL tree, version 3. Header line has type "session".
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
import {
  addSearchText,
  contentToText,
  countTools,
  deriveRepo,
  extractCommand,
  firstPreview,
  isoFromMs,
  parseIso,
  probePath,
  pushCommand,
  pushMessage,
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
  "notebookedit",
  "str_replace_editor",
]);
const READ_TOOLS = new Set(["read", "notebookread"]);

interface Parsed {
  session: ExternalSession;
  messages: { role: string; text: string }[];
  tools: Map<string, number>;
  commands: string[];
  filesChanged: string[];
  filesRead: string[];
  hasToolCalls: boolean;
  hasToolResults: boolean;
  hasReasoning: boolean;
}

export class PiAdapter implements SessionAdapter {
  id = "pi" as const;
  displayName = "Pi";

  private readonly root: string;

  constructor(home: string) {
    this.root = path.join(home, ".pi", "agent", "sessions");
  }

  async detect(): Promise<DetectionResult> {
    const probe = probePath(this.root);
    if (probe === "missing") {
      return { harness: this.id, status: "path_missing", root: this.root, sessionCount: 0 };
    }
    if (probe === "denied") {
      return { harness: this.id, status: "permission_denied", root: this.root, sessionCount: 0 };
    }
    const files = this.files();
    return {
      harness: this.id,
      status: "available",
      root: this.root,
      sessionCount: files.length,
    };
  }

  private files(): string[] {
    return walkFiles(this.root, { exts: [".jsonl"], maxDepth: 3, maxFiles: 20000 });
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
        tools: toToolSummaries(parsed.tools),
        commands: parsed.commands,
      };
    }
    return null;
  }

  async buildNativeResume(nativeId: string): Promise<NativeResumeAction | null> {
    for (const file of this.files()) {
      if (!file.includes(nativeId)) continue;
      return {
        command: "pi",
        args: ["--session", file],
        cwd: path.dirname(file),
        verificationBasis: "cli-help",
        verified: true,
        verificationNote: "flag documented in `pi --help` (--session <path|id>)",
        requiresConfirmation: true,
        description: `Open this Pi session in a new pi process (${path.basename(file)})`,
      };
    }
    return null;
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
    let name: string | null = null;
    let model: string | null = null;

    const messages: { role: string; text: string }[] = [];
    const searchAcc: string[] = [];
    const toolNames: string[] = [];
    const commands: string[] = [];
    const filesChanged = new Set<string>();
    const filesRead = new Set<string>();
    let hasToolResults = false;
    let hasReasoning = false;
    let messageCount = 0;
    let lastTs: string | null = null;

    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = entry.type;
      const ts = parseIso(entry.timestamp);
      if (ts) lastTs = ts;

      if (type === "session") {
        if (typeof entry.id === "string") id = entry.id;
        if (typeof entry.cwd === "string") cwd = entry.cwd;
        if (typeof entry.timestamp === "string") createdAt = parseIso(entry.timestamp);
        continue;
      }
      if (type === "session_info") {
        if (typeof entry.name === "string") name = entry.name;
        continue;
      }
      if (type === "model_change") {
        const m = entry.modelId;
        const p = entry.provider;
        if (typeof m === "string") {
          model = typeof p === "string" ? `${p}/${m}` : m;
        }
        continue;
      }
      if (type !== "message") continue;

      const msg = entry.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const role = typeof msg.role === "string" ? msg.role : "unknown";
      messageCount++;

      if (role === "assistant") {
        if (typeof msg.model === "string" && !model) model = msg.model;
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            if (b.type === "thinking") hasReasoning = true;
            if (b.type === "toolCall" || b.type === "tool_call") {
              const toolName = typeof b.name === "string" ? b.name : "unknown";
              toolNames.push(toolName);
              collectPaths(b.arguments, toolName, filesChanged, filesRead);
              pushCommand(commands, extractCommand(toolName, b.arguments));
            }
          }
        }
      }
      if (role === "toolResult" || role === "tool_result") {
        hasToolResults = true;
        const toolName = typeof msg.toolName === "string" ? msg.toolName : "";
        if (toolName) collectPaths(msg.details, toolName, filesChanged, filesRead);
      }

      const textPart = contentToText(msg.content);
      if (textPart) addSearchText(searchAcc, role, textPart);
      if (withMessages) {
        if (textPart) pushMessage(messages, role, textPart);
      } else if (role === "user" && messages.length < 3) {
        if (textPart) pushMessage(messages, role, textPart, 3);
      }
    }

    if (!id) {
      const base = path.basename(file, ".jsonl");
      const idx = base.indexOf("_");
      id = idx >= 0 ? base.slice(idx + 1) : base;
    }

    const preview = firstPreview(messages);
    const repo = deriveRepo(cwd);
    const fallback = path.basename(path.dirname(file)).replace(/^--|--$/g, "");

    const session: ExternalSession = {
      uid: `pi:${id}`,
      harness: "pi",
      nativeId: id,
      path: file,
      title: name ?? titleFromPreview(preview, fallback || `Pi session ${id.slice(0, 8)}`),
      createdAt: createdAt ?? isoFromMs(stat.mtimeMs),
      updatedAt: lastTs ?? isoFromMs(stat.mtimeMs),
      cwd,
      repo,
      model,
      messageCount,
      toolCount: toolNames.length,
      preview,
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
    };

    return {
      session,
      messages,
      tools: countTools(toolNames),
      commands,
      filesChanged: uniqSorted(filesChanged),
      filesRead: uniqSorted(filesRead),
      hasToolCalls: toolNames.length > 0,
      hasToolResults,
      hasReasoning,
    };
  }
}

function collectPaths(
  args: unknown,
  toolName: string,
  changed: Set<string>,
  read: Set<string>,
): void {
  if (!args || typeof args !== "object") return;
  const a = args as Record<string, unknown>;
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

export function toToolSummaries(map: Map<string, number>): ToolUseSummary[] {
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}
