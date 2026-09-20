# pi-session-hub

One list for every coding-agent session on your machine.

`pi-session-hub` indexes the local session stores of **Pi, Claude Code, Codex,
OpenCode, Crush and JCode** and gives you a single TUI to browse, search, preview
and reuse them. It is the cross-harness `/resume` that Pi does not ship with.

```
+-- Session Hub ------------------------------------------- 429 sessions ------+
|  search: pliego█          [0 all] [1 pi:3] [2 cc:74] [3 cx:4] [4 oc:286] .. |
+------------------------------------+----------------------------------------+
| > * 35m ago  pliego-lab  gpt-5.6   |  ◆ JCode  session_penguin_178985790...  |
|   El usuario pidió cerrar el server|  -------------------------------------- |
| > * 34m ago  pliego-lab  gpt-5.6   |  when     19 sep 19:45 -> 20 sep 14:56 |
|   Validá sin editar ni commitear   |  repo     ~/Projects/pliego-lab        |
| > π 40m ago  pliego-prod  deepseek |  model    gpt-5.6-luna                 |
|   OKay.. en mi proyecto de pliego  |  messages 15  tools 5                  |
|                                    |  changed  4 file(s)                    |
|                                    |  transcript preview                    |
|                                    |   user  cerrá el server de pliego lab  |
+------------------------------------+----------------------------------------+
|  ↑↓ move · tab pane · enter open · h handoff · n native · / search · esc     |
+----------------------------------------------------------------------------+
```

## Install

```bash
pi install /path/to/pi-session-hub
```

Or try it without installing:

```bash
pi -e /path/to/pi-session-hub
```

No dependencies, no native modules, no network. Requires Node 22.5+ (uses the
built-in `node:sqlite` with FTS5).

## Usage

| Command | What it does |
|---|---|
| `/session-hub` (or `/hub`, or `alt+r`) | Interactive browser across every harness |
| `/session-search <query>` | Search the local index, printed into the chat |
| `/session-open <id>` | Read-only metadata and transcript preview |
| `/session-handoff <id>` | New Pi session seeded with an imported context document |
| `/session-native <id>` | Resume in the original harness (confirmation first) |

### What `Enter` does

Selecting a session loads its conversation **into the chat you are already in**, so
the next thing you type has it. It is deliberately *not* a session switch: your
current chat is never replaced, and it works identically from `/session-hub` and
from the `alt+r` shortcut.

```
 imported transcript  ◆ JCode  102/804 messages  ·  ~8,172 tokens
 source: ~/.jcode/sessions/session_sauropod_1789838887910_ee0399e551863ce9.json
 - Original objective: okay ahora lo que tenemos que hacer para prepararnos a salir...
 expand this message to read the imported transcript
```

It is collapsed by default and expands to the whole imported context.

### How much context it loads (the important part)

Loading the *entire* conversation would be wasteful, and the cost would grow
without bound as sessions get longer. So the context is **tiered, with a hard
budget**:

| Tier | What it contains | Cost |
|---|---|---|
| 1. Header | objective, repo, model, files changed/read, commands run, tool usage | ~1k chars, always |
| 2. Recent tail | the last turns **verbatim** — this is what you continue from | up to 26k chars |
| 3. Earlier | one line per older message, so the shape of the conversation survives | remainder |
| 4. Omitted | a count, never silence | 0 |

Measured on real sessions with the default 40k-character budget (~10k tokens):

| Session | Source messages | In full | Condensed | Omitted | Cost |
|---|---|---|---|---|---|
| JCode, i18n work | 804 (102 with text) | 73 | 29 | 0 | ~8.2k tokens |
| Pi, pliego-prod | 413 (291 with text) | 111 | 69 | 111 | ~9.8k tokens |
| Claude Code, ComfyUI | 49 (6 with text) | 6 | 0 | 0 | ~2.9k tokens |

Two things make this affordable:

- **Tool output is compressed to a short preview in every tier.** Measured here, tool
  output was 90% of the bytes in a 291-message session and is the least useful part
  for resuming work.
- **The tail is protected, not the head.** If the budget runs out, the *oldest*
  messages are condensed or dropped and the document says how many. Losing the tail
  is what would make continuation fail.

Cost is reported in the notification every time, so you always know what it spent.

### Tuning it

```json
// ~/.pi/agent/settings.json
{
  "sessionHub": {
    "contextChars": 40000
  }
}
```

40000 is the default (~10k tokens). Raise it if you want more of a long session
verbatim, lower it if you want to spend less. It is a ceiling, not a target: a short
session costs far less.

For a zero-token look at any session, use `v` (read-only transcript viewer).

There are also two tools so the agent can work with your history on its own:

- `session_hub_search` finds sessions when you ask "where did I do X?"
- `session_hub_context` loads the full context document for one session, so the
  agent can actually pick up work that started in another tool.

Every row states its harness in words, not just a glyph, and a legend at the top
decodes the colours:

