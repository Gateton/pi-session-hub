/**
 * Build a demo home with sessions from all six harnesses.
 *
 * Used only to produce screenshots. It writes a synthetic home so the hub can be
 * captured showing every adapter at once; the real user's sessions are never
 * touched. Point the hub at it with PI_SESSION_HUB_HOME.
 *
 * Usage: node test/tools/demo-home.mjs /tmp/session-hub-demo
 */

import fs from "node:fs";
import path from "node:path";
import { openIndexDb } from "../../src/sqlite.ts";

const home = process.argv[2] ?? "/tmp/session-hub-demo";

const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const iso = (day, hour, min) =>
  `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00.000Z`;

const PI = [
  ["a1b2c3d4-1111-4000-8000-000000000001", "Add a language switcher to Settings",
   "the app is Spanish only and we need English too before going public",
   "I'll add an i18n layer, extract the 75 UI files, and wire a selector into Settings.",
   "/srv/work/atlas-web", 20, 14],
  ["a1b2c3d4-1111-4000-8000-000000000002", "Flaky checkout test on CI",
   "the checkout test passes locally and fails about one run in five on CI",
   "It was a race on the shared fixture. I isolated the fixture and added a deterministic clock.",
   "/srv/work/atlas-web", 20, 11],
  ["a1b2c3d4-1111-4000-8000-000000000003", "Migrate auth to the new SDK",
   "we should move off the hand-rolled token refresh onto the vendor SDK",
   "Ported the refresh path, kept the old endpoint behind a flag, and added contract tests.",
   "/srv/work/atlas-api", 19, 16],
];

const CLAUDE = [
  ["b2c3d4e5-2222-4000-8000-000000000001", "Refactor the billing module",
   "the billing module has grown to 1400 lines and nobody wants to touch it",
   "Split it into pricing, invoicing and dunning. Behaviour is unchanged; 212 tests still pass.",
   "/srv/work/atlas-api", 20, 12],
  ["b2c3d4e5-2222-4000-8000-000000000002", "Dashboard query takes 9 seconds",
   "the dashboard is unusable, the main query takes about nine seconds",
   "Added a composite index on (tenant_id, created_at) and dropped two N+1 lookups. Down to 180ms.",
   "/srv/work/atlas-web", 19, 15],
  ["b2c3d4e5-2222-4000-8000-000000000003", "Harden the upload endpoint",
   "we accept any file size and any mime type, that cannot ship",
   "Added a size cap, a mime allowlist and streaming validation. Wrote three tests for the rejects.",
   "/srv/work/atlas-api", 18, 10],
];

const CODEX = [
  ["c3d4e5f6-3333-4000-8000-000000000001", "Port the worker to the new queue",
   "move the ingestion worker off the old queue onto the new one",
   "Ported the worker with backpressure and idempotent retries. Benchmarks are in the report.",
   "/srv/work/atlas-ingest", 20, 9],
  ["c3d4e5f6-3333-4000-8000-000000000002", "Review the migration plan",
   "read docs/migration.md and tell me what will break in production",
   "Two blockers: the backfill has no rate limit, and step 4 drops a column still read by v1 clients.",
   "/srv/work/atlas-api", 18, 17],
];

const JCODE = [
  ["session_demo_jcode_1", "Prepare the public release checklist",
   "we want to open source this, what do we need before publishing",
   "Wrote PUBLIC_RELEASE_CHECKLIST.md: licence, secret scan, CONTRIBUTING, and a clean git history.",
   "/srv/work/atlas-web", 20, 16],
  ["session_demo_jcode_2", "Split the config loader",
   "the config loader mixes env parsing, file reading and validation",
   "Split it into three cohesive modules and kept the public API stable.",
   "/srv/work/atlas-api", 19, 11],
];

const OPENCODE = [
  ["ses_demo_opencode_1", "Interactive tutorial for clinicians",
   "build a step by step interactive tutorial for the clinical staff",
   "Built the tutorial shell with five steps and persisted progress per user.",
   "/srv/work/clinic-frontend", 20, 15],
  ["ses_demo_opencode_2", "Payment reconciliation report",
   "finance needs a monthly reconciliation report they can export",
   "Added the report endpoint with CSV export and a nightly reconciliation job.",
   "/srv/work/clinic-api", 19, 9],
  ["ses_demo_opencode_3", "Accessibility pass on the booking flow",
   "the booking flow fails our accessibility audit",
   "Fixed focus order, added labels to six controls and made the calendar keyboard navigable.",
   "/srv/work/clinic-frontend", 18, 13],
];

const CRUSH = [
  ["crush-demo-1", "Add retries to the uploader",
   "the uploader gives up on the first network blip",
   "Added exponential backoff with jitter, capped at five attempts, plus a dead letter path.",
   "/srv/work/atlas-ingest", 19, 18],
];

fs.rmSync(home, { recursive: true, force: true });

// ---- Pi
for (const [id, title, ask, reply, cwd, day, hour] of PI) {
  const t = iso(day, hour, 20);
  write(
    path.join(home, ".pi", "agent", "sessions", `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`, `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}-20-00-000Z_${id}.jsonl`),
    jsonl([
      { type: "session", version: 3, id, timestamp: t, cwd },
      { type: "session_info", id: "s0", parentId: null, timestamp: t, name: title },
      { type: "message", id: "a1", parentId: "s0", timestamp: t, message: { role: "user", content: ask } },
      {
        type: "message", id: "a2", parentId: "a1", timestamp: t,
        message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: reply }] },
      },
    ]),
  );
}

