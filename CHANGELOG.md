<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Changelog

Notable changes to PrimusClaw. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

PrimusClaw is pre-1.0. Until a `v1.0.0` tag exists, treat every interface as
subject to change and pin what you deploy.

Three things are versioned separately, and they do not currently move together:

| Artifact | Versioned by |
|---|---|
| Source | git tags (`v*`), which also trigger the image build |
| Container images | the git tag on a tag push, otherwise `latest` plus a build timestamp |
| Helm charts | each chart's own `version` in `Chart.yaml` |

**`latest` is the chart default and is a moving target.** For anything you
intend to reproduce, set an explicit image tag — `--set image.tag=<tag>` — and
record it.

## [Unreleased]

### Added
- The connector picks up after a restart (a crash, a kill, a pod restart, `stop`, an upgrade): the turn an agent was running is kept
  on disk, and the next run either carries it on (the agent was waiting for a person's permission for a tool call, always asks, and
  the connector is not paused: it asks again and a new card comes, under the same prompt) or ends it with `turn_end` `error: "connector_restarted"`, so a phone stops waiting; prompts queued
  behind it are delivered again after a supervisor's restart instead of being dropped; and each session used in the last 4 hours
  gets one `session_recovered` event, which a chat shows as "recovered".
- A conversation open in a terminal on your machine that has waited a minute for you (Claude Code's own "waiting": a permission or a
  question) is pushed once through your assistant: the machine, the agent, what it waits for and the conversation's title. Answered at
  the terminal within the minute, it is never pushed; a terminal working or finishing is never pushed. A later wait is told again once.
- Pairing a machine from the chat with a one-time code (remote agents). `POST /v1/remote-agents/pairings` gives the signed-in person a
  12-character code (10 minutes, one use, at most 3 live) inside one command line,
  `npm install -g @primusclaw/connector@latest && claw-connector pair <code> --server <CLAW_PUBLIC_URL>`; running it on the machine is the
  approval. The connector trades the code at the anonymous `POST /v1/remote-agents/pairings/claim` for a connector grant (`cpg_...`,
  only its SHA-256 stored) that authenticates on the connector-side routes only, reaches only the connector it registered, and ends when
  that connector is revoked (`/agent off`, logout, `DELETE .../connectors/:cid`): it then answers 401 `revoked`. The owner is told once,
  through their assistant, which machine was paired and how to disconnect it. A grant replaces no row but its own (never another
  machine of the owner's with the same name) and re-registers only under its own row's name; wrong claims are throttled per caller
  (the forwarded chain with the socket address), failures only, with a bounded caller table and at
  most 4 claims at the database at once (64 waiting, else 503 busy); at most 6 codes a minute per person by any route. New tables `claw_remote_pairings`, `claw_remote_grants`
  (created with the remote-agents schema). The router's `devenv_pair` tool answers "连接我的开发环境" with no machine yet, "add a machine",
  "pair my laptop" with that command line, said as given; it is never sent by devenv_send or by a report. Router prompt router-devenv-v8.
- Connecting a machine is said with the exact commands, for every client. `GET /v1/remote-agents/setup` gives the connector's npm
  package (`@primusclaw/connector`), the four commands (`npm install -g`, `claw-connector init`, `claw-connector login --server <this
  API's CLAW_PUBLIC_URL> --identity-url <CLAW_CONNECTOR_IDENTITY_URL, else IDENTITY_ISSUER_URL>`, `claw-connector service install`) and
  the same as a short text in English and Chinese. `devenv_list` with no machine connected, and a `devenv_send` refused `no_machine`,
  carry it (`connect_a_machine`), and the router is told to give it as it is: before, it was told only that "running claw-connector
  connects it" and composed the commands itself. Router prompt router-devenv-v5.
- A minimum and a recommended connector version (`CONNECTOR_VERSIONS` in the protocol, 0.1.3 and 0.1.4; a server moves them with
  `CLAW_REMOTE_AGENTS_MIN_CONNECTOR_VERSION` and `CLAW_REMOTE_AGENTS_RECOMMENDED_CONNECTOR_VERSION`). `GET /v1/remote-agents/connectors`
  and `devenv_list` give each machine's `version_status` (`current`, `outdated`, `unsupported`, `unknown`) and, below the recommended
  version, the `upgrade_command` (`npm install -g @primusclaw/connector@latest && claw-connector stop && claw-connector service
  install`); a heartbeat's answer carries the same (`connector_version`). Below the minimum no new session starts on it:
  `POST /v1/remote-agents/sessions`, `devenv_send` and a pressed `devenv_send` card answer `409 connector_outdated` with the version
  and the command, instead of a session that fails on the old connector. A connector that reports no version is not refused, and a
  session already open on an old connector continues.
- The assistant drives development environments from plain words end to end: `devenv_send` takes
  `new_session` (新开一个会话在 ~/repo 里看看 opens a new session, never an idle one) and reads a folder
  written with `~` in the home folder the agent's roots are in; the router names a session by when it was
  last used (切到昨天那个会话), and answers 回到助理 in a chat that is already with it without running anything.
  `test/e2e/assistant-devenv-eval.ts` measures these sentences, in Chinese and English, against the router's
  real prompt and tools. Router prompt router-devenv-v6.
- A development environment session is pushed only when it needs you, finishes or fails, each once: an instruction the assistant sent
  to an agent on your machine says nothing while it works, one message when the agent waits on a permission request (`assistant.say`
  `remote.ask`: the request with its options and when it runs out, for a channel to put to you as buttons), one when it finished, and
  one when it failed (an error or a refusal, the machine refusing the instruction, or the session closing first, now said as an error
  rather than as a finish). Each message carries `remote: {kind, session_id, machine, agent}` so a channel that already shows the
  session can tell. `GET /v1/remote-agents/sessions` lists, per active session, the requests it waits on its user for (`waiting`).
- `claw-connector doctor` checks the machine first, before its adapter check: Node.js 22+, each agent's program on PATH and on the
  installed service's PATH, Claude Code and Codex signed in, the roots writable, the proxy variables, Claw answering and whether
  Node trusts its certificate (`NODE_USE_SYSTEM_CA=1`, which the service now carries with `NODE_USE_ENV_PROXY`), a service and
  something calling `keepalive.sh`; one fix per problem, exit 1 when something stops sessions (`--json`: `machine_ok`,
  `environment`). A running connector repeats the machine checks with its own environment, in a child process (a stalled disk
  cannot stall the connection), every 15 minutes and at once when `doctor` signals it, and reports them in each agent's
  `capabilities.health` (docs/remote-agents.md, "Health"). The assistant's `devenv_list` passes them on as each machine's
  `problems`, so "is my dev box OK?" and a devenv_send that cannot work are answered with the fix.
  Router prompt router-devenv-v7.
- Brain's `SKILL_HINTS_IN_SYSTEM_USERS` (default none): comma-separated user ids whose turns put the skill and MCP server hints in
  the system message, as `SKILL_HINTS_IN_SYSTEM` does for everyone, so the change can be measured on one identity on a live
  deployment before it is switched on for all. `engine.tools_resolved` logs `hintsInSystem` for each turn.
- `CLAW_IDENTITY_TOKEN_DELEGATED_KEY_CLIENT_IDS` (default none): a delegated identity token of a named service that brings no key of
  the person's own is exchanged once more at the identity provider, and the caller has the keys SaFE holds for the token's subject. A
  chat service that holds no key of the person (a chat user who never linked one) then has the person's turns run on their own virtual
  key instead of none.
- The assistant writes text itself and hands it over with no sandbox: `deliver_text(name, text, caption?)` (router and worker) stores a
  text file (markdown, plain text, CSV, JSON, YAML, code; at most 256 KB, redacted as a message is) as a delivery of the calling
  session, which the user downloads from Claw's own link. A router's file reaches the user at once, a worker's with its next report.
  The router is told that writing, drafting and translating are its own, not a work item's (`router-write-v1`).
- `github_comment(pr, body)` (router, with the confirmation cards on): a comment the router drafted is put to the user as a card that
  shows it whole; pressing it (or `批准 #<ref>`) posts exactly that comment as the user's GitHub account. Nothing is posted by the call,
  and no work item or sandbox is needed to comment.
- `web_fetch` reads a page larger than one answer in parts: `find` returns the page around each place a text appears, `offset` reads on
  from a character; a page cut short says how long it is and the offset to read on.

### Fixed
- "连接我的开发环境" with no machine connected answers the one-line pairing command, every time. devenv_list with no machine, in a
  router turn answering a message the user sent signed in, recently, makes the pairing itself and gives it in `connect_a_machine`
  (`commands` the one line, `text` in the user's language with it in a code block, `pairing` its minutes). Any other turn (a report,
  a message with a key, an old one), and where pairing is refused (no `CLAW_PUBLIC_URL`, too many codes), gets the four setup
  commands; `devenv_pair` now refuses the same turns (`not_attended`, `attendance_expired`). Before, the list always carried the four
  setup commands and the router copied them in 5 of 7 fresh sessions instead of calling devenv_pair. Router prompt router-devenv-v9.
- An assistant whose new lookup differs from its earlier answer says what changed since, not that the earlier answer was its mistake
  (`router-read-v12`, and the placeholder that stands for an earlier turn's result): a pull request merged between two asks was
  told as "上次我多算了 1 个，抱歉".
- A long run taken over by another brain near its end (a Brain rolling update in the middle of it) is announced as a long run again:
  its `run.completed` was measured from the claim that resumed it, which clears and restamps `started_at`, so a 70-second run
  resumed three seconds before its end ran "three seconds" and no notification was recorded (release claw-rel-1917, 2026-11-07).
  A run is now measured across every claim from its run-time anchor, less the time it spent queued.
- A run's `run.completed` / `run.failed` is no longer lost when the outbox write fails at the run's end (an API drain closing
  the database pool under it): the completion was stamped processed regardless, so its redelivery acked and the notification was
  never recorded. What it still owes is now stored with the processed stamp, and the event is redelivered until the notification
  is recorded -- once, by its run-derived key -- without running the rest of the completion again.
- A connector no longer stops for good (exit 78, `needs-login.json`, offline until someone runs `login`) because Claw's sign-in
  service was down. On 2026-11-07 09:50-10:15Z, while SaFE was failing, Claw answered a mix of no answer, 503
  `authentication_service_unavailable` and 401 `invalid_api_key` for a key that was fine, and the connector took four 401s as a
  deleted key. A 401 or 403 that comes while Claw is failing (no answer, 5xx, 429), or within ten minutes of it, or that is not
  Claw's own answer (no JSON error: a gateway's page), is no longer counted and the connector keeps retrying; the same rule now
  applies at start, so a supervisor restart into an outage is not ended by its first 401. A revocation still stops it at once.
- The API answers 503 `authentication_service_unavailable`, not 401 `invalid_api_key` (or `invalid_cookie`), when SaFE answers
  a key or cookie check with a 5xx or with a 2xx that is not an answer, and no longer remembers the latter as a refusal for 30 s.
- A fresh connector install trusts the CAs the machine trusts: a Claw behind a company CA no longer fails `doctor`, `login`, `pair`
  and `run` until `NODE_USE_SYSTEM_CA=1` is set. On Node.js 22.19+ / 24.5+ the connector adds the system store to Node's own list
  (and `NODE_EXTRA_CA_CERTS`) before its first connection and passes `NODE_USE_SYSTEM_CA=1` to the programs it starts;
  `NODE_USE_SYSTEM_CA=0` turns it off. When the certificate is still not trusted, `doctor` says what the connector already did and
  names the next step (add the CA to the machine's store; on an older Node.js, upgrade or `NODE_OPTIONS=--use-system-ca`).
- `claw-connector <command> --help` (or `-h`) prints that command's help and exits 0, for every command; before, `pair --help` and
  `login --help` failed with "unknown option". An unknown option is a usage error (exit 2) for every command, including `login`
  (it exited 1) and commands that take no arguments (`stop`, `pause`, `resume`, `logout`, which ignored them).
- An assistant asked again about something it had just looked up no longer disowns its own answer ("上一条我是在查询结果返回之前就
  写了答案，请不要采信"). A turn with tool calls was handed back to the model as one message, its final text first and every call side
  by side, so a lookup followed by an answer read as an answer written beside (before) the lookup. History now replays each call, then
  its result, then the turn's text, in the order they ran. The router's answer about what it can do no longer labels any part of
  itself read-only (只读) (`router-read-v11`).
- Asking the assistant how many nodes SaFE has no longer answers 0 for members who are not administrators. SaFE answers their
  `node_list` without a workspace with an empty list (200, `totalCount: 0`) rather than a 403, so the answer read "no nodes" while
  the workspaces they use have several. Brain now reads such an empty answer again per workspace of `user_self`, as it already does
  for the 403 of `workload_list`, and says which workspaces the count covers; `limit: -1` still returns every node.
- The brief's SaFE section works for members who are not administrators. SaFE refuses them a workload list across workspaces
  (403), so every such brief said "SaFE 没有回答：safe_http_403". After a 403 the brief now lists the user's own workspaces and reads
  each one (at most 20); a workspace that refuses is left out, and SaFE is unreadable only when every one refuses.
- A machine paired from the chat (`claw-connector pair`) and then disconnected is told, wherever the connector says what to do next
  (the revocation itself, `run` started again by the service or by hand, the supervisor's log line, `status`, `service status`,
  `doctor`'s fix, a sign-in refused at start), to ask the
  chat for a new pairing command and run it, instead of `claw-connector login`, which it never ran. A machine signed in with `login`
  is still told to log in.
- A sandbox torn down by one brain replica while another was walking the handle records no longer stops every replica
  from starting sandboxes. The walk read the deleted record's DEL marker as an unreadable record, marked the fleet count
  incomplete, and admission refused new sandboxes ("the fleet count it would be checked against is incomplete") until a later
  sweep read clean, failing the user's task; replicas that start together sweep in phase, so after a rollout this happened
  often. A deleted record is now an absent one. And a fleet count that is briefly unreadable is waited out
  (`SANDBOX_ADMISSION_STALE_WAIT_MS`, default one keepalive interval plus 15s) before a new sandbox is refused; a refusal after
  the wait, and a fleet genuinely at its ceiling, say in plain words what happened and that a retry later will work.
- `claw-connector init` (`connector/`, next release) no longer merges the Claude Code session hooks into the user's Claude
  `settings.json` without asking. At a terminal it asks first (`[y/N]`); with nobody to answer (a script, a pipe) it leaves the file
  alone and prints `claw-connector hooks install`. `--hooks` adds them without asking, `--no-hooks` skips them.
- The connector (`connector/`, next release) keeps its heartbeat through a stalled state directory (CephFS, NFS). Writes to
  `connector.json`, `sessions.json`, `children.json`, the outbox, the audit trail, the adapter log and the disconnect record, the
  pause-file check and the heartbeat's look at the Claude config directory no longer block the event loop: they run off it, one at
  a time per file, and a write that must land is waited for a bounded time. An event is posted only once its line is written (a restart still never reuses a number), so while the
  disk does not answer events wait and the machine stays online; the run is started with libuv's pool at 16 threads (in the
  systemd unit, the launchd plist and the supervisor's spawn) so stuck calls cannot starve DNS. A test blocks connector.json's temporary file, the audit trail and the outbox log with FIFOs: heartbeats go on, and the
  turn's events arrive once the disk answers. Against production Claw, a connector whose state files were blocked for 75 s stayed
  online throughout; 0.1.4 under the same block went offline (`no_heartbeat`) and stayed stuck.
- A user with no development environment session can connect from the assistant: `devenv_list` gives each agent on an online machine
  its own `attach_command` (`/agent attach MACHINE/AGENT`, which attaches its open session or starts one in its first folder), the
  attach button accepts it, and with no session anywhere and one such agent `attach_default` is that agent (`new_session: true`).
  Before, "connect me to my dev box" with no session open had nothing to attach and nothing it could press.
- `devenv_send` no longer chooses an agent that only takes over existing conversations (`kind: attach`) for a new session, which its
  connector refused (`resume_ref_required`) with nothing said to the user: it is chosen only to continue its own idle session, and
  when it is all that fits, the refusal says so (`which_agent` listing its conversations, else `no_agent`).
  Router prompt router-devenv-v4.
- Opening a remote session at the limit of open sessions (10) closes the user's sessions nobody is using to make room (none for half
  an hour, no command waiting, no turn under way, no approval waiting; or nothing for a day), an offline machine's first, each with a
  `close` to its connector and a `session.reclaimed` audit; `session_limit_reached` now means every open session is in use. Before,
  sessions were never closed unless the user closed them, so ordinary use hit the limit in about a week. `POST
  /v1/remote-agents/sessions` returns the closed ones as `reclaimed`.
- A machine whose connector runs on Windows can be sent instructions from the assistant: its roots (`C:\Users\a\repo`, a share
  `\\server\share\proj`) were dropped as not absolute, so `devenv_send` answered `no_folder` for every one of them. They are folders
  now, and a folder asked for under one compares as Windows does (either separator, any case, a trailing separator or not) and is sent
  as the root spells it with the root's separator; an idle session open there continues however the folder is typed. POSIX roots compare
  exactly, as before.
- Connector: an agent with `approval = "never"` on a machine where the connector runs as root opens its phone sessions again. Claude
  Code offers `bypassPermissions` to root only with `IS_SANDBOX` set, so every such session was refused with `mode_unavailable`; the
  connector now sets `IS_SANDBOX=1` for that agent's Claude adapter only, and says so when it starts. An agent whose own `env` sets
  `IS_SANDBOX` is left as written, and `status` warns when the mode will still be missing.
- Connector: a Claude agent that asks before every step opens its phone sessions in `default` on a machine whose own Claude
  settings default to `bypassPermissions`; the connector tells the adapter to leave that mode out
  (`allowDangerouslySkipPermissions: false`) instead of closing each session with `mode_not_enforced`. The start-up warning
  about it is gone with the refusal.
- Connector: `claw-connector doctor` (also run at the end of `init`) starts each agent's adapter, opens a session without a prompt
  and compares the modes the adapter offers with what `agents.toml` needs, naming the fix instead of leaving it to a refused phone
  session.
- Connector: a supervised connector stopped by a signal that did not come from `claw-connector stop` (a bare `kill`) exits 75 and is
  started again; before, it exited 0, which the supervisor took for a stop on purpose, and the machine stayed offline.
- A Claw release no longer takes development environments offline. An API replica that is shutting down sends every connector
  command stream it holds `event: reconnect` before it ends them, and keeps those connectors online (`stream_end_reason` `restart`)
  while they open the stream on another replica, so a rolling update is neither an offline transition in
  `claw_remote_connector_transitions` nor a reason to tell anyone; a connector that does not come back is offline once the 90 s
  online window has passed, as before. Live releases had shown each connector offline for 2-7 s.
- A Brain rollout no longer cuts a tool call in flight. A drain used to abort every run at once: Hands killed the foreground command
  with its request, the run resumed on another replica told the call was interrupted, and the model said so in the chat and ran the
  command again (one chat turn, cut twice by one rollout, ran its `sleep 90` three times and showed both explanations). A drain now
  lets a call already in flight finish, for up to `SIGTERM_TOOL_GRACE_MS` (default the foreground ceiling plus 20 s, at most 180 s,
  inside the chart's 300 s grace), and the resumed run continues from its recorded result. A call still running then is cut as
  before, and the model is told not to mention the restart.
- Development environments: an instruction accepted while a closed laptop still looked online no longer leaves its chat and its
  assistant item waiting for hours. Five minutes on it is not delivered any more, as before (a new session too, which until now was
  still started up to a day later), and once its machine has gone away since it was queued with nothing heard from it in that
  session and no turn running before it, Claw ends the prompt's turn with `turn_end {error: "delivery_unconfirmed"}`: the item closes
  as dropped and the user is told once that it may not have run. The machine's own end of it, if it comes later, still closes the
  item with its answer. A prompt waiting behind a running turn is never ended this way.
- A `devenv_send` card pressed after its machine registered again (a reinstall, a lost state directory, a rebuilt pod) sends the new
  session to the machine's new registration, when exactly one of that name is online with that agent, instead of failing with
  `no_machine`. A card that continues a session of the old registration fails with `machine_reconnected` and sends nothing; when
  the old row is replaced on registering again, such a card is closed at once as `machine_reconnected`, while a card for a new session
  keeps waiting (it was closed with the row before). An old row still in its reconnect grace is passed over for a newer one online.
- A connector whose command stream has just ended without a graceful hand-over (a replica that crashed, an ingress or gateway
  restart, a token refresh) is online for 45 s more while its heartbeat is fresh: a session asked for in that gap is queued and
  delivered on the next stream, not refused with `connector_offline`, and the break is not recorded as an offline transition.
- A connector revoked (`claw-connector logout`, `/agent off`, `DELETE .../connectors/:cid`) or replaced by registering again under its
  name now ends its open sessions with a `session_closed {reason: "connector_revoked" | "machine_reconnected", by: "claw"}` of Claw's
  own. Their queued commands were dropped with the row and their sessions closed with no event, so an assistant item whose prompt
  was still queued stayed in progress for good and an attached chat waited for an end that could not come.
- A connector registration refused with `connector_limit_reached` no longer replaces anything. An owner already past the limit who
  registered again under a name whose old row was offline had that row revoked and its sessions closed, with no `session_closed`
  said to their items or chats, and a paired machine's grant left pointing at the revoked row; the refusal now rolls all of it back.
- Asked the same question again ("autopilot现在有几台节点" twice), the router no longer disowns its earlier answer ("上一条回答没有查证，请
  忽略", 2026-11-06 parity run, K1). An earlier turn's lookup results are replaced in the next turn's history (a turn that has read must
  not carry that text into one that can act), and the placeholder said only that the result was not kept: next to its own say with
  numbers and no data under it, the model took that answer for unchecked. The placeholder now says the lookup ran and answered in its
  turn, that the answer said after it came from it and is never to be called unchecked, and that a new answer is compared with it.
- A router turn that answered the user and ended without its answer said is counted, by what its end did about it:
  `claw_assistant_router_unsaid_total{outcome}` (`delivered`, `replaced_early_line`, `lost_notice`, `withheld`, `refused`,
  `after_say`). `replaced_early_line` is the parity run's K2 (only "查一下 Autopilot 的状态。" reached the user), which was fixed but
  not counted, so a return of it could only be found by reading transcripts.
- A translation the user asks for is said at once, alone: `say` no longer refuses the English text a Chinese message asked for
  (把这句翻成英文，只给译文), which cost a rewrite of about 1.4 s and put a Chinese label before it (2026-11-06 parity run, S2). A message in
  the language the user named (翻成/译成/写成/用 X 写/X 版, translate … into X, in X) is let through; any other message in another language
  still is refused (`router-v17`).
- A request to review and merge pull requests that are already merged is answered with when each merged and its merge commit, and starts
  nothing: `review_start` reads each named pull request on GitHub first, as the person (their `GH_TOKEN`, else their binding, audited
  as a GitHub read), and refuses `already_merged` before it asks who the reviewer is or hands anything to the channel (G3: the router
  asked who eval-reviewer was). The router calls it before asking anything (`router-v21`). `pr_get` also returns `merged_at`,
  `merged_by`, `merge_commit` and `closed_at`.
- "How many pull requests do I have open" is answered with the total and the pull requests themselves: `issue_search` returns
  `refs_by_repo` (every match as `#number`, grouped by repository in `by_repo`'s order), and the router lists them from it (G1: 18 and the
  per-repository counts, no numbers; `router-read-v9`).
- A pull request number that does not exist is said not to exist: when a read of one (`pr_get`, `pr_reviews`, `pr_files`,
  `review_threads_list`) gets 404 while the repository itself is readable, it answers `no_such_pull_request` with the repository's newest
  pull request numbers, or that the number is an issue (H2: "可能不存在，也可能没有权限", with a number made up). A repository the token
  cannot see keeps GitHub's plain 404.
- An assistant router turn that looks something up answers through `say` again, with its sources. Beside `web_search` and
  `web_fetch`, which have plain names, the model now and then called `say` by its short name instead of `mcp__assistant__say`; the
  call was outside the run's tool allowlist and refused, so the answer went out as the turn's plain text, without sources, saying its
  message tool was not available (2026-11-07 parity runs R1/R2, 3 of 3 lookup turns). Brain's agent loop now reads a call by an
  offered MCP tool's short name as that tool (`tools/offered-name.ts`: only when exactly one offered `mcp__<server>__<name>` matches
  and the name itself is not offered), renamed before the allowlist, hooks, approval, the router and the replayed history see it.
- Router prompts `router-cite-v4` (a page fetched at an address the router knew is never a source, so an official page it wants
  to cite is found with `web_search` in the first step, beside the fetch) and `router-read-v10`: a current fact (the latest version, what a version supports) is
  read now from the source that states it, the latest version from the project's release record (stable.txt, the GitHub latest
  release) rather than a releases page that lags it, and support from that version's own compatibility matrix.
- A person who asks something the router answers from a lookup hears from it at once: when the turn's first web search or MCP read starts
  and nothing has been said, the system says one short line in their language ("收到，我查一下。"), and the answer takes that line's place
  (`CLAW_ASSISTANT_LOOKUP_ACK`, default on; 2026-11-06 nightly: first reply p90 8.4 s against a 5 s target). A router turn that spends every
  step on lookups now answers in text at its cap (Brain `report_at_turn_cap`), and one that still ends with no word is told so once (peer
  run bczh-202: eleven web lookups, no reply). The message saying an item waits for a write its worker holds carries the write as a card
  (`held_write`) for a reader of the session. The router is told outright that what a worker reported is `work_recall`, that "记住…" is a
  memory entry and never a setting, and that a daily brief or a pause is a channel action, never a scheduled task (`router-v18`,
  `router-memory-v2`).
- How far an item got is answered from what its job wrote at the question, not from the worker's last look at it: a worker checks a
  long job only every minute or two, so its last tool output was up to two steps behind the log (2026-11-06 parity run, L1: "step 3/16"
  while the log said step 5). While the item's run is going, `work_recall(item, "live")` also returns `files_now`: the tails of the
  newest files of the worker's workspace, read from its running sandbox (never one started for it; hidden files and dependency trees
  skipped; masked and cut), each with the time it was written, and the router answers from them with the line's time and how long ago
  it was (`router-v16`).
- A difference or percentage between two results is computed from the unrounded values: the router no longer subtracts the rounded
  figures of two reports itself (2026-11-06 parity run, M2: 678.7 where the data gives 678.6) but asks the item that has the data, and
  a worker rounds only the figure it reports (`worker-v6`).
- An item's result is no longer said twice. The silent sweep took a say shown in the assistant session as having told nobody when the
  user had no channel subscription, and said the result again about five minutes later, into whichever session was the user's by then
  (2026-11-06 parity run: #119 and #120 into the session that replaced the deleted one, #121 into its own). A say whose event was
  published to a session that is still there (`claw_assistant_says.session_id`, recorded after the publish) now tells a user with no
  channel that takes it. What the system says about an item on its own goes to the session the item was started from
  (`claw_work_items.router_session_id`); when the user deleted that session, once to the one they have now (made, as their next visit
  would, when none was made yet), marked as from an earlier conversation.
- A result whose router could not be woken is said at once, not about five minutes later by the silent sweep. A session made again after
  the user deleted one holds no credentials until their first message in it, so the wake was refused (`assistant.wake_not_queued
  error=no_credentials`) and only the sweep said the result (2026-11-07 parity run, v369 B-short). The system now says it with the report,
  in its own words and under the sweep's id, so it is still said once. When the user has spoken in the new session, the router is told
  the item came from an earlier conversation, and its message about the item starts with （之前的对话里开始的事项）, as the system's own
  does (v369 B-talk: said with no marker).
- A follow-up that starts a new item ("去掉 cancelled 再算一次") no longer leaves its worker without the file the user sent earlier: a new item
  gets a copy of the files the user sent in the last 24 hours of the conversation (`files_from_earlier_messages`), the router is told
  they will go with it, and it forwards a follow-up to the item that did the work while that item is open (`router-v15`).
- A write a worker holds for its person is no longer put to them before what was found: the worker reports what it found first
  (`worker-v5`), that report is said to the person ahead of the request, and the request says what the write would do in plain words
  (the comment it would post, whole) in the person's language, never as the tool's name alone. A comment the router drafts itself is
  put on its card after the answers the user asked for (`router-write-v2`).
- How far an item got is read now, not estimated: `work_recall(item, "live")` shows the worker's last steps with their times (a log's
  latest lines included), and a `say` that names an item still in progress, in a turn answering the user, is refused until that turn
  looked at the item.
- A NATS timeout that reaches a brain run wrapped in another error (the sandbox layer's `hands KV is unavailable` and DAG-binding
  write failures keep the `NatsError` as `cause`) is retried like a bare one instead of ending the run for good, and is reported as
  `infra_transient` rather than `upstream_timeout` when its retries run out. A retryable failure now waits 5 s, 10 s, 20 s, 40 s,
  then 60 s per attempt (was a flat 5 s), so a stall spends the delivery budget over the time it lasts.
- A development environment item no longer stays in progress after its last instruction ended when two stops came in quick
  succession and a turn finished on its own as the first was on its way. The connector (`connector/`, next release) names the
  prompt each `turn_end` ends (`data.cmd_seq` and `data.cmd_id`; `null` for the end of a cancel that found nothing running) and
  refuses by name each prompt a cancel drops from its queue (`command_rejected`, reason `cancelled`). Claw keeps the command
  numbers of an item's open prompts (`open_cmd_seqs`; a number, which the credential masking of events never changes, unlike a
  client's `Idempotency-Key` in a `cmd_id`) and ends exactly the prompt named; a turn's end that names a prompt the item does not
  have open ends nothing. The end a cancel brings ends every prompt still open that was sent before it, so a prompt whose turn's end
  never came (the connector restarted mid-turn) ends with the next stop. A connector that does not send `cmd_seq` is counted as before.
- A router turn that said only a line that it was on it ("查一下 Autopilot 的状态。") before its lookup answered, and then wrote its
  answer as plain text, no longer leaves the person with that line alone: the completion skipped the text because the turn had
  spoken. When the turn's stored `toolUsed` events show that every say that went out came before its last lookup ended (answered or
  failed), the text is delivered as its answer, once, and takes the line's place (`replaces`, #360)
  (`assistant.unsaid_answer_after_early_say`). The plugin's `teams-reply-style` rule reaches the router under a heading that keeps
  it to how a say's text looks: its line asking for a line between tool calls is the Teams sessions', not the router's.
