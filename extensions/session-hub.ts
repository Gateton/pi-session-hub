/**
 * pi-session-hub
 *
 * A cross-harness session hub for Pi. One list, one search box, every harness:
 * Pi, Claude Code, Codex, OpenCode, Crush and JCode.
 *
 * Two rules this extension never breaks:
 *  1. Nothing outside `~/.pi/agent/pi-session-hub/` is ever written.
 *  2. A conversation from another harness is never turned into a Pi session file
 *     that pretends Pi created it. External sessions are either resumed in their
 *     own harness, or handed off as an explicitly labelled context document.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { AdapterRegistry } from "../src/adapters/registry.ts";
import { buildTranscriptContext } from "../src/context.ts";
import { buildHandoff } from "../src/handoff.ts";
import {
  distinctRepos,
  indexCount,
  lastIndexedAt,
  openIndex,
  querySessions,
  rowToSession,
  type IndexHandle,
} from "../src/index/db.ts";
import { scan } from "../src/index/scan.ts";
import {
  describeNativeResume,
  launchNativeResume,
  resolveNativeResume,
} from "../src/native.ts";
import { assertWritableTarget, indexDbPath, indexDir } from "../src/security.ts";
import { badgeFor } from "../src/tui/badges.ts";
import { HubComponent } from "../src/tui/hub.ts";
import { TranscriptView } from "../src/tui/transcript.ts";
import type { DetectionResult, ExternalSession, HarnessId } from "../src/types.ts";
import { HARNESS_LABEL, HARNESS_ORDER } from "../src/types.ts";

export default function sessionHub(pi: ExtensionAPI) {
  // The hub always reads the real user's home unless explicitly pointed
  // elsewhere. PI_SESSION_HUB_HOME exists for tests and for producing demo
  // screenshots from a synthetic home, never as a normal user-facing setting.
  const home = process.env.PI_SESSION_HUB_HOME || os.homedir();
  const registry = new AdapterRegistry(home);

  let index: IndexHandle | null = null;
  let detections: DetectionResult[] = [];
  let sessions: ExternalSession[] = [];
  let lastScanAt = 0;
  let lastScanError: string | null = null;

  /** Floor and ceiling for any context budget, configured or per-call. */
  const CONTEXT_CHARS_MIN = 4_000;
  const CONTEXT_CHARS_MAX = 400_000;

  /**
   * Context budget, in characters, for the imported transcript. Tunable so the
   * user decides how many tokens a continuation is worth:
   *   { "sessionHub": { "contextChars": 40000 } }
   * Defaults to ~40k chars (~10k tokens) regardless of session length.
   */
  function readContextBudget(): number {
    const fallback = 40_000;
    try {
      const raw = fs.readFileSync(path.join(home, ".pi", "agent", "settings.json"), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const section = parsed.sessionHub as Record<string, unknown> | undefined;
      const value = section?.contextChars;
      if (typeof value === "number" && Number.isFinite(value) && value >= CONTEXT_CHARS_MIN) {
        return Math.min(value, CONTEXT_CHARS_MAX);
      }
    } catch {
      /* no settings file, or unreadable: use the default */
    }
    return fallback;
  }

  /**
   * The budget for one session_hub_context call: an explicit `chars` argument
   * from the model wins over the configured default, so an unusually large
   * conversation is not permanently capped by the user's global setting. Still
   * bounded by CONTEXT_CHARS_MIN/MAX either way.
   */
  function resolveContextBudget(requested: unknown): number {
    if (typeof requested === "number" && Number.isFinite(requested) && requested >= CONTEXT_CHARS_MIN) {
      return Math.min(requested, CONTEXT_CHARS_MAX);
    }
    return readContextBudget();
  }

  // ------------------------------------------------------------------ index

  function ensureIndexDir(): void {
    const dir = indexDir(home);
    assertWritableTarget(dir, home);
    fs.mkdirSync(dir, { recursive: true });
  }

  async function getIndex(): Promise<IndexHandle | null> {
    if (index) return index;
    ensureIndexDir();
    index = await openIndex(indexDbPath(home));
    return index;
  }

  async function loadDetail(session: ExternalSession) {
    const adapter = registry.get(session.harness);
    if (!adapter) return null;
    try {
      return await adapter.getSession(session.nativeId);
    } catch {
      return null;
    }
  }

  /**
   * Read sessions from the index, scanning first when needed. Throws with a
   * readable message instead of silently reporting "no sessions": a failed read
   * and an empty index are very different situations.
   */
  async function refresh(ctx: ExtensionContext, force: boolean): Promise<void> {
    const handle = await getIndex();
    if (!handle) {
      sessions = [];
      throw new Error("could not open the session index");
    }
    detections = await registry.detectAll();

    const needScan = force || indexCount(handle) === 0;
    if (needScan) {
      const result = await ctx.ui.custom<{ failed: string[]; errors: string[] }>(
        (tui, theme, _kb, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            force ? "Reindexing all harnesses\u2026" : "Indexing harness sessions\u2026",
          );
          loader.onAbort = () => done({ failed: [], errors: [] });
          scan(handle, registry, { force, maxPerHarness: 2000 })
            .then((r) => {
              lastScanAt = Date.now();
              loader.setMessage?.(`Indexed ${r.total} sessions in ${r.durationMs}ms`);
              done({
                failed: r.failed.map(String),
                errors: r.errors.map((e) => `${e.harness}: ${e.message}`),
              });
            })
            .catch((err) =>
              done({ failed: [], errors: [err instanceof Error ? err.message : String(err)] }),
            );
          return loader;
        },
      );
      lastScanError = result.errors.length ? result.errors.join("; ") : null;
      if (result.errors.length) {
        ctx.ui.notify(
          `Session hub: some sources could not be read and were left as they were:\n${result.errors.join("\n")}`,
          "warning",
        );
      }
    }

    const rows = querySessions(handle, { limit: 2000 });
    sessions = rows.map(rowToSession);
    lastScanAt = lastScanAt || Date.now();
  }

  /**
   * refresh() wrapper for command handlers: a read failure must be reported as a
   * failure, never rendered as "no sessions".
   */
  async function safeRefresh(ctx: ExtensionContext, force = false): Promise<boolean> {
    try {
      await refresh(ctx, force);
      return true;
    } catch (err) {
      ctx.ui.notify(
        `Session hub could not read its index: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return false;
    }
  }

  function statusLine(): string {
    const when = lastIndexedAt(index!) ?? null;
    if (!when) return `${sessions.length} sessions`;
    const secs = Math.round((Date.now() - Date.parse(when)) / 1000);
    const ago = secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`;
    return `${sessions.length} sessions \u00b7 indexed ${ago} ago`;
  }

  // -------------------------------------------------------------------- hub

  /**
   * Hub loop. Actions return `true` when the user cancelled, in which case we
   * reopen the hub where they left off instead of dropping them into the chat.
   */
  async function openHub(ctx: ExtensionContext, initialHarness?: HarnessId | null) {
    let harness: HarnessId | null = initialHarness ?? null;
    // Bounded so a pathological action loop cannot spin forever.
    for (let round = 0; round < 100; round++) {
      const back = await hubRound(ctx, harness);
      if (back === null) return;
      harness = back;
    }
  }

  /** One pass of the hub. Returns the harness filter to reopen with, or null to stop. */
  async function hubRound(
    ctx: ExtensionContext,
    initialHarness: HarnessId | null,
  ): Promise<HarnessId | null> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("session-hub requires interactive mode", "error");
      return;
    }
    if (!(await safeRefresh(ctx))) return;

    // Actions that replace the session or open another overlay must run *after*
    // the hub closes, because the command context is stale once the session is
    // replaced.
    type Pending =
      | { kind: "handoff"; session: ExternalSession }
      | { kind: "native"; session: ExternalSession }
      | { kind: "continue"; session: ExternalSession }
      | { kind: "load"; session: ExternalSession }
      | { kind: "view"; session: ExternalSession };
    let pending: Pending | null = null;
    let reindexRequested = false;

    const handle = index;

    const result = await ctx.ui.custom<null>((tui, theme, _kb, done) => {
      const hub = new HubComponent({
        sessions,
        detections,
        repos: handle ? distinctRepos(handle).map((r) => r.repo) : [],
        initialHarness: initialHarness ?? null,
        theme,
        requestRender: () => tui.requestRender(),
        callbacks: {
          onQuit: () => done(null),
          loadDetail: (session) => loadDetail(session),
          onOpen: (session) => {
            // Enter always does the same thing regardless of harness or of how
            // the hub was opened: load the context into this chat so the user
            // can continue. Switching a Pi session is a separate, explicit
            // action (`o`) because it replaces the current session.
            pending = { kind: "load", session };
            done(null);
          },
          onSwitch: (session) => {
            pending = { kind: "continue", session };
            done(null);
          },
          onView: (session) => {
            pending = { kind: "view", session };
            done(null);
          },
          onHandoff: (session) => {
            pending = { kind: "handoff", session };
            done(null);
          },
          onNative: (session) => {
            pending = { kind: "native", session };
            done(null);
          },
          onReindex: () => {
            reindexRequested = true;
            done(null);
          },
        },
      });
      // Warm the detail pane for the initially selected session, otherwise the
      // preview stays empty until the user moves the cursor.
      hub.primeDetail();
      return {
        render: (width: number) => hub.render(width),
        handleInput: (data: string) => {
          hub.handleInput(data);
          tui.requestRender();
        },
        invalidate: () => hub.invalidate(),
      };
    });

    void result;

    if (reindexRequested) {
      if (!(await safeRefresh(ctx, true))) return null;
      ctx.ui.notify(`Reindexed: ${statusLine()}`, "info");
      return initialHarness;
    }

    if (!pending) return null;
    const action: Pending = pending;

    let backToHub: boolean;
    if (action.kind === "handoff") {
      backToHub = await runHandoff(ctx, action.session);
    } else if (action.kind === "native") {
      backToHub = await runNative(ctx, action.session);
    } else if (action.kind === "continue") {
      backToHub = await runContinue(ctx, action.session);
    } else if (action.kind === "load") {
      backToHub = await runLoadContext(ctx, action.session);
    } else {
      backToHub = await runView(ctx, action.session);
    }

    if (!backToHub) return null;
    // Reopen on the same harness the user was browsing.
    return action.session.harness;
  }

  // ---------------------------------------------------------------- actions

  /**
   * Continue a Pi session for real: switch the current Pi session to that file.
   * This is the equivalent of what JCode does when you resume a session.
   */
  async function runContinue(ctx: ExtensionContext, session: ExternalSession): Promise<boolean> {
    if (typeof (ctx as { switchSession?: unknown }).switchSession !== "function") {
      ctx.ui.notify(
        "Switching to a session needs the /session-hub command; keyboard shortcuts cannot " +
          "replace the active session. Run /session-hub and press o, or use Enter to load " +
          "this session's context into the current chat.",
        "warning",
      );
      return true;
    }
    if (session.harness !== "pi") {
      ctx.ui.notify(
        `${HARNESS_LABEL[session.harness]} sessions cannot be switched into Pi. ` +
          `Press Enter to load its context here, or n to reopen it in its own tool.`,
        "warning",
      );
      return true;
    }
    if (!fs.existsSync(session.path)) {
      ctx.ui.notify(`Session file is gone: ${session.path}`, "error");
      return true;
    }
    const current = ctx.sessionManager.getSessionFile();
    if (current === session.path) {
      ctx.ui.notify("That is already the active session.", "info");
      return true;
    }

    const ok = await ctx.ui.confirm(
      "Continue this Pi session?",
      [
        session.title ?? session.nativeId,
        "",
        `  ${session.path}`,
        "",
        `${session.messageCount} messages \u00b7 ${session.model ?? "model unknown"}`,
        "",
        "Pi will switch to that session. The current session is saved and stays on disk.",
      ].join("\n"),
    );
    if (!ok) {
      ctx.ui.notify("Cancelled", "info");
      return true;
    }

    const switched = await ctx.switchSession(session.path, {
      withSession: async (replacement) => {
        replacement.ui.notify(
          `Continued session from the hub: ${session.title ?? session.nativeId}`,
          "info",
        );
      },
    });
    if (switched.cancelled) {
      ctx.ui.notify("Switch cancelled", "info");
      return true;
    }
    // The session was replaced: the hub's context is stale, so stop here.
    return false;
  }

  /**
   * Load a session's context into the CURRENT Pi chat so the user can continue.
   *
   * Uses `pi.sendMessage`, which is available on the extension API rather than
   * the command context, so this works identically from a slash command and from
   * a keyboard shortcut. The context is queued for the next turn: it does not
   * trigger a model call on its own and it does not interrupt anything.
   *
   * The document is explicitly labelled as imported and names the source
   * harness, id and path. It is never presented as a Pi-native conversation.
   */
  async function runLoadContext(
    ctx: ExtensionContext,
    session: ExternalSession,
  ): Promise<boolean> {
    const detail = await loadDetail(session);
    if (!detail) {
      ctx.ui.notify(
        `Could not read the transcript for ${session.nativeId}, so there is no context to load. ` +
          `Its source file may have moved or become unreadable.`,
        "error",
      );
      return true;
    }
    if (detail.messages.length === 0) {
      ctx.ui.notify(
        `${HARNESS_LABEL[session.harness]} session ${session.nativeId} has no recoverable messages, ` +
          `so there is nothing to continue from.`,
        "warning",
      );
      return true;
    }

    // The full conversation, not a digest. Tool output is compressed inside
    // buildTranscriptContext, which is what makes an extensive session fit while
    // still being enough to continue coherently.
    const context = buildTranscriptContext(detail, { charBudget: readContextBudget() });
    const markdown = context.markdown;

    // `pi.sendMessage` is the one API that both renders in the transcript and
    // creates a custom_message entry that participates in LLM context. It is on
    // the extension API, so it works from a slash command and from a keyboard
    // shortcut alike (unlike newSession/switchSession, which need a command
    // context). triggerTurn:false means it does not spend a model call on its
    // own; the context is simply there for the user's next message.
    //
    // Verified against the running binary: pi.sendMessage renders immediately,
    // while ctx.sessionManager.appendCustomMessageEntry is in context but
    // invisible, and pi.appendEntry is visible but not in context.
    pi.sendMessage(
      {
        customType: "session-hub-import",
        content: markdown,
        display: true,
        details: {
          uid: session.uid,
          harness: session.harness,
          sourcePath: session.path,
          messageCount: detail.messages.length,
          includedMessages: context.includedMessages,
          fullMessages: context.fullMessages,
          condensedMessages: context.condensedMessages,
          omittedMessages: context.omittedMessages,
          chars: context.chars,
          estimatedTokens: context.estimatedTokens,
          unavailableFields: detail.fidelity.notes,
        },
      },
      { triggerTurn: false },
    );

    const parts = [
      `${context.fullMessages} recent message(s) in full`,
      context.condensedMessages > 0 ? `${context.condensedMessages} older condensed to one line` : null,
      context.omittedMessages > 0 ? `${context.omittedMessages} omitted` : null,
      `${context.toolResultsCompressed} tool results compressed`,
    ].filter(Boolean);
    ctx.ui.notify(
      `Loaded context from ${HARNESS_LABEL[session.harness]} session ` +
        `${session.nativeId.slice(0, 12)}: ${parts.join(", ")}. ` +
        `Cost: ~${context.estimatedTokens.toLocaleString()} tokens ` +
        `(${Math.round(context.chars / 1000)}k chars, budget ${Math.round(readContextBudget() / 1000)}k). ` +
        `Just type what you want to do next.`,
      "info",
    );
    // Return to the chat so the user can continue immediately.
    return false;
  }

  /** Full read-only transcript for a session that Pi cannot adopt. */
  async function runView(ctx: ExtensionContext, session: ExternalSession): Promise<boolean> {
    const detail = await loadDetail(session);
    if (!detail) {
      ctx.ui.notify(
        `Could not read the transcript for ${session.nativeId}. The session is still indexed; ` +
          `its source file may have moved or become unreadable.`,
        "error",
      );
      return true;
    }

    type ViewAction = "back" | "handoff" | "native";
    let action: ViewAction = "back";

    await ctx.ui.custom<null>((tui, theme, _kb, done) => {
      const view = new TranscriptView({
        detail,
        theme,
        requestRender: () => tui.requestRender(),
        onQuit: () => {
          action = "back";
          done(null);
        },
        onHandoff: () => {
          action = "handoff";
          done(null);
        },
        onNative: () => {
          action = "native";
          done(null);
        },
      });
      return {
        render: (width: number) => view.render(width),
        handleInput: (data: string) => {
          view.handleInput(data);
          tui.requestRender();
        },
        invalidate: () => view.invalidate(),
      };
    });

    if (action === "handoff") return runHandoff(ctx, session);
    if (action === "native") return runNative(ctx, session);
    // Escape returns to the hub rather than dropping the user into the chat.
    return true;
  }

  async function runHandoff(ctx: ExtensionContext, session: ExternalSession): Promise<boolean> {
    const adapter = registry.get(session.harness);
    if (!adapter) {
      ctx.ui.notify("No adapter for this session", "error");
      return true;
    }
    const detail = await adapter.getSession(session.nativeId);
    if (!detail) {
      ctx.ui.notify("Could not read that transcript", "error");
      return true;
    }

    const { markdown, unavailableFields } = buildHandoff(detail);
    const parentSession = ctx.sessionManager.getSessionFile();

    const newSession = await ctx.newSession({
      parentSession,
      withSession: async (replacement) => {
        replacement.ui.setEditorText(markdown);
        const note = unavailableFields.length
          ? `Handoff ready in the editor. Fields unavailable from the source: ${unavailableFields.join(", ")}.`
          : "Handoff ready in the editor. Review it, then submit.";
        replacement.ui.notify(note, "info");
      },
    });

    if (newSession.cancelled) {
      ctx.ui.notify("Handoff cancelled", "info");
      return true;
    }
    // The session was replaced: the hub's context is stale, so stop here.
    return false;
  }

  async function runNative(ctx: ExtensionContext, session: ExternalSession): Promise<boolean> {
    const adapter = registry.get(session.harness);
    if (!adapter) {
      ctx.ui.notify("No adapter for this session", "error");
      return true;
    }
    const action = await resolveNativeResume(adapter, session.nativeId);
    if (!action) {
      ctx.ui.notify(
        `${HARNESS_LABEL[session.harness]} has no verified resume-by-id command for this ` +
          `transcript (for example, a sub-agent transcript whose id the CLI will not accept). ` +
          `Use the handoff action instead (/session-handoff).`,
        "warning",
      );
      return true;
    }

    const ok = await ctx.ui.confirm("Launch native resume?", describeNativeResume(action));
    if (!ok) {
      ctx.ui.notify("Cancelled", "info");
      return true;
    }
    const launched = launchNativeResume(action);
    ctx.ui.notify(launched.message, launched.ok ? "info" : "error");
    // Stay in the hub so the user can keep browsing.
    return true;
  }

  // --------------------------------------------------------------- commands

  const HUB_COMMANDS = ["session-hub", "hub"];

  for (const name of HUB_COMMANDS) {
    pi.registerCommand(name, {
      description: "Browse and search sessions from every coding harness",
      handler: async (args, ctx) => {
        const trimmed = args.trim();
        const harness = HARNESS_ORDER.find(
          (h) =>
            h === trimmed.toLowerCase() ||
            HARNESS_LABEL[h].toLowerCase() === trimmed.toLowerCase(),
        );
        await openHub(ctx, harness ?? null);
      },
    });
  }

  pi.registerShortcut("alt+r", {
    description: "Open the cross-harness session hub",
    handler: async (ctx) => {
      await openHub(ctx);
    },
  });

  pi.registerCommand("session-search", {
    description: "Search sessions across all harnesses (local FTS index)",
    getArgumentCompletions: (prefix) => {
      const items = HARNESS_ORDER.map((h) => ({
        value: `--harness ${h}`,
        label: `--harness ${h}`,
        description: HARNESS_LABEL[h],
      }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length ? filtered : null;
    },
    handler: async (args, ctx) => {
      if (!(await safeRefresh(ctx))) return;
      const handle = index;
      if (!handle) {
        ctx.ui.notify("Index unavailable", "error");
        return;
      }
      const { text, harness, limit } = parseSearchArgs(args);
      const rows = querySessions(handle, { text, harness, limit });
      if (rows.length === 0) {
        ctx.ui.notify(
          `No sessions matched${text ? ` "${text}"` : ""}. Try /session-hub to browse.`,
          "info",
        );
        return;
      }
      const lines = rows.slice(0, 25).map((r) => {
        const s = rowToSession(r);
        const when = (s.updatedAt ?? s.createdAt ?? "").slice(0, 16).replace("T", " ");
        return `${s.uid}\n    ${when}  ${HARNESS_LABEL[s.harness]}  ${s.repo ?? s.cwd ?? "-"}\n    ${s.title ?? s.preview ?? ""}`;
      });
      ctx.ui.notify(
        `${rows.length} match(es)${text ? ` for "${text}"` : ""}:\n\n${lines.join("\n\n")}`,
        "info",
      );
    },
  });

  pi.registerCommand("session-open", {
    description: "Show one session's metadata and transcript preview (read-only)",
    handler: async (args, ctx) => {
      if (!(await safeRefresh(ctx))) return;
      const uid = args.trim();
      if (!uid) {
        ctx.ui.notify("Usage: /session-open <session-id>", "error");
        return;
      }
      const session = findSession(uid);
      if (!session) {
        ctx.ui.notify(`No session matching "${uid}". Try /session-search.`, "error");
        return;
      }
      const adapter = registry.get(session.harness);
      const detail = adapter ? await adapter.getSession(session.nativeId) : null;
      const body = [
        `Harness:  ${HARNESS_LABEL[session.harness]}`,
        `ID:       ${session.nativeId}`,
        `Path:     ${session.path}`,
        `Project:  ${session.repo ?? session.cwd ?? "not available"}`,
        `Model:    ${session.model ?? "not available"}`,
        `Created:  ${session.createdAt ?? "not available"}`,
        `Updated:  ${session.updatedAt ?? "not available"}`,
        `Messages: ${session.messageCount}   Tools: ${session.toolCount}`,
        `Changed:  ${session.fidelity.filesChanged?.length ?? "not available"}`,
        `Read:     ${session.fidelity.filesRead?.length ?? "not available"}`,
        "",
        "--- transcript preview (first 10 messages) ---",
        ...(detail?.messages ?? [])
          .slice(0, 10)
          .map((m) => `[${m.role}] ${m.text.slice(0, 400)}`),
      ].join("\n");
      // Read-only: this only renders text, it never writes to the source.
      await ctx.ui.editor(`Session ${session.nativeId} (read-only preview)`, body);
    },
  });

  pi.registerCommand("session-handoff", {
    description: "Create a new Pi session seeded with an imported context document",
    handler: async (args, ctx) => {
      if (!(await safeRefresh(ctx))) return;
      const uid = args.trim();
      if (!uid) {
        ctx.ui.notify("Usage: /session-handoff <session-id>", "error");
        return;
      }
      const session = findSession(uid);
      if (!session) {
        ctx.ui.notify(`No session matching "${uid}". Try /session-search.`, "error");
        return;
      }
      await runHandoff(ctx, session);
    },
  });

  pi.registerCommand("session-native", {
    description: "Resume a session in its original harness (shows the command first)",
    handler: async (args, ctx) => {
      if (!(await safeRefresh(ctx))) return;
      const uid = args.trim();
      if (!uid) {
        ctx.ui.notify("Usage: /session-native <session-id>", "error");
        return;
      }
      const session = findSession(uid);
      if (!session) {
        ctx.ui.notify(`No session matching "${uid}". Try /session-search.`, "error");
        return;
      }
      await runNative(ctx, session);
    },
  });

  // ------------------------------------------------------- message rendering

  /**
   * The imported context is a long document. Rendering it collapsed keeps the
   * chat readable while still making it obvious that context was loaded and
   * where it came from. Expanding the message shows the full handoff.
   */
  pi.registerMessageRenderer(
    "session-hub-import",
    (message, { expanded, outputPad }, theme) => {
      const d = (message.details ?? {}) as {
        uid?: string;
        harness?: HarnessId;
        sourcePath?: string;
        messageCount?: number;
        includedMessages?: number;
        fullMessages?: number;
        condensedMessages?: number;
        omittedMessages?: number;
        estimatedTokens?: number;
        unavailableFields?: string[];
      };
      const harness = d.harness ?? "pi";
      const badge = badgeFor(harness);
      const label = theme.fg(badge.color, `${badge.icon} ${HARNESS_LABEL[harness] ?? harness}`);

      const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
      const sizing = [
        d.includedMessages !== undefined && d.messageCount !== undefined
          ? `${d.includedMessages}/${d.messageCount} messages`
          : d.messageCount !== undefined
            ? `${d.messageCount} messages`
            : null,
        d.estimatedTokens !== undefined
          ? `~${d.estimatedTokens.toLocaleString()} tokens`
          : null,
        d.omittedMessages ? `${d.omittedMessages} omitted` : null,
      ]
        .filter(Boolean)
        .join("  \u00b7  ");
      box.addChild(
        new Text(
          `${theme.fg("accent", theme.bold("imported transcript"))}  ${label}` +
            theme.fg("dim", `  ${sizing}`),
          0,
          0,
        ),
      );
      box.addChild(new Text(theme.fg("dim", `source: ${d.sourcePath ?? "unknown"}`), 0, 0));

      const body = String(message.content ?? "");
      if (expanded) {
        box.addChild(new Text("", 0, 0));
        for (const line of body.split("\n").slice(0, 300)) {
          box.addChild(new Text(theme.fg("muted", line), 0, 0));
        }
      } else {
        const objective = body
          .split("\n")
          .find((l) => l.startsWith("- Original objective:"));
        if (objective) {
          box.addChild(new Text(theme.fg("text", objective.slice(0, 220)), 0, 0));
        }
        if (d.unavailableFields?.length) {
          box.addChild(
            new Text(
              theme.fg("dim", `source notes: ${d.unavailableFields.slice(0, 2).join("; ")}`),
              0,
              0,
            ),
          );
        }
        box.addChild(
          new Text(theme.fg("dim", "expand this message to read the imported transcript"), 0, 0),
        );
      }
      return box;
    },
  );

  // ------------------------------------------------------------------- tool

  pi.registerTool({
    name: "session_hub_search",
    label: "Session Hub Search",
    description:
      "Search the local index of coding-agent sessions across Pi, Claude Code, Codex, OpenCode, Crush and JCode. " +
      "Use this when the user asks which session they worked on something in, or wants to find prior context.",
    promptSnippet: "Search past sessions across all coding harnesses",
    promptGuidelines: [
      "Use session_hub_search when the user asks about previous work, prior sessions, or 'where did I do X'.",
      "Results are local-only metadata and previews. It never uploads transcripts anywhere.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Full-text query over titles and previews" }),
      ),
      harness: Type.Optional(
        Type.String({
          description: `One of: ${HARNESS_ORDER.join(", ")}`,
        }),
      ),
      repo: Type.Optional(Type.String({ description: "Filter by repository path substring" })),
      limit: Type.Optional(Type.Number({ description: "Max results, default 15" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        await refresh(ctx as ExtensionContext, false);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Session hub index could not be read: ${err instanceof Error ? err.message : String(err)}. This is a read failure, not an empty index.`,
            },
          ],
        };
      }
      const handle = index;
      if (!handle) {
        return { content: [{ type: "text" as const, text: "Session index unavailable." }] };
      }
      const harness =
        typeof params.harness === "string" &&
        (HARNESS_ORDER as string[]).includes(params.harness)
          ? (params.harness as HarnessId)
          : null;

      let rows: ReturnType<typeof querySessions>;
      try {
        rows = querySessions(handle, {
          text: typeof params.query === "string" ? params.query : undefined,
          harness,
          limit: typeof params.limit === "number" ? Math.min(params.limit, 50) : 15,
        });
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Session index query failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      const repoFilter =
        typeof params.repo === "string" ? params.repo.toLowerCase() : null;
      const filtered = repoFilter
        ? rows.filter((r) => (r.repo ?? r.cwd ?? "").toLowerCase().includes(repoFilter))
        : rows;

      if (filtered.length === 0) {
        const total = indexCount(handle);
        return {
          content: [
            {
              type: "text" as const,
              text:
                total === 0
                  ? "The session index is empty. The user can build it with /session-hub then r."
                  : `No sessions matched, but the index holds ${total} sessions. ` +
                    "Try a broader query, or drop the harness/repo filters.",
            },
          ],
        };
      }

      const text = filtered.map((r) => formatSessionBlock(rowToSession(r))).join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${filtered.length} session(s) from the local cross-harness index ` +
              `(index total: ${indexCount(handle)}).\n\n` +
              `To continue one: call session_hub_context with its id to get the full ` +
              `handoff document, then use that context to answer or continue the work. ` +
              `The user can also run /session-open <id>, /session-handoff <id>, /session-native <id>.\n\n` +
              text,
          },
        ],
        details: { count: filtered.length },
      };
    },
  });

  pi.registerTool({
    name: "session_hub_context",
    label: "Session Hub Context",
    description:
      "Load the full imported-context document for one session from any harness, so you can continue " +
      "work that started elsewhere. Use after session_hub_search when the user asks to pick up a prior session.",
    promptSnippet: "Load a prior session's context document to continue its work",
    promptGuidelines: [
      "Call session_hub_context when the user wants to continue, resume, or ask about what was happening in a specific past session.",
      "The returned document is generated locally from the transcript. Treat fields marked 'not available' as genuinely unknown.",
      "After loading it, summarize the prior context for the user before continuing.",
      "If the returned transcript feels too thin to actually continue the work (long session, heavily condensed), call again with a higher 'chars' value instead of guessing at what was omitted.",
    ],
    parameters: Type.Object({
      id: Type.String({
        description: "Session id from session_hub_search, e.g. 'claude-code:<uuid>' or 'pi:<uuid>'",
      }),
      mode: Type.Optional(
        Type.String({
          description:
            "'transcript' (default) returns the actual conversation so work can continue; " +
            "'summary' returns a short digest with objective, decisions and file lists",
        }),
      ),
      chars: Type.Optional(
        Type.Number({
          description:
            "Override the character budget for this call only (default: the configured " +
            "sessionHub.contextChars setting, falling back to 40000). Raise it when the default " +
            "transcript feels too thin to continue the work; hard ceiling 400000. Ignored in 'summary' mode.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        await refresh(ctx as ExtensionContext, false);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Session hub index could not be read: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
      const session = findSession(String(params.id ?? ""));
      if (!session) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No session matching "${params.id}". Run session_hub_search first to get a valid id.`,
            },
          ],
        };
      }
      const detail = await loadDetail(session);
      if (!detail) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Session ${session.uid} is indexed but its transcript could not be read (source: ${session.path}).`,
            },
          ],
        };
      }
      const mode = String(params.mode ?? "transcript").toLowerCase();
      if (mode === "summary") {
        const { markdown, unavailableFields } = buildHandoff(detail);
        const note = unavailableFields.length
          ? `\n\nFields the source format could not supply: ${unavailableFields.join(", ")}.`
          : "";
        return {
          content: [{ type: "text" as const, text: markdown + note }],
          details: { uid: session.uid, harness: session.harness, mode: "summary" },
        };
      }

      // Default: the real conversation. This is what makes an extensive session
      // continuable, which a digest cannot do. `chars` lets the caller ask for
      // more (or less) than the configured default for this one call.
      const charBudget = resolveContextBudget(params.chars);
      const ctxResult = buildTranscriptContext(detail, { charBudget });
      const sizing =
        `\n\n---\nImported from ${HARNESS_LABEL[session.harness]}: ` +
        `${ctxResult.fullMessages} recent message(s) in full, ` +
        `${ctxResult.condensedMessages} older condensed to one line, ` +
        `${ctxResult.omittedMessages} omitted, ` +
        `${ctxResult.toolResultsCompressed} tool results compressed. ` +
        `~${ctxResult.estimatedTokens.toLocaleString()} tokens (budget ${Math.round(charBudget / 1000)}k chars). ` +
        `If you need more, call again with a higher "chars" argument.`;
      return {
        content: [{ type: "text" as const, text: ctxResult.markdown + sizing }],
        details: {
          uid: session.uid,
          harness: session.harness,
          mode: "transcript",
          includedMessages: ctxResult.includedMessages,
          omittedMessages: ctxResult.omittedMessages,
          estimatedTokens: ctxResult.estimatedTokens,
        },
      };
    },
  });

  /** Compact but informative block used by session_hub_search results. */
  function formatSessionBlock(s: ExternalSession): string {
    const changed = s.fidelity.filesChanged;
    const lines = [
      `- id: ${s.uid}`,
      `  harness: ${HARNESS_LABEL[s.harness]}`,
      `  title: ${s.title ?? "(none)"}`,
      `  updated: ${s.updatedAt ?? "unknown"}`,
      `  project: ${s.repo ?? s.cwd ?? "unknown"}`,
      `  model: ${s.model ?? "unknown"}`,
      `  messages: ${s.messageCount}${s.toolCount ? `  tool calls: ${s.toolCount}` : ""}`,
      `  first user message: ${s.preview ?? "not available"}`,
      `  changed files: ${
        changed === null
          ? "not available"
          : changed.length
            ? changed.slice(0, 5).join(", ")
            : "none recorded"
      }`,
    ];
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- helpers

  function findSession(uidOrPrefix: string): ExternalSession | null {
    const q = uidOrPrefix.trim().toLowerCase();
    if (!q) return null;
    return (
      sessions.find((s) => s.uid.toLowerCase() === q) ??
      sessions.find((s) => s.nativeId.toLowerCase() === q) ??
      sessions.find((s) => s.uid.toLowerCase().startsWith(q)) ??
      sessions.find((s) => s.uid.toLowerCase().includes(q)) ??
      null
    );
  }

  function parseSearchArgs(args: string): {
    text: string | undefined;
    harness: HarnessId | null;
    limit: number;
  } {
    const tokens = args.split(/\s+/).filter(Boolean);
    let harness: HarnessId | null = null;
    let limit = 25;
    const rest: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (tok === "--harness" && tokens[i + 1]) {
        const candidate = tokens[i + 1]!.toLowerCase();
        if ((HARNESS_ORDER as string[]).includes(candidate)) {
          harness = candidate as HarnessId;
        }
        i++;
        continue;
      }
      if (tok.startsWith("--harness=")) {
        const candidate = tok.slice("--harness=".length).toLowerCase();
        if ((HARNESS_ORDER as string[]).includes(candidate)) harness = candidate as HarnessId;
        continue;
      }
      if (tok === "--limit" && tokens[i + 1]) {
        const n = Number.parseInt(tokens[i + 1]!, 10);
        if (!Number.isNaN(n)) limit = Math.max(1, Math.min(n, 200));
        i++;
        continue;
      }
      rest.push(tok);
    }
    const text = rest.join(" ").trim();
    return { text: text || undefined, harness, limit };
  }

  // Keep the index fresh across session reloads without blocking startup.
  pi.on("session_start", async () => {
    try {
      await getIndex();
    } catch {
      /* non-fatal */
    }
  });
}
