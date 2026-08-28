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