- A worker that left what the user asked for in its last words (after a one-line report, or with no report) no longer loses it: final
  words of 1200 characters or more that no report of the run held are delivered as `item-<n>-reply.md`.
- A `say` whose `[n]` lost its source (the page was fetched at an address no lookup returned) is refused with what to do, instead of
  reaching the user as a number that links nowhere; a turn that ended in plain text is said without its bare `[n]`.
- The router answers a list item by item from the result (`owner/repo#number`), gives numbers exactly as returned (no estimates), and
  never tells the user an earlier answer was unchecked (`router-read-v8`).
- A review item's pull request is followed after its turn (`gh_pr_follow`, the review items' sweep, at most every 90 s per item):
  merged or closed on GitHub ends the item and closes what its session still held for the reviewer's answer. For a review asked of
  someone else that may merge, the requester's own GitHub account merges their pull request once the reviewer's approval of the head
  is on GitHub, CI is green, no thread is open and the merge state is CLEAN, instead of waiting for the reviewer to confirm a held
  merge; the held merge closes as merged by the requester. One acting user may now be asked about 30 writes at once (was 10).
- `claw-connector logout` (`connector/`, next release) revokes this machine's connector at Claw before it deletes the sign-in. It
  said "signed out" and left the connector row alive: still the user's connector, and instructions sent to it waited for the next
  sign-in on that machine. With a key it calls `DELETE /v1/remote-agents/connectors/:cid`; with a device sign-in, whose access token
  the user side refuses, the new connector-side `POST /v1/remote-agents/connectors/:cid/revoke` (the same revocation, for any of the
  caller's connectors). When the row cannot be revoked (Claw unreachable, the sign-in already refused, a Claw without the new route),
  the sign-in is still deleted, `logout` says the connector is not revoked, prints the `curl` that revokes it, keeps its id, and
  exits 1.
- Remote connector presence over time: every change of a connector's presence is recorded, the connector list gives
  `last_seen_at`, `offline_since` and `offline_reason` (`auth_expired`, `no_heartbeat`), and a connector offline for 5 minutes
  is reported once to its owner through their assistant with when it was last seen and the command that brings it back, then
  once more when it is back. The seconds-long breaks a Claw release causes are never reported.
- The assistant router's `say` takes an optional `suggested` (`CLAW_ASSISTANT_SUGGESTED_REPLIES`, default on): up to three short
  replies the user is likely to send next. They are checked (one plain line of at most 30 code points each, no address, markup, slash
  command or internal text, none twice; one that does not fit is left out and never refuses the message) and carried by
  `assistant.say` and the session's `AssistantSay` as `suggested_replies`, for a channel to show as buttons that send them.
- Citations of the agent board: `CLAW_ASSISTANT_CITE_LINK_SERVERS` (`agent-board=https://host/board/`, default none) names plugin
  read servers whose JSON results carry their own pages as `html_url`; a router turn that reads one sends them as
  `ExecuteRequest.cite.link_servers`, and Brain keeps the `html_url` of each top-level result object under that prefix as a source of
  the new kind `board`. A `say` that cited a board issue it had read lost the source before (no lookup of the turn had returned it).
- The router's read section says what it can do, from the tool catalog (`router-read-v7`): reads at once; every write of its
  servers, GitHub's and anything needing code or a run through a work item whose worker asks the user before each write; never
  "read-only", and never a system failure (a sandbox that would not start, a 403) as a limit.
- The assistant's week: `GET /v1/assistant/brief?range=week` and the router's `brief(range: "week")` put together the last seven
  days (items that ended and how, pull requests merged or closed with their links, SaFE workloads that succeeded and failed), for a
  weekly report written from what Claw holds. The router can schedule a brief through the same confirmation card as any trigger
  (`trigger_create` with `action: "brief"`, no prompt), and a brief trigger whose schedule fires at most weekly says the week.
- `CLAW_ASSISTANT_JOB_HTTP_SOURCES`: kinds of job the deployment adds to `job_watch`, each read over HTTP with the user's own
  platform key (the URL names the job with `{id}`; dotted paths pick its state, a line about it and, optionally, its owner; listed
  end states end the watch). Only https, or plain http to an in-cluster `.svc` host, is taken.
- Three GitHub writes, each held for the user's decision like every write of the `github` server: `checks_rerun_failed` (run
  again the failed jobs of a GitHub Actions workflow run; `checks_list` now gives a job's `run_id`), `pr_request_reviewers` (people
  and teams) and `labels_set` (the whole list of an issue's or pull request's labels). None is a router read.
- An assistant's router turn diagnoses a failure itself: of the assistant plugin's servers it is offered SaFE's `workload_logs`,
  `workload_events`, `workload_pod_logs`, `workload_pod_containers`, `node_pod_logs`, `node_reboot_logs`, `cluster_logs` and
  `flavor_avail`, and the agent board's `notification_read` and `milestone_read`; the user's scheduled tasks (`trigger_list` of
  the turn's own `schedules` server, kept only when this API minted its bearer for this turn's session, message and run); and the plugin's
  `teams-reply-style` rule. Its log reads go to Brain as the new `ExecuteRequest.log_reads` (each read's line-counting
  argument, empty for `workload_pod_containers`, which counts nothing but whose termination messages can hold a log's end):
  Brain asks for at most 40 lines or entries, masks credential-shaped text in the answer before the model, an event or a log
  line sees it (new `redactLogSecrets` of @claw/utils: `redactSecrets`; values after a credential's name, where an unquoted
  value runs to its line's end, or to the closing quote of the string its name is in, and no separator or bracket ends it; Kubernetes environment variables named like a credential; armored private keys, OpenPGP ones
  included, and a key whose BEGIN line the tail cut off, from its first base64 line), and keeps the last 6000 characters of a
  plain-text answer.
- Work on the user's development environments is on their work item list (`kind = 'remote'`, one item per remote session, written
  by Claw from the session's prompts and its connector's events), so "did the one I just ran finish?" is answered from the list,
  for a prompt typed into an attached chat (told to nobody) as for one the assistant sent (told once when it ends or waits for an
  approval). New router tool `devenv_send` puts an instruction for an agent on one of the user's own machines to them as a card
  (held write kind `devenv_send`, showing the text, the machine, the session and the folder): nothing is sent from the turn, even
  one answering their own signed-in message; it is sent only when they press the card or reply `批准 #ref`, which then picks the
  machine, continues an idle session or opens one, and files the item. `why_card` says `confirm_first`, or why the turn could not
  act anyway; with cards off it is refused (`cards_off`). The agent's answer and its tools' titles stay off the router's item list
  (`work_recall` reads them and marks the turn). `work_send` refuses these items, `work_stop` and the item's stop button cancel the
  agent's turn, and the silent sweep skips them. Router prompt router-devenv-v3.
