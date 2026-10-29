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
- `auto_approve` on an MCP server spec, the sibling of `requires_approval`: an explicit allowlist (tool
  names, a trailing `*` for a prefix, and an optional `when` that must equal the call's top-level scalar
  arguments) of the held tools that may run without a decision, so a session nobody is watching can run
  low-risk tools. A held tool that is not listed still waits for a person; an absent field changes
  nothing, and a malformed one releases nothing. A release is recorded as `decisionResult` with
  `by: "policy"` and counted in `claw_hitl_policy_allow_total{rule}`. See `claw/docs/mcp-approval.md`.
- A shared identity client in `@claw/utils`, built by API and Brain when
  `IDENTITY_CLIENT_ENABLED=true` (off by default; nothing authenticates through it yet). It does OIDC
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
- Deployment-level platform defaults: `PLATFORM_DEFAULTS_FILE` lists default skills
  (by marketplace tool id) and MCP servers mounted into every chat, behind
  `PROGRESSIVE_SKILLS_ENABLED` for skills. Default skills are listed by name and
  description only and written into the sandbox on first read. Off by default;
  see `claw/docs/platform-defaults.md`.

### Changed
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
  every sweep. NATS KV answers `get` on a deleted key with its delete marker, an
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
  timeout a reclaim was measured against and the last activity it saw, so an
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
