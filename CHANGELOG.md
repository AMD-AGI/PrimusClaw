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

### Changed
- `secret.yaml` gains `LLM_DEBUG_RESPONSE_HEADERS` (empty by default). It
  changes the rendered secret's checksum, so the first upgrade carrying it
  **rolls api and brain once** even though the value does nothing yet.
- The LiteLLM deploy wrapper no longer passes the master key and database URL to
  Helm when `secrets.existingSecret` is set, so they stay out of the release
  values. Revisions written before this change still hold them; see
  "Credentials already in the release history" in `deploy/litellm/README.md`.

### Added
- Initial public release of PrimusClaw: the Claw agent harness (`claw/`), the
  Agent Sandbox control-plane fork (`sandbox/`), the long-term memory plane
  (`memory/`), and the whole-stack installer.

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
