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

Claw's side is documented in [claw/docs/remote-agents.md](https://github.com/AMD-AGI/PrimusClaw/blob/main/claw/docs/remote-agents.md); the wire
contract is `claw/packages/protocol/src/remote-agents.ts`, compiled into this package.

## Quick start (about 5 minutes)

You need Node.js 22 or newer, a coding agent that already works on this machine (Claude Code, Codex or the Cursor CLI), and the
two addresses the people who run your Claw give you: the Claw API URL and the identity service URL. The addresses below are
placeholders. The Claude and Codex adapters are fetched by `npx` the first time a session starts, so the machine needs
access to the npm registry.

**1. Install**

```sh
npm install -g @primusclaw/connector
claw-connector --version
```

If npm answers `EACCES`, point its global prefix at a directory you own (`npm config set prefix ~/.npm-global`, then put
`~/.npm-global/bin` on your `PATH`) instead of using `sudo`. To update later, run the same `npm install -g` again.

**2. Choose what an agent may touch**

```sh
claw-connector init      # writes agents.toml and prints where: ~/.config/claw-connector/agents.toml unless XDG_CONFIG_HOME or CLAW_CONNECTOR_HOME is set
claw-connector status    # after you edit it: prints a "problem:" line if the file is wrong
```

Open the file `init` printed and set `roots`, the directories an agent may work in. The sample enables `claude`, working in `~/work`;
remove the `#` in front of the `codex` or `cursor` block to offer those too. A root that does not exist is reported as a problem, so
create it or change it. See [agents.toml](#agentstoml).

**3. Sign in**

```sh
claw-connector login --server https://claw.example.com/claw-api --identity-url https://identity.example.com
```

`login` prints a link and a short code. Open the link in a browser where you are signed in to Claw, check the machine name shown
there, and confirm; the command then prints `signed in as <machine name>`. The connector holds a rotating sign-in token (file mode
0600) and refreshes its short-lived access token by itself. Put `server` and `identity_url` in `agents.toml` and the two
options can be left out.

If there is no browser sign-in to use (a development server), use a Claw API key instead. Pass it in `CLAW_CONNECTOR_KEY`
(replace the placeholder value) rather than with `--key`, which would show it in the process list:

```sh
CLAW_CONNECTOR_KEY='replace-with-your-claw-api-key' claw-connector login --server https://claw.example.com/claw-api
```

The key is stored as it is in `credentials.json` (mode 0600) and is for trying things out; the device sign-in is the normal way.

**4. Run**

```sh
claw-connector run
```

It prints `connecting claude to https://claw.example.com/claw-api as "<machine name>"` and stays in the foreground: keep it in a
terminal tab, `tmux` or `screen`. Ctrl-C stops it and every agent it started. From another terminal, `claw-connector status` shows
whether it is running and signed in.

**5. See it in Clawy**

In Clawy (or any chat client built on Claw), send `/agents`. The agents of this machine are listed, online while `run` is up.
A session started there runs on this machine, inside one of your `roots`, and each permission request comes back as a card in the chat.

To disconnect: `claw-connector pause` (stay offline until `resume`), `claw-connector stop`, or `claw-connector logout` (also
asks the identity service to revoke the device sign-in; a saved key is deleted from this machine, not revoked at Claw).

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
- **No remote shell.** Only these commands are carried out: `session.new`, `prompt`, `cancel`, `set_mode`, `resume`,
  `close`, `decision`. Anything else is dropped and audited. Claw never sends a command line, an environment variable or a
  key.
- **What leaves the machine.** Agent output, tool calls, diffs and command output are uploaded to Claw's event store (so
  your phone can show them), after credential-shaped strings (API keys, tokens, bearer headers, private keys, JWTs) are
  masked and long tool output is cut to 8 KB. Adapter stderr never leaves; it goes to `logs/` under the state directory.
  A prompt's text is not written to the local audit log, only its hash and length.

## Commands

| Command | |
|---|---|
| `init` | Write a sample `agents.toml`. |
| `login` | Device sign-in. `--key <api key>` (or `CLAW_CONNECTOR_KEY`) is for development only. After a revocation, run it again: it connects this machine as a new connector. |
| `run` | Connect and serve. Exit code 3 means the connector was revoked. |
| `status [--json]` | Running or not, paused, signed in, agents, adapter processes. |
| `pause` / `resume` | Stop every agent within a second and stay offline, or undo that. |
| `stop` | Stop the running connector and every agent it started. |
| `logout` | Stop, ask the identity service to revoke the sign-in, delete it from this machine. The stored connector id stays, so the next sign-in reuses the same connector. |

**Kill switch.** Every adapter is started in its own process group and recorded (pid and start time) in
`children.json`. `stop`, `pause`, a revocation and Ctrl-C signal exactly those groups: a process that is not recorded, or
whose pid has been reused, is never signalled, and nothing here uses a pattern kill. If an adapter's group leader (an `npx` wrapper) died but the
agent it started is still in that group, the group is still stopped. If you disconnect the connector in Claw,
the connector sees it within a heartbeat, stops every agent and exits without retrying.

## Files

`~/.config/claw-connector/` (or `$XDG_CONFIG_HOME/claw-connector/`): `agents.toml`, `credentials.json` (0600; a file other users can read is
refused). `~/.local/state/claw-connector/` (or `$XDG_STATE_HOME/claw-connector/`): `connector.json` (the connector's identity and the
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
node scripts/check-pack.mjs        # the package ships only dist/cli.js, README.md, LICENSE and package.json
npm pack && npm install -g ./primusclaw-connector-*.tgz   # the package as the registry serves it, from a checkout
```

A release is a tag `connector-vX.Y.Z` on a commit of `main` whose `connector/package.json` has that version: see
[.github/workflows/connector-release.yml](https://github.com/AMD-AGI/PrimusClaw/blob/main/.github/workflows/connector-release.yml).