- An assistant router turn answers about the user's development environments itself: `devenv_list` (where
  `CLAW_REMOTE_AGENTS_ENABLED` is on) lists their own machines (online, last seen, version, agents) and every agent session on them
  (open through Claw, or the agent's own conversation a connector offers to take over) with its state, folder, last activity, a
  label and the command that attaches the chat to it; `detail: "activity"` adds what each one is doing in the agent's words.
  Either read marks the turn as having read untrusted text; such a turn may still put the attach command of one of the user's own
  sessions to them as a button, and nothing else. The router prompt treats 开发环境 / dev box / my machine as the connector, never as
  a SaFE workspace, and "connect me to it" as `channel_action` with that attach command. Only the caller's rows are read.
- Citations for the assistant router's answers, behind `CLAW_ASSISTANT_CITATIONS` (default off). The router writes [1], [2] in its
  `say` and names each number's address in `say`'s new `sources` argument; the new `ExecuteRequest.cite` makes Brain keep the sources
  the turn's own lookups returned (`web_search` hits and what the API's GitHub server lists in its results' `_meta["claw/sources"]`:
  pull requests, issues, repositories, files, and checks on GitHub's own pages; a page `web_fetch` read whole only confirms one of
  those or an address the user wrote in the message, `cite.user_urls`, and never adds a source) and send `say` only the entries that
  match, in the MCP request's `_meta`, where the model cannot write; an address no lookup returned is dropped and counted. The API
  checks them again (numbers cited in the text, none in a text that can make a link of its own as CommonMark with GitHub's
  autolinks reads it, escapes resolved; http(s) addresses without credentials or anything redaction would mask; titles cut to one
  plain line of 80 code points with markup, addresses and hidden characters removed) and the `assistant.say` payload and
  `AssistantSay` event carry them as `sources: [{ n, url, title, kind }]`. The text is never changed, so a streamed say stays a
  prefix of the message, and a `sources` argument of the wrong type is read as none rather than refusing the say. New counter
  `claw_assistant_say_sources_total{outcome}` (`cited`, `dropped_not_in_turn`, `dropped_invalid`, `dropped_over_cap`,
  `unreferenced`, `suppressed_link_text`).
- The assistant takes the files a person sends and hands back the files and long answers its work produces. A channel uploads the
  files to the assistant's session and names them beside the message (`channel_context.files`: `path` below `.uploads/`, `name`,
  `media_type`, `size`; at most 10, only paths inside the session's own uploads). The router turn that answers the message is told what
  came and is shown the images itself: the new `prompt_images` field of the execute request names them, and Brain reads them from the
  session's uploads and sends them with the prompt as image blocks (whole PNG, JPEG, GIF or WebP up to 3.5 MB, at most 4 and 6 MiB of base64 together; the checks
  are now one module, `@claw/protocol` `images.ts`, shared with Hands' `read`; the OpenAI wire sends them as image parts). Every item
  the turn starts or instructs (`work_create`, `work_send`) gets a server-side copy of every file in its worker's session before its
  message is queued (the copies side by side, under one 10 s deadline), and the worker is told where; a copy the store refused or
  that was not done by the deadline is answered as `files_not_attached`. A worker's
  `deliver_file` reaches the user: after a report that says something (any kind but progress), at a worker run's end and from the
  assistant sweep, each delivered file still downloadable is announced once, oldest first, as an `assistant.say` in the system's words
  carrying `files` (`item_id`, `session_id`, `id`, `name`, `size`, `content_type`, a small image inline) for a channel to draw as a
  download; a report records how far its files were announced in the new table `claw_work_item_delivery_checks`, so a store that did
  not answer is retried by the sweep, and a file's message that neither a channel's outbox nor the session holds is published
  again. A delivered file's name is said inside a code span and redacted as the message's text is. Long answers are said whole: `say`
  takes up to 9000 characters (the router is still asked for about 600 unless the user needs more), an `answer` report up to 8800
  (other kinds stay at 600), and an answer longer than 600 is sent to the user whole by the system at once (stored for sending in the
  report's own transaction, and only then is the router told it was sent); a plain-text router ending is cut only past 9000. The super-agent evaluation sends a turn's `files` as a channel does and grades
  `delivers` and `style.min_chars`.
- Quicker assistant router turns. A router turn can ask for low reasoning effort (`CLAW_ASSISTANT_ROUTER_EFFORT`: low | medium |
  high | `default`, the default, for the model's own; set `low` where the router runs on a reasoning model such as Claude; a session
  that chose an effort keeps it), and its `say` is published while the model writes it (`CLAW_ASSISTANT_STREAM_SAY`, default on): the
  new `ExecuteRequest.stream_tool_text` names tools whose `text` argument Brain streams (Anthropic `eager_input_streaming`, Claude
  models only) and publishes as `toolTextDelta` events (`tool`, `actionId`, the text so far, at most every 400 ms per call, top-level
  loop only). The call itself still runs when the step is whole; the deltas are a preview for
  whoever follows the session live and are not stored. The router's read-only lookups (`read_taint.sources`) now run side by side
  within a step, as Brain's sandbox reads do.
- An assistant's work item whose worker holds a write for its person's decision, or asks them with `ask_user_question`, now reaches
  that person and waits for them (`assistant/holds.ts`). The item moves to needs_you with what it waits for as its question (and a
  new attention), and the request goes out as an `approval.requested` with `source: "assistant_item"`, the item, and for a question
  the questions, to each subscription that lists the type and the new `assistant_item` source (not in the default set; the
  subscription routes accept it). With no such subscription the item's needs-you message goes at once, not after the silent sweep's
  wait, and a request a channel took counts as that message, so the sweep does not repeat it. The decision, the answer, or the end
  of the wait (`decisionResult`, the question's result) puts the item back in progress, as does the end of the run that waited (an
  aborted wait sends no decision; the assistant sweep releases one whose run ended unseen). A worker's sub-agents can wait at once:
  the item records each request (`params.holds`) and goes back to work only when the last is over, and a request whose end arrived
  first holds nothing. The router's turn is shown what waits
  ("Waiting for you in work items"), which only the person answers. Worker turns carry the new `ExecuteRequest.decision_wait_ms`
  (`CLAW_ASSISTANT_DECISION_WAIT_SEC`, default 3600, 0 keeps Brain's settings), which Brain uses for that run's approval and
  question waits and announces as their `timeout_ms`. Before, nobody was told and the item said "in progress" until Brain refused the
  call after `HITL_DECISION_TIMEOUT_MS`. The super-agent evaluation runner answers such a request through the same routes (`hold`).
- The assistant acts later on its own. With `CLAW_TRIGGER_TOOLS_ENABLED` (and triggers and the assistant on) the router has
  `trigger_list`, and `trigger_create` / `trigger_cancel`, which create and cancel nothing themselves: the write is stored as a
  confirmation (new table `claw_assistant_confirmations`, 24 hours) and put to the user as a card (`assistant.say` with
  `confirm_write`: its id, short ref, kind and button label; the session's `AssistantSay` event now carries `confirm_write` and
  `confirm_action` too). The user's press is `POST /v1/assistant/confirmations/:id/decision` (`allow` | `deny`), taken as a held
  merge's answer is: from their own sign-in, or from a service listed in `CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS` answering for them,
  never from a key; or their whole signed-in message `批准 #<ref>` / `拒绝 #<ref>` through `confirmation_answer`. The write happens in
  the transaction that closes the card, so one card does it once; the answer says when the trigger first runs. `GET
  /v1/assistant/confirmations` lists open cards. A router turn proposes only while answering a message of the user's, before it has
  read anything untrusted.
- The user's brief: `GET /v1/assistant/brief?lang=&timezone=` puts it together without a model from their items, the pull requests
  their items watch and what happened on them, the runs and approvals Claw notified them about and the writes waiting for them, the
  jobs the assistant watches, and their SaFE workloads read with their own key (failed in the last day, pending over 30 minutes,
  running). Every section is there; one that could not be read says "could not check". The router reads it with `brief` (with the
  schedule tools; the turn no longer acts for the user afterwards). A trigger may now have `action: "brief"`
  (new column `claw_triggers.action`, default `run`): it fires without a run, saying the brief through the owner's assistant once per
  planned time (recorded as `delivered`; refused at creation without the assistant).
- An item whose title or brief names pull requests in full (a link or `owner/repo#123`, at most three) watches them from the start, as
  `work_subscribe` would (read-only), when the loop can read the user's GitHub token; `work_create` answers `watching` or
  `not_watched` with the reason (`no_github_token` without one).
- Job watches, behind `CLAW_ASSISTANT_JOB_EVENTS` (default off; `CLAW_ASSISTANT_JOB_POLL_SEC` 30, `CLAW_ASSISTANT_JOB_MAX_WATCHES`
  20): the router's `job_watch` (a SaFE workload of the user's own, read with their key, or a run of theirs), `job_watch_list` and
  `job_unwatch`.
  A loop modelled on the GitHub events loop claims due watches, writes each change of state once (new tables
  `claw_assistant_job_watches`, `claw_assistant_job_events`) and tells the user in their language; an ended job ends its watch, a gone
  one says so, and one unreadable for ten minutes says so once.
- Model choice for the assistant's items, behind `CLAW_ASSISTANT_MODEL_CHOICE` (`on` | off, default off; needs `CLAW_ASSISTANT_ENABLED`
  and a non-empty `CLAW_ASSISTANT_MODELS`, the allow-list as `name=label,...`). One function decides an item's model: the model the
  message asked for, else the payer's own review default (reviews), else their own default, else the deployment's default for the kind
  (`CLAW_ASSISTANT_WORKER_MODEL`, or the new `CLAW_ASSISTANT_REVIEW_MODEL`), else Brain's `DEFAULT_MODEL`. A review asked of someone
  else uses that person's settings; the model the requester named is set aside and reported in `ignored`. A name off the allow-list is
  refused with the list; a model other than the deployment's default for the kind is asked of the gateway with the payer's own key
  (cached five minutes), and one it cannot use falls back to `CLAW_FALLBACK_MODEL` (or the kind's default), recorded as
  `params.model_asked` and answered as `fell_back_from`; when the gateway cannot be asked, a named model is refused and a default runs.
  `work_create` and `work_send` take `model`; `review_start` / `review_restart` no longer need the model's name in the message; the new
  `model_default_set` sets the user's defaults (attended turns only), as do `GET`/`PUT /v1/assistant/settings` (new table
  `claw_user_model_prefs`); the router is shown the allow-list with labels and the user's defaults. A worker turn's model is the
  deployment's worker model only when its session names none. A worker, review or router turn the gateway refuses for want of a key
  binding (403 "No APIM Key binding found", 401 "missing subscription key") is run again once on `CLAW_FALLBACK_MODEL`, and the user is
  told (with `CLAW_ASSISTANT_KEY_BINDING_URL` when set); new table `claw_assistant_model_fallbacks`. Off, nothing changes: no new tool
  arguments, tables, routes or prompt lines.
- The assistant's `review_start` naming another person is handed to the channel that carried the message when that channel declares
  it can start such a review with the reviewer's own credentials (`channel_context.handoffs: ["review_for_other"]`): an
  `assistant.action` named `review_for_other` with a typed `review` (reviewer, pull requests, merge, the person's message), queued
  once after the same grounding, and the router is answered `handed_off`. A channel that does not declare it, or a user with no
  subscription to `assistant.action`, gets the `acting_as_credentials_required` refusal as before. The handoff is recorded
  (`claw_assistant_review_handoffs`) and its id handed over (`review.handoff_id`); `POST /v1/assistant/reviews` takes it back as
  `handoff_id` and reads the record, not the body: such a review only reviews when the router read no merge, and starts once per
  handoff; when it may merge, it merges as the reviewer's own review mode says. The reviewer must be named in the person's message, not
  only listed by the channel (`reviewer_not_named`).
- Archived sessions can be deleted on a schedule: `SESSION_RETENTION_DAYS` (default 0, off) makes the API's daily
  maintenance delete a session that many days after it was archived, through the same commit as a user's delete (queued
  messages dropped, turns, events and summaries stamped deleted) with its S3 workspace and checkpoint prefixes removed by
  the existing cleanup sweeper. Never taken: sessions made through the Anthropic-compatible API, sessions with a run in
  flight (their own or a team member's), open tasks or queued messages, and the worker session of any work item; each
  is checked again under the session's row lock before it is deleted. `SESSION_PURGE_DAYS` (default 0, off) removes for
  good the stamped rows of sessions deleted more than that many days ago. `SESSION_RETENTION_BATCH` (default 500) bounds
  each pass; `SESSION_RETENTION_DRY_RUN=true` only logs the counts (`session_retention.dry_run`). Archiving now records
  `claw_sessions.archived_at` (a new nullable column; a session archived before it existed counts from `updated_at`).
- A review asked of someone else (`POST /v1/assistant/reviews` with `acting_as` naming another person) is that person's: their item, their session sealed with their own keys (brought as `x-acting-as-token` and `x-acting-as-api-key`), their quota; their delegation switch is asked at creation and before every queued turn; the session runs with a fixed review profile and, on SaFE, a sandbox in `SANDBOX_CPU_NAMESPACE` created with `useWorkspaceStorage: false`; the requester sees four facts only. `POST /v1/sessions` refuses `requested_by`, `sandbox_profile`, `requester_note` and `acting_as` naming anyone but the caller (a deployment with `CLAW_ASSISTANT_REVIEW_ITEMS` off has no way to ask a review of someone else). New settings `CLAW_REVIEW_FOR_OTHERS_*`. The assistant's `review_start` refuses a review by someone else (`acting_as_credentials_required`; the user is sent to the review agent named by `CLAW_GITHUB_REVIEW_AGENT_NAME`); the requester's assistant lists the reviews they asked of others read-only (four facts), and `work_recall` / `work_stop` act on them with only those facts in the answer. A review the assistant's router starts or restarts merges nothing by itself, whatever its `merge` says: its session (`config.merge_needs_confirmation`, kept by every restart) holds its merge, and an approval GitHub's auto-merge or merge queue would turn into one, for the acting user's confirmation whatever the risk and review mode, made only from the card's button or `批准 #<ref>` / `approve #<ref>`; while auto-merge is on or the pull request is in the merge queue, such a session (and a review-only one) resolves no thread (`gh_thread_resolve` answers `auto_merge_on`).
- The user's long-term memory in the assistant, behind `CLAW_ASSISTANT_MEMORY_TOOLS` (`on` | `off`, default off; needs
  `CLAW_ASSISTANT_ENABLED` and `CLAW_MEMORY_ENABLED`, and the user's own opt-in). A router turn is shown the one-line
  index and offered `memory_recall`, `memory_save`, `memory_update`, `memory_forget` and `memory_undo`; each write acts only
  for a turn that answers the person's own signed-in, recent message (the review tools' attended check: a worker's report,
  a message sent with a key, a stale one or a turn that has read a worker's words is refused; reading works), on an entry whose number is in that message or
  in what the assistant said to them just before, quoting that message, and never in a conversation marked
  `memory: "off"`. A task item's worker is shown a read-only index and may only recall; a review item's session is shown
  only the entries bound to its item, and so is a task item's worker while any of its pull request subscriptions allows
  answers without asking (`reply_allowed`): no index in its prompt, and `memory_recall`, asked again on every call,
  reaches only entries bound to its item. A worker's session keeps what it read from run to run, so once
  an item's worker has been shown the index or recalled an entry beyond its item, `pr_reply` refuses that item for good
  (`memory_reached`; it answers by asking, through the github tools) (`claw_work_items.memory_reached_at`, a new column
  required at start-up). An entry can be bound to one work item (`claw_memory_entries.work_item_id`, a new
  column required at start-up); bound entries are left out of the chat's catalogue, and a save is checked for a duplicate
  or a near one only against entries of the same binding. Workers started from a session marked `memory: "off"` are
  marked so too, and an assistant's watcher of a group or a repository is never served the chat's memory. The chat's
  own memory tools and
  their fixed forget and undo phrases are unchanged.
- A work item can watch a GitHub pull request, behind `CLAW_ASSISTANT_GITHUB_EVENTS` (default off; needs
  `CLAW_ASSISTANT_ENABLED`). New comments, reviews, review comments, a failed CI on the head commit and the pull request
  closing reach the item's worker as one queued message, without anybody mentioning it and without going through the
  router. A small loop reads each watched pull request every `CLAW_ASSISTANT_GITHUB_POLL_SEC` (default 30, at least 10)
  with the owner's own `GH_TOKEN`; each event is stored once under GitHub's id and delivered in the transaction that
  queues the message, at most 6 deliveries per item in 10 minutes (the rest wait, they are not dropped). A pull request
  that cannot be read for 10 minutes puts the item in front of the user; neither that nor any other report of the watch's own
  replaces a result waiting for the user (it is told once the result is sent back), and the pull request closing does not take
  such a result back. New routes `POST/GET
  /v1/work-items/:id/subscriptions` and `DELETE /v1/work-items/:id/subscriptions/:sub_id`; the router gets
  `work_subscribe`, the worker `pr_reply`, which answers one event on the pull request as the owner, once per event,
  and only where the owner allowed it themselves (`reply: true`, which needs an identity-provider sign-in; a key or
  ending the subscription takes it away); an answer carrying the owner's token, one of their stored values or
  anything shaped like a credential is refused. Only comments and reviews by people who can write to the repository
  (their permission on it, asked of GitHub: admin, maintain or write) or by the owner's own account reach the worker;
  others are recorded and dropped. When the owner's token cannot see who may write (no push access, as on an upstream a
  fork's pull request goes to), others' comments are held back as `author_unverifiable` and the owner is asked once
  whether to keep watching; a permission GitHub would not give (a rate limit) is asked again, never judged. Bots reach
  the worker only when listed in `CLAW_ASSISTANT_GITHUB_TRUSTED_BOTS` (default empty). Comments the `github` tools write
  end with an invisible `<!-- claw:github-tool -->` mark, so an answer the owner approved there does not come back to the
  worker as news. One poll asks GitHub five things; one user's watched pull requests share 1200 requests an hour (each is
  read less often the more there are), and nothing of theirs is read while GitHub reports less than a fifth of their
  token's hour left. Every stored value is looked for in an answer, a value shorter than 8 characters as a whole word,
  and the refusal names the variable. Events still waiting when the user stops watching are dropped. A failed CI is passed on as counts, run ids and conclusions, never the runs' names. Reviews on someone's behalf are never subscribed. New tables `claw_work_item_subscriptions`,
  `claw_work_item_github_events` and `claw_work_item_pr_replies` (required at start-up when the assistant is on);
  `CLAW_ASSISTANT_GITHUB_MAX_SUBSCRIPTIONS` (default 20) caps what one user watches.
- A review item reviewed again continues the last review (with `CLAW_ASSISTANT_REVIEW_ITEMS`): what a review posted is
  recorded with its threads (`claw_github_audit.posted`, a new column; `params.record` on the item), a restart or a new
  request after the requester's closed item gives the fresh session the open findings to check first, and `gh_pr_get`
  reads only the change since the last head unless it was rewritten, merged the base branch in, is large or touches
  security or CI paths. Such a
  session is offered `gh_thread_resolve` for the recorded threads of the acting user's own findings. See
  `claw/docs/github-review.md`, "A review again".
- `run.completed` and `run.failed` notifications carry `message_id`, the message whose turn the run was (a trigger's
  run names the message the trigger sent; `null` for a task that has none). A client that sent that message and
  already showed its answer can now tell the run's end is that turn's by the id: a run is closed after its last
  answer, often more than a minute after, so matching by time sent a second "Run completed" card to the chat that had
  just shown the answer.
