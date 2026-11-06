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
asked, as long as CI is green and nothing holds it. What holds it is the reviewing model's own judgement
that a person should look (security-sensitive code, credentials, CI or workflow changes, destructive
migrations, behaviour the pull request does not explain, anything it is unsure of), and a short list of
hard holds the model cannot lower (see "High risk"); size, an outside author or a fork are evidence for
the model, not holds. A held approval or merge waits until the committer confirms that very write, signed
in as themselves. The author needs no GitHub
account bound and is not looked at; the committer's account must not be the author of the pull request
(`cannot_approve_own_pull_request`), and without the committer's standing authorization nothing is done
with their account (`delegation_off`).

Two roles run through the rest of this page. The *requester* asks (usually the author of the pull request, and the
owner of the session); the *acting user* is the committer named in `config.acting_as`, whose GitHub account does the
review and the merge and who is the reviewer of record, and whose own standing authorization is what lets someone else ask.

## How a session uses it

1. The requester creates a session with `config.acting_as = "<user id>"` (`POST /v1/sessions`; there only their own id,
   `403 acting_as_must_be_self` otherwise: a review of someone else is asked as below, "A review asked of someone else"),
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
   The creator may also ask for a review only with `config.review_only = true`: `gh_pr_merge` is then
   refused (`review_only`) before anything is read or written, so the session reviews, and may approve,
   but never merges and never approves on the way to a merge; an approval is refused (`review_only`) as well
   while GitHub's auto-merge is on for the pull request, since it could merge it; a merge held for such a session is refused
   at the acting user's allow as well. Like the target it is written only at creation, is `400` without
   `config.acting_as` or when it is neither a boolean nor null (null and absent are false), and a stored value that is
   not a boolean reads as true.
2. From then on every turn of that session is offered an MCP server named `github_review`
   (reserved: a request cannot replace it) with four tools, hosted by the API at
   `POST /v1/internal/github-review/mcp`. Brain calls it with a token signed by the API
   (`CLAW_GITHUB_REVIEW_MCP_SECRET`) that names the session, its owner and `acting_as`; the
   route checks the session row again on every call.
3. The model reviews by the review instructions (below) and posts one review; if it is clean it
   merges. Every gate is in the tool, not in the prompt.

## As an item of the assistant

With `CLAW_ASSISTANT_REVIEW_ITEMS` on (and `CLAW_ASSISTANT_ENABLED`), a review can also be started as a work item of the
requester's assistant, so it is on their board and can be stopped there. The session is the same: it is made by the same
check as `POST /v1/sessions` makes of a session with `config.acting_as` (`github-review/acting-session.ts`), with the same
credentials asked of the caller, and holds the same tools and gates.

| Route | |
|---|---|
| `POST /v1/assistant/reviews` | `{prs: [{owner, repo, number, message?}], acting_as?, acting_as_name?, model?, effort?, review_only?}`: one item per pull request (1 to 10), all of them or none. `review_only` defaults to `true`; `message` is the session's first message, written by Claw when absent. Answers `{items: [{item_id, seq, title, session_id, pr, message_id}]}`, where `message_id` is the turn id of that first message |
| `POST /v1/assistant/reviews/:id/restart` | The same pull request again with what the body changes (`model`, `effort`, `review_only`, `message`); the old item is stopped as a stop would stop it |
| `POST /v1/work-items/:id/stop` | Also denies every write the session holds for an answer, in the same transaction; `409 merge_in_progress` while one is being made, `409 already_merged` after a merge |

Before anything is made: only an identity-provider token (`403 interactive_sign_in_required` / `service_client_not_allowed`);
one open review per pull request whoever asked (`409 review_in_progress`, or `review_in_progress_by_other` without the other
person's item); the hourly limits below, counting the open reviews that have not written yet (`429 rate_limited` with how many
more fit); and the pull request read with the acting user's account (`422 pr_check_failed` with the tool's refusal code,
`503 pr_check_unavailable` for an outage).

The item limits (the owner's unfinished items, and the review-agent limits below) do not refuse a review: an item over one is made
and waits for a slot, answered with `queued: {reason}` (the limit's code, `too_many_active_items`, `too_many_requested_reviews` or
`too_many_from_requester`). Its session gets no message until then; every tick the sweeper starts the waiting reviews of each owner
that now fit, oldest first, and one that would fit while others of its kind wait is queued behind them. A queued review holds no slot,
counts as open for the hourly limits and for one review per pull request, and is stopped like any other. One halted while it waits
(the reviewer's say withdrawn halts every review asked of them) stops waiting: its owner sees the halt, and only a restart runs it. Only past 20 waiting items
of one owner is the limit's refusal answered (`409 too_many_active_items`, with `data.scope` for the review-agent limits).

The item's state is read off the audit and confirmation tables, never from the model: a merge, a queued merge or a posted
review is done (accepted by policy); a write held for the requester themselves, or a closed one that did not write (`stale`,
`expired`, `refused`), a merge refused by a gate, a failed turn or a turn that posted nothing needs them; a write held for
someone else, or being made, is in progress; a denied one is done (stopped). A review session gets no worker report tool.

### A review asked of someone else

When `acting_as` names someone other than the caller (R asks X), the review is X's work, not R's: X's item on X's board, X's
session sealed with X's own keys (so it runs on X's model quota), and R is recorded as who asked. The asking service sends X's
credentials with the request: `x-acting-as-token` (X's delegated identity-provider token, from a client listed in both
`CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS` and `CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS`, `sub` = `acting_as`) and
`x-acting-as-api-key` (X's own `ak-` key, which SaFE must say is X's). Without them, or with anyone else's, nothing is made
(`401 acting_as_credentials_required`, `invalid_acting_as_token`, `key_subject_mismatch`; `403 acting_as_mismatch`,
`acting_as_not_delegated`, `service_client_not_allowed`).

- X's switch that lets others act for them is asked of the identity service when the review is asked (`403 delegation_off`,
  `actor_not_bound`, `credential_expired`; `503 delegation_unavailable`) and again before every queued turn of it. Turned off, the
  review is not run, it goes to X as failed with the reason, and X's keys are removed from every open review others asked of X.
