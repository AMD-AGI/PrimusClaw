# PrimusClaw Execution Template Design

> Status: Draft v1.0 (pending review)
> Scope: **Complete specification** for Claw Execution Templates (supersedes the initial version in [architecture-design.md §17](./architecture-design.md))
> Purpose: Provide a unified "execution environment contract" and audit asset for Sessions and AgentTeam
> Related: [architecture-design.md §17](./architecture-design.md) (initial definition), [agent-team-design.md](./agent-team-design.md) (primary downstream consumer)

---

## 0. Scope Boundary

| Boundary | Ownership | Description |
|---|---|---|
| Execution template schema / Registry / CRUD / Injection | This document | Single source of truth |
| Team Spec topology and team orchestration (delegate/wait/compose) | `agent-team-design.md` | Execution templates do not define team topology |
| Role capability field source | This document | Roles only reference `template_id`, no inline capability fields allowed |
| Public template queries | This document `GET /v1/templates` | For users and frontend |
| Internal template queries | This document `GET /internal/templates` | Only used by Brain tool `list_templates` |

**Override Rules (Hard Constraints)**
- Session requests and Team Spec must not override template security fields (tools/rules/hooks/sandbox/A2A binding/limits).
- AgentTeam only consumes template capabilities and does not inversely define template fields; in case of conflict, this document's schema and validation rules take precedence.
- External interface naming and field changes must be updated in this document first, then the AgentTeam document follows with updated references.

### 0.1 Unified Glossary (Aligned with AgentTeam Document)

| Term | Definition | Single Source |
|---|---|---|
| **Execution Template** | Execution contract for a single session (engine/model/tools/rules/hooks/sandbox/A2A/limits) | This document |
| **Template Registry** | Execution template loading and query layer (FS+DB+visibility filtering) | This document |
| **Team Spec** | Team topology contract (leader/roles/max_parallel/on_leader_fail/a2a_entry) | `agent-team-design.md` |
| **Static Team Template** | Pre-compiled YAML snapshot of Team Spec (`deploy/team-templates/*.yaml`) | `agent-team-design.md` |
| **Dynamic Compose** | Leader instantiates Team Spec at runtime via `compose_team(spec)` | `agent-team-design.md` (capability switch fields in this document) |
| **Worker Capability** | Final available capability set of a Worker | Determined by the Execution Template referenced by the Worker |
| **A2A Worker** | Remote worker execution path with `type=a2a` | Protocol in AgentTeam document, template fields in this document |

---

## 1. Background and Goals

### 1.1 Requirements

In PrimusClaw, the configuration for "a single execution" spans multiple dimensions: Engine/Model, Tools, Rules, Hooks, System Prompt, Sandbox, resource quotas, A2A bindings, etc. If maintained separately, issues arise:

- Audit asset drift (same role configured with different tools in different teams)
- LLM bypassing security fields via prompt injection
- Sessions and AgentTeam Workers unable to share configurations
- Difficulty for newcomers to understand "why this execution can run this tool"

**Execution Template** is the single concept to solve this: bundle all the above fields into a **reusable, auditable atomic unit**, referenced by Sessions / AgentTeam Workers.

### 1.2 Goals

1. A single schema covering both Session execution and AgentTeam Worker execution
2. All security-sensitive fields centrally audited; Team Spec / Session cannot override them
3. Support both system-level (FS pre-configured, ops audited) and user-level (DB, API CRUD) templates
4. Extensible to A2A remote Workers without creating a new schema
5. Fully compatible with existing Skills / MCP / Rules / Marketplace Tools system; no new execution mechanisms introduced

### 1.3 Relationship with architecture-design.md §17

| Dimension | §17 Initial Version | This Document vFinal |
|---|---|---|
| Schema fields | engine/model/tools/rules/hooks/system_prompt | This document + sandbox/subagent/limits/A2A binding/dynamic compose switch |
| Registry | DB only | **FS + DB two layers** |
| Source visibility | Global / user private | System / global / user private |
| A2A type | Not covered | First-class citizen (`type: a2a`) |
| AgentTeam adaptation | Not covered | Primary downstream |

This document **supersedes** all content in §17 sections 17.1~17.9; §17 is retained as historical context.

---

## 2. Design Principles

