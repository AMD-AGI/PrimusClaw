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
