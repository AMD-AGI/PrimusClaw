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

## Fastest: pair from the chat (one command)

In Clawy (or another chat client built on Claw), say **连接我的开发环境** ("connect my dev environment"). It answers one line
with a one-time code in it, for example:

```sh
npm install -g --no-update-notifier @primusclaw/connector@latest && claw-connector pair ABCD-EFGH-JKMN --server https://claw.example.com/claw-api
```

Run it in a terminal on the machine, in the folder the agents may work in. That is the whole setup: it installs the connector,
pairs this machine with you (running the command is the approval; the code works once, for 10 minutes), writes `agents.toml`
for the agents it finds (`claude`, `codex`, `cursor-agent` on your `PATH`), each asking before it writes a file or runs a
command and working in that folder, and starts the connector as a service (see [Keep it running](#quick-start-about-5-minutes)).
The chat tells you when the machine is connected. To disconnect it, `/agent off <machine>` in the chat or `claw-connector logout`
here; either ends this machine's sign-in for good. An `agents.toml` that is already there is kept as it is.

The pairing is a connector grant: it reaches the connector routes of Claw for this one machine and nothing else, and it ends
when the machine is disconnected. Pair again (a new code) to connect it again.

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
claw-connector doctor    # checks the machine (step 5), then starts each agent's adapter, opens a session (no prompt) and checks the modes it offers
```

`init` runs the adapter check of `doctor` at the end. `doctor` says `ok` for an agent whose phone sessions will open, and otherwise a
`problem:` line with the fix, for example an agent whose sessions would be refused with `mode_unavailable`.

By default every agent asks before it writes a file or runs a command, and your phone answers each question. To let phone sessions run
like your terminal instead, run `claw-connector init --approval never` (or set `approval = "never"` on an agent later); see
[Running without per-step approval](#running-without-per-step-approval).

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

**4. Keep it running**

```sh
claw-connector service install
claw-connector service status
```

This starts the connector now and keeps it up: at login and after a reboot, and again 5 seconds after it dies for any reason, except
one that only you can fix (the connector was revoked, or Claw refused the sign-in), which leaves it stopped until you run `login` again.
A revocation stops it at once. A refused sign-in stops it only after Claw has refused it four times in a row over two minutes
while answering everything else: a 401 that comes while Claw or its sign-in service is failing (no answer, 5xx), or within ten
minutes of such a failure, is not counted, and the connector keeps retrying until the outage ends.
Only `claw-connector stop` (or stopping the service) stops it for good: a `kill` of the connector's process from anywhere else ends it
with exit 75, and it is started again.
It uses `systemd --user` on Linux and launchd on macOS. On Linux, run `loginctl enable-linger $USER` once (`service install` says so
when it is needed) so it also runs while you are logged out. In a container without systemd, `service install` starts a small
supervisor, writes `keepalive.sh` and adds it to your crontab when a cron daemon runs; when none does it says so, and the container's
startup command must run that script (it does nothing when the supervisor is up) for a restarted container to come back. Keys the
agents read from your shell (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`...) are kept for the service in a 0600 file, never in the unit.
See [Keeping it running](#keeping-it-running).

To try it in the foreground instead, `claw-connector run` prints `connecting claude to https://claw.example.com/claw-api as
"<machine name>"` and stays up until Ctrl-C, which stops it and every agent it started.

**5. Check the machine**

```sh
claw-connector doctor
```

`doctor` checks what makes a first phone session fail far from the machine that caused it, and prints one fix per problem:
Node.js 22 or newer; each agent's program on `PATH` (and on the `PATH` the installed service starts it with, which is not your
shell's); whether Claude Code and Codex are signed in (`claude auth status`, `codex login status`, or the model provider's key
variable in `~/.codex/config.toml`); the `roots` writable; `HTTPS_PROXY` and `https_proxy` not set to different values; a service
installed (and, for `keepalive.sh`, something calling it); and Claw answering, including whether Node.js trusts its certificate
(the connector trusts this machine's CA store as well as Node's own list and `NODE_EXTRA_CA_CERTS`, on Node.js 22.19+ / 24.5+, and passes
`NODE_USE_SYSTEM_CA=1` to the programs it starts; `NODE_USE_SYSTEM_CA=0` turns that off; on an older Node.js doctor names the fix). Then it
runs the adapter check of step 2. It exits 1 when something will stop sessions (`--json`: `ok` is the adapters' verdict,
`machine_ok` and `environment` the machine's). The
running connector repeats the machine checks with its own environment (in a child process, so a stalled disk cannot stall
it) every 15 minutes, and at once when `doctor` runs (it signals the connector), and Clawy's `/agents` card shows what it found under the machine ("Codex is not signed in: run `codex login` on that machine").

**6. See it in Clawy**

In Clawy (or any chat client built on Claw), send `/agents`. The agents of this machine are listed, online while `run` is up.
A session started there runs on this machine, inside one of your `roots`, and each permission request comes back as a card in the chat.

To disconnect: `claw-connector pause` (stay offline until `resume`), `claw-connector stop`, or `claw-connector logout` (also
revokes this machine's connector at Claw, so it can be sent nothing more, and asks the identity service to revoke the device
sign-in; a saved key is deleted from this machine, not revoked at Claw).

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
approval = "never"                 # optional, "ask" (the default) or "never": see "Running without per-step approval"

[[agents]]
id = "codex"
preset = "codex"
roots = ["~/work/repo-a", "~/work/repo-b"]
[agents.env]                       # passed to the adapter; the model settings live here, never in Claw
OPENAI_API_KEY = "..."             # or leave your own environment / CODEX_HOME to supply it; with only a key, the
                                   # connector signs Codex in with it (Codex keeps it in its auth.json, like
                                   # "codex login --with-api-key")

[[agents]]
id = "mine"
kind = "my-agent"                  # a label chat clients pick an icon from
command = "my-agent-acp"           # any agent that speaks the Agent Client Protocol over stdio
args = []
ask_mode = "careful"               # the mode in which it asks before it writes (required for a custom agent)
roots = ["~/work"]
```

Presets and the adapter versions they pin (override `command` and `args` to move):

| Preset | Command | Mode every session is forced into | Modes a phone may select | With `approval = "never"` |
|---|---|---|---|---|
| `claude` | `npx @agentclientprotocol/claude-agent-acp@0.99.0` | `default` | `default`, `plan` | `bypassPermissions` |
| `claude-attach` | `npx @agentclientprotocol/claude-agent-acp@0.99.0` | `default` | `default`, `plan` | `bypassPermissions` |
| `codex` | `npx @agentclientprotocol/codex-acp@2.3.0` | `read-only` | `read-only` | `agent-full-access` |
| `cursor` | `agent acp` (the Cursor CLI) | `ask` | `ask`, `plan` | `agent`, started as `agent --force acp` |

The pinned adapters (the `npx -y <package>@<version>` presets above) are installed once into the connector's state
directory (`adapters/<package>@<version>`), by `init`, by `service install` and in the background when `run` starts, and are
then started from there with the connector's own Node.js: a session does not wait for npx to look the package up in a
registry (about 70 seconds when the registry cannot be reached) or download it (Claude's adapter takes about 350 MB on
disk with its dependencies), and a repository's own `.npmrc` cannot pick the registry. The install uses `npm install` with your npm
settings (`~/.npmrc`, `npm_config_*`, `NPM_TOKEN`, an `npm_config_registry` in the agent's `env`), and never with the agents'
sign-in variables: anything named like a credential that is not npm's own (`ANTHROPIC_API_KEY`, a gateway token...) is left
out of npm's environment, so no install script of the adapter or its dependencies sees it. A session that opens while its
adapter is still being installed waits for it; if the install failed, the agent's npx command runs as before, in the
connector's state directory, and the install is tried again in the background ten minutes later. An agent with its own
`command` or `args` is started exactly as written.

`claude-attach` does not start new conversations: it takes over Claude Code conversations that already exist on this
machine (see [Taking over an existing conversation](#taking-over-an-existing-conversation)).

An agent with no `roots` is never offered. A configuration problem is reported at start-up, not skipped. A root that does
not exist, or whose disk does not answer (a network mount that is down or not mounted yet), is not a configuration problem:
`run` warns about it and keeps going, and that root's sessions are refused (`cwd_not_found`, `root_unavailable`) until it is
back. Reading `agents.toml` never touches a root.

## Running without per-step approval

By default every agent asks before it writes a file or runs a command, and the phone answers each question. To let a
phone session run like your own terminal session (Claude `bypassPermissions`, Codex full access, Cursor `agent` with
`--force`), turn the questions off for that agent:

```sh
claw-connector init --approval never                  # every sample agent
claw-connector init --approval claude=never           # only Claude (repeatable: --approval never --approval cursor=ask)
```

or set `approval = "never"` in an `[[agents]]` table of an existing `agents.toml`. It is per agent, so Claude can run
unattended while Cursor keeps asking. For that agent the connector then:

- starts every session in the preset's no-approval mode (the table above; for a custom agent, `ask_mode` names it);
- lets a phone select any mode the adapter offers (without the setting a phone can only select the safe modes);
- accepts an adapter's warning that it will not ask for permission, which happens when your own Claude settings default to
  `bypassPermissions`, instead of refusing the session (`mode_not_enforced`). The warning is written to `audit.jsonl`
  with `accepted: true`. Without the setting that refusal stays, except that `allow_unsafe_modes = true` in the file
  accepts it too, for every agent that has no `approval` of its own (below);
- tells the phone: every agent reports `unattended` in its capabilities, and `session_started`, `session_resumed` and
  `mode_update` carry `unattended`, so a client can always show whether a session asks. `status` and the line `run` prints
  at start-up name the agents without per-step approval.

**Your own Claude settings may default to `bypassPermissions`** (`permissions.defaultMode` in your user `settings.json`,
`$CLAUDE_CONFIG_DIR` or `~/.claude`, or in Claude's managed settings). For a `claude` agent that asks (no
`approval = "never"`), the connector tells the adapter to leave that mode out (`allowDangerouslySkipPermissions: false`),
so its sessions start in `default` and ask; before 0.1.5 each of them was closed with `mode_not_enforced`. An agent with
`approval = "never"` runs in `bypassPermissions` either way. A `claude-attach` agent takes over a conversation in the mode
its terminal chose and accepts the adapter's warning while it starts. Codex and Cursor have no equivalent: their own
settings are replaced by the mode the connector sets and reads back.

**Root.** Claude Code offers `bypassPermissions` to root only when `IS_SANDBOX` is set. For an agent that runs
`claude-agent-acp` with `approval = "never"` (or `allow_unsafe_modes = true`), the connector sets `IS_SANDBOX=1` in that
agent's adapter environment when it runs as root, and `run` prints a `note:` line saying so; nothing else gets it. Without
that, every phone session of such an agent was refused with `mode_unavailable`. To keep it off, set `IS_SANDBOX` yourself
in the agent's `[agents.env]` (an empty value is kept as it is; `status` then warns that sessions will be refused).

**The risk, in one sentence:** an agent without per-step approval acts on whatever it is told, including text it read in
a file or a web page, with everything your account can do inside its roots (and `--force` or full access reach outside the
sandbox the adapter would otherwise keep), and nobody is asked first.

**To go back:** set `approval = "ask"` on the agent and restart the connector (`claw-connector stop`, then `run`). The
policy is read again on start, so a session that was unattended resumes asking. Setting `"ask"` is the way back that
always works. Deleting the `approval = "never"` line is enough only when the file does not set `allow_unsafe_modes = true`:
that is the older, coarser form, which lets a phone select unsafe modes for every agent and accepts the warning for all
of them (but starts sessions in the asking mode), so an agent without an `approval` line of its own still resumes an
unattended session unattended (the phone shows it). `approval = "ask"` on an agent overrides it for that agent.

**Upgrading.** Two things change for an `agents.toml` that already exists, with no setting needed:

- A file with `allow_unsafe_modes = true` now also accepts an adapter's "will not ask for permission" warning for every
  agent without its own `approval`. Such a session used to be closed with `mode_not_enforced`; now it opens and is
  reported `unattended`. Set `approval = "ask"` on an agent to keep refusing it.
- A preset agent whose `safe_modes` or `ask_mode` names a mode the preset does not know to ask (for example `claude`
  with `safe_modes = ["default", "plan", "acceptEdits"]`) is now a configuration error, and `claw-connector run` does not
  start. Remove the mode, or set `approval = "never"` on that agent (or `allow_unsafe_modes = true` in the file, for an
  agent that does not say `approval = "ask"`).

## What the connector enforces

All of these run on your machine and fail closed.

- **Directories.** A session's working directory is resolved (symlinks included) and must be inside one of the agent's
  `roots`; otherwise no process is started and the session is closed with `cwd_outside_roots`. The agent runs in the
  resolved path. A folder can be given the way people type it: `~` and `~/x` are the agent's home directory (its
  `[agents.env]` `HOME`, else the connector's), and a relative name (`repo`, `repo/sub`) is looked up under each root and
  taken when exactly one has it (`cwd_ambiguous` when several do); a root's own last segment names that root. A relative
  name never climbs out (`..`). Every look at the disk on the way to opening a session is asynchronous with a 10-second
  limit, so a root on a stalled network mount refuses its own sessions (`root_unavailable`), never those under a healthy
  root, and never freezes the connector or its heartbeat. A restored session whose root does not answer is kept: its
  commands are rejected `root_unavailable` until it does, and `close` still closes it.
- **Opened, never used, then a restart.** Claude keeps a conversation only from its first message, so a session opened
  from the phone and restarted before anyone wrote in it has nothing to resume ("Resource not found"). Such a session (never
  prompted, not a takeover) gets a fresh conversation in the same folder (audited `session_recreated`) instead of being
  closed; a session that was used keeps the error.
- **Signed in before ready.** A new session of an agent that reports its sign-in (Claude Code does) and reports none is
  refused at once with `agent_auth_required`, instead of opening and failing at its first message; a session that
  already exists is kept and its prompts say why. A prompt refused for the same reason later
  (an expired login) ends its turn with `error: "agent_auth_required"` and the fix, and the next prompt starts the agent
  afresh, so a sign-in done on the machine meanwhile is picked up. An adapter that needs a sign-in and offers an
  `api-key` method (Codex) is told to `authenticate` with it when its environment has `OPENAI_API_KEY` or `CODEX_API_KEY`;
  the key itself is never sent, the adapter reads its own environment.
- **Why, in one sentence.** Every refusal (`session_closed`, `command_rejected`, and a `turn_end` that failed for a known
  reason) carries its stable `reason` code and a `hint`: one English sentence of what to do about it (sign in with which
  command, which folder to pick, `claw-connector doctor`), with no path and nothing secret, for a client to show beside
  its own translation of the code.
- **Ask mode, read back.** After the adapter creates a session, the connector sets the agent's ask mode and reads the
  mode back from the adapter. Your own agent settings may start an adapter in a mode that never asks (bypass, full
  access); an adapter that does not confirm the ask mode, or that warns it will not invoke its permission callback, is
  not opened, unless you set `approval = "never"` for that agent (above) or `allow_unsafe_modes = true` for the file,
  either of which accepts the warning and records it. A mode
  change the agent makes on its own to a mode outside the allowed list is undone at once. The adapter's
  `session/resume` can reset the mode, so it is locked again after every resume.
- **Unsafe modes.** Modes in which the agent does not ask before writing (`acceptEdits`, `bypassPermissions`, Codex write and full-access
  modes, Cursor `agent`) cannot be selected from a phone. `approval = "never"` on an agent, or `allow_unsafe_modes = true`
  for the whole file, in `agents.toml` is the only way, and it is yours alone. Flags that turn a tool's own approvals off
  (`--force`, `--yolo`, ...) in an agent's `args` are refused unless one of those is set too. A session recorded in a mode
  you no longer allow comes back in the ask mode. On a preset agent `safe_modes` can only narrow what the preset
  knows to ask (naming another mode is a configuration error unless the agent has `approval = "never"` or the file has
  `allow_unsafe_modes`), and a session in a mode the preset does not know to ask is reported `unattended`.
- **Cursor.** Measured on `agent acp` 2026.10.22: in `agent` mode a shell command asks (options `allow-once`, `allow-always`,
  `reject-once`) but a file edit is applied without asking, whatever the approval setting. So the preset starts in `ask`,
  which cannot write. `approval = "never"` selects `agent` and starts `agent --force acp` (`--force` is a root flag of the
  Cursor CLI, "force allow commands unless explicitly denied"; it is accepted before or after `acp`). Cursor
  has no `session/resume`; the connector uses `session/load` and marks the replayed history `replay: true`.
  A Cursor agent that asks therefore answers and plans but changes no file: its capabilities say `edits: false` with an
  `edits_hint`, `read_only_modes` lists `ask` and `plan` (each such mode in `session_started` carries `read_only: true`),
  `run` prints a note, and the sample `agents.toml` says so above the Cursor block.
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

**You do not have to add this agent.** Every agent made from the `claude` preset brings one with the same roots, adapter,
approval and environment, named `<id>-sessions`, so the conversations already on the machine show up on the phone by
themselves. `existing_sessions = false` on the `claude` agent turns that off; an explicit `claude-attach` agent reading the same
Claude config directory replaces it. `terminal_input` and `tmux_cli` (below) set on the `claude` agent are that derived agent's:
`terminal_input = false` there keeps the watch and turns only the typing off.

```toml
[[agents]]
id = "claude"
preset = "claude"
roots = ["~/work"]
# terminal_input = false        # conversations open in a tmux pane are watched only, never typed into (default: true)
# tmux_cli = "tmux"             # the tmux command used to type (default: tmux, from PATH)
```

Each entry also says, for a conversation a terminal holds open, what Claude Code says that terminal is doing (`activity`:
`working`, `waiting` for the person at it, or `idle`; with `waiting`, `waiting_for` in its words, such as "input needed"). The
connector looks at Claude Code's session registry and projects directory every 10 seconds (file names and times only; nothing
is started) and reports a change at once instead of at the next heartbeat, so a conversation a terminal has just opened, or one
that starts waiting, reaches the phone within seconds.

```toml
[[agents]]
id = "claude-attach"
preset = "claude-attach"
roots = ["~/work"]
# attach_cli = "claude"        # the command asked which sessions are open (default: claude, from PATH)
# terminal_input = true         # a message to a conversation open in a tmux pane is typed into that terminal (default: true)
# tmux_cli = "tmux"             # the tmux command used for that (default: tmux, from PATH)
# [agents.env]
# CLAUDE_CONFIG_DIR = "/home/me/.claude"   # where the conversations live, if not the default
```

A taken-over conversation asks before every write and command like any other session. `approval = "never"` in this table
works as it does for `claude`: the conversation is resumed in `bypassPermissions` and the phone shows it as unattended
(see [Running without per-step approval](#running-without-per-step-approval)).

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
that came and went between two prompts is noticed. What the agent itself writes between two prompts does not count: a
background task it started finishes and Claude Code answers it with a turn of its own. Those entries name the same program
(`entrypoint`) as the agent's own turns, and their only prompt is the one Claude Code writes for itself
(`origin.kind: "task-notification"`) about a task whose id the agent's own turn recorded, so the agent is kept and the
prompt goes through. An entry from any other program
(a terminal's say `cli`), any other prompt (one a person typed, or a `claude -p`), or anything that cannot be read still
discards the agent, and the prompt is refused `recently_written` while that write is fresh.

While the connector's own agent is working on the conversation (starting, or running a turn) the size cannot say whether
someone else wrote, because the agent's own writes grow it too. So during that time the registry is read every second and
once more, in full, when the work ends. A terminal that held the conversation open for about a second or more during a turn
is noticed even if it has exited by the next prompt: that prompt goes to a fresh agent, after the full check above. One seen
while the agent is starting refuses the takeover (`session_live`) and stops the agent. A terminal that opens and closes the
conversation between two reads, which is shorter than anything that can take a turn, is not seen.

The first thing asked is the terminal itself. `claw-connector hooks install` (or `claw-connector init`, when you say yes at
its question or pass `--hooks`) adds two Claude Code hooks, `SessionStart` and `SessionEnd`, to the user-level `settings.json` of the Claude config directory. Each runs a tiny
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
A running Claude Code process of this machine whose own row (`sessions/<pid>.json`) is not valid JSON (an empty file a lost
write left, measured on a dev pod with a terminal open for days) has a conversation open that neither answer names: every
conversation in that process's folder (every one, when its folder cannot be read) is then reported `unknown`, not `idle`, and
a takeover of one is refused (`twin_check_failed`, naming the process and the file); `doctor` warns
(`claude_registry_row_unreadable`). Claude Code never writes such a row again (a status change reads the row first and gives up on
one that does not parse; measured on 2.1.321), so the connector proves the conversation that process has open another way where it
can (Linux): the process keeps its conversation's task folder (`<tmp>/claude-<uid>/<project>/<session>/tasks`) open once that
conversation ran a background task. When exactly one such folder is open, it is this user's (the uid in its name, its owner and the
process's owner), of the process's own folder, written since the process started, its name (`/rename`, `--name`) shown by the
process's own tmux pane in the rule above its input box, and no other conversation of that folder written since then known to share
that name (a `/clear` or `/resume` leaves the old folder open), that conversation is reported `live` (and typed into, as below) and
the rest of the folder is not held by it. Any doubt (an unnamed conversation, a file or folder that cannot be read) leaves the folder
`unknown` as above.
A transcript written within the last 10 seconds is refused too (a terminal that has only just exited may still be writing). The reasons Claw is told are
`session_live`, `recently_written` and `twin_check_failed`; the agent that this connector itself started for the conversation
is not mistaken for a twin.

A conversation that a terminal has open when the phone asks for it is not refused but watched, read-only. Nothing is
started: the connector reads the transcript the terminal writes, from its end (opened read-only; nothing is ever written to it),
and sends each new line as the update an adapter would have sent (the user's words, the agent's words, the steps it starts
and how they end; thinking and sub-agents are left out), scrubbed for credentials like every event and marked `read_only`.
The last twenty updates already there are sent first, marked `replay`. `session_started` says `read_only: true` and
`read_only_reason: "session_live"`. A prompt, a mode change or a decision sent to it is refused with
`read_only_live_session` and reaches nothing that could write to the transcript; the server refuses them too
(`session_read_only`). The heartbeat still reports the conversation as `live`, and an attach agent's capabilities say `watch_live: true`, so a
client offers the watch only where the connector can do it. When the terminal no longer has it open the
watch ends (`session_closed`, reason `terminal_closed`), and taking it over is then a new session, through every check
above. A watched session stays read-only across a restart of the connector.

When the terminal that has the conversation open is a **tmux pane**, the phone can talk to it without taking it over: what
is sent is typed into that terminal, as the person at it would type it, and the replies are read from the transcript as for a
watch. Nothing else writes to the conversation, so its history never forks, and the terminal and the phone show the same
conversation. `session_started` then says `live_terminal: true` and `input: "terminal"` instead of `read_only`, and a prompt is
accepted and typed at once, whatever Claude Code is doing there: one submitted while a turn runs is queued by Claude Code
itself and taken in at that turn's next step or once it ends, as one typed by the person at the terminal is (no registry status, no
transcript reading and no footer decides when it may be typed). It waits (one notice, `terminal_input_queued`, with `reason`
`terminal_typing`, `terminal_dialog`, `terminal_screen` or `terminal_scrolled`) only while it could not be typed safely: the input
box holds someone's half-typed text, a question or a menu is on the screen (an Enter there would answer it: on a permission
question it would approve a tool call), or the pane is scrolled back. It is pasted as one bracketed paste (`load-buffer` and
`paste-buffer -p -d`), one line or several: nothing in it is read as a key name, and a question that shows at that moment does not
take it as its choice (a typed `1` would approve a permission question), and it is
submitted with Enter once the box shows it, and only on a screen that, read twice 250 ms apart, shows the box holding exactly that
text and no question or menu, with End and Enter sent together (one write): in the box they submit it; on a question that came
up in the moment after that read, End picks its last option ("No") and Enter chooses that, so a phone's message never approves
anything (if a question took them, the Enter is tried again once it is gone). A question that shows after the text went in holds the Enter: no key at all is sent while it shows,
the phone is told (`terminal_dialog`), and once it is answered at the terminal the Enter goes if the box holds the text again, or
the text is typed again if the question emptied the box. A box that then holds anything else (the person at the terminal typed into
it) is left as it is and the message is refused (`terminal_input_failed`): a phone's message never answers a permission question. Before that every control character is removed from it (C0, DEL, C1, the Unicode line separators; tabs
become spaces), so nothing in a message can act as a key or end the paste. Its turn ends (`turn_end`, naming the prompt) when the
transcript records the end of the turn that took it in (a queued message: the turn whose `queued_command` it is, or its own turn
after the `dequeue`), when the turn is stopped there (`cancelled`), or once Claude Code has said it is idle for 5 seconds; a message
that neither appears in the transcript nor is queued there (`queue-operation` enqueue) within 20 seconds ends as
`terminal_input_unconfirmed`, and one Claude Code queued whose queue went back into the box (`popAll`, to be edited there) as
`terminal_input_withdrawn`. A
`cancel` presses Esc in the terminal only for a turn the phone's message started itself (submitted straight at a prompt, not
through Claude Code's queue), which stops it there. While the message is still being put in, waiting on a question, or
held in Claude Code's queue or taken into a turn the person started, no key is sent: the phone stops following it (the question
stays the person's to answer; a message Claude Code already queued is still Claude Code's to run, and text already in the box stays
there). A mode change is refused (`terminal_session`): the terminal keeps
its own mode.

**The terminal's own permission mode applies to what is typed.** The terminal's owner chose that mode, and a message from the phone
is typed in any of them (`default`/manual, `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`), whatever the agent's
`approval`: in `auto`, `acceptEdits`, `dontAsk` and `bypassPermissions` it runs its tools without asking, as a message typed at the
terminal would. The mode is read from the line Claude Code draws below its input box (`⏸ manual mode on`, `⏵⏵ bypass permissions on`...)
when the session starts, and `session_started` names it (`terminal_mode`, null when that line names none) so the chat can say so;
the audit log records it with each message typed. The terminal is never switched to another mode for it. A conversation with a name
(`/rename`) has it in the rule above the box; that rule is still the box's edge. A Claude Code that says it is idle while its screen
is not its input box (another program, a layout the connector does not know) is read again for 30 seconds, then the message is
refused (`terminal_screen_unknown`); while it waits the phone is
told why (`terminal_input_queued`). Connectors 0.1.8 to 0.1.13 refused a mode the agent's approval did not allow
(`terminal_mode_not_allowed`, `terminal_mode_unknown`); this one no longer sends those. A message that starts with `!`
(Claude Code runs the rest as a shell command, with no question) or `/` (a slash command such as `/permissions` or `/add-dir`) is
never typed, in any mode (`terminal_command_refused`). The audit log records each message typed (`terminal_input`: the pid, the pane, its length, line count and a digest,
never its words). The heartbeat marks such a conversation `input: "terminal"` and the agent's capabilities say `terminal_input: true`.

Only the terminal of this connector's own user is typed into, and only one that is proven: exactly one local process holds the
conversation open, Claude Code's own `claude agents --json` (or its registry row with the same process start) names it, its working
directory is inside the agent's roots, it runs as this user, the `TMUX` socket it was started with is a socket owned by this user,
and that tmux server reports a pane whose process is that process or one of its parents. Before every message this is asked
again: the same process (same start time) still runs in that pane, and Claude Code's registry row for it still names this
conversation (a `/resume` or `/clear` in that terminal moves it to another one: the message is refused, `terminal_switched`). Anything less (a plain terminal, `screen`,
another user's tmux, two terminals on one conversation, a holder on another machine, not Linux) is watched read-only as above, and
`session_started` says why (`read_only_why`). The owner turns it off with `terminal_input = false` on the agent (on a `claude`
agent, for the `<id>-sessions` agent derived from it). Claude Code's
own messaging between sessions was not used for this: a message sent that way arrives as a message from another session, not as
the person's own input. A second `claude --resume` process was not either: two writers fork the conversation.

Taking it over while the terminal still has it is the person's choice, made on the phone after being told what it does:
`session.new` with `takeover: true` (Claw passes it on only with a `resume_ref`). The connector then asks every process on
this machine that holds the conversation open to end (`SIGTERM`: Claude Code writes the end of its transcript, removes its
registry row and exits, about a second, measured on 2.1.319; a turn running in that terminal stops), waits until none is left
and the transcript has been quiet for 10 seconds, and resumes the conversation through every check above;
`session_started` then says `took_over: true` and the audit log records `terminal_ended` with the pids. It fails closed,
and resumes nothing, when the holder is a process this machine cannot see (another host or container sharing the config
directory: `session_live_elsewhere`), belongs to another user (`takeover_not_permitted`), cannot be proven to be the local
process that holds it, inside this agent's roots (`takeover_failed`: Claude Code's own `claude agents --json` lists it, or
its registry row names this machine and the same process start time, and its working directory is inside the roots), or
is still there after 15 seconds (`terminal_did_not_exit`; it is never killed harder). Without `takeover` the conversation is only watched, as above.
A takeover is acted on only while the confirmation is fresh: Claw sends `takeover_until` (the live-command TTL, 5 minutes, from when it was confirmed) and drops an uncollected one after that; one that reaches the connector later, or names no deadline, is refused (`takeover_expired`) and ends nothing. An attach agent reports `takeover: true` in its capabilities so that a client knows it can offer this. Afterwards the
terminal continues the same conversation with `claude --resume <id>` once the phone session is closed.

The ask mode still applies: a conversation keeps the mode it was left in, often one that never asks (`bypassPermissions`),
and the adapter says so while it sets the session up. That warning describes the mode that is about to be replaced, so it is
set aside until the ask mode (`default`) is locked and read back from the adapter; a warning that comes after that, or a mode
that is not confirmed, closes the session. The phone can select only the safe modes, as for every agent. Closing the
session stops the agent process; it never deletes the conversation.

## Questions asked in a terminal, answered from the chat

A Claude Code session you started yourself, in your own terminal, still stops and waits for you when it wants to run a command,
edit a file, leave plan mode or put a multiple-choice question to you. With the approval hooks installed, that question is also
put to you in the chat as a card with the same choices, so you can answer it away from the screen:

```sh
claw-connector hooks install --approvals      # opt-in; "hooks uninstall --approvals" takes them out again
```

This adds a `PermissionRequest` hook, plus `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop` (all run in the
background) and `SessionEnd`, to the Claude config directory's user-level `settings.json`, merged the same way as the session
hooks above (marked `--managed-by claw-connector`, nothing else in the file is touched). They run `approval-hook.js` from this
installation, which talks to the running connector over a socket in its state directory (`approvals.sock`, 0600, in a
directory only you can enter).

- **The terminal keeps asking.** Claude Code shows its own dialog while the hook waits (measured on 2.1.322). The first answer,
  in the terminal or in the chat, decides; the other is withdrawn (the card says it was answered in the terminal). A
  connector that is not running, not connected, paused, or a question no card can carry (a multi-select question, more than
  four answers) leaves the question to the terminal at once.
- **What a card offers.** A command, an edit or another tool: *Yes*, *No*, *No, and stop*, and, when Claude Code suggests an
  allow rule for it, *Always allow this session: <rule>* (never written to a settings file; a rule too long to name is not offered).
  A plan: *Approve (ask before each edit)*, which also sets the session back to the mode that asks, or *Keep planning*. A
  question (`AskUserQuestion`): its own answers, one card per question. No card switches a session into a mode that stops
  asking (auto, accept edits, bypass).
- **Nothing is approved unseen.** A card carries the request whole (credentials masked). One too long for that (over 12 KB
  as JSON) is shown cut and offers only the options that turn it down; it is approved at the terminal.
- **Which conversations.** Only sessions in a terminal (`CLAUDE_CODE_ENTRYPOINT=cli`); one this connector runs already asks
  through its own cards. The folder must be inside the roots of the agent that reads that Claude config directory (a
  `claude-attach` agent, or the one derived from a `claude` agent). A session in `bypassPermissions` asks only its questions
  and plan approvals, so only those reach the chat.
- **On Claw's side** each conversation's questions go on a session of its own (`origin: "terminal_hook"`) that carries
  nothing but these cards: it cannot be sent a prompt. Turning the cards off there (`/approvals off`) makes the connector
  leave every question to the terminal.
- A card nobody answers is withdrawn after an hour; the terminal still has the question. The audit log records each request,
  answer and withdrawal (`approval_requested`, `permission_resolved`, `approval_withdrawn`), never what was typed.

## Commands

| Command | |
|---|---|
| `init [--approval ask\|never \| AGENT=ask\|never] [--hooks \| --no-hooks]` | Write a sample `agents.toml`; an existing file is never touched. `--approval never` turns per-step approval off (see above). At a terminal it then asks before adding the Claude Code session hooks to Claude's `settings.json`; `--hooks` adds them without asking, `--no-hooks` skips them, and with nobody to answer (a script, a pipe) they are not added and the `hooks install` command is printed instead. |
| `hooks install\|uninstall\|status [--approvals]` | The `SessionStart`/`SessionEnd` hooks alone (with `--approvals`, also the approval hooks: see [Questions asked in a terminal](#questions-asked-in-a-terminal-answered-from-the-chat)); `--config-dir DIR` names the Claude config directory (default: those of the `claude-attach` agents, else `$CLAUDE_CONFIG_DIR` or `~/.claude`). |
| `login` | Device sign-in. `--key <api key>` (or `CLAW_CONNECTOR_KEY`) is for development only. After a revocation, run it again: it connects this machine as a new connector. |
| `run [--supervised]` | Connect and serve. Exit code 78 means starting it again will not help: the connector was revoked, Claw or the identity service refused the sign-in (at start, or for two minutes in a row while running), or there is no usable `agents.toml` or sign-in; the reason is kept in `needs-login.json`, and until `login` removes it `run` exits 78 at once without contacting Claw. `--supervised` marks a run the service started. Any other non-zero exit is worth a restart. A unit written by hand for 0.1.2 and older (`RestartPreventExitStatus=3`): replace it with `claw-connector service install`, which writes the same file. |
| `service install\|uninstall\|status [--supervisor systemd\|launchd\|script] [--env NAME ...]` | Keep `run` up (see [Keeping it running](#keeping-it-running)). `install` stops a `run` started by hand so the service takes over, and starts an installed service again (a script supervisor too) so an edited `agents.toml` or environment takes effect; `status` also lists the last five disconnects and why. |
| `status [--json]` | Running or not, paused, signed in, agents, adapter processes, the last disconnect and its reason (`last down:`), a `problem:` line when a new sign-in is needed, and a `warning:` line for each agent whose sessions will be refused because Claude's own settings default to `bypassPermissions` (see [Running without per-step approval](#running-without-per-step-approval)). |
| `doctor [--agent ID] [--json]` | Check this machine and print one fix per problem (see step 5 of the quick start), then each agent's adapter (step 2); exit 1 when something stops sessions. The report is kept in `doctor.json`; a running connector is signalled to check again and sends what it finds to Claw (each agent's `capabilities.health`). |
| `pause` / `resume` | Stop every agent within a second and stay offline, or undo that. |
| `stop` | Stop the running connector and every agent it started. |
| `logout` | Stop, revoke this machine's connector at Claw (with a key, `DELETE /v1/remote-agents/connectors/:cid`; with a device sign-in, the connector-side `POST .../connectors/:cid/revoke`), ask the identity service to revoke the sign-in, and delete it from this machine. The next sign-in registers a new connector. When Claw cannot be reached or refuses (a Claw from before the connector-side route refuses a device sign-in), the sign-in is still deleted, but `logout` says the connector was not revoked, prints the `curl` that revokes it with a Claw API key of yours, keeps its id (so a later sign-in reuses it), and exits 1. |

**Kill switch.** Every adapter is started in its own process group and recorded (pid and start time) in
`children.json`. `stop`, `pause`, a revocation and Ctrl-C signal exactly those groups: a process that is not recorded, or
whose pid has been reused, is never signalled, and nothing here uses a pattern kill. If an adapter's group leader (an `npx` wrapper) died but the
agent it started is still in that group, the group is still stopped. If you disconnect the connector in Claw,
the connector sees it within a heartbeat, stops every agent and exits without retrying.

## Files

`~/.config/claw-connector/` (or `$XDG_CONFIG_HOME/claw-connector/`, or `$CLAW_CONNECTOR_CONFIG_DIR`): `agents.toml`, `credentials.json`
(0600; a file other users can read is refused), and `service-env.json` (0600, the agents' sign-in variables `service install` kept). `~/.local/state/claw-connector/` (or `$XDG_STATE_HOME/claw-connector/`): `connector.json` (the connector's identity and the
commands handled), `connector-id.json` (the identity alone, written once and flushed to the disk: a `connector.json` damaged
by a crash falls back to it instead of registering the machine as a new connector), `sessions.json`, `outbox/` (events not yet acknowledged by Claw), `audit.jsonl` (spawn, directory
decisions, every command received, every permission request and answer, every automatic approval, mode changes),
`logs/`, `children.json`, `connector.pid`, `disconnects.jsonl`, `needs-login.json` (only after a run that needs a new sign-in), `doctor.json`
(the last `doctor` report), and with the script supervisor `supervisor.pid`, `keepalive.sh`, `keepalive-last` (when it last ran) and `run.log`. `CLAW_CONNECTOR_HOME=/some/dir` keeps all of it under one directory.

## Keeping it running

`service install` picks the supervisor (override with `--supervisor`):

- **systemd** (Linux, when systemd is the machine's init): `~/.config/systemd/user/claw-connector.service` with `Restart=on-failure`,
  `RestartSec=5`, `RestartPreventExitStatus=78` and no start limit. Logs: `journalctl --user -u claw-connector`.
- **launchd** (macOS): `~/Library/LaunchAgents/com.primusclaw.connector.plist` (mode 0600) with `KeepAlive` on any unclean exit. launchd cannot
  exempt one exit code, so a run it started exits 0 instead of 78.
  Log: `run.log` in the state directory.
- **script** (a container without systemd; an `systemctl` that answers "Running in chroot" counts as none): `claw-connector supervise`
  runs in the background and restarts the connector 5 seconds after it dies; `keepalive.sh` in the state directory starts that
  supervisor unless it is alive (recorded pid and start time) or a sign-in is needed. Where a cron daemon runs, `install` adds an
  `@reboot` and a 5-minute line that call `keepalive.sh` to your crontab (once; `uninstall` removes them). Where none runs (most
  containers), `install` says so: nothing brings the connector back after a restart until the container's startup command (or
  `~/.bashrc`) runs `sh keepalive.sh`. Log: `run.log`.

**A container whose home directory does not outlive it** (a dev pod): when `agents.toml` and the sign-in sit on the container's own
file system (overlay, tmpfs), `init` and `service install` say so. Keep them on storage that survives the container with
`CLAW_CONNECTOR_CONFIG_DIR=/mnt/<your persistent volume>/claw-connector` (only the configuration and sign-in move; pid files, the outbox
and logs stay on the local disk), set in your shell profile and in the container's startup command, which then runs
`claw-connector service ensure` (after installing the package again, if it lived on the container's file system too).

A successful `login` starts an installed service again, so after a revocation or a refused key signing in is the whole fix.
`keepalive.sh` and the script supervisor start nothing while only a person can help (no `agents.toml`, not signed in,
`needs-login.json`); under launchd every exit 78 is turned into a clean exit, which launchd does not restart. The service
installed for a state directory is recorded in its `service.json`.

The unit carries `PATH` (so the agents are found), `CLAW_CONNECTOR_HOME`, `CLAW_CONNECTOR_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, the CA and proxy variables (with `NODE_USE_SYSTEM_CA` and `NODE_USE_ENV_PROXY`), `LANG`, `IS_SANDBOX`, the npm registry and proxy settings, and every
plain setting of the agents (`ANTHROPIC_*`, `CLAUDE_CODE_*`, `OPENAI_*`, `CODEX_*`, `CURSOR_*` that is not named like a credential:
`ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `CLAUDE_CODE_USE_BEDROCK`...) from the shell that ran `install` (a proxy URL with a password in
it only when named with `--env`, e.g. `--env HTTPS_PROXY`); `--env NAME` adds another.

The agents' own sign-in variables are never written into a unit. When the shell that runs `install` has `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CURSOR_API_KEY`, the
AWS keys, a variable Codex's `config.toml` names as a provider's `env_key`, or an `--env` name that looks like a credential (`KEY`,
`TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`), they are kept in `service-env.json` beside `credentials.json` (mode 0600) and every `run`
gives them to the agents that do not set them in `[agents.env]` (a configuration directory its group or others may write is first made 0700; one owned by another account is refused). `install` prints their names, never their values; `service status`
lists them; `uninstall` deletes the file. Without this a connector that works in a terminal loses its agents' sign-in as a service,
and each session fails at its first message. `CLAW_CONNECTOR_KEY` is never copied. Run `install` again after changing any of them, or
after moving Node. With a service installed, `claw-connector stop` stops the connector until the next login,
boot or keep-alive check; to stay offline use `pause`, or `service uninstall`.

**Why it went down.** Every disconnect is appended to `disconnects.jsonl` in the state directory: `server_closed` (a Claw release or
restart, `superseded` by another run, `token_expired`; reconnected at once), `stream_lost` (the network, with the error), `stopped`,
`revoked`, `auth_failed`, `failed`, `process_died` (the previous run never shut down: killed, crashed or the machine restarted;
dated by its last heartbeat), and `connector_limit_reached` (Claw already holds the most connectors one person may have: remove a
machine you no longer use, in the chat with `/agents` or with `claw-connector logout` on it; the run stays up and tries again every 10
minutes instead of being restarted every 5 seconds). `status` shows the latest, `service status` the last five.

## Restarts and crashes

A prompt counts as handled only when it reaches the agent (or is dropped by a cancel or a close), so a connector that
dies, or is stopped or restarted by its supervisor, with a prompt still queued is sent that prompt again by Claw instead of
losing it. A permission request waiting for an answer lives in the adapter, which dies with the connector: the next run
closes such a card (`cancelled`, by `connector_restart`), so a phone is not left with a button that does nothing. Session
state, unacknowledged events and their sequence numbers are on disk; a session resumes in a fresh adapter on its next prompt
(Claude Code's `session/resume`, the conversation intact).

The turn an agent is running is on disk too, from the moment its prompt reaches the agent until its `turn_end`. The next run
(after a crash, a kill, a pod restart, `stop`, or an upgrade) finds it and:

- carries it on when the agent was waiting for a person's permission for a tool call (not a plan or a question card), the agent
  always asks (no `approval = "never"`, no `allow_unsafe_modes`) and its session was in a mode that asks, the connector is not
  paused, and it was away no longer than a card lives (10 minutes): the agent is told the connector restarted and to go on, so
  it asks again and a new card comes; the prompt's own `turn_end` still ends it. It only asks, so nothing runs that nobody
  approved. Nothing is carried on before the run has signed in (a revoked connector carries on nothing);
- otherwise ends it with `turn_end` `{"stopReason": "error", "error": "connector_restarted"}`, naming its prompt (`cmd_id`,
  `cmd_seq`), so a phone stops waiting for it. The agent is not re-run by itself; the next message resumes the conversation.

Every session used in the last 4 hours, and every one with a turn found this way, then gets one `session_recovered` event
(`interrupted`: a turn was cut off; `continuing`: it is being carried on; `cmd_id` and `cmd_seq` of that turn), which a chat
shows as "recovered". A stop by the kill switch (`pause`, a revocation) still ends every turn and drops the queue.

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
npm run build                      # dist/cli.js and dist/terminal-hook.js; the wire contract from claw/packages/protocol is compiled in
node scripts/check-pack.mjs        # packs the tarball: it must hold only dist/cli.js, dist/terminal-hook.js, README.md, LICENSE and package.json
npm pack && npm install -g ./primusclaw-connector-*.tgz   # the package as the registry serves it, from a checkout
```

## Releasing (maintainers)

A release is a GitHub Release whose tag is `connector-vX.Y.Z`, cut the way Hyperloom's are. Publishing it starts
[connector-release.yml](https://github.com/AMD-AGI/PrimusClaw/blob/main/.github/workflows/connector-release.yml): it builds, tests and
checks the tarball, signs a build-provenance attestation for it, attaches it to the release and publishes it to npm with Trusted Publishing
(an OIDC credential; no npm token is stored anywhere). Only stable `MAJOR.MINOR.PATCH` versions are released: a prerelease needs a dist-tag,
which OIDC publishing sets only with a newer npm and a separate permission on the Trusted Publisher entry.

**What stops an unreviewed publish.** A release runs the workflow file as it exists at its tag, and a tag can point at any commit, so the
checks inside that file (tag shape, the commit being in `main`, the environment below having a reviewer) catch honest mistakes and are not the
control. The control is the GitHub environment `npm-publish`: one of its required reviewers must approve the `publish` job, and the Trusted
Publisher entry on npmjs.com names that environment, so npm hands the publish credential to no other job. Only the `publish` job, which checks out
and installs nothing, runs behind it. Two more rules narrow who can get that far. The environment does not let administrators bypass its
protection, and a tag ruleset limits creating `refs/tags/connector-v*` to repository admins, so only an admin can start a release run at all.
Self-review is allowed: the maintainer who cuts a release may approve its publish, so the approval is an explicit decision by a listed reviewer
and not a second person's check. `scripts/release-tests/connector-release-workflow.sh`, run on every change by the Connector packaging
workflow, fails if the workflow file stops having that shape, or if its environment check would refuse the environment as set up below.

**One-time setup** (a repository admin, and a member of the `primusclaw` npm organisation). The order matters.

1. Create the environment `npm-publish` (repository Settings > Environments) with **Required reviewers** (the people who may publish) and
   **Allow administrators to bypass** off. **Prevent self-review** is left off, so a reviewer who cuts a release may approve it (turning it on is
   accepted too). The release run refuses to build unless the environment has at least one required reviewer and administrator bypass is off.
   Then add a tag ruleset (Settings > Rules > Rulesets, target: tags) matching `refs/tags/connector-v*` that restricts creation to repository
   admins: with self-review allowed this is what limits who can start a release run, and a deployment tag rule on the environment alone does
   not help, since the tag of an unreviewed commit matches it too. Do not restrict the environment to "Protected branches only": a release's
   ref is a tag, so it would be refused.
2. Publish 0.1.0 once by hand from a clean checkout of the merged `main` (the package must exist before it can be given a Trusted Publisher):
   `cd connector && npm ci && npm publish --access public`, logged in to npm with 2FA.
3. On npmjs.com, Packages > `@primusclaw/connector` > Settings > Trusted publishing > GitHub Actions: Organization `AMD-AGI`, Repository
   `PrimusClaw`, Workflow filename `connector-release.yml`, Environment `npm-publish` (all case-sensitive; create the entry only after step 1).
   Allowed actions: `npm publish`, which is what the workflow runs; leave dist-tag management off. The entry must see its first successful
   publish within 2 days or it expires.
4. Settings > Publishing access: require two-factor authentication and disallow tokens.

**Cutting a release.**

1. Set the new version in `package.json` and `src/version.ts` (`scripts/check-pack.mjs` fails if they disagree) and merge that to `main`.
2. Write the release notes from the PR descriptions, not from commit subjects: every change states in its PR what a user will now observe.
   For the PRs that touched `connector/` since the previous release (`prev` is the newest `connector-v*` tag, the previous release's;
   `next` is the version merged in step 1, read from `package.json` on `main`):
   ```sh
   git fetch origin main --tags
   prev=$(git tag --list 'connector-v*' --sort=-version:refname | head -n 1)
   next=$(git show origin/main:connector/package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
   [ "$prev" != "connector-v$next" ] || echo "connector-v$next is already released: step 1 is not merged yet" >&2
   for n in $(git log --first-parent --format=%s "$prev"..origin/main -- connector/ | grep -o '(#[0-9]*)$' | tr -d '(#)'); do
     gh pr view "$n" --repo AMD-AGI/PrimusClaw --json number,title,body --jq '"## #\(.number) \(.title)\n\n\(.body)\n"'
   done > notes.md
   ```
   Edit `notes.md` into the notes a user of the package wants to read.
3. Publish the release on the merged commit (not as a pre-release):
   `gh release create "connector-v$next" --target <sha-on-main> --title "claw-connector $next" --notes-file notes.md`
4. The `package` job runs and writes a summary: the commit, whether the release workflow at that commit equals the one on `main`, and the
   tarball's name, sha256 and files. A reviewer opens the run, checks that the tagged commit is the reviewed one on `main` and that the
   workflow file is `main`'s (if the summary says it is different, read the diff first), and approves `publish`. The job then attests the
   tarball, attaches it to the release and publishes it.
5. Check it: `npm view @primusclaw/connector version`, and `gh attestation verify "primusclaw-connector-$next.tgz" --repo AMD-AGI/PrimusClaw`
   on the tarball attached to the release.