1. **Single execution contract**: All configuration for a single execution must come from one execution template + request-level overrides (optional, restricted).
2. **Centralized field auditing**: Security-sensitive fields only appear in templates; downstream consumers cannot override.
3. **No new execution mechanisms**: Fully reuse Skills prompt channel, Hands MCP `callTool()`, existing marketplace tool loading logic.
4. **System/user layering**: System templates use FS + PR review; user templates use DB + API CRUD.
5. **Explicit type**: `type: local | a2a` determines schema validation branch and execution path; no implicit inference.
6. **Forward-compatible with AgentTeam**: All fields needed by AgentTeam Workers are included as first-class citizens in the schema, not as extension fields.

---

## 3. Core Architecture

```
                    ┌───────── Template Sources ─────────┐
                    │                            │
         deploy/execution-templates/*.yaml       │
                    │                    claw_templates table (DB)
                    ▼                            ▼
            ┌────────────────────────────────────────┐
            │   Template Registry (API in-process memory) │
            │   - FS loader (system templates)           │
            │   - DB loader (user/global templates)      │
            │   - Validation, merging, visibility filter  │
            │   - Hot reload (SIGHUP / ConfigMap watch)   │
            └─────────────┬──────────────────────────┘
                          │
                          │ GET/PUT via API
                          │
              ┌───────────┼───────────────┐
              │           │               │
              ▼           ▼               ▼
       Session creation  Team Spec       Brain list_templates
       (template_id)     validation      (dynamic compose tool)
              │          (role.template)
              └─────┬─────┘
                    │ Injection
                    ▼
             ExecuteRequest
              {tools, rules_text, hooks, model,
               system_append, sandbox_image, limits, ...}
                    │
                    ▼
              Brain agent-loop
```

---

## 4. Template Schema

### 4.1 Complete Schema (TypeScript)

```ts
// packages/protocol/src/execution-template.ts
export interface ExecutionTemplate {
  // === Basic Metadata ===
  template_id: string;                  // Primary key, kebab-case, globally unique
  name: string;                         // Display name
  description?: string;
  version: string;                      // semver, default "1.0.0"
  source: "system" | "global" | "user"; // Populated by loader, not hand-writable
  user_id?: string;                     // Required when source=user
  tags?: string[];                      // Optional, for list_templates filtering

  // === Type Branch ===
  type: "local" | "a2a";                // Required

  // === Local Type Fields (type="local") ===
  engine_type?: "claude";                    // Brain is Claude-only; codex/pi engines removed. Default claude
  model?: string;                            // If empty, Brain default is used
  sandbox_image?: string;                    // null = default Hands image; non-null = GPU or custom
  subagent_type?: "explore" | "readonly" | "shell" | "generalPurpose";  // Reuse sub-agent profile
  tools?: TemplateTool[];                    // See §4.2
  rules?: TemplateRule[];                    // See §4.3
  hooks?: {                                  // See §4.4
    pre?: ToolHookCall[];
    post?: ToolHookCall[];
    on_error?: ToolHookCall[];
  };
  system_prompt?: string;                    // Appended to system message

  // === A2A Type Fields (type="a2a") ===
  peer?: string;                             // Corresponds to id in A2A_PEERS
  skill_id?: string;                         // Skill declared in external Agent Card
  auth_env?: string;                         // Override peer default credentials

  // === Resource Quotas (both types) ===
  max_runtime_ms?: number;                   // Default 3600_000
  max_tokens_per_run?: number;               // Default 2_000_000

  // === Capability Switches (both types) ===
  allow_a2a_out?: boolean;                   // Default false; allow this template's agent to call a2a_call
  allow_dynamic_compose?: boolean;           // Default false; allow compose_team when used as AgentTeam Leader

  // === Audit ===
  created_at: string;
  updated_at: string;
}

export type TemplateTool =
  | { type: "builtin"; names: string[] }
  | { type: "mcp"; name: string; config: Record<string, unknown> }
  | { type: "marketplace"; id: number; name?: string };

export type TemplateRule =
  | { type: "text"; content: string }
  | { type: "skill"; name: string };

export interface ToolHookCall {
  type: "tool";
  name: string;                              // Hands tool name (bash/read/write/...)
  args: Record<string, unknown>;
  on_fail?: "abort" | "warn" | "continue";   // Default abort (pre) / warn (post/on_error)
}
```

### 4.2 `tools` Field

| type | Meaning | Merge Behavior |
|---|---|---|
| `builtin` | Hands built-in tools (bash/read/write/grep/...) | Deduplicate and merge with other builtins |
| `mcp` | External MCP server | Deduplicate by `name`; template overrides request on name collision |
| `marketplace` | Marketplace registered tool ID | Append to `tool_ids[]` |

