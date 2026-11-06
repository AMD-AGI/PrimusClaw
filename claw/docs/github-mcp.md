<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# GitHub tools

With `CLAW_GITHUB_MCP_ENABLED=true`, every session whose owner keeps a GitHub token in their env vault
(`PUT /v1/env/user/GH_TOKEN`, the same variable the sandbox's `gh` and `git` use) is offered a `github` MCP
server, hosted by the API. Off by default; nothing is registered or offered while it is off.

With `CLAW_GITHUB_MCP_BINDING_ENABLED=true` as well, an owner who keeps no `GH_TOKEN` is served with the GitHub
account they bound at the identity provider (`/github bind` in Teams, the binding [GitHub review](github-review.md)
uses), so binding once is enough for the tools too. The vault comes first: an owner who keeps a `GH_TOKEN` is served
with it. Off by default: switching it on changes what a binding is used for, so the people who bound one have to be
told (Clawy's `/github status` and its binding card say it).

| Reads (run without asking) | Writes (each waits for the user's decision) |
|---|---|
| `repo_get_file`, `repo_list`, `pr_get`, `pr_list`, `pr_files`, `pr_diff`, `pr_reviews`, `checks_list`, `job_logs`, `issue_get`, `issue_list`, `issue_search`, `review_threads_list`, `code_search` | `issue_comment`, `issue_create`, `pr_create`, `pr_update`, `review_thread_reply`, `review_thread_resolve`, `checks_rerun_failed`, `pr_request_reviewers`, `labels_set` |

Merging is not a tool here: it belongs to GitHub review (`github-review.md`), which has the gates for it.

## Lists

The list reads (`issue_search`, `pr_list`, `issue_list`, `repo_list`, `code_search`) answer
`{ total_count, shown, complete, next_page?, note?, items }`: how many matches there are where that is known (a
search's count, or a list read to its end), how many the answer holds, and whether that is all of them. An answer
holds at most `GITHUB_LIST_MAX_CHARS` (`@claw/protocol`) of items, and Brain keeps the answer of these tools whole up
to that bound, where any other tool's result is cut to its head and tail; past it the answer says how many it left
out. Pages are 50 by default, up to 100.

- `pr_list` `state`: `open` (default) and `all` newest first; `closed` most recently closed first; `merged` only the
  merged ones, most recently merged first. `author` keeps one person's. Closed and merged ones, and one author's, are
  read in pages of 100 (at most 5) and ordered or filtered here; reading stops once nothing unread can come first.
- `checks_list` gives a GitHub Actions job's `run_id`, which `checks_rerun_failed` takes.
- A search narrowed with `repo:`, `org:` or `user:` that GitHub refuses (422; GitHub refuses some fine-grained tokens
  such a search even where they read the repository) fails with words that say to list the repository with `pr_list`
  or `issue_list` instead.

A failed read is the tool's own error (`isError`), and Brain marks its result event `is_error: true` (the event's
`status` stays `success`: the call returned, and its text is what a later turn is rebuilt with).

## How it is wired

- At dispatch the API adds the entry under the reserved name `github` (it replaces any server a request names
  `github`): a token signed with `CLAW_GITHUB_MCP_SECRET` that names the session and its owner, and the policy
  `requires_approval: true` with the read tools in `auto_approve` (see `mcp-approval.md`). Every tool is held
  unless listed, so a tool added later waits for a person until someone lists it.
- The entry holds no GitHub credential. On every call the API checks the token, reads the session row again
  (still there, the same owner, not acting as another user) and reads the owner's `GH_TOKEN` from the vault for
  that request. Whose token is used comes from the session, never from a tool argument.
- With a binding, the API asks the identity provider for it on every request, for the owner themselves and named
  `github_mcp:<tool>` in the provider's audit trail, and never keeps it. At dispatch it is asked for once to learn whether
  there is one that works (`github_mcp:offer`); an expired one is not offered. Every call made with it is written to
  GitHub review's audit log (`claw_github_audit`, tool `github_mcp.<tool>`, the arguments summarised, a body only as its
  length) before it runs, and finished after; a call whose row cannot be written is not made. Writes wait for the user
  exactly as with a `GH_TOKEN`.
- `GET /v1/github/connection` answers the signed-in user which token their tools would use now: `reads_with` is
  `env`, `binding` or null (`missing`: `none` or `expired`), with the bound `login`, and `binding_reads` says whether a
  binding counts here at all. A channel reads it to offer `/github bind` before it sends a question that needs GitHub. It
  exists only while the tools are on.
- A session that acts as another user (`config.acting_as`) is not offered these tools.
- An assistant's router turn gets the same entry, cut by its `tools_allowlist` to the reads a question needs
  (`assistant/read-tools.ts`: no write, no whole diff, no job log), and under its `read_taint`: once a read has answered,
  the turn can only speak, so what a pull request says cannot start or change work for the user. A read that failed read
  nothing and leaves the turn free to start the work, so a read's failure is said as the status GitHub answered with, in the
  server's own words, never as GitHub's message (a write's failure still carries GitHub's message, for the worker).
- The same writes made from the shell (`gh pr create`, `gh api -X POST`, ...) are held by the built-in bash
  rules (`bash-approval.md`).

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `CLAW_GITHUB_MCP_ENABLED` | `false` | The switch |
| `CLAW_GITHUB_MCP_SECRET` | none | HMAC key of the session token, 32 characters or more; the API does not start without it while the switch is on |
| `CLAW_GITHUB_MCP_URL` | `<INTERNAL_BACKEND_URL>/v1/internal/github/mcp` | Where Brain reaches the tools |
| `CLAW_GITHUB_API_URL` | `https://api.github.com` | Shared with GitHub review |
| `CLAW_GITHUB_MCP_BINDING_ENABLED` | `false` | An owner with no `GH_TOKEN` is served with their GitHub binding; the API does not start with it on unless `IDENTITY_CLIENT_ENABLED` and `CLAW_GITHUB_REVIEW_ENABLED` are on too |

The tools call GitHub's REST and GraphQL API themselves rather than GitHub's own remote MCP server, so they need
nothing reachable but `CLAW_GITHUB_API_URL`.