- The assistant can watch a group chat or a repository and record what it would do there without doing it, behind
  `CLAW_ASSISTANT_OBSERVE` (default off; needs `CLAW_ASSISTANT_ENABLED`): `POST /v1/assistant/observations` hands one
  message of a place (`group:<channel>:<id>` or `repo:<owner>/<repo>`) to a watcher session of the caller's own, whose
  every assistant tool only writes a record (`claw_assistant_observations`); `GET /v1/assistant/observations?scope=`
  reads it back message by message; `GET`/`PUT /v1/assistant/scopes` list and switch a place between `observe` (the
  default) and `auto`, which only a person's sign-in (or a service in `CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS`) can
  set. Acting in `auto` is not built yet: a place in `auto` is still only recorded. New tables `claw_assistant_scopes`
  and `claw_assistant_observations`, required at start-up when the assistant is on.
- A watchdog for work items, behind `CLAW_ASSISTANT_WATCHDOG_SEC` (default 0, off): an item in progress with a run or a
  queued instruction behind it and no sign of life for longer than the threshold is moved to "needs you" with the
  reason (no progress, a worker with no heartbeat, an instruction no run took up), which wakes the assistant; it runs
  in the assistant's existing sweep and stops nothing.
- On-behalf GitHub reviews as work items of the assistant, behind `CLAW_ASSISTANT_REVIEW_ITEMS` (default off; needs
  `CLAW_ASSISTANT_ENABLED` and `CLAW_GITHUB_REVIEW_ENABLED`): `POST /v1/assistant/reviews` and `POST
  /v1/assistant/reviews/:id/restart`; `claw_work_items.kind` (`task` | `review`) and `params` (new columns, required at
  start-up when the assistant is on) on every board row; one open review per pull request across users; stopping a review
  item denies what its session holds for an answer. See `claw/docs/github-review.md`, "As an item of the assistant".
  `POST /v1/sessions` now checks `acting_as`, `review_target`, `review_only`, the model and the effort through the same
  function (`github-review/acting-session.ts`); its answers are unchanged.
- The assistant's review and settings tools, behind `CLAW_ASSISTANT_TOOLS=on` (default off): `review_start`,
  `review_restart`, `confirmation_answer`, `review_mode_set` (towards `high_risk_confirm` only) and `channel_action`
  (an `assistant.action` outbox event when the user typed the command whole; otherwise an `assistant.say` carrying the
  command as `confirm_action`, for the channel to run only when the user presses its button). A held write is let through
  only by the exact command `批准 #<ref>` / `approve #<ref>` naming it, or the card's button. They act only in a router turn
  that answers the user's own signed-in message
  (recorded in the new `claw_assistant_messages` when the message is accepted, with how it was authenticated), received
  at most `CLAW_ASSISTANT_ATTENDED_TTL_SEC` (600) seconds before, that has not read a worker's words; and only on what
  that message names. A user's message now stops a router turn that is reading a worker's report, and a router turn
  that answered the user and failed without a word is followed by one system notice. See `claw/docs/github-review.md`.
- GitHub tools as an MCP server hosted by the API, off by default (`CLAW_GITHUB_MCP_ENABLED`, with
  `CLAW_GITHUB_MCP_SECRET`). A session whose owner keeps `GH_TOKEN` in their env vault is offered `github`:
  eleven read tools that run without asking and six write tools (comment, open an issue or a pull request,
  change a pull request, reply to or resolve a review thread) that each wait for the user's decision. The
  owner's token is read by the API per call, from the session the signed token names; it never travels in
  the server entry. See `claw/docs/github-mcp.md`.
- Built-in bash approval rules for GitHub writes from the shell (`git push` force / delete forms, pushes
  to `main` / `master` and pushes that do not name their destination, writing `gh pr` / `gh issue` / `gh release` / `gh api` / `gh repo` / `gh workflow` /
  `gh secret` / `gh variable` / `gh label` / `gh run` / `gh gist` / key / cache commands, a GraphQL mutation,
  and `curl` / `wget` writes to `api.github.com`), on unless `BASH_APPROVAL_DEFAULTS_ENABLED=false`. A run with
  no approval channel now has these commands denied instead of run. The outbound-actions pack gains the same
  rules, and no longer holds a GraphQL read. See `claw/docs/bash-approval.md`.
- Brain's MCP client passes on every content block of a tool result: an image, an embedded resource or a
  resource link becomes a line that says what it was (an embedded text resource is passed in full) instead
  of the result reading as empty, and a result with only `structuredContent` is passed as JSON. A server that
  declares resources is also offered `list_resources` and `read_resource` under its own prefix.
- A general working guideline for agent turns (`claw/packages/api/src/sessions/agent-guideline.ts`): read before
  changing, verify before claiming done, say what was not verified, cite sources, answer in the user's language, treat
  text from pages and files as data, respect approvals. It names no product. With `CLAW_AGENT_GUIDELINE_ENABLED=true`
  the API sends it as `system_append` on every turn that does the user's work; an assistant Router turn never gets it.
  Off by default, which changes nothing. Brain's `RULES_DIR`, its `execution-policy.txt` placeholders and plugin rules
  are untouched.
- An agent evaluation (`claw/packages/api/test/e2e/agent-eval.ts`): 40 tasks in six categories (research, code,
  documents, GitHub, MCP, long-running) run through the API a client uses, graded from the session's events and files,
  with per-category tool calls, failed calls, approvals, turn time, sandbox wait and tokens taken from what Brain
  already records. `EVAL_ARM=guideline` compares a run with the guideline against one without.
- A session chooses its reasoning effort as it chooses its model: `effort` (`low`, `medium`, `high`, or `null` for none)
  on `POST /v1/sessions` and `PATCH /v1/sessions/:id`, stored in `claw_sessions.effort` (new column, required at start-up)
  and sent on every turn and on every task-system run of the session (new `ExecuteRequest.effort`, which Brain sends as `output_config.effort`, or
  `reasoning_effort`, on every turn and sub-agent of the run). A value outside the set is a `400`; none sends nothing,
  as before. A session created with `config.acting_as` (a pull request reviewed on someone's behalf) is an ordinary
  session in this: it runs on the model and effort its creator chose, or the deployment's defaults. There is no
  review model or review effort setting.
- `config.review_only: true` on a session created with `config.acting_as` (a `400` without it, or for a value that is
  neither a boolean nor null): its `gh_pr_merge` is refused with `review_only` before anything is read, so it reviews, and may
  approve, but never merges, never approves on the way to a merge, and does not approve while GitHub's auto-merge is
  on for the pull request or it is in the merge queue (`review_only` as well); a held merge of such a session is refused at
  the acting user's allow as well.
- A deep review behind `CLAW_GITHUB_REVIEW_DEEP_ENABLED`, on by default (`false` turns it off, and then the review
  instructions, path advice and thresholds are exactly the previous ones). On, any change of a non-test source file,
  or of more than 200 lines (`CLAW_GITHUB_REVIEW_FAST_MAX_CHANGED_LINES`, 600 with it off), takes the sandbox path (`source_change`), and the
  default instructions require it: check the pull request out, read the callers of every changed function and
  export, build and run the closest tests under a time bound, then a second adversarial pass by a read-only
  sub-agent; the review body lists what was read and run and carries non-blocking suggestions and open questions,
  while inline comments stay for verified blocking findings. The gates are unchanged.
- An on-behalf review costs less: every turn of a session that acts as a user writes its rolling prompt-cache markers
  for 5 minutes and keeps the anchor at `LLM_CACHE_TTL` (new `ExecuteRequest.rolling_cache_ttl`; other sessions are
  unchanged), bounds its second pass to 20 turns (new `ExecuteRequest.sub_agent_max_turns`, never above
  `SUB_AGENT_MAX_TURNS`), and hands that pass the diff file, what was read and the callers seen but not opened.
  `gh_pr_get` answers in pages of up to 23000 characters (Brain cuts that tool at 24000, other tools still at 6000), and
  the deep review's sandbox path reads the diff once from its checkout instead of in pages. Deploy Brain before the API.
- The model can schedule work itself: with `CLAW_TRIGGER_TOOLS_ENABLED` (needs `CLAW_TRIGGERS_ENABLED` and a
  `CLAW_TRIGGER_TOOLS_TOKEN_KEY` of 32+ characters; off by default) every turn but a trigger's own run is offered
  `trigger_create`, `trigger_list` and `trigger_cancel`, served by the API at `/v1/internal/trigger-mcp`. The user is
  always the owner of the calling turn's session, named by a bearer minted for that turn, never by an argument;
  `trigger_create` is held for the user's approval. A trigger can end by itself (`until`, `max_runs`, also accepted by
  `POST /v1/triggers`), and one made from a work item's worker wakes that worker instead of starting a new session.
- A service that acts for a person (a delegated identity token: RFC 8693 `act`) can now bring the person's own
  `ak-` key in `x-api-key`, for the services an operator names in `CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS` (empty by
  default, which changes nothing: such a token still has no keys and the header is still not read). SaFE verifies the
  key, it must be the token's own subject's, and the request is still judged by the token. A key that is another
  user's is a 401 `key_subject_mismatch`, one SaFE does not accept (or a value that is not a key) a 401
  `invalid_api_key`, and SaFE not answering a 503; a request that asked for its key to be used is never served without
  it. With GitHub review on, each such service must also be in `CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS`, or the API
  does not start. See `claw/docs/identity-client.md`.
- The sandbox of a session that acts as a user (`config.acting_as`, GitHub review on) is created without its owner's
  keys: Brain is told (`ExecuteRequest.withhold_sandbox_keys`, set on every turn of such a session) to leave
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `SAFE_API_KEY` out of its environment, whichever layer sets them, while it
  still uses the keys for the model and for SaFE; a sandbox the session already has that holds them is replaced rather
  than reused, and a hosted application run is refused for such a session (409
  `app_run_not_allowed_for_acting_session`; Brain winds up one admitted earlier). Nothing changes for any other session,
  and no sandbox fingerprint stored before this is disturbed. See `claw/docs/github-review.md`.
- Brain now enforces `ExecuteRequest.tools_allowlist`, which it used to ignore. A run whose request carries a
  non-empty list is offered only the tools it names, and a call outside the list is refused with an error
  instead of run: a tool the model was never offered, one a resumed transcript still names, a `task` or
  `todo_write` the loop handles itself, and anything a sub-agent calls (a sub-agent starts from the parent's
  tools narrowed by the same list). An entry is an exact tool name, or a name ending in `*` that matches by
  prefix (`mcp__<server>__*` names a whole MCP server). A request with no list, or an empty one, changes
  nothing. The API's DAG expander used to fill a node that set no list with the names of its plugin's MCP tool
  rows, which are not the names Brain's tools have; such a node now sends no list (so it keeps every tool, as
  before), and a list a node does set has an entry naming one of the plugin's MCP tool rows converted to
  `mcp__<server>__*` for each server that row declares. A node's list that is not a list of strings is refused
  when the template is registered (and when a stored one is expanded) instead of being read as no list.
  `mode=script` tasks still ignore the field.
- The assistant's board, off by default (`CLAW_ASSISTANT_ENABLED=true`; one switch for every user, no per-user
  list): `POST /v1/assistant` returns the caller's assistant session, made on first use and the same one every
  time; `GET /v1/work-items?state=in_progress|needs_you|done` and `GET /v1/work-items/:id` show the work the
  assistant took on (done items for the last seven days); `POST /v1/work-items/:id/accept` takes the result
  version the user saw and refuses a version that is no longer current (409); `POST /v1/work-items/:id/stop`
  closes an item and interrupts its worker. A user's unfinished items are capped by
  `CLAW_ASSISTANT_MAX_ACTIVE_ITEMS` (default 20) and `CLAW_ASSISTANT_ROUTER_MODEL` picks the assistant
  session's model. Another user's item is a 404. Four tables (`claw_assistants`, `claw_work_items`,
  `claw_work_item_events`, `claw_assistant_says`) exist only while the switch is on; the assistant's model
  tools and the way a worker reports are separate changes.
- The assistant's turns, still behind `CLAW_ASSISTANT_ENABLED`. A user's messages go to their assistant session,
  whose turns are cut to the assistant's own tools (`tools_allowlist: ["mcp__assistant__*"]`, so Brain must
  already honour it: roll Brain out first): `say` is the only way anything reaches the user (the assistant's
  plain output goes nowhere), `work_create` starts a work item in its own worker session, `work_send` and
  `work_stop` steer it, `work_recall` looks closer. A worker reports with one tool, `report`, and never speaks
  to the user; a report, its event and the message that wakes the assistant are one transaction, and a report
  from a run that is no longer the item's current one is refused (generation fencing; a new instruction to the
  item fences out the run that was still executing). A worker turn that ends
  without reporting is recorded as ready (or failed), and the sweeper records a turn whose end was lost, reports
  as failed an item in progress that nothing is running or queued for, and
  tells the user about an item that has needed them for `CLAW_ASSISTANT_SILENT_SWEEP_SEC` (default 300) with
  no delivered message. The tools are served at `/v1/internal/assistant-mcp`, authenticated by a per-turn
  bearer signed with `CLAW_ASSISTANT_TOKEN_KEY` (required, 32+ characters, when the switch is on);
  `CLAW_ASSISTANT_WORKER_MODEL` and `CLAW_ASSISTANT_ROUTER_MAX_TURNS` (default 8) tune the turns.
- `CLAW_REQUIRED_PLATFORM_ROLES` (chart: `api.requiredPlatformRoles`; empty by default, which changes
  nothing) names platform roles of which a caller must hold at least one to use Claw at all. Anyone else is
  refused with a 403 `platform_access_required` ("no access yet - ask an administrator") on every
  authenticated route, before any LLM key is cached for them. The roles are the ones the platform's
  verification of the caller's credential reports; a connector token and a BYOK key bring none, so they are
  refused while the setting is on, and so is an identity token unless it carries a role the identity provider
  confirmed (`CLAW_IDENTITY_TOKEN_TRUSTED_ROLES`; the `default` every such caller has never counts). Claw knows
  no role names. Scheduled triggers already created keep firing for a user who loses access. See
  `claw/docs/platform-access.md`.