During merging, global DENY_LIST (`task` / `save_memory` / `save_skill` / `upload_to_s3` / `download_from_s3`, etc.) always applies.

### 4.3 `rules` Field

Follows existing design: `text` injected directly; `skill` loads SKILL.md content for injection. Both concatenated into `rules_text`, appended to system prompt.

**New constraint**: `rules[].content` max 4096 characters; `skill` reference must exist (load failure → template load failure, no silent degradation).

### 4.4 `hooks` Field

Follows existing design's hard/soft hook distinction:

- **Hard hooks** (this field): Brain forcefully calls Hands MCP `callTool()`, LLM cannot skip
- **Soft hooks**: Written as `rules` injected via prompt (LLM may ignore)

**New constraints**:
- `type: a2a` templates **cannot** define `hooks.pre` / `hooks.post` / `hooks.on_error` (no local Hands to call); validation fails at load time
- When `on_fail: "abort"`, pre/post hook failure causes the entire run to fail with `exec_complete.failed=true`
- Hooks have independent timeout `DEFAULT_HOOK_TIMEOUT_MS=60000`, overridable by hook's `args.timeout`

### 4.5 Resource Quotas

| Field | Enforcement Point | Over-Limit Behavior |
|---|---|---|
| `max_runtime_ms` | Brain agent-loop abortCtrl timeout | signal.abort() → exec_complete.failed |
| `max_tokens_per_run` | agent-loop cumulative token monitoring | Reached → stop next turn → exec_complete.failed=true, reason=token_budget |

### 4.6 Capability Switches

| Field | Meaning |
|---|---|
| `allow_a2a_out` | Whether `a2a_call` / `a2a_stream` / `a2a_list_peers` appear in tool schemas for this template's associated session's agent-loop |
| `allow_dynamic_compose` | Whether `compose_team` / `list_templates` are injected when used as AgentTeam Leader |

Both default to `false`, explicitly **declared** by the template to enable; reduces audit complexity.

### 4.7 Complete YAML Examples

```yaml
# deploy/execution-templates/gpu-pytorch.yaml
template_id: gpu-pytorch
name: "GPU PyTorch (ROCm)"
description: "Sandbox with PyTorch/ROCm for GPU training."
version: 1.0.0

type: local
engine_type: claude
model: claude-sonnet-4-20250514
sandbox_image: rocm-pytorch:latest
subagent_type: generalPurpose

tools:
  - type: builtin
    names: [bash, read, write, edit, grep, glob, ls]
  - type: marketplace
    id: 42
    name: hf-hub-cli

rules:
  - type: text
    content: "Always use mixed precision (bf16 or fp16) when training on ROCm."
  - type: skill
    name: pytorch-best-practices

hooks:
  pre:
    - { type: tool, name: bash, args: { command: "nvidia-smi || rocm-smi" }, on_fail: warn }
  post:
    - { type: tool, name: bash, args: { command: "rm -rf /tmp/ckpt_*" } }

system_prompt: |
  You are a senior PyTorch training engineer. Prefer deterministic runs.

max_runtime_ms: 7200000            # 2h
max_tokens_per_run: 4000000
allow_a2a_out: false
allow_dynamic_compose: false
```

```yaml
# deploy/execution-templates/a2a-ci-lint.yaml
template_id: a2a-ci-lint
name: "CI Lint (external A2A)"
type: a2a

peer: ci
skill_id: lint-ts
auth_env: A2A_PEER_TOKEN_CI

max_runtime_ms: 600000
```

```yaml
# deploy/execution-templates/team-leader.yaml
template_id: team-leader
name: "AgentTeam Leader"
type: local
engine_type: claude
model: claude-sonnet-4-20250514
tools:
  - type: builtin
    names: [read, grep, glob, ls]
system_prompt: "You are an orchestrator. Use delegate_to_worker / team_wait to coordinate."
allow_dynamic_compose: true
max_runtime_ms: 3600000
```

---

## 5. Registry (Two-Layer Storage)

### 5.1 Storage Model

| Source | Physical Location | `source` | Visibility | Change Method |
|---|---|---|---|---|
| System templates | `deploy/execution-templates/*.yaml` | `system` | Visible to all users | PR review, ops apply |
| Global user templates | `claw_templates` table, `user_id=NULL` | `global` | Visible to all users | API CRUD (admin) |
| User private | `claw_templates` table, `user_id=X` | `user` | Visible only to that user | API CRUD (user) |

### 5.2 DB Schema

