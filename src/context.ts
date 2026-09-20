/**
 * Tiered transcript context.
 *
 * The problem this solves: to continue a session from another harness you need
 * the actual conversation, not a digest. But dumping the whole conversation is
 * wasteful, and the cost grows without bound as the session gets longer.
 *
 * Measured on this machine:
 *   - a 102-message JCode session  = ~41k chars (~10k tokens) of real prose
 *   - a 291-message Pi session     = ~77k chars (~19k tokens), of which 90% of
 *     the raw bytes were tool output
 *
 * So the context is built in tiers with a hard budget, defaulting to ~40k chars
 * (~10k tokens) no matter how long the session is:
 *
 *   tier 1  header        objective, repo, model, files, commands, tool usage
 *   tier 2  recent tail   the last turns IN FULL, because that is what you
 *                         actually continue from
 *   tier 3  earlier       one line per older message, so the shape of the
 *                         conversation survives at a fraction of the cost
 *   tier 4  omitted       a count, never silence
 *
 * Tool results are compressed to a short preview in every tier: they are
 * evidence, not conversation, and they were the single biggest source of waste.
 */

import type { SessionDetail } from "./types.ts";
import { HARNESS_LABEL, fidelityNote } from "./types.ts";
import { clip } from "./security.ts";

export interface TranscriptContextOptions {
  /** Hard ceiling for the whole document, in characters. */
  charBudget?: number;
  /** Portion of the budget spent on the recent tail rendered in full. */
  fullTailChars?: number;
  /** Per-message cap inside the recent tail. */
  perMessageCap?: number;
  /** How much of a tool result to keep. */
  toolPreviewChars?: number;
  /** Characters kept per message in the condensed earlier section. */
  condensedLineChars?: number;
  now?: Date;
}

export interface TranscriptContextResult {
  markdown: string;
  /** Messages rendered in full (tier 2). */
  fullMessages: number;
  /** Messages rendered as one line (tier 3). */
  condensedMessages: number;
  /** Messages dropped entirely (tier 4). */
  omittedMessages: number;
  /** Messages with recoverable text, before budgeting. */
  totalMessages: number;
  /** Every message in the source, including tool-only turns. */
  sourceMessageCount: number;
  chars: number;
  estimatedTokens: number;
  toolResultsCompressed: number;
  /** Convenience: full + condensed, i.e. messages the model can see. */
  includedMessages: number;
}

const DEFAULT_CHAR_BUDGET = 40_000;
const DEFAULT_FULL_TAIL = 26_000;
const DEFAULT_PER_MESSAGE = 4_000;
const DEFAULT_TOOL_PREVIEW = 160;
const DEFAULT_CONDENSED_LINE = 140;

const TOOL_ROLES = new Set(["toolresult", "tool_result", "tool", "function", "tooloutput"]);

function isToolRole(role: string): boolean {
  return TOOL_ROLES.has(role.toLowerCase());
}

export function buildTranscriptContext(
  detail: SessionDetail,
  opts: TranscriptContextOptions = {},
): TranscriptContextResult {
  const charBudget = opts.charBudget ?? DEFAULT_CHAR_BUDGET;
  const fullTailChars = Math.min(
    opts.fullTailChars ?? DEFAULT_FULL_TAIL,
    Math.max(2000, charBudget - 6000),
  );
  const perMessage = opts.perMessageCap ?? DEFAULT_PER_MESSAGE;
  const toolPreview = opts.toolPreviewChars ?? DEFAULT_TOOL_PREVIEW;
  const condensedLine = opts.condensedLineChars ?? DEFAULT_CONDENSED_LINE;

  const header = buildHeader(detail, opts.now ?? new Date());
  const footer = buildFooter(detail);
  const overhead = header.length + footer.length + 1200;
  const bodyBudget = Math.max(3000, charBudget - overhead);

  const messages = detail.messages;
  let toolResultsCompressed = 0;

  // ---- tier 2: the recent tail, in full, newest-first so it always survives.
  let tailBudget = Math.min(fullTailChars, bodyBudget);
  const tail: string[] = [];
  let cursor = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const isTool = isToolRole(m.role);
    if (isTool) toolResultsCompressed++;
    const block = renderFull(m.role, m.text, isTool, perMessage, toolPreview);
    if (block.length + 2 > tailBudget) break;
    tailBudget -= block.length + 2;
    tail.push(block);
    cursor = i;
  }
  tail.reverse();

  // ---- tier 3: older messages as one line each, still newest-first.
  let condensedBudget = Math.max(0, bodyBudget - (fullTailChars - tailBudget));
  const condensed: string[] = [];
  let omitted = 0;
  for (let i = cursor - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isToolRole(m.role)) toolResultsCompressed++;
    const line = renderCondensed(m.role, m.text, condensedLine);
    if (line.length + 1 > condensedBudget) {
      omitted = i + 1;
      break;
    }
    condensedBudget -= line.length + 1;
    condensed.push(line);
  }
  condensed.reverse();

  const parts: string[] = [header, ""];

  if (condensed.length > 0) {
    parts.push(
      "## Earlier in this conversation (condensed)",
      "",
      ...condensed,
      "",
    );
  }
  if (omitted > 0) {
    parts.push(
      `> ${omitted} earlier message(s) are not shown at all. They are in the source`,
      `> transcript at \`${detail.path}\`. Ask for them explicitly if needed.`,
      "",
    );
  }
  parts.push("## Recent conversation (full)", "", ...tail, "", footer);

  const markdown = parts.join("\n");
  const includedMessages = tail.length + condensed.length;

  return {
    markdown,
    fullMessages: tail.length,
    condensedMessages: condensed.length,
    omittedMessages: omitted,
    totalMessages: messages.length,
    sourceMessageCount: detail.messageCount,
    chars: markdown.length,
    estimatedTokens: Math.round(markdown.length / 4),
    toolResultsCompressed,
    includedMessages,
  };
}

