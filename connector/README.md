<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# claw-connector

Lets you drive the coding agents on your own machine (Claude Code, Codex, Cursor) from Claw and the chat
clients built on it, for example from your phone.

The connector only makes **outbound HTTPS requests** to Claw. It opens no port, and your machine needs no public address. Claw relays
the conversation and keeps an audit trail; the agent itself, your files, your checkout and your model credentials
stay on your machine.

```
phone / chat client --> Claw (remote agents) <-- connector on your machine --> agent adapter (stdio) --> your agent
```

Claw's side is documented in [claw/docs/remote-agents.md](../claw/docs/remote-agents.md); the wire contract is
`claw/packages/protocol/src/remote-agents.ts`, compiled into this package.

## Quick start

Requirements: Node.js 22 or newer, and the agent you want to expose already working on this machine (an adapter is fetched
by `npx` on first use).

```sh
npx @primusclaw/connector init          # writes a sample agents.toml
$EDITOR ~/.config/claw-connector/agents.toml   # set roots: the directories an agent may work in
npx @primusclaw/connector login --server https://claw.example.com/claw-api --identity-url https://identity.example.com
npx @primusclaw/connector run
```

(The npm scope above is a placeholder until the package is published; `npm run build` in this directory produces the
same `claw-connector` binary in `dist/cli.js`.)

`login` prints a short code and a link. Open the link on any device that is signed in to Claw, check the machine name,
and confirm. The connector then holds a rotating sign-in token (file mode 0600) and refreshes its short-lived access
token by itself. `run` keeps the connection up and stops every agent it started when you press Ctrl-C.

## agents.toml

```toml
# Everything that limits an agent lives here, on your machine. Nothing Claw sends can widen it.
server = "https://claw.example.com/claw-api"      # optional: --server / CLAW_URL
identity_url = "https://identity.example.com"     # optional: --identity-url / CLAW_IDENTITY_URL
name = "my-laptop"                                # shown to you in Claw; defaults to the host name

[[agents]]
id = "claude"
preset = "claude"                  # claude | codex | cursor, or a custom command (below)
roots = ["~/work"]                 # required: a session's directory must be inside one of these

[[agents]]
id = "codex"
preset = "codex"
roots = ["~/work/repo-a", "~/work/repo-b"]
[agents.env]                       # passed to the adapter; the model settings live here, never in Claw
OPENAI_API_KEY = "..."             # or leave your own environment / CODEX_HOME to supply it

[[agents]]
id = "mine"
kind = "my-agent"                  # a label chat clients pick an icon from
command = "my-agent-acp"           # any agent that speaks the Agent Client Protocol over stdio
args = []
ask_mode = "careful"               # the mode in which it asks before it writes (required for a custom agent)
roots = ["~/work"]
```

Presets and the adapter versions they pin (override `command` and `args` to move):

| Preset | Command | Mode every session is forced into | Modes a phone may select |
|---|---|---|---|
| `claude` | `npx @agentclientprotocol/claude-agent-acp@0.99.0` | `default` | `default`, `plan` |
| `codex` | `npx @agentclientprotocol/codex-acp@2.3.0` | `read-only` | `read-only` |
| `cursor` | `agent acp` (the Cursor CLI) | `ask` | `ask`, `plan` |
| `claude-attach` | `npx @agentclientprotocol/claude-agent-acp@0.99.0` | `default` | `default`, `plan` |