```sql
CREATE TABLE claw_templates (
  template_id   TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  version       TEXT NOT NULL DEFAULT '1.0.0',
  user_id       TEXT,                          -- NULL = global
  type          TEXT NOT NULL,                 -- local | a2a
  engine_type   TEXT,
  model         TEXT,
  sandbox_image TEXT,
  subagent_type TEXT,
  tools         JSONB DEFAULT '[]',
  rules         JSONB DEFAULT '[]',
  hooks         JSONB DEFAULT '{}',
  system_prompt TEXT,
  peer          TEXT,
  skill_id      TEXT,
  auth_env      TEXT,
  max_runtime_ms           BIGINT,
  max_tokens_per_run       BIGINT,
  allow_a2a_out            BOOLEAN DEFAULT false,
  allow_dynamic_compose    BOOLEAN DEFAULT false,
  tags          JSONB DEFAULT '[]',
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_templates_user ON claw_templates(user_id);
CREATE INDEX idx_templates_type ON claw_templates(type);
```

**Constraints**:
- `template_id` matches `^[a-z][a-z0-9-]{0,47}$`
- System template (FS) `template_id` must not conflict with DB; startup error on conflict
- When `type='a2a'`, `tools/rules/hooks/system_prompt/sandbox_image/...` must be NULL or default (see §4.4 constraints)

### 5.3 Loading Flow

```
API Startup:
  ├─ loadSystemTemplates(): Scan deploy/execution-templates/*.yaml → validate → in-memory Map
  ├─ loadDBTemplates():     SELECT * FROM claw_templates → validate → in-memory Map
  ├─ Conflict detection: Same template_id → error exit
  └─ Subscribe to hot reload:
        - SIGHUP: Re-run loadSystemTemplates + loadDBTemplates
        - ConfigMap watch (K8s deployment): kubelet fsnotify → SIGHUP self-trigger
        - DB changes: API's POST/PUT/DELETE endpoints update memory + broadcast NATS core subject
          `template.invalidate.<template_id>` for other API instances to sync
```

### 5.4 Visibility Resolution

```ts
function resolveTemplate(tpl_id: string, user_id: string | null): ExecutionTemplate | null {
  const t = registry.get(tpl_id);
  if (!t) return null;
  switch (t.source) {
    case "system":
    case "global": return t;
    case "user":   return t.user_id === user_id ? t : null;
  }
}
```

Brain-side `list_templates()` tool returns must pass through this filter to prevent users from seeing others' private templates.

---

## 6. Injection Flow

### 6.1 Session Creation

```
POST /v1/sessions { template_id: "gpu-pytorch" }
  ├─ resolveTemplate(template_id, req.user_id)
  ├─ Validation passes → write claw_sessions.template_id = "gpu-pytorch"
  └─ Return session_id
```

### 6.2 Message Submission

```
POST /v1/chat/sessions/{id}/messages { content: "..." }
  ├─ session = db.getSession(id)
  ├─ template = resolveTemplate(session.template_id, req.user_id)
  ├─ buildExecutionContext():
  │     a. tools = merge(template.tools, request.tools) (uses existing resolve-tools logic)
  │     b. rules_text = render(template.rules)
  │     c. system_append = template.system_prompt
  │     d. hooks = template.hooks (empty {} for a2a type)
  │     e. model = request.model ?? template.model
  │     f. sandbox_image = template.sandbox_image
  │     g. max_runtime_ms / max_tokens_per_run = template fields
  │     h. a2a binding (for type=a2a) = { peer, skill_id, auth_env }
  └─ Construct ExecuteRequest → submit NATS task
```

### 6.3 ExecuteRequest Extension (New Fields)

```ts
// packages/protocol/src/types.ts incremental
export interface ExecuteRequest {
  // ...existing fields...

  // Injected from Template
  rules_text?: string;
  system_append?: string;
  hooks?: {
    pre?: ToolHookCall[];
    post?: ToolHookCall[];
    on_error?: ToolHookCall[];
  };
  sandbox_image?: string;          // existing
  max_runtime_ms?: number;
  max_tokens_per_run?: number;

  // Capability bits (affect resolve-tools)
  allow_a2a_out?: boolean;
  allow_dynamic_compose?: boolean;

  // A2A type session
  a2a_binding?: {
    peer: string;
    skill_id: string;
    auth_env?: string;
  };
}
```

### 6.4 Brain-Side Consumption