function renderFull(
  role: string,
  text: string,
  isTool: boolean,
  perMessage: number,
  toolPreview: number,
): string {
  if (isTool) {
    const head = text.replace(/\s+/g, " ").trim().slice(0, toolPreview);
    const dropped = Math.max(0, text.length - toolPreview);
    const suffix = dropped > 0 ? ` \u2026(+${dropped} chars of tool output omitted)` : "";
    return `[tool result] ${head}${suffix}`;
  }
  return `[${role}] ${clip(text, perMessage)}`;
}

function renderCondensed(role: string, text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const head = flat.slice(0, width);
  const suffix = flat.length > width ? "\u2026" : "";
  return `- [${role}] ${head}${suffix}`;
}

function buildHeader(detail: SessionDetail, now: Date): string {
  const lines: string[] = [
    "# Imported Session Context",
    "",
    `- Source harness: ${HARNESS_LABEL[detail.harness] ?? detail.harness}`,
    `- Source session ID: ${detail.nativeId}`,
    `- Source path: ${detail.path}`,
    `- Project/repository: ${detail.repo ?? detail.cwd ?? "not available"}`,
    `- Model: ${detail.model ?? "not available"}`,
    `- Session started: ${detail.createdAt ?? "not available"}`,
    `- Last activity: ${detail.updatedAt ?? "not available"}`,
    `- Messages in source: ${detail.messageCount} (${detail.messages.length} carry recoverable text)`,
  ];

  const firstUser = detail.messages.find((m) => m.role === "user" && m.text.trim());
  lines.push(
    `- Original objective: ${firstUser ? clip(firstUser.text, 400) : "not available"}`,
  );

  const changed = detail.fidelity.filesChanged;
  const read = detail.fidelity.filesRead;
  lines.push(
    `- Files changed: ${
      changed === null
        ? "not available"
        : changed.length
          ? `${changed.length} (${changed.slice(0, 8).join(", ")}${changed.length > 8 ? ", \u2026" : ""})`
          : "none recorded"
    }`,
  );
  lines.push(
    `- Files read: ${
      read === null
        ? "not available"
        : read.length
          ? `${read.length} (${read.slice(0, 8).join(", ")}${read.length > 8 ? ", \u2026" : ""})`
          : "none recorded"
    }`,
  );
  if (detail.commands.length > 0) {
    lines.push(`- Commands run: ${detail.commands.length}`);
    for (const c of detail.commands.slice(0, 8)) {
      lines.push(`    - \`${c.replace(/`/g, "'")}\``);
    }
  } else {
    lines.push("- Commands run: not available");
  }
  if (detail.tools.length > 0) {
    lines.push(
      `- Tool usage: ${detail.tools.slice(0, 10).map((t) => `${t.name} x${t.count}`).join(", ")}`,
    );
  }

  const fidelity = fidelityNote(detail.fidelity);
  if (fidelity !== "complete") {
    lines.push(`- Fidelity: ${fidelity}`);
  }
  for (const note of detail.fidelity.notes) {
    lines.push(`- Note: ${note}`);
  }
  lines.push(`- Imported at: ${now.toISOString()}`);
  return lines.join("\n");
}

function buildFooter(detail: SessionDetail): string {
  const harness = HARNESS_LABEL[detail.harness] ?? detail.harness;
  return [
    "## How to use this context",
    "",
    `This is an imported reading of a conversation that happened in ${harness}, so work can`,
    "continue here. The recent turns are verbatim; older ones are condensed to one line;",
    "tool output is compressed to short previews. Nothing here was invented, and anything",
    "the source format did not record is marked unavailable.",
    "",
    `Full source transcript: \`${detail.path}\``,
  ].join("\n");
}
