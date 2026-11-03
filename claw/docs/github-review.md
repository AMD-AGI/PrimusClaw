<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# GitHub pull request review

A session can review a public GitHub pull request, and merge it when everything is green,
**with the GitHub account of a named user**: the requester asks, the named user is the
reviewer of record. Four tools do the work. The GitHub token is fetched from the identity
provider for one tool call, used on the API's side and dropped; it never enters a sandbox, a
tool result, a log line or an event. Claude, Codex and the other agents that review in a
sandbox have no token to leak. Nor does the requester's own key or their stored variables: the
sandbox of such a session holds none of them (see "The sandbox holds no key").

Off by default. With `CLAW_GITHUB_REVIEW_ENABLED` unset there are no tables, no routes, no
tool offered to a session, and `config.acting_as` is refused.

## The ordinary request

The author of a pull request asks a chat integration to have a committer review and merge it. The
committer has allowed that once, beforehand: they bound their GitHub account at the identity
provider and switched on its `delegation` flag, which is their standing authorization. The
integration then starts a session that acts as the committer (`config.acting_as`) and reviews and
merges the author's pull request with the committer's own account, with no confirmation and no question
asked, as long as CI is green and the change is not high risk (architecture, interfaces, security, CI
or release, dependencies, size: see "High risk"). An approval or a merge of a high-risk change is held
until the committer confirms that very write, signed in as themselves. The author needs no GitHub
account bound and is not looked at; the committer's account must not be the author of the pull request
(`cannot_approve_own_pull_request`), and without the committer's standing authorization nothing is done
with their account (`delegation_off`).

## How a session uses it

