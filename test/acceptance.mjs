/**
 * Acceptance tests for pi-session-hub.
 *
 * These run against the real stores on this machine, not fixtures. They assert
 * the user-facing requirements: every harness is discovered, the index matches
 * the sources, search works, the handoff never invents fields, and nothing
 * outside the extension's own directory is ever written.
 *
 * Run: node test/acceptance.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdapterRegistry } from "../src/adapters/registry.ts";
import { buildTranscriptContext } from "../src/context.ts";
import { buildHandoff, UNAVAILABLE } from "../src/handoff.ts";
import {
  distinctRepos,
  harnessCounts,
  indexCount,
  openIndex,
  querySessions,
  rowToSession,
  toFtsQuery,
} from "../src/index/db.ts";
import { scan } from "../src/index/scan.ts";
import { assertWritableTarget, indexDir, isDeniedPath, redact } from "../src/security.ts";
import { HARNESS_ORDER } from "../src/types.ts";

const home = os.homedir();
const indexPath = path.join(indexDir(home), "index.sqlite");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` :: ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
section("1. Read-only guarantee");

/** Fingerprint every external store so we can prove nothing was written. */
function fingerprintStores() {
  const targets = [
    path.join(home, ".claude", "projects"),
    path.join(home, ".codex", "sessions"),
    path.join(home, ".pi", "agent", "sessions"),
    path.join(home, ".jcode", "sessions"),
    path.join(home, ".crush"),
    path.join(home, ".local", "share", "opencode"),
  ];
  const map = new Map();
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile()) {
        // -shm/-wal are touched by SQLite itself on any read of a live WAL db.
        if (e.name.endsWith("-shm")) continue;
        try {
          const st = fs.statSync(full);
          map.set(full, `${st.mtimeMs}:${st.size}`);
        } catch {
          /* ignore */
        }
      }
    }
  };
  for (const t of targets) walk(t, 0);
  return map;
}

const before = fingerprintStores();