```
  π Pi  ✻ Claude Code  ⬡ Codex  ⌘ OpenCode  ❯ Crush  ◆ JCode
  [0 all] [1 pi:4] [2 cc:74] [3 cx:4] [4 oc:286] [5 cr:1] [6 jc:61]
▸▌Claude Code   19 sep 17:24  gateton  claude-sonnet-5
 ▌  SamplerCustomAdvanced shape mismatch error
 ▌JCode         49m ago       pliego-lab  gpt-5.6-luna
 ▌  El usuario pidió cerrar el server de Pliego Lab...
```

### Inside the hub

The hub is a **full-screen replacement UI**, not a floating overlay: it takes over
the whole terminal instead of hovering over the chat.

```
┌ SESSION HUB ─────────────────────────────────────────────────── 434 sessions ┐
│ ⌕ search…            all [1 pi 8] [2 cc 74] [3 cx 4] [4 oc 286] [5 cr 1] …   │
├───────────────────────────────────────┬───────────────────────────────────────┤
│   HARNESS     UPDATED   PROJECT       │ ◆ JCode                               │
│ ▸▎JCode       3h        pliego-lab    │ ───────────────────────────────────── │
│   ▎El usuario pidió cerrar el server… │  when     2026-09-19 17:28 ▸ 17:28    │
│  ▎Pi          3h        Projects      │  repo     ~/Projects/Silly-Gateton    │
│   ▎de que estabamos hablando?         │  messages 804   tools 337             │
│                                       │  TRANSCRIPT 73 full · 29 condensed    │
│  1-10 of 434  ↓ more                  │   ▎ user  okay ahora lo que tenemos…  │
├───────────────────────────────────────┴───────────────────────────────────────┤
│ π Pi 8  │ ✻ Claude Code 74  │ ⬡ Codex 4  │ ⌘ OpenCode 286  │ ❯ Crush 1  │ ◆ …  │
│ ↑↓ move  ⇥ pane  ⏎ load context  v view  o open in place  h draft  n native  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Harness symbols are plain Unicode, not emoji, so they render in any font:
`π` Pi · `✻` Claude Code · `⬡` Codex · `⌘` OpenCode · `❯` Crush · `◆` JCode.

**For a true alternate-screen takeover**, set Pi's own fullscreen mode:

```json
// ~/.pi/agent/settings.json
{ "tuiMode": "fullscreen" }
```

In the default `regular` mode the hub still replaces the UI area, but Pi's
scrollback stays visible around it. `fullscreen` is what makes it feel like a real
application.

| Key | Action |
|---|---|
| `↑` `↓` | move |
| `Tab` | switch pane (list / transcript) |
| `?` | keyboard reference |
| `Enter` | **Load this session's context into the current chat** so you can continue |
| `v` | Read the full transcript (read-only) |
| `o` | Open in place: switch Pi to that session (Pi only, needs `/session-hub`) |
| `h` | Handoff draft in the editor (review before sending) |
| `n` | resume in the native harness |
| `/` | search |
| `f` | filter by touched file |
| `p` | cycle project/repo filter |
| `0`-`6` | filter by harness (`0` clears) |
| `r` | reindex |
| `Esc` / `q` | close |

Also: `page up/down`, `home`/`end`, and `j`/`k` work as expected. The list shows a
position indicator (`1-10 of 434`) and the detail pane scrolls independently with
`Tab` then `↑`/`↓`.

## What it reads

| Harness | Store | Format |
|---|---|---|
| Pi | `~/.pi/agent/sessions/--<cwd>--/*.jsonl` | JSONL tree v3 |
| Claude Code | `~/.claude/projects/<slug>/*.jsonl` | JSONL (undocumented) |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL (undocumented) |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite |
| Crush | `~/.crush/crush.db` | SQLite |
| JCode | `~/.jcode/sessions/*.json` | JSON |

Each harness gets its own adapter. A missing, empty or unreadable store degrades to
a specific message ("no store at ...", "cannot read ...") instead of an empty list,
and one broken adapter never takes down the others.

## The two rules

### 1. Nothing outside the index is written

The only writable path is `~/.pi/agent/pi-session-hub/`. Every harness store is
opened read-only, including the SQLite databases. The test suite fingerprints every
external store before and after a full scan and fails if anything changed.

### 2. External sessions are never disguised as Pi sessions

A Claude, Codex, OpenCode, Crush or JCode conversation is **never** converted into a
Pi session file that pretends Pi created it. There are exactly two paths:

- **Native resume** (`n`): reopen the session in its own harness, using its own
  command. Every command states its verification basis in the confirmation dialog
  (`cli-help` means the flag is documented in that tool's own `--help`). All six
  harnesses have one. The single exception is Claude sub-agent transcripts, whose
  ids `claude --resume` does not accept, so the hub refuses instead of handing you
  a command that would fail.
- **Cross-harness handoff** (`h`): create a *new* Pi session containing an
  `# Imported Session Handoff` document, with the real source harness, id and path.

The handoff is generated locally and deterministically. No LLM, no network, no
uploading transcripts anywhere. Fields the source format cannot supply are written
as `not available` rather than guessed, and the document says so explicitly.

Example handoff header:

```markdown
# Imported Session Handoff

- Source harness: Claude Code
- Source session ID: 97c73be2-fb17-4f62-a7b5-e9b99ff41f47
- Source path: /home/gateton/.claude/projects/-home-gateton/97c73be2-....jsonl
- Project/repository: /home/gateton
- Original objective: me sale este error Node threw an error during execution...
- Decisions already made: Con `nvidia-smi` veo el problema de fondo...
- Files changed/read: 2 changed, 3 read
- Commands/tests and results: `find ~/Downloads -iname "*minimax*h3*i2v*"`
- Current working-tree status: not available
- Unresolved issues: unknown: the source transcript has no structured issue tracker
```

## Privacy

- The index is local: `~/.pi/agent/pi-session-hub/index.sqlite`.
- Credential stores are never read. `auth.json`, `.credentials.json`, `.env`,
  `request_dump_*` and similar are denied by name before any open is attempted.
- Transcript text is passed through a redactor (Bearer tokens, `sk-` keys, JWTs,
  `api_key=`/`password=` patterns) before being stored or written into a handoff.
- The FTS index stores a **bounded excerpt of the conversation** per session
  (20k characters, sampled from both the start and the end) plus titles and
  metadata, so search can answer "where did we discuss X" rather than only
  matching titles. It is a second local copy of some conversation text: if you
  back up `~/.pi`, the index goes with it. Delete
  `~/.pi/agent/pi-session-hub/index.sqlite` to remove it; it is rebuilt on the
  next scan.

## Architecture

```
extensions/session-hub.ts   command/shortcut/tool wiring
src/adapters/               one adapter per harness (read-only)
src/index/                  local SQLite + FTS5 index
src/handoff.ts              deterministic handoff document
src/native.ts               native resume resolve + launch
src/security.ts             path guards + secret redaction
src/tui/                    two-pane hub component
skills/session-hub/         agent-facing skill
```

Adding a harness means adding one file under `src/adapters/` that implements
`SessionAdapter` and registering it in `src/adapters/registry.ts`.

## Publishing

The [Pi package gallery](https://pi.dev/packages) indexes npm automatically: it
lists every package tagged with the `pi-package` keyword. There is no submission
form, no review, and no repository template to follow. Publish to npm and the
gallery picks it up within minutes.

```bash
npm login                 # once, interactive (browser / 2FA)
npm publish               # publishes pi-session-hub
```

Then anyone can install it:

```bash
pi install npm:pi-session-hub
```

What the listing needs, and what this repo already has:

| Requirement | Status |
|---|---|
| `"pi-package"` in `keywords` | yes |
| A `pi` manifest in `package.json` (or conventional `extensions/`, `skills/` dirs) | yes, both |
| A `description` (shown on the gallery card) | yes |
| `repository` / `homepage` / `bugs` (the card links to the repo) | yes |

Optional gallery preview, if you want a card image or video:

```json
{
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "image": "https://.../screenshot.png"
  }
}
```

To ship a change: bump `version` and run `npm publish` again.

Before publishing, verify the artifact rather than the repo:

```bash
npm pack --dry-run         # inspect exactly what ships
npm pack && tar xzf pi-session-hub-*.tgz
pi -e ./package            # load the packed package the way npm would
```

## Development

```bash
node test/smoke.mjs        # exercise every adapter against real stores
node test/acceptance.mjs   # full requirement suite (68 checks)
```

The acceptance suite asserts, among other things: index counts equal detected
counts, FTS rows equal session rows with no orphans, uids are unique, the handoff
contains every required field, unavailable fields are reported honestly, OpenCode
refuses to invent a resume command, and no external store file is modified.

## Verified against the running binary

The injection path is not guesswork. Measured behaviour:

| API | Visible in transcript | In LLM context |
|---|---|---|
| `pi.sendMessage` | yes | yes |
| `pi.appendEntry` | yes | no |
| `ctx.sessionManager.appendCustomMessageEntry` | no | yes |

`pi.sendMessage` is the only one that does both, and it lives on the extension API
rather than the command context, so it also works from a keyboard shortcut.

## Failure behaviour

Two failure modes are explicitly designed against, because both are worse than a
crash:

- **A failed read is never reported as "no sessions".** Reads throw, and the error
  is surfaced in the UI and in tool results. An unreadable index and an empty index
  are different messages.
- **A failing adapter never deletes data.** Sessions are only dropped from the index
  for harnesses that were actually read successfully this pass, so one transient
  failure cannot wipe that harness's history.

Both are covered by regression tests.

## Limitations

- **Claude Code and Codex formats are undocumented.** Parsers are defensive and
  degrade to filename-derived metadata rather than throwing, but a format change may
  cost fields until the adapter is updated.
- **Crush does not record a session working directory**, so those sessions show no
  repo and cannot be filtered by project.
- **Transcripts are capped** at roughly 2000 messages per session by the reader's
  budget. When that happens the viewer says so rather than silently truncating.
- **Search covers a bounded excerpt**, not the entire history of a very long
  session. Phrases from beyond the sampled window will not match.
- **Claude sub-agent transcripts** are indexed (they contain real work) but are
  marked as not resumable and carry their parent session id in the notes.
- The hub shows metadata and previews. It is a context router, not a full transcript
  viewer.
