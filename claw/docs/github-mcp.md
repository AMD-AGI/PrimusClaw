<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# GitHub tools

With `CLAW_GITHUB_MCP_ENABLED=true`, every session whose owner keeps a GitHub token in their env vault
(`PUT /v1/env/user/GH_TOKEN`, the same variable the sandbox's `gh` and `git` use) is offered a `github` MCP
server, hosted by the API. Off by default; nothing is registered or offered while it is off.

| Reads (run without asking) | Writes (each waits for the user's decision) |
|---|---|
| `repo_get_file`, `repo_list`, `pr_get`, `pr_list`, `pr_files`, `pr_diff`, `pr_reviews`, `checks_list`, `job_logs`, `issue_get`, `issue_list`, `issue_search`, `review_threads_list`, `code_search` | `issue_comment`, `issue_create`, `pr_create`, `pr_update`, `review_thread_reply`, `review_thread_resolve` |

Merging is not a tool here: it belongs to GitHub review (`github-review.md`), which has the gates for it.

## How it is wired

- At dispatch the API adds the entry under the reserved name `github` (it replaces any server a request names
  `github`): a token signed with `CLAW_GITHUB_MCP_SECRET` that names the session and its owner, and the policy
  `requires_approval: true` with the read tools in `auto_approve` (see `mcp-approval.md`). Every tool is held
  unless listed, so a tool added later waits for a person until someone lists it.
- The entry holds no GitHub credential. On every call the API checks the token, reads the session row again
  (still there, the same owner, not acting as another user) and reads the owner's `GH_TOKEN` from the vault for
  that request. Whose token is used comes from the session, never from a tool argument.
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

The tools call GitHub's REST and GraphQL API themselves rather than GitHub's own remote MCP server, so they need
nothing reachable but `CLAW_GITHUB_API_URL`.
