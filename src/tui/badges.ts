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

/**
 * Symbols were checked against actual font coverage rather than assumed:
 * U+273B (the obvious Claude sparkle), U+2B21 and U+2315 are absent from
 * JetBrainsMono Nerd Font, and would render as tofu boxes. These are present in
 * that font and in the broadly available Geometric Shapes / Misc Technical
 * blocks, so they degrade gracefully on other setups.
 */
const BADGES: Record<HarnessId, Badge> = {
  pi: { icon: "\u03c0", color: "accent" },
  "claude-code": { icon: "\u273b", color: "warning" },
  codex: { icon: "\u2b21", color: "success" },
  opencode: { icon: "\u2318", color: "mdLink" },
  crush: { icon: "\u276f", color: "mdQuote" },
  jcode: { icon: "\u25c6", color: "mdCode" },
};

/**
 * Plain-ASCII markers, for terminals whose font has no Geometric Shapes or Misc
 * Technical coverage. Enabled with PI_SESSION_HUB_ASCII=1 or
 * { "sessionHub": { "ascii": true } }.
 */
const ASCII_BADGES: Record<HarnessId, Badge> = {
  pi: { icon: "P", color: "accent" },
  "claude-code": { icon: "C", color: "warning" },
  codex: { icon: "X", color: "success" },
  opencode: { icon: "O", color: "mdLink" },
  crush: { icon: "R", color: "mdQuote" },
  jcode: { icon: "J", color: "mdCode" },
};

let asciiMode: boolean | null = null;

/** Whether to use plain ASCII markers instead of symbols. */
export function setAsciiMode(on: boolean): void {
  asciiMode = on;
}

export function badgeFor(harness: HarnessId): Badge {
  if (asciiMode === null) {
    asciiMode =
      process.env.PI_SESSION_HUB_ASCII === "1" || process.env.PI_SESSION_HUB_ASCII === "true";
  }
  if (asciiMode) return ASCII_BADGES[harness] ?? { icon: "?", color: "muted" };
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
