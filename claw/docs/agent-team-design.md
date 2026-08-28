# PrimusClaw AgentTeam Design

> Status: Draft v1.5 (pending review)
> Scope: Based on Claw's Brain/Hands architecture, extend multi-Brain collaboration to AgentTeam; built-in A2A dual-channel; support LLM dynamic team composition
> Delivery: **One-time complete delivery** (including A2A Inbound + Outbound, dynamic team composition), internally split PRs by file granularity to satisfy the ≤5 files/PR constraint; no staged acceptance
> **Prerequisite**: Execution Template as established infrastructure; field definitions, Registry, CRUD API, and injection flow are detailed in [execution-template-design.md](./execution-template-design.md) (historical background in [architecture-design.md §17](./architecture-design.md)); this design does not redefine, only "references".
> v1.5 evolution: Profile merged into Execution Template; Team Spec role only retains `{ name, template, prompt }`; `list_profiles` → `list_templates`
> v1.4 evolution: Template split into Capability Profile + Team Spec two layers; added dynamic team composition
> v1.3 convergence: Removed inbox / kanban tools / broadcast / team_result_emit; `delegate_to_worker` uses internal HTTP API; Team state in independent KV bucket
> Related: [architecture-design.md](./architecture-design.md)

---

## 0. Scope Boundary

| Boundary | Ownership | Description |
|---|---|---|
| Execution environment fields (engine/model/tools/rules/hooks/sandbox/A2A binding/limits) | `execution-template-design.md` | AgentTeam does not define or override, only references `template` |
| Team topology (leader/roles/max_parallel/on_leader_fail/a2a_entry) | This document | Defined by Team Spec, executed by API/Brain |
| Template CRUD / Registry / Injection | `execution-template-design.md` | AgentTeam only depends on `resolveTemplate` and injection results |
| Team controller and internal endpoints (delegate/compose/stop/delete) | This document | Runtime orchestration capabilities |
| A2A protocol boundary (inbound/outbound) | This document + Execution Template document | Protocol defined here, capability switches in execution template fields |

**Override Rules (Hard Constraints)**
- Team Spec only allows `{ name, template, prompt }` level semantic fields; `tools` / `rules` / `hooks` / `sandbox_image` and other execution fields are not allowed.
- A role's actual capabilities are entirely determined by the referenced execution template; if the template does not authorize (e.g., `allow_a2a_out=false`), AgentTeam must not relax the constraint.
- Pseudocode in this document treats the execution template implementation as an external dependency by default; if conflicts arise, `execution-template-design.md` takes precedence.

### 0.1 Unified Glossary (Aligned with Execution Template Document)

| Term | Definition | Single Source |
|---|---|---|
| **Execution Template** | Execution contract for a single session (engine/model/tools/rules/hooks/sandbox/A2A/limits) | `execution-template-design.md` |
| **Template Registry** | Execution template loading and query layer (FS+DB+visibility filtering) | `execution-template-design.md` |
| **Team Spec** | Team topology contract (leader/roles/max_parallel/on_leader_fail/a2a_entry) | This document |
| **Static Team Template** | Pre-compiled YAML snapshot of Team Spec (`deploy/team-templates/*.yaml`) | This document |
| **Dynamic Compose** | Leader instantiates Team Spec at runtime via `compose_team(spec)` | This document (capability switch provided by execution template) |
| **Worker Capability** | Final available capability set of a Worker | Determined by the Execution Template referenced by the Worker |
| **A2A Worker** | Remote worker execution path with `type=a2a` | Protocol in this document, template fields in execution template document |

---

## 1. Background and Goals

### 1.1 Requirements