| Field | Consumption Point |
|---|---|
| `rules_text` + `system_append` | `agent/prompt.ts` concatenates into system message |
| `hooks` | `engines/*` execute() forcefully calls `callTool()` before/after (see §4.4) |
| `sandbox_image` | `ensureHands()` takes GPU template path |
| `max_runtime_ms` | `agent-loop` starts timeout abortCtrl |
| `max_tokens_per_run` | `agent-loop` cumulative token monitoring |
| `allow_a2a_out` | `resolve-tools` decides whether to inject a2a_* tools |
| `allow_dynamic_compose` | `resolve-tools` decides whether to inject compose_team / list_templates (effective for AgentTeam Leader) |
| `a2a_binding` | Brain takes a2a branch: no ensureHands, directly calls external peer via a2a_client |

---

## 7. API

```
POST   /v1/templates              # Create (system source rejected)
GET    /v1/templates              # List: ?type=&tags=&owner=me|global
GET    /v1/templates/{id}         # Details (sensitive fields redacted: auth_env only returned for admins)
PUT    /v1/templates/{id}         # Update (system source rejected)
DELETE /v1/templates/{id}         # Delete (system source rejected; rejected when referenced, unless ?force=true)

GET    /internal/templates        # Brain internal query (used by list_templates)
                                   # query: ?type=&tags=&restrict_to=tpl1,tpl2
                                   # headers: Authorization: Bearer <INTERNAL_API_TOKEN>

POST   /v1/sessions               # body: { template_id }
```

**Authentication**:

| Operation | Permission |
|---|---|
| Read system / global | Any logged-in user |
| Read user | Owner only |
| Write user | Owner only |
| Write global | Admin (`roles` includes `admin`) |
| Write system | **Forbidden** (only via PR) |
| `GET /internal/templates` | Internal service only (`INTERNAL_API_TOKEN`) |

**Sensitive field redaction**:
- `auth_env` name returns `"***"` for non-admins (prevents exposing env var names as probing vectors)
- Fields in `tools[type=mcp].config` matching `/token|secret|password|key/i` are masked

---

## 8. Permissions and Security

| Control Point | Rule |
|---|---|
| System template source | Only `deploy/execution-templates/*.yaml`; PR review; K8s ConfigMap mounted read-only |
| User template `tools` whitelist | Global DENY_LIST enforced; allowed list controlled by env `TEMPLATE_USER_ALLOWED_TOOLS`, excludes `bash`/`write`/`edit` and other high-privilege tools by default (user side only allows read-only tools) |
| User template `sandbox_image` | Custom images disabled by default; only users with `admin` role can set, and must be ∈ `TEMPLATE_ALLOWED_IMAGES` whitelist |
| User template `hooks` | User-side disabled by default (hooks can bypass prompt-layer constraints); requires admin role |
| User template `allow_a2a_out` / `allow_dynamic_compose` | User-side disabled by default; requires admin role |
| A2A peer reference | Must be ∈ `A2A_PEERS` whitelist; validated at load time |
| Request-level overrides | `rules`/`hooks`/`tools` in `POST /messages` body **ignored** (only non-security fields like `prompt`/`model` can be overridden); template is the single source of truth |
| Prompt injection | `rules[].content` is hardcoded in template, cannot be appended at runtime; `system_append` likewise |
| Template reference counting | +1 on Session/Team creation, -1 on completion; refuses deletion when reference > 0 (unless force) |

---

## 9. Integration with AgentTeam

### 9.1 Interface Contract

AgentTeam (see [agent-team-design.md](./agent-team-design.md)) consumes capabilities defined in this document in the following ways:

| AgentTeam Need | Execution Template Provides |
|---|---|
| Team Spec `role.template` reference | `template_id` + Registry resolveTemplate |
| `list_templates()` tool | `GET /internal/templates` (internal endpoint, server-side visibility filtering) |
| `compose_team(spec)` validation | Registry existence validation + `allow_dynamic_compose` bit |
| Worker Session runtime environment | Template injection (§6) |
| A2A Worker binding | `type: a2a` + peer/skill_id/auth_env |
| Leader can call `a2a_call` | `allow_a2a_out=true` |
| Leader can dynamically compose teams | `allow_dynamic_compose=true` |

### 9.2 Strong Constraints on References in Team Spec

- `leader.template` / `roles[].template` must exist and be visible to current user
- Team Spec **must not** contain template fields (tools/rules/hooks/sandbox_image/...); API validation failure rejects
- Multiple Workers in the same team can reference the same template (each with independent Hands sandbox)

### 9.3 AgentTeam-Specific Constraints Not in This Document

