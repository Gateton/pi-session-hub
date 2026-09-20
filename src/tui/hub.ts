/**
 * Session Hub TUI - full-screen.
 *
 * Rendered as a replacement UI (not an overlay), so it owns the terminal instead
 * of floating over the chat. Pi still draws its own footer, so the layout leaves
 * a few rows at the bottom for it.
 *
 * Visual language: box-drawing frame, one Unicode symbol per harness, and theme
 * colours for everything. No emoji, so it renders identically in any font.
 */

import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DetectionResult, ExternalSession, HarnessId, SessionDetail } from "../types.ts";
import { HARNESS_LABEL, HARNESS_ORDER, fidelityNote } from "../types.ts";
import { badgeFor, shortLabel } from "./badges.ts";

export interface ThemeLike {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold(text: string): string;
}

export type Focus = "list" | "detail";
export type Mode = "browse" | "search" | "file";

export interface HubCallbacks {
  onHandoff(session: ExternalSession): void;
  onNative(session: ExternalSession): void;
  onOpen(session: ExternalSession): void;
  onView(session: ExternalSession): void;
  onSwitch(session: ExternalSession): void;
  onReindex(): void;
  onQuit(): void;
  loadDetail(session: ExternalSession): Promise<SessionDetail | null>;
}

export interface HubOptions {
  sessions: ExternalSession[];
  detections: DetectionResult[];
  repos: string[];
  callbacks: HubCallbacks;
  theme: ThemeLike;
  requestRender(): void;
  initialHarness?: HarnessId | null;
}

// Frame glyphs
const TL = "\u250c";
const TR = "\u2510";
const BL = "\u2514";
const BR = "\u2518";
const H = "\u2500";
const V = "\u2502";
const LT = "\u251c";
const RT = "\u2524";
const TT = "\u252c";
const BT = "\u2534";
const CROSS = "\u253c";

// Interface glyphs (symbols, not emoji)
const G_SEARCH = "\u25ce";
const G_ENTER = "\u23ce";
const G_TAB = "\u21e5";
const G_UP = "\u2191";
const G_DOWN = "\u2193";
const G_ARROW = "\u25b8";
const G_BAR = "\u258e";
const G_WARN = "\u25b2";
const G_INFO = "\u25cf";

export class HubComponent implements Component {
  private readonly opts: HubOptions;
  private readonly theme: ThemeLike;
  private readonly callbacks: HubCallbacks;

