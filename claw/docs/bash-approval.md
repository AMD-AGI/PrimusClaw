# Bash approval rules

Hold selected `bash` tool calls for an explicit user decision, the same way
`requires_approval` holds MCP tools. A held call emits a `permissionRequest`
and waits. It runs only on an explicit allow; a deny, a timeout, an abort or a
missing approval channel means it never runs. An approval is never remembered
(`always_allow` has no effect), exactly like `requires_approval`.

## What this is, and is not

A guard against **accidental writes**. It reads shell text. A determined model
can get around it: `eval`, a base64 pipe, a script written to a file and then
run, a URL assembled from variables, or an HTTP client no rule knows. It is not
a sandbox boundary. Keep server-side authorization as the real control; this
only makes the honest, common case ask first.

## Where rules come from

- A plugin tool's `config.bash_approval` (or `bashApproval`), on any tool
  type. Rules apply to the sessions that mount that tool.
- The deployment's `BASH_APPROVAL_RULES` environment variable (a JSON list).

All sources are combined. Absent, `null` or `false` means no rule.

## Rule format

A list of objects. All fields present in one rule must match.

| Field | Meaning |
|---|---|
| `label` | Required. Shown in the approval request and logged. |
| `regex` | Tested against the whole command line. |
| `flags` | Optional regex flags: any of `i`, `m`, `s`. |
| `program` | Program name or list; a trailing `*` matches a prefix. Wrappers such as `sudo`, `env`, `time`, `VAR=x` and `bash -c "..."` are looked through. |
| `args_regex` | Tested against the arguments of one simple command (the program itself excluded). |
| `http.methods` | For `curl` / `wget`: the method is `-X` / `--method`, else `PUT` for `-T` / `--upload-file`, `POST` when a body flag is present, else `GET`. |
| `http.url_prefix` | URL prefix without scheme, case-insensitive, e.g. `api.example.invalid/v1`. |
| `http.url_regex` | Tested against the URL as written, so `$BASE/v1/x` can be matched. |

`program`, `args_regex` and `http` must all match within the same simple
command (commands are split on `;`, `&`, `|`, newlines, `(`, `)` and backticks).

## Malformed rules fail closed

A value that is not a non-empty list, an entry that is not an object, a
missing `label`, an unknown key, a bad type or an unparsable regex makes the
policy hold **every** bash command, and logs `bash_approval.invalid_holding_all_commands`.
A command that is not a string, or longer than 100000 characters, is held too.

## Examples (generic)

```json
[
  { "label": "HTTP write to the console API",
    "http": { "methods": ["POST", "PUT", "PATCH", "DELETE"],
              "url_prefix": "console.example.invalid/api" } },
  { "label": "Write through the console client script",
    "program": ["python", "python3"], "flags": "i",
    "args_regex": "\\bclient\\.py\\s+(POST|PUT|PATCH|DELETE)\\b" },
  { "label": "Recursive delete under /data",
    "regex": "\\brm\\s+-rf?\\s+/data\\b" }
]
```

As a deployment setting: `BASH_APPROVAL_RULES='[{"label":"...","regex":"..."}]'`.
As plugin config: `{"config": {"s3_key": "...", "bash_approval": [ ... ]}}`.

Approval needs a decision channel, the same one `requires_approval` uses; with
none, a held call is denied.

## A ready-made pack for outbound actions