- `max_parallel` hard cap, dynamic compose window, Kanban-related items maintained by AgentTeam document
- This document only guarantees the template schema can be correctly referenced by teams

---

## 10. Lifecycle

```
Template loading (startup)
  └─ FS + DB → Registry → validation → ready

Template usage (runtime)
  ├─ Session creation: bind template_id
  └─ Message: resolveTemplate → inject → ExecuteRequest

Template changes (hot reload)
  ├─ PUT /v1/templates/{id}: DB update → broadcast invalidate → each API instance re-reads that id
  ├─ SIGHUP / ConfigMap watch: Rescan FS + DB
  └─ Currently executing sessions: **no hot-swap** (uses load-time snapshot, avoids mid-flight switching)

Template deletion
  ├─ Reference count > 0: rejected (force can override)
  └─ After deletion, resolveTemplate returns null; new Session creation fails
```

---

## 11. Key Design Decisions (ADR)

| ID | Decision | Choice | Rationale |
|---|---|---|---|
| T1 | Whether schema unifies Session/Team | Unified | Single source of truth after merging; zero difference between AgentTeam/Session |
| T2 | Registry layers | FS (system) + DB (user/global) two layers | System uses PR review; user uses API CRUD |
| T3 | Whether `type: local|a2a` is explicit | Explicit | Clear validation branches; avoids field-based inference |
| T4 | Whether A2A type templates allow hooks | No | No local Hands; validation fails at load time |
| T5 | Whether request-level can override template security fields | No | Template is the sole source of truth; request can only pass prompt/model |
| T6 | Whether users can customize high-privilege fields | No, requires admin | Least privilege; ops auditable |
| T7 | Whether running sessions hot-swap | No | Uses load-time snapshot to avoid semantic drift |
| T8 | Deleting templates with references | Rejected (force can bypass) | Avoid dangling references; maintain ops escape hatch |
| T9 | `auth_env` display | Masked for non-admins | Prevents env var names from being used as probing vectors |
| T10 | Version field | semver string, no automatic migration in this version | Keep v1 simple; design multi-version coexistence later |

---

## 12. Risks and Boundaries

| Risk | Mitigation |
|---|---|
| Wide impact of template changes | Reference counting + change log + hot reload doesn't affect in-progress sessions |
| User template abuse | Whitelisted tool set + admin approval for high-privilege fields |
| FS and DB conflict | Strong validation at startup; exit and alert on same id |
| Template Registry memory growth | Expected < 1000 entries; full rebuild on hot reload; single entry < 4KB compressed |
| `allow_a2a_out` accidentally enabled | Whitelisted peers still have hard constraints (outbound host whitelist) |
| Users seeing others' private templates | `resolveTemplate` strong visibility filtering + `list_templates` second-pass filtering + SQL WHERE triple guarantee |
| Hooks timeout dragging down sessions | Each hook has independent timeout (default 60s); `on_fail=abort` fails fast |
| Marketplace tool dependency | Referenced marketplace id must exist, validated at startup; runtime loss degrades to warn |

---

## 13. Change List

### 13.1 New Files

| File | Responsibility |
|---|---|
| `packages/protocol/src/execution-template.ts` | Type definitions (`ExecutionTemplate` / `TemplateTool` / `TemplateRule` / `ToolHookCall`) |
| `packages/api/src/templates/registry.ts` | Two-layer Registry: FS loader + DB loader + visibility filtering + hot reload |
| `packages/api/src/templates/validator.ts` | Schema validation (including a2a type branch constraints) |
| `packages/api/src/templates/injector.ts` | `buildExecutionContext()`: Template → ExecuteRequest field injection |
| `packages/api/src/routes/templates.ts` | `/v1/templates` CRUD + `/internal/templates` internal query routes |
| `deploy/execution-templates/*.yaml` | Built-in system templates (team-leader / cpu-shell / readonly / gpu-pytorch / a2a-ci-lint, etc.) |
| `docs/execution-template-design.md` | This document |

### 13.2 Modified Files