1. The requester creates a session with `config.acting_as = "<user id>"` (`POST /v1/sessions`),
   signed in with an identity provider's access token: a person's own, or a service's that an
   operator named (see "Who may speak for the person"). An `ak-` key, a BYOK key, a connector token
   and a browser session cookie are refused (`403 interactive_sign_in_required`): the key a sandbox
   holds must not be able to start a session that reviews and merges with its owner's account.
   A service that creates the session for the requester sends the requester's own `ak-` key in
   `x-api-key` beside its token, so that the turns run on the requester's models and quota
   (see "A service answering for the acting user"); a key alone is still refused.
   The id is a reference, never a credential. The requester is the session's owner; the
   verified caller's name is kept as `config.acting_as_requester` for the review footer (a
   client cannot set it).
   The same credentials are asked of everything that puts work in front of that session's model
   afterwards: a message (`POST /v1/sessions/:id/messages`, queued or immediate, and the Anthropic-compatible
   `POST /anthropic/v1/sessions/:id/events`), an approval or an answer to a question of the model
   (`messageType: "decision"`, `POST /v1/chat/sessions/:id/decisions` and `/answers`), and a task, a batch, a
   retry, a hosted application run or a workbench run into it. Otherwise a model in any ordinary session of
   the same user would find the acting session with `GET /v1/sessions` and send it a message with its key.
   Each is `403 interactive_sign_in_required` (or `service_client_not_allowed`) without one, and nothing is
   queued or created. Stop, and starting the session's sandbox (no model call), are not asked for. Browser
   clients of such a session therefore send the person's identity-provider access token, not the session
   cookie.
   The creator may also bind the session to one pull request with `config.review_target =
   {"owner": "<owner>", "repo": "<repository>", "number": <n>}`. Every tool call that names another pull
   request, in this repository or any other, is refused (`review_target_mismatch`) before the acting
   user's credential is looked up, reads included; the answer names the bound pull request. It is
   written only when the session is created (no route changes a session's config afterwards), it is
   `400` without `config.acting_as` or when it is not a well-formed reference, and a session whose stored
   target cannot be read is offered no tools (`403 review_target_invalid` on the tool route). Without it
   the session may act on any pull request of an allowed owner. The binding is what stops a model that
   was talked into naming another pull request from reading it, or writing under the acting user's name
   on it.
2. From then on every turn of that session is offered an MCP server named `github_review`
   (reserved: a request cannot replace it) with four tools, hosted by the API at
   `POST /v1/internal/github-review/mcp`. Brain calls it with a token signed by the API
   (`CLAW_GITHUB_REVIEW_MCP_SECRET`) that names the session, its owner and `acting_as`; the
   route checks the session row again on every call.
3. The model reviews with the `pr-review` skill (below) and posts one review; if it is clean it
   merges. Every gate is in the tool, not in the prompt.

## The tools

| Tool | What it does |
|---|---|
| `gh_pr_get` | The pull request, its files and diff, CI, review threads, existing comments, the risk verdict, what the acting user may do, the review path (below) and the review instructions. Text that came from the pull request is under `untrusted`. Call it first. |
| `gh_pr_risk` | The risk verdict alone, with its categories. The model may pass `risk_flags` (`security_finding`, `review_skipped`) and a `risk_judgement` (see High risk); both can only raise the verdict. |
| `gh_review_submit` | One review on the pinned head commit (the model may pass the same `risk_flags` as to `gh_pr_risk`, and they count for an `APPROVE`), with inline comments that must sit on lines the diff shows. `COMMENT`, `REQUEST_CHANGES` or `APPROVE`. A body footer says `Reviewed by <agent name> on behalf of <login> (requested by <name>), run <id>` (the agent name is `CLAW_GITHUB_REVIEW_AGENT_NAME`, default `Claw`) and a hidden marker (the run, the event and a digest of the text and inline comments) keeps a retry of the same review from posting twice, while a different review of the same kind on the same commit is posted. An `APPROVE` of a high-risk change is held until the acting user confirms (below). |
| `gh_pr_merge` | Approves when needed and merges, if every gate is open. On a base branch that is merged through a merge queue it puts the pull request in the queue instead of merging it (`queued`, below). A high-risk change is held until the acting user confirms. |

## Gates (all enforced inside the tools)

- **Which pull requests.** The repository's owner must be in `CLAW_GITHUB_REVIEW_OWNERS`
  (default `AMD-AGI`), the repository must be public (`private` is false and the visibility is
  `public`), not archived, the pull request open and not a draft. A repository that has moved
  is judged by its owner now. Nothing is asked of GitHub for an owner that is not allowed.
- **Which commit.** `gh_review_submit` and `gh_pr_merge` take the `head_sha` that `gh_pr_get`
  returned. A head that moved is refused (`head_moved`); the merge itself is made with
  `sha=<head>` (and a request to the merge queue names it as `expectedHeadOid`), so GitHub refuses it too if the head moves in between.
- **The acting user's say.** The credential is the acting user's own (`requester_user_id ==
  user_id`) or the user has allowed others to act for them (the identity provider's
  `delegation` flag, their standing authorization). Without that every tool is refused
  (`delegation_off`), reads and comments included: the account is not used, and nothing is sent to
  GitHub with it. An approval also needs the user to have write permission on the repository. Without
  write permission the review stands as comments and nothing is merged (`no_merge_permission`).
- **The acting user did not write it.** An approval and a merge (which approves where it must) made
  with the account of the pull request's author are refused (`cannot_approve_own_pull_request`): GitHub
  does not count it, and it would be no second person's review. It is the first thing an `APPROVE`
  review and a merge ask, after the pull request itself has been read and before CI, threads, the diff
  or the merge rules are read and before anyone is asked to confirm, and again when the acting user
  allows a held write. The person who asked is not looked at: they are very often the author, which is
  the ordinary case, and their own GitHub account need not be bound. An account whose login the identity
  provider does not know (an empty one) cannot be compared with the author, so an approval or a merge with it is
  refused too (`acting_login_unknown`), at the same place. A comment and a request for changes approve nothing
  and are not held to either. `gh_pr_get` tells the model before it tries: `acting.acting_user_is_author`.
- **Standing authorization and high risk.** With the acting user's `delegation` flag on, a `COMMENT`, a
  `REQUEST_CHANGES`, an `APPROVE` and a merge are made at once, whoever asked, when the change is not
  high risk. An `APPROVE` review and a merge of a high-risk change (the rules and the reviewer's own flags
  and judgement count, see "High risk") stop at `confirmation_required` and write nothing, for the
  reasons the rules gave, until the acting user has confirmed that very write; a comment or a request for
  changes on the same change is posted as ever. The confirmation holds the review as it will be posted
  (event, text, inline comments), so what the acting user reads is what goes out; the gates of the write
  are read again when they allow it. It cannot be switched off by a setting or by a repository's
  configuration. A held approval is posted alone: to approve and merge in one confirmation, a model calls
  `gh_pr_merge`.
- **Merge queue.** A base branch that is merged through a merge queue refuses a direct merge, so there
  `gh_pr_merge` does not merge: after every gate of a merge has passed and the approval is on the pull
  request (or the acting user has allowed a high-risk merge), it puts the pull request in the queue with the
  GraphQL mutation `enqueuePullRequest`, as the acting user, pinned to the head commit the review read
  (`expectedHeadOid`), so a push after the last read is not queued. It never jumps the queue. The answer is
  `status: "queued"`, never `merged`, with the queue entry GitHub returned (`queue_entry_id`,
  `queue_position`, `queue_state`) and `approved_by_this_call`. Claw does not track the queue: the queue runs
  its own checks and merges the pull request, or takes it out, later, and nothing here looks again. A second
  `gh_pr_merge` finds the pull request in the queue (`isInMergeQueue`, `mergeQueueEntry` in the same GraphQL
  read) and answers `queued` with `already_queued: true` and writes nothing, so a retry after a lost answer
  does not queue twice. Two reads say a queue is there, and either one is enough: the rules of the base branch
  (`GET /repos/{owner}/{repo}/rules/branches/{branch}`, the same read that finds the required checks) include
  a `merge_queue` rule, which sees rulesets only; and the pull request's `isMergeQueueEnabled` (the GraphQL
  read of its merge state) is true, which also covers a queue set up through classic branch protection. A
  `false`, a `null` and a missing field are not a queue; rules that cannot be read are not a queue either and
  fail the CI gate (`ci_not_green`) before any write. The queue, not this call, chooses the merge method, so
  `method` and the repository's allowed methods do not matter there. Failures are told as they are:
  a head that moved (checked before the approval is written, and again when GitHub refuses the pinned head,
  which is read again to say why) is `head_moved`; a queue GitHub refuses (repository settings, permissions) is
  `enqueue_refused` with GitHub's own message and `approved_by_this_call`; an answer without a queue entry is
  `enqueue_unconfirmed`; a pull request GitHub gave no id for is `unreadable_pull_request`. Nothing is ever
  reported as queued or merged unless GitHub said so. The acting user's allow of a held merge queues it and
  closes the confirmation as `queued` (below). A merge queue has not been exercised against a real
  repository.
