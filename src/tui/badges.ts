/**
 * Harness visual identity.
 *
 * Icons and theme colour tokens per harness. Colours are always taken from the
 * active Pi theme so the hub matches whatever theme the user has configured.
 */

import type { HarnessId } from "../types.ts";

export interface Badge {
  icon: string;
  /** Theme colour token understood by theme.fg(). */
  color:
    | "accent"
    | "warning"
    | "success"
    | "muted"
    | "error"
    | "mdLink"
    | "mdCode"
    | "mdQuote"
    | "toolTitle";
}

const BADGES: Record<HarnessId, Badge> = {
  pi: { icon: "\u03c0", color: "accent" },
  "claude-code": { icon: "\u273b", color: "warning" },
  codex: { icon: "\u2b21", color: "success" },
  opencode: { icon: "\u2318", color: "mdLink" },
  crush: { icon: "\u276f", color: "mdQuote" },
  jcode: { icon: "\u25c6", color: "mdCode" },
};

export function badgeFor(harness: HarnessId): Badge {
  return BADGES[harness] ?? { icon: "?", color: "muted" };
}

/** Two-letter fallback for terminals without good glyph coverage. */
export function shortLabel(harness: HarnessId): string {
  switch (harness) {
    case "pi":
      return "pi";
    case "claude-code":
      return "cc";
    case "codex":
      return "cx";
    case "opencode":
      return "oc";
    case "crush":
      return "cr";
    case "jcode":
      return "jc";
    default:
      return "??";
  }
}
