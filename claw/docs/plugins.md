# Tool Upload Format Specification

This document describes how to upload tools (skills, rules, hooks) to the
marketplace, covering both single-file uploads and zip archive imports.

- Single-file path: `POST /v1/tools/upload`
- Zip / GitHub import path: `POST /v1/tools/import/discover` followed by
  `POST /v1/tools/import/commit`

All requests require an authenticated user. The maximum single-file upload
size is 10 MB; zip archives are bounded by `MAX_ZIP_BYTES`.

---

## 1. Single-File Upload

### Endpoint

```
POST /v1/tools/upload
Content-Type: multipart/form-data
```

### Filename-Based Type Detection

The tool type (`skill` or `rule`) is derived from the **uploaded filename**
(case-insensitive substring match):

| Filename (lowercased) contains | Detected type | Stored object name |
| ------------------------------ | ------------- | ------------------ |
| `skill` (e.g. `SKILL.md`, `my-skill.md`) | `skill` | `SKILL.md` |
| `rule`  (e.g. `rule.md`, `MY_RULE.md`)   | `rule`  | `rule.md`  |
| Both `skill` and `rule`        | 400 Bad Request — `filename ambiguous` |
| Neither                        | 400 Bad Request — `filename must contain 'skill' or 'rule'` |

### Multipart Fields

| Field          | Type                | Required | Description |
| -------------- | ------------------- | -------- | ----------- |
| _file part_    | binary              | yes      | The markdown file. The `filename` attribute drives type detection. |
| `name`         | string              | no       | Tool name override. When blank, the server falls back to the in-body header (see below). |
| `display_name` | string              | no       | Display label; defaults to `name`. |
| `description`  | string              | no       | Short description stored on the row. |
| `tags`         | string (CSV)        | no       | Comma-separated tags, e.g. `ai,helper`. |
| `version`      | string              | no       | Semantic version string. Defaults to `1.0.0`. |
| `icon_url`     | string              | no       | Optional icon URL. |
| `is_public`    | string `"true"\|"false"` | no  | Defaults to `true`. Only the literal string `"false"` makes the tool private. |

### Tool Name Resolution Order

1. Form field `name` (when non-blank).
2. The first matching header line inside the file body (case-insensitive,
   normalized for CRLF / lone CR / BOM / NBSP / zero-width characters):
   - First `title:` line wins.
   - Falls back to the first `name:` line.
3. If still empty: returns `400 skill name is required` /
   `400 rule name is required`.

The header line may live either inside a YAML frontmatter block or as a bare
top-level line in the document.

### Name Validation

The final name must match the regex `^[A-Za-z0-9._-]+$`. Invalid names
return `400 invalid skill name (use A-Za-z0-9._-)` (or `rule`).

### Description Extraction (Informational, Non-Blocking)

When the form `description` field is empty, downstream listing previews fall
back to:

1. The `description:` value from the YAML frontmatter (supports `>-`, `|`
   folded blocks).
2. The first paragraph of the body, after stripping a leading `# Heading`,
   trimmed to 500 characters.

### Recommended File Format

YAML frontmatter is the recommended layout for both `SKILL.md` and rule
files:

```markdown
---
name: my-tool
description: One-line summary used in marketplace previews.
---

# My Tool

Body content goes here.
```

A bare top-level header without `---` markers is also accepted:

```markdown
title: my-tool

# My Tool

Body content...
```

### Response

**Success (`201 Created`):**

```json
{
  "ok": true,
  "data": {
    "id": 123,
    "type": "skill",
    "name": "my-skill",
    "version": "1.0.0",
    "...": "..."
  }
}
```

**Error (`400 Bad Request`):**

| Error message                                                | Trigger |
| ------------------------------------------------------------ | ------- |
| `file required`                                              | No file part in the request. |
| `file exceeds size limit`                                    | File body > 10 MB. |
| `filename ambiguous: contains both 'skill' and 'rule'`       | Both substrings present. |
| `filename must contain 'skill' or 'rule'`                    | Neither substring present. |
| `skill name is required` / `rule name is required`           | Empty `name` field and no extractable header. |
| `invalid skill name (use A-Za-z0-9._-)` / `invalid rule ...` | Resolved name violates the safe charset. |

### Curl Examples

Upload a skill file:

```bash
curl -X POST "$API/v1/tools/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./SKILL.md" \
  -F "name=my-skill" \
  -F "description=A handy skill" \
  -F "tags=ai,helper" \
  -F "version=1.0.0" \
  -F "is_public=true"
```

