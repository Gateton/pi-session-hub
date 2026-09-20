/**
 * Build a synthetic "another user" home directory.
 *
 * This exists to prove portability rather than assert it: every adapter must
 * discover and index sessions from a home it has never seen, with no reference
 * to the developer's machine. Paths here are deliberately unlike this machine's
 * (different project names, different timestamps).
 */

import fs from "node:fs";
import path from "node:path";
import { openIndexDb } from "../../src/sqlite.ts";

const UUID = "11111111-2222-3333-4444-555555555555";
const PROJECT = "/srv/work/acme-api";
const T0 = "2026-01-01T00:00:00.000Z";

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function jsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

export async function buildFakeHome(home) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });

  // ---- Pi
  const piDir = path.join(home, ".pi", "agent", "sessions", "--srv-work-acme-api--");
  write(
    path.join(piDir, `2026-01-01T00-00-00-000Z_${UUID}.jsonl`),
    jsonl([
      { type: "session", version: 3, id: UUID, timestamp: T0, cwd: PROJECT },
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: T0,
        message: { role: "user", content: "fake pi: wire up the billing endpoint" },
      },
      {
        type: "message",
        id: "a2",
        parentId: "a1",
        timestamp: T0,
        message: {
          role: "assistant",
          model: "fake-model-1",
          content: [{ type: "text", text: "fake pi reply: added the billing route plus a regression test" }],
        },
      },
    ]),
  );
  write(
    path.join(home, ".pi", "agent", "settings.json"),
    JSON.stringify({ theme: "dark", sessionHub: { contextChars: 20000 } }, null, 2),
  );

  // ---- Claude Code
  const claudeDir = path.join(home, ".claude", "projects", "-srv-work-acme-api");
  write(
    path.join(claudeDir, `${UUID}.jsonl`),
    jsonl([
      {
        type: "user",
        sessionId: UUID,
        cwd: PROJECT,
        timestamp: T0,
        message: { role: "user", content: "fake claude: the migration keeps timing out" },
      },
      {
        type: "assistant",
        sessionId: UUID,
        cwd: PROJECT,
        timestamp: T0,
        message: {
          role: "assistant",
          model: "fake-claude-model",
          content: [{ type: "text", text: "fake claude reply: added a partial index on created_at" }],
        },
      },
      { type: "ai-title", sessionId: UUID, title: "Fake Claude Session" },
    ]),
  );

  // ---- Codex
  const codexDir = path.join(home, ".codex", "sessions", "2026", "01", "01");
  write(
    path.join(codexDir, `rollout-2026-01-01T00-00-00-${UUID}.jsonl`),
    jsonl([
      {
        timestamp: T0,
        type: "session_meta",
        payload: { session_id: UUID, cwd: PROJECT, cli_version: "0.0.0-fake", timestamp: T0 },
      },
      { timestamp: T0, type: "turn_context", payload: { model: "fake-codex-model", cwd: PROJECT } },
      {
        timestamp: T0,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "fake codex: port the worker to the new queue" }],
        },
      },
      {
        timestamp: T0,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "fake codex reply: ported the worker with backpressure" }],
        },
      },
    ]),
  );

  // ---- JCode
  write(
    path.join(home, ".jcode", "sessions", "session_fake_1.json"),
    JSON.stringify({
      id: "session_fake_1",
      title: "Fake JCode Session",
      created_at: T0,
      updated_at: T0,
      working_dir: PROJECT,
      model: "fake-jcode-model",
      provider_key: "fake-provider",
      messages: [
        { role: "user", content: [{ type: "text", text: "fake jcode: refactor the config loader" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "edit", input: { file_path: `${PROJECT}/config.ts` } },
            { type: "text", text: "fake jcode reply: split it into two cohesive modules" },
          ],
        },
      ],
    }),
  );

  // ---- Crush (SQLite)
  const crushDir = path.join(home, ".crush");
  fs.mkdirSync(crushDir, { recursive: true });
  const crush = await openIndexDb(path.join(crushDir, "crush.db"));
  crush.run(
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0, cost REAL DEFAULT 0, updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, summary_message_id TEXT, todos TEXT)`,
  );
  crush.run(
    `CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
      parts TEXT NOT NULL DEFAULT '[]', model TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, finished_at INTEGER, provider TEXT,
      is_summary_message INTEGER DEFAULT 0, prism_model_id TEXT, prism_model_name TEXT,
      prism_hypercredit_savings REAL, prism_dollar_savings REAL)`,
  );
  crush.run(
    `CREATE TABLE files (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL,
      content TEXT NOT NULL, version INTEGER DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL)`,
  );
  crush.run(
    `CREATE TABLE read_files (session_id TEXT NOT NULL, path TEXT NOT NULL, read_at INTEGER NOT NULL,
      PRIMARY KEY (path, session_id))`,
  );
  const secs = Math.floor(Date.parse(T0) / 1000);
  crush.run(
    "INSERT INTO sessions (id,title,message_count,created_at,updated_at) VALUES (?,?,?,?,?)",
    ["crush-fake-1", "Fake Crush Session", 2, secs, secs],
  );
  crush.run(
    "INSERT INTO messages (id,session_id,role,parts,model,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    [
      "m1",
      "crush-fake-1",
      "user",
      JSON.stringify([{ type: "text", data: { text: "fake crush: add retries to the uploader" } }]),
      null,
      secs,
      secs,
    ],
  );
  crush.run(
    "INSERT INTO messages (id,session_id,role,parts,model,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    [
      "m2",
      "crush-fake-1",
      "assistant",
      JSON.stringify([{ type: "text", data: { text: "fake crush reply: added exponential backoff and jitter" } }]),
      "fake-crush-model",
      secs,
      secs,
    ],
  );
  crush.run("INSERT INTO files (id,session_id,path,content,created_at,updated_at) VALUES (?,?,?,?,?,?)", [
    "f1",
    "crush-fake-1",
    `${PROJECT}/uploader.ts`,
    "x",
    secs,
    secs,
  ]);
  crush.run("INSERT INTO read_files (session_id,path,read_at) VALUES (?,?,?)", [
    "crush-fake-1",
    `${PROJECT}/README.md`,
    secs,
  ]);
  crush.close();

  // ---- OpenCode (SQLite)
  const ocDir = path.join(home, ".local", "share", "opencode");
  fs.mkdirSync(ocDir, { recursive: true });
  const oc = await openIndexDb(path.join(ocDir, "opencode.db"));
  oc.run(
    `CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
      share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      summary_diffs TEXT, revert TEXT, permission TEXT, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, time_compacting INTEGER, time_archived INTEGER,
      workspace_id TEXT, path TEXT, agent TEXT, model TEXT, cost REAL DEFAULT 0,
      tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
      tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0,
      tokens_cache_write INTEGER DEFAULT 0, metadata TEXT)`,
  );
  oc.run(
    `CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL)`,
  );
  oc.run(
    `CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`,
  );
  oc.run("CREATE INDEX part_session_idx ON part (session_id)");
  const ms = Date.parse(T0);
  oc.run(
    `INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated,model)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      "ses_fake_1",
      "proj-fake",
      "fake",
      PROJECT,
      "Fake OpenCode Session",
      "1.0.0",
      ms,
      ms,
      JSON.stringify({ id: "fake-opencode-model", providerID: "fake-provider" }),
    ],
  );
  oc.run("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)", [
    "msg1",
    "ses_fake_1",
    ms,
    ms,
    JSON.stringify({ role: "user", time: ms }),
  ]);
  oc.run("INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)", [
    "p1",
    "msg1",
    "ses_fake_1",
    ms,
    ms,
    JSON.stringify({ type: "text", text: "fake opencode: make the search faster" }),
  ]);
  oc.run("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)", [
    "msg2",
    "ses_fake_1",
    ms + 1,
    ms + 1,
    JSON.stringify({ role: "assistant", time: ms + 1 }),
  ]);
  oc.run("INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)", [
    "p2",
    "msg2",
    "ses_fake_1",
    ms + 1,
    ms + 1,
    JSON.stringify({ type: "text", text: "fake opencode reply: added a covering index on title" }),
  ]);
  oc.close();

  return { home, project: PROJECT, uuid: UUID };
}