Implement **AgentTeam** in PrimusClaw based on the "multi-Brain + Hands isolation" capability: 1 Leader + N Workers collaborating on complex tasks. Drawing on the declarative template concept from [ClawTeam](https://github.com/win4r/ClawTeam-OpenClaw), but **not introducing its CLI runtime** to avoid dual-layer scheduling.

### 1.2 Current Capabilities

| Capability | Source | Significance for AgentTeam |
|---|---|---|
| Multi-Brain task acquisition | `brain/src/index.ts` durable consumer + `acquireSessionLock` | Different sessions naturally land on different Brains for parallel execution |
| In-process sub-Agent | `brain/src/agent/sub-agent.ts` | Coroutine concurrency within a single Brain (retained, orthogonal to AgentTeam) |
| Per-session Hands | `brain/src/index.ts::ensureHands` | K8s Workload-level isolation |
| NATS JetStream + KV | `api/src/infra/nats.ts`, `brain-registry.ts` | Event bus & shared state ready |
| Event Store + SSE | `events/store.ts`, `events/consumer.ts` | Extensible for team event aggregation |

### 1.3 Relationship with ClawTeam

| Dimension | ClawTeam runtime | AgentTeam approach |
|---|---|---|
| Process | tmux + CLI | Brain instance + Session (reuse existing) |
| Isolation | git worktree | Hands K8s Workload (reuse existing) |
| Communication | file/ZeroMQ | **delegate + result unidirectional** (NATS KV stores result, task delivered via HTTP) |
| Template | YAML | **YAML (compatible with ClawTeam subset)** |
| Secrets | Host process | Brain holds them (Brain/Hands security boundary maintained) |

**Only reuse template format**; runtime is entirely handled by Claw itself. ClawTeam's Kanban / inbox / broadcast and other runtime collaboration primitives **are not included in v1**; will be added when driven by real use cases.

---

## 2. Design Principles

1. **Minimal introduction**: No new components; only extend `protocol / api / brain`.
2. **Homogeneous Session**: Both Leader and Worker are ordinary Sessions, reusing SSE / interrupt / S3 archiving / keepalive.
3. **Strong isolation**: Each Worker has a dedicated Hands sandbox; workspaces are not shared.
4. **Reference, don't define**: All security-sensitive fields (engine/model, tools, rules, hooks, sandbox_image, A2A binding, resource quotas, etc.) are carried and audited by **Execution Templates** (see [execution-template-design.md](./execution-template-design.md)); AgentTeam only defines **team topology** — each role references a registered template via the `template` field and must not override template fields.
5. **Lazy instantiation**: Worker session records are pre-created (static) or created on demand (dynamic); task delivery is uniformly deferred until Leader calls `delegate_to_worker`.
6. **Unidirectional collaboration model**: v1 only supports Leader → Worker `delegate` and Worker → Leader `result` directions; no inbox / broadcast / kanban or other bidirectional/shared state primitives, reducing deadlock surface and implementation complexity.
7. **Built-in A2A**: External boundary protocol uses A2A (Inbound + Outbound dual-channel); internal collaboration still uses NATS; boundary protocol and internal protocol are decoupled.

---

## 3. Core Architecture

```
                       ┌──────── NATS ────────┐
 User ──► API ─POST /v1/teams─► Team Controller │
                                   │              │
                      Create N+1 Sessions (DB + KV only; Workers don't submit tasks)
                                   │              │
                                   ▼              │
                            Leader Session         │
                            (Brain-L + Hands-L)    │
                                   │              │
                     delegate_to_worker(role,prompt) via internal HTTP
                                   │              │
            ┌──────────────────────┼──────────────────────┐
            ▼                      ▼                      ▼
       Worker Session A       Worker Session B       Worker Session C
       (Brain-1 + Hands-A)    (Brain-2 + Hands-B)   (Brain-3 + Hands-C)
            │                      │                      │
            │ exec_complete → NATS KV team.<tid>.result.<role>
            └──────────────────────┼──────────────────────┘
                                   │
                          Leader team_wait(roles) aggregation
                                   │
                       event-store aggregates by team_id
                                   │
                                   ▼
                     GET /v1/teams/{tid}/events (SSE)
```

### 3.1 Conceptual Model

| Concept | Definition | Carrier |
|---|---|---|
| **Team** | Execution unit for a collaborative task | `team_id` |
| **Leader** | Orchestrator Session | `role=leader` |
| **Worker** | Executor Session | `role=<name>` |
| **Meta** | Team static configuration | `team.<tid>.meta` (NATS KV) |
| **Result** | Worker final output | `team.<tid>.result.<role>` (NATS KV) |

### 3.2 Component Changes

| Component | Changes |
|---|---|
| `protocol` | `ExecuteRequest` / `CreateSessionRequest` add `team?: TeamContext` |
| `api` | Add team routes and template engine; session/event carry team tags; expose internal `POST /internal/teams/{tid}/delegate` |
| `brain/agent-loop` | Pass through team tags; add team-tools toolset |
| `brain/resolve-tools` | Inject team-tools based on `team_role` |
| `brain/sub-agent` | No changes (in-process concurrency retained) |
| `hands` | No impact |
| `event-consumer` | Persist with team index |

---

## 4. Protocol and Data Model

### 4.1 Protocol Extension

```ts
// packages/protocol/src/types.ts
export interface TeamContext {
  team_id: string;
  team_role: string;          // "leader" | custom worker role
  leader_session_id?: string; // Worker side pass-back for locating leader
}

export interface ExecuteRequest {
  // ...existing fields
  team?: TeamContext;
}

export interface CreateSessionRequest {
  // ...existing fields
  team?: TeamContext;
}
```

### 4.2 NATS KV Schema

**Independent bucket `TEAM_STATE`, TTL=24h**, not reusing `BRAIN_REGISTRY` (the latter has a 5min TTL that would expire during long tasks).

| Key | Writer | Reader |
|---|---|---|
| `team.<tid>.meta` | API on create / `compose` | API / Brain team-tools |
| `team.<tid>.result.<role>` | Worker `agent-loop` on `exec_complete` | Brain Leader `team_wait` / API aggregate query |

#### `team.<tid>.meta` Complete Structure

```ts
interface TeamMeta {
  team_id: string;
  template_name?: string;          // Team template name in static mode; null in dynamic mode
  spec: TeamSpec | null;           // Static mode = compiled spec; dynamic mode initially null, filled after compose
  leader_session_id: string;
  worker_session_ids: Record<string, string>;   // role → sid; populated during static creation; populated after compose in dynamic mode
  user_id: string;
  created_at: string;              // ISO8601
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  max_parallel: number;
  on_leader_fail: "stop" | "continue";
  a2a_entry?: "team" | "session";
  // Dynamic mode specific
  allow_compose: boolean;          // false=static; true=allow compose_team to be called once
  allowed_templates?: string[];    // Dynamic mode optional: restrict list_templates return set
}
```

#### `team.<tid>.result.<role>` Complete Structure

```ts
interface WorkerResult {
  role: string;
  session_id: string;              // Worker session
  final_text: string;
  failed: boolean;
  failure_reason?: string;
  tool_stats: { total_calls: number; error_calls: number; by_tool: Record<string, number> };
  token_usage: { input_tokens: number; output_tokens: number; cache_read: number; cache_create: number; turns: number };
  elapsed_ms: number;
  finished_at: string;             // ISO8601
  // A2A remote worker specific
  a2a_peer?: string;
  a2a_task_id?: string;
}
```

### 4.3 DB Schema Extension

```sql
-- sessions table extension
ALTER TABLE sessions ADD COLUMN team_id TEXT;
ALTER TABLE sessions ADD COLUMN team_role TEXT;
CREATE INDEX idx_sessions_team_id ON sessions(team_id);

-- teams main table
CREATE TABLE teams (
  team_id TEXT PRIMARY KEY,
  template_name TEXT NOT NULL,
  leader_session_id TEXT NOT NULL,
  status TEXT NOT NULL,        -- pending | running | completed | failed | cancelled
  created_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  meta JSONB
);
CREATE INDEX idx_teams_status ON teams(status);

-- A2A tasks table (see §16.8)
```

---

## 5. Team Specification (Team Spec)

This section only defines **team topology**. All runtime environment/capability/security fields are provided and audited by **Execution Templates**, and AgentTeam only references them via the `template` field.

### 5.1 Prerequisite: Execution Templates

The execution template field schema, Registry loading, CRUD API, and injection flow are defined in [execution-template-design.md](./execution-template-design.md) (initial version in [architecture-design.md §17](./architecture-design.md)); this document **assumes they are implemented** and provides the following interfaces:

| Interface | Source | Purpose |
|---|---|---|
| `GET /v1/templates` | `execution-template-design.md §7` | List available templates (public endpoint) |
| `GET /v1/templates/{id}` | `execution-template-design.md §7` | Template details |
| Template Registry in-memory object | `execution-template-design.md §5` | Brain / API internal queries |
| Template injection into `ExecuteRequest` | `execution-template-design.md §6` | Auto-inject tools/rules/hooks/model/system_prompt during session execution |

**AgentTeam constraints** (only added at the reference layer):
- Template referenced by a role must exist and be visible to the current user
- AgentTeam does not override template fields; if role-specific differences are needed, express them via the `prompt` field

**Template-side field extensions required** (not defined in this document, maintained by execution template document):
- `type: local | a2a`, `peer`, `skill_id`, `auth_env` (needed by A2A type workers)
- `sandbox_image`, `subagent_type`, `max_runtime_ms`, `max_tokens_per_run`, `allow_a2a_out` (needed by AgentTeam Workers)

> If the execution template v1 schema does not cover the above fields, they need to be added in the execution template document; the AgentTeam document **only records dependencies, does not define fields**.

### 5.2 Team Spec (Runtime Form)

Team Spec describes a specific team instance; all fields are "topology/semantic":

```json
{
  "team": "ml-research",
  "description": "Parallel ML experiments",
  "max_parallel": 5,
  "on_leader_fail": "stop",
  "leader": {
    "role": "orchestrator",
    "template": "team-leader",
    "prompt": "You are the tech lead..."
  },
  "roles": [
    { "name": "data-prep", "template": "cpu-shell",   "prompt": "Focus on data cleaning..." },
    { "name": "trainer",   "template": "gpu-pytorch", "prompt": "Train the model..." },
    { "name": "evaluator", "template": "readonly",    "prompt": "Compute metrics..." }
  ],
  "coordination": {
    "result_wait_timeout_ms": 1800000
  }
}
```

**Validation rules** (shared by API layer + `compose_team`):
- `team` matches `^[a-z][a-z0-9-]{0,31}$`
- `max_parallel` ∈ [1, `MAX_PARALLEL_HARD_CAP=10`], default 5
- `roles[].name` globally unique; reserved word `leader`
- `leader.template` / `roles[].template` must be ∈ Template Registry, otherwise rejected
- `on_leader_fail` defaults to `stop`
- **Template field overrides not allowed**: If Team Spec contains template fields like `tools` / `rules` / `hooks` / `sandbox_image` → rejected (prevents audit bypass)

### 5.3 Static Team Templates (Pre-compiled Snapshots of Team Spec)

Location: `deploy/team-templates/*.yaml`. Syntax is the YAML version of Team Spec; validation rules at load time are the same as §5.2; API side only does "YAML → Team Spec" conversion, downstream logic is unified.

```yaml
# deploy/team-templates/ml-research.yaml
team: ml-research
max_parallel: 5
on_leader_fail: stop

leader:
  role: orchestrator
  template: team-leader
  prompt: "You are the tech lead..."

roles:
  - name: data-prep
    template: cpu-shell
    prompt: "Focus on data cleaning and feature engineering."
  - name: trainer
    template: gpu-pytorch
    prompt: "Train the model."
  - name: evaluator
    template: readonly
    prompt: "Compute metrics."

coordination:
  result_wait_timeout_ms: 1800000
```

> Note the distinction from Execution Templates: **Execution Templates govern "how a single session runs"**; **Static Team Templates govern "how multiple sessions are organized"**. The two asset directories are separate:
> - Execution Templates: Storage and management mechanism defined by [execution-template-design.md](./execution-template-design.md)
> - Static Team Templates: `deploy/team-templates/*.yaml`

### 5.4 Dynamic Team Composition (Leader Generates Team Spec)

Leader can obtain available execution templates via `list_templates()`, then instantiate the team via `compose_team(spec)` (see §7.1). The generated Spec is subject to §5.2 server-side validation:
- Template doesn't exist / not visible to current user → rejected
- Contains restricted fields (tools/rules/hooks/...) → rejected
- Exceeds `MAX_PARALLEL_HARD_CAP` → rejected
- Role with same name already exists → rejected
- Dynamic team composition is **disabled by default**, enabled by environment variable `TEAM_ALLOW_DYNAMIC_COMPOSE=true` or Leader execution template declaring `allow_dynamic_compose: true` (D19)

**v1 constraint**: `compose_team` can only be called once during the **initial phase** of the team lifecycle (before Leader's first assistant turn); runtime role addition is not supported (Q4 constraint to avoid session lock and KV schema concurrent modification complexity, deferred to v1.1).

---

## 6. API

### 6.1 External Endpoints

```
POST /v1/teams
  body: one of two:
    # Static mode: use pre-written template
    { template: string, context?: Record<string,unknown>, initial_prompt: string }
    # Dynamic mode: empty shell Leader + allow compose_team
    { auto: { allowed_templates?: string[], leader_template?: string, leader_prompt?: string }, initial_prompt: string }
  resp: { team_id, leader_session_id, worker_session_ids: {role→sid} | null }
  # In dynamic mode worker_session_ids=null, populated after Leader calls compose_team

GET  /v1/teams/{tid}
  resp: { team_id, status, spec, leader, workers:[{role,sid,status,template}], created_at }

GET  /v1/teams/{tid}/events      # SSE, aggregates all member events by team_id (summary)
GET  /v1/teams/{tid}/sessions    # Expand all member sessions

POST /v1/teams/{tid}/stop        # Cascade send interrupt.<sid> to all members
DELETE /v1/teams/{tid}           # Cascade send cleanup.<sid> and delete KV
```

> Execution template public queries reuse `GET /v1/templates` (see [execution-template-design.md §7](./execution-template-design.md)). Brain internal tools use internal endpoint `GET /internal/templates` to avoid passing through user-facing auth (see below).

### 6.2 Internal Endpoints (For Brain team-tools Calls)

```
POST /internal/teams/{tid}/delegate
  headers: Authorization: Bearer <INTERNAL_API_TOKEN>
  body: { role: string, prompt: string, from_session_id: string }
  resp: { session_id, message_id }
  # Action: Deliver a message to the Worker session (same path as existing /v1/chat/sessions/{id}/messages),
  # trigger NATS task. Equivalent to Leader sending instructions to Worker on behalf of the user.

POST /internal/teams/{tid}/compose
  headers: Authorization: Bearer <INTERNAL_API_TOKEN>
  body: { spec: TeamSpec, from_session_id: string }
  resp: { worker_session_ids: {role→sid} }
  # Action: Dynamic team composition. Validate spec (§5.2), create Worker session records per spec,
  # update team.<tid>.meta.spec; only callable when meta.allow_compose=true and meta.spec=null
  # to prevent duplicate composition.

GET /internal/templates?type=local|a2a&tags=...&restrict_to=...
  headers: Authorization: Bearer <INTERNAL_API_TOKEN>
  resp: { templates: TemplateSummary[] }
  # Action: Provide template summary query for list_templates tool (filtered by user_id + allowed_templates).
```

> `list_templates` only goes through internal endpoints, not calling the API in-process Registry directly; HTTP protocol is unified across process boundaries.

**Credentials**: `INTERNAL_API_TOKEN` is injected into the API process and all Brain processes at deployment; only accepts `localhost` / intra-cluster calls (locked at network policy layer).

### 6.3 Orchestration Sequence

**Static Mode**:

```
POST /v1/teams { template: "ml-research", initial_prompt }
  ├─ Load static team template → compile to Team Spec → validate (§5.2)
  │    (Each role's referenced execution template must exist in Template Registry)
  ├─ Generate team_id
  ├─ Write teams row (DB) + team.<tid>.meta (KV, with spec)
  ├─ Create Leader session record (associated with leader.template; DB) + submit NATS task (with initial_prompt)
  │    (Execution template tools/rules/hooks/model/system_prompt injected into ExecuteRequest per `execution-template-design.md §6`)
  ├─ Create N Worker session records per spec (each session associated with role.template; no NATS task submitted)
  └─ Return all sids

Leader agent-loop running:
  ├─ Call delegate_to_worker(role, prompt)
  │     └─ Brain HTTP → POST /internal/teams/{tid}/delegate
  │           └─ API uses existing message path, injects Worker session's associated execution template
  │                 → Submit NATS task → Some Brain picks it up → exec_complete writes result KV
  └─ Call team_wait(roles)
        └─ Brain KV watch team.<tid>.result.<role>, return after all collected
```

**Dynamic Mode**:

```
POST /v1/teams { auto: { allowed_templates?, leader_template?, leader_prompt? }, initial_prompt }
  ├─ Generate team_id
  ├─ Write teams row (DB, spec=null) + team.<tid>.meta (KV, spec=null, allow_compose=true,
  │                                                allowed_templates?)
  ├─ Create Leader session (associated with leader_template; inject list_templates / compose_team tools)
  ├─ Submit NATS task (with initial_prompt + available template list)
  └─ Return team_id + leader_sid (workers not yet created)

Leader agent-loop first round:
  ├─ list_templates() → view available execution templates
  ├─ compose_team(spec)
  │     └─ Brain HTTP → POST /internal/teams/{tid}/compose
  │           └─ API validates spec → create Worker session records (with execution template association) → update meta.spec
  │                 └─ Return worker_session_ids
  └─ Continue with same delegate_to_worker / team_wait flow as static mode
```

---

## 7. MCP Toolset (New, Brain-local Implementation)

All team-tools are implemented **within the Brain process**, **not through Hands**, to prevent secret/permission leakage. Injected by `tools/resolve.ts` based on `team_role`. v1 toolset is intentionally minimal, covering only the "parallel subtask + aggregation" scenario.

### 7.1 Leader Exclusive

```ts
list_templates(filter?: { type?: "local" | "a2a", tags?: string[] }): TemplateSummary[]
// Implementation:
//   1. Get team_id from this session's TeamContext, and meta.allowed_templates (if specified)
//   2. Query execution template Registry (provided by execution-template-design.md implementation), filter by current user visibility and allowed_templates
//   3. Return summary: { template_id, name, description, type, capabilities summary }
//   4. Redact sensitive fields: do not return auth_env / tokens / internal paths

compose_team(spec: TeamSpec): { worker_session_ids: Record<string, string> }
// Implementation:
//   1. Only available when meta.allow_compose=true and meta.spec=null, otherwise throw error
//   2. Local pre-validation of spec (§5.2), reject restricted fields (tools/rules/hooks/...)
//   3. Call POST /internal/teams/{tid}/compose with INTERNAL_API_TOKEN
//   4. API server-side second validation + batch create Worker sessions per spec (with execution template association) + update meta.spec
//   5. v1 only allows single call during initial phase (D20)

delegate_to_worker(role: string, prompt: string, timeout_ms?: number): { session_id, message_id }
// Implementation:
//   1. Validate role ∈ team.<tid>.meta.spec.roles
//   2. Get team_id from this session's TeamContext
//   3. Call POST /internal/teams/{tid}/delegate with INTERNAL_API_TOKEN
//   4. Return session_id / message_id immediately; does not block waiting for result
//   5. Non-blocking: Leader can sequentially delegate to multiple workers in parallel

team_wait(roles: string[], timeout_ms?: number): Record<string, WorkerResult>
// Implementation:
//   1. Start NATS KV watch on team.<tid>.result.<role> for each role
//   2. Collect results as they arrive; return all at once when all collected or timeout
//   3. Return structure: { role: { final_text, failed, tool_stats, token_usage, elapsed_ms } }
```

### 7.2 Worker Exclusive

Workers need no additional team-tools. Their `exec_complete` event is automatically written to `team.<tid>.result.<self_role>` by agent-loop (see §8.2). Worker tools / rules / hooks are all provided by their associated execution template (see [execution-template-design.md](./execution-template-design.md)).

### 7.3 Permissions

```ts
// packages/brain/src/team-tools.ts
const TEAM_TOOL_ALLOW: Record<"leader" | "worker", string[]> = {
  // list_templates / compose_team only injected in dynamic mode (meta.allow_compose=true)
  leader: ["delegate_to_worker", "team_wait", "list_templates", "compose_team"],
  worker: [],
};
```

**Conditional injection of dynamic tools** (determined by `tools/resolve.ts` based on `meta.allow_compose`):
- Static mode (`allow_compose=false`): Leader only gets `delegate_to_worker` + `team_wait`
- Dynamic mode (`allow_compose=true`): Plus `list_templates` + `compose_team`

Global DENY (unavailable to all team members):
- `task`: Prevent starting independent sub-teams within a team
- `save_memory` / `save_skill`: Follow existing boundaries

---

## 8. Lifecycle

### 8.1 Creation

1. API parses template → write `teams` row (DB) + `team.<tid>.meta` (KV)
2. Create Leader session record + submit NATS task (with `initial_prompt` and `team={tid, role: leader}`)
3. Create N Worker session records; `team={tid, role:<name>, leader_sid}`; **do not submit NATS task**
4. API returns all sids

### 8.2 Execution

- Leader Brain picks up task → enters agent-loop normally
- Leader calls `delegate_to_worker` → API submits NATS task for Worker session → Worker Brain picks up and executes
- When Worker `exec_complete`, if agent-loop detects non-empty `TeamContext`, it automatically writes the result to `team.<tid>.result.<self_role>` (no explicit tool call needed)
- Leader calls `team_wait` to collect results → synthesize final `final_text`
- `event-consumer` persists all member events indexed by team

### 8.3 Interruption

- User `POST /v1/teams/{tid}/stop`
- API iterates meta.workers + leader_sid, publishes `interrupt.<sid>` for each
- Each Brain's `intSub` subscription triggers `abortCtrl.abort()` (reusing existing path)
- Unstarted Worker sessions (no task submitted) don't need interruption; cleanup phase directly destroys DB records

### 8.4 Completion

- Leader `exec_complete` → API updates `teams.status=completed`
- Background GC: KV bucket TTL auto-cleans `team.<tid>.*` after 24h

### 8.5 Cleanup

- `DELETE /v1/teams/{tid}`:
  - Cascade `cleanup.<sid>` to all members (destroy Hands)
  - Delete `team.<tid>.*` KV
  - Update `teams.status=cancelled`

### 8.6 Failure Propagation

- Worker failure → `team.<tid>.result.<role>.failed=true`
- Leader `team_wait` returns the failure result; Leader prompt decides whether to retry `delegate_to_worker` (same worker session can receive multiple messages, executed sequentially) or give up
- Leader failure → API listens for `exec_complete{team_role:leader, failed:true}`, decides whether to cascade stop all Workers based on template `on_leader_fail` policy

### 8.7 `delegate_to_worker` Internal Path (ADR D16)

**Uses internal HTTP API, not direct NATS submission**:

| Option | Pros | Cons | Adopted |
|---|---|---|---|
| Brain direct NATS task submission | Lowest latency; no extra endpoints | Bypasses API layer → no message record in DB, SSE can't be reused, stats/billing path broken | ✗ |
| Brain calls API HTTP endpoint | DB / SSE / billing / auth paths all reused; debug traceable | One extra hop; requires internal credentials | ✓ |

Implementation details:
- Endpoint: `POST /internal/teams/{tid}/delegate` (listens on intra-cluster / localhost only)
- Auth: `INTERNAL_API_TOKEN` (env injected into API and all Brain processes)
- Internally converts request to an equivalent `POST /v1/chat/sessions/{worker_sid}/messages` call, reusing all existing middleware

---

## 9. Events and SSE Aggregation

### 9.1 Event Extension

All events emitted by members automatically carry `team_id` and `team_role` (passed through by `agent-loop`, similar to `sub-agent` bubble).

### 9.2 Aggregated SSE

`GET /v1/teams/{tid}/events`:

- Subscribe to NATS core subject `sse.events.*`, filter by `team_id`
- By default only forward **summary events** (`statusUpdate / subagentStart / subagentEnd / exec_complete / delegate_to_worker / team_wait_complete`)
- `?verbose=true` forwards all events (for debugging)

### 9.3 Frontend Display Suggestions (Not Mandated by This Design)

- Team view: One timeline column per Worker + Leader summary area
- Default collapsed mode; click to expand to see tool-call details

---

## 10. Permissions and Security

| Control Point | Rule |
|---|---|
| Team tools location | **Implemented only in Brain**, not exposed to Hands; secrets not leaked |
| Worker tool whitelist | Declared by template `tools` field, intersected by `resolve-tools` |
| Cross-team access | `delegate_to_worker` / `team_wait` read `team_id` from `TeamContext`, ignoring parameter forgery |
| DENY list | `task` (prevent starting independent teams within a team), `save_memory` / `save_skill` (maintain existing boundaries) |
| Interrupt cascade | Implemented at API side; Brain does not trust client's team_id |
| Template source | `deploy/team-templates/*.yaml` writable only by ops; request body inline templates not accepted (prevents prompt injection team construction) |
| Internal API credentials | `INTERNAL_API_TOKEN` callable only within cluster; combined with NetworkPolicy |

---

## 11. Key Design Decisions (ADR)

| ID | Decision | Final Choice | Rationale |
|---|---|---|---|
| D1 | Worker physical unit | 1 Session = 1 Brain + 1 Hands | Follows the Brain/Hands isolation boundary |
| D2 | ClawTeam form | Only reuse YAML templates | Avoid dual-layer scheduling and secret boundary breach |
| D3 | Leader form | Ordinary Session (homogeneous) | Reuse all existing mechanisms |
| D4 | Collaboration carrier | Team state uses independent NATS KV bucket `TEAM_STATE`; task delivery via internal HTTP | Long-task TTL friendly; reuse API middleware stack |
| D5 | Team tools location | Brain-local implementation | Secret safety; not through Hands |
| D6 | Max concurrent Workers | Template-level `max_parallel`, hard cap 10 | Aligned with SaFE quotas |
| D7 | Template source | Filesystem only, no request body inline | Prevent prompt injection |
| D8 | External protocol | NATS (internal) + A2A (external) | §16 |
| D9 | Sub-Agent vs Team | Coexist orthogonally: in-process uses sub-agent; cross-Brain uses Team | Don't break existing use cases |
| D16 | `delegate_to_worker` path | Brain → internal HTTP API → NATS | DB/SSE/billing paths all reused, see §8.7 |
| D17 | v1 collaboration primitive scope | Only `delegate_to_worker` + `team_wait`; removed inbox / broadcast / kanban / team_send/recv / team_result_emit | Minimal viable set; controllable deadlock surface and implementation complexity; extend when driven by real use cases |
| D18 | Role capability source | Role only references execution template via `template` (see execution-template-design.md); Team Spec does not define capability fields | Single audit asset pool; Profile merged into Execution Template; AgentTeam document deduplication |
| D19 | Dynamic team composition default switch | **Disabled** by default; env `TEAM_ALLOW_DYNAMIC_COMPOSE=true` or Leader execution template declaring `allow_dynamic_compose: true` enables it | Regression validation and gradual rollout; doesn't affect static teams |
| D20 | Dynamic team composition timing | v1 only allows calling `compose_team` once during initial phase; runtime role addition deferred to v1.1 | Avoid session lock and KV schema concurrent modification complexity |
| D21 | Static team template form | Static team template syntax is the YAML version of Team Spec, compiled uniformly at load time | Single downstream path; zero migration cost |
| D22 | Execution template prerequisite | Execution template defined and implemented by `execution-template-design.md` (`architecture-design.md` §17 is the historical initial version); AgentTeam only references, does not redefine fields; Team Spec cannot override template fields | Avoid dual maintenance; all security-sensitive fields audited centrally |

---

## 12. Risks and Boundaries

| Risk | Mitigation |
|---|---|
| Hands Workload concurrent cost | Template `max_parallel` + API-side total concurrent quota |
| Session lock conflicts | Maintain "one session per Brain"; Worker sessions only submit tasks when Leader delegates; NATS natural dispatch |
| Worker not delegated for long time | Team overall TTL 24h; API periodically scans KV, Worker sessions not delegated within timeout marked as `timeout_unused` |
| SSE event storms | Aggregate endpoint only forwards summary events by default; `verbose` mode explicitly enabled |
| Lost interrupts | API idempotent resend; Brain-side abort idempotent |
| Leader/Worker semantic drift | Prompt templates + tool whitelist dual constraints |
| Cross-team call forgery | team-tools read team_id from `TeamContext`, ignoring parameter forgery |
| Internal API endpoint accessed externally | Listens only on intra-cluster; Bearer Token validation + NetworkPolicy dual layers |

---

## 13. Change List

### 13.1 Core AgentTeam

> Prerequisite: Execution template (`execution-template-design.md`) Registry, CRUD API, and injection logic are not in this table; provided by execution template deliverables.

**New Files**:

| File | Responsibility |
|---|---|
| `packages/api/src/routes/teams.ts` | Team CRUD & aggregate queries (excluding template management) |
| `packages/api/src/routes/teams-internal.ts` | `POST /internal/teams/{tid}/{delegate,compose}` |
| `packages/api/src/team-spec.ts` | Team Spec schema, validation, static team template compilation; references Execution Template Registry for existence validation |
| `packages/api/src/team-controller.ts` | Team lifecycle (create/stop/cleanup) |
| `packages/brain/src/team-tools.ts` | MCP tools: `delegate_to_worker` / `team_wait` / `list_templates` / `compose_team` |
| `packages/brain/src/team-context.ts` | Extract team context from `ExecuteRequest` and propagate |
| `deploy/team-templates/*.yaml` | Built-in static team templates (ml-research / code-review / batch-eval) |

**Modified Files**:

| File | Changes |
|---|---|
| `packages/protocol/src/types.ts` | Add `TeamContext`; extend `ExecuteRequest` / `CreateSessionRequest` |
| `packages/api/src/routes/sessions.ts` | Accept and persist team fields |
| `packages/api/src/infra/db.ts` | Add columns to `sessions`, create `teams` table |
| `packages/api/src/events/consumer.ts` | Persist with team index |
| `packages/api/src/events/store.ts` | Aggregate subscription supports team filtering |
| `packages/api/src/infra/nats.ts` | Initialize `TEAM_STATE` KV bucket (TTL=24h) |
| `packages/brain/src/agent/agent-loop.ts` | Pass through team context; write result KV on `exec_complete` |
| `packages/brain/src/tools/resolve.ts` | Inject team-tools based on `team_role` |
| `packages/brain/src/index.ts` | `handleTask` injects team context into onEvent |

### 13.2 A2A Integration (Included in This Delivery, Details in §16)

**New**: `packages/api/src/a2a/{card.ts, inbound.ts, registry.ts, auth.ts}`, `packages/api/src/routes/a2a.ts`, `packages/brain/src/a2a/client.ts`, `packages/brain/src/a2a-tools.ts`, `docs/a2a-ops.md`

**Modified**: `packages/api/src/infra/db.ts` (`a2a_tasks` table), `packages/brain/src/tools/resolve.ts` (a2a-tools injection), `packages/brain/src/team-tools.ts` (`delegate_to_worker` dispatches a2a worker), `packages/api/src/team-spec.ts` (A2A type template role resolution)

### 13.3 Engineering Split (PR Granularity, Not Phases)

6 PRs delivered as a whole, fixed merge order, no staged acceptance.

| # | PR | Content | Dependencies |
|---|---|---|---|
| 1 | PR-1 Protocol & DB & KV | protocol types / sessions route / db schema / event-consumer / nats (TEAM_STATE bucket) (5 files) | — |
| 2 | PR-2 Brain team-tools | team-tools / team-context / agent-loop / resolve-tools / brain/index (5 files) | PR-1 |
| 3 | PR-3 API & Team Templates | teams route (external) / teams-internal route (delegate + compose) / team-spec / team-controller / event-store (5 files) | PR-2, **depends on Execution Template Registry being implemented** |
| 3b | PR-3b Built-in Team Templates | `deploy/team-templates/*.yaml` (config only) | PR-3 |
| 4 | PR-4 A2A Inbound | a2a/{card, inbound, registry, auth} / routes/a2a (5 files) | PR-1, PR-3 |
| 5 | PR-5 A2A Outbound | a2a/client / a2a-tools / resolve-tools (extension) / team-tools (dispatch extension) / team-spec (A2A type extension) (5 files) | PR-2, PR-3 |
| 6 | PR-6 Operations & Documentation | env/ConfigMap loading, hot reload, rate limiting, metrics, `docs/a2a-ops.md` (≤5 files) | PR-4, PR-5 |

**PR-1 → PR-2 → PR-3 → PR-4/PR-5 (can be parallel) → PR-6**. End-to-end acceptance per §14 only after all are merged; no features published or exposed at intermediate points.

---

## 14. Acceptance Criteria (Executed Once After Full Delivery)

### 14.1 AgentTeam Core (Static Mode)

- Use `ml-research` static team template `POST /v1/teams` to spin up 1 Leader + 3 Workers
- Each Worker session's tools / rules / hooks / model correctly injected by their associated execution template (see `execution-template-design.md §6`)
- 3 Brain instances handle 3 Worker sessions respectively, Hands physically isolated
- Leader `delegate_to_worker` × 3 in parallel + `team_wait` aggregation → final `exec_complete`
- Worker `exec_complete` automatically writes to `team.<tid>.result.<role>` (no explicit tool call needed)
- `POST /v1/teams/{tid}/stop` cascades interrupt to all members; `DELETE` cleans up KV and Hands
- `GET /v1/teams/{tid}/events` SSE can fully trace the entire team
- Cross-team unauthorized `delegate_to_worker` rejected (negative test)
- Internal API endpoint returns 401 without `INTERNAL_API_TOKEN`
- Leader failure cascades stop Workers per template `on_leader_fail` policy
- Leader sends `delegate_to_worker` twice to same Worker; Worker executes two messages sequentially
- Negative: Team template role references non-existent execution template → load failure
- Negative: Team template role fields contain `tools`/`rules`/`hooks` and other template fields → load failure

### 14.1b Dynamic Team Composition (Under `TEAM_ALLOW_DYNAMIC_COMPOSE=true`)

- `POST /v1/teams { auto: {...}, initial_prompt }` returns `team_id + leader_sid` successfully, `worker_session_ids=null`
- Leader first round calls `list_templates()` and gets execution template subset visible to current user (without credential fields)
- Leader calls `compose_team(spec)` successfully creates Worker sessions; meta.spec is populated
- Post-composition flow matches static mode
- Negative: Reference non-existent `template` → rejected
- Negative: Spec contains restricted fields (tools/rules/hooks/...) → rejected
- Negative: Exceeds `MAX_PARALLEL_HARD_CAP` → rejected
- Negative: Duplicate `compose_team` call → rejected
- Negative: In static mode, Leader calls `compose_team` → tool not visible (not injected)
- Negative: When feature flag is off, `auto` entry returns 403

### 14.2 A2A Inbound

- `GET /.well-known/agent.json` returns Card consistent with loaded templates
- External triggers `POST /a2a/invoke` for `ml-research` team execution, `/a2a/stream` receives complete event stream
- Non-whitelisted token rejected; out-of-scope access rejected
- Inbound task cancellation → cascades interrupt to internal session/team

### 14.3 A2A Outbound

- Leader calls `a2a_call(peer=ci, skill=lint-ts)` to successfully invoke external mock Agent and get results
- `external-lint` worker participates as team member in orchestration, output stored in `team.<tid>.result.<role>`
- Non-whitelisted host `a2a_call` rejected
- Worker default `a2a_call` rejected by permission layer
- External peer timeout → retry → Leader receives `failed=true` result on final failure

### 14.4 Security

- Hands-side shell tool cannot read any `A2A_PEER_TOKEN_*` / `A2A_INBOUND_TOKENS` / `INTERNAL_API_TOKEN` or other Brain environment secrets
- A2A traffic access log complete (task_id, peer, scope, duration, bytes)
- Outbound QPS rate limiting effective (default 10 req/s/peer)
- Inbound SSE connection rate limiting effective (default 50/client_id)
- `/internal/teams/*` endpoints not registered on public routes

---

## 15. Open Items

- [ ] Whether `retry_policy` should be included in v1 Team Spec
- [ ] Whether `max_parallel` hard cap of 10 matches SaFE quotas
- [ ] Whether Team-level billing dimension is needed (token aggregation attributed to team_id)
- [ ] Whether frontend Team view is developed in the same period
- [ ] A2A spec: Whether to follow Google A2A Protocol subsequent version upgrades (currently aligned with v0.x subset)
- [ ] Retention policy for undelegated Worker sessions: 24h KV TTL auto-cleanup vs API active reaping
- [ ] Whether dynamic team composition needs a "Spec preview + manual confirmation" step (safety mode vs fully automatic)

**Execution template dependencies** (owned by execution template document, only listing relationships):
- Execution Template schema needs to cover fields required by AgentTeam: `type: local|a2a`, `peer`, `skill_id`, `auth_env`, `sandbox_image`, `subagent_type`, `max_runtime_ms`, `max_tokens_per_run`, `allow_a2a_out`, `allow_dynamic_compose`
- Initial built-in execution template list: recommend at least `cpu-shell` / `readonly` / `gpu-pytorch` / `a2a-ci` / `team-leader`
- Template Registry hot-reload strategy (SIGHUP vs ConfigMap watch vs API restart)
- Template visibility model (global / user-private / team-specific)

---

## 16. A2A Integration (External Boundary Protocol)

### 16.1 Goals

Expose AgentTeam as a whole as an **A2A-compatible Agent** externally, while allowing internal Leaders to call external Agents via A2A as "remote Workers". **Internal Team collaboration continues via NATS + internal HTTP** (§4~§9 unchanged); A2A is only responsible for cross-system boundaries.

### 16.2 Scope

| Direction | Meaning | Implementation Layer |
|---|---|---|
| **Inbound** | External systems call PrimusClaw Agent / Team via A2A protocol | **API layer** |
| **Outbound** | Internal Agent calls external A2A Agent via MCP tools | **Brain layer** (same directory and permission model as team-tools) |

A2A spec: Aligned with **Google A2A Protocol v0.x subset**, implementing only Agent Card / invoke / stream / status four core endpoint types; extension fields left blank.

### 16.3 Layered Implementation

```
                     ┌───── A2A peer (external) ─────┐
                     │                             │
               (in) ▼                         (out)│
  ┌──────────── API Layer ──────────────┐             │
  │ /.well-known/agent.json          │             │
  │ POST /a2a/invoke                 │             │
  │ GET  /a2a/stream (SSE)           │             │
  │ GET  /a2a/tasks/{id}             │             │
  │ a2a-registry / card-cache / auth │             │
  └──┬──────────────────────────────┬┘             │
     │ NATS task                    │              │
     ▼                              ▼              │
  Leader Brain ──────────── a2a-client ────────────┘
  (MCP tools: a2a_call / a2a_list_peers)
```

### 16.4 Inbound (API Layer)

#### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/.well-known/agent.json` | Agent Card (capabilities, skills, auth method) |
| `POST` | `/a2a/invoke` | Create an A2A task (body contains task + input + auth) |
| `GET` | `/a2a/stream?task_id=...` | SSE push task events |
| `GET` | `/a2a/tasks/{id}` | Task status and final result |
| `POST` | `/a2a/tasks/{id}/cancel` | Cancel task |

#### Mapping

- A2A task maps to **internal Session** (default) or **Team** (when template `a2a_entry: team`)
- Inbound requests are forwarded as `POST /v1/chat/sessions/{id}/messages` or `POST /v1/teams` after authentication
- Event stream outputs from event-store in reverse, preserving original `team_id / session_id`, hidden externally

#### Authentication

- Unified through SaFE auth stack + A2A-specific bearer (`A2A_INBOUND_TOKENS` env, supports multi-tenant token→scope mapping)
- External caller identity injected as virtual `user_id`, billing attributed to independent dimension `user_id=a2a:<client-id>`

#### Agent Card

**Dynamically generated** by API at startup based on loaded templates + tool whitelist, main fields:

```json
{
  "name": "primus-claw",
  "version": "1.0",
  "protocol_version": "0.x",
  "capabilities": ["chat", "team_orchestration"],
  "skills": [
    { "id": "team:ml-research", "description": "...", "input_schema": {} },
    { "id": "session:chat",     "description": "...", "input_schema": {} }
  ],
  "auth": { "type": "bearer" },
  "endpoints": {
    "invoke": "/a2a/invoke",
    "stream": "/a2a/stream"
  }
}
```

### 16.5 Outbound (Brain Layer)

#### MCP Tools

| Tool | Available To | Function |
|---|---|---|
| `a2a_list_peers()` | Leader | Return whitelisted peer list + Agent Card summaries |
| `a2a_call(peer, task, input, timeout_ms?)` | Leader | Synchronous call to external Agent; returns final_text + stats |
| `a2a_stream(peer, task, input)` | Leader | Streaming call, events sent back to this session (with `a2a_peer` tag) |

**Workers cannot use by default** (D14); visibility is determined by **Worker's referenced execution template** `allow_a2a_out: true` (execution template field, see [execution-template-design.md §4.6](./execution-template-design.md)); resolve-tools reads this field from the worker session's associated execution template before injecting tools.

#### Implementation Key Points

- `brain/src/a2a/client.ts`: HTTP + SSE client with bearer auth, timeout, exponential backoff retry
- Peer credentials read from Brain process env / ConfigMap (key format `A2A_PEER_TOKEN_<PEER_ID>`), **never enters Hands**
- Request target must match **whitelist** (see §16.6), otherwise rejected
- Outbound events bubble back to session SSE via existing `onEvent`, tagged with `a2a_peer` / `a2a_task_id`
- When A2A worker serves as remote Worker, `delegate_to_worker` dispatches on the Brain side based on **Worker's referenced execution template `type` field**: `type=local` → call internal HTTP endpoint (submit NATS task); `type=a2a` → call `a2a_client` directly to external peer, result also written to `team.<tid>.result.<role>`

### 16.6 Peer Whitelist (Maintained by Ops)

| Config Item | Carrier | Example |
|---|---|---|
| Peer directory | env `A2A_PEERS_JSON` or ConfigMap `a2a-peers.json` | `[{"id":"ci","card_url":"https://ci.example.com/.well-known/agent.json","auth_env":"A2A_PEER_TOKEN_CI"}]` |
| Outbound endpoint whitelist | env `A2A_OUTBOUND_HOST_WHITELIST` | `ci.example.com,monitor.internal` |
| Inbound token | env `A2A_INBOUND_TOKENS` | `<token>:<client-id>:<scope>` multiple entries |

Loaded into memory at startup + hot-reloaded (SIGHUP or ConfigMap watch).

### 16.7 Team Template Field Extension (A2A Scenario)

After A2A introduction, the only new field **team templates** (`deploy/team-templates/*.yaml`) need is the top-level `a2a_entry` (determines the default Inbound mapping target). Other A2A-related fields (`type`/`peer`/`skill_id`/`auth_env`/`allow_a2a_out`) all belong to **execution templates** (see [execution-template-design.md §4](./execution-template-design.md)); team templates **only reference** execution templates.

```yaml
# deploy/team-templates/ml-research-with-ci.yaml
team: ml-research-with-ci
a2a_entry: team                # Inbound default mapping target: team | session

leader:
  role: orchestrator
  template: team-leader        # This execution template needs allow_a2a_out=true for Leader to call a2a_call
  prompt: "Coordinate local trainer and external lint."

roles:
  - name: local-trainer
    template: gpu-pytorch       # type=local execution template
    prompt: "Train the model."
  - name: external-lint
    template: a2a-ci-lint       # type=a2a execution template (peer/skill_id/auth_env defined in that template)
    prompt: "Lint the produced code."

coordination:
  result_wait_timeout_ms: 1800000
```

> Corresponding execution template `a2a-ci-lint` example in [execution-template-design.md §4.7](./execution-template-design.md).

### 16.8 Data Model Extension

#### KV

| Key | Value | Description |
|---|---|---|
| `team.<tid>.result.<role>` | Original fields + `a2a_peer?`, `a2a_task_id?` | Remote worker output also stored here |
| `a2a.tasks.<task_id>` | `{type:session\|team, target_id, status, created_at}` | Inbound task routing table, TTL 24h |

#### DB

```sql
ALTER TABLE teams ADD COLUMN a2a_entry TEXT;   -- "team" | "session" | NULL
CREATE TABLE a2a_tasks (
  task_id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,        -- "inbound" | "outbound"
  peer_id TEXT,
  target_type TEXT NOT NULL,      -- "session" | "team"
  target_id TEXT NOT NULL,
  client_id TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP
);
CREATE INDEX idx_a2a_tasks_target ON a2a_tasks(target_type, target_id);
```

### 16.9 Engineering Split (Merged into §13.3)

A2A-related PRs (PR-4 / PR-5 / PR-6) together with AgentTeam core PRs form the **complete delivery set**, see §13.3. Split principles:
- PR-4 only adds API layer Inbound endpoints and data structures, exposed but not activated (inaccessible without whitelist configuration)
- PR-5 adds Brain layer Outbound tools, under the same permission framework as team-tools
- PR-6 completes ops configuration, rate limiting, documentation, triggering end-to-end enablement
- **A2A functionality is not externally exposed before PR-4 / PR-5 / PR-6 are merged**; no intermediate acceptance points

### 16.10 Acceptance

A2A acceptance has been merged into §14.2 / §14.3 / §14.4, no longer listed separately.

### 16.11 Security Red Lines

- Outbound requests **must** match host whitelist + peer directory; arbitrary URLs forbidden
- Agent Card cache must verify source TLS; optional signature (v1 marked TODO)
- Per-peer outbound QPS rate limiting (default 10 req/s, configurable)
- Inbound SSE connection rate limiting (default 50 per client_id)
- `a2a_call`'s `input` does not automatically forward Hands workspace file paths; Leader prompt explicitly summarizes (prevents path probing)
- All A2A traffic logged with access log (task_id, peer, scope, duration, bytes)

### 16.12 ADR Supplements

| ID | Decision | Choice | Rationale |
|---|---|---|---|
| D10 | Whether internal collaboration switches to A2A | No, continue NATS + internal HTTP | Latency/throughput/persistence advantages; A2A only for external boundaries |
| D11 | Whether A2A Inbound goes in Brain | No, API layer | Brain has no external HTTP entry; auth/rate limiting unified stack |
| D12 | A2A Outbound tool location | Brain-local | Same model as team-tools; secrets don't enter Hands |
| D13 | Peer whitelist carrier | env / ConfigMap | Ops auditable; hot-reload support |
| D14 | Whether Workers can `a2a_call` | Disabled by default; explicitly enabled by Worker's referenced **execution template** `allow_a2a_out=true` | Least privilege; opened when driven by real use cases; same audit asset as execution templates |
| D15 | A2A spec version | Google A2A Protocol v0.x subset | Aligned with ecosystem; extension fields left blank |

---

## 17. Detailed Implementation (Pseudocode)

This chapter provides implementation pseudocode for key modules, error paths, and concurrency scenarios. All pseudocode is in TypeScript style; there may be stylistic differences from final code, but behavioral contracts must be consistent.

### 17.1 Internal Type Definitions

```ts
// packages/protocol/src/team.ts
export interface TeamSpec {
  team: string;
  description?: string;
  max_parallel: number;
  on_leader_fail: "stop" | "continue";
  leader: { role: "leader"; template: string; prompt: string };
  roles: Array<{ name: string; template: string; prompt: string; prompt_suffix?: string }>;
  coordination: { result_wait_timeout_ms: number };
  a2a_entry?: "team" | "session";
}

export interface TemplateSummary {
  template_id: string;
  name: string;
  description?: string;
  type: "local" | "a2a";
  capabilities: { tools: string[]; subagent_type?: string; sandbox_image?: string };
  // Does not contain auth_env / tokens / internal paths
}

export interface DelegateResponse { session_id: string; message_id: string; }
export interface ComposeResponse  { worker_session_ids: Record<string, string>; }

export const TEAM_RESERVED_ROLES = new Set(["leader"]);
export const MAX_PARALLEL_HARD_CAP = 10;
export const RESERVED_SPEC_FIELDS = new Set(["tools", "rules", "hooks", "sandbox_image", "model", "engine_type", "system_prompt"]);
```

### 17.2 Team Spec Validation (`team-spec.ts`)

```ts
// packages/api/src/team-spec.ts
import type { TeamSpec } from "@claw/protocol";
import { templateRegistry } from "./templates/registry";  // provided by execution-template-design

export class TeamSpecValidationError extends Error {
  constructor(public code: string, msg: string) { super(msg); }
}

export function validateTeamSpec(spec: unknown, userId: string): TeamSpec {
  if (typeof spec !== "object" || !spec) throw new TeamSpecValidationError("invalid_type", "spec must be object");
  const s = spec as Record<string, unknown>;

  // 1. Team name convention
  if (typeof s.team !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(s.team)) {
    throw new TeamSpecValidationError("invalid_team_name", "team name must match ^[a-z][a-z0-9-]{0,31}$");
  }

  // 2. max_parallel bounds
  const maxPar = Number(s.max_parallel ?? 5);
  if (!Number.isInteger(maxPar) || maxPar < 1 || maxPar > MAX_PARALLEL_HARD_CAP) {
    throw new TeamSpecValidationError("max_parallel_out_of_range",
      `max_parallel must be 1..${MAX_PARALLEL_HARD_CAP}`);
  }

  // 3. leader / roles required
  if (!s.leader || !Array.isArray(s.roles) || s.roles.length === 0) {
    throw new TeamSpecValidationError("missing_members", "leader and at least one role required");
  }

  // 4. Anti-bypass: prohibit execution template fields
  const checkReserved = (obj: Record<string, unknown>, where: string) => {
    for (const k of Object.keys(obj)) {
      if (RESERVED_SPEC_FIELDS.has(k)) {
        throw new TeamSpecValidationError("reserved_field",
          `field "${k}" not allowed in team spec (${where}); set it on the execution template instead`);
      }
    }
  };
  checkReserved(s.leader as Record<string, unknown>, "leader");
  for (const r of s.roles as Array<Record<string, unknown>>) checkReserved(r, `roles[name=${r.name}]`);

  // 5. Role name uniqueness + reserved words
  const seen = new Set<string>();
  for (const r of s.roles as Array<Record<string, unknown>>) {
    const name = String(r.name);
    if (TEAM_RESERVED_ROLES.has(name)) throw new TeamSpecValidationError("reserved_role", `role name "${name}" is reserved`);
    if (seen.has(name)) throw new TeamSpecValidationError("duplicate_role", `duplicate role: ${name}`);
    seen.add(name);
  }

  // 6. Template reference validation (including visibility)
  const allTemplates = [
    { who: "leader", id: String((s.leader as Record<string, unknown>).template) },
    ...(s.roles as Array<Record<string, unknown>>).map(r => ({ who: `roles[name=${r.name}]`, id: String(r.template) })),
  ];
  for (const { who, id } of allTemplates) {
    const tpl = templateRegistry.resolve(id, userId);
    if (!tpl) throw new TeamSpecValidationError("template_not_found", `template "${id}" not visible to user (${who})`);
  }

  return spec as TeamSpec;
}

export function compileStaticTemplate(yamlPath: string): TeamSpec {
  // 1. Read yaml -> obj
  // 2. Inject defaults (max_parallel=5, on_leader_fail="stop", coordination.result_wait_timeout_ms=1800_000)
  // 3. validateTeamSpec(obj, userId="__system__")
  // 4. Return spec
}
```

### 17.3 Team Controller (`team-controller.ts`)

#### Creation (Static + Dynamic)

```ts
// packages/api/src/team-controller.ts
import { kv, sc } from "./nats";
import { db } from "./db";
import { templateRegistry } from "./templates/registry";
import { buildExecutionContext } from "./templates/injector";  // provided by execution-template-design
import { validateTeamSpec, compileStaticTemplate } from "./team-spec";

export async function createTeam(req: CreateTeamRequest, userId: string): Promise<CreateTeamResponse> {
  const teamId = `team-${randomUUID()}`;

  // 1. Parse spec: static vs dynamic
  let spec: TeamSpec | null;
  let allowCompose: boolean;
  let allowedTemplates: string[] | undefined;

  if ("template" in req) {
    spec = compileStaticTemplate(`${TEAM_TEMPLATES_DIR}/${req.template}.yaml`);
    validateTeamSpec(spec, userId);  // Second validation for current user visibility
    allowCompose = false;
  } else {
    // Dynamic mode
    if (process.env.TEAM_ALLOW_DYNAMIC_COMPOSE !== "true") throw new HttpError(403, "dynamic_compose_disabled");
    spec = null;
    allowCompose = true;
    allowedTemplates = req.auto.allowed_templates;
    // Leader template must have allow_dynamic_compose=true
    const leaderTpl = templateRegistry.resolve(req.auto.leader_template ?? "team-leader", userId);
    if (!leaderTpl || !leaderTpl.allow_dynamic_compose) throw new HttpError(403, "leader_template_not_compose_capable");
  }

  // 2. Write DB (teams main table)
  await db.tx(async (t) => {
    await t.exec(`INSERT INTO teams (team_id, template_name, leader_session_id, status, created_at, meta)
                  VALUES ($1, $2, $3, 'pending', NOW(), $4)`,
      [teamId, req.template ?? null, "", JSON.stringify({})]);
  });

  // 3. Create Leader session (DB + submit NATS task)
  const leaderTplId = spec ? spec.leader.template : (req.auto.leader_template ?? "team-leader");
  const leaderSid = await createSession({
    user_id: userId,
    template_id: leaderTplId,
    team: { team_id: teamId, team_role: "leader" },
  });

  // 4. Create Worker sessions (DB placeholder only, no NATS task submitted)
  const workerSids: Record<string, string> = {};
  if (spec) {
    for (const role of spec.roles) {
      workerSids[role.name] = await createSession({
        user_id: userId,
        template_id: role.template,
        team: { team_id: teamId, team_role: role.name, leader_session_id: leaderSid },
        suppress_initial_task: true,  // ← Key: no NATS submission
      });
    }
  }

  // 5. Write KV meta
  const meta: TeamMeta = {
    team_id: teamId,
    template_name: req.template,
    spec,
    leader_session_id: leaderSid,
    worker_session_ids: workerSids,
    user_id: userId,
    created_at: new Date().toISOString(),
    status: "running",
    max_parallel: spec?.max_parallel ?? 5,
    on_leader_fail: spec?.on_leader_fail ?? "stop",
    a2a_entry: spec?.a2a_entry,
    allow_compose: allowCompose,
    allowed_templates: allowedTemplates,
  };
  await kv.create(`team.${teamId}.meta`, sc.encode(JSON.stringify(meta)));

  // 6. Update DB.teams.leader_session_id + meta
  await db.exec(`UPDATE teams SET leader_session_id=$1, status='running', meta=$2 WHERE team_id=$3`,
    [leaderSid, meta, teamId]);

  // 7. Submit Leader's initial_prompt (via existing /messages path)
  await postMessageInternal({
    session_id: leaderSid,
    user_id: userId,
    content: req.initial_prompt,
  });

  return { team_id: teamId, leader_session_id: leaderSid, worker_session_ids: spec ? workerSids : null };
}
```

#### Stop (Cascade Interrupt)

```ts
export async function stopTeam(teamId: string, userId: string): Promise<void> {
  const meta = await getMeta(teamId, userId);  // Includes permission check
  // 1. Send interrupt to all members
  const sids = [meta.leader_session_id, ...Object.values(meta.worker_session_ids)];
  await Promise.all(sids.map(sid => nats.publish(`interrupt.${sid}`, sc.encode(""))));

  // 2. Update DB status (idempotent)
  await db.exec(`UPDATE teams SET status='cancelled', completed_at=NOW()
                 WHERE team_id=$1 AND status NOT IN ('completed','failed','cancelled')`, [teamId]);

  // 3. KV meta status sync (CAS, prevent race with exec_complete write)
  await casUpdateMeta(teamId, m => ({ ...m, status: "cancelled" }));
}
```

#### Cleanup (Destroy Hands + Delete KV)

```ts
export async function deleteTeam(teamId: string, userId: string): Promise<void> {
  const meta = await getMeta(teamId, userId);
  const sids = [meta.leader_session_id, ...Object.values(meta.worker_session_ids)];

  // 1. Cascade cleanup (destroy Hands sandbox), execute concurrently
  await Promise.allSettled(sids.map(sid => nats.publish(`cleanup.${sid}`, sc.encode(""))));

  // 2. Delete KV
  await Promise.allSettled([
    kv.delete(`team.${teamId}.meta`),
    ...Object.keys(meta.worker_session_ids).map(role => kv.delete(`team.${teamId}.result.${role}`)),
    kv.delete(`team.${teamId}.result.leader`),
  ]);

  // 3. DB tombstone
  await db.exec(`UPDATE teams SET status='cancelled', completed_at=NOW() WHERE team_id=$1`, [teamId]);
}
```

#### Leader Completion Linkage

```ts
// Triggered by event-consumer listening to exec_complete events
export async function onExecComplete(evt: ExecCompleteEvent): Promise<void> {
  if (!evt.team_id) return;
  const meta = await getMetaSilent(evt.team_id);
  if (!meta) return;

  if (evt.team_role === "leader") {
    // Leader completed → mark team as completed / failed
    const finalStatus = evt.failed ? "failed" : "completed";
    await db.exec(`UPDATE teams SET status=$1, completed_at=NOW() WHERE team_id=$2 AND status='running'`,
      [finalStatus, evt.team_id]);
    await casUpdateMeta(evt.team_id, m => ({ ...m, status: finalStatus }));

    // on_leader_fail handling
    if (evt.failed && meta.on_leader_fail === "stop") {
      await stopTeam(evt.team_id, meta.user_id);
    }
  }
}
```

### 17.4 Internal Endpoints (`routes/teams-internal.ts`)

```ts
// POST /internal/teams/:tid/delegate
fastify.post("/internal/teams/:tid/delegate", { preHandler: requireInternalToken }, async (req, reply) => {
  const { role, prompt, from_session_id } = req.body as DelegateBody;
  const tid = req.params.tid;

  const meta = await loadMeta(tid);
  if (!meta) return reply.code(404).send({ code: "team_not_found" });
  if (meta.spec === null) return reply.code(409).send({ code: "team_not_composed", message: "call compose_team first" });

  // Authorization protection: from_session_id must be this team's leader
  if (from_session_id !== meta.leader_session_id) {
    return reply.code(403).send({ code: "not_leader" });
  }

  // Role must exist
  const sid = meta.worker_session_ids[role];
  if (!sid) return reply.code(404).send({ code: "role_not_found" });

  // Pass through to existing message path, reuse all middleware (template injection, event-store write, SSE)
  const messageId = await postMessageInternal({
    session_id: sid,
    user_id: meta.user_id,
    content: prompt,
  });

  return { session_id: sid, message_id: messageId };
});

// POST /internal/teams/:tid/compose
fastify.post("/internal/teams/:tid/compose", { preHandler: requireInternalToken }, async (req, reply) => {
  const { spec, from_session_id } = req.body as ComposeBody;
  const tid = req.params.tid;

  const meta = await loadMeta(tid);
  if (!meta) return reply.code(404).send({ code: "team_not_found" });
  if (!meta.allow_compose) return reply.code(403).send({ code: "compose_not_allowed" });
  if (meta.spec !== null) return reply.code(409).send({ code: "already_composed" });
  if (from_session_id !== meta.leader_session_id) return reply.code(403).send({ code: "not_leader" });

  // Validate spec
  let validSpec: TeamSpec;
  try {
    validSpec = validateTeamSpec(spec, meta.user_id);
  } catch (e: any) {
    return reply.code(400).send({ code: e.code ?? "spec_invalid", message: e.message });
  }

  // Enforce max_parallel hard cap
  if (validSpec.roles.length > MAX_PARALLEL_HARD_CAP) {
    return reply.code(400).send({ code: "max_parallel_exceeded" });
  }

  // Create Worker sessions (same path as static)
  const workerSids: Record<string, string> = {};
  for (const role of validSpec.roles) {
    workerSids[role.name] = await createSession({
      user_id: meta.user_id,
      template_id: role.template,
      team: { team_id: tid, team_role: role.name, leader_session_id: from_session_id },
      suppress_initial_task: true,
    });
  }

  // CAS update meta (prevent concurrent compose)
  const ok = await casUpdateMeta(tid, m => {
    if (m.spec !== null) throw new Error("already_composed_race");
    return { ...m, spec: validSpec, worker_session_ids: workerSids };
  });
  if (!ok) {
    // Rollback worker sessions
    for (const sid of Object.values(workerSids)) await deleteSession(sid).catch(() => {});
    return reply.code(409).send({ code: "already_composed_race" });
  }

  return { worker_session_ids: workerSids };
});
```

### 17.5 Brain Team Tools (`team-tools.ts`)

```ts
// packages/brain/src/team-tools.ts
import { kv, watchKv, sc } from "./nats";
import { fetch } from "undici";

const INTERNAL_API = process.env.INTERNAL_API_URL!;
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN!;

async function callApi(path: string, body: object) {
  const r = await fetch(`${INTERNAL_API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${INTERNAL_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new ToolError(`api_${r.status}`, await r.text());
  return r.json();
}

async function callApiGet(path: string) {
  const r = await fetch(`${INTERNAL_API}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
  });
  if (!r.ok) throw new ToolError(`api_${r.status}`, await r.text());
  return r.json();
}

// ---- delegate_to_worker ----
export const delegateToWorker = {
  name: "delegate_to_worker",
  inputSchema: {
    type: "object",
    properties: {
      role: { type: "string" },
      prompt: { type: "string" },
      timeout_ms: { type: "number" },  // Only for wait phase; fire-and-forget here
    },
    required: ["role", "prompt"],
  },
  async execute(args, ctx: ToolContext): Promise<DelegateResponse> {
    if (!ctx.team) throw new ToolError("not_in_team", "delegate_to_worker only in team context");
    return callApi(`/internal/teams/${ctx.team.team_id}/delegate`, {
      role: args.role,
      prompt: args.prompt,
      from_session_id: ctx.session_id,
    });
  },
};

// ---- team_wait ----
export const teamWait = {
  name: "team_wait",
  inputSchema: {
    type: "object",
    properties: {
      roles: { type: "array", items: { type: "string" } },
      timeout_ms: { type: "number" },
    },
    required: ["roles"],
  },
  async execute(args, ctx: ToolContext): Promise<Record<string, WorkerResult>> {
    if (!ctx.team) throw new ToolError("not_in_team", "team_wait only in team context");
    const tid = ctx.team.team_id;
    const collected: Record<string, WorkerResult> = {};
    const remaining = new Set(args.roles);
    const timeoutMs = args.timeout_ms ?? 1_800_000;
    const deadline = Date.now() + timeoutMs;

    // 1. First scan KV (already completed workers)
    for (const role of args.roles) {
      const entry = await kv.get(`team.${tid}.result.${role}`).catch(() => null);
      if (entry) {
        collected[role] = JSON.parse(sc.decode(entry.value));
        remaining.delete(role);
      }
    }
    if (remaining.size === 0) return collected;

    // 2. KV watch incremental (must be able to exit on timeout: cannot rely on "new event" to check deadline)
    const watcher = await watchKv("TEAM_STATE", { include_history: false });
    const watchLoop = (async () => {
      for await (const upd of watcher) {
        const m = /^team\.([^.]+)\.result\.(.+)$/.exec(upd.key);
        if (!m || m[1] !== tid) continue;
        const role = m[2];
        if (!remaining.has(role)) continue;
        collected[role] = JSON.parse(sc.decode(upd.value));
        remaining.delete(role);
        if (remaining.size === 0) return "done";
      }
      return "closed";
    })();

    const timeout = new Promise<"timeout">((resolve) => {
      const ms = Math.max(1, deadline - Date.now());
      setTimeout(() => resolve("timeout"), ms);
    });

    const winner = await Promise.race([watchLoop, timeout]);
    watcher.stop();

    if (winner === "timeout" && remaining.size > 0) {
      for (const r of remaining) collected[r] = synthTimeoutResult(r);
    }
    return collected;
  },
};

// ---- list_templates ---- (only visible in dynamic mode)
export const listTemplates = {
  name: "list_templates",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["local", "a2a"] },
      tags: { type: "array", items: { type: "string" } },
    },
  },
  async execute(args, ctx: ToolContext): Promise<TemplateSummary[]> {
    const q = new URLSearchParams();
    if (args.type) q.set("type", args.type);
    if (args.tags?.length) q.set("tags", args.tags.join(","));
    if (ctx.team?.allowed_templates?.length) q.set("restrict_to", ctx.team.allowed_templates.join(","));
    // user_id resolved from INTERNAL_API_TOKEN bound service identity + from_session_id context, not passed via query
    const { templates: summaries } = await callApiGet(`/internal/templates?${q.toString()}`);
    // Second-pass redaction: remove any sensitive fields
    return summaries.map(redactSensitive);
  },
};

// ---- compose_team ---- (only visible in dynamic mode)
export const composeTeam = {
  name: "compose_team",
  inputSchema: {
    type: "object",
    properties: { spec: { type: "object" } },
    required: ["spec"],
  },
  async execute(args, ctx: ToolContext): Promise<ComposeResponse> {
    if (!ctx.team) throw new ToolError("not_in_team", "compose_team only in team context");
    return callApi(`/internal/teams/${ctx.team.team_id}/compose`, {
      spec: args.spec,
      from_session_id: ctx.session_id,
    });
  },
};
```

### 17.6 Tool Conditional Injection (`tools/resolve.ts` increment)

```ts
// packages/brain/src/tools/resolve.ts (appended to end of existing logic)
function attachTeamTools(schemas: ToolSchema[], ctx: ToolContext, meta: TeamMeta | null): ToolSchema[] {
  if (!ctx.team) return schemas;  // Not a team session, no injection

  const out = [...schemas];

  if (ctx.team.team_role === "leader") {
    out.push(delegateToWorker.schema, teamWait.schema);
    if (meta?.allow_compose && meta.spec === null) {
      out.push(listTemplates.schema, composeTeam.schema);
    }
  }
  // Workers don't get team-tools injected (v1.5 decision)

  // Cross-team a2a_call controlled by execution template allow_a2a_out (§16.5)
  return out;
}
```

### 17.7 agent-loop Integration Points

```ts
// packages/brain/src/agent/agent-loop.ts (key changes)
async function agentLoop(messages, schemas, opts): Promise<ExecuteResult> {
  // ... existing logic ...

  // Increment 1: Inject team context into onEvent
  const teamCtx = opts.team;
  const onEvent: EventCallback = async (evt) => {
    if (teamCtx) {
      evt.team_id = teamCtx.team_id;
      evt.team_role = teamCtx.team_role;
    }
    await opts.onEvent(evt);
  };

  // Increment 2: Inject team-tools (conditional on role and meta.allow_compose)
  let schemasForRound = schemas;
  if (teamCtx) {
    const meta = await loadMetaCached(teamCtx.team_id);
    schemasForRound = attachTeamTools(schemas, { ...opts, team: teamCtx }, meta);
  }

  // ... main loop ...

  // Increment 3: Before exec_complete, if team worker, write result KV
  if (teamCtx && teamCtx.team_role !== "leader") {
    const result: WorkerResult = {
      role: teamCtx.team_role,
      session_id: opts.sessionId,
      final_text: finalText,
      failed: errorCount > 0 && finalText === "",
      tool_stats: toolStats,
      token_usage: tokenUsage,
      elapsed_ms: elapsedMs,
      finished_at: new Date().toISOString(),
    };
    await kv.put(`team.${teamCtx.team_id}.result.${teamCtx.team_role}`,
      sc.encode(JSON.stringify(result))).catch(err => logger.error({err}, "team.result.write_failed"));
  }

  return { finalText, ... };
}
```

### 17.8 SSE Aggregation (`routes/teams.ts` `/events`)

```ts
fastify.get("/v1/teams/:tid/events", async (req, reply) => {
  const tid = req.params.tid;
  const verbose = req.query.verbose === "true";
  const meta = await getMeta(tid, req.user.userId);

  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");

  const sub = nc.subscribe(`sse.events.>`);
  const SUMMARY_TYPES = new Set([
    "statusUpdate", "subagentStart", "subagentEnd",
    "exec_complete", "delegate_to_worker", "team_wait_complete",
    "sandboxStatus",
  ]);

  const heartbeat = setInterval(() => reply.raw.write(":\n\n"), 15_000);

  req.raw.on("close", () => { clearInterval(heartbeat); sub.unsubscribe(); });

  for await (const msg of sub) {
    let evt: any;
    try { evt = JSON.parse(sc.decode(msg.data)); } catch { continue; }
    if (evt.team_id !== tid) continue;
    if (!verbose && !SUMMARY_TYPES.has(evt.type)) continue;
    reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
  }
});
```

### 17.9 Unified Error Code Table

| Code | HTTP | Trigger Condition |
|---|---|---|
| `team_not_found` | 404 | meta KV does not exist |
| `team_not_composed` | 409 | Dynamic mode: delegate before compose |
| `already_composed` | 409 | compose_team called when meta.spec is non-null |
| `already_composed_race` | 409 | CAS failure (concurrent compose) |
| `compose_not_allowed` | 403 | meta.allow_compose=false |
| `dynamic_compose_disabled` | 403 | env feature flag off |
| `not_leader` | 403 | from_session_id ≠ leader_session_id |
| `role_not_found` | 404 | role not in worker_session_ids |
| `template_not_found` | 400 | role.template not in Registry or not visible to user |
| `reserved_field` | 400 | spec contains tools/rules/hooks and other reserved fields |
| `invalid_team_name` / `duplicate_role` / `reserved_role` | 400 | See §17.2 |
| `max_parallel_exceeded` | 400 | roles.length > hard cap |
| `max_parallel_out_of_range` | 400 | max_parallel ∉ [1, 10] |
| `team_no_permission` | 403 | meta.user_id ≠ request user_id |
| `unauthorized` | 401 | Internal endpoint missing INTERNAL_API_TOKEN |

### 17.10 Key Concurrency Scenarios

#### 17.10.1 Concurrent `compose_team`

| Timestamp | Brain-A | Brain-B (after abnormal Leader restart and takeover) |
|---|---|---|
| t1 | Read meta (spec=null) | Read meta (spec=null) |
| t2 | Validate spec → OK | Validate spec → OK |
| t3 | Create worker sessions A | Create worker sessions B |
| t4 | CAS update meta.spec=specA | CAS failure → rollback sessions B → return 409 |

> Leader session lock (NATS KV `lock.<sid>`) already ensures only one Brain processes at any time; theoretically 17.10.1 won't happen. But for robustness, CAS remains as a fallback.

#### 17.10.2 `delegate_to_worker` and `stopTeam` Simultaneously

| Timestamp | Leader Brain | API |
|---|---|---|
| t1 | Call delegate (submit task to NATS) | Receive stop request |
| t2 | Task enters queue | Send interrupt.<workerSid> |
| t3 | Worker Brain picks up task | abort signal already subscribed |
| t4 | Enter agent-loop → immediate abort | exec_complete{failed:false, final_text:""} |
| t5 | Write result KV {failed:false, final_text:""} | DB.status=cancelled |

Leader's `team_wait` receives empty result → Leader prompt should be able to recognize "cancelled" semantics; Brain can additionally check `meta.status=cancelled` in `team_wait` and return immediately.

#### 17.10.3 Worker `exec_complete` and `deleteTeam` Simultaneously

After `deleteTeam` deletes KV, Worker's `kv.put(result)` will **create a new entry** (when KV has no conditional put). Background GC (24h TTL) will handle it. Optional optimization: `agent-loop` checks `kv.get(meta)` for `status != cancelled` before writing result, but adds one RTT; not doing this in v1.

#### 17.10.4 Same Worker Receives Two Consecutive `delegate_to_worker`

| Timestamp | Leader | Worker |
|---|---|---|
| t1 | delegate(role=A, "task1") |  |
| t2 | API submits message1 → NATS task | Brain picks up task → executes task1 |
| t3 | delegate(role=A, "task2") |  |
| t4 | API submits message2 → NATS task | task1 still executing; task2 queued in NATS |
| t5 |  | task1 complete → write result.A (overwrite) → ack |
| t6 |  | Pick up task2 → execute → write result.A (overwrite) |

⚠️ **Design decision**: result KV is "most recent output"; each delegate overwrites previous value. Leader's `team_wait` must understand this semantic. For history, use event-store (differentiated by message_id).

### 17.11 Hands Sandbox Lifecycle and Worker Session Relationship

| Phase | Behavior |
|---|---|
| Worker session creation | **No** ensureHands; no `hands.<sid>` entry in KV |
| First delegate | NATS task arrives → Brain `handleTask` → ensureHands → create K8s workload |
| Subsequent delegates | Use existing "reuse Hands" path (`hands.<sid>` KV exists and health check passes) |
| Worker idle for long time | Hands follows existing sweeper (5min health check) + session keepalive |
| `stopTeam` | Only sends interrupt; Hands not destroyed |
| `deleteTeam` | Send cleanup → destroy Hands K8s workload + delete KV |

> Implication: Worker sessions **do not occupy K8s quota** before `delegate`; mass pre-allocation via templates only occupies DB rows + KV meta. `max_parallel` only constrains the upper limit of **simultaneously delegated** workers (semantic is in documentation, not enforced at runtime; recommend checking active worker count in `delegate_to_worker` for v1.1).

### 17.12 Interrupt Signal Propagation Complete Chain

```
POST /v1/teams/{tid}/stop                                   (API)
   │
   ├─► nats.publish("interrupt.<leader_sid>", "")
   │
   └─► nats.publish("interrupt.<worker_sid_X>", "") ×N

Each Brain instance's intSub subscription:
   for await (msg of nats.subscribe("interrupt.*")):
     sid = msg.subject.split(".")[1]
     ctrl = activeAbort.get(sid)
     if ctrl: ctrl.abort()                               (existing logic)

agent-loop fetch throws AbortError due to abortCtrl.signal       (existing logic)
   │
   └─► handleTask catch (signal.aborted)
        → onEvent(exec_complete {failed:false, final_text:""})  (existing logic)

team-controller.onExecComplete (triggered by event-consumer):
   if team_role === "leader" && status was cancelled:
     skip on_leader_fail handling                        (avoid duplication)
```

### 17.13 Startup Sequence (API Process)

```ts
// packages/api/src/index.ts (incremental pseudocode)
async function main() {
  // ... existing initialization ...

  // 1. NATS KV create TEAM_STATE bucket (TTL configurable)
  await js.views.kv("TEAM_STATE", {
    ttl: Number(process.env.TEAM_STATE_KV_TTL_MS ?? 24 * 3600 * 1000),
  });

  // 2. Load built-in static team templates (FS scan + compile + validate)
  for (const f of fs.readdirSync(TEAM_TEMPLATES_DIR)) {
    if (!f.endsWith(".yaml")) continue;
    try {
      const spec = compileStaticTemplate(`${TEAM_TEMPLATES_DIR}/${f}`);
      teamTemplateRegistry.set(spec.team, spec);
    } catch (e) {
      logger.error({ err: e, file: f }, "team_template.load_failed");
      throw e;  // fail fast
    }
  }

  // 3. Register routes
  fastify.register(require("./routes/teams").default);
  fastify.register(require("./routes/teams-internal").default);

  // 4. event-consumer subscribes to exec_complete events, triggers team-controller.onExecComplete
  eventConsumer.on("exec_complete", onExecComplete);

  // ... rest ...
}
```

### 17.14 Configuration Items Overview

| Environment Variable | Default | Description |
|---|---|---|
| `INTERNAL_API_URL` | `http://localhost:8200` | Brain calls API internal endpoints |
| `INTERNAL_API_TOKEN` | (required) | Internal credential shared between API and Brain |
| `TEAM_ALLOW_DYNAMIC_COMPOSE` | `false` | Global switch: whether `auto` entry is allowed |
| `TEAM_TEMPLATES_DIR` | `/etc/claw/team-templates` | Static team template directory |
| `TEAM_STATE_KV_TTL_MS` | `86400000` | TEAM_STATE bucket TTL (24h) |
| `TEAM_RESULT_WAIT_DEFAULT_MS` | `1800000` | `team_wait` default timeout |
| `TEAM_DELEGATE_MAX_RETRIES` | `3` | Internal HTTP delegate network failure retry count |
| `MAX_PARALLEL_HARD_CAP` | `10` | Global max_parallel upper limit |

---

## 18. Execution Runbook

This chapter is for directly implementing the design into engineering; following the order avoids rework.

### 18.1 Pre-Development Checklist

| Check Item | Pass Criteria |
|---|---|
| Execution template dependency available | `GET /v1/templates` returns at least `team-leader`, `cpu-shell`, `readonly` |
| Internal credential configuration | Both API and Brain have `INTERNAL_API_TOKEN` configured with matching values |
| KV bucket | `TEAM_STATE` can be created, TTL controlled by `TEAM_STATE_KV_TTL_MS` |
| Route conflict | `/v1/teams*` has no path conflict with existing `/v1/sessions*` |
| Event pathway | `event-consumer` can receive `exec_complete` and can append team fields |
| A2A whitelist | `A2A_PEERS_JSON` has at least 1 available peer configured (e.g., `ci`) |

### 18.2 Implementation Order (Code Level)

| Step | File Group | Output |
|---|---|---|
| S1 | `protocol/src/types.ts` | `TeamContext`, `TeamSpec`, `WorkerResult` type implementation |
| S2 | `api/src/infra/db.ts` + migration | `teams` table, `sessions.team_*` fields, indexes |
| S3 | `api/src/infra/nats.ts` | `TEAM_STATE` KV initialization and TTL configuration |
| S4 | `api/src/team-spec.ts` | Static template compilation + TeamSpec validation |
| S5 | `api/src/team-controller.ts` | `create/stop/delete/onExecComplete` implementation |
| S6 | `api/src/routes/teams.ts` | `/v1/teams*` external routes |
| S7 | `api/src/routes/teams-internal.ts` | `/internal/teams/{delegate,compose}` |
| S8 | `brain/src/team-tools.ts` | `delegate_to_worker/team_wait/list_templates/compose_team` |
| S9 | `brain/src/tools/resolve.ts` | Inject tools based on `team_role` + `allow_compose` |
| S10 | `brain/src/agent/agent-loop.ts` | Team event passthrough + `result.<role>` KV write |
| S11 | `api/src/routes/events.ts` | `team_id` aggregate SSE filtering capability |
| S12 | `api/src/index.ts` | Route registration, team template loading, event subscription |

### 18.3 Request/Response Examples (Ready for Integration Testing)

#### Create Static Team

```bash
curl -sS -X POST "http://localhost:8200/v1/teams" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -d '{
    "template": "ml-research",
    "initial_prompt": "Complete a minimal reproducible experiment and output conclusions."
  }'
```

Success response:

```json
{
  "team_id": "team-0f9f6b1e-57af-4f6d-a8d3-3fe5e7f9a0d3",
  "leader_session_id": "sess_leader_xxx",
  "worker_session_ids": {
    "data-prep": "sess_worker_a",
    "trainer": "sess_worker_b",
    "evaluator": "sess_worker_c"
  }
}
```

#### Create Dynamic Team (auto)

```bash
curl -sS -X POST "http://localhost:8200/v1/teams" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -d '{
    "auto": {
      "leader_template": "team-leader",
      "allowed_templates": ["cpu-shell","readonly","gpu-pytorch","a2a-ci-lint"]
    },
    "initial_prompt": "First list templates, then assemble a 3-role team."
  }'
```

Dynamic mode success response (before compose):

```json
{
  "team_id": "team-xxxx",
  "leader_session_id": "sess_leader_xxx",
  "worker_session_ids": null
}
```

#### Internal delegate (Brain calls API)

```bash
curl -sS -X POST "http://localhost:8200/internal/teams/team-xxxx/delegate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" \
  -d '{
    "role": "trainer",
    "prompt": "Train a baseline and record metrics.",
    "from_session_id": "sess_leader_xxx"
  }'
```

#### Internal compose (Dynamic Team Composition)

```bash
curl -sS -X POST "http://localhost:8200/internal/teams/team-xxxx/compose" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" \
  -d '{
    "from_session_id": "sess_leader_xxx",
    "spec": {
      "team": "ml-auto",
      "max_parallel": 3,
      "on_leader_fail": "stop",
      "leader": { "role": "leader", "template": "team-leader", "prompt": "orchestrate" },
      "roles": [
        { "name": "prep", "template": "cpu-shell", "prompt": "prepare data" },
        { "name": "train", "template": "gpu-pytorch", "prompt": "train model" },
        { "name": "lint", "template": "a2a-ci-lint", "prompt": "lint outputs" }
      ],
      "coordination": { "result_wait_timeout_ms": 1800000 }
    }
  }'
```

### 18.4 Database Migration and Rollback

#### Forward Migration (Illustrative)

```sql
ALTER TABLE claw_sessions ADD COLUMN IF NOT EXISTS team_id TEXT;
ALTER TABLE claw_sessions ADD COLUMN IF NOT EXISTS team_role TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_team_id ON claw_sessions(team_id);

CREATE TABLE IF NOT EXISTS teams (
  team_id TEXT PRIMARY KEY,
  template_name TEXT,
  leader_session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  meta JSONB
);
CREATE INDEX IF NOT EXISTS idx_teams_status ON teams(status);
```

#### Rollback Strategy

| Scenario | Action |
|---|---|
| New code deployment fails, need quick rollback | Roll back service image first, don't immediately roll back table schema |
| Data already written to `teams` table | Keep table, disable entry via feature flag (`TEAM_ALLOW_DYNAMIC_COMPOSE=false` + API route disabled) |
| Confirmed permanent removal | Export offline before DROP (execute only during maintenance window) |

### 18.5 Test Matrix (Minimum Required)

| Category | Test Case | Expected |
|---|---|---|
| Team Spec validation | Duplicate role name | 400 `duplicate_role` |
| Team Spec validation | role.template doesn't exist | 400 `template_not_found` |
| Dynamic composition | `allow_compose=false` calls compose | 403 `compose_not_allowed` |
| Internal security | Missing `INTERNAL_API_TOKEN` | 401 `unauthorized` |
| Delegate execution | Consecutive delegate to same role twice | Sequential execution, result KV is most recent |
| `team_wait` | No events trigger timeout | Returns synthesized timeout result (non-blocking) |
| Stop flow | stop while worker executing | Receives interrupt, finishes quickly |
| Delete flow | delete broadcasts cleanup | Hands destroyed, KV cleaned |
| A2A worker | role.template is `type=a2a` | Uses a2a_client, result contains `a2a_peer` |

### 18.6 Observability and Alerting

| Metric Name (Suggested) | Dimensions | Alert Suggestion |
|---|---|---|
| `team_create_total` | `status` | Failure rate > 20% for 5 consecutive minutes |
| `team_delegate_total` | `role,status` | Delegate failure rate for a role > 10% |
| `team_wait_timeout_total` | `team_template` | Sustained increase in timeout rate triggers alert |
| `team_active_gauge` | None | Alert when exceeding capacity threshold |
| `team_internal_api_401_total` | `route` | Alert on any occurrence (possible credential drift) |
| `team_result_write_fail_total` | `role` | >0 immediate alert (KV availability issue) |

**Log Key Fields** (Unified JSON):
- `team_id`, `team_role`, `leader_session_id`, `worker_session_id`, `message_id`
- `template_id`, `a2a_peer`, `error_code`, `elapsed_ms`

### 18.7 Gradual Rollout and Feature Switch Strategy

| Phase | Switch | Description |
|---|---|---|
| Phase-A | Routes disabled | Deploy code only, don't expose `/v1/teams` |
| Phase-B | Static mode only | Enable `/v1/teams`, `TEAM_ALLOW_DYNAMIC_COMPOSE=false` |
| Phase-C | Dynamic mode gradual | Enable `TEAM_ALLOW_DYNAMIC_COMPOSE=true` for whitelisted users |
| Phase-D | A2A worker gradual | Only allow `a2a-ci-lint` template |

### 18.8 Rollback Handbook

| Level | Trigger Condition | Rollback Action |
|---|---|---|
| L1 Feature rollback | `team_wait_timeout_total` abnormal increase | Disable `/v1/teams` route exposure, keep internal routes |
| L2 Mode rollback | Dynamic composition anomaly | `TEAM_ALLOW_DYNAMIC_COMPOSE=false` |
| L3 External dependency rollback | A2A peer unstable | Suspend `type=a2a` template visibility (Registry layer filtering) |
| L4 Full rollback | Core path instability | Roll back image to previous version; preserve data structures, review later |