- The `a2a_call` tool is now a complete A2A client, off by default behind `A2A_CLIENT_ENABLED` (chart `extraEnv`;
  while it is off the tool is not offered to the model and a call that arrives anyway is refused). With it on:
  a peer is called where its Agent Card says (the JSONRPC 1.0 `supportedInterfaces` entry, cached by `ETag` /
  `Cache-Control`) instead of at a guessed `<base>/a2a`, and only on the origin the operator wrote down; the
  result is JSON `{state, task_id, context_id, text, artifacts, input_required?}` instead of text; `mode` gains
  `get` and `cancel`, and `context_id` continues a conversation; a peer that asks for input or approval comes
  back as `state=input_required` with the question (and a structured approval request when the peer sends one),
  and the model answers by calling again with the `task_id` (`approval` for an approval request, whose `allow`
  is held for the user's own approval before it is sent); a streamed call stops waiting after
  `A2A_STREAM_IDLE_TIMEOUT_MS` (default 120 s) without an event, or `A2A_STREAM_MAX_MS` (default 600 s) in
  total or when the run's budget is nearly spent, and then returns `state=working` with the `task_id` rather than
  failing; and the user's Stop sends `CancelTask` to the peer. A peer entry in `A2A_AGENTS` may now set
  `card_url`, and either `audience` (and optionally `scope`) -- Brain exchanges a short-lived token for the
  session's user at primus-identity (`user_id:<owner>`, RFC 8693) and calls the peer as them; the token stays in
  the Brain process -- or `auth_env` as before (a service credential, the peer sees Claw rather than the user).
  What a peer writes back is scrubbed of the credentials the call sent before the model reads it.
  An entry with a key it does not know, or with both `auth_env` and `audience`, is refused. The tool's `skill`
  parameter, which nothing read, is gone. With the switch off the prompt also loses its "A2A Auth" line.
  See `claw/docs/agent-server-design.md`, "Outbound `a2a_call`".
- The API accepts an access token from an OpenID Connect identity provider (`Authorization: Bearer <JWT>`,
  verified by the shared identity client against the issuer's key set) as a credential beside the existing
  ones, behind `CLAW_IDENTITY_TOKEN_AUTH_ENABLED` (off by default; also needs `IDENTITY_CLIENT_ENABLED`).
  The token must be typed `at+jwt`, name `CLAW_IDENTITY_TOKEN_AUDIENCE` (default `claw-api`) and carry
  `CLAW_IDENTITY_TOKEN_SCOPE` (default `claw.api`); `sub` becomes the user id and the caller has the `default`
  role only (the token's `roles` are not copied, so enabling this never grants admin).
  `CLAW_IDENTITY_TOKEN_INTROSPECT` also asks the provider whether the token is still active. The chart takes
  `identity.tokenAuth`. See `claw/docs/identity-client.md`.
- `CLAW_IDENTITY_TOKEN_TRUSTED_ROLES` (chart: `identity.tokenAuth.trustedRoles`; empty by default, which changes
  nothing) lets an administrator who signs in through the identity provider reach the admin pages. It names
  `system-admin` and/or `system-admin-readonly`; such a role is adopted only for a token that claims it and whose
  RFC 7662 answer, asked now, is active, names the same subject and lists it. A token that does not verify as the
  configured issuer's never gets that far, an inactive token is refused, and a provider that cannot be asked
  leaves the caller a plain user (never the token's claim, and not a 503).
- A user can vote on an answer of their own session. `PUT /v1/sessions/:sessionId/feedback`
  (`{ "message_id", "vote": "up" | "down", "reason"? }`) records it and
  `DELETE /v1/sessions/:sessionId/feedback/:messageId` takes it back; both answer `{ "ok": true }`.
  There is one vote per user per message, a repeat replaces it, and only the session's creator may
  vote: another user's session, a deleted one and a missing one are the same 404. `message_id` is
  text (1-100 characters from `A-Za-z0-9._:@-`) and `reason` is at most 8192 characters. A session
  holds at most 1000 votes per user (409 past that). The votes live in the new table
  `claw_answer_feedback`, created by the same idempotent start-up migration and required by the
  schema check.
- `GET /v1/images?search=<text>&limit=<n>` lists the container images the caller may pick from, as
  `{ "items": [{ "name", "tag"?, "createdAt"? }], "total" }` (`name` is the full reference; `limit` is
  50 by default and at most 200). It asks SaFE with the caller's own credential and passes on only
  those fields. When SaFE cannot answer, the reply is a 503 (unreachable, not configured, or kubernetes
  mode) or 502 (an answer that is not an image list), with `{ "error", "reason" }`, and a 401 or 403
  when SaFE refuses the caller.
- `auto_approve` on an MCP server spec, the sibling of `requires_approval`: an explicit allowlist (tool
  names, a trailing `*` for a prefix, and an optional `when` that must equal the call's top-level scalar
  arguments) of the held tools that may run without a decision, so a session nobody is watching can run
  low-risk tools. A held tool that is not listed still waits for a person; an absent field changes
  nothing, and a malformed one releases nothing. A release is recorded as `decisionResult` with
  `by: "policy"` and counted in `claw_hitl_policy_allow_total` (no labels: a request can carry its own
  server spec, so the entry that released the call is in the `hitl.policy_allow` log line instead). See
  `claw/docs/mcp-approval.md`.
- GitHub pull request review, guards around the account of someone who is asked for (all inside the feature, which is
  still off by default). The ordinary request is the author of a pull request asking for a committer's review and
  merge: with the committer's standing authorization (the identity provider's `delegation` flag) it is made with the
  committer's account and no confirmation, and the author's own GitHub is not looked at; an `APPROVE` review or a
  merge of a high-risk change is held (`confirmation_required`, `kind` `merge` or `review`) until the committer
  confirms that very write, and the held review keeps its event, text and inline comments, which the confirmation
  route lists and answers `submitted` once posted. A `COMMENT` or `REQUEST_CHANGES` is never held. The acting user
  may not approve or merge a pull request they wrote (`cannot_approve_own_pull_request`), refused before CI, the
  diff or any confirmation. A session may be bound to one pull request with
  `config.review_target = {owner, repo, number}`, set only at creation: every tool call that names another is
  refused as `review_target_mismatch` before the acting user's credential is looked up. A merge into a branch with a merge
  queue (a `merge_queue` rule, or the pull request's own `isMergeQueueEnabled`, which also covers classic branch
  protection) puts the pull request in the queue instead of merging it: after the approval (or the committer's allow
  of a high-risk merge) the committer's account calls GraphQL `enqueuePullRequest` pinned to the head the review read,
  and the answer is `queued` with the queue entry, never `merged`; Claw does not follow the queue (a moved head is
  `head_moved`, a refusal by GitHub `enqueue_refused`). An account whose GitHub login is empty is refused for an
  approval or a merge (`acting_login_unknown`), and `gh_pr_get` says `acting.acting_user_is_author`. The review
  footer, the hidden run marker and the repository configuration file no longer carry the name of the chat
  integration: the footer name is `CLAW_GITHUB_REVIEW_AGENT_NAME` (default `Claw`), the marker is `claw-review:run`
  and the file is `.github/claw-review.yml`; the old marker and file are still read and never written. The
  confirmations table gains `kind`, `review` and `action_key` and the statuses `submitted` and `queued` (upgraded in place at start-up).
  See `claw/docs/github-review.md`.
- GitHub pull request review, off by default (`CLAW_GITHUB_REVIEW_ENABLED=true`). A session created with
  `config.acting_as = <user id>` is offered four tools (`gh_pr_get`, `gh_pr_risk`, `gh_review_submit`,
  `gh_pr_merge`) that review, and when everything is green merge, a public pull request with that user's GitHub
  account. The token is fetched from the identity provider for one call and never reaches a sandbox, a tool result,
  a log line or an event. Every gate is in the tool: owner allow-list and public repositories only, the head
  commit pinned, the acting user's own permission and their setting for others acting for them (without it,
  comments only), CI green on the head commit, no unresolved thread, GitHub's merge state `CLEAN`, a versioned
  high-risk rule pack that holds a merge for the acting user's confirmation
  (`GET /v1/github-review/confirmations`, `POST .../:id/decision`, which takes an identity-provider access token
  only: the person's own sign-in, or a service an operator named in `CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS`
  acting for the user its token names, recording both. It refuses the `ak-` or BYOK key a sandbox holds and the
  session cookie that key can sign in to at SaFE; the same credentials are required to create a session with
  `config.acting_as` and to start any turn in one: a message, an approval or an answer, a task, a batch, a retry
  or a workbench run). The
  rules judge what the change does (architecture, interface, security-sensitive code, CI and release,
  dependencies, size and breadth) from its net diff, so a pure refactor stays low; a file that came without its
  diff (a binary, or an LFS pointer), a lock file and an edit of an authentication module or a release file stay
  high as a floor whatever the edit looks like, and the reviewing model can raise a verdict with a reason shown on
  the confirmation (`risk_judgement`) and never lower it. Rate limits, a request budget per session, a
  dry-run switch and an audit row per call (`claw_github_audit`). A small change is reviewed from the diff
  without starting a sandbox; the path taken is logged and audited, and the thresholds are
  `CLAW_GITHUB_REVIEW_FAST_MAX_FILES` / `_MAX_CHANGED_LINES`. A repository's own review skill is read from the
  tip of the base branch; the default `pr-review` skill is in `claw/examples/skills/pr-review/`.
  The merge waits a few seconds, one request a look, for GitHub to finish working out the merge state after the
  approval it just posted (`UNKNOWN`, or `BLOCKED` until the review counts; CI is read again before a merge that waited), and a review's hidden marker
  carries a digest of its text and inline comments, so a second, different review of the same kind on the same commit is posted.
  On the sandbox path the model gets a credential-free bash recipe that fetches the pull request anonymously, shallow and
  pinned to the reviewed head, reusing an existing checkout. The shared
  identity client gains `resolveExternalCredential` (`IDENTITY_CREDENTIAL_RESOLVE_URL`). See
  `claw/docs/github-review.md`.
- A session can be bound to a repository. `POST /v1/sessions` accepts `config.repo = {url, branch?}`
  (`url` is `https://<host>/<owner>/<name>[.git]` with no credentials, query or fragment; `branch` is a
  plain ref name, empty meaning the remote's default; anything else is a `400` starting
  `config.repo`). Whenever Brain opens the sandbox for such a session it makes `/workspace/<name>` a git
  working tree before the model is asked anything: a clone when absent, only a `git fetch` when a `.git` is
  already there (a restored snapshot: local commits, the current branch and uncommitted edits are left
  alone), and the repository's `.git` attached beside the files when a snapshot has files but no `.git`. The
  turn's prompt gains a `[Repository]` block and the repository's `AGENTS.md` / `CLAUDE.md` (32 KB at most,
  cut with a marker). The sandbox's global git config gets `credential.helper = !gh auth git-credential`, so
  `git push` works with the user's own `GH_TOKEN`, which never appears in a URL, a command line or a log. A
  failed clone does not fail the run; the reason is in the block. A session without `config.repo` is unchanged.
  See `claw/docs/sandbox-session-lifecycle.md`.
- Remote agents, off by default (`CLAW_REMOTE_AGENTS_ENABLED=true`): a program on a user's own
  machine can dial out to Claw, advertise the agents it can run, receive commands over a
  `text/event-stream` and post back the events they produce, while the user's own clients read the
  session, send commands and answer permission requests through the API. Presence, resumable streams
  (`Last-Event-ID`), keepalive, owner-only access (another user's id is a 404) and an audit trail are
  included; Claw does not interpret what an agent says. See `claw/docs/remote-agents.md`.
- Connector access tokens: the four connector-side routes of remote agents accept an RFC 9068 JWT
  (`Authorization: Bearer`, audience `claw-api`, scope `claw.connector`, type `at+jwt`) issued by the
  identity provider and verified with the shared identity client, beside the keys and sessions they
  already accept. The token is a credential on those routes only; the user side and every other route
  answer it as a request with no credential. The caller is the token's subject with the `default` role,
  a token is good until it expires or, with `CLAW_CONNECTOR_TOKEN_INTROSPECT=true`, until the provider
  says its grant is revoked, and a command stream opened with one ends (`event: token_expired`, or
  `event: revoked`) when the token does. The audit trail records which kind of credential a
  connector-side action used. Off unless remote agents and the identity client are both on. See
  `claw/docs/remote-agents.md`.
- A shell in a session's sandbox, for a browser, through the API alone (no direct call to SaFE). The
  session's creator -- no one else, admins included; anything else answers 404 -- gets
  `GET /v1/sessions/:id/terminal` (`{state: "ready"|"none"|"starting"|"ended", message?, target?}`),
  `POST /v1/sessions/:id/terminal/ticket` (body `{cols, rows}`, answers `{ticket, expiresInSeconds,
  wsPath}`) and `GET /v1/sessions/:id/terminal/ws?ticket=...` (WebSocket). Everything is looked up and
  opened with the caller's own SaFE key. A browser WebSocket cannot send an `Authorization` header, so
  the socket is authenticated by the ticket: random, good for one connection for 30 seconds, bound to
  one user and one session, kept (as a hash, with the key it carries sealed) in the new table
  `claw_terminal_tickets` so any replica can redeem it. The proxy passes SaFE's webshell frames
  through as they are (input as text or binary frames, `RESIZE <cols> <rows>` as a text frame, output
  as binary frames) and ends both sockets together; a terminal with no traffic in either direction for
  `TERMINAL_IDLE_TIMEOUT_SECONDS` (default 900) is closed with code 4408, and one open for
  `TERMINAL_MAX_LIFETIME_SECONDS` (default 28800, 8 hours; traffic does not extend it, so a tab left on
  `tail -f` is ended too; 0 and anything outside 60 to 604800 is refused and the default applies) is
  closed with code 4409, and `TERMINAL_MAX_CONNECTIONS` (200) and
  `TERMINAL_MAX_CONNECTIONS_PER_USER` (5) bound what one replica holds. SaFE being unreachable or
  refusing the key answers 502, and a deployment without SaFE 503, each with `{error, reason}`. The
  WebSocket server is the `ws` package, a new dependency of the API.
- `connector/`, the client of remote agents: `claw-connector` runs on a user's own machine and exposes
  their Claude Code, Codex and Cursor agents (over the Agent Client Protocol) through outbound HTTPS only.
  Device sign-in (RFC 8628) or a development key; a per-agent directory whitelist; every session forced into
  the agent's ask mode and the mode read back before the first prompt (a session whose mode cannot be
  confirmed is not opened); the adapter's own permission options passed through verbatim, including
  allow-always; credentials masked before upload; a local audit log; a kill switch that stops only the
  process groups it started. See `connector/README.md`.
- `@primusclaw/connector` on npm: publishing a GitHub Release tagged `connector-vX.Y.Z` runs
  `.github/workflows/connector-release.yml`, which tests the connector, signs a build-provenance attestation
  for the tarball, attaches it to the release and publishes it with npm Trusted Publishing (a short-lived OIDC
  credential and a provenance statement; no stored npm token). The publish waits for a required reviewer
  of the `npm-publish` environment (who may be the maintainer who cut the release; administrators cannot
  bypass it), which is what keeps an unreviewed commit from being published, and creating a `connector-v*`
  tag is limited to repository admins by a tag ruleset. The tag must equal the version in
  `connector/package.json`. Once a release has been published,
  `npm install -g @primusclaw/connector` installs the `claw-connector` command (Node.js 22 or newer).
  The package holds only the two bundles (the CLI and the session-hook program), README and LICENSE, and the Connector packaging workflow checks a real
  tarball on every change (`connector/scripts/check-pack.mjs`), together with the shape of the release workflow.
- `@primusclaw/connector` 0.1.1 is the first version published by the release workflow, with a build-provenance
  attestation (`gh attestation verify` on the tarball attached to the release, and the provenance shown on npmjs.com). It has
  the same code as 0.1.0, which was published by hand: no behaviour change.
- `@primusclaw/connector` 0.1.2: `claw-connector status` (text, and a `warnings` field in `--json`) and the start-up line of
  `run` warn per agent when the machine's Claude Code settings default to `bypassPermissions` (user `settings.json` or the
  managed settings file) and the agent has no `approval = "never"`, so every session of that agent would be closed with
  `mode_not_enforced`. Before, such a machine showed online and nothing said so before the first session (#247).
- `@primusclaw/connector` 0.1.4: every `turn_end` of a prompt's turn names the prompt it ends (`cmd_seq`, `cmd_id`), so a
  development environment item no longer stays `in_progress` after its last instruction when stops and turn ends cross (#365);
  `claw-connector logout` revokes the connector at the Claw it registered with before it deletes the sign-in, and exits 1 with
  the remedy when it cannot (#367).
- `@primusclaw/connector` 0.1.5: on `event: reconnect` (a Claw replica shutting down for a release) the connector opens its command
  stream again at once, without the reconnect backoff and without waiting for the end of the response a gateway may hold (up to the
  75 s watchdog before); `disconnects.jsonl` records it as `server_closed` / `restart`. A second such frame within 5 s takes the
  usual backoff, so a release never becomes a burst of reconnects.
- `@primusclaw/connector` 0.1.6: `claw-connector doctor` checks the machine first (Node version, the agents' programs on the PATH the
  service sees, whether Claude and Codex are signed in, writable roots, proxy variables, a Claw certificate Node does not trust, the
  keep-alive) with one fix per problem, then opens a session on each agent's adapter; a running connector re-checks every 15 minutes
  and reports the result with each agent's health, which the chat shows; `service install` also carries `NODE_USE_SYSTEM_CA` and
  `NODE_USE_ENV_PROXY` (#416). After a restart (a crash, a kill, a pod or supervisor restart, an upgrade) a connector carries on
  a turn that was waiting for a tool approval and shows its card again (an agent that always asks, not paused, offline for less than
  the card's lifetime), ends any other running turn with `connector_restarted`, keeps the prompts that were queued, and says
  `session_recovered` for a session used in the last 4 h (#419).
- `@primusclaw/connector` 0.1.7: `claw-connector pair <code> --server <url>` signs a machine in with a one-time code from the chat
  (#421); setup no longer touches a network mount that may hang, the npm install of the adapters runs without the agents' keys,
  and a session that never received a message survives a connector restart (#435). (0.1.6, as published, also carried #430 and #425.)
- `@primusclaw/connector` 0.1.8: `init` asks before writing Claude hooks and a stalled state directory no longer stops the heartbeat
  (#401); a paired machine that was disconnected is told to pair again (#437); a conversation open in a terminal can be taken over
  once the person confirms (#423, connector part); a fresh install trusts the machine's CA store without `NODE_USE_SYSTEM_CA` (#443);
  every command answers `-h`/`--help` and an unknown option exits 2 (#440); a crash that damages `connector.json` no longer
  registers the machine as a new connector (#446).
- `claw-connector`: an owner can let an agent run without per-step approval, like in their own terminal.
  `approval = "never"` on an `[[agents]]` table (or `claw-connector init --approval never`, `--approval claude=never`)
  starts that agent's sessions in its no-approval mode (Claude `bypassPermissions`, Codex `agent-full-access`,
  Cursor `agent` with `--force`), lets the phone select such modes for that agent only, and accepts the adapter's
  "will not ask" warning (audited) instead of refusing the session; a file-level `allow_unsafe_modes = true` accepts it
  too, for every agent without its own `approval`, and without either the session is still refused. Agents
  report `unattended` and `unattended_allowed` in their capabilities, and `session_started`, `session_resumed` and
  `mode_update` carry `unattended`, so a client always shows how a session runs; the API relays them unchanged. See
  `connector/README.md` and `claw/docs/remote-agents.md`.
- A shared identity client in `@claw/utils`, built by API and Brain when
  `IDENTITY_CLIENT_ENABLED=true` (off by default; it authenticates a request only through the access-token
  credentials above, a connector's and an identity provider's). It does OIDC
  discovery and caches the issuer's JWKS, RFC 7662 token introspection (an active answer is cached for
  30 s, an inactive one for 5 s, concurrent lookups of one credential share one call), and an RFC 8693
  token exchange with a token cache. When the provider cannot be asked, a cached active answer keeps
  being served for up to 30 minutes (`IDENTITY_STALE_IF_ERROR_SECONDS`, counted in
  `claw_identity_stale_served_total`); anything else is a typed `IdentityUnavailableError` and is never
  read as "inactive". The chart takes an `identity:` block (client secret by `existingSecret`
  reference) and exports `claw_identity_*` metrics. See `claw/docs/identity-client.md`.
- A session can choose its own model. `POST /v1/sessions` accepts an optional `model`,
  `PATCH /v1/sessions/:id` accepts `model` (a string, or `null` to go back to the default) alone or
  beside `name`, and `GET /v1/sessions/:id` and the session list report it (`null` is the
  deployment's `DEFAULT_MODEL`). Every LLM call of the session's turns -- the loop, its sub-agents and
  compaction -- uses it, a change applies from the next turn (a message already parked behind a running
  turn is sent on the model the session has when it is sent on), and the key that pays is still the
  asking user's. The name is checked for shape only (non-empty, at most 128 characters,
  `[A-Za-z0-9._:/-]`): the gateway decides which models exist, and a name it refuses comes back as the
  gateway's error on the turn. `HITL_SUMMARY_MODEL` and the memory model are not affected. The column
  (`claw_sessions.model`) is added by the same idempotent start-up migration as the others.
- `HITL_SUMMARY_MODEL` names the model that writes an approval card's one-sentence summary, so a
  small, fast model can do it instead of the run's own reasoning model, which could not answer inside
  `HITL_SUMMARY_TIMEOUT_MS`. Unset keeps the run's own model. The call authenticates with the key the run
  itself uses (the asking user's, or the platform key in proxy mode), so the tokens are billed as the
  run's are. A model that key may not call (401/403/404) leaves the card without a summary and counts
  `claw_brain_approval_summary_model_refused_total`; it never falls back to another key.
- A `permissionRequest` now says in words what the call is, so an approval card
  can show something a person can judge instead of a raw request body:
  `tool_description` (the tool's own first sentence), `intent` (what the agent
  said just before the call) and `summary` (one plain sentence in the user's
  language, written by one small call on the run's own model, within
  `HITL_SUMMARY_TIMEOUT_MS`; `summary_by: "model"` marks it as machine-written).
  Credential-named arguments never reach that call. A timeout, an error or
  `HITL_SUMMARY_ENABLED=false` just omit the fields; approval semantics are
  unchanged and `input` is still sent as before.
- `approval.requested` notifications. When Brain holds a tool call for a person's decision (an MCP tool
  with `requires_approval`, a bash command a `bash_approval` rule matches, or `HITL_ENABLED`), the owner's
  subscriptions that list `approval.requested` in their `event_types` are sent a signed webhook: the usual
  fields plus `approval: {tool_use_id, tool, target, expires_at}`. `target` is the command (bash) or the
  tool's name and salient inputs, with credentials masked and cut to 300 characters; `expires_at` is when
  Brain stops waiting and refuses the call; a request that has already timed out when the event is
  consumed is not announced. The `event_id` is derived from (type, session, `tool_use_id`),
  so a repeated request is one row per subscription. The opt-in is the run notifications' (the session was
  created with `config.notify_on_finish: true`, or was started by a trigger); `NOTIFY_MIN_RUN_SECONDS` does
  not apply. A subscription that was created with the default `event_types` (the two run events) is not sent
  approvals: add the type with `PATCH /v1/notification-subscriptions/:id`, or pass it on create.
- `claw/examples/bash-approval/outbound-actions.json`, a `bash_approval` rule pack for actions that leave
  the sandbox: `git push` (force and delete forms labelled apart), `gh pr` / `release` / `repo` / `workflow`
  writes, `gh api` writes and implied POSTs, `kubectl` and `helm` writes, and a recursive `rm` unless
  every target is spelled out under `/workspace/`. See `claw/docs/bash-approval.md`.
- Deployment-level platform defaults: `PLATFORM_DEFAULTS_FILE` lists default skills
  (by marketplace tool id) and MCP servers mounted into every chat, behind
  `PROGRESSIVE_SKILLS_ENABLED` for skills. Default skills are listed by name and
  description only and written into the sandbox on first read. Off by default;
  see `claw/docs/platform-defaults.md`.

- `GET /v1/sessions/:id/changes`: what the session's sandbox has changed, computed live with git through
  Hands. It lists every git work tree under `/workspace` (two levels down, at most 20, and 200 files each, with
  `truncated` past a limit) with branch, short head, and for each changed file its status (`M` `A` `D` `R` `?`),
  additions and deletions (git's own numbers; untracked files counted by their lines; binary files `null`), and
  `?repo=<path>&file=<path>` returns one file's unified diff (64 KB at most; vendor tokens, Bearer headers, URL
  userinfo and the value after a credential-named variable, flag or field such as `DB_PASSWORD=` are masked). Creator only;
  another user's session is a 404 like a missing one. A sandbox that is not running (reclaimed, pending, not
  answering) is a `409 sandbox_not_running` and nothing is started to look at it. The repository and file in
  the patch form must be exactly what the live listing holds; git is given only those strings, quoted, after
  `--`, with literal pathspecs and without its optional index lock. See `claw/docs/sandbox-session-lifecycle.md`.

### Changed
- Brain: a turn's MCP servers are connected side by side instead of one after another, and the connections are kept for the same
  user's next turn (new `clients/mcp-pool.ts`) instead of being opened from nothing (initialize, then tools/list) on every turn. A
  kept connection is keyed by the user, the server's name and a hash of its whole spec, credentials and headers included, so two
  users never share one and a changed credential is a new connection; a run without a user opens and closes its own as before.
  When its tools were last listed more than 30 s ago a turn lists them again beside it, without waiting (it is offered them as last
  listed), and a failed listing reopens the connection; a call answered 404 (session gone) is sent again on a new connection, a failure is answered from memory for 30 s, and a connection unused for
  `MCP_POOL_IDLE_MS` (default 600000) is closed. A turn waits at most `MCP_CONNECT_BUDGET_MS` (default 2000) for its servers: one
  not ready by then is left out of that turn (said to the model like an unreachable one, logged as `mcp_client.connect_deferred`)
  and keeps connecting, and the next turn offers it. `MCP_POOL_ENABLED=false` turns the pool off. The Streamable HTTP client no
  longer opens the standalone GET stream for server-initiated messages, which Brain never read; an SSE connection is not kept.
  One slow server (SaFE's, 4-6 s at times) had held every assistant turn's first word behind it.
- Brain: a streamed `say`'s text (`toolTextDelta`) that arrives inside the 400 ms interval is published when the interval ends,
  and whatever is still unpublished when the model's turn ends is published before the call runs. The last delta of a call is now
  always its whole text; a text written inside one interval had been a single delta of its first fragment.
- Assistant: a review the router hands to the user's chat (`handed_off`) is answered there in one message, by the chat that starts
  it: the router says nothing about it. From the handoff on, a `say` in that turn is refused (`handed_off`), and neither the turn's
  plain text nor a notice that it failed is delivered for it; the handoff record keeps the turn's `message_id` (new column on
  `claw_assistant_review_handoffs`). `POST /v1/assistant/reviews` and the restart route answer each created item's `review_only`, and
  `merge_needs_confirmation` when its merge waits for the acting user's own confirmation whatever their review mode, so a channel tells
  the person how the merge is made from what was started (`router-v12`).
- Assistant: a review handed to the user's chat merges as the reviewer's own review mode says, as a review asked of them in the chat
  does: it is no longer held for the reviewer's confirmation whatever their mode (`fully_auto` merges, `high_risk_confirm` asks for
  high-risk writes). A request that leaves `handoff_id` out is an ordinary request again: an earlier handoff of the same pull request no
  longer holds it or makes it review-only.
- The assistant router answers sooner, in the user's language, and names items the user can recognise (router prompt `router-v10`,
  read section `router-read-v5`, review prompt `router-v13`). `work_create` tells the user at once that the item started, with its
  number and title (a system message in Chinese or English, not counted against the say limit, sent with the item and the turn's
  message id; not in another language, where the router says it, nor in a turn that handed a review to the person's channel); its
  result says `announced`, and the router no longer repeats it. `say` also refuses an item number said without its title (`#6、#8`;
  `bare_item_number`, naming what to write instead; a pull request's, issue's, run's or another repository's number is not an
  item's, nor is the item the message is sent with) and a message plainly in another language than the turn's `[Reply language]`
  (`reply_language`): an answer to a Chinese message with no Chinese character in it once the user's item titles are set aside. The
  other way is left to the prompt: an English sentence may quote a Chinese title of anything, and a Japanese answer may be all kanji. A router turn whose model answered nothing (Brain's empty-turn failure, which is how a declined request
  arrives) is told to the user as a request it cannot help with, not as one that did not go through. Every router turn that answers
  the user logs `assistant.router_turn_timing` (first and final reply in ms from the message, replies, the system's own replies,
  items started). The prompt now has the router put a one-line acknowledgement beside its first lookups, make a step's lookups at
  once, start work a worker can find its way in (and send a request that fits an open item to it) and ask first only when a guess
  would act on the wrong target, make every write and all sandbox work an item, use
  work_recall for how far an item got and the memory and channel tools for what they are for, read GitHub only with its `github`
  tools, search a research question again in other words before answering with the best candidate, answer a failed lookup from
  another read or say it plainly (no longer by starting a work item), and never give the system's own failures as an answer.
- An assistant's worker turn starts opening its sandbox when the turn starts, beside its first model call, instead of on its
  first tool call: the API marks worker turns with the new `ExecuteRequest.sandbox_prestart`, and Brain honours it behind
  `BRAIN_SANDBOX_PRESTART` (chart `brain.sandboxPrestart`, default on) for a run that opens its sandbox lazily and whose tool list
  has a sandbox tool. The first tool that asks joins the open already under way. A turn that never asks gives the sandbox back by
  the ordinary ending: a ready one is parked for the session's next message (and its untouched workspace is not uploaded), one
  still being created is given up, its workload stopped and its PENDING entry reaped, before the turn reports. Router, observer
  and ordinary chat turns are unchanged. Brain also reads a provisioning workload's status every second for the first 20 s of
  the wait, then backs off to every 5 s, instead of every 5 s throughout; a run of 404s must still span 55 s before the
  workload is given up as gone.
- Assistant: the router's `say` refuses a message that shows the user internal text (a tool name, the `[work_event]` marker,
  an `item_id`, a run id, or an id of the UUID form the user did not write in the message the turn answers) with
  `internal_text`, and the router is told to name an item by its number and title (`router-v7`); a turn that ends in plain text
  with such text in it is answered with the system's notice instead of that text. A run's `tool_stats` (on
  `executionStats` and the run row) carries `first_ok_ms` / `last_ok_ms`: per tool, when its first and last good call ended, in
  ms from the start of the run's loop; an assistant turn's first and last `say` and whether it called `work_create` are read
  from there. Brain's new `SKILL_HINTS_IN_SYSTEM` (default off) puts a turn's skill and MCP server hints in the system message
  instead of after the user's message.
- Assistant: the router answers a question itself when a read-only tool can. With `CLAW_ASSISTANT_PLUGIN_ID` set (new; default 0,
  none), a router turn is given that plugin's MCP servers listed in
  `claw/packages/api/src/assistant/read-tools.ts`, cut to their read tools by name (`tools_allowlist`), and no skill, rule or write
  tool of it; its prompt (`router-read-v1`) says to answer such a question with those tools and to start a work item only for work
  that produces or changes something. A plugin named on the message gives the router no read tools: the list vouches only for
  servers the operator configured. A work item's worker runs with the message's plugin, else that one, on every turn (recorded on the item as
  `params.plugin_id`). A worker that only found something out reports `kind="answer"` (`worker-v2`): the item closes as `answered`
  and the router passes the answer on, with nothing to accept; an answer the router does not say is said by the silent sweep.
  Once a router turn has called one of its read tools, Brain refuses the assistant's acting tools for the rest of that turn
  (new `ExecuteRequest.read_taint`): the user's message covers what they wrote, not what the model read afterwards. A router or observer turn is marked `skip_platform_defaults` (new
  `ExecuteRequest` field), so Brain connects no default MCP server and lists no default skill after the message. The router's system
  prompt is now the same on every turn (`router-v6`): the item list, the review state and the memory entries go with the message,
  and its history is its last 40 to 59 turns from a start that moves every 20, so the provider's prompt cache keeps both.
- GitHub review: whether an `APPROVE` or a merge made with someone else's account waits for that person's
  confirmation is now decided by the reviewing model's `risk_judgement` (`high` holds, `low` lets it through the
  other gates), not by the rule pack (`claw/packages/api/src/github-review/risk.ts`, `assessRisk`; rule pack
  `2026-11-03.1`). The rules are given to the model as evidence (`risk.evidence` and `risk.hard_holds` in
  `gh_pr_get` and `gh_pr_risk`; what to hold for is in the `risk_judgement` description and the review instructions) and no longer hold on their own: a large change, an author
  outside the organisation (the person who asked is very often the author), a fork, another base branch, an
  interface or dependency change are for the model to weigh. Before, nearly every approval of an ordinary large
  pull request by a contributor was held. What still holds whatever the model says: the repository's own
  `.github/claw-review.yml` (or the same file under its earlier name) asking for it (`confirm_merge: always`, a `high_risk_paths`
  match) or not parsing; a change to `.github/workflows/`, `.github/actions/`, `.github/scripts/`, another CI
  definition, `CODEOWNERS` or that configuration file; a change to the instructions the reviewing model reads (a
  review skill, the root `AGENTS.md`, `.github/copilot-instructions.md`); a cut file list; rules that fail; and a missing or malformed judgement. The model's `risk_flags` hold as
  before (all of this under the default review mode; see the next entry for `fully_auto`). The held confirmation and the tool answer give the reasons in plain words, the model's own first.
  Delegation, author != acting user, CI, merge state, branch protection, the writes switch, the head-SHA binding
  and the audit are unchanged; the audit row keeps the evidence (`evidence: ...`). `gh_pr_risk` no longer
  answers `raised_by_reviewer`. An approval or a merge of a head commit whose earlier approval or merge still
  waits for the acting user, is being decided, was refused, or expired unanswered is held too, and approval and
  merge decisions of one acting user on one pull request take turns (`write_in_progress`). Review instructions
  that are a symlink to another file are no longer read. See `claw/docs/github-review.md` ("High risk").
- GitHub review: the acting user's own review mode decides what holds for every review and merge made with their
  account, whoever asked: `high_risk_confirm` (the default, also for a person who never set one) holds as above,
  `fully_auto` holds only what the repository itself requires (`confirm_merge: always`, a `high_risk_paths` match, a
  configuration that does not parse), a change to the instructions the reviewing model reads (compared between the
  base and head commits' trees, not from the file list, so a change hidden among thousands of files is seen; a tree
  GitHub cuts holds), a file list past GitHub's 3000 files (now read in full up to there, page by page against the
  session's request budget, instead of 500), and an earlier held,
  refused or unanswered write of the commit. It is kept in Claw
  (`claw_github_review_settings`, by user id, created on start) and read and set by the person themselves with
  `GET` / `PUT /v1/github-review/settings` (`{review_mode}`; the `PUT` needs the person's sign-in or an allowed
  service's exchange token). `delegation` still decides alone whether others may ask. The mode is in `gh_pr_get` and
  `gh_pr_risk`, in a new `claw_github_audit.review_mode` column, and a write made under `fully_auto` answers
  `review_mode_note`.
- `claw-connector`: two changes for an existing `agents.toml` that need no setting to take effect. A file with
  `allow_unsafe_modes = true` now also accepts an adapter's "will not ask for permission" warning for every agent without
  its own `approval`, so a session that used to be closed with `mode_not_enforced` now opens and is reported
  `unattended`; set `approval = "ask"` on an agent to keep refusing it. And a preset agent whose `safe_modes` or
  `ask_mode` names a mode the preset does not know to ask (for example `claude` with
  `safe_modes = ["default", "plan", "acceptEdits"]`) is now a configuration error, so `claw-connector run` does not
  start; remove the mode, or set `approval = "never"` on the agent (or `allow_unsafe_modes = true` in the file, for an
  agent that does not say `approval = "ask"`).
- Brain no longer fetches every plugin skill again on every turn. Downloaded skill
  files are held in memory (bounded by `SKILL_CACHE_MAX_BYTES`, 64 MiB by default,
  `0` turns it off) and reused while the skill is unchanged: a plugin skill is
  validated with one object-store listing per turn (per-object ETag and size, so
  an in-place upsert of the same version is picked up), a marketplace `tool_ids`
  skill by its record's `version` and `updated_at`. A turn that finds a plugin
  skill unchanged reads no object and reports no `download_skill` event for it.
- A turn of a session with plugin tools no longer starts a sandbox before its
  first model call unless the plugin has a hooks-type tool: plugin skill files
  are written into the sandbox on the first sandbox call that names `.skills`,
  so a turn that only calls MCP tools opens none. With
  `PROGRESSIVE_SKILLS_ENABLED`, plugin skills are listed by name and description
  like the platform defaults instead of being inlined.

### Security
- What the API stores of a conversation now has credentials masked before it is written: session events (`claw_session_events`,
  as the event consumer, the message route and the A2A route write them), conversation turns (`claw_conversation_turns`) and the
  words an assistant's router turn answers (`claw_assistant_messages`). The new `redactStoredText` / `redactStoredValue`
  (`@claw/utils`) add to `redactSecrets` a SaFE API key (`ak-...`), a short `Bearer` token with a digit in it, an armored private
  key, and a value written after a credential's name (`password=`, `"api_key": "..."`, `token: ...`), leaving code, placeholders and
  sentences alone (`password = getPassword()`, `password: string`, `${DB_PASSWORD}`, `"Enter your password"`). Identifier fields
  (`id`, `*_id`, `*Id`: `message_id`, `tool_use_id`, `actionId`, ...) holding one token are stored as they are, whatever their shape,
  since readers match stored rows on them (a 64-hex A2A `messageId` is not a credential). Only the stored copy
  is masked: the turn's prompt reaches Brain as written, and a router turn run again on the fallback model is given its prompt as the
  model first was when that prompt is the stored message. Later turns read their history from the masked rows. Rows written before
  this change are not rewritten.
- Claw works with a sandbox Router that runs with `--enable-auth`. With `SANDBOX_ROUTER_AUTH_ENABLED` on, every Hands
  request that goes through the Router's port proxy (`SANDBOX_HANDS_VIA_ROUTER`) presents the sandbox owner's platform key
  in `Authorization`: Brain's MCP client, health checks, shell records and the sweeper, and the API's changes view and
  sandbox census. Before, they carried only the Hands token, which such a Router answers with 401, so the Router could
  not authenticate while Hands was reached through it. Hands still reads its own token from `X-Hands-Token`; the Router
  strips `Authorization` before forwarding. With the setting off nothing changes. `deploy/deploy.sh` now sets
  `SANDBOX_ROUTER_AUTH_ENABLED` for Claw from the Sandbox it installs (`true` unless `--insecure-sandbox`).
- A session that acts as a user (`config.acting_as`, GitHub review on; its turns carry `withhold_sandbox_keys`) is no longer
  given the deployment's platform defaults (`PLATFORM_DEFAULTS_FILE`): no default MCP server and no default skill. The default
  servers are called with the requester's own key (`<SAFE_API_KEY>`), so a pull request's text that a review turn reads could
  drive their read tools as the requester and carry the result into the review. Such a turn now has only what its own request
  carries (the review tools the API puts there), whichever way it reaches Brain (a message, a queued turn, a task of a DAG,
  a sub-agent). Every other session is given the defaults as before. See `claw/docs/platform-defaults.md`.
- The same session is no longer given its requester's long-term memory, in either direction (`CLAW_MEMORY_ENABLED`, with the
  requester opted in): their memory entries and profile are not put in its prompt (nor the notice that memory is off),
  `save_memory` is not offered (Brain refuses a request marked `withhold_sandbox_keys` whatever `memory_enabled` says; a
  sub-agent starts from its parent's tools and has none), and a completion of such a session saves nothing it asked to save
  and extracts nothing from its conversation. A pull request's text that a review turn reads could otherwise get the
  requester's private memories quoted into a public review comment, or write a memory that steers all of their later
  ordinary sessions. A session whose row cannot be read counts as one that withholds: memory is not used, the turn is not
  failed. Every other session is unchanged. See `claw/docs/github-review.md`.
- `a2a_call` no longer accepts a URL, and no longer sends the user's LLM key or the platform key to a peer.
  The model used to be able to name any `http(s)://` address, and the call went out with the user's key (or,
  in safe mode, the platform key) as its `Authorization` bearer, so a prompt-injected model could send that key
  to any host or aim the call at an address inside the cluster. The tool now resolves only the peers an operator
  configured in `A2A_AGENTS` (a URL is refused with the configured names), a peer is sent only its own token
  (the variable its entry's `auth_env` names; none when it names none), a peer on a loopback or link-local
  address is refused unless its entry sets `allow_local`, and redirects are not followed. `A2A_AGENTS` also
  accepts a JSON array carrying those fields; the `name=url` list still works and sends no credential.
  `auth_env` must name a variable that starts with `A2A_PEER_TOKEN_`; an entry naming any other variable
  (for example `ANTHROPIC_API_KEY`) is refused at start-up and not registered, so a peer entry cannot be
  pointed at a deployment-wide secret.
  **Breaking:** a call that relied on passing a URL (for example to the API's own A2A endpoint,
  authenticated with the user's key) must now go through a configured peer with its own credential.
  See `claw/docs/agent-server-design.md`, "Outbound `a2a_call`".
- `redactSecrets` no longer takes quadratic time on a long line. The URL-credential pass rescanned a run of
  letters from every position in it when no `://` followed, so one line of 64 KB of letters held the event loop
  for about sixteen seconds in every caller (event redaction, previews, the new changes route). The scheme is now
  matched only where a run of scheme characters begins; the result for every input is unchanged.
- Credential redaction no longer treats every `user_env` / `session_env` value
  as a secret to cut out of transcripts, and no longer misses short or
  oddly-named ones. Values are selected by whether the variable **name** reads
  as a credential, hunted only when the value is distinctive enough that
  replacing it will not also delete ordinary words, and matched by **shape**
  (GitHub/GitLab/Slack/OpenAI/Hugging Face/AWS tokens, JWTs, URLs with inline
  credentials) regardless of the field they sit in. The name rule knows the
  spellings a real config file uses, not just the word `password`:
  `PGPASSWORD`, `MYSQL_PWD` and `SSH_PASSPHRASE` are each masked at their
  field, while the standalone `PWD` — the shell's working directory, present
  in every container — is not, so an absolute path is never cut out of a
  command.

  Credentials the run was **handed** (`llm_api_key`, `platform_key`,
  `backend_internal_token`) are hunted without consulting their shape at all.
  The shape rules exist to keep guesses from destroying ordinary text, and
  nothing is being guessed about a field that means exactly one thing — a real
  key ending in a date (`XkjQmzPlVbNrTqWd20240903`) is indistinguishable from
  an ordinary `snapshot20240903`, and only provenance separates them. Exact
  values are matched before the shape scan runs, so a composite credential
  cannot lose its recognizable half and strand the rest in the clear.

  **Still open — among other shapes, two are knowingly not caught in free
  text.** A purely alphabetic secret at any length and in any script
  (`XkjQmzPl`) and a word with digits on the end (`hunter2`) are both masked
  wherever they sit in a field, but an echo of either in free text — a log
  line, tool output — is left alone. The only rules that would catch them also
  catch ordinary prose: three attempts to tell a long word from a long token
  by its shape were each broken by ordinary English (`GitHub`,
  `internationalization`, `straightforwardly`), and a fourth read `A-Za-z` as
  the definition of a letter and so deleted `naïveté` and `конфигурация`.
  Letters — Unicode ones — are no longer judged at all. This pass is a
  blind substring replace over payloads that are replayed to the model: a
  false positive does not mask a secret, it deletes text from a conversation
  and the agent resumes without it. A missed secret is bounded and fixed by
  rotating the credential; a corrupted transcript is neither. These are
  examples rather than an inventory: each round of review found another
  ordinary string a heuristic had read as a key, so treat free text as
  unredacted. Do not put a secret in an env var the agent can print.

- A credential-named variable holding a *location* is no longer treated as
  holding a credential. `TOKEN_ENDPOINT=https://…/oauth/token` and
  `SSH_KEY_PATH=/home/user/.ssh/id_ed25519` are what an OAuth client and an SSH
  config are supposed to be called; collected for their names alone, both were
  cut out of every transcript line that named the endpoint or ran a command
  against the path. A URL carrying inline userinfo, a credential in a query
  parameter, and any documented vendor shape anywhere in the value all keep the
  value collected, and a value picked for its own shape is unaffected. That
  test now percent-decodes query values before judging them -- an ordinary
  `redirect_uri=https%3A%2F%2Fapp.example%2Fcb` reads as credential-shaped only
  because of its escaping -- and reads the URL FRAGMENT the same way it reads
  the query, so a callback URL carrying an implicit-flow `#access_token=…` is
  no longer mistaken for a plain location.

- Overlapping exact secrets are now replaced longest first. Whatever is
  replaced first rewrites the text the rest are searched in, so a platform key
  that is a prefix of a token derived from it used to leave the derived token's
  signed half in the clear.

- A compaction no longer leaves a stale cache-use timestamp reachable. The
  agent loop clears the timestamp and then publishes an event before it reaches
  its next checkpoint; a SIGTERM inside that await persisted the checkpoint
  written before the compaction, describing an entry that no longer existed.
  The clear is now reported to the runner on the line that performs it.

- The URI split used to decide whether a value is a location no longer
  backtracks quadratically on a long non-matching input (CodeQL
  `js/polynomial-redos`): the path alternative must begin with `/`, so exactly
  one split of any input is possible.

- `API_KEYS` and `ACCESS_TOKENS` are recognized as credentials. Only qualified
  compounds are: bare `keys` and `tokens` stay non-sensitive, because
  `input_tokens`, `max_tokens`, `foreign_keys` and their kin are counters and
  map keys that the UI renders.

- `LLM_DEBUG_RESPONSE_HEADERS` rejects credential-bearing header names and
  names that are not valid HTTP tokens, at boot rather than per request.

- Each workload can authenticate to NATS as its own least-privilege user
  instead of the single all-access `prod` account. Off until
  `NATS_PER_USER_WORKLOADS` names a component, so the fleet moves one at a
  time; `NATS_RETIRE_PROD=true` removes the all-access user once nothing is
  left on it, and refuses unless every built-in identity is deployed, adopted
  by its workload and accepted by the NATS server -- retirement is one-way, and
  a connection census cannot see a CronJob between sweeps. See
  `deploy/nats-values.yaml` for the allow-lists and for the census that decides
  about clients this repo does not deploy.
- Brain checkpoints can be sealed with AES-256-GCM
  (`brain.checkpointWriteVersion: 4` plus `secret.brainCheckpointKey`) instead
  of being rewritten by the observability redactor. Off by default, and readers
  accept both formats, so ship the reader to every pod first — `values.yaml`
  carries the preconditions and the rollback rule. Each sealed checkpoint is
  bound to the run that wrote it, which also closes a path where anyone able to
  write the KV bucket could have one run replay another's conversation.

### Fixed
- The assistant router speaks once per turn: a later `say` of a turn takes the place of the turn's first message instead of being a
  second one (`assistant.say` payload and `AssistantSay` event `replaces`, the first say's id, and `turn_message_id` on a router say's
  payload; matched through the delivery, so only with notifications on). A quick "查一下" is replaced by the answer, and a correction is
  the whole message again, never "更正上一条…" beside it. A channel that no longer has that message shows the new one on its own, and a
  turn that hands a review over carries only the last of them in `held_says`.
- Each thing that waits for the user (a write held for confirmation, a scheduled task's card, what a worker holds) is marked
  `told` in the router's state once a message the user can still see (not dropped, not replaced by a later say of its turn) named it
  (its ref) or, for a hold, was about its item under the hold's attention; the router brings it up on its own at most once, instead of ending every reply with the same reminder.
- The router compares a repeated question's answer with its last one and says what changed and why, and tells a requester they can
  stop a review they asked someone else to do (handed off or not) with `work_stop` and its item_id (router-v14, review router-v18).
- A user whose account may not create workloads in the workspace Claw starts their sandbox in (today: anyone not a member of
  the CPU workspace, the first time an assistant item or Teams message needs a sandbox) no longer sees SaFE's raw 403 body,
  with their internal user id and the platform error code, as `Sandbox failure (sandbox_create_failed): Create Hands failed: HTTP
  403 {...}`. The run now fails with `sandbox_workspace_forbidden` and a sentence naming the workspace and the next step (ask a
  SaFE administrator to add the account); the body stays in the Brain log. The refusal is terminal, and a lazy sandbox is not
  opened again in the same turn. `GET /v1/me` gains `sandbox.cpu` (`{ workspaceId, available, reason?: "no_access" }`) when
  `SANDBOX_CPU_NAMESPACE` is set, so a client can tell an account that has no CPU sandbox workspace before it is refused.
- A work item's worker whose item waits for a person (`needs_you`) or is `done` no longer keeps its sandbox for background work: past
  `WAITING_ITEM_SANDBOX_RELEASE_SECONDS` (API, default 900) of quiet with nothing queued, the orphan sweep stops it, and the next turn
  starts a fresh one. A review session's leftover test Postgres had held global-cpu sandboxes for up to two hours behind held merges.
- Brain: deleting a session owned by a non-admin key (every ordinary user, and service identities such as `sa-eval-bot`,
  `sa-release-gate` and `dispatron-service`) no longer stops at `cleanup_incomplete_parked`. The session-scoped SaFE workload
  list named no workspace, which SaFE answers with 403 for any key that is not an admin's, so teardown read it as
  `mn.safe_lookup_failed`. When the unscoped list is refused with 403, teardown and the multi-node idle sweep now list in
  the workspace the session recorded (its `hands.<sid>` binding's `namespace`), one list per workspace when there are several;
  a key that may read the unscoped list (an admin's) keeps reaching every workspace.
- The assistant router sees each person a message names with their address and other handles beside their user id (`People in
  this message`), so it can pick one of two people with the same name from the reply that names them (`确认 Wei, Lei (weil2)`).
- The sandbox's E2B file API takes an absolute path as that path. `files.write('/tmp/x')` wrote `<workspace>/tmp/x`, so a
  command reading `/tmp/x` found nothing, and a process `cwd` of `/tmp` ran in `<workspace>/tmp`. An unsealed sandbox's file calls
  run under the uid its commands get, so the mapping bounded nothing; they now follow E2B (absolute paths as given, relative ones
  under the workspace, responses name the absolute path). A sealed sandbox keeps its grant's workspace-rooted paths (`/in` is
  `<workspace>/in`), and a sealed path that would leave the workspace is refused with `permission_denied` "path escapes the
  sandbox root". Ships in the envd injector image.
- The GitHub list reads (`issue_search`, `pr_list`, `issue_list`, `repo_list`, `code_search`) answer the whole list a question
  asks for: `{ total_count, shown, complete, next_page?, items }`, pages of 50 by default (up to 100), and an answer of at most
  `GITHUB_LIST_MAX_CHARS` that Brain keeps whole (any other result is still cut to its head and tail at 6000 characters, which
  is how "my 22 open pull requests" was answered with about 15). `pr_list` takes `state: merged` (only merged ones, most
  recently merged first; "the 3 latest merged" was read in creation order and named one merged before another), orders
  `closed` by when each closed, and takes `author`. A search narrowed with `repo:`, `org:` or `user:` that GitHub refuses
  (422, for some fine-grained tokens) says to list the repository with `pr_list` or `issue_list` instead.
- A tool call whose result was the tool's own error is marked `is_error: true` on its `toolUsed` result event; its `status`
  is still `success`. A failed GitHub read was recorded as one that read something, and the evaluation counted it so.
- An app run cancelled while its sandbox is still being created, typically by its session being deleted seconds after
  the run was submitted, no longer leaves that sandbox running until its workload timeout. The run's signal now reaches
  the sandbox ensure: no create is sent once it has fired, and the wait for a workload that exists (one whose create was
  already under way included) ends at once. A wait cut short by a cancel, the deadline or a terminal row stops the
  workload; one cut short by a drain or a lost lease leaves it for the next holder.
  Before, the wait ran on until the workload was Running (minutes, for a queued one), and the finish that followed came
  after the run's lease had expired, was refused (`not_holder`) and stopped nothing. As a backstop, the sweeper now moves
  a run whose task was closed before the run reached `finishing` (`provisioning`, `starting`, `running`, `restarting`)
  to `finishing` once the task's lease has been gone, and the task closed, for `LEASE_LOST_GRACE_SEC`, so the existing
  finish-only dispatch stops its sandboxes and revokes its grant (`sweeper.abandoned_app_runs_to_finishing`); a finish
  that fails every one of its bounded hand-overs is left for an operator, as before.
- An assistant message no channel can carry is no longer silent: one stored with no notification subscription for its type is counted
  (`claw_assistant_say_unreachable_total{type}`) and logged as `assistant.say_unreachable` with the user and the item, once per user
  per clock hour across replicas. The silent sweep takes a message as told only when it was delivered or has an outbox row still queued
  and not failed, so a fallback stored while nothing could carry it no longer counts; once a subscription takes its type, the sweep sends it. A subscription
  created or changed to take `assistant.say` or `work_item.needs_you` is sent, once, the newest unreached message of each item that still
  needs its owner.
- A receiver's `410 Gone` drops that outbox row at once (`last_status = http_410`) and is not counted against the subscription, so a
  receiver that cannot reach one of a user's conversations no longer gets that user's subscription disabled.
- A leader lock held on a connection made before a failover this process noticed is lost (`LeadershipLostError`, the lease, the
  stall alarm): the demoted server may still answer it, but its lock fences nothing on the new primary.
- Session retention can no longer spend a place of the day that a user's own delete took: every session deletion takes one advisory
  lock, and retention asks the day's count again under it before each deletion.
- A revoked connector grant is refused within `CLAW_CONNECTOR_TOKEN_INTROSPECT_MAX_AGE_SECONDS` (default 5; was up to the identity
  client's 30-second cache). The identity client's `introspect` takes a per-call `maxAgeMs`.
- A database failover no longer leaves the API on the old primary, and no longer costs the assistant's replies. A
  switchover demotes the old primary in place, and a connection still on it answers every read and refuses every write
  (`25006`): `inTransaction` handed such a connection back to the pool after a clean rollback, to fail the next
  transaction too. The first failover error (`25006`, `57P01`-`57P03`, a `08` connection error or a dropped socket) now
  marks every connection opened before it stale (so does an idle connection the switchover terminates): idle ones are
  dropped as they are checked out, by any caller of either pool's `connect()` or `query()`, held ones as they are
  released. A new connection of either pool is handed out only once its server says it is not in recovery (asked once
  per connection), because for a few seconds the Service can route one to the demoted server, which refuses every write
  and grants advisory locks that fence nothing. A statement is sent once more on a new connection, after `PG_FAILOVER_RETRY_DELAY_MS` (default 1000), when
  running it twice is the same as running it once: Postgres refused it before it ran (`25006`, `57P03`), or it only
  reads. A transaction that says it may run twice is retried the same way, and also when its connection went before
  its `COMMIT` was sent; every way the assistant stores a message says so. A message whose `COMMIT` took effect but
  whose answer the failover lost (a `say`, the cap's notice, a system notice, a needs-you message) is looked up,
  announced and reported as stored; one not found then, or that cannot be looked up, is looked up again in the
  background over the next minute and announced once found (an error on the `COMMIT` proves nothing either way), and a
  `say` like that is reported as
  `say_outcome_unknown`, and the Router ends the turn with the words instead of saying them again (they are delivered
  only if the turn has not spoken). So the only `say` that faults is one that was not stored; it tells the Router the
  message was not delivered and to call `say` again. Delivering a Router turn's unsaid answer is tried three times
  before it is given up, instead of once.
- A reply the assistant's hourly cap (`CLAW_ASSISTANT_SAY_MAX_PER_HOUR`) refused is no longer dropped without a word.
  The model's `say` was refused, and so was delivering what it wrote instead, and the user heard nothing for as long as
  the cap held. The first refusal in an hour now tells the user, in their language, that replies are paused and to try
  again later (a notice in the system's words, not counted against the cap; at most one an hour, by the database's
  clock and under the user's say lock, so a client that keeps writing at the cap gets one notice and not one per
  message; a notice that failed to be stored is tried again in the background); the model is told the message was not delivered
  and not to call `say` again in the turn; and every refusal is counted in `claw_assistant_say_rate_limited_total`, by
  whether the user was sent the notice.
- `SESSION_RETENTION_BATCH` is now a daily limit across replicas: every replica runs the maintenance pass a minute
  after it boots, and each pass deleted a whole batch of its own, so a rollout of four replicas deleted four batches
  (16,535 sessions in an hour with a batch of 5000) and left the cleanup sweeper hours behind. Each hold of the
  retention lock now deletes at most the batch less the archived sessions deleted in the last 24 hours. The next
  day's pass, which starts 24 hours after the last and so a little before the last day's deletions leave that window,
  waits for them and deletes as they leave instead of ending with nothing deleted (which would have made it a batch
  every other day); it waits only when they start leaving within two hours, so a replica booted mid-day does not.
- Deleting a session that has no `hands.<sid>` binding and no key on its cleanup notification -- every session the
  retention pass deletes, and every sweeper replay of a delete that already finished -- is a finished teardown with
  nothing to address (`session.cleanup_nothing_addressable`), not `no_platform_key`. Claw holds no handle to anything
  such a session could own, and parking it did nothing, so each one only logged `session.cleanup_incomplete_parked`
  and counted `claw_brain_session_cleanup_incomplete_total` once per Brain replica, firing the sandbox-teardown alert.
  A binding without a key, or a KV store that cannot be read, is still reported as incomplete.
- The daily session retention no longer stalls for a day after a rolling update. A replica killed mid-pass could leave
  its idle Postgres backend, and the retention advisory lock on it, alive on the server for the OS keepalive's two hours,
  and every new replica skipped until the next day. API connections now set server-side TCP keepalives
  (`PG_TCP_KEEPALIVES_IDLE_S`, `PG_TCP_KEEPALIVES_INTERVAL_S`, `PG_TCP_KEEPALIVES_COUNT`, defaults 60/10/6), so such a
  backend and its locks go about two minutes after the peer, and a retention pass that finds the lock held asks again
  every `SESSION_RETENTION_LOCK_RETRY_MIN` minutes (default 10), up to twelve times.
- The purge of deleted sessions' rows (`SESSION_PURGE_DAYS`) removes rows again: choosing the sessions to purge was one
  query that Postgres planned as a scan of the whole events table, which hit the statement timeout on every pass
  (`session_retention.purge_pass_failed`). It now walks deleted sessions a page at a time, along a new index
  (`idx_sessions_deleted_walk`, built concurrently at startup), and asks each on its own, by index. And a retention pass
  no longer holds its lock past the stall alarm (`leader.hold_exceeded`): each hold stops after
  `SESSION_RETENTION_HOLD_BUDGET_SEC` seconds (default 300) and the pass continues in a new hold 30 seconds later, until
  the day's `SESSION_RETENTION_BATCH` is spent.
- An on-behalf review of a pull request that changes two or more `SKILL.md` files can approve again: Brain's
  skill-read guard (`BRAIN_BLOCK_SKILL_SUBAGENTS`) turned its second pass away, since that pass names the files the
  review read, and an approval needs the second pass. The guard no longer applies to a session that acts as a user
  (`withhold_sandbox_keys`); every other run keeps it.
- A session's queue is drained by one drain at a time (a lease on the session row, the new column
  `claw_sessions.pending_drain_until`, added on start). Two drains running together -- a turn's completion and the
  sweeper's, or two workers' reports waking an idle assistant a moment apart -- each started a turn: the second
  started the next queued message on top of the first, whose `say` was then refused as `turn_superseded`, or the same
  message again, which failed on a duplicate run id (`sweeper.orphaned_pending_drain_failed`). A message the owner
  sends while a queued one is being dispatched now waits for that dispatch and is queued behind it, instead of
  starting a turn the dispatch then took the session from. In the assistant's session the user's queued messages go
  before queued worker reports. `POST /v1/sessions/{id}/messages` on a busy session now also answers the `message_id`
  the queued message's turn will carry, and the assistant's `AssistantSay` session event names the turn that said it
  (`turn_message_id`).
- The review instructions that `gh_pr_get` returns (`review_instructions`) no longer open with a skill's frontmatter
  (`name: pr-review ...`), which sent the model looking for a skill that is not in its session and made it say so. The
  default instructions are the rules and steps alone, a repository skill's own frontmatter is left out too, and
  `examples/skills/pr-review/SKILL.md` is still a valid skill: it is the same text behind its frontmatter. The
  instructions also tell the model to answer in the language the person wrote in, in natural wording, with plain words
  ("approved", "merged", "commented", "waiting for your confirmation") instead of the names of tools or of their states
  such as `dry_run`, and to say that nothing happened on GitHub when writes are switched off. These answer rules, with
  the last `VERDICT:` line, are put in front of a repository's own review skill as well, not only in the default
  instructions. Tool names stay in the logs and the audit rows.
- Reading a skill no longer starts a sandbox. With `PROGRESSIVE_SKILLS_ENABLED`, the prompt told the model to open
  `/workspace/.skills/<name>/SKILL.md` with the `read` tool, which made Brain provision a sandbox for a file read:
  a turn that called an MCP tool and then needed the skill waited for a pod, and on a cluster that could not
  schedule one (all sandbox nodes unschedulable) the user watched a progress bar for minutes before Brain gave up
  after ~15 minutes. A skill is instructions for the model, so Brain now serves it: the listed skills are loaded
  with a new `load_skill` tool (`name`, optional `file`) from Brain's own staged copy, with no sandbox, and the
  prompt says so instead of giving a path to read. SKILL.md comes back with the skill's other files and the sandbox
  path its scripts run from. The sandbox is for running things: a skill's files, scripts included, are still
  written into it the first time a sandbox tool names `.skills`, so running a script starts a sandbox as before, and
  a model that reads a `.skills` path with `read` or `bash` still gets the file. `load_skill` is offered only when
  the prompt lists skills, is allowed in plan mode and for the `readonly` and `explore` sub-agents, and is subject
  to `tools_allowlist`: a run whose list does not name it (every list written before the tool existed) is not
  offered it, and gets the skill hint from before, which reads SKILL.md with `read` from the path on each line, as
  its skills were read until now; a list that names `load_skill` gets the sandbox-free load. It is in the default
  `HITL_AUTO_ALLOW`, so turning approval on does not start asking about every skill the model loads. A skill longer than the loop's 6000-character tool-result cap is not cut by it, which would
  have sent the model back to `read` or `bash` for the rest: `load_skill` returns a file in parts of up to 16000
  characters, each saying the `offset` of the next, and has a bound of its own that leaves a part and the skill's
  file list whole.
- A sandbox that cannot start is now told to the user early and ended early. While a sandbox is held up, either
  queued in the platform or admitted with nothing yet willing to run its pod, the turn's progress event says so
  as soon as the platform reports it, instead of one "Waiting in queue (position 0)" and then ten minutes of nothing
  (`log`, plus additive `waiting` = `queued` | `unscheduled` and `waitReason`: one line in our words, such as how many
  nodes cannot take the sandbox and why, never the platform's pool ids, namespaces, pod names or taint keys, which stay
  in the Brain log; the queue's own short phrases are repeated as written). A sandbox the platform admitted whose pod no node has taken and for which no node is being added,
  for `SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS` (default 300, chart `secret.sandboxUnschedulableTimeoutSeconds`, `0` turns
  it off), now ends with the new reason `sandbox_unschedulable` saying what was observed, and its workload is stopped;
  before, it was waited on for the whole of `SANDBOX_START_TIMEOUT_SECONDS` (15 minutes) once the platform called it
  NotReady, and for `SANDBOX_PENDING_TIMEOUT_SECONDS` (3 hours) while it called it Pending. The platform's own message
  on such a pod ("0/7 nodes are available ...", "pod didn't trigger scale-up ...") says why it is stuck and does not
  exempt it; a scale-up the platform reports as triggered, or a message it has not said before, restarts the clock.
  A sandbox still in the platform's queue, one with a scale-up under way and one that is pulling an image keep their
  existing, longer limits, and multi-node clusters and hosted applications are unchanged. When opening a
  run's sandbox ends on `sandbox_unschedulable`, `sandbox_start_timeout` or `sandbox_pending_timeout`, the run no longer
  provisions another for the rest of that turn (the model used to read a bare "did not become ready", call the tool
  again, and make the user wait the whole time twice): the tool error tells the model the sandbox is unavailable and to
  report the reason to the user, a further attempt is refused with the same error, and the workload the failed open left
  is stopped and its binding reaped even though the run goes on.
- The assistant's Router (behind `CLAW_ASSISTANT_ENABLED`) could not act on the items it was shown. Its list and a
  worker's report named an item only as `#3` while the tools took only the item's id, so in an evaluation against a
  real model a follow-up or a stop was refused as `item_not_found` three times in four. `say`, `work_send`,
  `work_stop` and `work_recall` now take the item's `item_id` or its number (`#3`, `3`) among the caller's own items
  (a number is per user, and another user's item is still not found), both are shown in the list and in a report's
  header, and a reference that names nothing is refused as `item_not_found`, `invalid_item_ref` or
  `ambiguous_item_ref`. The Router is told to call `work_create`, `work_send` and `work_stop` without a `say` in the
  same step and to speak after their results, so it no longer announces what a refused call did not do. The message
  it is answering is followed by a `[Reply language: X]` line (Chinese, Japanese, Korean or English, read from the
  user's own words with what they quote left out, or from their last ones when a worker's report woke it; a message
  in another language gets no line, and only one with no wording of its own, such as `ok`, `retry #2` or `done` (at most
  one Latin word, and no letter of another script), looks back;
  only the first and last 2000 characters of a long message are read, so a message of megabytes costs what a short
  one does), so item titles in another language no longer decide the language of a reply. The line is on the request only: the
  conversation turn written when the run completes holds the user's words from the run row, as they were sent. A
  turn that ends with plain text and no `say`, which reached nobody, has its text delivered as a `say`. The
  evaluation in `claw/packages/api/test/e2e/assistant-router-eval.ts` measures all of this against a real model.
- A caller authenticated by an identity provider's access token (`CLAW_IDENTITY_TOKEN_AUTH_ENABLED`) now has
  the platform key and the virtual key SaFE holds for the token's subject, in the SaFE deployment mode. SaFE is never
  shown the person's token: the API exchanges it at the provider (RFC 8693 service delegation, subject token type
  access token) for a token for SaFE's audience that names the API as the party acting for the person
  (`CLAW_IDENTITY_TOKEN_DELEGATION_AUDIENCE` and `_SCOPE`, default `primus-safe` and `safe.api`), and asks SaFE's
  `POST /api/v1/auth/verify` with that, only for a token it has already accepted and that carries no actor. Only keys
  for the token's own `sub` are used, and the answer is kept per person for at most the life the delegated token has
  left, not per token and not for a fixed time. Before, such a caller had no model key (a turn failed with "Could not
  resolve authentication method"), no key to create a sandbox with, and `GET /v1/me` answered 401. A SaFE that does
  not accept the delegated token, or a provider that refuses the exchange, leaves the caller without keys; one that
  cannot be reached, or answers 200 with something that is not an answer, is a 503. The provider's refusal of one subject token (`invalid_grant`: that device's grant is signed out, or the token has expired inside the clock tolerance) is kept for that token alone for 30 seconds, so the person's other tokens still get keys; only a refusal about the API's own client (`unauthorized_client`, `invalid_target`, `invalid_scope`) is kept per person. The MCP models tool no longer forwards such a caller's token to SaFE (it sends the platform key). A SaFE 5xx is no longer remembered as a failed verification of a cookie or key for 30
  seconds. See `claw/docs/identity-client.md`.
- A sandbox rebuilt from the workspace snapshot is still a git repository. `.git` was on the
  snapshot's exclude list, so after the idle window the files came back and the history did not,
  and every commit that had not been pushed was lost while the conversation still remembered
  making it. `.git` is now snapshotted (S3 and the shared disk alike) except git's own transient
  files (`*.lock`, `tmp_*` under `.git/objects`); `node_modules` and the rest of the list stay
  excluded. A repository is carried whole or not at all: one over `WORKSPACE_GIT_MAX_BYTES`
  (default 300 MiB) or `WORKSPACE_GIT_MAX_FILES` (default 2000, since the upload is one request
  per file) is left out, and the run emits a `workspace_git_skipped` sandbox event that names it.
  A workspace's repositories are also bounded together (`WORKSPACE_GIT_TOTAL_MAX_BYTES`, 1 GiB, and
  `WORKSPACE_GIT_TOTAL_MAX_FILES`, 10000; the largest go first), and both snapshot destinations
  emit the event, once per change of which repositories were left out and why. A repository left
  out of a sync (over a bound, or one the sandbox cannot measure within
  `WORKSPACE_GIT_PROBE_TIMEOUT_SEC`, default 60; 8 on a SIGTERM sync) keeps the copy the last
  snapshot held: S3 does not prune its objects, and the shared-disk sync carries it forward. The
  rest of the workspace is still saved and S3 keeps its upload delta. A `find` that only met an
  unreadable directory no longer counts as an unfinished measurement. `WORKSPACE_GIT_MAX_BYTES=0` restores the old behaviour. A restore recreates the
  empty `refs/` and `objects/` directories an object store cannot hold, the file list and zip
  download hide `.git`, per-message archives do not copy it, and the resume hint no longer tells
  the model its commits are gone.
- A session no longer becomes unusable after a turn that called a tool whose name
  reads as a credential field (for example `mcp__*__apikey_*`). Brain's redactor
  replaced such a tool's whole `argumentsDetail` entry with the string
  `"<redacted>"`; that string was stored with the turn and replayed to the model as
  the call's input, the model endpoint answered 400 ("function.arguments must be a
  JSON object") to the whole request, and every later turn of the session failed
  the same way within two seconds. The entry now stays an object with every value
  still masked; `reconstructHistory` turns any stored non-object input (including
  rows already written) into one; both model providers send object inputs on the
  wire and store streamed calls whose arguments decode to `[]` or `null` as
  objects; and a 400 of that kind repairs the history and retries once
  (`claw_brain_llm_tool_args_rejected_total`, `claw_brain_llm_tool_input_repaired_total`).
- `deploy/upgrade.sh` no longer drops `PG_SSL_NO_VERIFY`. Only `deploy.sh`
  read it, so the first upgrade of a deployment installed with it re-rendered
  the API at verify-full, and against a PGO-managed database every new API pod
  failed its TLS handshake. It is now recorded in `values.<ns>.env` like the
  other operator knobs and forwarded on every render.
- A sandbox that never came up is no longer recorded as `agent_error`, and is no
  longer retried. Under lazy sandbox creation the provisioning give-up reaches the
  task runner wrapped in `SandboxAttachError`, and the runner matched the give-up by
  its class alone: the run failed as `agent_error` instead of its provisioning code
  (`sandbox_workload_terminal`, `sandbox_gone`, ...), and a give-up whose message
  named a retryable status was naked back into the queue it had just given up on.
  The runner now finds the give-up anywhere in the cause chain.
- Parking a session whose hands handle was deleted no longer fails and retries
  every sweep. NATS KV answers `get` on a deleted key with its delete marker, a
  empty value, and `parkHandsHandle` parsed it as a handle ("Unexpected end of
  JSON input") while `parkHandsAfterRun` skipped it as unreadable. Both now read a
  delete or purge marker as `gone`.
- `GET /v1/runs` no longer answers 500 when a query parameter is given twice.
  A repeated key parses to an array, and the handler read every parameter as a
  string, so `?ids=a&ids=b` — and the same for `state` and `since` — reached a
  `TypeError` and reported the server as broken rather than the request. Any
  repeated parameter is now a 400 (`repeated_query_parameter`).
- The prompt-cache loss counter no longer misses the turn after a NATS
  redelivery, no longer reports the anchor breakpoint's fixed distance as a
  broken marker chain, no longer claims the provider reported cache fields it
  did not, and compares gaps against the TTL the deployment configured rather
  than a hardcoded five minutes. Its metric labels are now `over_ttl` /
  `under_ttl`. A SIGTERM arriving inside a turn's tool batch now persists that
  turn's cache-use timestamp rather than the previous turn boundary's, so a
  resumed run does not read a long-running tool call as an expired cache
  entry. Three ways that timestamp still went wrong are closed with it: a
  resumed run's first new tool batch had no checkpoint of its own to carry the
  timestamp and dropped it, a run that never opened a sandbox wrote no SIGTERM
  checkpoint at all because the KV write was gated on having one, and a
  context compaction discarded the cache entry without the runner hearing about
  it, so a SIGTERM wrote the pre-compaction timestamp back and the resumed run
  reported a cache loss that had not happened. A run SIGTERMed during its
  **first** tool batch still writes no checkpoint at all — that case resumes
  with no timestamp, which reads as "no evidence", the detector's
  under-reporting default.
- Checkpoints are no longer written through the redactor that masks events, so
  a resumed run replays what was actually sent. History already in
  `claw_conversation_turns` keeps its `<redacted>` markers; that path is
  unchanged here.
- `upgrade.sh` no longer strips security settings it did not know about.
  `render_chart` rendered with chart defaults for anything a caller did not
  pass, so an upgrade removed the checkpoint key, reset the checkpoint format
  and dropped the per-workload NATS credentials — on a fleet already writing
  sealed checkpoints, that is data loss rather than a rollback.

- Prompt-cache token accounting on the OpenAI path. An OpenAI-shaped
  `prompt_tokens` already contains the cached portion, where Anthropic's
  `input_tokens` is only the uncached remainder; the OpenAI provider passed the
  inclusive number through as `input_tokens` while also reporting the cached
  portion separately, so every consumer that adds the cache fields back on
  counted those tokens twice. A cache hit ratio computed as
  `cache_read / (input + cache_read + cache_create)` therefore asymptoted to
  0.5 as caching improved — observed at ~0.49 on a fleet whose cache was in
  fact working at ~96%. `input_tokens` is now normalized to the uncached
  remainder on both paths.

### Changed
- `secret.yaml` gains `LLM_DEBUG_RESPONSE_HEADERS` (empty by default). It
  changes the rendered secret's checksum, so the first upgrade carrying it
  **rolls api and brain once** even though the value does nothing yet.
- The LiteLLM deploy wrapper no longer passes the master key and database URL to
  Helm when `secrets.existingSecret` is set, so they stay out of the release
  values. Revisions written before this change still hold them; see
  "Credentials already in the release history" in `deploy/litellm/README.md`.

- **Affects existing dashboards and alerts.** The `provider` label and the
  OpenAI-path token-accounting fix in this release both alter series already
  being scraped, and both take effect the moment a Brain pod restarts: the
  label splits every existing series in three of the cache metrics, and the
  accounting fix steps `kind="input"` down to the uncached remainder. Queries
  that `sum()` before dividing keep working and simply become correct;
  anything matching an exact label set, or comparing across the upgrade
  boundary, needs revisiting. There is no setting that restores the old
  numbers — they were wrong.

### Added

- Outbound run notifications, off by default (`CLAW_NOTIFICATIONS_ENABLED`).
  A user subscribes an https URL through `/v1/notification-subscriptions` and
  receives `run.completed` / `run.failed` events for runs started by a trigger
  and for runs that took at least `NOTIFY_MIN_RUN_SECONDS` (default 60) in a
  session created with `config.notify_on_finish: true` (sessions without it
  are never announced as long runs). Events
  go through a database outbox with retry, a stable `event_id` for receiver-side
  dedup, and an HMAC-SHA256 signature over `<timestamp>.<body>`
  (`X-Claw-Timestamp`, `X-Claw-Signature`, `X-Claw-Event-Id`). Subscription URLs
  must be https and must not resolve to a private address unless the host is in
  `NOTIFY_WEBHOOK_ALLOWED_HOSTS`.
- `terminal.failure_reason` on `GET /v1/runs`: Claw's own code for how the run
  failed. `class` and `kill_reason` report a run whose sandbox never became usable
  as `failed` / `""`, exactly like an agent that ran and broke; the provisioning
  codes listed in `claw/docs/run-api.md` are what tell a dispatcher that nothing
  executed.
- `run_id` on the responses that start a run, so a caller can read back the run
  it just began. `POST /v1/sessions` with a `message` reports it at
  `data.message.run_id`, and `POST /v1/sessions/{id}/messages` at the top level
  when the message is dispatched rather than queued. Both previously returned
  only a session ID and a message ID, neither of which names a run: a session
  owns many runs, so a caller polling `/v1/runs` had to guess which entry was
  its own. A message accepted while the session is busy still answers
  `{"queued": true}` with no `run_id` — its run row is opened later, when the
  queue drains — and `POST /v1/sessions` without a `message` starts no run and
  reports none. Additive; no existing field changed.
- `session_id` on every `/v1/runs` result, and a `?session_ids=` filter for
  enumerating the runs of one or more sessions. This is a collection filter for
  discovery and reconciliation, not a second way of naming a run: it returns
  every run a session owns, so `requested` counts sessions asked about rather
  than runs to expect back. At most 350 session IDs and 1000 returned runs per
  call, each refused (`too_many_ids`, `too_many_runs`) rather than trimmed.
  See [`claw/docs/run-api.md`](claw/docs/run-api.md).
- Initial public release of PrimusClaw: the Claw agent harness (`claw/`), the
  Agent Sandbox control-plane fork (`sandbox/`), the long-term memory plane
  (`memory/`), and the whole-stack installer.
- Deployment-level sandbox lifetime settings: `brain.sessionTimeout` and
  `brain.maxSessionDuration` in the Claw chart, set at install time with
  `AGENT_SANDBOX_SESSION_TIMEOUT` / `AGENT_SANDBOX_MAX_SESSION_DURATION`.
  Both take Go durations (`6h`, `48h`). Both are persisted to
  `deploy/values.<namespace>.env`, so an upgrade re-renders with the value the
  install chose. Leaving them unset changes nothing: the sandbox template's own
  values, and then the built-in fallbacks (`15m` idle, `24h` lifetime), still
  apply.
- An `IdleReclaimRequested` Kubernetes Event on the Sandbox, recording the idle
  timeout a reclaim was measured against and the last activity it saw, so a
  operator can tell an idle reclaim from any other deletion after the fact.
- A `provider` label (`anthropic` | `openai`) on `claw_brain_llm_tokens_total`,
  `claw_brain_llm_cache_turns_total` and `claw_brain_llm_cache_write_tokens_total`.
  What a wire protocol can observe differs — the self-hosted OpenAI-shaped
  backend reports no cache writes at all, and no TTL breakdown — so a fleet
  that speaks both, during a rollout or after a backend switch, previously
  summed measurements together with blind spots and gave the reader no way to
  notice.
  The Brain dashboard's "Prompt Cache Hit Ratio" panel gained a per-provider
  token series so the split is visible, and its description now names the
  arithmetic signature of the failure the label exists to catch.

<!--
Template for the next release. Drop the sections that do not apply.

## [x.y.z] - YYYY-MM-DD

### Added
### Changed
### Deprecated
### Removed
### Fixed
### Security

Call out anything that changes behaviour for an existing deployment under
**Changed**, with the setting that restores the old behaviour where one exists.
Feature flags that default off are the usual case — see CLAW_MEMORY_ENABLED and
CLAW_SKILL_EVOLUTION_ENABLED in claw/.env.example for the pattern.
-->