  private sessions: ExternalSession[];
  private filtered: ExternalSession[];
  private selected = 0;
  private offset = 0;
  private focus: Focus = "list";
  private mode: Mode = "browse";
  private query = "";
  private fileQuery = "";
  private harness: HarnessId | null;
  private repo: string | null = null;
  private status: string | null = null;
  private showHelp = false;
  private detailCache = new Map<string, SessionDetail | null>();
  private detailLoading = new Set<string>();
  private transcriptCache = new Map<string, string[]>();
  private detailScroll = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private repos: string[];

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.theme = opts.theme;
    this.callbacks = opts.callbacks;
    this.sessions = opts.sessions;
    this.filtered = opts.sessions;
    this.harness = opts.initialHarness ?? null;
    this.repos = opts.repos;
    this.applyFilter();
  }

  // ---------------------------------------------------------------- data

  setSessions(sessions: ExternalSession[]): void {
    this.sessions = sessions;
    this.detailCache.clear();
    this.transcriptCache.clear();
    this.detailScroll = 0;
    this.applyFilter();
    this.invalidate();
  }

  setStatus(message: string | null): void {
    this.status = message;
    this.invalidate();
  }

  setDetections(detections: DetectionResult[]): void {
    this.opts.detections = detections;
    this.invalidate();
  }

  get current(): ExternalSession | null {
    return this.filtered[this.selected] ?? null;
  }

  /** Kick off loading the transcript for the current selection. */
  primeDetail(): void {
    this.ensureDetail();
  }

  private applyFilter(): void {
    const q = this.query.trim().toLowerCase();
    const f = this.fileQuery.trim().toLowerCase();
    this.filtered = this.sessions.filter((s) => {
      if (this.harness && s.harness !== this.harness) return false;
      if (this.repo && s.repo !== this.repo) return false;
      if (f) {
        const inFiles =
          (s.fidelity.filesChanged ?? []).some((p) => p.toLowerCase().includes(f)) ||
          (s.fidelity.filesRead ?? []).some((p) => p.toLowerCase().includes(f));
        if (!inFiles) return false;
      }
      if (!q) return true;
      const haystack = [
        s.title ?? "",
        s.preview ?? "",
        s.repo ?? "",
        s.cwd ?? "",
        s.model ?? "",
        s.harness,
        s.nativeId,
        HARNESS_LABEL[s.harness] ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return q.split(/\s+/).every((token) => haystack.includes(token));
    });
    if (this.selected >= this.filtered.length) {
      this.selected = Math.max(0, this.filtered.length - 1);
    }
    this.clampOffset();
  }

  private clampOffset(): void {
    const rows = this.listRows();
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + rows) this.offset = this.selected - rows + 1;
    if (this.offset < 0) this.offset = 0;
  }

  // ------------------------------------------------------------- input

  handleInput(data: string): void {
    if (this.showHelp) {
      if (
        data === "?" ||
        matchesKey(data, Key.escape) ||
        data === "q" ||
        matchesKey(data, Key.enter)
      ) {
        this.showHelp = false;
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.escape) || data === "q") {
      if (this.mode !== "browse") {
        this.mode = "browse";
        this.query = this.query;
        this.invalidate();
        return;
      }
      this.callbacks.onQuit();
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      this.callbacks.onQuit();
      return;
    }
    if (data === "?") {
      this.showHelp = true;
      this.invalidate();
      return;
    }

    if (this.mode === "search") {
      this.handleTextInput(data, "query");
      return;
    }
    if (this.mode === "file") {
      this.handleTextInput(data, "file");
      return;
    }

    if (matchesKey(data, Key.up) || data === "k") return this.move(-1);
    if (matchesKey(data, Key.down) || data === "j") return this.move(1);
    if (matchesKey(data, Key.pageUp)) return this.move(-this.listRows());
    if (matchesKey(data, Key.pageDown)) return this.move(this.listRows());
    if (matchesKey(data, Key.home)) {
      this.selected = 0;
      this.clampOffset();
      this.ensureDetail();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.selected = Math.max(0, this.filtered.length - 1);
      this.clampOffset();
      this.ensureDetail();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.focus = this.focus === "list" ? "detail" : "list";
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const s = this.current;
      if (s) this.callbacks.onOpen(s);
      return;
    }
    if (data === "/") {
      this.mode = "search";
      this.invalidate();
      return;
    }
    if (data === "f") {
      this.mode = "file";
      this.invalidate();
      return;
    }
    if (data === "v") {
      const s = this.current;
      if (s) this.callbacks.onView(s);
      return;
    }
    if (data === "o") {
      const s = this.current;
      if (s) this.callbacks.onSwitch(s);
      return;
    }
    if (data === "h") {
      const s = this.current;
      if (s) this.callbacks.onHandoff(s);
      return;
    }
    if (data === "n") {
      const s = this.current;
      if (s) this.callbacks.onNative(s);
      return;
    }
    if (data === "r") {
      this.callbacks.onReindex();
      return;
    }
    if (data === "p") return this.cycleRepo();
    if (data === "0") return this.refilter(null);
    const digit = Number.parseInt(data, 10);
    if (!Number.isNaN(digit) && digit >= 1 && digit <= HARNESS_ORDER.length) {
      return this.refilter(HARNESS_ORDER[digit - 1] ?? null);
    }
    if (this.focus === "detail") {
      if (data === "K") this.detailScroll = Math.max(0, this.detailScroll - 3);
      else if (data === "J") this.detailScroll += 3;
      else return;
      this.invalidate();
    }
  }

  private handleTextInput(data: string, which: "query" | "file"): void {
    if (matchesKey(data, Key.enter)) {
      this.mode = "browse";
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      if (which === "query") this.query = this.query.slice(0, -1);
      else this.fileQuery = this.fileQuery.slice(0, -1);
      this.selected = 0;
      this.applyFilter();
      this.invalidate();
      return;
    }
    if (data.length === 1 && data >= " ") {
      if (which === "query") this.query += data;
      else this.fileQuery += data;
      this.selected = 0;
      this.offset = 0;
      this.detailScroll = 0;
      this.applyFilter();
      this.ensureDetail();
      this.invalidate();
    }
  }

  private move(delta: number): void {
    if (this.focus === "detail") {
      this.detailScroll = Math.max(0, this.detailScroll + delta * 2);
      this.invalidate();
      return;
    }
    if (this.filtered.length === 0) return;
    const next = this.selected + delta;
    if (next < 0 || next >= this.filtered.length) return;
    this.selected = next;
    this.clampOffset();
    this.ensureDetail();
    this.detailScroll = 0;
    this.invalidate();
  }

  /**
   * Apply a filter change and refresh the detail pane.
   *
   * Forgetting the detail refresh was a real defect: changing the harness or repo
   * filter left the transcript pane showing "no messages recovered" until the
   * user happened to press an arrow key.
   */
  private refilter(harness: HarnessId | null): void {
    this.harness = harness;
    this.selected = 0;
    this.offset = 0;
    this.detailScroll = 0;
    this.applyFilter();
    this.ensureDetail();
    this.invalidate();
  }

  private cycleRepo(): void {
    if (this.repos.length === 0) return;
    const idx = this.repo ? this.repos.indexOf(this.repo) : -1;
    const next = idx + 1;
    this.repo = next >= this.repos.length ? null : (this.repos[next] ?? null);
    this.refilter(this.harness);
  }

  private ensureDetail(): void {
    const s = this.current;
    if (!s) return;
    if (this.detailCache.has(s.uid) || this.detailLoading.has(s.uid)) return;
    this.detailLoading.add(s.uid);
    this.callbacks
      .loadDetail(s)
      .then((detail) => this.detailCache.set(s.uid, detail))
      .catch(() => this.detailCache.set(s.uid, null))
      .finally(() => {
        this.detailLoading.delete(s.uid);
        this.invalidate();
        this.opts.requestRender();
      });
  }

  // ------------------------------------------------------------ geometry

  /**
   * Total lines to emit. Pi draws its own footer below the replacement UI, so a
   * few rows are reserved rather than being drawn over.
   */
  private height(): number {
    const rows = process.stdout.rows && process.stdout.rows > 14 ? process.stdout.rows : 30;
    return Math.max(12, rows - 3);
  }

  private bodyRows(): number {
    // top + search + sep + ... + sep + legend + keys + bottom
    return Math.max(4, this.height() - 7);
  }

  private listRows(): number {
    // each entry is 2 lines
    return Math.max(1, Math.floor(this.bodyRows() / 2));
  }

  // ------------------------------------------------------------ render

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const t = this.theme;
    const total = this.height();

    if (this.showHelp) {
      this.cachedLines = this.renderHelp(width, total).map((l) => pad(l, width));
      this.cachedWidth = width;
      return this.cachedLines;
    }

    const lines: string[] = [];
    lines.push(this.frameTop(width));
    lines.push(this.searchBar(width));
    lines.push(sep(width, LT, RT, H));

    const wide = width >= 96;
    const leftWidth = wide ? Math.max(44, Math.floor(width * 0.46)) : width - 2;
    const rightWidth = wide ? width - leftWidth - 3 : 0;

    const body = this.bodyRows();
    const left = this.renderList(leftWidth, body);
    const right = wide ? this.renderDetail(rightWidth, body) : [];

    for (let i = 0; i < body; i++) {
      const l = left[i] ?? "";
      if (wide) {
        lines.push(
          t.fg("border", V) + pad(l, leftWidth) + t.fg("border", V) + pad(right[i] ?? "", rightWidth) + t.fg("border", V),
        );
      } else {
        lines.push(t.fg("border", V) + pad(l, leftWidth) + t.fg("border", V));
      }
    }

    lines.push(sep(width, LT, RT, H));
    lines.push(t.fg("border", V) + pad(this.legend(width - 2), width - 2) + t.fg("border", V));
    lines.push(t.fg("border", V) + pad(this.keyBar(width - 2), width - 2) + t.fg("border", V));
    lines.push(t.fg("border", BL + H.repeat(Math.max(0, width - 2)) + BR));

    while (lines.length < total) lines.push(" ".repeat(width));
    this.cachedLines = lines.slice(0, total).map((l) => pad(l, width));
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private frameTop(width: number): string {
    const t = this.theme;
    const title = ` ${t.fg("accent", t.bold("SESSION HUB"))} `;
    const shown = this.filtered.length;
    const all = this.sessions.length;
    const count = shown === all ? `${all} sessions` : `${shown} / ${all} sessions`;
    const right =
      (this.status ? t.fg("dim", ` ${this.status} `) + t.fg("border", V) : "") +
      t.fg("muted", ` ${count} `);
    const inner = width - 2;
    const titleW = visibleWidth(title);
    const rightW = visibleWidth(right);
    const fill = Math.max(0, inner - titleW - rightW);
    return (
      t.fg("border", TL) + title + t.fg("border", H.repeat(fill)) + right + t.fg("border", TR)
    );
  }

  private searchBar(width: number): string {
    const t = this.theme;
    const editing = this.mode === "search" || this.mode === "file";
    const label = this.mode === "file" ? "files" : "search";
    const value = this.mode === "file" ? this.fileQuery : this.query;
    const caret = editing ? "\u2588" : "";
    const prompt = editing
      ? t.fg("accent", `${G_SEARCH} ${label}: `) + t.fg("text", value) + t.fg("accent", caret)
      : value
        ? t.fg("muted", `${G_SEARCH} ${label}: `) + t.fg("text", value)
        : t.fg("dim", `${G_SEARCH} search\u2026  (press / )`);

    const chips: string[] = [];
    chips.push(this.harness === null ? t.fg("accent", t.bold("all")) : t.fg("muted", "all"));
    HARNESS_ORDER.forEach((h, i) => {
      const n = this.opts.detections.find((d) => d.harness === h)?.sessionCount ?? 0;
      const label = n > 0 ? `${shortLabel(h)} ${n}` : shortLabel(h);
      chips.push(
        this.harness === h
          ? t.fg("accent", t.bold(`[${i + 1} ${label}]`))
          : t.fg("muted", `[${i + 1} ${label}]`),
      );
    });
    if (this.repo) chips.push(t.fg("warning", `repo:${this.repo.split("/").pop()}`));

    const inner = width - 2;
    const left = " " + prompt;
    const right = chips.join(" ") + " ";
    const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(right));
    return (
      t.fg("border", V) +
      pad(left + " ".repeat(gap) + right, inner) +
      t.fg("border", V)
    );
  }

  private legend(width: number): string {
    const t = this.theme;
    const parts = HARNESS_ORDER.map((h) => {
      const b = badgeFor(h);
      const n = this.opts.detections.find((d) => d.harness === h)?.sessionCount ?? 0;
      return t.fg(b.color, `${b.icon} ${HARNESS_LABEL[h]}`) + t.fg("dim", ` ${n}`);
    });
    return " " + parts.join(t.fg("dim", `  ${V} `));
  }

  private keyBar(width: number): string {
    const t = this.theme;
    const editing = this.mode === "search" || this.mode === "file";
    const pairs: [string, string][] = editing
      ? [
          ["type", "filter"],
          [G_ENTER, "accept"],
          ["esc", "clear"],
        ]
      : [
          [`${G_UP}${G_DOWN}`, "move"],
          [G_TAB, "pane"],
          [G_ENTER, "load context"],
          ["v", "view"],
          ["o", "open in place"],
          ["h", "draft"],
          ["n", "native"],
          ["/", "search"],
          ["f", "files"],
          ["p", "repo"],
          ["r", "reindex"],
          ["?", "help"],
          ["esc", "close"],
        ];
    // Render keys greedily so nothing is ever cut mid-word on a narrow terminal.
    const sep = t.fg("dim", "  ");
    let out = " ";
    for (const [k, label] of pairs) {
      const piece = t.fg("accent", k) + t.fg("dim", ` ${label}`);
      const candidate = out === " " ? out + piece : out + sep + piece;
      if (visibleWidth(candidate) > width) break;
      out = candidate;
    }
    return out;
  }

  private renderHelp(width: number, total: number): string[] {
    const t = this.theme;
    const inner = width - 2;
    const out: string[] = [];
    out.push(this.frameTop(width));
    out.push(t.fg("border", V) + pad(` ${t.fg("accent", t.bold("Keyboard reference"))}`, inner) + t.fg("border", V));
    out.push(sep(width, LT, RT, H));

    const rows: [string, string][] = [
      [`${G_UP} / ${G_DOWN}`, "move the selection"],
      ["j / k", "same as arrows"],
      ["page up / down", "jump a page"],
      ["home / end", "first / last session"],
      [G_TAB, "switch between the list and the transcript pane"],
      [`${G_ENTER}`, "load this session's context into the current chat"],
      ["v", "read the full transcript (no tokens spent)"],
      ["o", "open in place: switch Pi to that Pi session"],
      ["h", "put a handoff draft in the editor, to review before sending"],
      ["n", "reopen the session in its original harness"],
      ["/", "search titles, previews, projects and models"],
      ["f", "filter by a touched file path"],
      ["p", "cycle the project/repo filter"],
      ["0 - 6", "filter by harness (0 clears)"],
      ["r", "reindex every harness"],
      ["?", "toggle this help"],
      ["esc / q", "close"],
    ];
    for (const [k, desc] of rows) {
      out.push(
        t.fg("border", V) +
          pad(`   ${t.fg("accent", k.padEnd(16))}${t.fg("muted", desc)}`, inner) +
          t.fg("border", V),
      );
    }
    out.push(sep(width, LT, RT, H));
    out.push(
      t.fg("border", V) +
        pad(
          ` ${t.fg("muted", "Harness symbols")}   ` +
            HARNESS_ORDER.map((h) => {
              const b = badgeFor(h);
              return t.fg(b.color, `${b.icon} ${HARNESS_LABEL[h]}`);
            }).join(t.fg("dim", "  ")),
          inner,
        ) +
        t.fg("border", V),
    );
    while (out.length < total - 1) {
      out.push(t.fg("border", V) + pad("", inner) + t.fg("border", V));
    }
    out.push(t.fg("border", BL + H.repeat(Math.max(0, width - 2)) + BR));
    return out.slice(0, total);
  }

  private renderList(width: number, rows: number): string[] {
    const t = this.theme;
    const out: string[] = [];

    if (this.filtered.length === 0) {
      out.push("");
      out.push(" " + t.fg("warning", `${G_WARN} no sessions match`));
      for (const line of this.emptyStateHint()) out.push("   " + t.fg("dim", line));
      while (out.length < rows) out.push("");
      return out.slice(0, rows);
    }

    const perItem = 2;
    const visible = Math.max(1, Math.floor(rows / perItem));
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + visible) this.offset = this.selected - visible + 1;

    const nameWidth = 12;
    const header =
      " " +
      t.fg("dim", "  HARNESS".padEnd(nameWidth + 2)) +
      t.fg("dim", "UPDATED".padEnd(10)) +
      t.fg("dim", "PROJECT");
    out.push(pad(header, width));

    const usable = rows - 1;
    const perPage = Math.max(1, Math.floor(usable / perItem));

    for (let i = this.offset; i < Math.min(this.filtered.length, this.offset + perPage); i++) {
      const s = this.filtered[i];
      if (!s) continue;
      const isSel = i === this.selected;
      const b = badgeFor(s.harness);
      const gutter = t.fg(b.color, G_BAR);
      const name = t.fg(b.color, HARNESS_LABEL[s.harness].padEnd(nameWidth).slice(0, nameWidth));
      const when = relativeTime(s.updatedAt ?? s.createdAt);
      const where = s.repo ? s.repo.split("/").pop() ?? "" : (s.cwd ?? "\u2014");
      const model = s.model ? shortModel(s.model) : "";

      const marker = isSel ? t.fg("accent", G_ARROW) : " ";
      const whereW = Math.max(8, width - nameWidth - 22);
      const head =
        ` ${marker}${gutter}${name}` +
        t.fg(isSel ? "text" : "muted", when.padEnd(10)) +
        t.fg(isSel ? "text" : "muted", clip(where, whereW));
      const headPadded = pad(head, width);
      out.push(isSel ? highlight(t, headPadded) : headPadded);

      const title = s.title ?? s.preview ?? s.nativeId;
      const titleLine =
        `   ${gutter}` +
        t.fg(isSel ? "accent" : "text", clip(title, Math.max(10, width - 6))) +
        (model && width > 60 ? t.fg("dim", `  ${model}`) : "");
      const titlePadded = pad(titleLine, width);
      out.push(isSel ? highlight(t, titlePadded) : titlePadded);
    }

    // Scroll indicator on the last row when the list overflows.
    while (out.length < rows - 1) out.push("");
    const total = this.filtered.length;
    const from = this.offset + 1;
    const to = Math.min(total, this.offset + perPage);
    out.push(
      pad(
        "  " +
          t.fg("dim", `${from}-${to} of ${total}`) +
          (total > perPage ? t.fg("dim", "  \u2193 more") : "") +
          (this.offset > 0 ? t.fg("dim", "  \u2191 above") : ""),
        width,
      ),
    );
    return out.slice(0, rows);
  }

  private emptyStateHint(): string[] {
    const lines: string[] = [];
    if (this.query || this.harness || this.repo || this.fileQuery) {
      lines.push("Active filters:");
      if (this.query) lines.push(`  text: ${this.query}`);
      if (this.harness) lines.push(`  harness: ${HARNESS_LABEL[this.harness]}`);
      if (this.repo) lines.push(`  repo: ${this.repo}`);
      if (this.fileQuery) lines.push(`  file: ${this.fileQuery}`);
      lines.push("Press 0 to clear the harness filter, esc to leave search.");
      lines.push("");
    }
    for (const d of this.opts.detections) {
      if (d.status === "path_missing") lines.push(`${HARNESS_LABEL[d.harness]}: no store at ${d.root}`);
      else if (d.status === "permission_denied") lines.push(`${HARNESS_LABEL[d.harness]}: cannot read ${d.root}`);
      else if (d.status === "not_installed") lines.push(`${HARNESS_LABEL[d.harness]}: not installed`);
      else if (d.status === "error") lines.push(`${HARNESS_LABEL[d.harness]}: ${d.detail ?? "error"}`);
      else if (d.sessionCount === 0) lines.push(`${HARNESS_LABEL[d.harness]}: store exists but has no sessions`);
    }
    return lines;
  }

  private renderDetail(width: number, rows: number): string[] {
    const t = this.theme;
    const s = this.current;
    if (!s) return Array.from({ length: rows }, () => "");
    const out: string[] = [];

    const b = badgeFor(s.harness);
    out.push(
      " " +
        t.fg(b.color, t.bold(`${b.icon} ${HARNESS_LABEL[s.harness]}`)) +
        t.fg("dim", `  ${s.nativeId.slice(0, Math.max(8, width - 24))}`),
    );
    out.push(" " + t.fg("borderMuted", H.repeat(Math.max(0, width - 2))));

    const kv = (k: string, v: string | null) => {
      if (!v) return;
      out.push(
        " " + t.fg("muted", ` ${k.padEnd(9)}`) + t.fg("text", clip(v, Math.max(8, width - 14))),
      );
    };
    kv("when", `${shortDate(s.createdAt)} ${G_ARROW} ${shortDate(s.updatedAt)}`);
    kv("repo", s.repo ?? s.cwd);
    kv("model", s.model);
    kv("messages", `${s.messageCount}${s.toolCount ? `   tools ${s.toolCount}` : ""}`);
    kv("store", s.path);

    const changed = s.fidelity.filesChanged;
    const read = s.fidelity.filesRead;
    kv(
      "changed",
      changed === null ? "not available" : changed.length ? `${changed.length} file(s)` : "none",
    );
    kv("read", read === null ? "not available" : read.length ? `${read.length} file(s)` : "none");

    const detail = this.detailCache.get(s.uid) ?? null;
    if (detail && detail.tools.length > 0) {
      kv(
        "tools",
        detail.tools.slice(0, 4).map((x) => `${x.name}${"\u00d7"}${x.count}`).join("  "),
      );
    }
    const fidelity = fidelityNote(s.fidelity);
    if (fidelity !== "complete") {
      out.push(" " + t.fg("dim", ` fidelity  ${clip(fidelity, Math.max(8, width - 13))}`));
    }
    for (const note of s.fidelity.notes.slice(0, 2)) {
      out.push(" " + t.fg("dim", ` note      ${clip(note, Math.max(8, width - 13))}`));
    }

    out.push(" " + t.fg("borderMuted", H.repeat(Math.max(0, width - 2))));

    if (this.detailLoading.has(s.uid) && !detail) {
      out.push(" " + t.fg("dim", " loading transcript\u2026"));
      while (out.length < rows) out.push("");
      return out.slice(0, rows);
    }

    const messages = detail?.messages ?? [];
    const body = this.transcriptLines(s.uid, messages, width);
    const bodyRows = Math.max(1, rows - out.length - 1);
    const maxScroll = Math.max(0, body.length - bodyRows);
    if (this.detailScroll > maxScroll) this.detailScroll = maxScroll;

    const truncated = s.messageCount > messages.length;
    const counter = truncated
      ? `${messages.length} of ${s.messageCount} messages`
      : `${messages.length} messages`;
    const pos =
      body.length > bodyRows
        ? `   ${this.detailScroll + 1}-${Math.min(body.length, this.detailScroll + bodyRows)}/${body.length}`
        : "";
    out.push(
      " " + t.fg("accent", " TRANSCRIPT ") + t.fg("muted", counter) + t.fg("dim", pos),
    );

    if (body.length === 0) {
      out.push("   " + t.fg("dim", "(no messages recovered)"));
    } else {
      out.push(...body.slice(this.detailScroll, this.detailScroll + bodyRows));
    }

    while (out.length < rows) out.push("");
    return out.slice(0, rows);
  }

  private transcriptLines(
    uid: string,
    messages: SessionDetail["messages"],
    width: number,
  ): string[] {
    const key = `${uid}@${width}`;
    const cached = this.transcriptCache.get(key);
    if (cached) return cached;

    const t = this.theme;
    const body: string[] = [];
    for (const m of messages) {
      const color = m.role === "user" ? "accent" : m.role === "assistant" ? "text" : "muted";
      body.push("   " + t.fg(color, G_BAR) + " " + t.fg(color, m.role));
      for (const line of wrapText(m.text, Math.max(10, width - 8))) {
        body.push("     " + t.fg("muted", line));
      }
      body.push("");
    }
    if (this.transcriptCache.size > 8) {
      const oldest = this.transcriptCache.keys().next().value;
      if (oldest !== undefined) this.transcriptCache.delete(oldest);
    }
    this.transcriptCache.set(key, body);
    return body;
  }
}

// ---------------------------------------------------------------- helpers

/** Selected-row background, falling back to plain text if the theme has no bg. */
function highlight(theme: ThemeLike, text: string): string {
  if (typeof theme.bg !== "function") return text;
  try {
    return theme.bg("selectedBg", text);
  } catch {
    return text;
  }
}

function sep(width: number, left: string, right: string, fill: string): string {
  return left + fill.repeat(Math.max(0, width - 2)) + right;
}

function pad(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w === width) return text;
  if (w > width) return truncateToWidth(text, width);
  return text + " ".repeat(width - w);
}

function clip(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  return flat.slice(0, Math.max(1, width - 1)) + "\u2026";
}

function shortModel(model: string): string {
  const m = model.includes("/") ? model.split("/").pop() ?? model : model;
  return m.length > 18 ? m.slice(0, 17) + "\u2026" : m;
}

function wrapText(text: string, width: number): string[] {
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
  return lines.slice(0, 6);
}

function shortDate(iso: string | null): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "\u2014";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "\u2014";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "\u2014";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}

