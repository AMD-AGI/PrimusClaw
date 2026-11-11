<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Changelog

The four packages (`@primusclaw/personal-agent`, `@primusclaw/personal-agent-runtime`,
`@primusclaw/personal-agent-teams`, `@primusclaw/personal-agent-teams-ingress`), the Teams ingress's Function package
(`personal-agent-teams-ingress-X.Y.Z.zip`) and the `personal-agent-teams` image are released together at one version. Each
release is the tag `personal-agent-vX.Y.Z`, and its section here is the GitHub Release's notes (README.md,
"Releasing"): a version without a section is not released. Which number a release moves, and what its notes must say
(each incompatible change called out, a plugin port change in core's `src/plugins/` included, and the oldest Claw a
feature needs), follow the repository's versioning rules in the root [CHANGELOG.md](../CHANGELOG.md#versioning).

## 0.4.0

A minor release: it adds the Teams ingress as a released part (#739, run on Node 24 by #745). No plugin port (core's
`src/plugins/`) changed, and the worker needs nothing new from Claw.

The ingress's npm package, `@primusclaw/personal-agent-teams-ingress`, is not on npm yet: its first publish waits for the
package's Trusted Publisher entry. Its tarball is attached to this release like the others, and the Function package
(`personal-agent-teams-ingress-0.4.0.zip` with its `.sha256`), which is what a deployment runs, is attached as usual.

### Added

- `@primusclaw/personal-agent-teams-ingress`, new: the Teams ingress, the Azure Function (Node 24 or later) between Azure Bot
  Service and the inbound queue, which until now each deployment wrote itself. It verifies the Bot Framework token
  (RS256 only; `exp`, `iss`, `aud` required, no leeway; the audience is `PRIMUSCLAW_BOT_APP_ID`), binds it to the
  activity's `serviceUrl` with the worker's Bot Connector host rule, and queues the activity on its conversation's
  session; it answers a card button with a placeholder card, the feedback buttons with an empty `200`, other invokes
  with an empty result, and logs one `token_rejected` security event per refusal. Its outbound queue trigger posts what
  the worker queues (`OUTBOUND_MODE=servicebus`) as the bot's managed identity, so the default outbound mode now works
  with published parts only. It answers as the Python Function it replaces did, case for case
  (`packages/teams-ingress/test/parity.test.ts`), except for a few `serviceUrl`s no Bot Connector sends, which it reads
  as the worker does. Settings: [configuration.md](docs/configuration.md#the-teams-ingress) (#739, #745).
- The release attaches the ingress as a deployable Function package, `personal-agent-teams-ingress-X.Y.Z.zip` (one
  reproducible bundle with `host.json`; its sha256 next to it, attested like the tarballs), checked in a real Functions
  host before it is published. [Quick start](docs/quickstart.md#4-the-ingress), step 4, now deploys it instead of
  asking for an ingress of one's own (#739, #745).
- `@primusclaw/personal-agent-teams`: a second entry, `@primusclaw/personal-agent-teams/connector-hosts`, the Bot
  Connector host rule alone, which the ingress imports (#739).

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