Upload a rule file (name resolved from frontmatter):

```bash
curl -X POST "$API/v1/tools/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./my-rule.md"
```

### Internal Flow

```
multipart parse
   |-- read part.filename + buffer
   v
lowercase(filename)
   |-- includes("skill") => kind = "skill"
   |-- includes("rule")  => kind = "rule"
   |-- both / neither    => 400
   v
createSkillOrRuleTool(body, userId, userName, kind)
   |-- DB toolInsert(type = APP_TYPE_SKILL | APP_TYPE_RULE)
   |-- S3 PUT plugins/{toolId}/{version}/{SKILL.md | rule.md}
   |-- DB toolUpdate(config = { s3_key, is_prefix: false })
   v
formatToolRow(row) -> 201 Created
```

---

## 2. Zip Archive Import (Two-Phase)

Zip imports support multiple skills, rules and hooks bundles in a single
archive. They are split into a discover step and a commit step.

### Phase 1 — Discover

```
POST /v1/tools/import/discover
Content-Type: multipart/form-data
```

Provide **either**:

- A multipart file part whose filename ends with `.zip` (case-insensitive),
  **or**
- A `github_url` field plus optional `github_token` field.

Providing both, or neither, returns `400 Bad Request`.

Optional query parameters:

| Query    | Default | Bounds       | Description |
| -------- | ------- | ------------ | ----------- |
| `offset` | `0`     | `>= 0`       | Pagination offset over the discovered candidate list. |
| `limit`  | `100`   | `1 .. 500`   | Page size. |

**Response:**

```json
{
  "ok": true,
  "data": {
    "archive_key": "imports/staging/<id>",
    "candidates": [
      {
        "type": "skill",
        "relative_path": ".cursor/skills/foo",
        "name": "foo",
        "description": "...",
        "requires_name": false
      },
      {
        "type": "rule",
        "relative_path": ".cursor/rules/code-style.md",
        "name": "code-style.md",
        "description": "...",
        "requires_name": false
      },
      {
        "type": "hooks",
        "name": "<bundle name>",
        "hooks_json_relative_path": ".cursor/hooks/hooks.json",
        "scripts": [
          { "type": "hooks", "relative_path": ".cursor/hooks/before_run.py", "name": "before_run.py", "requires_name": false }
        ]
      }
    ],
    "total": 3
  }
}
```

`requires_name = true` means the candidate's auto-derived name violates the
`^[A-Za-z0-9._-]+$` charset; the client must supply `name_override` during
commit.

### Phase 2 — Commit

```
POST /v1/tools/import/commit
Content-Type: application/json
```

JSON body:

```json
{
  "archive_key": "imports/staging/<id>",
  "selections":  [/* subset of candidates from discover */],
  "tags":        ["optional", "tags"],
  "version":     "1.0.0"
}
```

Each selection should carry the relevant `relative_path` (and
`hooks_json_relative_path` for hooks). Override the name when needed:

```json
{ "type": "skill", "relative_path": ".cursor/skills/foo", "name_override": "foo-v2" }
```

The response contains a per-selection result list with `status: "ok" | "failed"`
and either the persisted tool row or an `error` string.

### In-Archive Type Detection Rules

#### 2.1 Skill Candidates — Driven by `SKILL.md`

- **Trigger**: any archive entry whose basename matches `SKILL.md`
  (case-insensitive lookup; the canonical S3 object name is always
  `SKILL.md`).
- **Skill root**: the directory containing `SKILL.md`. Every file under that
  root (excluding `..` segments) is committed to S3 under
  `skills/<name>/<inner-path>`.
- **Outer prefixes are stripped**: `my_repo/.cursor/skills/foo/SKILL.md`
  collapses to `skills/foo/SKILL.md` in S3.
- **Nested roots**: if a `SKILL.md` is nested inside another skill root, the
  outermost (shallowest) root wins; nested ones are absorbed.
- **Name resolution**:
  1. `title:` then `name:` line inside `SKILL.md` (same rules as single-file).
  2. Fallback to the directory basename (e.g. `foo`).
  3. Top-level archives without a directory fall back to `skill`.

Example archive layout:

```
my_repo.zip
├── .cursor/skills/foo/
│   ├── SKILL.md          (name extracted here)
│   ├── reference.md
│   └── helpers/util.py
└── docs/skills/bar/
    └── SKILL.md
```

