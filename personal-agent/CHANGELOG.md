<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Changelog

The three packages (`@primusclaw/personal-agent`, `@primusclaw/personal-agent-runtime`,
`@primusclaw/personal-agent-teams`) and the `personal-agent-teams` image are released together at one version. Each
release is the tag `personal-agent-vX.Y.Z`, and its section here is the GitHub Release's notes (README.md,
"Releasing"): a version without a section is not released. While the version is 0.x, a patch release fixes and a minor
release adds; a change to a plugin port (core's `src/plugins/`) is always a minor release and is called out here.

## 0.3.0

A minor release: it adds a way to run the Teams worker (#736). No plugin port (core's `src/plugins/`) changed.

### Added

- `@primusclaw/personal-agent-teams`: the worker can get its Bot Connector token with an Azure app registration's client
  secret (`BOT_TOKEN_SOURCE=secret`, `BOT_CLIENT_ID`, `BOT_TENANT_ID`, `BOT_CLIENT_SECRET`), the usual way to run a bot
  outside Azure, beside the managed identity (`imds`) and workload identity federation. Covered by unit tests; not yet
  run against a real app registration (#736).

### Fixed

- `@primusclaw/personal-agent`: a person who confirmed an identity binding but never linked a key reaches their
  assistant in a 1:1 chat: their exchanged token now gets them a notification subscription and a Claw user id, which
  before came only from a link (#733).
- `@primusclaw/personal-agent`: a person whose chats run on their linked key because they never confirmed their identity
  is offered the identity card once, right after an answer Claw refused for want of it (Claw marks such a reply
  `needs_identity`), instead of nothing telling them how to fix it (#735).

## 0.2.0

A minor release: it adds behaviour (#713, #720, #725). No plugin port (core's `src/plugins/`) changed.

### Added

- `@primusclaw/personal-agent`: a message typed into a chat attached to a remote agent session while the agent is
  still answering is sent and queued behind the running turn, not refused with "send it again" (#720).
- `@primusclaw/personal-agent`: in a group chat that lets the bot read its messages, the chat's recent messages are
  given to an @mention as untrusted background; `/context off` turns that off for the chat (#725).
- `@primusclaw/personal-agent`, `@primusclaw/personal-agent-teams`: a terminal's approval questions on the phone. A coding
  agent the person started in their own terminal asks before it runs a command, edits a file or starts on a plan; the
  question arrives in the chat as a card (the command, the edit's both sides, the plan; any field the card does not
  render is shown as JSON, so nothing is approved unseen), and the card is ended in place when the terminal answers it
  first. `/approvals [on|off]` reads or sets whether a terminal's questions come to the phone. Needs Claw with #707; the
  store gains two additive columns on `remote_permissions` (#713).

### Fixed

- `@primusclaw/personal-agent`: with the assistant on, `/sessions` (and the menu's sessions) shows the sessions on the
  person's machines, as `/agents` does, instead of saying there are none (#716).
- `@primusclaw/personal-agent`: a chat following a conversation open in a terminal tells the terminal's reply after a
  few quiet seconds, not after the 30 s / 60 s timings of the phone's own sessions (#717).
- `@primusclaw/personal-agent`: a reply that starts with a code span no longer streams a lone look-alike backtick and
  then repeats the whole answer as a second message (#718).
- `@primusclaw/personal-agent`: a message sent while the chat's own turn runs (a group chat, or a 1:1 chat off the
  assistant) is queued behind it instead of refused; the assistant's `/stop` answers in the chat's language; a turn
  the person stopped says it stopped (#724).
- `@primusclaw/personal-agent`: asked in a group to introduce itself, the agent also names what a 1:1 chat with it
  adds (connecting your own machine, memory, research, the board, reminders) (#726).
- `@primusclaw/personal-agent-runtime`, `@primusclaw/personal-agent-teams`: `/whoami` names the account of a person whose
  chats run on an exchanged identity token: a person's own key (`ak-...`) is still asked of the platform's `/users/self`,
  any other credential of Claw's `GET /v1/me` (#730).
- `@primusclaw/personal-agent`, `@primusclaw/personal-agent-teams`: a feedback report from a 1:1 chat with the assistant
  on shows the assistant session's turns, the ones the person saw, instead of the plain chat session's (#731).

### Docs

- A quick start for running your own personal agent from the published artifacts (`docs/quickstart.md`, #719).

## 0.1.1

- `@primusclaw/personal-agent`: a remote agent's activity no longer shows, as words the person typed, the entries
  Claude Code writes into a transcript on its own: a background task's or a sub-agent's notification, a message from
  another session, and a compacted conversation's summary. A newer connector already leaves these out; this catches
  them from an older one (#698).

## 0.1.0

The first release.

- `@primusclaw/personal-agent`: the channel-neutral core, with the Claw wire contract compiled in, and every port and
  plugin interface (`Plugins`, `neutralPlugins`, `IntegrationRegistry`).
- `@primusclaw/personal-agent-runtime`: the Node adapters of core's ports (SQLite store, Fernet, the Claw client, the
  token exchange, metrics, settings and secrets, the HTTP server).
- `@primusclaw/personal-agent-teams`: the Microsoft Teams channel and the process assembly (`buildWorker`, `main`,
  `WorkerOptions.registerIntegrations`), with the worker program as `dist/main.js`.
- The `personal-agent-teams` image: the three packages installed from their checked tarballs on Node.js 26, running as
  uid 65534, with `personal_agent_build_info` on `/metrics`.
- The worker logs one line per HTTP request and per inbound queue message (#696), and its outbound log line names the
  target conversation and the activity type (#697).