- The session config carries `requested_by: {user_id, label}` and `sandbox_profile: "review"`, written only by the server;
  `POST /v1/sessions` refuses both (and `requester_note`) as server-managed, and refuses `acting_as` naming anyone but the caller
  (`403 acting_as_must_be_self`), whether or not these routes are on. The review tools take `requested_by` as the requester only when the
  session's owner is the acting user; for every other session the requester is the owner.
- The session runs with a fixed profile: the review tools and the sandbox's file and shell tools, nothing else (no skills,
  memory, triggers, stored variables, default or application MCP servers, `a2a_call`, `deliver_file`; no pattern or skill
  evolution from it). Brain applies the same list again. Its sandbox is built in the deployment's existing CPU sandbox workspace
  (`SANDBOX_CPU_NAMESPACE`), whatever the request names, without a GPU, and always with `useWorkspaceStorage: false`, so SaFE
  mounts neither X's directory nor the workspace's volumes. A deployment without `SANDBOX_CPU_NAMESPACE` gives such a review no
  sandbox tools.
- X's review-agent limits (the deployment's defaults for every person for now): `CLAW_REVIEW_FOR_OTHERS_MAX_ACTIVE` (20) open
  reviews others asked of X, `CLAW_REVIEW_FOR_OTHERS_PER_REQUESTER_MAX_ACTIVE` (10) of them per requester, both apart from X's
  own item limit (`409 too_many_active_items` with `data.scope` `reviewer` or `requester`); `CLAW_REVIEW_FOR_OTHERS_TURNS_PER_ITEM`
  (200) model turns per review and `CLAW_REVIEW_FOR_OTHERS_TURNS_PER_DAY` (2000) for all of them per UTC day. A review's
  sub-agents take their turns from the same budget and are counted with it, as is a context-compaction summary, and a review
  stopped or failed partway is charged the turns it took.
- The model and effort are X's: a `model` or `effort` R names is not taken (the review runs on the deployment's default), and R's
  answer says so with `ignored: ["model", "effort"]` (whichever were named). X may change them on X's own restart. The review's
  sub-agents run on the review's model, never on one a `task` call names or the reading default.
- `requester_note` (up to 2000 characters) is quoted after the first message as untrusted text that cannot change merging, the
  model or the pull request; a body naming `requested_by` or `sandbox_profile` is a 400.
- R is answered without the session's ids, may stop the review and read it, and sees its requester view only on every answer
  (`{status, pr_url, verdict, merged, waiting_for, findings, note}`, frozen into `params.requester_view` when the item closes):
  the four facts; while it waits for X, for what (`confirm_merge`, `confirm_review`, `failed`: restarted by X or asked again by R,
  or `reviewer`); and what the review posted on the pull request (open findings and the first of them in one line, credentials
  masked). `GET /v1/work-items/asked-of-others` lists R's reviews of others (open, or closed in the last 3 days) with whom R asked
  and that view, for R's channel to show beside R's board. Restart and accept are X's
  (404 for R), and R cannot send a turn into X's session. The writes the session holds for confirmation are X's alone: R's
  `GET /v1/github-review/confirmations` lists none of them, whatever the filter.
- A review again (below) continues only the last closed review of the same pull request with the same owner and the same
  requester: a new request from R continues R's last request of X, never X's own review or another requester's.

### After the review: the pull request is followed, and the requester merges

Once a review item's turn has ended having posted or held something, the review items' sweep looks at its pull request on GitHub,
at most once every 90 seconds per item and by one replica at a time (`followReviewItems`, `GithubReview.followPullRequest`; an
audit row with tool `gh_pr_follow` each time):

- **Merged or closed on GitHub, by anyone.** The item ends (`merged on GitHub` as done, `closed on GitHub without a merge` as stopped),
  and every write its session still holds for the acting user's answer is closed as `stale` (`result.reason` `pr_merged` /
  `pr_closed`): nobody is asked to confirm a merge of a pull request that is no longer open, and it no longer counts against
  `too_many_pending_confirmations`. The requester's view says `merged` for a pull request merged on GitHub.