- **An approval.** An approval can merge a pull request by itself (GitHub's auto-merge), so
  `gh_review_submit` with `APPROVE` is posted only where `gh_pr_merge` would not stop: CI is
  green on the head commit (`ci_not_green`) and no review thread is open (`threads_unresolved`);
  an approval of a high-risk change, the model's `risk_flags` included, is then held for the acting
  user (`confirmation_required`, `kind: "review"`). `COMMENT` and `REQUEST_CHANGES` are not held to that.
- **The merge.** Everything is read again at merge time: CI is green on the **head commit**
  (every check completed and passing; a required check that never reported is missing; a pull
  request with no check at all is not green however clean GitHub calls it; an infrastructure
  failure is a failure; nothing is re-run), no review thread is unresolved, GitHub's own merge
  state is `CLEAN` after the approval (GitHub works the state out asynchronously, so an `UNKNOWN`,
  and a `BLOCKED` right after this call's own approval, is looked at again for about seven seconds, one
  request a look, with CI read once more before a merge that had to wait, before the merge is refused as `merge_state_not_clean`), and the repository's own
  protections are met because they are GitHub's. No admin merge, no auto-merge, no branch update, no change to a rule.
  The method is the repository's first allowed one, squash first.
- **High risk.** A versioned rule pack (`packages/api/src/github-review/risk.ts` and
  `risk-signals.ts`, version `2026-11-02.1`) decides from what the change **does**, read from
  its diff, not from which kind of file it touches. An approval or a merge is held for the acting user's own
  confirmation when the change is
  - an **architecture** change: a package or module added or removed (a manifest, a `go.mod`, a
    `__init__.py`), a deployable unit added or removed (a Dockerfile, a compose file, a
    Kubernetes Deployment, Service, Ingress or role, a Terraform resource), a directory moved
    (three or more files) or code moved between packages, a relative import that reaches into
    another package, the workspace, project-reference or layering rules changed;
  - an **interface** change: an exported symbol with a different signature or removed (TypeScript,
    Go, Python, Rust and Java/Kotlin/C# are read; a new export counts in a package's entry point),
    an HTTP route added, removed or changed, an OpenAPI, protobuf, GraphQL, Avro or JSON schema, a
    command-line flag, an environment variable read or the documented configuration example, a
    database migration or a schema statement in code, a wire or event format under `protocol/`,
    `contracts/` and the like;
  - **security-sensitive code**: authentication, authorisation and permission logic, token
    handling, cryptography, privilege and isolation settings, secret and credential handling, web
    security settings, code-execution surfaces, and the lines that switch verification off or
    carry a secret (a secret is a finding in documentation too, an insecure flag in prose is not);
  - a **CI or release** change (workflows, governance files such as CODEOWNERS, a Dockerfile, a
    chart, a release script), however small the edit (the path floor below), a **dependency**
    manifest change, or a change that is large (files, lines, deletions) or broad (five packages or
    more).

  For interfaces and architecture it reads the **net** change: a line that one file loses and
  another gains cancels out, and blank and comment lines are not content, so a pure refactor, a
  move of code, a reformat, a comment-only edit, documentation and tests are low. A rename inside
  one package is low. What a comment is depends on the file's language: `//` and a block comment
  that closes on its line in the C family, Go, Java, Rust and TypeScript, `#` in shell, Python,
  YAML and Dockerfiles (not `#!` or `#[`), `--` in SQL, a closed `<!-- -->` in markup, and nothing
  at all in a file of a kind that is not listed, where every line is read. A line that only
  starts like a comment is code and is read (`#allowed() {` in TypeScript is a private member, an
  empty block comment followed by a call is a call, `* b;` ends a multiplication), a line is a
  comment only when all of it is, and a line in the middle of a block comment is read like any
  other. A comment-only edit is low, except in the files the path floor watches. Security-sensitive code, schemas, migrations, layering rules and the files
  the path rules watch (workflows, a Dockerfile, an authentication module) are read **raw**, with
  nothing cancelled: a check that is removed in one place and an identical line added in another
  is indistinguishable from a move, and must not be able to hide behind a copy of itself, so
  moving code that carries such a line is held. A comment that a tool reads is not a comment: a
  Dockerfile parser directive (`# syntax=` names the build frontend), a migration tool's
  `-- +goose` and `-- migrate:` lines, `//go:generate`, `//go:build`, a `+kubebuilder` marker, the
  C preprocessor, and a marker that switches a security scanner off for a line (`#nosec`,
  `checkov:skip`, `nolint:gosec` and the like) all count as changed content. A changed line longer
  than 4000 characters (minified or generated code) is held rather than scanned, and so is a change
  with more than 20 000 changed lines or two million characters, which is not read past that point.
  Every pattern that reads a line runs in time linear in its length (the author of a pull request
  may be outside the organisation, and the rules run in the API's own process:
  `test/github-review-redos.test.ts` times each language on adversarial lines). What it cannot see (a
  field added to an exported type, a parameter on a wrapped signature line, a behaviour that changed
  under an unchanged name) is for the reviewer's own judgement (below).

  Under the content rules sits a **floor** that reads no content and stays as a backstop: a file
  that came without its diff (GitHub sends none for a binary, a rename or a diff it finds too large,
  and counts a modified or renamed binary as 0 lines, so the missing patch is the signal), a lock
  file (it decides what an install downloads), a submodule pointer, a file mode change, a file list
  that was cut, a fork, a non-member author, a base branch other than the default, an
  authentication module, a workflow, a Dockerfile, a chart or a release script that is edited at
  all (a line shaped like a comment does not take it below the floor: the content rules can only
  add), a file tracked by Git LFS (GitHub sends its pointer, `version`, `oid sha256:` and `size`,
  as an ordinary text patch with real line counts; that is a diff that did not show the file, and
  is treated like a binary's), and any rule that throws: the rules fail closed. A file that was moved is judged by the path it left as well
  as the one it went to, and a line that starts with `++` or `--` is read like any other. A
  repository's `.github/claw-review.yml` on the base branch can add paths (`high_risk_paths`) or ask for
  confirmation on every merge (`confirm_merge: always`).

  **The reviewer's judgement.** `gh_pr_risk`, `gh_review_submit` and `gh_pr_merge` take
  `risk_judgement: {level: "low" | "high", reason}`. A `high` with its reason adds a reason that
  comes first on the confirmation the acting user is shown (one clipped line, markup stripped, the
  token masked) and holds the merge, and an APPROVE with it. A `low` changes nothing: the
  reviewer can raise the verdict, never lower it, and what the rules said alone is reported apart
  (`risk.rule_level`, `risk.raised_by_reviewer`, `risk.categories`: `architecture`, `interface`,
  `security`, `ci_release`, `dependency`, `size_breadth`, `integrity`, `provenance`, `reviewer`).

  A merge or an approval that needs confirmation creates one pending row for the head commit and
  writes nothing.

## Confirmations

| Route | Purpose |
|---|---|
| `GET /v1/github-review/confirmations?session_id=<id>&status=pending` | The confirmations of the caller's own sessions and those that ask the caller. `{items:[{id, kind, review, repo, pr, title, author, head_sha, reasons, checks, actor_user_id, requester_user_id, session_id, expires_at, status}]}`. `kind` is `merge` or `review`; for a `review`, `review` is `{event, body, comments: [{path, line, side, body}]}` as it will be posted (without its footer), and `null` for a merge. `status` is `pending`, `merging`, `merged`, `queued`, `submitted`, `denied`, `stale`, `expired` or `refused` |
| `POST /v1/github-review/confirmations/:id/decision` `{decision: "allow" \| "deny"}` | The acting user's answer, given with an identity provider's access token: their own sign-in at the provider, or an allowed service's (next section). Anyone else gets `403`, and so does the acting user with an `ak-` key (`Authorization: Bearer` or `x-api-key`), a BYOK key, a connector token or a browser session cookie, whatever the id (`403 interactive_sign_in_required`; the check is on how the request was authenticated, before the confirmation is looked up). The sandbox of an ordinary session holds its owner's key, and with SaFE's built-in sign-in that key sets the owner's password and logs in, which returns a session cookie the API verifies as the person's own: so neither a key nor a cookie is proof of a person, and a model in any session of that user could otherwise answer a confirmation itself. On `allow` every gate is read again and the held write is made with the acting user's account; the answer is `{status: "merged" \| "queued" \| "submitted" \| "denied" \| "stale" \| "expired" \| "refused" \| "retry", reason, merge_sha, queue_entry_id, queue_position, queue_state, review_id, url}` (`merged` for a merge, `queued` for a merge that put the pull request in the base branch's merge queue, which is not yet merged, `submitted` for a review). `retry` means the write could not be tried just now (the identity service or GitHub failed, a limit was hit) before anything was sent to GitHub, and the confirmation is still open: allow it again. Once a review, an approval or a merge has been sent the try is not given back: the confirmation is closed as `refused` with `wrote: true`. The write is recorded as asked for by the requester, not by the acting user. A service an operator named may answer for the acting user too (next section) |

A browser session cookie would be taken again only where the platform that issues it refuses to set a
password with an API key; that is a change to Primus-SaFE, not something this code can check, so until
it is made the identity provider (or an allowed service) is the only way to answer.

A confirmation lives 24 hours (`CLAW_GITHUB_CONFIRMATION_TTL_SECONDS`), is bound to the head
commit (a head that moved makes it `stale`) and is used once. There is one pending confirmation for a
head commit and a write: asking for the same merge, or posting the same review, again shows the same one,
while a merge and a review, or two reviews that say different things, are different confirmations. One
acting user is asked about at most ten writes at a time (`too_many_pending_confirmations`).

### A service answering for the acting user

A chat integration or another service cannot hold a person's sign-in at the identity provider,
and the key a sandbox holds (and the cookie that key can sign in to) is refused on purpose. A
**service client** of the identity provider answers instead, the way a service acts for a user everywhere else in Claw: it exchanges its own client
credentials for an access token that acts as that user (RFC 8693: `sub` is the user, `act.sub` and
`client_id` name the service) and calls the decision route with it as `Authorization: Bearer`.

- Only a client an operator named is taken: `CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS`
  (comma or space separated, compared exactly as the identity provider signed it, empty by
  default, which refuses every service). Any other client, and a token that names an actor but
  no client, is `403 service_client_not_allowed`.
- The subject is the token's `sub`, which the service cannot choose: the answer counts only when
  it is the acting user's own (`403 only_the_acting_user_can_decide` otherwise), so a service
  holding a token for someone else, or its own token, cannot answer.
- A person's own access token (their sign-in at the provider, which names no actor) is the person's
  answer, and an `ak-` key, an `x-api-key`, a BYOK key, a connector token or a browser session cookie
  is refused (`403 interactive_sign_in_required`), whatever the allow-list says. (A key sent beside an allowed
  service's token is not a credential of its own: see "The requester's own key" below. Sent alone it is refused.)
- The same two checks apply to creating a session with `config.acting_as` (`POST /v1/sessions`) and to
  every turn in it (see "How a session uses it"): the person's own token, or an allowed service's, and
  nothing else. Without a credential of that kind the answer is `403 interactive_sign_in_required` or
  `403 service_client_not_allowed`, and nothing is created or queued.
- **The requester's own key.** A turn needs a model key, and a delegated token has none of its own
  (see [identity-client.md](identity-client.md), "Keys for a token's user"). A service named in
  `CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS` (comma or space separated, compared exactly as signed, empty by
  default) may send the requester's own `ak-` key as `x-api-key` with the request that creates the session and
  with every request that sends it a message or answers it. It counts only when SaFE says the key is the
  token's own `sub`'s (`401 key_subject_mismatch` otherwise; `401 invalid_api_key` for a key SaFE does not
  accept or a value that is not a key; `503` when SaFE cannot answer), and the turn then runs on the
  requester's keys, never on the acting user's. The decision route is called with the acting user's token and
  runs no turn, so it is sent no key: one sent with it would not be that token's user's and is refused. Setting the list needs
  `CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS` to name the same services: a process with the review on that
  has a client in the first list and not in the second does not start. With the list empty, nothing here
  changes: a delegated token has no keys and the header is not read.
- Who stood behind the answer is recorded: `decided_by` is the acting user, `decided_via` is
  `{kind: "service", client_id, act_sub}` (also in the confirmation list), the closing `result`
  says `by: "service"`, the audit row of the write carries `decided_by_service`, and a
  `github_review.decision_by_service` log line names the confirmation, the user and the client.

## The sandbox holds no key

A model that reviews a pull request reads what strangers wrote, and a sandbox's environment is whatever that
model can print. In an ordinary session that environment holds its owner's key (`SAFE_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), which with SaFE's built-in sign-in is also the owner's account. A session
with `config.acting_as` is therefore built differently: every turn Brain is handed for it carries
`withhold_sandbox_keys` (decided from the session's row, on every path a turn reaches Brain by: a message, a
turn claimed from the queue, a task of a DAG), and Brain creates its sandbox with none of the three. Brain keeps using
the key for what it does itself, the model calls and the workload it creates and owns in SaFE. What a process in
the sandbox cannot do is call the model or SaFE as the requester: a review reads and runs code, it does not need
to. The three variables are taken out of the environment once it is composed, whichever layer set them (the
sandbox spec's, the request's); every other variable of those layers is applied as before.
The session's own sandbox, if it holds the keys (one made before the mark existed), is not reused for a marked turn:
the mark is part of what a sandbox is reused by, so the turn gets a new one, and the fingerprint of a sandbox made
without the mark is unchanged. A sandbox that a DAG handle names is looked up before that comparison, so a session that
acts as a user and was already running tasks on a Brain without the mark should be created again rather than
continued; a session created with the mark never has one. A hosted application run (`mode: "app"`) is refused for such
a session (`409 app_run_not_allowed_for_acting_session`), and Brain winds up one that was admitted before that refusal
existed (stops its sandbox, revokes its grant, ends the run) instead of starting it: an application's sandbox is made
with the key, and an application is code the session's model can hand text to.
The key stays where the session already keeps it (the session's stored configuration, server-managed), and is not
shown to the model or the sandbox. Nothing changes while `CLAW_GITHUB_REVIEW_ENABLED` is off: such a session is
an ordinary one.

**The requester's stored variables are not sent either.** The requester's env vault (`/v1/env/user`) is where
personal tokens are kept (GitHub, Hugging Face, W&B and the like), under names no key filter would know, and an ordinary
session's sandbox is composed with all of it. The model of a session with `config.acting_as` can print those as it can
print the keys, so such a session is sent none of them, on every path that carries the vault: the API does not read it
for a message, for a message queued behind a running turn (also one the server queues on a session by itself), for the
first message of a new session, for the start of the
session's sandbox, for an event of the Anthropic-compatible route, or for a workbench run into the session; it reads none
when Brain claims a queued turn, and takes whatever a queued message was frozen with before the mark applied off the turn
it sends on; and the scheduler's dispatch of a task of a DAG leaves out what the task's input holds, from the request and from the
context its prompt and script templates are rendered with (a template that names it does not resolve and the task is not
sent). Brain composes none
of `request.user_env` into the sandbox of a request marked `withhold_sandbox_keys` (and so a change in the vault is not a
change of such a sandbox), whatever the request carries, as a backstop for one that is sent some anyway. A new place that
reads the vault or puts it on a request fails `test/github-review-acting-user-env.test.ts` (E9) until it says how it
decides.

Two other layers of a sandbox's environment are applied as before, and this is why. The request's own `env` (the
per-message `session_env`) is written by the person, or the allowed service, that sends the message, for that sandbox:
nothing is read from a store on their behalf, so it carries no secret that the sender did not hand over for the purpose,
and only the person's own sign-in or an allowed service can send into such a session at all; the three key variables are
still taken out of it. The system environment (`/v1/env/system`, written by a system administrator) is composed
into the sandbox of every session of every user as a fallback: it is nobody's personal secret, a model in any other
session can print the same, and it cannot name the model keys. A personal credential does not belong in it, and a review
sandbox is not given a smaller one.

## Review path: the diff or a sandbox

A sandbox costs a cold start of about 16 seconds. A small change needs none: `gh_pr_get`
returns the diff, the file list and the metadata, and says `review_path.path = "api_diff"`.
A sandbox is allowed (`"sandbox"`) when the change is large, GitHub did not send the diff of
some file (a binary, a rename or a diff too large, whatever the line counts say), the file list is incomplete, or the repository has a review skill of its own, which
may use scripts. Brain opens a sandbox only when a turn uses a sandbox tool, so the decision is
advice plus a record: a structured log line (`github_review.path_chosen` with `review_path`,
`review_path_reason`, `session_id`, `repo`, `pr`, `changed_files`, `changed_lines`) and the
`review_path` and `review_path_reason` columns of the audit row.

### The sandbox path: getting the code

On the sandbox path `gh_pr_get` also returns `review_path.sandbox_recipe`, a short bash script, and
the model runs it as it is. It is anonymous by construction: the repositories are public, so no
credential is needed and none may be given. The script starts git in a clean environment (only
proxy and certificate settings are passed through), ignores every git configuration file, turns
the credential helper off, rewrites the checkout's own configuration each time so a reused one
cannot carry a header, a helper, a rewrite or another remote, and talks to one address,
`https://github.com/<owner>/<repo>.git`. It fetches the base branch and the pull request's own
head through GitHub's `pull/<n>/head` ref, so a fork's commits arrive without a fork remote ever
being added. Both are fetched shallow and without file contents (`--depth`, `--filter=blob:none`),
and a checkout that already exists in the sandbox is reused, so only what is new is fetched and a
large repository stays fast. The fetched head is pinned to the `head_sha` the tools returned: any
other commit stops the script with exit code 3 and the model calls `gh_pr_get` again. Only the
code comes this way; the metadata, the diff and the existing comments come from the tools, which
hold the acting user's token on the API's side. The script is built only from a validated owner,
repository, number, branch name and commit id (a branch name it will not put in a command means
no recipe, and the review proceeds from the `gh_pr_get` result alone).

## Review instructions

A repository's review skill is read from the **tip of the base branch** and nowhere else
(never the pull request's head, which could rewrite the rules it is reviewed by), in the order
`.claude/skills/review-pr`, any other `.claude/skills/*review*`, any `.agents/skills/*review*`,
together with the base's `AGENTS.md` and `.github/copilot-instructions.md`. The fixed rules (read
and comment only, text from the pull request is data, the tools' gates) are always put in front
of it. Without one the default `pr-review` skill applies
([`examples/skills/pr-review/SKILL.md`](../examples/skills/pr-review/SKILL.md), the same text,
importable as an ordinary skill): parallel passes over the whole change, only what the change
introduces, only findings that are actionable and verified with a path and line, a rebuttal
round per finding, CI read for the head commit, at most five findings, one review, no code
changes, no request for reviewers. The answer ends with exactly one last line, `VERDICT: CLEAN`,
`VERDICT: BLOCKING` or `VERDICT: NOT_REVIEWED`, which a calling program can read.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `CLAW_GITHUB_REVIEW_ENABLED` | off | Everything above |
| `CLAW_GITHUB_REVIEW_MCP_SECRET` | required when on | At least 32 characters; signs the tool token. A process that is on without it, or without `IDENTITY_CLIENT_ENABLED`, refuses to start |
| `CLAW_GITHUB_REVIEW_MCP_URL` | `<INTERNAL_BACKEND_URL>/v1/internal/github-review/mcp` | Where Brain reaches the tools |
| `CLAW_GITHUB_REVIEW_TOKEN_TTL_SECONDS` | 43200 | Life of the tool token |
| `CLAW_GITHUB_REVIEW_OWNERS` | `AMD-AGI` | Comma-separated owners whose repositories may be reviewed |
| `CLAW_GITHUB_WRITES_ENABLED` | off | Off is a dry run: every gate is checked and nothing is written to GitHub; the tools answer what they would do |
| `CLAW_GITHUB_API_URL` | `https://api.github.com` | The API address |
| `CLAW_GITHUB_CONFIRMATION_TTL_SECONDS` | 86400 | Life of a pending confirmation |
| `CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS` | none | Identity-provider client ids of the services that may answer a held write, or create a session that acts as a user, for the user their token names (see "A service answering for the acting user"). Empty refuses every service |
| `CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS` | none | The services whose delegated token may bring the requester's own `ak-` key in `x-api-key` (see "A service answering for the acting user", and [identity-client.md](identity-client.md)). Each must be in `CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS` too, or the process does not start. Empty: no service may |
| `CLAW_GITHUB_REVIEW_AGENT_NAME` | `Claw` | How the footer of a review names its author (`Reviewed by <name> on behalf of ...`): one line of plain text, at most 40 characters |
| `CLAW_GITHUB_REVIEWS_PER_TOKEN_PER_HOUR` | 6 | Reviews one GitHub account may have in an hour (a review and its merge count once) |
| `CLAW_GITHUB_REVIEWS_PER_HOUR` | 20 | The same, all accounts together |
| `CLAW_GITHUB_CONCURRENT_PER_REPO` | 3 | Tool calls on one repository at once, per API replica |
| `CLAW_GITHUB_REQUESTS_PER_SESSION` | 60 | GitHub requests one session may make |
| `CLAW_GITHUB_REVIEW_FAST_MAX_FILES` | 15 | At most this many changed files for the diff-only path |
| `CLAW_GITHUB_REVIEW_FAST_MAX_CHANGED_LINES` | 600 | At most this many added plus deleted lines for the diff-only path |

The identity provider must give the API's own client the `identity.credential.resolve` scope
(see [identity-client.md](identity-client.md), external credentials). Without a bound credential
for the acting user a tool answers `actor_not_bound`; an expired one `credential_expired`; an
identity outage `identity_unavailable`, and nothing is done in any of the three.

## Audit and limits

Every tool call writes a row to `claw_github_audit` **before** it does anything and finishes
it afterwards: requester, acting user, session, repository, pull request, head commit, tool,
a summary of the arguments (names and sizes, not the text of a review), the number of GitHub
requests and their request ids, the risk reasons, the confirmation, whether it was a dry run or
a write, the result and the review path. A call that cannot be written down is not made. No
table holds a credential. A tool answer is masked with the token and anything shaped like a
secret before the model reads it. Rate limits answer `rate_limited`; GitHub's own limits
answer `github_rate_limited` with `retry_after_seconds`, and a write is never retried blindly:
a retry first looks for its own marker on the pull request, in all of its reviews (more than a thousand
answer `reviews_unreadable`).

## Names

- Earlier release names, still read and never written: the hidden marker `<!-- clawy:run:... -->` in a review's footer (a retry still finds a review an earlier release posted, and does not post it twice) and the repository configuration file `.github/clawy.yml`, which is read only where `.github/claw-review.yml` is absent. A pull request that edits either file is high risk. Everything new is written under the neutral names: the marker `<!-- claw-review:run:... -->`, the file `.github/claw-review.yml` and the footer name `CLAW_GITHUB_REVIEW_AGENT_NAME`. The platform does not name the clients that call it; `test/github-review-public-tree.test.ts` fails on the product name anywhere else in this feature.

## Risks accepted in this phase

- **The standing authorization is wide.** With the `delegation` flag on, whoever can start a session that
  acts as the committer can have a pull request approved and merged with the committer's account, their
  own included, whenever CI is green and the change is not high risk; the committer is asked only about
  high-risk changes. Which people may ask for someone else's account is for the deployment to decide
  (`CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS` names the services that may), and the committer's own
  switch is what limits it. The rules that call a change high risk are a hold for a human, not a security scan.
- **A held write waits for a person.** A person who is asked by many can have ten high-risk writes
  waiting at once and then every further one is refused until they answer or the cards expire; there is no
  per-requester limit yet.

## What it does not do

It does not edit or push code, request reviewers, resolve another person's thread, re-run CI,
update a branch, use auto-merge, merge with admin rights or change a rule. It reviews only
public repositories of the configured owners. The risk rules are a hold for a human, not a
security scan.
