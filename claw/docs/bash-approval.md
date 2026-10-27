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

## What the model sees on a refusal

For MCP tools and bash alike: `The user denied this action; it was not
executed. Tell the user it was not done because they denied it.` (plus the
user's note, if any), or `No decision was received in time; this action was
not executed. ...` on a timeout.