| File | Changes |
|---|---|
| `packages/protocol/src/types.ts` | `ExecuteRequest` adds `rules_text / system_append / hooks / max_runtime_ms / max_tokens_per_run / allow_a2a_out / allow_dynamic_compose / a2a_binding` |
| `packages/api/src/infra/db.ts` | `claw_templates` table migration; `claw_sessions` add `template_id` field |
| `packages/api/src/routes/sessions.ts` | Accept and persist `template_id` |
| `packages/api/src/routes/chat.ts` | Message path calls `injector.buildExecutionContext()` to inject template |
| `packages/api/src/infra/nats.ts` | Subscribe to `template.invalidate.*` for cross-instance sync |
| `packages/brain/src/agent/agent-loop.ts` | Consume `rules_text / system_append / hooks / limits` |
| `packages/brain/src/tools/resolve.ts` | Conditionally inject tools based on `allow_a2a_out / allow_dynamic_compose` |
| `packages/brain/src/engines/*.ts` | Execute pre/post/on_error hooks (see §4.4) |
| `packages/brain/src/agent/prompt.ts` | Concatenate `rules_text` and `system_append` into system message |

### 13.3 Engineering Split (PR Granularity)

| # | PR | Content | Dependencies |
|---|---|---|---|
| 1 | T-PR-1 Schema & DB | execution-template.ts / db migration / types.ts extension / validator (5 files) | — |
| 2 | T-PR-2 Registry | registry.ts / nats invalidate subscription / routes/templates.ts (CRUD + /internal/templates) / sessions route extension / injector.ts skeleton (5 files) | T-PR-1 |
| 3 | T-PR-3 Brain Consumption | agent-loop / resolve-tools / engines hooks / prompt / brain/index (5 files) | T-PR-1 |
| 4 | T-PR-4 Full Injection | injector.ts complete / chat route / marketplace merge / skill loading / sessions route finalized (5 files) | T-PR-2, T-PR-3 |
| 5 | T-PR-5 Built-in System Templates | `deploy/execution-templates/*.yaml` + this document | T-PR-4 |

**T-PR-1 → T-PR-2 / T-PR-3 (can be parallel) → T-PR-4 → T-PR-5**. Execution template functionality is not externally exposed before all are merged (feature flag `EXECUTION_TEMPLATE_ENABLED=false` off by default).

### 13.4 Dependency Relationship with AgentTeam

Execution template T-PR-1 ~ T-PR-5 are **prerequisites** for AgentTeam PR-3. Recommended delivery order:

```
T-PR-1 → T-PR-2 → T-PR-3 → T-PR-4 → T-PR-5
                                      │
                                      ▼
                          AgentTeam PR-1 → PR-2 → PR-3 → ...
```

---

## 14. Acceptance Criteria

### 14.1 Registry

- Both FS + DB layer loading succeed; startup error on conflict
- `resolveTemplate` correctly filters visibility by source
- SIGHUP hot reload works; running sessions are not affected
- Cross-API-instance sync via NATS `template.invalidate.*`

### 14.2 CRUD

- Users can CRUD their own private templates
- Users **cannot** create `sandbox_image`/`hooks`/`allow_*` and other high-privilege fields (unless admin)
- System templates are read-only; PUT/DELETE returns 403
- Deleting referenced templates returns 409 (force=true can bypass)
- Non-admin reading `auth_env` returns `"***"`

### 14.3 Injection and Execution

- `type: local` template tools / rules / hooks / model / system_prompt / sandbox_image / limits all correctly injected
- `type: a2a` template: Brain doesn't start Hands, calls external peer via a2a_client; results returned correctly
- Pre-hook failure (`on_fail: abort`) → exec_complete.failed=true
- Post-hook failure (`on_fail: warn`) → warning but doesn't change success status
- `max_runtime_ms` / `max_tokens_per_run` over-limit correctly terminates

### 14.4 Integration with AgentTeam

- Team Spec referencing `type: local` template → Worker executes normally
- Team Spec referencing `type: a2a` template → Worker takes a2a branch, result stored in `team.<tid>.result.<role>`
- Leader with `allow_dynamic_compose=true` can call `compose_team`; otherwise tool not visible
- Session with `allow_a2a_out=true` can call `a2a_call`; otherwise not visible
- Team Spec containing `tools`/`rules`/`hooks` fields → API validation failure

### 14.5 Security

- A2A template with non-whitelisted peer fails to load
- User template with non-whitelisted sandbox_image fails to write
- Request body attempting to override `rules`/`hooks`/`tools` fields → ignored (not appended)
- Hands-side shell cannot read `A2A_PEER_TOKEN_*` / `INTERNAL_API_TOKEN`

---

## 15. Open Items

