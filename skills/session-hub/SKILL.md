---
name: session-hub
description: Search and reuse past coding-agent sessions across harnesses (Pi, Claude Code, Codex, OpenCode, Crush, JCode). Use when the user asks which session they worked on something in, wants to find prior context, wants to continue work from another tool, or asks "where did I do X" / "in what chat did I fix Y".
---

# Session Hub

`pi-session-hub` indexes the local session stores of every coding harness on this
machine and exposes them through one list.

## When to use it

Reach for the hub when the user:

- asks which session they worked on something in ("where did I implement the db layer?")
- wants prior context before starting new work
- wants to continue a conversation that started in another tool
- asks what they were doing on a project recently

Do **not** use it for reading project source files. It reads agent transcripts, not
code.

## Tools and commands

| Surface | Use |
|---|---|
| `session_hub_search` tool | Search the local index. Preferred: you can call it directly. |
| `/session-hub` | Open the interactive two-pane browser (also `/hub`, or `alt+r`). |
| `/session-search <query>` | Same search, printed into the chat. Supports `--harness <id>` and `--limit <n>`. |
| `/session-open <id>` | Read-only metadata + transcript preview. |
| `/session-handoff <id>` | Handoff draft in the editor, to review before sending. |
| `/session-native <id>` | Resume the session in its original harness. Asks for confirmation first. |

In the hub, `Enter` loads the selected session's conversation into the current chat
as a collapsed `imported transcript` message. The context is tiered and budgeted
(~10k tokens by default): recent turns verbatim, older ones condensed to one line,
tool output compressed, and anything omitted is counted rather than hidden. `v`
reads the transcript for free, `o` switches Pi to a Pi session, `n` reopens it in
its original tool. The hub is a full-screen replacement UI; `?` shows the keyboard
reference.

Harness ids: `pi`, `claude-code`, `codex`, `opencode`, `crush`, `jcode`.

## Search query syntax

- bare terms use prefix matching: `pliego` matches `pliego-prod`
- `"exact phrase"` for phrases
- `-term` to exclude

## Working rules

1. **Never claim a session is Pi-native when it is not.** Session ids are namespaced
   `harness:nativeId`. Report the harness honestly.
2. **Prefer loading the context over pasting transcript text.** `Enter` in the hub
   (or `session_hub_context`) produces a structured document that is labelled as
   imported and lists what the source could not provide.
3. **Respect "not available".** Some sources do not record changed files, commands or
   working directories. Report that as unavailable rather than guessing.
4. **`/session-native` for OpenCode is intentionally unavailable.** There is no
   verified resume-by-id command, so the hub refuses rather than inventing one.
5. **Nothing outside `~/.pi/agent/pi-session-hub/` is written.** Do not attempt to
   modify any harness's session store.

## Rebuilding the index

The index is rebuilt automatically when empty. To force a refresh, open `/session-hub`
and press `r`. The index lives at `~/.pi/agent/pi-session-hub/index.sqlite`.