#### 2.2 Rule Candidates — Driven by `rules/` Path Segments

- **Trigger**: any **directory segment** equal to `rules`
  (case-insensitive) followed by at least one file beneath it.
- **Granularity**: every file under any `rules/` directory becomes its own
  candidate (rules are not aggregated by directory).
- **Name**: the file basename, truncated to 255 characters.
- **Description**:
  1. The first `description:` field (frontmatter wins, otherwise full-text).
  2. Falls back to the first 512 bytes of the body.
  3. Edge whitespace and punctuation (ASCII + common CJK) are stripped.

Example archive layout:

```
my_repo.zip
└── .cursor/rules/
    ├── code-style.md     (candidate name = code-style.md)
    ├── git-policy.md     (candidate name = git-policy.md)
    └── nested/foo.md     (candidate name = foo.md)
```

#### 2.3 Hooks Bundle — Driven by `hooks.json`

- **Trigger**: archive contains at least one `hooks.json` (basename
  case-insensitive).
- **Bundling**: an entire archive yields **one** hooks tool, regardless of
  how many scripts it references.
- **Authoritative manifest**: the lexicographically first `hooks.json` is
  treated as authoritative; any other `hooks.json` files are ignored as
  candidates.
- **Script selection** (a script is included only if all hold):
  - Path lives under a `hooks/` directory (path starts with `hooks/` or
    contains `/hooks/`, case-insensitive).
  - Path is **not** under any `rules/` segment.
  - Basename is not `SKILL.md`.
  - Path, basename, or any trailing subpath appears as a substring inside
    the `hooks.json` text.

Example archive layout:

```
my_repo.zip
└── .cursor/hooks/
    ├── hooks.json
    ├── before_run.py
    └── after_run.sh
```

### Common Constraints

- Paths containing `..` segments are silently skipped (zip-slip protection).
- Path separators are normalized: `\` → `/`.
- Candidate names must match `^[A-Za-z0-9._-]+$`. Otherwise the discover
  response sets `requires_name: true` and commit must supply
  `name_override`.
- Newline normalization (CRLF / lone CR), BOM, NBSP and zero-width
  characters are cleaned during name and description extraction.

---

## 3. Format Cheat Sheet

| Scenario        | Endpoint(s)                                     | Payload     | Type detection                         | Name source                                       |
| --------------- | ----------------------------------------------- | ----------- | -------------------------------------- | ------------------------------------------------- |
| Single skill    | `POST /v1/tools/upload`                         | `.md` file  | Filename contains `skill`              | Form `name` > `title:` > `name:` in body          |
| Single rule     | `POST /v1/tools/upload`                         | `.md` file  | Filename contains `rule`               | Form `name` > `title:` > `name:` in body          |
| Multi-skill zip | `/v1/tools/import/discover` + `/import/commit`  | `.zip`      | Archive contains `SKILL.md` files      | `title:` / `name:` inside `SKILL.md`, else dir name |
| Multi-rule zip  | Same as above                                   | `.zip`      | Path contains a `rules/` directory     | File basename                                     |
| Hooks bundle    | Same as above                                   | `.zip`      | Archive contains `hooks.json`          | Bundle name derived from `hooks.json` rows        |
| GitHub repo     | `/v1/tools/import/discover` (with `github_url`) | URL         | Same rules as zip                      | Same rules as zip                                 |

### Recommended Frontmatter Template

The same frontmatter works for `SKILL.md` and rule files inside `rules/`:

```markdown
---
name: my-tool
description: One-line summary used in marketplace previews.
---

# My Tool