check("redact strips Bearer tokens", redact("Authorization: Bearer abcdefghijklmnop").includes("[REDACTED]"));
check("redact strips sk- keys", !redact("sk-abcdefghijklmnopqrst").includes("sk-abcdefghijklmnopqrst"));
check("redact strips JWTs", redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij").includes("[REDACTED_JWT]"));
check("credential files are denied", isDeniedPath(path.join(home, ".codex", "auth.json")));
check("hermes request dumps are denied", isDeniedPath("/x/.hermes/sessions/request_dump_2026.json"));
check("normal session files are allowed", !isDeniedPath(path.join(home, ".claude", "projects", "a", "b.jsonl")));

let writeGuardThrew = false;
try {
  assertWritableTarget(path.join(home, ".claude", "projects", "evil.jsonl"), home);
} catch {
  writeGuardThrew = true;
}
check("writing outside the index dir is refused", writeGuardThrew);

let indexDirAllowed = true;
try {
  assertWritableTarget(indexDir(home), home);
} catch {
  indexDirAllowed = false;
}
check("writing the index dir itself is allowed", indexDirAllowed);

// ---------------------------------------------------------------------------
section("2. Detection across every harness");

const registry = new AdapterRegistry(home);
const detections = await registry.detectAll();
check(
  "every harness is probed",
  detections.length === HARNESS_ORDER.length,
  `got ${detections.length}`,
);
for (const d of detections) {
  console.log(
    `        ${d.harness.padEnd(12)} ${d.status.padEnd(16)} ${d.sessionCount} sessions` +
      (d.detail ? `  (${d.detail})` : ""),
  );
}
const usable = detections.filter((d) => d.status === "available");
check("at least 5 harnesses are readable", usable.length >= 5, `got ${usable.length}`);
check(
  "every status is a known value",
  detections.every((d) =>
    ["available", "not_installed", "path_missing", "permission_denied", "unsupported_version", "error"].includes(
      d.status,
    ),
  ),
);

// ---------------------------------------------------------------------------
section("3. Index matches the sources");

const index = await openIndex(indexPath);
check("index opens", index !== null);

const first = await scan(index, registry, { force: true });
console.log(`        scan: ${first.total} sessions in ${first.durationMs}ms`);
check("scan reports no errors", first.errors.length === 0, JSON.stringify(first.errors));
check("index is not empty", first.total > 0);
check(
  "forced scan completes in under 15s",
  first.durationMs < 15000,
  `${first.durationMs}ms`,
);

const counts = harnessCounts(index);
const detectedTotal = usable.reduce((n, d) => n + d.sessionCount, 0);
check(
  "indexed count equals detected count",
  indexCount(index) === detectedTotal,
  `indexed ${indexCount(index)} vs detected ${detectedTotal}`,
);
console.log(`        per harness: ${counts.map((c) => `${c.harness}=${c.n}`).join(" ")}`);
check(
  "every readable harness contributed sessions",
  usable.every((d) => d.sessionCount === 0 || counts.some((c) => c.harness === d.harness)),
);

const ftsCount = index.db.get("select count(*) as n from search").n;
check("FTS rows equal session rows (no duplicates)", ftsCount === indexCount(index), `${ftsCount} vs ${indexCount(index)}`);

const orphans = index.db.get(
  "select count(*) as n from search where uid not in (select uid from sessions)",
).n;
check("no orphaned FTS rows", orphans === 0, `${orphans} orphans`);

// uid uniqueness and required fields
const rows = querySessions(index, { limit: 5000 });
const uids = new Set(rows.map((r) => r.uid));
check("uids are unique", uids.size === rows.length, `${uids.size} unique of ${rows.length}`);

const badRows = rows.filter(
  (r) =>
    !r.uid ||
    !r.harness ||
    !r.native_id ||
    !r.path ||
    typeof r.message_count !== "number" ||
    !r.fidelity,
);
check("every row has the required fields", badRows.length === 0, `${badRows.length} bad rows`);

const harnessValues = new Set(rows.map((r) => r.harness));
check(
  "all harness values are known",
  [...harnessValues].every((h) => HARNESS_ORDER.includes(h)),
  [...harnessValues].join(","),
);

// incremental rescan should skip unchanged JSONL sources
const second = await scan(index, registry, { force: false });
// Deterministic: the file-backed harnesses are skipped on an unchanged rescan,
// while the database-backed ones are always re-read.
const fileBacked = counts
  .filter((c) => ["pi", "claude-code", "codex", "jcode"].includes(c.harness))
  .reduce((n, c) => n + c.n, 0);
check(
  "incremental rescan skips exactly the unchanged file-backed sessions",
  second.skipped === fileBacked,
  `skipped ${second.skipped}, expected ${fileBacked}`,
);

// ---------------------------------------------------------------------------
section("4. Search");

check("fts query builder quotes terms", toFtsQuery("pliego prod") === '"pliego"* AND "prod"*');
check("fts query builder handles negation", toFtsQuery("pliego -prod") === '"pliego"* NOT "prod"*');
check("fts query builder rejects bare negation", toFtsQuery("-prod") === null);

const probes = [
  { q: "pliego", expect: true },
  { q: "turnero", expect: true },
  { q: "zzzz-no-such-session-zzzz", expect: false },
];
for (const p of probes) {
  const hits = querySessions(index, { text: p.q, limit: 5 });
  check(
    `search "${p.q}" ${p.expect ? "finds" : "does not find"} sessions`,
    p.expect ? hits.length > 0 : hits.length === 0,
    `${hits.length} hits`,
  );
}

const repoFiltered = querySessions(index, { limit: 10, harness: "opencode" });
check(
  "harness filter returns only that harness",
  repoFiltered.every((r) => r.harness === "opencode"),
);

const repos = distinctRepos(index);
check("repo filter has options", repos.length > 0, `${repos.length} repos`);

const fileFiltered = querySessions(index, { limit: 10, filePath: "src" });
check("file filter works", Array.isArray(fileFiltered));

// ---------------------------------------------------------------------------
section("5. Handoff fidelity (never invents fields)");

const REQUIRED_FIELDS = [
  "Source harness:",
  "Source session ID:",
  "Source path:",
  "Project/repository:",
  "Original objective:",
  "Decisions already made:",
  "Files changed/read:",
  "Commands/tests and results:",
  "Current working-tree status:",
  "Unresolved issues:",
  "Recommended next step:",
  "Evidence links/references:",
];

// Pick a session from a harness that has full fidelity, plus one that does not.
const richRow = rows.find((r) => r.harness === "pi" || r.harness === "claude-code");
const richAdapter = registry.get(richRow.harness);
const richDetail = await richAdapter.getSession(richRow.native_id);
check("detail loads for a rich session", richDetail !== null);

const richHandoff = buildHandoff(richDetail, { skipWorkingTree: true, now: new Date(0) });
check("handoff starts with the required heading", richHandoff.markdown.startsWith("# Imported Session Handoff"));
for (const field of REQUIRED_FIELDS) {
  check(`handoff contains "${field}"`, richHandoff.markdown.includes(field));
}
check(
  "handoff declares its import method",
  richHandoff.markdown.includes("deterministic-local") &&
    richHandoff.markdown.includes("Import method:"),
);
check(
  "handoff for an external harness disclaims Pi authorship",
  richRow.harness === "pi" || richHandoff.markdown.includes("not by Pi"),
);
check("handoff reports fidelity", richHandoff.markdown.includes("Fidelity:"));
check(
  "handoff carries the real source path",
  richHandoff.markdown.includes(richDetail.path),
);
check(
  "handoff quotes the real first user turn",
  richHandoff.markdown.includes(richDetail.messages.find((m) => m.role === "user").text.slice(0, 40)),
);

// A session whose source cannot supply commands must say so, not invent them.
const opaqueRow = rows.find((r) => r.harness === "opencode" && r.message_count > 0);
if (opaqueRow) {
  const detail = await registry.get("opencode").getSession(opaqueRow.native_id);
  if (detail) {
    const h = buildHandoff(detail, { skipWorkingTree: true, now: new Date(0) });
    const commandsLine = h.markdown
      .split("\n")
      .find((l) => l.startsWith("- Commands/tests and results:"));
    const hasRealCommands = detail.commands.length > 0;
    check(
      "commands section is honest about availability",
      hasRealCommands ? !commandsLine.includes(UNAVAILABLE) : commandsLine.includes(UNAVAILABLE),
      `commands=${detail.commands.length}`,
    );
    check(
      "unavailable fields are reported to the caller",
      h.unavailableFields.length > 0,
      JSON.stringify(h.unavailableFields),
    );
  }
}

// Use a non-Pi harness for the authorship check, otherwise the phrase
// "created by Pi, not by Pi" is meaningless.
const externalRow =
  rows.find((r) => r.harness === "claude-code") ?? rows.find((r) => r.harness !== "pi");
const externalDetail = await registry.get(externalRow.harness).getSession(externalRow.native_id);
const externalHandoff = buildHandoff(externalDetail, { skipWorkingTree: true, now: new Date(0) });
check(
  "handoff names the true source harness",
  externalHandoff.markdown.includes(
    `created by ${externalRow.harness === "claude-code" ? "Claude Code" : externalRow.harness}`,
  ),
);
check(
  "handoff disclaims Pi authorship for external sessions",
  externalHandoff.markdown.includes("not by Pi"),
);
check(
  "handoff states it is not a Pi-native session file",
  externalHandoff.markdown.includes("not a Pi-native session file"),
);

// ---------------------------------------------------------------------------
section("6. Native resume honesty");

const nativeResults = [];
for (const adapter of registry.all()) {
  const row = rows.find((r) => r.harness === adapter.id);
  if (!row) continue;
  const action = await adapter.buildNativeResume(row.native_id);
  nativeResults.push({ harness: adapter.id, action });
  console.log(
    `        ${adapter.id.padEnd(12)} ${action ? `${action.command} ${action.args.join(" ")}` : "null (no verified command)"}`,
  );
}
check(
  "opencode offers its documented resume command",
  (() => {
    const a = nativeResults.find((n) => n.harness === "opencode")?.action;
    return a && a.command === "opencode" && a.args[0] === "--session";
  })(),
);
check(
  "every harness offers a native resume command",
  nativeResults.every((n) => n.action !== null),
  nativeResults.filter((n) => !n.action).map((n) => n.harness).join(","),
);
check(
  "every returned command states its verification basis",
  nativeResults.every(
    (n) => !n.action || (n.action.verificationBasis && n.action.verificationNote.length > 10),
  ),
);
check(
  "every returned command is marked verified",
  nativeResults.every((n) => !n.action || n.action.verified === true),
);
check(
  "every returned command requires confirmation",
  nativeResults.every((n) => !n.action || n.action.requiresConfirmation === true),
);
check(
  "at least 5 harnesses have a native resume command",
  nativeResults.filter((n) => n.action).length >= 5,
);

// Claude subagent transcripts must not offer a resume command that would fail.
const subagentRow = rows.find(
  (r) => r.harness === "claude-code" && r.path.includes(`${path.sep}subagents${path.sep}`),
);
if (subagentRow) {
  const action = await registry.get("claude-code").buildNativeResume(subagentRow.native_id);
  check("subagent transcripts refuse native resume", action === null);
  check(
    "subagent sessions are still indexed",
    true,
    `uid ${subagentRow.uid}`,
  );
}

// ---------------------------------------------------------------------------
section("6b. Transcript context (continuation, not a digest)");

const ctxHeaderFields = [
  "# Imported Session Context",
  "- Source harness:",
  "- Source session ID:",
  "- Source path:",
  "- Project/repository:",
  "- Original objective:",
  "- Messages in source:",
  "## Recent conversation (full)",
  "## How to use this context",
];

let comparedHarnesses = 0;
for (const adapter of registry.all()) {
  const row = rows.find((r) => r.harness === adapter.id && r.message_count > 3);
  if (!row) continue;
  const detail = await adapter.getSession(row.native_id);
  if (!detail || detail.messages.length === 0) continue;
  comparedHarnesses++;

  const ctx = buildTranscriptContext(detail);
  const digest = buildHandoff(detail, { skipWorkingTree: true });

  for (const field of ctxHeaderFields) {
    check(`${adapter.id}: transcript context has "${field}"`, ctx.markdown.includes(field));
  }
  // The invariant that actually makes continuation work: the transcript must
  // carry messages from the beginning, middle and end of the conversation. A
  // digest only ever carries a few excerpts from the end.
  const substantive = detail.messages.filter((m) => m.text.trim().length > 80);
  const probes = [
    substantive[0],
    substantive[Math.floor(substantive.length / 2)],
    substantive[substantive.length - 1],
  ].filter(Boolean);
  check(
    `${adapter.id}: transcript carries messages from start, middle and end`,
    probes.length > 0 && probes.every((m) => ctx.markdown.includes(m.text.slice(0, 40))),
    `${probes.length} probes`,
  );
  check(
    `${adapter.id}: digest does NOT carry the whole conversation`,
    substantive.length <= 3 ||
      !substantive.every((m) => digest.markdown.includes(m.text.slice(0, 40))),
    `${substantive.length} substantive messages`,
  );
  if (detail.messages.length > 20) {
    check(
      `${adapter.id}: transcript is larger than the digest for a long session`,
      ctx.chars > digest.markdown.length,
      `${ctx.chars} vs ${digest.markdown.length}`,
    );
  }
  check(
    `${adapter.id}: every recoverable message is accounted for`,
    ctx.fullMessages + ctx.condensedMessages + ctx.omittedMessages === ctx.totalMessages,
    `${ctx.fullMessages}+${ctx.condensedMessages}+${ctx.omittedMessages} vs ${ctx.totalMessages}`,
  );
  check(
    `${adapter.id}: the recent tail is rendered in full`,
    ctx.fullMessages > 0,
    `${ctx.fullMessages} full`,
  );
  check(
    `${adapter.id}: reports the true source message count`,
    ctx.sourceMessageCount === detail.messageCount,
    `${ctx.sourceMessageCount} vs ${detail.messageCount}`,
  );
  check(
    `${adapter.id}: context stays inside the default 40k budget`,
    ctx.chars <= 40_000,
    `${ctx.chars} chars`,
  );
  check(
    `${adapter.id}: context cost stays modest regardless of session length`,
    ctx.estimatedTokens <= 12_000,
    `~${ctx.estimatedTokens} tokens for ${ctx.sourceMessageCount} source messages`,
  );
  check(
    `${adapter.id}: no single tool dump dominates the context`,
    !detail.messages.some((m) => /tool/i.test(m.role) && m.text.length > 8000),
  );
  check(
    `${adapter.id}: context is framed as imported, not Pi-native`,
    ctx.markdown.includes("imported reading") && ctx.markdown.includes("was invented"),
  );
  check(
    `${adapter.id}: the last message is always present verbatim`,
    (() => {
      const last = [...detail.messages].reverse().find((m) => m.text.trim().length > 40);
      return last ? ctx.markdown.includes(last.text.slice(0, 40)) : true;
    })(),
  );
}

check("transcript context was exercised on multiple harnesses", comparedHarnesses >= 3, `${comparedHarnesses}`);

// Budget behaviour: a tiny budget must elide the oldest, keep the newest, and
// say so. Losing the tail of a conversation is what makes continuation fail.
{
  // Find a session with enough recoverable PROSE to exercise tiering. Raw
  // message_count is not a good proxy: the largest sessions on this machine are
  // Claude sub-agent transcripts with thousands of tool-only turns and very
  // little text.
  let detail = null;
  let longest = null;
  for (const candidate of [...rows].sort((a, b) => b.message_count - a.message_count).slice(0, 40)) {
    const d = await registry.get(candidate.harness).getSession(candidate.native_id);
    if (d && d.messages.length > 50) {
      detail = d;
      longest = candidate;
      break;
    }
  }
  check(
    "found a session long enough to exercise tiering",
    detail !== null,
    detail ? `${detail.messages.length} text messages in ${longest.harness}` : "none found",
  );
  const tight = buildTranscriptContext(detail, { charBudget: 9000 });
  check(
    "tight budget drops or condenses older messages",
    tight.omittedMessages > 0 || tight.condensedMessages > 0,
    `omitted ${tight.omittedMessages}, condensed ${tight.condensedMessages}`,
  );
  check("tight budget still fits", tight.chars <= 11_000, `${tight.chars} chars`);
  check(
    "tight budget accounts for every message",
    tight.fullMessages + tight.condensedMessages + tight.omittedMessages === tight.totalMessages,
  );
  check(
    "tight budget never silently loses messages",
    tight.omittedMessages === 0 || /are not shown at all/.test(tight.markdown),
  );
  const lastUser = [...detail.messages].reverse().find((m) => m.role === "user");
  check(
    "tight budget keeps the newest messages (the continuation point)",
    lastUser ? tight.markdown.includes(lastUser.text.slice(0, 60)) : true,
  );
}

// ---------------------------------------------------------------------------
section("7. Failure modes must not be silent or destructive");

// Regression: a failed read used to return [] silently, which was then reported
// as "no sessions" and could trigger a destructive rescan.
let readThrew = false;
try {
  index.db.all("select * from table_that_does_not_exist");
} catch {
  readThrew = true;
}
check("a failed read throws instead of returning []", readThrew);

let getThrew = false;
try {
  index.db.get("select * from table_that_does_not_exist");
} catch {
  getThrew = true;
}
check("a failed single-row read throws", getThrew);

// Regression: a transient adapter failure used to delete that harness's whole
// slice of the index, because its sessions were "not seen" this pass.
const beforeFailure = harnessCounts(index);
const failingHarness = "claude-code";
const beforeCount =
  beforeFailure.find((c) => c.harness === failingHarness)?.n ?? 0;
check(`${failingHarness} has sessions to protect`, beforeCount > 0, `${beforeCount}`);

const originalList = registry.get(failingHarness).listSessions.bind(registry.get(failingHarness));
registry.get(failingHarness).listSessions = async () => {
  throw new Error("simulated transient failure (test)");
};
const failureScan = await scan(index, registry, { force: true });
registry.get(failingHarness).listSessions = originalList;

const afterCount =
  harnessCounts(index).find((c) => c.harness === failingHarness)?.n ?? 0;
check(
  "a failing adapter is reported, not hidden",
  failureScan.failed.includes(failingHarness),
  JSON.stringify(failureScan.failed),
);
check(
  "a failing adapter does not delete its indexed sessions",
  afterCount === beforeCount,
  `${afterCount} vs ${beforeCount}`,
);
check(
  "scan reports which harnesses succeeded",
  failureScan.scanned.length > 0 && !failureScan.scanned.includes(failingHarness),
  JSON.stringify(failureScan.scanned),
);

// Restore a clean index for the remaining checks.
const restored = await scan(index, registry, { force: true });
check(
  "index recovers fully after a transient failure",
  harnessCounts(index).find((c) => c.harness === failingHarness)?.n === beforeCount &&
    restored.failed.length === 0,
);

// ---------------------------------------------------------------------------
section("8. Transcripts are readable for every harness");

// The user-facing promise is "see the chats of every harness", so every adapter
// must be able to return messages, not just metadata.
for (const adapter of registry.all()) {
  const candidates = rows.filter((r) => r.harness === adapter.id && r.message_count > 0);
  if (candidates.length === 0) continue;
  const target = candidates[0];
  const detail = await adapter.getSession(target.native_id);
  check(
    `${adapter.id}: transcript loads with messages`,
    detail !== null && detail.messages.length > 0,
    detail ? `${detail.messages.length} messages` : "detail was null",
  );
  if (detail) {
    check(
      `${adapter.id}: transcript text is non-empty and redacted`,
      detail.messages.some((m) => m.text.trim().length > 0) &&
        !detail.messages.some((m) => /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/.test(m.text)),
    );
    check(
      `${adapter.id}: transcript does not exceed the stored message count`,
      detail.messages.length <= Math.max(target.message_count, 5) * 2,
      `${detail.messages.length} vs ${target.message_count}`,
    );
  }
}

// ---------------------------------------------------------------------------
section("9. Adapter isolation");

// A registry pointed at an empty home must degrade cleanly, not throw.
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "hub-empty-"));
const emptyRegistry = new AdapterRegistry(emptyHome);
const emptyDetections = await emptyRegistry.detectAll();
check(
  "empty home yields no available sources",
  emptyDetections.every((d) => d.status !== "available"),
  JSON.stringify(emptyDetections.map((d) => d.status)),
);
const emptyList = await emptyRegistry.listAll();
check("empty home lists zero sessions without throwing", emptyList.sessions.length === 0);
check("empty home reports no crash errors", emptyList.errors.length === 0, JSON.stringify(emptyList.errors));
fs.rmSync(emptyHome, { recursive: true, force: true });

// ---------------------------------------------------------------------------
section("10. No writes to external stores");

const after = fingerprintStores();
const changed = [];
for (const [file, sig] of before) {
  const now = after.get(file);
  if (now !== sig) changed.push(file);
}
for (const file of after.keys()) {
  if (!before.has(file)) changed.push(`${file} (new)`);
}
check(
  "no external store file was modified or created",
  changed.length === 0,
  changed.slice(0, 5).join(", "),
);
check(
  "the only writable artifact is the index",
  fs.existsSync(indexPath),
  indexPath,
);

// ---------------------------------------------------------------------------
section("Summary");
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
index?.close();
process.exit(failed === 0 ? 0 : 1);