// ---- Claude Code
for (const [id, title, ask, reply, cwd, day, hour] of CLAUDE) {
  const t = iso(day, hour, 5);
  write(
    path.join(home, ".claude", "projects", cwd.replace(/\//g, "-"), `${id}.jsonl`),
    jsonl([
      { type: "user", sessionId: id, cwd, timestamp: t, message: { role: "user", content: ask } },
      {
        type: "assistant", sessionId: id, cwd, timestamp: t,
        message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: reply }] },
      },
      { type: "ai-title", sessionId: id, title },
    ]),
  );
}

// ---- Codex
for (const [id, title, ask, reply, cwd, day, hour] of CODEX) {
  const t = iso(day, hour, 40);
  write(
    path.join(home, ".codex", "sessions", "2026", "09", String(day).padStart(2, "0"), `rollout-2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}-40-00-${id}.jsonl`),
    jsonl([
      { timestamp: t, type: "session_meta", payload: { session_id: id, cwd, cli_version: "0.154.0", timestamp: t } },
      { timestamp: t, type: "turn_context", payload: { model: "gpt-6-astra", cwd } },
      { timestamp: t, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: ask }] } },
      { timestamp: t, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: reply }] } },
    ]),
  );
}

// ---- JCode
for (const [id, title, ask, reply, cwd, day, hour] of JCODE) {
  const t = iso(day, hour, 30);
  write(
    path.join(home, ".jcode", "sessions", `${id}.json`),
    JSON.stringify({
      id, title, created_at: t, updated_at: t, working_dir: cwd,
      model: "claude-opus-5", provider_key: "claude",
      messages: [
        { role: "user", content: [{ type: "text", text: ask }] },
        { role: "assistant", content: [{ type: "text", text: reply }] },
      ],
    }),
  );
}

// ---- OpenCode
{
  const dir = path.join(home, ".local", "share", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const db = await openIndexDb(path.join(dir, "opencode.db"));
  db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
    slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, model TEXT,
    tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.run(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.run("CREATE INDEX part_session_idx ON part (session_id)");
  for (const [id, title, ask, reply, cwd, day, hour] of OPENCODE) {
    const ms = Date.parse(iso(day, hour, 45));
    db.run(
      `INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated,model)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, "proj-demo", "demo", cwd, title, "1.0.0", ms, ms,
       JSON.stringify({ id: "deepseek-v4-pro", providerID: "opencode-go" })],
    );
    db.run("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)",
      [`${id}-m1`, id, ms, ms, JSON.stringify({ role: "user", time: ms })]);
    db.run("INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)",
      [`${id}-p1`, `${id}-m1`, id, ms, ms, JSON.stringify({ type: "text", text: ask })]);
    db.run("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)",
      [`${id}-m2`, id, ms + 1, ms + 1, JSON.stringify({ role: "assistant", time: ms + 1 })]);
    db.run("INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)",
      [`${id}-p2`, `${id}-m2`, id, ms + 1, ms + 1, JSON.stringify({ type: "text", text: reply })]);
  }
  db.close();
}

// ---- Crush
{
  const dir = path.join(home, ".crush");
  fs.mkdirSync(dir, { recursive: true });
  const db = await openIndexDb(path.join(dir, "crush.db"));
  db.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0, cost REAL DEFAULT 0, updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, summary_message_id TEXT, todos TEXT)`);
  db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
    parts TEXT NOT NULL DEFAULT '[]', model TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, finished_at INTEGER, provider TEXT,
    is_summary_message INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE files (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL,
    content TEXT NOT NULL, version INTEGER DEFAULT 0, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE read_files (session_id TEXT NOT NULL, path TEXT NOT NULL,
    read_at INTEGER NOT NULL, PRIMARY KEY (path, session_id))`);
  for (const [id, title, ask, reply, cwd, day, hour] of CRUSH) {
    const secs = Math.floor(Date.parse(iso(day, hour, 50)) / 1000);
    db.run("INSERT INTO sessions (id,title,message_count,created_at,updated_at) VALUES (?,?,?,?,?)",
      [id, title, 2, secs, secs]);
    db.run("INSERT INTO messages (id,session_id,role,parts,model,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      [`${id}-m1`, id, "user", JSON.stringify([{ type: "text", data: { text: ask } }]), null, secs, secs]);
    db.run("INSERT INTO messages (id,session_id,role,parts,model,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      [`${id}-m2`, id, "assistant", JSON.stringify([{ type: "text", data: { text: reply } }]), "deepseek-v4-flash", secs + 1, secs + 1]);
    db.run("INSERT INTO files (id,session_id,path,content,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      [`${id}-f1`, id, `${cwd}/uploader.ts`, "x", secs, secs]);
  }
  db.close();
}

const total = PI.length + CLAUDE.length + CODEX.length + JCODE.length + OPENCODE.length + CRUSH.length;
console.log(`demo home at ${home}: ${total} sessions across 6 harnesses`);