`claude-attach` does not start new conversations: it takes over Claude Code conversations that already exist on this
machine (see [Taking over an existing conversation](#taking-over-an-existing-conversation)).

An agent with no `roots` is never offered. A configuration problem is reported at start-up, not skipped.

## What the connector enforces

All of these run on your machine and fail closed.

- **Directories.** A session's working directory is resolved (symlinks included) and must be inside one of the agent's
  `roots`; otherwise no process is started and the session is closed with `cwd_outside_roots`. The agent runs in the
  resolved path.
- **Ask mode, read back.** After the adapter creates a session, the connector sets the agent's ask mode and reads the
  mode back from the adapter. Your own agent settings may start an adapter in a mode that never asks (bypass, full
  access); an adapter that does not confirm the ask mode, or that warns it will not invoke its permission callback, is
  not opened. A mode change the agent makes on its own to a mode outside the safe list is undone at once. The adapter's
  `session/resume` can reset the mode, so it is locked again after every resume.
- **Unsafe modes.** Modes in which the agent does not ask before writing (`acceptEdits`, `bypassPermissions`, Codex write and full-access
  modes, Cursor `agent`) cannot be selected from a phone. `allow_unsafe_modes = true` in `agents.toml` is the only way, and
  it is yours alone. Flags that turn a tool's own approvals off (`--force`, `--yolo`, ...) in an agent's `args` are refused
  unless that is set too.
- **Cursor.** Measured on `agent acp` 2026.10.22: in `agent` mode a shell command asks (options `allow-once`, `allow-always`,
  `reject-once`) but a file edit is applied without asking, whatever the approval setting. So the preset starts in `ask`,
  which cannot write. To use `agent` mode set `allow_unsafe_modes = true` and `ask_mode = "agent"` for that agent. Cursor
  has no `session/resume`; the connector uses `session/load` and marks the replayed history `replay: true`.
- **Permissions.** Each permission request becomes a card with the options **the adapter offered**, passed through with
  their own ids and kinds (`allow_once`, `allow_always`, `reject_once`). An answer must be one of those ids; any other is refused
  and the request stays open. An unanswered request is answered `cancelled` after 10 minutes, and a cancel,
  a close or an adapter exit answers every waiting request `cancelled`. Cursor's `cursor/create_plan` and a single
  `cursor/ask_question` are shown as cards; a question the phone cannot carry is skipped, visibly, so the agent never waits.
- **Automatic approval, by rule.** `auto_allow = [{ kind = "edit", path_glob = "docs/**" }]` (at file level or per agent) lets
  a call through without asking when its kind matches and every path it touches is inside the session directory and
  matches the glob. It uses the one-time option, never an "always" one, is decided on your machine, is written to the
  audit log and is shown on the phone. The default is no rules.
- **Credentials go over HTTPS only.** The Claw URL and the identity URL must be `https://` (`http://` is accepted only for
  localhost, for a development server); `login` and `run` refuse anything else before a token is saved or sent.
- **Existing conversations.** Taken over only when no other process holds them open, only from inside the roots, only in the
  directory the conversation itself records, and in the ask mode (see above).
- **No remote shell.** Only these commands are carried out: `session.new`, `prompt`, `cancel`, `set_mode`, `resume`,
  `close`, `decision`. Anything else is dropped and audited. Claw never sends a command line, an environment variable or a
  key.
- **What leaves the machine.** Agent output, tool calls, diffs and command output are uploaded to Claw's event store (so
  your phone can show them), after credential-shaped strings (API keys, tokens, bearer headers, private keys, JWTs) are
  masked and long tool output is cut to 8 KB. Adapter stderr never leaves; it goes to `logs/` under the state directory.
  A prompt's text is not written to the local audit log, only its hash and length.

## Taking over an existing conversation

An agent made from the `claude-attach` preset lists the Claude Code conversations on this machine whose directory is inside
its `roots`, and lets you continue one from your phone. It reports them to Claw as an opaque list (`capabilities.resumable`:
reference, title, directory, last activity, and whether anything holds it open), newest first, at most a dozen, so that a
chat client can offer a choice; `session.new` then names the chosen one (`resume_ref`). Claw and the chat client know no
product: the agent's `kind` is the label `attach`.

```toml
[[agents]]
id = "claude-attach"
preset = "claude-attach"
roots = ["~/work"]
# attach_cli = "claude"        # the command asked which sessions are open (default: claude, from PATH)
# [agents.env]
# CLAUDE_CONFIG_DIR = "/home/me/.claude"   # where the conversations live, if not the default
```

What you do: **exit the conversation in the terminal first** (`/exit`), then pick it on the phone. When you are done,
close it from the phone and continue in the terminal with `claude --resume <id>`: the turns you took on the phone are in
its history, because both sides read and append to the same transcript.

Why the terminal must be closed: Claude Code does not stop a second process from resuming a conversation that is still
open, and two writers fork the transcript; the next resume follows only one branch, so a turn is lost without any error
(measured). The connector therefore refuses to take over a conversation that another process holds open, and it checks again
before it starts the agent again after a pause and before every prompt. A prompt that meets a terminal is rejected, not sent
(the session stays, and the prompt can be sent again once the terminal is closed), and the connector's agent for the
conversation is discarded: what the terminal wrote is not in its memory, so the next prompt starts a fresh one that reads
the transcript. The same happens when the transcript is no longer the size the connector left it, which is how a terminal
that came and went between two prompts is noticed.

While the connector's own agent is working on the conversation (starting, or running a turn) the size cannot say whether
someone else wrote, because the agent's own writes grow it too. So during that time the registry is read every second and
once more, in full, when the work ends. A terminal that held the conversation open for about a second or more during a turn
is noticed even if it has exited by the next prompt: that prompt goes to a fresh agent, after the full check above. One seen
while the agent is starting refuses the takeover (`session_live`) and stops the agent. A terminal that opens and closes the
conversation between two reads, which is shorter than anything that can take a turn, is not seen.

The first thing asked is the terminal itself. `claw-connector init` (or `claw-connector hooks install`) adds two Claude Code
hooks, `SessionStart` and `SessionEnd`, to the user-level `settings.json` of the Claude config directory. Each runs a tiny
program that keeps one row per terminal session, `<config dir>/claw-connector-terminals/<pid>.json`: the session id and the
process that holds it, with that process's start time. Claude Code runs the same hooks for sessions started by an ACP adapter
(this connector's own included) and by `claude -p`; they are told apart by `CLAUDE_CODE_ENTRYPOINT` in the hook's environment
(`cli` in a terminal, `sdk-cli` otherwise), so only terminal sessions are recorded. `SessionEnd` runs on `/exit`, Ctrl-C and
Ctrl-D twice, a closed terminal (SIGHUP) and a plain `kill`; it does not run after `kill -9` or a power cut, so a row counts
only while the process it names is still the same process (same start time), and the next hook sweeps dead rows away. The
hooks are merged into `settings.json` without touching anything else in it (a file that is not valid JSON is left alone), take
under two seconds at most (`SessionStart` holds up the first turn, so they have timeouts of 2 s and 1 s), print nothing and
always exit 0, so they cannot get in the way of a session. `claw-connector hooks uninstall` takes exactly those entries out
again (they carry the mark `--managed-by claw-connector`; a hook of your own is never taken for one of them). The entries name this installation's node and program by absolute path, so install from a durable one (`npm i -g
@primusclaw/connector`) rather than a throwaway `npx` cache; `hooks status` and `run` say when a path is gone, and installing
again repairs it. A conversation that was opened before the hooks were installed is not in the rows, and neither is one under a
different config directory or when Claude Code is configured not to run user hooks: the rows can only add a refusal, and
everything below stays in force as the fallback (`claw-connector hooks status` says where they stand).

Who holds the conversation open is then asked of Claude Code itself
(`claude agents --json`, which lists the live processes of this machine and ignores the files a killed one leaves behind)
and of the registry Claude Code keeps in `$CLAUDE_CONFIG_DIR/sessions/`, whose rows are each checked against the process they
name. The command does not report a row from another host or container that shares the directory (it asks whether the pid is
alive here), and such a row cannot be checked: it counts as open whatever the command says. If the command is missing or
fails, the registry alone is the answer; if neither can be read, the answer is "cannot tell" and the takeover is refused.
A transcript written within the last 10 seconds is refused too (a terminal that has only just exited may still be writing). The reasons Claw is told are
`session_live`, `recently_written` and `twin_check_failed`; the agent that this connector itself started for the conversation
is not mistaken for a twin.

The ask mode still applies: a conversation keeps the mode it was left in, often one that never asks (`bypassPermissions`),
and the adapter says so while it sets the session up. That warning describes the mode that is about to be replaced, so it is
set aside until the ask mode (`default`) is locked and read back from the adapter; a warning that comes after that, or a mode
that is not confirmed, closes the session. The phone can select only the safe modes, as for every agent. Closing the
session stops the agent process; it never deletes the conversation.

## Commands

| Command | |
|---|---|
| `init` | Write a sample `agents.toml` and install the Claude Code session hooks (`--no-hooks` skips that). |
| `hooks install\|uninstall\|status` | The `SessionStart`/`SessionEnd` hooks alone; `--config-dir DIR` names the Claude config directory (default: those of the `claude-attach` agents, else `$CLAUDE_CONFIG_DIR` or `~/.claude`). |
| `login` | Device sign-in. `--key <api key>` (or `CLAW_CONNECTOR_KEY`) is for development only. After a revocation, run it again: it connects this machine as a new connector. |
| `run` | Connect and serve. Exit code 3 means the connector was revoked. |
| `status [--json]` | Running or not, paused, signed in, agents, adapter processes. |
| `pause` / `resume` | Stop every agent within a second and stay offline, or undo that. |
| `stop` | Stop the running connector and every agent it started. |
| `logout` | Stop, revoke the sign-in at the identity service, delete it. The stored connector id stays, so the next sign-in reuses the same connector. |

**Kill switch.** Every adapter is started in its own process group and recorded (pid and start time) in
`children.json`. `stop`, `pause`, a revocation and Ctrl-C signal exactly those groups: a process that is not recorded, or
whose pid has been reused, is never signalled, and nothing here uses a pattern kill. If an adapter's group leader (an `npx` wrapper) died but the
agent it started is still in that group, the group is still stopped. If you disconnect the connector in Claw,
the connector sees it within a heartbeat, stops every agent and exits without retrying.

## Files

`~/.config/claw-connector/` (or `$XDG_CONFIG_HOME`): `agents.toml`, `credentials.json` (0600; a file other users can read is
refused). `~/.local/state/claw-connector/` (or `$XDG_STATE_HOME`): `connector.json` (the connector's identity and the
commands handled), `sessions.json`, `outbox/` (events not yet acknowledged by Claw), `audit.jsonl` (spawn, directory
decisions, every command received, every permission request and answer, every automatic approval, mode changes),
`logs/`, `children.json`, `connector.pid`. `CLAW_CONNECTOR_HOME=/some/dir` keeps all of it under one directory.

## Restarts and crashes

A prompt counts as handled only when it reaches the agent (or is dropped by a cancel, a close or a stop), so a connector that
dies with a prompt still queued is sent that prompt again by Claw instead of losing it. A permission request waiting
for an answer lives in the adapter, which dies with the connector: the next run closes such a card (`cancelled`, by
`connector_restart`), so a phone is not left with a button that does nothing. Session state, unacknowledged events and
their sequence numbers are on disk; a session resumes in a fresh adapter on its next prompt.

Known limit: the working-directory check resolves the path and starts the adapter in the resolved path, but another process of
the same user that can rewrite a directory in that path could swap a symlink between the check and the start. The
whitelist protects against what Claw (or a phone) asks for, not against another local process of the same user, which could already
run the agent itself.

## Connection behaviour

One long-lived `text/event-stream` carries commands to the connector; events go back in batches (150 ms or 20 events,
one request at a time). Every event has a per-session sequence number written to disk before it is queued, and stays
there until Claw acknowledges it, so a dropped connection, a failed request or a restart loses nothing and, because Claw
stores each `(session, seq)` once, repeats nothing. The connector sends a heartbeat every 30 s, drops a stream that is silent for 75 s
and reconnects with a 1 s to 60 s backoff with jitter. Commands are delivered at least once and carried out once
(by command id and number). A card still waiting after a reconnect is sent again with the same action id.

## Development

```sh
cd connector
npm ci
npm run typecheck && npm test      # node:test against a stand-in Claw and a stand-in ACP adapter (real processes, real sockets)
npm run build                      # dist/cli.js: one file; the wire contract from claw/packages/protocol is compiled in
```
