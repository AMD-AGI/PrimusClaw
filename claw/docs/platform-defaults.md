# Platform defaults

A deployment can mount a fixed set of skills and MCP servers into **every** chat,
plain chats included, without the user selecting anything. Everything is off by
default; with `PLATFORM_DEFAULTS_FILE` unset, chats are built exactly as before.

## Brain settings

| Variable | Default | Effect |
|---|---|---|
| `PLATFORM_DEFAULTS_FILE` | unset | Path to the defaults file below. Unset, missing, unreadable or malformed means "not enabled" (a malformed file is logged and counted, and never fails a chat). Re-read when its mtime changes. |
| `PROGRESSIVE_SKILLS_ENABLED` | `false` | Whether the file's `skills` apply. Off: only its `mcp_servers` are mounted and no skill is fetched. |

## The file

```json
{
  "skills": [
    { "tool_id": 123 },
    { "tool_id": 124, "name": "optional-directory-name" }
  ],
  "mcp_servers": {
    "example": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "token": "<SAFE_API_KEY>"
    }
  }
}
```

- `skills` reference **marketplace tool ids** (type `skill`). Array order is the
  order in the prompt. `name` overrides the directory name under `.skills/`; it
  must match `[A-Za-z0-9][A-Za-z0-9._-]*`.
- `mcp_servers` has the same schema as a request's `mcp_servers`. A server needs a
  `token` (or `api_key`); Brain sends it as `Authorization: Bearer <token>`, and
  extra `headers` are merged on top. `<SAFE_API_KEY>` is replaced inside Brain
  with the calling user's own key, so `"token": "<SAFE_API_KEY>"` authenticates
  as the caller. A server without a token is rejected at connect time.

Mount order, lowest priority first: platform defaults, request `mcp_servers`,
`tool_ids`, plugin. A skill the request already supplies (plugin, local, or
`tool_ids`) under the same name wins and stays fully inlined.

## How skills load (progressive disclosure)

The prompt carries one line per default skill: name, a one-line description
(from the SKILL.md frontmatter `description`, else the first body paragraph,
capped at 300 characters) and the path to read. The body is **not** in the
prompt. The skill directory is written into the sandbox the first time a
sandbox tool call names `.skills`, immediately before that call, and the agent
reads it with its normal `read` tool. A chat that never reads a default skill
never writes one and never starts a sandbox on their account.

Limits: 50 entries and 8000 characters of list; further skills are summarized
as "N more skills not listed". Keep SKILL.md short (about 300 lines) and move
detail into files next to it, which the agent reads only when SKILL.md points
to them. Skills from plugins and `tool_ids` are unchanged and stay inlined.

## Publishing default tools

Brain lists the marketplace with the **calling user's** key, so a default skill
is mounted only for users who can see its tool. Publish each default tool with
`is_public` true (the upload default, `is_public=true` on `/v1/tools/upload`, or
public in the import flow) so every user can read it; a tool a user cannot see
is skipped for that user and counted. The marketplace list is read with
`limit=100`, newest first, so a default tool must be among the 100 most recent
tools visible to the user.

A failed or invisible default never blocks the chat: it emits an error event
(`platform_defaults`) and increments a counter.

## Metrics

| Metric | Meaning |
|---|---|
| `claw_platform_default_total{kind,outcome,reason}` | Config load, skill staging and lazy-write outcomes. |
| `claw_platform_default_chats_total` | Chats offered at least one default skill. |
| `claw_platform_skill_list_chars` | Size of the prompt list. |
| `claw_platform_skill_read_total{skill}` | Default skills the agent actually read. |
| `claw_platform_skill_lazy_write_total{outcome,cold_sandbox}` | Lazy writes; `cold_sandbox` marks writes that came with a sandbox started by the same call. |
| `claw_platform_skill_lazy_write_duration_seconds` | Time of one lazy write. |
