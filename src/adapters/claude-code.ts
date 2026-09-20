/**
 * Claude Code adapter.
 *
 * Source: ~/.claude/projects/<slug>/<uuid>.jsonl
 * Format: undocumented JSONL. One JSON object per line with a `type` field.
 * Titles come from `ai-title` entries, which Claude Code generates itself.
 *
 * The schema is proprietary and has changed across releases, so every field is
 * read defensively and the parser degrades to filename-derived metadata rather
 * than throwing.
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
  clip,
  cleanText,
} from "../security.ts";
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

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "NotebookRead"]);

interface Parsed {
  session: ExternalSession;
  messages: { role: string; text: string }[];
  tools: Map<string, number>;
  commands: string[];
}

export class ClaudeCodeAdapter implements SessionAdapter {
  id = "claude-code" as const;
  displayName = "Claude Code";

  private readonly root: string;

  constructor(home: string) {
    this.root = path.join(home, ".claude", "projects");
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
      detail:
        this.files().length - this.topLevelFiles().length > 0
          ? `${this.files().length - this.topLevelFiles().length} subagent transcripts included (not resumable by id)`
          : undefined,
    };
  }

  private files(): string[] {
    // Depth 3 reaches <slug>/<uuid>/subagents/*.jsonl as well as the top-level
    // <slug>/*.jsonl sessions.
    return walkFiles(this.root, { exts: [".jsonl"], maxDepth: 3, maxFiles: 20000 });
  }

  /** Top-level sessions only: the ones Claude Code can actually resume by id. */
  private topLevelFiles(): string[] {
    return this.files().filter((f) => !isSubagentPath(f));
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
    // `claude --resume <id>` only accepts top-level session ids. Subagent
    // transcripts have ids that the CLI will not resolve, so we refuse rather
    // than hand the user a command that fails.
    const file = this.files().find((f) => f.includes(nativeId));
    if (file && isSubagentPath(file)) return null;
    return {
      command: "claude",
      args: ["--resume", nativeId],
      verificationBasis: "cli-help",
      verified: true,
      verificationNote: "flag documented in `claude --help` (--resume <session-id>)",
      requiresConfirmation: true,
      description: `Resume session ${nativeId.slice(0, 8)} with Claude Code`,
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
    let aiTitle: string | null = null;
    let agentName: string | null = null;
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

    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const type = e.type;
      if (typeof e.sessionId === "string" && !id) id = e.sessionId;
      if (typeof e.cwd === "string" && !cwd) cwd = e.cwd;
      const ts = parseIso(e.timestamp);
      if (ts) updatedAt = ts;
      if (ts && !createdAt) createdAt = ts;

      if (type === "ai-title") {
        const t = e.title ?? e.aiTitle ?? e.ai_title;
        if (typeof t === "string" && t.trim()) aiTitle = t.trim();
        continue;
      }
      if (type === "agent-name") {
        const n = e.name ?? e.agentName;
        if (typeof n === "string" && n.trim()) agentName = n.trim();
        continue;
      }
      if (type !== "user" && type !== "assistant") continue;

      const msg = e.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const role = typeof msg.role === "string" ? msg.role : type;
      const content = msg.content;

      if (typeof msg.model === "string" && !model) model = msg.model;

      let isToolResultCarrier = false;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result") {
            isToolResultCarrier = true;
            hasToolResults = true;
          }
          if (b.type === "thinking") hasReasoning = true;
          if (b.type === "tool_use") {
            const name = typeof b.name === "string" ? b.name : "unknown";
            toolNames.push(name);
            const input = b.input as Record<string, unknown> | undefined;
            pushCommand(commands, extractCommand(name, input));
            const p = input?.file_path ?? input?.notebook_path ?? input?.path;
            if (typeof p === "string" && p) {
              if (WRITE_TOOLS.has(name)) filesChanged.add(p);
              else if (READ_TOOLS.has(name)) filesRead.add(p);
            }
          }
        }
      }

      if (role === "user" && !isToolResultCarrier) messageCount++;
      if (role === "assistant") messageCount++;

      // Only user/assistant *prose* is preview material. Tool result payloads
      // are enormous and would swamp both the preview and the search index.
      if (!isToolResultCarrier) {
        const t = proseOnly(content);
        if (t) addSearchText(searchAcc, role, t);
        if (t) {
          const clean = clip(cleanText(t), 4000);
          if (clean) {
            if (withMessages) messages.push({ role, text: clean });
            else if (role === "user" && messages.length < 3) {
              messages.push({ role, text: clean });
            }
          }
        }
      }
    }

    if (!id) id = path.basename(file, ".jsonl");

    // Sub-agent transcripts reuse the parent's sessionId, so the id alone would
    // collide across dozens of files. Key them by their own agent file name.
    const isSub = isSubagentPath(file);
    const nativeId = isSub ? path.basename(file, ".jsonl") : id;
    const parentSessionId = isSub ? id : null;

    const firstUser = messages.find((m) => m.role === "user")?.text ?? null;
    const preview = firstUser ? clip(firstUser, 160) : null;
    const fallback = `Claude Code session ${id.slice(0, 8)}`;

    return {
      session: {
        uid: `claude-code:${nativeId}`,
        harness: "claude-code",
        nativeId,
        path: file,
        title: aiTitle ?? agentName ?? titleFromPreview(preview, fallback),
        createdAt: createdAt ?? isoFromMs(stat.mtimeMs),
        updatedAt: updatedAt ?? isoFromMs(stat.mtimeMs),
        cwd,
        repo: deriveRepo(cwd),
        model,
        messageCount,
        toolCount: toolNames.length,
        preview,
        searchText: searchTextFrom(searchAcc),
        fidelity: {
          ...emptyFidelity(
            isSub
              ? [
                  `sub-agent transcript: not resumable with \`claude --resume\``,
                  ...(parentSessionId ? [`parent session: ${parentSessionId}`] : []),
                ]
              : [],
          ),
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

/**
 * Claude Code stores sub-agent transcripts under `<slug>/<uuid>/subagents/`.
 * They are real transcripts worth surfacing, but their ids are not accepted by
 * `claude --resume`.
 */
function isSubagentPath(file: string): boolean {
  return file.split(path.sep).includes("subagents");
}

/** Extract only prose blocks, ignoring tool_use/tool_result/thinking payloads. */
function proseOnly(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "tool_result") continue;
    else if (typeof b.text === "string" && b.type !== "thinking") parts.push(b.text);
  }
  return parts.join("\n");
}

function toSummaries(map: Map<string, number>): ToolUseSummary[] {
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function claudeProjectsRoot(home: string): string {
  return path.join(home, ".claude", "projects");
}
