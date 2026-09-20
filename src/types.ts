/**
 * Normalized cross-harness session model.
 *
 * Every adapter converts its own on-disk format into these shapes. Nothing here
 * writes to any external harness store: this module is pure data description.
 */

export type HarnessId =
  | "pi"
  | "claude-code"
  | "codex"
  | "opencode"
  | "crush"
  | "jcode";

export const HARNESS_ORDER: HarnessId[] = [
  "pi",
  "claude-code",
  "codex",
  "opencode",
  "crush",
  "jcode",
];

export const HARNESS_LABEL: Record<HarnessId, string> = {
  pi: "Pi",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  crush: "Crush",
  jcode: "JCode",
};

/**
 * What we know about what the source format can and cannot give us.
 *
 * `null` on filesChanged/filesRead means "this source does not expose it",
 * which is different from an empty array ("exposed, and nothing happened").
 * The handoff generator renders those two cases differently and never invents
 * a value it cannot back with evidence.
 */
export interface Fidelity {
  hasToolCalls: boolean;
  hasToolResults: boolean;
  hasReasoning: boolean;
  filesChanged: string[] | null;
  filesRead: string[] | null;
  notes: string[];
}

export interface ExternalSession {
  /** Namespaced stable id: "<harness>:<nativeId>". */
  uid: string;
  harness: HarnessId;
  nativeId: string;
  /** Absolute path to the source file or database. */
  path: string;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  cwd: string | null;
  repo: string | null;
  model: string | null;
  messageCount: number;
  toolCount: number;
  preview: string | null;
  /**
   * Bounded excerpt of the conversation used only to build the search index.
   * Without it, search could only match titles and the opening line, which is
   * not enough to answer "where did we discuss X".
   */
  searchText: string | null;
  fidelity: Fidelity;
  /** Source fingerprint, used for incremental reindexing. */
  mtimeMs: number;
  size: number;
}

export interface PreviewMessage {
  role: string;
  text: string;
}

export interface ToolUseSummary {
  name: string;
  count: number;
}

export interface SessionDetail extends ExternalSession {
  messages: PreviewMessage[];
  tools: ToolUseSummary[];
  /**
   * Shell commands the session ran, extracted from tool inputs where the source
   * format exposes them. Empty means "not exposed", and the handoff renders that
   * as unavailable rather than pretending nothing was run.
   */
  commands: string[];
}

export type DetectionStatus =
  | "available"
  | "not_installed"
  | "path_missing"
  | "permission_denied"
  | "unsupported_version"
  | "error";

export interface DetectionResult {
  harness: HarnessId;
  status: DetectionStatus;
  root: string;
  sessionCount: number;
  detail?: string;
}

export function emptyFidelity(notes: string[] = []): Fidelity {
  return {
    hasToolCalls: false,
    hasToolResults: false,
    hasReasoning: false,
    filesChanged: null,
    filesRead: null,
    notes,
  };
}

/** Human-readable one-liner describing what the source could not provide. */
export function fidelityNote(f: Fidelity): string {
  const missing: string[] = [];
  if (!f.hasToolCalls) missing.push("tool calls");
  if (!f.hasToolResults) missing.push("tool results");
  if (!f.hasReasoning) missing.push("reasoning traces");
  if (f.filesChanged === null) missing.push("changed files");
  if (f.filesRead === null) missing.push("read files");
  if (missing.length === 0) return "complete";
  return "not available: " + missing.join(", ");
}
