/**
 * Read-only transcript viewer - full-screen.
 *
 * Opened by `v` in the hub, or when the user picks a session that Pi cannot
 * adopt. Same visual language as the hub: box frame, one symbol per harness,
 * theme colours, no emoji.
 */

import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionDetail } from "../types.ts";
import { HARNESS_LABEL, fidelityNote } from "../types.ts";
import { badgeFor } from "./badges.ts";
import type { ThemeLike } from "./hub.ts";

export interface TranscriptOptions {
  detail: SessionDetail;
  theme: ThemeLike;
  requestRender(): void;
  onQuit(): void;
  onHandoff(): void;
  onNative(): void;
}

const TL = "\u250c";
const TR = "\u2510";
const BL = "\u2514";
const BR = "\u2518";
const H = "\u2500";
const V = "\u2502";
const LT = "\u251c";
const RT = "\u2524";
const G_UP = "\u2191";
const G_DOWN = "\u2193";
const G_BAR = "\u258e";
const G_ARROW = "\u25b8";

export class TranscriptView implements Component {
  private readonly detail: SessionDetail;
  private readonly theme: ThemeLike;
  private readonly opts: TranscriptOptions;
  private lines: string[] = [];
  private builtFor = -1;
  private scroll = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(opts: TranscriptOptions) {
    this.opts = opts;
    this.detail = opts.detail;
    this.theme = opts.theme;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
      this.opts.onQuit();
      return;
    }
    if (data === "h") {
      this.opts.onHandoff();
      return;
    }
    if (data === "n") {
      this.opts.onNative();
      return;
    }
    const page = Math.max(1, this.bodyRows() - 2);
    if (matchesKey(data, Key.up) || data === "k") this.scrollBy(-1);
    else if (matchesKey(data, Key.down) || data === "j") this.scrollBy(1);
    else if (matchesKey(data, Key.pageUp) || data === "K") this.scrollBy(-page);
    else if (matchesKey(data, Key.pageDown) || data === "J") this.scrollBy(page);
    else if (data === "g") this.setScroll(0);
    else if (data === "G") this.setScroll(Number.MAX_SAFE_INTEGER);
  }

  private scrollBy(delta: number): void {
    this.setScroll(this.scroll + delta);
  }

  private setScroll(value: number): void {
    const max = Math.max(0, this.lines.length - this.bodyRows());
    this.scroll = Math.max(0, Math.min(value, max));
    this.invalidate();
    this.opts.requestRender();
  }

  private height(): number {
    const rows = process.stdout.rows && process.stdout.rows > 14 ? process.stdout.rows : 30;
    return Math.max(12, rows - 3);
  }

  private bodyRows(): number {
    // frame + meta rows + separators + title + keys
    return Math.max(4, this.height() - 12);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const t = this.theme;
    if (this.builtFor !== width) {
      this.lines = this.buildLines(width);
      this.builtFor = width;
    }

    const d = this.detail;
    const b = badgeFor(d.harness);
    const inner = width - 2;
    const total = this.height();
    const out: string[] = [];

    // Title bar
    const title = ` ${t.fg(b.color, t.bold(`${b.icon} ${HARNESS_LABEL[d.harness]}`))} `;
    const right = t.fg("muted", `${d.messageCount} messages`) + " ";
    const fill = Math.max(0, inner - visibleWidth(title) - visibleWidth(right));
    out.push(t.fg("border", TL) + title + t.fg("border", H.repeat(fill)) + right + t.fg("border", TR));

    const row = (content: string) => t.fg("border", V) + pad(" " + content, inner) + t.fg("border", V);

    out.push(row(t.fg("dim", d.nativeId)));
    const meta = [
      d.updatedAt ? `updated ${d.updatedAt.slice(0, 16).replace("T", " ")}` : null,
      d.repo ?? d.cwd,
      d.model,
      d.toolCount ? `${d.toolCount} tool calls` : null,
    ]
      .filter(Boolean)
      .join(t.fg("dim", `  ${V} `));
    out.push(row(t.fg("muted", meta)));
    out.push(row(t.fg("dim", `store  ${d.path}`)));

    const fidelity = fidelityNote(d.fidelity);
    if (fidelity !== "complete") {
      out.push(row(t.fg("dim", `fidelity  ${fidelity}`)));
    }
    for (const note of d.fidelity.notes.slice(0, 2)) {
      out.push(row(t.fg("dim", `note  ${note}`)));
    }

    out.push(t.fg("border", LT + H.repeat(Math.max(0, inner)) + RT));

    const rows = this.bodyRows();
    const max = Math.max(0, this.lines.length - rows);
    if (this.scroll > max) this.scroll = max;
    const pct = this.lines.length > rows ? Math.round((this.scroll / Math.max(1, max)) * 100) : 100;
    const pos =
      this.lines.length > rows
        ? `${this.scroll + 1}-${Math.min(this.lines.length, this.scroll + rows)}/${this.lines.length}  ${pct}%`
        : `${this.lines.length} lines`;
    out.push(
      t.fg("border", V) +
        pad(
          ` ${t.fg("accent", "TRANSCRIPT")}   ${t.fg("dim", pos)}`,
          inner,
        ) +
        t.fg("border", V),
    );

    const body = this.lines.slice(this.scroll, this.scroll + rows);
    const bodyStart = out.length;
    for (const line of body) {
      out.push(t.fg("border", V) + pad(line, inner) + t.fg("border", V));
    }
    while (out.length < bodyStart + rows) {
      out.push(t.fg("border", V) + pad("", inner) + t.fg("border", V));
    }

    out.push(t.fg("border", LT + H.repeat(Math.max(0, inner)) + RT));
    out.push(
      row(
        [
          [`${G_UP}${G_DOWN}`, "scroll"],
          ["J / K", "page"],
          ["g / G", "top / bottom"],
          ["h", "draft"],
          ["n", "native"],
          ["esc", "back"],
        ]
          .map(([k, label]) => t.fg("accent", k) + t.fg("dim", ` ${label}`))
          .join(t.fg("dim", "   ")),
      ),
    );
    out.push(t.fg("border", BL + H.repeat(Math.max(0, inner)) + BR));

    while (out.length < total) out.push(" ".repeat(width));
    this.cachedLines = out.slice(0, total).map((l) => pad(l, width));
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private buildLines(width: number): string[] {
    const t = this.theme;
    const out: string[] = [];
    const messages = this.detail.messages;

    if (messages.length === 0) {
      out.push(" " + t.fg("warning", "No messages could be recovered from this source."));
      out.push("");
      out.push(" " + t.fg("dim", "The session is indexed, but its transcript could not be read."));
      return out;
    }

    let index = 0;
    for (const m of messages) {
      index++;
      const color = m.role === "user" ? "accent" : m.role === "assistant" ? "text" : "muted";
      out.push(
        " " +
          t.fg(color, G_BAR) +
          " " +
          t.fg("dim", String(index).padStart(4)) +
          " " +
          t.fg(color, m.role) +
          t.fg("dim", `   ${m.text.length} chars`),
      );
      for (const line of wrap(m.text, Math.max(20, width - 9))) {
        out.push("       " + t.fg(m.role === "user" ? "text" : "muted", line));
      }
      out.push("");
    }

    if (this.detail.messageCount > messages.length) {
      out.push(
        " " +
          t.fg("warning", `${G_ARROW} showing ${messages.length} of ${this.detail.messageCount} messages`),
      );
      out.push(
        " " + t.fg("dim", "   The source format or the reader's budget capped this transcript."),
      );
    }
    return out;
  }
}

function pad(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w === width) return text;
  if (w > width) return truncateToWidth(text, width);
  return text + " ".repeat(width - w);
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.replace(/\s+/g, " ").trim().split(" ");
    let current = "";
    for (const word of words) {
      if (current.length === 0) current = word;
      else if (current.length + 1 + word.length <= width) current += " " + word;
      else {
        lines.push(current);
        current = word;
      }
      while (current.length > width) {
        lines.push(current.slice(0, width));
        current = current.slice(width);
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}