Body content...
```

---

## 4. Plugin Run-Time Overrides

A launch of a plugin can change a few declared settings without registering a
new plugin. The plugin's author declares what may change in `overridable`;
a launch names its values in `overrides`. Nothing is overridable unless
declared: a plugin without `overridable` (every plugin registered before the
field existed) refuses every override and launches exactly as before.

### Declaring (`overridable` on the plugin)

`overridable` is accepted by `POST /v1/plugins`, `POST /v1/plugins/upsert`,
`PUT`/`PATCH /v1/plugins/:id` and `POST /v1/plugins/:id/new-version` (a new
version keeps the source version's declaration unless the request sets one),
and is returned by every plugin read. An invalid declaration is
`400 bad_request` naming every problem, and nothing is written.

```json
{
  "image": { "enum": ["harbor.example/app:rc"] },
  "model": { "enum": ["model-a", "model-b"], "env": ["APP_MODEL", "APP_REPORT_MODEL"] },
  "args":  { "items": { "pattern": "^--[a-z-]+(=[A-Za-z0-9._-]+)?$" }, "maxItems": 4 },
  "env": {
    "SOURCE_SHA": { "pattern": "^[0-9a-f]{40}$", "description": "Commit to build from" },
    "MODE": { "enum": ["fast", "full"] }
  },
  "sandbox_templates": {
    "runner": {
      "fromImage": { "enum": ["harbor.example/runner:1", "harbor.example/runner:2"] },
      "per_gpu_count": { "enum": [2, 4, 8] },
      "resources": {
        "cpu": { "max": "64" },
        "memory": { "max": "2048Gi" },
        "ephemeralStorage": { "max": "1500Gi" },
        "sharedMemory": { "max": "1000Gi" }
      }
    }
  }
}
```

| Key     | Value a launch gives | Rule |
| ------- | -------------------- | ---- |
| `image` | a string | Must be one of the plugin's `images[].repo`, or of the declaration's own `enum`. |
| `model` | a string | String rule (below). A task runs on it; an app run gets it in every env name listed in `env` (an app run cannot override `model` when `env` is empty). |
| `args`  | a list of strings | Appended to the app manifest's `command`. `items` is a string rule for each; `maxItems` 1-64 (default 16). |
| `env`   | an object of name to string | One string rule per variable name the launch may set. At most 64 names. |
| `sandbox_templates` | an object of template name to values | One declaration per template of the app manifest's `sandbox_templates` (at most 64), each naming at least one of the keys below. App runs only. |

Per template, under `sandbox_templates.<name>`:

| Key | Value a launch gives | Rule |
| --- | -------------------- | ---- |
| `fromImage` | a string | String rule (below), which must have an `enum` or a `pattern`. Becomes the template's `fromImage`. |
| `per_gpu_count` | an integer | Integer rule: `{ "enum": [2, 4, 8] }` or `{ "minimum": 1, "maximum": 8 }` (an `enum` or a `maximum` is required; values 1-1024). Becomes the template's only card count, `[n]`. |
| `resources` | `{ "requests": {...}, "limits": {...}, "sharedMemory": "..." }` | One `{ "max": "<quantity>" }` per resource the launch may size: `cpu`, `memory`, `ephemeralStorage` (`ephemeral-storage` in `requests`/`limits`) and `sharedMemory` (the template's `/dev/shm`). |

The resource values are Kubernetes quantity strings (`"24"`, `"500m"`, `"1400Gi"`;
a leading `+` is accepted, as Kubernetes accepts it), each positive and at most its declared `max`, compared exactly as Kubernetes
compares them (a value finer than a nano-unit rounds up, so `"64.0000000001"` is
above a `max` of `"64"`; a decimal exponent above 64 is not accepted). A resource with no `max` cannot be
set, and `requests`/`limits` take only `cpu`, `memory` and `ephemeral-storage`
(the GPU count comes from `per_gpu_count` alone).

A string rule is a small JSON Schema subset: `type` (`"string"`), `enum`
(1-256 strings), `pattern` (an ECMAScript regular expression, at most 512
characters; anchor it with `^...$`), `maxLength` (1-4096, default 4096) and
`description`. Unknown keys are refused. Values and `enum` entries may not
have leading or trailing whitespace. All pattern tests of one launch share a
50 ms budget and run interruptibly, so a pattern that backtracks badly cannot
stall the API: a value whose test does not finish in time is refused. Whether a
declaration's patterns compile is checked in one run under the same budget, and
each pattern's answer is kept, so a stored declaration that has passed once does
not read as invalid later because the API was briefly busy.

### Launching with `overrides`

`POST /v1/sessions/:sessionId/tasks` takes `overrides`:

| Launch | Applicable keys |
| ------ | --------------- |
| App run (`mode: "app"`) | `image`, `model`, `args`, `env`, `sandbox_templates` |
| Single task (`plugin_id`, no DAG) | `image`, `model` |

```json
{
  "mode": "app",
  "plugin_id": 42,
  "input": { "...": "..." },
  "resources": { "gpus": 8, "workspace": "ws-a" },
  "overrides": {
    "model": "model-b",
    "env": { "SOURCE_SHA": "0123...cdef" },
    "sandbox_templates": {
      "runner": {
        "fromImage": "harbor.example/runner:2",
        "per_gpu_count": 4,
        "resources": {
          "requests": { "cpu": "24", "memory": "1400Gi" },
          "limits": { "cpu": "32", "memory": "1400Gi", "ephemeral-storage": "750Gi" },
          "sharedMemory": "512Gi"
        }
      }
    }
  }
}
```

Every key must be declared, apply to the launch, and hold a value its rule
accepts; otherwise the answer is `400 plugin_overrides_invalid` with a
`problems` list (`field`, `reason`), and nothing is created. A task with
`overrides` but no `plugin_id`, or with a DAG, is refused the same way. For an
app run the overrides are applied to a copy of the plugin's manifest, which must
still validate (a platform-reserved variable such as `LD_PRELOAD` stays
refused, reported as `issues`); `overrides.image` together with
`resources.image` is refused (give the image once), and a plugin that declares
`image` holds `resources.image` to the same list (a plugin that declares nothing
keeps accepting any `resources.image`, as before). The plugin row itself is
never changed by a launch.

`overrides.sandbox_templates` is applied to the named templates of that copy;
every other template is left as written:

- each name must be declared and be a template of the app manifest, and each
  key under it must be declared for that template;
- `per_gpu_count: n` replaces the template's card counts with `[n]`, so the app's
  `env_map.sandbox_templates` map lists the template under `n`. Two templates of
  one role may not end up with the same count;
- `fromImage` and `resources` are written where Agent Sandbox reads them: at the
  top of the template, or inside `template` when the template is in that form;
- each given request or limit replaces that one entry of the template's
  `resources` and keeps the others; `sharedMemory` becomes `gpu.sharedMemory`;
- the result must hold: a request may not exceed its limit (the launch's or the
  template's own), and only a template with `per_gpu_count` may set
  `sharedMemory`;
- the template's shared memory (the launch's `sharedMemory`, or the template's own
  `gpu.sharedMemory` when the launch changes its card count or memory) may not
  exceed the memory it will get: its memory limit, else its memory request, else
  Agent Sandbox's per-card default of `224Gi` times its fewest cards. A launch that
  wants more shared memory than that gives a memory limit as well.

The effective templates are what the run's grant hands Agent Sandbox (and what a
later reissue or extension of the grant uses). Agent Sandbox registers a template's
`resources` and `gpu.sharedMemory` in place of its per-card sizes only from the
release that reads them; an earlier one keeps sizing a GPU template per card.

### Audit

The checked values are recorded on the task, in
`metadata.plugin_overrides = { plugin_id, plugin_version, values }`; an app run
also stores the manifest it actually ran with. The API logs
`plugin_overrides.applied` with the task, plugin, user and the overridden keys
(`sandbox_templates.<name>.<key>` for a template), never the values. For an app run, `overrides` is part of what an
`Idempotency-Key` is bound to; a request without it hashes as before.

---

## 5. Listing Plugins and Their Versions

`GET /v1/plugins` lists **one entry per plugin**, where a plugin is an owner's
name: the latest active version of that (owner, name) the caller may see.
Names are not owned, so two users' plugins called `alpha` are two entries, and
one user's versions never replace or count towards another's. "Latest" is the
version order an upsert uses (the first three dot-separated parts compared by
their leading digits, so `1.10.0` is newer than `1.9.0`; ties go to the most
recently updated row, then the highest id), not the row touched last. A
collapsed entry carries `version_count`: the number of versions of that
(owner, name) the listing covers, which is the active ones unless `status`
says otherwise.

| Query parameter | Effect |
| --------------- | ------ |
| `latest_per_name` | Defaults to `true`. `false` (also `0`, `no`) lists every row (every version), as before this default; `true`, `1`, `yes` collapse; anything else is `400`. |
| `status` | With collapsing, only `active` rows compete unless a status is given; `status=disabled` collapses over disabled rows instead. |
| `include_deleted` | Admins only. Adds deleted rows within the `scope`: with the default `visible` that is deleted public plugins and the admin's own; another user's deleted private plugins need `scope=all` as well. Among the rows that compete (the active ones, unless `status` is given), a deleted version never wins over an undeleted one; it is the entry only when none of the competing versions is undeleted, for example when the plugin's only undeleted versions are disabled. `include_deleted` is honoured only as the exact value `true`. |
| `scope` | Which plugins: `visible` (default) is the public ones plus the caller's own, for admins too; `mine` only the caller's own; `public` only public ones; `all` every plugin, admins only (`403` otherwise). An absent or empty `scope` is `visible`; any other value is `400`. |
| `owner` | Narrows the listing to one owner's plugins (`me` is the caller), inside the `scope`. For an admin this changed with `scope`: `owner=<another user>` alone returns only that user's public plugins; add `scope=all` to include their private ones (as `owner` alone did before `scope` existed). |
| `name_exact`, `name`, `limit`, `offset` | Unchanged. |

The other versions are listed on demand:

```
GET /v1/plugins/:id/versions
```

```json
{
  "ok": true,
  "data": {
    "name": "my-plugin",
    "versions": [
      { "id": 12, "name": "my-plugin", "version": "1.10.0", "status": "active", "is_public": true,
        "owner_user_id": "...", "author": "...", "created_at": "...", "updated_at": "...", "deleted_at": null }
    ]
  }
}
```

Versions are those of the same owner and name as `:id`, newest first, and only
those the caller may see; deleted versions are left out (an admin may pass
`include_deleted=true`). The route answers `404`
or `403` exactly as `GET /v1/plugins/:id` does for the same id. Every version
keeps its own id, and every other route (`GET`, `PATCH`, `DELETE`, launches)
still addresses a plugin by id.

---

## 6. Temporary Plugins

A plugin registered for one run (an eval, a probe, a smoke test) can expire on
its own instead of staying in every listing until someone deletes it.

Plugin writes (`POST /v1/plugins`, `POST /v1/plugins/upsert`,
`PUT`/`PATCH /v1/plugins/:id`, `POST /v1/plugins/:id/new-version`) accept one of:

| Field | Meaning |
| ----- | ------- |
| `ttl_seconds` | Expire this many seconds from now. |
| `expires_at` | Expire at this ISO 8601 instant. |

Either must land from 60 seconds to `PLUGIN_TTL_MAX_DAYS` (default 30) days
from now; giving both is refused. `null` for either clears the expiry and makes
the plugin permanent. Every plugin read returns `expires_at` (`null` when
permanent).

- **Never public.** A temporary plugin is private by default; asking for
  `is_public: true` together with an expiry, making a temporary plugin public, or
  giving a public plugin an expiry is `400`. Clear the expiry first to publish.
- **New versions** inherit the source version's `expires_at` unless the request
  names its own (or `null`).
- **Past `expires_at`** a new task, batch, app run, retry, session message
  (including a session's first message and a message to an Anthropic-compatible
  session) or DAG template naming the plugin is refused: `404 plugin_not_found`,
  the same answer as for a plugin that does not exist or is another user's
  private one (a DAG template write is `400`, a retry `409 not_retryable`; an
  app run naming another user's private plugin keeps its existing `403
  plugin_access_denied`). Workbench runs refuse a gone plugin the same way. An A2A request naming it runs as
  if the plugin were deleted (no tools), as A2A already treats a plugin the
  caller cannot see. Work admitted before the expiry keeps running.
- **The sweep.** Every `PLUGIN_EXPIRY_SWEEP_INTERVAL_MIN` (default 5) minutes
  the API soft-deletes (`deleted_at`) every private plugin whose `expires_at` is
  more than 10 minutes past, except one that is still in use: an unfinished
  task, a live app run, a queued message or a live DAG template that names it.
  That one expires on a later pass, once the use is over. An admission in
  flight holds the plugin row until it commits, and the sweep skips a held row,
  so a plugin is never deleted under a run being created. The API logs
  `plugin.expired` for each.

Eval and probe tooling that registers plugins should set `ttl_seconds`, for
example a day for a nightly run:

```bash
curl -X POST "$CLAW/v1/plugins/upsert" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"probe-2026-11-11","version":"0.1.0","ttl_seconds":86400}'
```

---

## 7. App Manifest: Read-Only Host Directories in Sandbox Templates

A sandbox template of an app manifest (`resource.app.manifest.sandbox_templates[]`)
can mount directories of its workspace's storage read-only with `host_mounts`,
in a sandbox created without the workspace's storage
(`"workspaceStorage": "off"`) or with all of it read-only
(`"workspaceStorage": "readOnly"`, see below). The typical use is a cache the
application publishes through the workspace's own read-write mount while the
sandboxes it starts from the template may only read it:

```json
{
  "name": "measurement",
  "fromImage": "registry.example.invalid/measure@sha256:...",
  "per_gpu_count": [1, 8],
  "workspaceStorage": "off",
  "host_mounts": [
    { "hostPath": "/shared/team/cache", "readOnly": true }
  ]
}
```

| Key | Required | Meaning |
| --- | -------- | ------- |
| `hostPath` | yes | The host directory, mounted at the same path in the sandbox. |
| `mountPath` | no | When given, must equal `hostPath`: the sandbox workload mounts a host path at its own path and has no field for another one. |
| `readOnly` | yes | Must be `true`. |

Checked when the manifest is registered and on every app run. Registration
here is every plugin write that carries `resource`: `POST /v1/plugins`,
`POST /v1/plugins/upsert`, `PUT`/`PATCH /v1/plugins/:id` and
`POST /v1/plugins/:id/new-version` (a new version that keeps its source's
`resource` is checked too). A write whose `resource.app.manifest` fails any
static check of the manifest, these among them, is refused with
`422 app_manifest_invalid` and the `issues` (each a `path` and a `reason`, at
most 20), the body an app run of that manifest would get, and nothing is
written. A write without `resource`, or whose `resource` has no `app`, is not
checked.


- At most 8 mounts per template, no path twice, no other key.
- `workspaceStorage`, wherever a template sets it, is `"on"`, `"off"` or
  `"readOnly"` (anything else is refused: "must be one of ...").
- A template with `host_mounts` sets `workspaceStorage` to `"off"` or
  `"readOnly"` where Agent Sandbox reads the template: in the nested
  `template` when that carries the `fromImage`, else at the template's top.
  Every path a mount may name lies under a directory the workspace mounts into
  its sandboxes, read-write where it allows writes; with that mount in the
  sandbox the directory would stay writable through its parent, and a
  read-only mount beneath it would protect nothing. Left out, `"on"`, or set
  only beside a nested template, it is refused
  (`sandbox_templates[i].workspaceStorage` or
  `sandbox_templates[i].template.workspaceStorage`: "must be \"off\" or
  \"readOnly\" in a template with host_mounts").
- `readOnly: true` only: the sandbox workload mounts every host path it is
  given read-only, so `readOnly: false` could not be kept.
- `hostPath` is absolute and normalised: no `.` or `..` segment, no `//`, no
  trailing `/`, not `/`, and none of `:`, `,`, a blank or a control character
  (the container runtimes' bind syntax cannot carry them). It is not, is not
  under, and does not contain a system directory (`/bin`, `/boot`, `/dev`,
  `/etc`, `/lib*`, `/proc`, `/root`, `/run`, `/sbin`, `/sys`, `/tmp`, `/usr`,
  `/var/lib`, `/var/run`, `/var/tmp`; so not `/var` either).
- A template's own Agent Sandbox `volumes` (flat or in a nested `template`)
  may not be `hostPath` volumes (other sources pass through as before), and
  neither they nor its `volumeMounts` may use a name starting with
  `template-mount-`; `volumes`,
  `volumeMounts`, `template`, `fromImage`, `image`, `workspace`,
  `workspaceStorage`, `resources` (with its `requests` and `limits`) and
  `gpu` (with its `sharedMemory`) must be spelt exactly (Agent Sandbox matches field names case-insensitively).
  Every key of a template, at any depth, must be ASCII: Agent Sandbox's JSON
  decoder folds some other letters onto ASCII ones (`ſ`, U+017F, is `s`; `K`,
  U+212A, is `k`), so `volumeſ` would reach it as `volumes`. No object of a
  template, at any depth, may have two keys that differ only in case: the
  decoder keeps the last, so `"workspace":"W2","Workspace":"W1"` would be
  checked against W2 and run in W1. `host_mounts` is the only way a template
  reaches a host path.

Checked only when an app run is created, as the caller, because the workspace
a sandbox runs in (and so the directories it grants) is known only then, and a
plugin registered today may run in a workspace whose volumes change later: a
mount outside every workspace directory is therefore stored at registration
and refused at the run. Every `hostPath` must lie
under a directory the template's workspace (the template's `workspace`, else the
run's `sandbox_workspace`) already mounts for sandboxes, read from the
workspace's `volumes`. A `hostpath` volume declares its `hostPath` joined with
its `subPath` when it applies to the `Sandbox` scope and does not set
`requiresPrivilegedGrant`; one with `enableUserDir` declares only the
directories under it other than `users`. Otherwise the run is refused with
`403 sandbox_template_mount_not_granted` and the field of each mount that is not
granted. A plugin therefore never reaches a host path its workspace does not
already give its sandboxes. The check is lexical; a symlink under the
workspace root is resolved where the path is mounted, which stays inside the
root: SaFE mounts the declared root and reaches the path through `subPath`
(the kubelet refuses a `subPath` that escapes it), and on an external node the
provider opens the path without following symlinks. `host_mounts` cannot be changed by run-time
`overrides`.

The grant hands each mount to Agent Sandbox as a `hostPath` volume
(`template-mount-<i>`, type `Directory`) and a `readOnly: true` volume mount at
the same path, after the template's own `volumes` and `volumeMounts`. Agent
Sandbox refuses to issue or extend a grant whose template has a hostPath
volume that is not a clean absolute path, is a system directory (or under or
above one), is mounted anywhere but read-only at its own path, or is mounted by
a sidecar, whose `workspaceStorage` is none of `on`, `off` and `readOnly`, or
whose template has a hostPath volume and does not set `workspaceStorage` to
`off` or `readOnly`. It checks the decoded template, so it sees a
hostPath volume however its keys were spelt, and it refuses a template spec in
which one object has two keys its decoder reads as one. It also refuses to
create a sandbox from a grant's template that reaches it with host paths and
the workspace's storage on (a CodeInterpreter schema older than
`workspaceStorage` drops the field), rather than create it with a
read-write parent over its read-only mounts.

