<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Changelog

The four packages (`@primusclaw/personal-agent`, `@primusclaw/personal-agent-runtime`,
`@primusclaw/personal-agent-teams`, `@primusclaw/personal-agent-teams-ingress`), the Teams ingress's Function package
(`personal-agent-teams-ingress-X.Y.Z.zip`) and the `personal-agent-teams` image are released together at one version.
The first three are published to npm; the ingress is deployed from the Function package on the GitHub Release, and its
npm package is not published (its tarball is attached to the release). Each
release is the tag `personal-agent-vX.Y.Z`, and its section here is the GitHub Release's notes (README.md,
"Releasing"): a version without a section is not released. Which number a release moves, and what its notes must say
(each incompatible change called out, a plugin port change in core's `src/plugins/` included, and the oldest Claw a
feature needs), follow the repository's versioning rules in the root [CHANGELOG.md](../CHANGELOG.md#versioning).

## Unreleased

A patch release (0.8.1): the worker's own settings get surface-neutral `PA_` names, and the older `TEAMS_` names still
work, so no deployment needs a change. No new npm package, no plugin port (core's `src/plugins/`) or store change;
works with any Claw.

### Changed

- `@primusclaw/personal-agent`, `@primusclaw/personal-agent-runtime`, `@primusclaw/personal-agent-teams`: the worker's
  own settings, the ones every surface shares, are read under the `PA_` prefix: `PA_DB_PATH`, `PA_ENCRYPTION_KEYS`,
  `PA_EXCHANGE_*`, `PA_GITHUB_REVIEW_*`, `PA_USER_*`, `PA_LINK_*`, `PA_LIMIT_<OPERATION>`, `PA_GROUP_CONTEXT_*`,
  `PA_DIRECT_CHAT(_USERS)` and the rest listed in docs/configuration.md, "Setting names". A surface's own settings keep
  its prefix (`TEAMS_STREAMING`, `TEAMS_AI_LABEL`, `TEAMS_GATE_*`). Runtime adds `SECRET_SETTING_NAMES` (the `PA_`
  variable of each secret), which the worker reads. Core adds `LIMIT_ENV_PREFIX` (`PA_LIMIT_`) and an optional second
  argument to `parseLimits` (`{ prefix, source }`: the prefix to read, and the variable a value was read from for its
  message); called as before it reads the `TEAMS_LIMIT_` names as before. The secret ids (`SecretName`) and the Key Vault entries are unchanged.
- `@primusclaw/personal-agent-runtime`: the channel context reads the people a message @mentions from
  `message.mentions` as the surface gave them, no longer rebuilt in Teams' mention shape.

### Deprecated

- `@primusclaw/personal-agent`: `ENV_PREFIX` (still `TEAMS_LIMIT_`, the prefix `parseLimits` reads when given none);
  use `LIMIT_ENV_PREFIX`.
- `@primusclaw/personal-agent-runtime`: `ENV_NAMES` (its values still the `TEAMS_` names); use `SECRET_SETTING_NAMES`.
- The `TEAMS_` names of those settings. Each is still read when its `PA_` name is unset or blank; when both are set the
  `PA_` name wins and the worker warns that the `TEAMS_` one is ignored. A worker that reads any of them logs one warning
  at start naming each with its replacement (never a value). They are removed only in a release whose notes say so.

## 0.8.0

A minor release, because its exported API changes incompatibly (#788, #789: listed under Changed): a worker names its
chat surface to Claw so an assistant message returns to the surface it came from (#787), core takes its channel's name,
id and limits from the surface (#789) and the worker process moves into a surface-neutral runtime entry (#788), and a
remote approval card ends in the language it was shown in (#794). The runtime's SQLite store gains one column
(`remote_permissions.lang`), added in place at start; nothing to do for a deployment of the published packages.

**Claw:** return-to-source routing is Claw's (claw-v0.4.0 and later reads the subscription's `surface`). With an older
Claw the `surface` this worker sends is ignored and every subscription gets every message, as before; nothing else in
this release needs a newer Claw.

### Changed

- `@primusclaw/personal-agent`: exported ports and helpers change for anyone implementing or importing them (the
  published runtime and Teams packages implement and call all of them, so a deployment of the published packages has
  nothing to do). Ports: `ClawNotificationsPort.create` takes an optional `surface` and `updateTypes` an optional
  `surface` option; `IntentReader.read`, `readMode` and `readAnswer` take the channel's name; Claw's `NewSession` and
  `SendOptions` carry an optional `channel`; `SurfaceCaps` now extends `SurfaceIdentity` (`channel`, `name`,
  `shortName`) and `SurfaceLimits` (`citationsMax`, `suggestionsMax`, `streamSeconds`), `Conversation` gains `caps` and
  `replyTo`, and `turn.TurnSurface` requires `caps`; `ChannelContextRequest` requires `channel`; `RemotePermission`
  gains `lang` (and `NewRemotePermission` an optional `lang`). Helpers that named Teams now take the channel: the
  constants `INTENT_PROMPT`, `MODE_PROMPT`, `ANSWER_PROMPT`, `LABEL_DESCRIPTION`, `DATA_LINES`, `RULE_HEADING`,
  `CHANGE_HEADING` and `CHANGE_SECTION` are replaced by functions of the channel (`intentPrompt`, `modePrompt`,
  `answerPrompt`, `labelDescription`, `dataLines` and the reply-style heading helpers), and `messageContent`,
  `voteMessageId`, `scopeOf`, `logTurnStarted` and `CommandViews.link` take the channel as a required argument;
  `turn.uploadFolder` and `dataStatement` take it as an optional one, and called without it no longer assume Teams
  (`uploadFolder` returns `<message>` instead of `teams/<message>`, `dataStatement` no longer names Microsoft Teams)
  (#787, #789, #794).
- `@primusclaw/personal-agent-teams` keeps only what is Teams' own (its settings, Azure Key Vault, the queues and the
  Bot Connector, `TeamsSurface` and its renderers, the inbound consumer and the release gate's test entry, as
  `teamsSurface()`); `buildWorker`, `main` and the types `BuildWorker`, `PluginFactory`, `Worker`, `WorkerEnv`,
  `WorkerOptions` and `WorkerServices` are still exported from it, unchanged, so a deployment's own entry keeps its
  imports. The subscription's `surface` is the surface's own id (`SurfaceShape.surfaceId`, Teams' `teams`) (#788).

### Added

- `@primusclaw/personal-agent`, `@primusclaw/personal-agent-teams`: the worker's notification subscription names its
  chat surface (`surface`, `teams` for the Teams worker) on create, and a subscription Claw lists with another surface
  is changed to the worker's on the next reconcile. With claw-v0.4.0 and later, a reply goes back to the surface the
  person's message came from and a proactive message to the surface they used last; a person with one surface sees no
  change (#787).
- `@primusclaw/personal-agent`: core no longer holds Teams' own constants and words: the channel id, its names
  ("Microsoft Teams", "Teams"), the citation and suggestion limits and the stream's lifetime come from the
  conversation's surface, so another chat app can be added as an adapter package without editing core. The Teams
  worker's output is unchanged (#789).

- `@primusclaw/personal-agent-runtime`: a second entry, `@primusclaw/personal-agent-runtime/worker`, the worker process
  without any chat app (the features behind the router, the store and Claw client from the environment, the HTTP
  endpoints, `/metrics`, the background loops, `runMain`, `assembleWorker`) and the `SurfaceAdapter` interface a chat
  app implements. `@primusclaw/personal-agent-teams` keeps only the Teams wiring (`teamsSurface()`) and still exports
  `buildWorker`, `main` and the worker types it exported before, so a plugin host built on it needs no change; the Teams
  worker behaves as before (#788).

### Fixed

- `@primusclaw/personal-agent`, `@primusclaw/personal-agent-runtime`: a remote agent's approval card (a terminal's
  question, connector approval hooks) ends, and answers a click, in the language it was shown in: a Chinese card
  answered at the terminal, timed out or ended stayed Chinese only by chance and could turn English ("answered at the
  terminal" in the tool name's language); a click answered in the person's set language, English when unset. The card's
  language is stored with it (`remote_permissions.lang`); a card stored before falls back to the person's language
  (#794). `/board` redraws such a card in the same stored language, not in the item title's (#796).
- `@primusclaw/personal-agent`: every message to the assistant names the surface it came from
  (`channel_context.channel`, the surface's `SurfaceCaps.channel`), not only a message the assistant reads first
  (`TEAMS_ASSISTANT_UNDERSTANDING`). Claw sends a turn's replies back to that surface (#787); without it a message from a
  second surface was taken as Teams', so a person on both got the reply in Teams. On Teams nothing changes: Claw already
  read a message that names no surface as Teams' (#799).

### Fixed

- `@primusclaw/personal-agent`: every message to the assistant names the surface it came from
  (`channel_context.channel`, the surface's `SurfaceCaps.channel`), not only a message the assistant reads first
  (`TEAMS_ASSISTANT_UNDERSTANDING`). Claw sends a turn's replies back to that surface (#787); without it a message from a
  second surface was taken as Teams', so a person on both got the reply in Teams. On Teams nothing changes: Claw already
  read a message that names no surface as Teams'.

## 0.7.2

A patch release: one fix (#785). No plugin port (core's `src/plugins/`) and no store change; works with any Claw.

### Fixed

- `@primusclaw/personal-agent`: in a group with no language set, or set to "follow the asker", each @-message now
  carries its own words' language as the `[Reply language: ...]` line, so the group session's history no longer decides:
  after `/lang auto` in a group that had talked English, the first Chinese question was answered in English. A message
  with no words of its own (`ok`, `#3`, a link) follows the language of the sender's last message with words in that
  group (kept in memory, so after a restart such a message gets no line until its sender writes one). An explicit group
  setting still wins. The English "follow the asker" announcement no longer reads "asked in in this group" (#785).

## 0.7.1

A patch release: one fix (#779). No plugin port (core's `src/plugins/`) and no store change.

**Claw:** the tool's name on the card needs claw-v0.3.1 or later, which passes it as `remote.tool`; with an older Claw the
card keeps the connector's agent id as before.

### Fixed

- `@primusclaw/personal-agent`: the card of a question a terminal asks names the tool that asked ("Claude Code", "Codex",
  "Cursor": "Claude Code in a terminal on dev-pod"), from the notice's `remote.tool`, instead of the connector's agent id
  (`claude-sessions`). Without `remote.tool` the card says the agent as before (#779).

## 0.7.0

A minor release: each group chat gets its own reply language (#775), and the card of a question a terminal asks says how
that agent's terminal asks (#773). No plugin port (core's `src/plugins/`) changed. The runtime's SQLite store gains one
table (`group_language`), created at start; nothing to do for a deployment. The `personal-agent-teams` image no longer
contains npm or npx, which it never ran (#774: the image scan found six HIGH findings in the base image's bundled npm).

**Claw:** the per-agent wording of #773 reads the connector's `terminal_asks` (connector 0.2.0) as Claw passes it from
claw-v0.3.0 on; with an older Claw or connector a terminal's card keeps Claude Code's wording. The group language works
with any Claw: it rides on the `[Reply language: ...]` line a plain session reads.

### Added

- `@primusclaw/personal-agent`, `@primusclaw/personal-agent-runtime`: each group chat has its own reply language, set by
  any member with `@Clawy /lang en|zh|auto` or a sentence that names the group ("这个群用英文", "use English in this group",
  "follow the asker"), and announced in the chat in both languages with who set it. The first @mention in a group with
  no setting gets a card asking which language to use (中文 / English / 跟随提问者); a pick by any member stores it. In a group
  the group's setting decides (in 0.6.0 a group turn carried the sender's own `/lang` (#771); now it carries the
  group's) and the chat's fixed texts follow it; with no setting, or "follow the asker", each message is answered in its
  own language. A request for one answer in a language ("answer in English", a translation) is not a setting. A person's
  1:1 chat keeps their own `/lang` (#775).

### Changed

- `@primusclaw/personal-agent`: the core's exported `StorePort` gains a required `groupLanguage` repository
  (`GroupLanguageRepository`: `groupLanguage`, `setGroupLanguage` and the asked-once marks of the first-@ card). The
  runtime's SQLite store implements it, so a deployment of the published packages has nothing to do; a store of one's own
  must add it (#775).

### Fixed

- `@primusclaw/personal-agent`, `@primusclaw/personal-agent-teams`: the card of a question a terminal asks no longer
  tells every user that "the first answer counts": its note follows the connector's `terminal_asks` (Cursor: the
  terminal asks only after the card is answered or its wait is over; Codex: typing in the terminal takes the question
  back), and Cursor's "hand back to the terminal" option is in the person's language (交回终端). Claude Code's wording is
  unchanged (#773).

## 0.6.0

A minor release: a choice the assistant puts to the person is a card (#765), a reply language chosen with `/lang`
governs the assistant's answers too (#771), and an answered question card speaks the chat's language (#766). No plugin
port (core's `src/plugins/`) changed. The runtime's SQLite store gains one table (the choice cards), created at start;
nothing to do for a deployment.

**Claw:** choice cards, and the chosen language on the assistant's answers, need claw-v0.3.0 or later, which adds
`choices` to the assistant's `say`. With an older Claw this worker never sees a choice and nothing changes. The other
way round, a worker before 0.6.0 under claw-v0.3.0 or later ignores a say's `choices` (it reads the say's known fields
only) and shows the say's text, which names the options, so the person answers by typing; no card, nothing lost.

### Added

- `@primusclaw/personal-agent`, `@primusclaw/personal-agent-runtime`, `@primusclaw/personal-agent-teams`: an
  `assistant.say` with `choices` (from claw-v0.3.0) is drawn as a card: "请选择一项 / Pick one" with radio buttons, or "可多选 /
  Pick any that apply" with check boxes, the words when they fit, a note that the person can also just reply in the
  chat, and one Send. Send is the person's next message, the picked options joined in the card's order, and goes the
  whole typed path (rate limit, attached agent, assistant); a second press or two at once send once. In a 1:1 chat only
  its person can press it; in a group chat whoever presses it answers, as whoever types there does. A pick is an answer,
  never a command: an option that is a menu word or a phrase help teaches ("New", "重新开始", "Stop", "停止", "Help", ...) is
  sent as those words, not as /new, /stop or /help (#765).
- `@primusclaw/personal-agent`: a language chosen with `/lang zh` or `/lang en` is sent with each message, so Claw
  answers in it too, not only the agent's own texts: to the assistant as `channel_context.reply_language`, to a plain
  session's turn (a group's, or a 1:1 chat without the assistant) as the `[Reply language: ...]` line after the message
  (in a group, the sender's choice). A language only learnt from what the person writes, and `/lang auto`, send nothing
  (#771). With a Claw before claw-v0.3.0 the assistant drops `reply_language` and answers as before; plain sessions
  still get the line.

### Fixed

- `@primusclaw/personal-agent`: the card a typed answer settles (#762) speaks the chat's language (the person's chosen
  or learnt language, else the client's locale, else the question's), not the reply's: "1" or "a" typed in a Chinese
  chat left it English (#766).

## 0.5.0

A minor release: it adds a route to the turn-start log line (#756) and lets a typed message answer a waiting question card
(#762), and fixes two things around question cards and thumbs (#760, #761). No plugin port (core's `src/plugins/`)
changed, and the worker needs nothing new from Claw. The runtime's SQLite store gains two columns on `approvals`
(`questions_json`, `card_id`), added in place at start; nothing to do for a deployment.

### Added

- `@primusclaw/personal-agent`: the worker's `turn started from Teams client` line says which route a message took,
  `route=assistant`, `route=legacy` (a plain Claw session of the person's own) or `route=review` (a review's turn), and is
  now written for a 1:1 message handed to the assistant too: one line per turn, still with no message text and no user,
  conversation or session id (#756).
- `@primusclaw/personal-agent`, `@primusclaw/personal-agent-runtime`: a message the person types while a turn's question
  card waits for them, in the same chat and in time, answers that question (Claw's answer call) instead of starting a turn
  that Claw would queue behind the waiting one until the question timed out. The card says it can be answered in the chat
  ("也可以直接在聊天里回复选项。"; in a group, by @mentioning the bot). A message Claw does queue no longer shows "Thinking…"
  while it waits: its stream closes at once with a queued notice, and the answer comes as a message of its own (#762).

### Fixed

- `@primusclaw/personal-agent`: a question card no longer leaves "Thinking…" up while the person chooses (until the chat's
  nine-minute limit): the stream closes once the card is out, with "请在卡片里选择，选好后我接着做。" / "Waiting for your
  choice in the card; I will continue once you pick.", and the answer comes as a message of its own (#761).
- `@primusclaw/personal-agent`, `@primusclaw/personal-agent-teams`: a thumb from a person bound at the identity service
  but with no linked key is recorded as their vote in Claw: the vote uses the credential the person's chats run on (the
  exchanged token when bound, else the linked key), on the same session as their turns. Before, it was filed as a report
  only (#760).

## 0.4.0

A minor release: it adds the Teams ingress as a released part (#739; its deployable package runs on Node 24 by #745, and
sends concurrently by #748), and fixes what the 0.3.0 acceptance found (#747). No plugin port (core's `src/plugins/`)
changed, and the worker needs nothing new from Claw.

The ingress is deployed from this release's Function package, `personal-agent-teams-ingress-0.4.0.zip` with its
`.sha256`. Its npm package, `@primusclaw/personal-agent-teams-ingress`, is not published to npm; its tarball is attached
to the release like the others.

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
  as the worker does. Sends to the inbound queue run concurrently on an instance's shared sender, each with a 20 s
  deadline, so one send stuck in retries holds up only its own request (a `500` at the deadline), not every request on
  that instance (#748). Settings: [configuration.md](docs/configuration.md#the-teams-ingress) (#739, #745).
- The release attaches the ingress as a deployable Function package, `personal-agent-teams-ingress-X.Y.Z.zip` (one
  reproducible bundle with `host.json`; its sha256 next to it, attested like the tarballs), checked in a real Functions
  host before it is published. [Quick start](docs/quickstart.md#4-the-ingress), step 4, now deploys it instead of
  asking for an ingress of one's own (#739, #745).
- `@primusclaw/personal-agent-teams`: a second entry, `@primusclaw/personal-agent-teams/connector-hosts`, the Bot
  Connector host rule alone, which the ingress imports (#739).
- `@primusclaw/personal-agent`, `@primusclaw/personal-agent-runtime`: help's "About answers and your data" can say what a
  group's recent-messages context keeps (one point per line: what is kept, for how long, that it is never answered or
  stored on its own, where it goes, and `/context off`), shown only where the deployment keeps those messages and its
  chat app is granted them: the new setting `TEAMS_GROUP_CONTEXT_GRANTED=1`, off by default, so until a deployment sets
  it help keeps its previous text (#742).

### Fixed

- `@primusclaw/personal-agent`: the identity card after an answer refused for want of a confirmed identity goes to a
  person at most once in 24 hours, and never once they confirmed. 0.3.0 sent it after every such answer (one per turn,
  not once as its notes said): a second refused request the same day got the same card again. When it was last sent is
  kept in the store (`github_notices`, kind `identity_card`), so a restart or another replica does not send it sooner;
  a card that could not be sent does not count. One card per turn at most still holds (#747).
- `@primusclaw/personal-agent`: Claw's "on it" line (收到，我看一下。) that arrives after its turn has begun to answer is
  dropped. It used to take the receipt under the person's message, replace the reply streaming into it, and close it
  as the answer, so the reply came as a message of its own above it (the 0.3.0 acceptance, a refused settings change).
  The line is known by its id (Claw's `lookupAckSayId`); it still closes a receipt in which nothing has been said yet (#747).
- `@primusclaw/personal-agent`, `@primusclaw/personal-agent-teams`: the identity card's title, body, buttons and AI
  notice are in the person's language; before, a Chinese lead stood over English text and buttons. A lead a caller has
  only in English keeps the whole card English. Pressing 我已确认 before confirming brings the card back in Chinese too (#747).
- `@primusclaw/personal-agent`: `/whoami` for a person connected only through an identity binding (no linked key) no
  longer tells them to send `/unlink`, which cannot remove a binding: it says the chat is connected through a SaFE
  identity binding and that the account's owner deletes it in SaFE under identity bindings (SaFE's administrator when
  SaFE does not name the account). `/unlink`'s answer to such a person is now in Chinese for a Chinese speaker (#747).
- `@primusclaw/personal-agent`: a turn the person stopped ends with the stop line in their language (已停止。 in a
  Chinese chat, group or 1:1; it was always the English "Stopped."), and no longer with a "Report a problem" card under
  it: a stop is what the person asked for. A stop Claw did not confirm on a turn that failed still says the failure and
  keeps the card (#747).

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
  is offered the identity card right after an answer Claw refused for want of it (Claw marks such a reply
  `needs_identity`), at most once per turn, instead of nothing telling them how to fix it (#735).

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