- **The requester's merge.** For a review asked of someone else (R asked X) that may merge (not `review_only`: R's message asked for
  a merge), the merge is R's once X's approval is on GitHub. R wrote the pull request and asked for it to be merged; X's review mode and
  X's held merge govern what is done with X's account, not what R does with R's own. So the sweep merges it **with R's own GitHub
  account** (R's own credential: nobody's switch is asked), instead of waiting for X to confirm a held merge, when every one of these
  holds, read at that moment: the pull request is open and not a draft; R's account is its author and may push; this review session
  posted an approval of the current head with X's account (the review id on its own audit row), and GitHub still has that review as
  `APPROVED` on that commit (a push or a dismissal takes it back); CI is green on the head, no review thread is open, and GitHub's merge
  state is `CLEAN` (a merge queue: it is queued as R, never merged directly; a pull request someone already queued is not written to, and X's held merge of that head is closed as `stale`, `pr_queued`); and nobody is answering X's held merge right now (X's
  answer, or X's write lock on the pull request, goes first). The merge is pinned to the head (`sha`), counts against the hourly write
  limits, and is made only with `CLAW_GITHUB_WRITES_ENABLED`. X's held merge for that head is then closed as `merged` (or `queued`),
  decided by R (`decided_via: {"kind": "requester"}`, `result.by: "requester"`), so X's card or `批准 #<ref>` for it answers that it no
  longer waits, and the item ends as merged by the requester's account. A merge GitHub refuses gives X's held merge back to X, still
  pending. When a gate is not open yet (CI still running, a thread open, `BEHIND`) nothing is written and the sweep looks again later.
  R without a bound GitHub account (or a lapsed one) is not merged for: the pull request is read with X's account, as the review read it,
  for the merged-or-closed check only.
- A review only, and the acting user's own review, are only read, with the acting user's account (their switch still counts).

`POST /v1/assistant/reviews` answers `merge_by_requester: true` on each item of a review asked of someone else that may merge, so the
channel that started it can tell the requester how the merge will be made.

### A review again: it continues the last one

A posted review of an item's session is recorded on its audit row (`claw_github_audit.posted`: the event and each inline finding
with the thread GitHub opened for it), and the item keeps the result in `params.record`: the head reviewed, the verdict, the
model and each finding with its thread and whether it is resolved. Nothing of it comes from the model. A restart, or a new
request for a pull request whose last item of the same requester is closed, makes a fresh session that continues that record
(`params.continues`): its first message names the open findings by number and thread id, to check first (their paths and
what they said are under `untrusted.previous_findings`, since the first message is the person's), and `gh_pr_get` answers with
a `continuation` block whose `scope` the code decides:

| `scope` | When | What `files` and `diff` hold |
|---|---|---|
| `unchanged` | The head is the one reviewed last time | Nothing: only the findings are checked |
| `delta` | GitHub's compare of the two heads says `ahead`, within the review path's size limits, and touching no security or CI path | The change since the last head |
| `full` | `history_rewritten` (force push or rebase), `base_merged` (the base branch merged into the head since, as "Update branch" does: a merge commit, or a changed file the pull request does not change), `large_delta`, or `security_path` | The whole pull request, as a first review reads it |

On the deep review's sandbox path, `review_path.advice` of a `delta` or `unchanged` re-review says so too: the checkout is
for reading around the change and running tests, and its whole-pull-request diff is not reviewed again. The risk, the holds
and every gate of a write stay those of the whole pull request. Such a session is also offered
`gh_thread_resolve(pr, thread_id, head_sha)`, which resolves the thread of a fixed finding: only a thread the last review
recorded (`thread_not_recorded`), opened by the acting user's own account (`not_own_thread`), on this pull request
(`thread_not_on_pull_request`), at the head the session read (`head_moved`), and not after the requester stopped the review
(`review_stopped`), and not while GitHub's auto-merge is on, or the pull request is in the merge queue, for a session that may not merge by itself (a review only, or one the
assistant started; `auto_merge_on`), since resolving the last open conversation can be what merges it. It is not counted in the
hourly review limits. With review items on, every review (not only an approval)
and every `gh_thread_resolve` takes the acting account's write lock on the pull request, which a restart takes too: one still
being made when its item is restarted holds the restart (`409 merge_in_progress`), and one that comes after it is refused
(`review_stopped`).

### From the assistant's conversation

With `CLAW_ASSISTANT_TOOLS=on` as well, the assistant's router can start, restart and answer reviews from what the user says
(`assistant/review-tools.ts`): `review_start`, `review_restart`, `confirmation_answer`, `review_mode_set` (only towards
`high_risk_confirm`; turning confirmations off stays the user's own setting) and `channel_action` (a setting the user's channel
listed with the message). `work_stop` stops a review item; `work_send` refuses one.

They act only for the person, never for a key or a report:

- **Attended.** The turn must answer a message the route recorded as carried by an identity-provider token (the same reading as
  answering a held merge), received at most `CLAW_ASSISTANT_ATTENDED_TTL_SEC` (default 600) seconds before the tool is called.
  A turn started by a worker's report, or by a message sent with a key or a browser session, is refused (`not_attended`).
- **Grounded.** A pull request's number must be in that message; its repository named there, or, when the message names none,
  the only repository it can be: the channel's own (`channel_context.repos`), else the one the user's recent reviews used (two
  candidates and a bare number are refused, so the assistant asks); a model named there; a reviewer the user themself or someone
  the channel listed with a Claw `user_id` (`channel_context.people`) whom the message names by a handle of theirs alone among those
  listed: their name with its words in any order, run together or not (`Wei, Lei`, `lei wei`, `weilei`), a word of it, their user id,
  their email or its part before the `@`, or one of the `aliases` the channel gave (a GitHub login, a chat user name). A handle two
  listed people share, or one inside another's longer name (`王一涵` in `王一涵娜`), names neither: nothing starts, and the assistant
  offers each person the message may mean (never the user) as the exact reply that picks them (`确认 Wei, Lei`; with what tells them
  apart in brackets when two share a name, `确认 Alex Chen (achen2)`). A message that is that reply and nothing else, sent within ten
  minutes of the request, starts that request with that reviewer; a sentence that only starts with 确认 is a request of its own.
  A message longer than 8 KiB is not read for a name at all: it names nobody, and gets the same offer.
- **`merge=true` never merges.** Whether the user asked for a merge is the router's reading of a sentence, and natural language
  never approves one. So every review the router starts or restarts (`review_start`, `review_restart`, whatever `merge` says) is
  made with `config.merge_needs_confirmation` (kept by every later restart of it): its `gh_pr_merge`, and a `gh_review_submit`
  `APPROVE` while GitHub's auto-merge is on or the pull request is in the merge queue, are held for the acting user (`confirmation_required`) whatever the risk and their
  review mode, and it resolves no thread while auto-merge is on or the pull request is in the merge queue (see `gh_thread_resolve`); the merge is made only from that confirmation: the card's button or the exact command below, by the acting
  user. `merge=true` only lets the review go on to ask for that confirmation after its verdict; `merge=false` is a review only.
- **Two acts are never read from a sentence.** A held write is let through only when the user's whole message is the approval
  command `批准 #<ref>` or `approve #<ref>` (case, spacing, a full-width `＃` and closing punctuation aside), where `<ref>` is the
  first six hex digits of its confirmation id (the assistant shows it; the whole id also works), and only for a write that was
  waiting when they wrote; any other yes is refused (`not_an_approval_command`), and the card's button works as before. Saying
  no (deny) is still read from the user's words. A channel action runs at once (an `assistant.action` event) only when the
  user's message is its command typed whole (`/brief off`, with the arguments the call carries); anything else is put to the
  user as an `assistant.say` that names the exact command and carries it as `confirm_action` (`{name, args, message_id,
  channel_message_id}`), for the channel to draw as a button that runs it only when the user presses it. A channel that
  draws no button shows the text, which tells the user to type the command.

The review is then made by the same `startReviews` / `restartReview` as the routes above, with the person's message standing
for their sign-in, so every check above applies unchanged. Their `guard` (the turn is still live and still answers that message) is
asked in the transaction that writes, once the owner's assistant row is held and before the open reviews and limits are counted again.

A review asked of someone else meets the assistant in three places:

- `review_start` naming another person (`reviewer`) cannot start it here: such a review runs on the reviewer's own credentials,
  which only the asking service brings (`x-acting-as-token`, `x-acting-as-api-key`), and the assistant holds the requester's keys
  only. When the channel that carried the message declared it can be handed one (`channel_context.handoffs` holds
  `review_for_other`) and the user has a subscription to `assistant.action`, the call is handed to that channel as typed data, after
  the same grounding (the reviewer is someone the channel listed, each pull request one the message names, the person is here): an
  `assistant.action` with `action.name` `review_for_other` and `review: {reviewer: {user_id, name}, prs: [{owner, repo, number}],
  merge, requester_note}` (the person's own message), once per message, reviewer, pull requests and merge. The router is answered
  `handed_off` and told that nothing has started yet; the channel starts the review with `POST /v1/assistant/reviews`, the reviewer's
  credentials and `handoff_id` (the `review.handoff_id` it was handed), and answers the person's message about it itself, in one
  message: whether it started, on which model, and how its merge is made, read from what the route answered (each created item's
  `review_only`; `merge_needs_confirmation` is absent, since the reviewer's own review mode decides) and the reviewer's review mode. The
  router says nothing about it: from the handoff on, a `say` in that turn is refused (`handed_off`), and neither the turn's plain text
  nor a notice that the turn failed is delivered for it (the handoff record keeps the turn's `message_id`). The route applies its
  own checks (the reviewer's delegation, the open reviews, the limits) and, beyond them, the record Claw kept of the handoff
  (`claw_assistant_review_handoffs`), not the channel's body: the review only reviews when the router read no merge. When it may merge,
  it merges as the reviewer's own review mode says, exactly as a review the person asked of them in the chat: under `high_risk_confirm`
  a high-risk approval or merge waits for the reviewer's confirmation, under `fully_auto` only what the repository itself requires does.
  A `handoff_id` must be the caller's handoff to that reviewer, cover the pull requests asked, be under 24 hours old and unused (one start
  per handoff; a replay is refused `handoff_used`). A request that leaves `handoff_id` out is an ordinary request of the reviewer,
  whatever was handed over before.
  The reviewer must also be named in the person's own message by something no other listed person shares (their name, a part of it,
  their email or the part before its `@`, their user id), not only listed beside it (`reviewer_not_named`). `channel_action` never sends an action named `review_for_other`. Otherwise (a channel that did not declare it, or no channel takes actions) it is refused with
  `acting_as_credentials_required`, and the refusal tells the router to send the user to the deployment's review agent, by the name
  its reviews are signed with (`CLAW_GITHUB_REVIEW_AGENT_NAME`).
- The requester's assistant lists the reviews they asked of others, open or closed in the last day, read-only after their own items:
  the item_id and the four facts (`params.requester_view` once closed), nothing else. `work_recall` on one answers the same four facts
  whatever detail is asked, and does not count as reading what a worker wrote. `work_stop` on one stops it as the requester's
  `POST /v1/work-items/:id/stop` does, only in a turn that answers the requester's signed-in message naming its pull request, and
  answers the four facts, frozen into the item as it closes.
- A held write of a stopped review is denied as stopped (`review_stopped`) only while it still waits; one already answered (an approval
  submitted before the stop, a merge being made) keeps its state, and a later answer to it says how it ended.

## The tools

| Tool | What it does |
|---|---|
| `gh_pr_get` | The pull request, its files and diff, CI, review threads, existing comments, the risk evidence and hard holds for the model's `risk_judgement`, what the acting user may do, the review path (below) and the review instructions. Text that came from the pull request is under `untrusted`. Call it first. Every answer fits under Brain's cut of this tool's results (24000 characters; 6000 for other tools), at most 23000 characters: the first is the overview, and what does not fit in it (`instructions`, `files`, `diff`, `conversation`) is read whole in pages, with `section`, `head_sha`, `read_id` and `offset` from each page's `next_offset` (on the deep review's sandbox path, `how_to_read` says the diff is read once from the checkout instead, and paged only if the checkout fails). Brain must be deployed before the API: an older Brain cuts a page at 6000 characters. Offsets are the whole diff's, with or without `file`; an offset past the end, or a `file` that is not in the change, is refused (`offset_out_of_range`, `unknown_file`), never answered with an empty page. A page is served from what the session read of that head and costs one GitHub request, which re-checks the repository gates, the head and the base branch; when the base branch has moved, the pull request is read again and the page is served only if it still reads the same (`read_id`), else refused with `read_changed`. |
| `gh_pr_risk` | Whether an approval or a merge would be held, and why, for the `risk_judgement` and `risk_flags` (`security_finding`, `review_skipped`) the model passes (see High risk): the judgement decides, except for the hard holds, and none holds. |
| `gh_review_submit` | One review on the pinned head commit (the model may pass the same `risk_flags` as to `gh_pr_risk`, and they count for an `APPROVE`), with inline comments that must sit on lines the diff shows. `COMMENT`, `REQUEST_CHANGES` or `APPROVE`. A body footer says `Reviewed by <agent name> on behalf of <login> (requested by <name>), run <id>` (the agent name is `CLAW_GITHUB_REVIEW_AGENT_NAME`, default `Claw`) and a hidden marker (the run, the event and a digest of the text and inline comments) keeps a retry of the same review from posting twice, while a different review of the same kind on the same commit is posted. An `APPROVE` the model judges high, without a judgement, or with a hard hold is held until the acting user confirms (below). |
| `gh_pr_merge` | Approves when needed and merges, if every gate is open. On a base branch that is merged through a merge queue it puts the pull request in the queue instead of merging it (`queued`, below). A merge the model judges high, without a judgement, or with a hard hold is held until the acting user confirms. |

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
- **Standing authorization and the hold.** With the acting user's `delegation` flag on, a `COMMENT`, a
  `REQUEST_CHANGES`, an `APPROVE` and a merge are made at once, whoever asked, when nothing holds them. An
  `APPROVE` review and a merge that are held (the reviewer's judgement, its flags and the hard holds, see
  "High risk") stop at `confirmation_required` and write nothing, with the reasons in plain words (the
  reviewer's own first), until the acting user has confirmed that very write; a comment or a request for
  changes on the same change is posted as ever. The confirmation holds the review as it will be posted
  (event, text, inline comments), so what the acting user reads is what goes out; the gates of the write
  are read again when they allow it. A repository's configuration cannot switch it off; the acting user's
  own review mode (next item) decides what holds. A held approval is posted alone: to approve and merge in
  one confirmation, a model calls `gh_pr_merge`.
- **The acting user's review mode.** How a held write is confirmed is the acting user's own setting, kept
  in Claw by their user id (`claw_github_review_settings`, see "Review mode" below). It applies to every
  review and merge made with their account, whoever asked, the acting user themselves included:
  - `high_risk_confirm` (the default, and what a person who never set one has): an `APPROVE` or a
    merge is held as "High risk" says, for the reviewer's judgement, its flags or a hard hold;
  - `fully_auto`: nothing is held except what the repository itself requires (`risk.repo_holds`: its
    configuration's `confirm_merge: always` or a `high_risk_paths` match, a configuration that does not
    parse, rules that failed), a change to the instructions the reviewing model reads (or not being able
    to tell), a file list cut at GitHub's 3000 files, and an earlier write of the same commit that still waits for the person, is
    being decided by them, was refused by them, or was held and never answered. The other
    gates (CI green, no open thread, merge state `CLEAN`, not the author, delegation, the head commit)
    stand as ever.

  It says nothing about who may ask: that stays the `delegation` flag (others may ask only when it is on).
  `gh_pr_get` (`acting.review_mode`,
  `risk.review_mode`, `risk.repo_holds`) and `gh_pr_risk` show the mode in force, the audit row records it
  (`review_mode`), and an approval or a merge made under `fully_auto` answers `review_mode_note` ("made
  under <login>'s fully automatic setting: nobody was asked to confirm it") for the report to repeat.
- **Merge queue.** A base branch that is merged through a merge queue refuses a direct merge, so there
  `gh_pr_merge` does not merge: after every gate of a merge has passed and the approval is on the pull
  request (or the acting user has allowed a held merge), it puts the pull request in the queue with the
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
  an approval that is held (see "High risk": the model's `risk_judgement` and `risk_flags`, or a hard
  hold) is then held for the acting user (`confirmation_required`, `kind: "review"`). `COMMENT` and `REQUEST_CHANGES` are not held to that.
- **The merge.** Everything is read again at merge time: CI is green on the **head commit**
  (every check completed and passing; a required check that never reported is missing; a pull
  request with no check at all is not green however clean GitHub calls it; an infrastructure
  failure is a failure; nothing is re-run), no review thread is unresolved, GitHub's own merge
  state is `CLEAN` after the approval (GitHub works the state out asynchronously, so an `UNKNOWN`,
  and a `BLOCKED` right after this call's own approval, is looked at again for about seven seconds, one
  request a look, with CI read once more before a merge that had to wait, before the merge is refused as `merge_state_not_clean`), and the repository's own
  protections are met because they are GitHub's. No admin merge, no auto-merge, no branch update, no change to a rule.
  The method is the repository's first allowed one, squash first.
- **High risk.** Whether an `APPROVE` or a merge is held for the acting user's own confirmation is
  decided in `packages/api/src/github-review/risk.ts` (`assessRisk`). Under the acting user's default review
  mode, `high_risk_confirm` (under `fully_auto` see the item above), it is held when
  1. the reviewing model's `risk_judgement` on `gh_review_submit` / `gh_pr_merge` is `high`; or it is
     missing or malformed (fail closed); or the model passed a `risk_flags` (`security_finding`,
     `review_skipped`); or
  2. a **hard hold** applies, which no judgement lowers: the repository's own configuration on the base
     branch asks for it (`confirm_merge: always`, or a changed path matches its `high_risk_paths`), or
     that configuration does not parse; the change touches a file that controls the repository
     (`.github/workflows/`, `.github/actions/`, `.github/scripts/`, `.gitlab-ci.yml`, a `Jenkinsfile`,
     `azure-pipelines`, `.circleci/config`, `CODEOWNERS` at the root, under `.github/` or `docs/`,
     `.github/claw-review.yml` or the same file under its earlier name), including a file moved out of
     one; the change touches the instructions the reviewing model reads (`repo-skill.ts`
     `isReviewInstructionPath`: a review skill directory under `.claude/skills/` or `.agents/skills/`,
     the root `AGENTS.md`, `.github/copilot-instructions.md`), which holds under `fully_auto` too. That
     check does not rely on the file list: the base and head commits' whole trees are read (two requests,
     `GET /git/trees/{sha}?recursive=1`) and every such path that was added, removed, edited, moved or
     given another mode counts, however many files the pull request changes. A tree GitHub cut (a very
     large repository) or could not give holds as well, with that reason. The file list itself is read up
     to GitHub's limit of 3000 files, 100 a page, each page counted against the session's request budget
     (`CLAW_GITHUB_REQUESTS_PER_SESSION`; a read that would pass it stops as `request_budget_exhausted`);
     a pull request with more files is cut, "too many files changed to see them all", which holds under
     `fully_auto` too; or the rules themselves fail.

  Nothing else holds. The rule pack below (version `2026-11-03.1`) is **evidence**: `gh_pr_get` and
  `gh_pr_risk` give it to the model as `risk.evidence`, with `risk.hard_holds`; the `risk_judgement`
  field's description (on every tool that takes it) and the review instructions carry the guidance, the
  instruction to hold for security-sensitive code (authentication, authorization, permissions,
  cryptography, sandboxing), credentials or secrets, CI, workflow, release or deployment changes,
  permission or access changes, destructive or irreversible data migrations, a change of an interface or
  behaviour others rely on that the pull request text does not explain, and anything it is unsure of,
  and to judge low otherwise. Size, an author outside the organisation (`CONTRIBUTOR`, `NONE`), a fork
  and a base branch other than the default are evidence, not reasons by themselves: the person who asked
  is very often the author, and a rule that held every large change by a contributor held nearly every
  approval. The rule pack reads what the change **does**, from its diff, not which kind of file it
  touches. It flags a change that is
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
  than 4000 characters (minified or generated code) is reported as evidence rather than scanned, and so is a change
  with more than 20 000 changed lines or two million characters, which is not read past that point.
  Every pattern that reads a line runs in time linear in its length (the author of a pull request
  may be outside the organisation, and the rules run in the API's own process:
  `test/github-review-redos.test.ts` times each language on adversarial lines). What it cannot see (a
  field added to an exported type, a parameter on a wrapped signature line, a behaviour that changed
  under an unchanged name) is for the reviewer's own judgement (below).

  Under the content rules sits a **floor** of evidence that reads no content: a file
  that came without its diff (GitHub sends none for a binary, a rename or a diff it finds too large,
  and counts a modified or renamed binary as 0 lines, so the missing patch is the signal), a lock
  file (it decides what an install downloads), a submodule pointer, a file mode change, a file list
  that was cut, a fork, a non-member author, a base branch other than the default, an
  authentication module, a workflow, a Dockerfile, a chart or a release script that is edited at
  all (a line shaped like a comment does not take it below the floor: the content rules can only
  add), and a file tracked by Git LFS (GitHub sends its pointer, `version`, `oid sha256:` and `size`,
  as an ordinary text patch with real line counts; that is a diff that did not show the file, and
  is treated like a binary's). A file that was moved is judged by the path it left as well
  as the one it went to, and a line that starts with `++` or `--` is read like any other. A
  repository's `.github/claw-review.yml` on the base branch can add paths (`high_risk_paths`) or ask for
  confirmation on every merge (`confirm_merge: always`); both are hard holds.

  **The reviewer's judgement.** `gh_pr_risk`, `gh_review_submit` and `gh_pr_merge` take
  `risk_judgement: {level: "low" | "high", reason}`. A `high` holds the APPROVE and the merge, and its
  reason comes first on the confirmation the acting user is shown and in what the model reports (one
  clipped line, markup stripped, the token masked). A `low` lets them through the other gates unless a
  hard hold applies; its reason is not shown as a reason to hold. No judgement, or one that is not
  `low` or `high`, holds. `gh_pr_risk` answers `risk.level` (held or not), `risk.reasons` (why, in plain
  words), `risk.judgement` (`low`, `high` or `missing`), `risk.hard_holds`, `risk.evidence`,
  `risk.rule_level` (whether the rules saw anything) and `risk.categories` (`architecture`, `interface`,
  `security`, `ci_release`, `dependency`, `size_breadth`, `integrity`, `provenance`, `reviewer`);
  `gh_pr_get`, before any judgement, gives the evidence and the hard holds. The audit row
  keeps the reasons and the evidence (marked `evidence:`). A `low` without a reason is no judgement.
  An approval or a merge of a head commit for which an earlier approval or merge already waits for the
  acting user, is being decided by them, was refused by them, or was held and never answered (an expired
  confirmation: asking again until a judgement says low does not get past it; a new head commit does), with
  the repository name compared without case, is held too, and `gh_pr_risk` says so, whatever the later call says: a lower judgement on a
  second call, or the other of the two tools, does not get past their decision. Calls in parallel take
  turns: an `APPROVE` or a merge decision holds a lock on the acting user's writes to that pull request
  (`claw_github_write_locks`, across replicas, renewed while the call works and lapsing two minutes after
  a call that died), and a second one meanwhile is
  refused at once as `write_in_progress`, with nothing written, to be made again.

  A merge or an approval that needs confirmation creates one pending row for the head commit and
  writes nothing.

## Review mode

| Route | What it does |
|---|---|
| `GET /v1/github-review/settings` | The caller's own review mode: `{ok: true, data: {review_mode, updated_at, review_modes}}`. `review_mode` is `high_risk_confirm` or `fully_auto`; with nothing set it is `high_risk_confirm` and `updated_at` is `null`. `review_modes` lists the values. Any signed-in caller; `401` without one |
| `PUT /v1/github-review/settings` `{review_mode: "high_risk_confirm" \| "fully_auto"}` | Sets the caller's own review mode and answers as `GET` does. Given as a decision is (next section): the person's own identity-provider token, or the exchange token of a service an operator named in `CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS`; an `ak-` key, a BYOK key, a connector token or a cookie is `403 interactive_sign_in_required`. Another value is `400` |

Neither route names a user: what is read or set is always the caller's own, so nobody can change another
person's mode. A chat integration sets it when the person binds GitHub and whenever they change it. It is
independent of `delegation` (whether others may ask), which stays at the identity provider.

## Confirmations

| Route | Purpose |
|---|---|
| `GET /v1/github-review/confirmations?session_id=<id>&status=pending` | The confirmations that ask the caller (the acting user) and those the caller requested in a session they own. A review someone else asked of the acting user runs in the acting user's session: its confirmations are listed to the acting user only, never to who asked, who reads the item's four facts instead. `{items:[{id, kind, review, repo, pr, title, author, head_sha, reasons, checks, actor_user_id, requester_user_id, session_id, expires_at, status}]}`. `kind` is `merge` or `review`; for a `review`, `review` is `{event, body, comments: [{path, line, side, body}]}` as it will be posted (without its footer), and `null` for a merge. `status` is `pending`, `merging`, `merged`, `queued`, `submitted`, `denied`, `stale`, `expired` or `refused` |
| `POST /v1/github-review/confirmations/:id/decision` `{decision: "allow" \| "deny"}` | The acting user's answer, given with an identity provider's access token: their own sign-in at the provider, or an allowed service's (next section). Anyone else gets `403`, and so does the acting user with an `ak-` key (`Authorization: Bearer` or `x-api-key`), a BYOK key, a connector token or a browser session cookie, whatever the id (`403 interactive_sign_in_required`; the check is on how the request was authenticated, before the confirmation is looked up). The sandbox of an ordinary session holds its owner's key, and with SaFE's built-in sign-in that key sets the owner's password and logs in, which returns a session cookie the API verifies as the person's own: so neither a key nor a cookie is proof of a person, and a model in any session of that user could otherwise answer a confirmation itself. On `allow` every gate is read again and the held write is made with the acting user's account; the answer is `{status: "merged" \| "queued" \| "submitted" \| "denied" \| "stale" \| "expired" \| "refused" \| "retry", reason, merge_sha, queue_entry_id, queue_position, queue_state, review_id, url}` (`merged` for a merge, `queued` for a merge that put the pull request in the base branch's merge queue, which is not yet merged, `submitted` for a review). `retry` means the write could not be tried just now (the identity service or GitHub failed, a limit was hit) before anything was sent to GitHub, and the confirmation is still open: allow it again. Once a review, an approval or a merge has been sent the try is not given back: the confirmation is closed as `refused` with `wrote: true`. The write is recorded as asked for by the requester, not by the acting user. A service an operator named may answer for the acting user too (next section) |

A browser session cookie would be taken again only where the platform that issues it refuses to set a
password with an API key; that is a change to Primus-SaFE, not something this code can check, so until
it is made the identity provider (or an allowed service) is the only way to answer.

A confirmation lives 24 hours (`CLAW_GITHUB_CONFIRMATION_TTL_SECONDS`), is bound to the head
commit (a head that moved makes it `stale`) and is used once. There is one pending confirmation for a
head commit and a write: asking for the same merge, or posting the same review, again shows the same one,
while a merge and a review, or two reviews that say different things, are different confirmations. One
acting user is asked about at most thirty writes at a time (`too_many_pending_confirmations`); a held write whose pull request
is merged or closed on GitHub stops counting as soon as the review items' sweep sees it (above, "After the review").

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

**The deployment's platform defaults are not given either.** The default MCP servers
(`PLATFORM_DEFAULTS_FILE`) are called with the requester's own key, and the model of such a session can be
steered by what a pull request says, so a default server's read tools would answer it as the requester. A turn marked
`withhold_sandbox_keys` is given no default MCP server and no default skill, on every path above; it has the review
tools and whatever its own request names. See `platform-defaults.md`.

**The requester's long-term memory is not given either, in either direction.** The model of such a session reads what
strangers wrote and its answer is posted publicly, so the requester's remembered entries and profile are not put in its
prompt (nor the notice that memory is off), and it cannot write to that memory, which every later session of the requester
reads: Brain does not offer `save_memory` to a turn marked `withhold_sandbox_keys` (whatever `memory_enabled` says; a
sub-agent starts from its parent's tools and has none), and a completion of the session drops `memories_to_save` and does
not extract memory from its conversation. It is decided from the session's row, as the mark is; a session whose row cannot
be read is treated as one that withholds, so memory is not used and the turn is not failed. With
`CLAW_GITHUB_REVIEW_ENABLED` off such a session is an ordinary one.

## Review path: the diff or a sandbox

A sandbox costs a cold start of about 16 seconds. A small change (at most
`CLAW_GITHUB_REVIEW_FAST_MAX_CHANGED_LINES` lines, default 600 with the deep review off, in at most
`CLAW_GITHUB_REVIEW_FAST_MAX_FILES` files) needs none: `gh_pr_get` returns the diff, the file list
and the metadata, and says `review_path.path = "api_diff"`. A sandbox is allowed (`"sandbox"`) when
the change is large, GitHub did not send the diff of some file (a binary, a rename or a diff too
large, whatever the line counts say), the file list is incomplete, or the repository has a review
skill of its own, which may use scripts.

### The deep review

`CLAW_GITHUB_REVIEW_DEEP_ENABLED` (on by default) reviews in depth. Set to `false`, the model is
given the instructions, the advice and the thresholds above, word for word what it was given before
the switch existed. On, the diff-only path is kept for a small change that touches no source code
(documentation, configuration, tests; the line threshold defaults to 200), and every other change
is reviewed with a sandbox that the instructions require: a non-test source file changed
(`source_change`: a code, shell, SQL or interface-schema (`.proto`, `.thrift`, `.graphql`) file by extension, outside
`test/`, `tests/`, `__tests__/`, `spec/`, `fixtures/`, `testdata/`, `e2e/`, `*.Tests/` and not named like a test,
`*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`), or one of the reasons above. On that path the
model checks the pull request out, reads the callers of every
changed function and export and the code around them, and runs the tests closest to the change
(the repository's documented test command, scoped, each command under `timeout 600`, after
building what those tests import the documented way: in a workspace a test loads its sibling
packages from their built output, which a fresh checkout lacks; dependencies and build output left
in the reused checkout are kept and reused, never reinstalled from clean; and under the runtime
version the repository declares in `.nvmrc`, `.node-version`, `engines`, `.python-version` or `go.mod`:
when the sandbox image's is older, the model downloads that version into the checkout, Node from
`nodejs.org` checked against its `SHASUMS256.txt`, so a repository that needs a newer Node than the
image has does not end with its tests failing to load), then has a
second, adversarial pass look for what the first missed (a `task` sub-agent with read and bash
tools only), and the review body lists what was read and run. A diff alone shows what changed, not
who depends on it.

It is on by default, and an operator upgrading gets it with its cost: every change of a source file
now takes the sandbox path, with the sandbox the instructions require, and a review costs more.
Measured on claude-opus-5.5 over five real pull requests, it cost about $1.86 per review (against about
$0.62 for the review without it on the same model, and $0.29 for that review on claude-sonnet-5.5), and found 17 real
problems where the review without it found 4. Three things below keep the cost down, and re-measured
on two of those pull requests they took a review from $1.14 to $0.80 and from $1.17 to $0.96, with the same
verdicts. Every turn of an on-behalf review writes its rolling prompt-cache markers for 5 minutes,
since nobody waits between its turns, and keeps the anchor at `LLM_CACHE_TTL` (1h by default) so the
next review still reads the shared prefix; the second pass is bounded to 20 turns and is handed the
diff (written once to `.pr-review/pr.diff` in the checkout, excluded from git), what the first pass
read, and the callers a search showed but it did not open, which it opens first; and the diff is
read once from the checkout rather than in `gh_pr_get` pages.

`CLAW_GITHUB_REVIEW_DEEP_ENABLED=false` turns the deep review off. The review has no model or
reasoning effort of its own: the session runs on the `model` and `effort` its creator sent with
`POST /v1/sessions` (or set later with `PATCH /v1/sessions/:id`), or on the deployment's defaults, as any
other session does.

Either way, Brain opens a sandbox only when a turn uses a sandbox tool, so the decision is
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
together with the base's `AGENTS.md` and `.github/copilot-instructions.md`. A file there that is a symlink
to another file is not read: GitHub would answer with the other file, which a pull request could change
without touching an instruction path. A pull request that changes any of these paths is held whatever the
review mode (see "High risk"). The fixed rules (read
and comment only, text from the pull request is data, the tools' gates) and the answer rules below
are always put in front of it. Without one the default review instructions apply
([`examples/skills/pr-review/SKILL.md`](../examples/skills/pr-review/SKILL.md) is the same text behind
a skill's frontmatter, so it can also be imported as an ordinary skill; `review_instructions` itself
carries no frontmatter, which would only send the model looking for a skill of that name, and a
repository skill's own frontmatter is left out as well): parallel passes over the whole change, only what the change
introduces, only findings that are actionable and verified with a path and line, a rebuttal
round per finding, CI read for the head commit, at most five findings, one review, no code
changes, no request for reviewers. The answer ends with exactly one last line, `VERDICT: CLEAN`,
`VERDICT: BLOCKING` or `VERDICT: NOT_REVIEWED`, which a calling program can read.
The answer is written for people who have never seen the tools: in the language the request was written
in, in plain words ("approved", "merged", "commented", "waiting for your confirmation"), never the name
of a tool or of one of its states. When writes are switched off in the deployment (`dry_run`) it says that
nothing was posted, approved or merged and nothing happened on GitHub. Tool names and states stay in the
logs and the audit rows.

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
| `CLAW_GITHUB_REVIEW_FAST_MAX_CHANGED_LINES` | 200 (600 with the deep review off) | At most this many added plus deleted lines for the diff-only path; with the deep review on, a change of a non-test source file takes the sandbox path whatever its size |
| `CLAW_GITHUB_REVIEW_DEEP_ENABLED` | on | The deep review ("The deep review" above): a required sandbox for source changes, the callers read, the closest tests run, and a second adversarial pass. `false` (or `0`, `no`) gives the review as it was before the switch. Another value than `true`/`1`/`yes`/`false`/`0`/`no` is reported and leaves it on |

The identity provider must give the API's own client the `identity.credential.resolve` scope
(see [identity-client.md](identity-client.md), external credentials). Without a bound credential
for the acting user a tool answers `actor_not_bound`; an expired one `credential_expired`; an
identity outage `identity_unavailable`, and nothing is done in any of the three.

## Audit and limits

Every tool call writes a row to `claw_github_audit` **before** it does anything and finishes
it afterwards: requester, acting user, session, repository, pull request, head commit, tool,
a summary of the arguments (names and sizes, not the text of a review), the number of GitHub
requests and their request ids, the risk reasons, the confirmation, whether it was a dry run or
a write, the result, the review path and the acting user's review mode. A call that cannot be written down is not made. No
table holds a credential. A tool answer is masked with the token and anything shaped like a
secret before the model reads it. Rate limits answer `rate_limited`; GitHub's own limits
answer `github_rate_limited` with `retry_after_seconds`, and a write is never retried blindly:
a retry first looks for its own marker on the pull request, in all of its reviews (more than a thousand
answer `reviews_unreadable`).

## Names

- Earlier release names, still read and never written: the hidden marker `<!-- clawy:run:... -->` in a review's footer (a retry still finds a review an earlier release posted, and does not post it twice) and the repository configuration file `.github/clawy.yml`, which is read only where `.github/claw-review.yml` is absent. A pull request that edits either file is held (a hard hold). Everything new is written under the neutral names: the marker `<!-- claw-review:run:... -->`, the file `.github/claw-review.yml` and the footer name `CLAW_GITHUB_REVIEW_AGENT_NAME`. The platform does not name the clients that call it; `test/github-review-public-tree.test.ts` fails on the product name anywhere else in this feature.

## Risks accepted in this phase

- **The standing authorization is wide.** With the `delegation` flag on, whoever can start a session that
  acts as the committer can have a pull request approved and merged with the committer's account, their
  own included, whenever CI is green and nothing holds it; the committer is asked only when the reviewing
  model judges it worth their look or a hard hold applies, which should be the few. The model's judgement
  is what stands between most pull requests and a merge: a model that judges a risky change low merges it,
  within the hard holds and the other gates. Which people may ask for someone else's account is for the deployment to decide
  (`CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS` names the services that may), and the committer's own
  switch is what limits it. The rules are evidence for the model and a few hard holds, not a security scan.
- **A held write waits for a person.** A person who is asked by many can have ten held writes
  waiting at once and then every further one is refused until they answer or the cards expire; there is no
  per-requester limit yet.

## What it does not do

It does not edit or push code, request reviewers, resolve another person's thread, re-run CI,
update a branch, use auto-merge, merge with admin rights or change a rule. It reviews only
public repositories of the configured owners. The risk rules are evidence for the reviewing model and a few hard holds, not a
security scan.