**Without the workspace's storage (`"off"`).** Agent Sandbox creates the sandbox's SaFE
Workload with `primus-safe.workload.use.workspace.storage: "false"`, and SaFE
mounts none of the workspace's volumes into it: the sandbox sees each
`host_mounts` directory read-only at its own path, and no other directory of
the workspace's storage. A write under one fails with `EROFS`
(`Read-only file system`), and there is no parent mount to write it through.
Whatever else the sandbox must read from the workspace's storage (a model
directory, say) is another `host_mounts` entry; what it produces it writes to
its own file system and returns through the sandbox API, not to the
workspace's storage. On nodes outside the cluster (SaFE external execution) a
mount below a workspace volume's root needs SaFE's
`external_execution.user_dir_mounts`; without it SaFE refuses the Workload. A
nested read-only mount under a read-write workspace mount is refused outright
by the sandbox platform's pod admission on such nodes (a mount point resolved
through a writable share can be redirected by what is written there), which is
why a template with `host_mounts` may not leave the storage on.

**The workspace's storage read-only (`"readOnly"`).** Agent Sandbox creates the
sandbox's SaFE Workload with
`primus-safe.workload.workspace.storage.readonly: "true"`, and SaFE mounts the
whole of the workspace's storage read-only, init containers included, with no
user directory: the per-user directory SaFE otherwise mounts read-write
(`users/<id>` of a volume with `enableUserDir`) is not mounted, and nothing of
the workspace's storage is writable from the sandbox. It suits a sandbox that
reads much of the workspace's storage (models, datasets, caches) and must not
change any of it; the `host_mounts` such a template would list are already
visible read-only, so leave them out (a mount point below the workspace's
mount can still be refused by the pod admission of nodes outside the cluster).

- Per-user directories nested under the storage (`users/<id>`, a per-user
  scratch directory) are not used in this mode: on nodes whose platform still
  lays them over the workspace's mount they are read-only like the rest, and
  nothing the sandbox writes reaches them.
- Never put a store several people or sandboxes share under a `users/<id>`
  directory: a sandbox that does not mount that user's directory cannot see
  it, and in this mode none is mounted at all.
- Enabling it requires the consumer to keep all its writes on local disk (the
  container's own file system, an `emptyDir`, or the sandbox's working
  directory): a tool that stages, caches or logs under the workspace's storage
  fails with `EROFS` (`Read-only file system`). Check the first load of every
  dataset and model the sandbox reads (library caches default to paths under
  home or the workspace) before switching a template.
- Roll it out per template, with a canary: switch one template, run it on
  each kind of node it lands on (in the cluster and outside it), check
  `/proc/mounts` shows the workspace's mount `ro` and that the workload passes,
  and only then switch the next. The annotation name is SaFE's: a SaFE that
  does not yet know it mounts the storage read-write as before, so confirm the
  deployed SaFE supports it before relying on it.