[`claw/examples/bash-approval/outbound-actions.json`](../examples/bash-approval/outbound-actions.json) is a
rule list for the actions that leave the sandbox and change something somewhere else: publishing commits,
opening or merging pull requests, writing through the GitHub API, changing a cluster, and deleting files
outside the workspace. Use it as it is (`BASH_APPROVAL_RULES="$(cat outbound-actions.json)"`, or as a
tool's `config.bash_approval`) or copy the rules you want. Each held call carries the rule's label in its
approval request.

| Rule | Held | Runs without asking |
|---|---|---|
| `git push` | `git push` in any form, `git -C dir push`, `git --git-dir=... push`; the **force / delete** forms (`--force`, `-f`, `--force-with-lease`, `--delete`, `-d`, `--mirror`, `--prune`, `+ref`, `:ref`) are labelled separately | `status`, `log`, `diff`, `fetch`, `pull`, `clone`, `checkout`, `branch`, `commit`, `stash` (also `stash push`), `remote`, `config` |
| `gh pr` | `create`, `merge`, `close`, `review`, `ready`, `edit`, `reopen`, `comment`, `update-branch` | `view`, `list`, `checks`, `diff`, `status`, `checkout` |
| `gh release` | `create`, `edit`, `delete`, `upload`, `delete-asset` | `list`, `view`, `download` |
| `gh api` | `-X` / `--method` `POST`, `PUT`, `PATCH`, `DELETE`; and any call with `-f`, `-F`, `--field`, `--raw-field` or `--input` and no explicit `GET` (`gh` sends those as a POST) | `GET` calls, including `-X GET ... -f q=...` |
| `gh repo` | `create`, `delete`, `edit`, `rename`, `archive`, `unarchive`, `fork`, `sync` | `view`, `clone`, `list` |
| `gh workflow` | `run`, `enable`, `disable` | `list`, `view` |
| `kubectl` | `apply`, `delete`, `patch`, `scale`, `exec`, `create`, `replace`, `edit`, `label`, `annotate`, `cordon`, `uncordon`, `drain`, `taint`, `set`, `run`, `cp`, `debug`, `expose`, `autoscale`, `rollout restart/undo/pause/resume` | `get`, `describe`, `logs`, `top`, `config`, `rollout status`, `rollout history` |
| `helm` | `install`, `upgrade`, `uninstall`, `delete`, `rollback`, `push` | `list`, `template`, `status`, `get`, `lint`, `show`, `repo` |
| `rm` | a recursive `rm` (`-r`, `-R`, `-rf`, `--recursive`) of an absolute path outside `/workspace`, of `~` or `$HOME`, of `/workspace` itself or `/workspace/*`, or of anything with a `..` segment (the working directory is not known, so a relative path that climbs is held too) | `rm file`, `rm -f /tmp/x.log` (not recursive), `rm -rf node_modules` (relative), `rm -rf /workspace/app/build` |

The program is found through `sudo`, `env X=1`, `timeout`, `nohup`, `bash -c "..."`, `ssh host ...` and
`kubectl exec -- ...`, and option values are skipped, so a namespace called `apply` in `kubectl -n apply get pods`
is not an `apply`, and `gh -R owner/repo pr create` is a `pr create`.

Things this pack does not do, beyond the limits above:

- A value with a space after git's global `-C` / `-c` (`git -C "my dir" push`) is not seen as a push: the
  words are matched after the shell's quotes are removed.
- A recursive delete of a `/tmp` path is held, because it is outside `/workspace`. Delete that rule, or
  narrow it, if scratch cleanup should not ask.
- A GraphQL read through `gh api graphql -f query=...` is a POST to GitHub and is held.
- It does not cover `gh issue`, `gh gist`, `gh secret`, `gh run`, `git` aliases, other HTTP clients (add an
  `http` rule), `docker push`, or a script that does any of this.

The held call's request goes to whoever can answer it. With `CLAW_NOTIFICATIONS_ENABLED`, a subscription that
lists `approval.requested` in its `event_types` is also sent a signed `approval.requested` webhook for each
held call of a session that opted in (`config.notify_on_finish: true`, or started by a trigger), carrying the
tool, a redacted summary of the command and the time at which Brain stops waiting, so the answer does not
depend on someone watching the run.

## What the model sees on a refusal

For MCP tools and bash alike: `The user denied this action; it was not
executed. Tell the user it was not done because they denied it.` (plus the
user's note, if any), or `No decision was received in time; this action was
not executed. ...` on a timeout.