- [ ] Default value for user template whitelist tool set (`TEMPLATE_USER_ALLOWED_TOOLS`)
- [ ] Whether user template whitelist sandbox image set (`TEMPLATE_ALLOWED_IMAGES`) should be open
- [ ] Whether to support template inheritance / composition (`extends: base-template`) — suggest not doing in v1
- [ ] Behavior when marketplace tool reference fails: whole template fails vs degraded warn
- [ ] Template version upgrade strategy (how to maintain backward compatibility with existing DB data on schema evolution)
- [ ] Whether `auth_env` ops tools (rotation, audit) should be in v1
- [ ] Template evaluation: whether a "dry-run" interface is needed to pre-check template executability (run pre-hook but don't enter agent-loop)
- [ ] Whether template tags / search / categorization enters v1 UI

---

## 16. Execution Runbook

### 16.1 Development Order (Recommended)

| Step | File Group | Output |
|---|---|---|
| E1 | `protocol/src/execution-template.ts` + `protocol/src/types.ts` | Template types and ExecuteRequest extension fields |
| E2 | DB migration | `claw_templates` + `claw_sessions.template_id` |
| E3 | `api/src/templates/{validator,registry}.ts` | Template loading, validation, visibility filtering |
| E4 | `api/src/routes/templates.ts` | `/v1/templates` + `/internal/templates` |
| E5 | `api/src/templates/injector.ts` + `routes/chat.ts` | Template injection into ExecuteRequest |
| E6 | `brain/src/{resolve-tools,agent-loop,prompt}.ts` | Consume injected fields and execute |
| E7 | `brain/src/engines/*.ts` | pre/post/on_error hooks forced execution |
| E8 | `deploy/execution-templates/*.yaml` | System template assets landed |

### 16.2 API Examples

#### Create User Template

```bash
curl -sS -X POST "http://localhost:8200/v1/templates" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "template_id": "cpu-shell-user-a",
    "name": "CPU shell for analysis",
    "type": "local",
    "engine_type": "claude",
    "model": "claude-sonnet-4-20250514",
    "tools": [{ "type": "builtin", "names": ["read","grep","glob","ls"] }],
    "rules": [{ "type": "text", "content": "Never modify files unless asked." }],
    "max_runtime_ms": 1200000
  }'
```

#### Brain Internal Template Query (For `list_templates`)

```bash
curl -sS "http://localhost:8200/internal/templates?type=local&restrict_to=cpu-shell,gpu-pytorch" \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN"
```

### 16.3 Injection Pipeline Validation Script

| Step | Command | Expected |
|---|---|---|
| 1 | Create session bound to template | `claw_sessions.template_id` correctly written |
| 2 | Send message | Task payload contains `rules_text/system_append/hooks` |
| 3 | Brain processes | Pre-hooks execute before agent-loop |
| 4 | Post-completion check | Post-hooks executed and output events |
| 5 | A2A template test | `type=a2a` does not trigger Hands creation |

### 16.4 Failure Injection (Must Run)

| Scenario | Injection Method | Expected |
|---|---|---|
| Template conflict | FS and DB with same `template_id` | Startup failure (fail-fast) |
| Non-admin reads sensitive field | `GET /v1/templates/{id}` | `auth_env` returns `"***"` |
| `type=a2a` with hooks | Create template with hooks | 400 validation failure |
| Non-whitelisted image | User template sets `sandbox_image` | 403/400 rejected |
| Pre-hook failure | Hook command `exit 1` + `on_fail=abort` | Run fails and reports |
| Token over-limit | `max_tokens_per_run` set to very small value | Terminates early, reason=token_budget |

### 16.5 Monitoring and Alerting

| Metric (Suggested) | Description | Alert Threshold |
|---|---|---|
| `template_registry_reload_total` | Reload count | Consecutive failures > 0 within 5 minutes |
| `template_resolve_fail_total` | Template resolution failures | Rate > 5% |
| `template_inject_fail_total` | Injection failures | > 0 immediate alert |
| `template_hook_fail_total` | Hooks failure count | Pre-hook failure rate > 2% |
| `template_internal_query_401_total` | `/internal/templates` auth failures | > 0 immediate alert |

### 16.6 Gradual Rollout and Rollback

| Phase | Switch | Behavior |
|---|---|---|
| T0 | `EXECUTION_TEMPLATE_ENABLED=false` | Routes deployable, not active |
| T1 | Enable template injection, system templates only | User template CRUD not yet open |
| T2 | Open user template CRUD (with whitelist restrictions) | Gradual rollout |
| T3 | Open `allow_dynamic_compose` / `allow_a2a_out` | Admin templates only |

Rollback principles:
- Prefer disabling features over rolling back table schema
- When Template Registry errors, fall back to `system` template subset first
- When A2A-related anomalies occur, take `type=a2a` templates offline first (doesn't affect local)
