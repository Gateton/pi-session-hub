/**
 * Cross-harness handoff.
 *
 * Builds a structured context document for a NEW Pi session. The document is
 * explicitly labelled as imported, and every field is either backed by the
 * source transcript or rendered as unavailable. Nothing is invented.
 *
 * This is deliberately not a "convert the transcript into a Pi session file"
 * operation. The hub never writes a Pi session that pretends a Claude, Codex,
 * OpenCode, Crush or JCode conversation was created by Pi.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import type { PreviewMessage, SessionDetail } from "./types.ts";
import { HARNESS_LABEL, fidelityNote } from "./types.ts";
import { clip } from "./security.ts";

export const UNAVAILABLE = "not available";

export interface HandoffOptions {
  /** Skip the git status probe. Used by tests and non-repo sessions. */
  skipWorkingTree?: boolean;
  /** Max assistant excerpts quoted into the document. */
  assistantExcerpts?: number;
  now?: Date;
}

export interface HandoffResult {
  markdown: string;
  /** Fields the source could not supply, surfaced for the UI. */
  unavailableFields: string[];
}

export function buildHandoff(
  detail: SessionDetail,
  opts: HandoffOptions = {},
): HandoffResult {
  const unavailable: string[] = [];
  const mark = (value: string, field: string): string => {
    unavailable.push(field);
    return value;
  };

  const harness = HARNESS_LABEL[detail.harness] ?? detail.harness;
  const project = detail.repo ?? detail.cwd;

  // --- Original objective: the first substantive user turn.
  const firstUser = detail.messages.find(
    (m) => m.role === "user" && m.text.trim().length > 0,
  );
  const objective = firstUser
    ? clip(firstUser.text, 700)
    : mark(UNAVAILABLE, "original objective");

  // --- Decisions: quoted assistant prose, labelled as raw excerpts rather than
  // a curated summary, because we cannot verify that a decision was "made".
  const assistantTurns = detail.messages
    .filter((m) => m.role === "assistant" && m.text.trim().length > 0)
    .slice(-(opts.assistantExcerpts ?? 3));
  const decisions =
    assistantTurns.length === 0
      ? mark(UNAVAILABLE, "decisions already made")
      : assistantTurns
          .map((m, i) => (i === 0 ? clip(m.text, 500) : `    ${i + 1}. ${clip(m.text, 500)}`))
          .join("\n");

  // --- Files. Summary inline, detail indented underneath.
  const changedList = detail.fidelity.filesChanged;
  const readList = detail.fidelity.filesRead;
  const filesSummary =
    changedList === null && readList === null
      ? mark(UNAVAILABLE, "files changed/read")
      : `${changedList?.length ?? "?"} changed, ${readList?.length ?? "?"} read`;
  const filesDetail = [
    changedList === null
      ? "    changed: not available"
      : changedList.length === 0
        ? "    changed: (none recorded)"
        : ["    changed:", ...changedList.map((p) => `      - ${p}`)].join("\n"),
    readList === null
      ? "    read: not available"
      : readList.length === 0
        ? "    read: (none recorded)"
        : ["    read:", ...readList.slice(0, 40).map((p) => `      - ${p}`)].join("\n"),
  ].join("\n");

  // --- Commands and tool evidence. First command inline so the field always has
  // a value on its own line; the rest are indented underneath.
  const toolSummary = detail.tools.length
    ? detail.tools.map((t) => `${t.name} x${t.count}`).join(", ")
    : "none recorded";
  let commands: string;
  if (detail.commands.length === 0) {
    commands = mark(UNAVAILABLE, "commands and tests");
  } else {
    const [firstCmd, ...restCmds] = detail.commands;
    const head = "`" + firstCmd.replace(/`/g, "'") + "`";
    commands =
      restCmds.length === 0
        ? head
        : [head, ...restCmds.map((c) => `    - \`${c.replace(/`/g, "'")}\``)].join("\n");
  }

  // --- Working tree.
  let workingTree: string;
  if (opts.skipWorkingTree) {
    workingTree = mark(UNAVAILABLE, "current working-tree status");
  } else {
    workingTree = probeWorkingTree(project) ?? mark(UNAVAILABLE, "current working-tree status");
  }

  // --- Next step: the last user turn, which is usually the live instruction.
  const lastUser = [...detail.messages]
    .reverse()
    .find((m) => m.role === "user" && m.text.trim().length > 0);
  const nextStep = lastUser ? clip(lastUser.text, 500) : mark(UNAVAILABLE, "recommended next step");

  const unresolved = mark(
    "unknown: the source transcript has no structured issue tracker",
    "unresolved issues",
  );

  const fidelity = fidelityNote(detail.fidelity);
  const notes = detail.fidelity.notes.length
    ? detail.fidelity.notes.map((n) => `    - ${n}`).join("\n")
    : "    (none)";

  const stamp = (opts.now ?? new Date()).toISOString();

  // The disclaimer is phrased per harness so it stays true even for Pi sessions,
  // where "created by Pi, not by Pi" would be nonsense.
  const disclaimer =
    detail.harness === "pi"
      ? `This is a context package produced by pi-session-hub from a Pi transcript. It is a
summary of an existing Pi session, not a copy of it. Fields marked
"${UNAVAILABLE}" could not be recovered.`
      : `This is a context package produced by pi-session-hub from a transcript that was
created by ${harness}, not by Pi. It is not a verbatim replay of that session, and
it is not a Pi-native session file. Fields marked "${UNAVAILABLE}" could not be
recovered from the source format. Verify anything load-bearing against the
transcript path above before acting on it.`;

  const markdown = `# Imported Session Handoff

- Source harness: ${harness}
- Source session ID: ${detail.nativeId}
- Source path: ${detail.path}
- Project/repository: ${project ?? mark(UNAVAILABLE, "project/repository")}
- Original objective: ${objective}
- Decisions already made: ${decisions}
- Files changed/read: ${filesSummary}
${filesDetail}
- Commands/tests and results: ${commands}
- Tool evidence: ${toolSummary}
- Current working-tree status: ${workingTree}
- Unresolved issues: ${unresolved}
- Recommended next step: ${nextStep}
- Evidence links/references: ${detail.path}
    - harness: ${harness}
    - session: ${detail.uid}
    - messages in source: ${detail.messageCount}
    - changed files: ${changedList === null ? UNAVAILABLE : changedList.length}

---

## Import metadata

- Import method: deterministic-local (no LLM, no network)
- Imported at: ${stamp}
- Fidelity: ${fidelity}
- Source notes:
${notes}

## How to read this document

${disclaimer}
`;

  return { markdown, unavailableFields: unavailable };
}

/** Read-only git probe. Returns null when not a repo or git is unavailable. */
function probeWorkingTree(project: string | null): string | null {
  if (!project) return null;
  let dir = project;
  try {
    if (!path.isAbsolute(dir)) return null;
    const out = execFileSync("git", ["status", "--porcelain", "--branch"], {
      cwd: dir,
      timeout: 2500,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return `clean (${dir})`;
    const shown = lines.slice(0, 15).join("\n  ");
    const more = lines.length > 15 ? `\n  ...and ${lines.length - 15} more` : "";
    return `${dir}\n  ${shown}${more}`;
  } catch {
    return null;
  }
}

/** Compact one-line summary used by the search command output. */
export function oneLineSummary(m: PreviewMessage): string {
  return `${m.role}: ${clip(m.text, 120)}`;
}
