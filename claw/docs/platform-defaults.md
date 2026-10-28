# Platform defaults

A deployment can mount a fixed set of skills and MCP servers into **every** chat,
plain chats included, without the user selecting anything. Everything is off by
default; with `PLATFORM_DEFAULTS_FILE` unset, chats are built exactly as before.

## Brain settings

| Variable | Default | Effect |
|---|---|---|
| `PLATFORM_DEFAULTS_FILE` | unset | Path to the defaults file below. Unset, missing, unreadable or malformed means "not enabled" (a malformed file is logged and counted, and never fails a chat). Re-read when its mtime changes. |
| `PROGRESSIVE_SKILLS_ENABLED` | `false` | Whether the file's `skills` apply. Off: only its `mcp_servers` are mounted and no skill is fetched. Also decides how a plugin's skills reach the prompt: on, they are listed by name and description like the defaults; off, every SKILL.md body is inlined. |
| `SKILL_CACHE_MAX_BYTES` | `67108864` (64 MiB) | Budget for the downloaded skill files Brain keeps in memory between turns (plugin skills and `tool_ids` skills; not the platform default skills, which are staged separately). A held skill is charged its content bytes plus 256 B per file and 1 KiB per skill, so even empty skills have a price. `0` turns the cache off and every turn downloads every skill. See "Skill cache". |

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
`tool_ids`) under the same name wins over the default; a plugin skill is then
listed like any other plugin skill (see below), a local or `tool_ids` skill stays
fully inlined.

## How skills load (progressive disclosure)

The prompt carries one line per default skill: name, a one-line description
(from the SKILL.md frontmatter `description`, else the first body paragraph,
capped at 300 characters) and the path to read. The body is **not** in the
prompt. The skill directory is written into the sandbox the first time a
sandbox tool call names `.skills`, immediately before that call, and the agent
reads it with its normal `read` tool. A chat that never reads a default skill
never writes one and never starts a sandbox on their account.

Limits: 50 entries and 8000 characters of list; further default skills are
summarized as "N more skills not listed". Keep SKILL.md short (about 300 lines)
and move detail into files next to it, which the agent reads only when SKILL.md
points to them. `tool_ids` skills are looked up and downloaded through the same
resolver and base URL and stay inlined.

### Plugin skills

With `PROGRESSIVE_SKILLS_ENABLED=true`, a plugin's skills use the same list and
the same on-demand write instead of inlining every SKILL.md body. A plugin skill
the capped list has no room for stays inlined, so no skill is ever neither listed
nor contained in the prompt. With the flag off, plugin skills are inlined as
before.

Independently of the flag, a plugin's skill files are written into the sandbox on
the first sandbox call that names `.skills` (immediately before it, supporting
files included), and a plugin without a hooks-type tool starts no sandbox at the
start of a turn: a turn that only calls MCP tools never opens one. A plugin with a
hooks tool keeps its sandbox and skill writes at the start of the turn.

### Skill cache

A plugin skill used to be listed and read from the object store again on every
turn. Brain now holds the files of each skill it has downloaded and reuses them
while the skill is unchanged, so a turn that finds a plugin skill unchanged reads
no object and reports no `download_skill` event for it.

- **Plugin skills** (`config.s3_key`): the held copy is keyed by tool id and
  `s3_key` (which carries the version) and validated every turn by one listing
  of the skill's prefix, fingerprinted by each object's ETag and size. An in-place
  upsert of the same version rewrites the objects under the same keys, so the
  version string alone would not show it; the ETag does. The listings of all of a
  turn's skills run at once.
- **`tool_ids` skills**: keyed by tool id and validated by the tool record's
  `version` and `updated_at`, which Brain already reads each turn and every
  in-place update bumps. The skill is still installed for the turn every time; only
  the fetch and the unpacking are saved.
- A skill is downloaded, and not held, whenever it cannot be told apart from a
  changed one: a store that returns no ETag, a failed listing, a record with no
  `updated_at`, or an archive that has no `SKILL.md`. Concurrent turns that need
  the same unheld version share one download.
- The cache holds bytes, never directories: each turn gets its own copy in its own
  private staging directory, so no turn can change another's files. It is bounded
  by `SKILL_CACHE_MAX_BYTES`, counted as content plus a fixed price per file and
  per skill (least recently used out first; a skill that costs more than a quarter
  of the bound is never held) and is per Brain process.
- `claw_skill_stage_total{source,outcome}` counts skills staged per turn by
  `source` (`plugin`, `tool`) and `outcome` (`hit`, `joined`, `downloaded`).

## Publishing default tools

Brain looks each default up **by id** through the in-cluster API (`INTERNAL_BACKEND_URL`, route `/v1/tools/<id>`; the gateway `SAFE_API_URL/claw-api` path is used only when it is unset) with the **calling user's** key (10 s
deadline), so a default skill is mounted only for users who can read its tool,
however many other tools exist. Publish each default tool with `is_public` true
(the upload default, `is_public=true` on `/v1/tools/upload`, or public in the
import flow) so every user can read it; a tool a user cannot read is skipped for
that user. An answer that did not come from the Claw API (for example a gateway
404 for a path it does not route) is reported as `endpoint_unreachable`, not as a
missing or unreadable tool; the metric `reason` label distinguishes `not_found`,
`forbidden`, `endpoint_unreachable` and `lookup`.

The skill archive may be flat or wrapped in a single top-level folder; either
way the directory that contains `SKILL.md` is what appears as
`.skills/<name>/` in the sandbox. Staged copies are kept on Brain for up to 24 h
(a chat can read its skill long after it started) and are re-staged if missing.

A failed or unreadable default never blocks the chat, but it is never silent: it
is logged at error level, emits an error event (`platform_defaults`) and
increments a counter.

## Metrics

| Metric | Meaning |
|---|---|
| `claw_platform_default_total{kind,outcome,reason}` | Config load, skill staging and lazy-write outcomes. |
| `claw_platform_default_chats_total` | Chats offered at least one default skill. |
| `claw_platform_skill_list_chars` | Size of the prompt list. |
| `claw_platform_skill_read_total{skill}` | Default skills the agent actually read. |
| `claw_platform_skill_lazy_write_total{outcome,cold_sandbox}` | Lazy writes; `cold_sandbox` marks writes that came with a sandbox started by the same call. |
| `claw_platform_skill_lazy_write_duration_seconds` | Time of one lazy write. |
| `claw_skill_stage_total{source,outcome}` | Skills staged for a turn: `hit` (held copy), `joined` (a concurrent turn's download), `downloaded`. |
