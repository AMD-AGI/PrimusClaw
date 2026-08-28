# Claw Long-Term Memory + Skill Self-Evolution Design

> Version: 2026-04-20 v3.5 (6 bug fixes from independent codex review + periodic review mechanism established)
> Based on: Claw V2 architecture + Hermes/SkillClaw mechanism analysis + multiple review rounds + code review + implementation feedback
>
> **v3.0 major changes**: All Phase 0-3 have been landed, with second-round improvements based on testing and SkillClaw lessons.
> Old chapters (1-12) are retained as design evolution records; **actual implementation is based on Section 13**.

---

## Table of Contents

1. [Current State Assessment](#1-current-state-assessment)
2. [Design Goals and Principles](#2-design-goals-and-principles)
3. [Overall Architecture](#3-overall-architecture)
4. [Data Model (2 New Tables)](#4-data-model-2-new-tables)
5. [Long-Term Memory Design](#5-long-term-memory-design)
6. [save_memory / save_skill Tool Design](#6-save_memory--save_skill-tool-design)
7. [Skill Full Lifecycle (Creation + Evolution + Usage)](#7-skill-full-lifecycle-creation--evolution--usage)
8. [Skill and SaFE Marketplace Relationship](#8-skill-and-safe-marketplace-relationship)
9. [Self-Learning Loop (Nudge Mechanism)](#9-self-learning-loop-nudge-mechanism)
10. [Observability](#10-observability)
11. [Phased Implementation Plan](#11-phased-implementation-plan)
12. [Review Records](#12-review-records)
13. [**v3.0 Implementation Status (Source of Truth)**](#13-v30-implementation-status-source-of-truth)

---

## 1. Current State Assessment

| Capability | Status | Gap |
|------|------|------|
| **Short-term memory** | `claw_conversation_turns` sliding window | ✅ Implemented |
| **Medium-term memory** | `claw_session_summaries` concatenation with truncation (comment "replace with LLM call later") | ⚠️ Needs upgrade to LLM summary |
| **Long-term memory** | None | ❌ Entirely new |
| **Skill storage** | Downloaded from SaFE marketplace + request inline, no local storage | ❌ Cannot save self-generated Skills |
| **Skill creation** | No auto-generation capability | ❌ Entirely new |
| **Skill evolution** | No execution tracking and improvement mechanism | ❌ Entirely new |
| **Self-learning loop** | None | ❌ Entirely new |

**Key existing files**:

| File | Purpose |
|------|------|
| `packages/api/src/sessions/context-builder.ts` | Build history + system prompt, sliding window |
| `packages/api/src/events/consumer.ts` | Consume NATS events, handleComplete saves turns, summaries, dispatches pending |
| `packages/api/src/infra/db.ts` | PostgreSQL migrations: claw_conversation_turns / claw_session_summaries / claw_pending_messages |
| `packages/brain/src/agent/agent-loop.ts` | Agent loop: LLM → tool_use → route → tool_result → repeat |
| `packages/brain/src/engines/claude.ts` | Claude engine: resolve tools → build prompt → pre-hooks → agent loop → post-hooks |
| `packages/brain/src/agent/prompt.ts` | buildPrompt: inject skills + MCP hints + execution policy |
| `packages/brain/src/tools/router.ts` | Tool routing: Hands MCP / Platform MCP |
| `packages/brain/src/tools/resolve.ts` | Download MCP configs and skill text from SaFE marketplace |
| `packages/protocol/src/types.ts` | ExecuteRequest / Message / TokenUsage / ExecuteResult types |

---

## 2. Design Goals and Principles

### 2.1 Goals

1. **Cross-session long-term memory**: Agent remembers user preferences, environment facts, historical corrections; automatically applied in new sessions
2. **Automatic Skill creation**: After complex tasks succeed, automatically distilled into reusable Skills
3. **Skill self-evolution**: When Skill execution statistics worsen, LLM automatically analyzes and generates improved versions
4. **Self-learning loop**: Dual-channel memory writing + dual-channel Skill creation, minimal user intervention

### 2.2 Architecture Constraints

```
1. Brain is completely stateless: does not write DB, only emits events. Memory and Skill read/write completed at API layer
2. Multi-user isolation: all memory and Skills isolated by user_id
3. Does not block main flow: memory extraction, Skill creation/analysis are async background tasks; failures don't affect core functionality
4. Only 2 new tables: claw_memory_entries + claw_skills; Skill execution stats reuse claw_session_events
5. No new external dependencies: only uses existing PostgreSQL + LLM API
```

---

## 3. Overall Architecture

```
User sends message
    │
    ▼
API (routes/sessions.ts — dispatch task)
    ├── 1. buildMessages (sessions/context-builder.ts)
    │       ├── Load top-K long-term memories from DB (by importance DESC, unconditionally injected into system prompt)
    │       ├── Load user profile from DB (special memory with category='user_profile')
    │       └── Build history (short-term turns + medium-term LLM summary)
    ├── 2. Read local active Skills from DB → write to task.skills field
    │       (Brain-side merges with marketplace skills, marketplace takes priority)
    └── 3. Submit NATS task → Brain executes
                                │
                                ▼
                         Brain (agent/agent-loop.ts)
                         ├── tools/resolve.ts downloads marketplace skills
                         ├── claude.ts merges skills (marketplace > request/local)
                         ├── agent/prompt.ts writes to .skills/ directory, Agent reads on demand
                         ├── During conversation can call save_memory / save_skill tools
                         └── Execution complete → exec_complete event
                                │    (carries user_id / skills_used / error_count
                                │      / memories_to_save / skills_to_save)
                                ▼
                    events/consumer.ts (handleComplete)
                         ├── 4. Save turns (existing)
                         ├── 5. Process save_memory / save_skill events → write to DB (Phase 2)
                         ├── 6. Process pending messages (existing)
                         └── 7. Background async (setImmediate, failure allowed)
                              ├── maybeSummarize — upgrade to LLM (Phase 1)
                              ├── maybeExtractMemory — background LLM memory extraction (Phase 1)
                              ├── maybeCreateSkill — background LLM Skill distillation (Phase 3)
                              └── maybeEvolveSkill — background stats analysis + improvement (Phase 3)
```

---

## 4. Data Model (2 New Tables)

### 4.1 Why 2 Tables Instead of 4

| Original Plan | Issue | Fix |
|--------|------|------|
| `claw_memory_entries` | Keep | ✅ Retained, user profile as special entry with `category='user_profile'` |
| `claw_user_profiles` | Essentially an aggregate view of memory | ❌ Removed, merged into `claw_memory_entries` |
| `claw_skill_executions` | Reuse existing `claw_session_events` (after Phase 0 extends exec_complete to include skills_used/turns/errors) | ❌ Removed |
| `claw_skill_revisions` | Needed, but should handle both "Skill storage" and "version management" | ✅ Renamed to `claw_skills` |

### 4.2 Schema

```sql
-- Table 1: Long-term memory
-- Including user profile (category='user_profile', max 1 per user, importance=1.0)
CREATE TABLE IF NOT EXISTS claw_memory_entries (
    id              SERIAL PRIMARY KEY,
    user_id         TEXT NOT NULL,
    category        TEXT NOT NULL,
                    -- 'preference' | 'correction' | 'env_fact' | 'tool_quirk' | 'pattern' | 'user_profile'
    content         TEXT NOT NULL,
    content_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    importance      REAL DEFAULT 0.5,       -- 0~1
    source_session  TEXT,
    source_type     TEXT DEFAULT 'auto',    -- 'auto' | 'explicit'
    access_count    INT DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    last_accessed   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memory_user ON claw_memory_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_importance ON claw_memory_entries(user_id, importance DESC);
CREATE INDEX IF NOT EXISTS idx_memory_tsv ON claw_memory_entries USING GIN(content_tsv);
CREATE UNIQUE INDEX IF NOT EXISTS unique_user_profile ON claw_memory_entries(user_id) WHERE category = 'user_profile';

-- Table 2: Skill storage + version management
-- Unified management of all Skill versions from auto-creation, manual creation, and self-evolution
CREATE TABLE IF NOT EXISTS claw_skills (
    id              SERIAL PRIMARY KEY,
    skill_name      TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    version         INT NOT NULL DEFAULT 1,
    content         TEXT NOT NULL,          -- Full Skill text
    source          TEXT DEFAULT 'auto',    -- 'auto'(auto-created) | 'manual'(user-written) | 'evolved'(self-evolved)
    status          TEXT DEFAULT 'active',  -- 'active' | 'archived' | 'rolled_back'
    change_reason   TEXT,                   -- Reason for creation/improvement
    source_session  TEXT,                   -- Source session_id
    analysis        JSONB DEFAULT '{}',     -- Analysis data during self-evolution
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(skill_name, user_id, version)
);
CREATE INDEX IF NOT EXISTS idx_skills_user ON claw_skills(user_id, status);
CREATE INDEX IF NOT EXISTS idx_skills_name ON claw_skills(skill_name, user_id, version DESC);
```

### 4.3 Skill Execution Statistics (Reuse claw_session_events)

No separate table needed. Requires extending `exec_complete` events (Phase 0 prerequisite modification) to carry `skills_used`, `turns`, `error_count`, `failed`, `user_id`.

**`skills_used` format**: JSONB object `{"skill-name": version_number}`, e.g., `{"react-scaffold": 2, "deploy-k8s": 1}`. Using object instead of array because JSONB `?` operator can directly query by key (skill name), with version number as value for rollback attribution.

After extension, direct query:

```typescript
async function getSkillStats(skillName: string, days = 7) {
  return (await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE (data->>'failed')::boolean IS NOT TRUE) as successes,
      AVG((data->>'turns')::int) as avg_turns,
      AVG(COALESCE((data->>'error_count')::int, 0)) as avg_errors
    FROM claw_session_events
    WHERE event = 'exec_complete'
      AND data->'skills_used' ? $1
      AND created_at > NOW() - INTERVAL '${days} days'
  `, [skillName])).rows[0];
}

async function getSkillStatsForVersion(skillName: string, userId: string, version: number) {
  return (await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE (data->>'failed')::boolean IS NOT TRUE) as successes
    FROM claw_session_events
    WHERE event = 'exec_complete'
      AND data->>'user_id' = $1
      AND (data->'skills_used'->>$2)::int = $3
  `, [userId, skillName, version])).rows[0];
}
```

---

## 5. Long-Term Memory Design

### 5.1 Memory Categories

| Category | Description | Example |
|------|------|------|
| `preference` | User preferences and habits | "User prefers pnpm over npm" |
| `correction` | User corrections to Agent | "Don't use any type, use strict TypeScript" |
| `env_fact` | Environment/project persistent facts | "Production database is PostgreSQL 15, port 5432" |
| `tool_quirk` | Tool tips/pitfalls | "This cluster's kubectl requires export KUBECONFIG=... first" |
| `pattern` | Successful operation patterns | "User habitually writes tests before implementation" |
| `user_profile` | **Special**: User profile aggregation | "Tech preferences: TypeScript, React, pnpm..." |

### 5.2 Capacity Control

- **Hard limit**: Max 50 memories per user (including user_profile)
- **Over-limit strategy**: On insert over limit, evict the entry with lowest importance + oldest last_accessed
- **Injection budget**: Memory block in system prompt max 3K tokens
- **tsvector**: Only for management-side search and deduplication, **not used** for context injection recall

```typescript
const MAX_MEMORY_ENTRIES = 50;

async function insertMemoryEntry(userId: string, entry: MemoryEntry): Promise<void> {
  const count = (await db.query(
    "SELECT COUNT(*) as cnt FROM claw_memory_entries WHERE user_id = $1", [userId]
  )).rows[0].cnt;

  if (count >= MAX_MEMORY_ENTRIES) {
    await db.query(`
      DELETE FROM claw_memory_entries
      WHERE id = (
        SELECT id FROM claw_memory_entries
        WHERE user_id = $1 AND category != 'user_profile'
        ORDER BY importance ASC, last_accessed ASC LIMIT 1
      )
    `, [userId]);
  }

  await db.query(`
    INSERT INTO claw_memory_entries (user_id, category, content, importance, source_session, source_type)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [userId, entry.category, entry.content, entry.importance, entry.sourceSession, entry.sourceType]);
}
```

### 5.3 Write Path A: Background Extraction (Nudge)

**Trigger condition**: After exec_complete, turns ≥ 3, executed asynchronously.

```typescript
async function maybeExtractMemory(sessionId: string, userId: string): Promise<void> {
  const turnCount = await getTurnCount(sessionId);
  if (turnCount < 3) return;

  const recentTurns = await getRecentTurns(sessionId, 10);
  const existingMemory = await getMemoryEntries(userId, 30);

  const result = await callMemoryLLM(EXTRACT_MEMORY_PROMPT, {
    conversation: formatTurns(recentTurns),
    existing_memory: formatMemories(existingMemory),
  });

  for (const entry of result.entries) {
    await insertMemoryEntry(userId, { ...entry, sourceSession: sessionId, sourceType: "auto" });
  }

  await maybeUpdateUserProfile(userId);
}
```

**Extraction Prompt**:

```
You are a memory extractor. Analyze the following conversation and extract facts worth remembering long-term.

Only extract the following types:
- preference: User's explicit preferences and habits
- correction: User's corrections
- env_fact: Environment/project persistent facts
- tool_quirk: Tool tips or pitfalls
- pattern: Successful operation patterns

Existing memories (avoid duplicates):
{existing_memory}

Conversation content:
{conversation}

Rules:
1. Only extract persistent facts useful for future sessions, not task progress or temporary state
2. Each entry should be one concise declarative sentence
3. Return empty array if nothing to extract
4. Don't duplicate existing memories
5. importance: explicit preference/correction → 0.8+, environment facts → 0.6, operation patterns → 0.5

Return JSON: { "entries": [{ "category": "...", "content": "...", "importance": 0.8 }] }
```

### 5.4 Write Path B: Agent Active Save

See [Section 6](#6-save_memory--save_skill-tool-design).

### 5.5 Read Path: Unconditional Injection

**Strategy**: Each time context is built, inject the user's top-K memories (by importance DESC), without query matching.

**Modify `sessions/context-builder.ts`**:

```typescript
export async function buildMessages(
  sessionId: string,
  prompt: string,
  userId: string,
  rulesText = "",
  systemAppend = "",
): Promise<Message[]> {
  const AVAILABLE = 174_000;
  const MEMORY_BUDGET = 3_000;
  const messages: Message[] = [];
  const systemParts: string[] = [];

  // 1. User profile (memory entry with user_profile category)
  const profileRow = (await db.query(
    "SELECT content FROM claw_memory_entries WHERE user_id = $1 AND category = 'user_profile' LIMIT 1",
    [userId]
  )).rows[0];
  if (profileRow?.content) {
    systemParts.push(`## User Profile\n${profileRow.content}`);
  }

  // 2. Long-term memory (exclude user_profile, top-K by importance)
  const memories = (await db.query(`
    SELECT id, category, content FROM claw_memory_entries
    WHERE user_id = $1 AND category != 'user_profile'
    ORDER BY importance DESC, last_accessed DESC
    LIMIT 30
  `, [userId])).rows;

  if (memories.length) {
    const memoryBlock = memories.map((m: any) => `- [${m.category}] ${m.content}`).join("\n");
    if (estimateTokens(memoryBlock) <= MEMORY_BUDGET) {
      systemParts.push(`## Long-term Memory\n${memoryBlock}`);
      const ids = memories.map((m: any) => m.id);
      db.query(
        "UPDATE claw_memory_entries SET access_count = access_count + 1, last_accessed = NOW() WHERE id = ANY($1)",
        [ids]
      ).catch(() => {});
    }
  }

  // 3. Session summary (existing)
  const summaryRow = (await db.query(
    "SELECT summary FROM claw_session_summaries WHERE session_id = $1", [sessionId],
  )).rows[0];
  if (summaryRow?.summary) {
    systemParts.push(`## Session Summary\nEarlier in this session:\n${summaryRow.summary}`);
  }

  // 4. Rules / System Append (existing)
  if (rulesText) systemParts.push(rulesText);
  if (systemAppend) systemParts.push(systemAppend);

  const fixedTokens = estimateTokens(systemParts.join("\n\n")) + estimateTokens(prompt);
  const remaining = AVAILABLE - fixedTokens;

  if (systemParts.length) {
    messages.push({ role: "system", content: systemParts.join("\n\n") });
  }

  const history = await buildHistory(sessionId, Math.max(remaining, 10_000));
  messages.push(...history);
  messages.push({ role: "user", content: prompt });
  return messages;
}
```

### 5.6 User Profile

User profile is a special entry in `claw_memory_entries` with `category='user_profile'`, max 1 per user.

```typescript
async function maybeUpdateUserProfile(userId: string): Promise<void> {
  const entries = (await db.query(`
    SELECT content FROM claw_memory_entries
    WHERE user_id = $1 AND category IN ('preference', 'correction')
    ORDER BY importance DESC LIMIT 30
  `, [userId])).rows;

  if (!entries.length) return;

  const current = (await db.query(
    "SELECT content FROM claw_memory_entries WHERE user_id = $1 AND category = 'user_profile'",
    [userId]
  )).rows[0]?.content || "";

  const result = await callMemoryLLM(USER_PROFILE_PROMPT, {
    current_profile: current,
    memory_entries: entries.map((r: any) => r.content),
  });

  await db.query(`
    INSERT INTO claw_memory_entries (user_id, category, content, importance, source_type)
    VALUES ($1, 'user_profile', $2, 1.0, 'auto')
    ON CONFLICT ON CONSTRAINT unique_user_profile
    DO UPDATE SET content = $2, last_accessed = NOW()
  `, [userId, result.profile]);
}
```

> Note: The partial unique constraint `unique_user_profile` is defined in the 4.2 Schema.

### 5.7 Memory Decay (Daily Scheduled Task)

```typescript
async function decayMemory(): Promise<void> {
  await db.query(`
    UPDATE claw_memory_entries
    SET importance = GREATEST(0.05, importance * 0.98)
    WHERE category != 'user_profile'
      AND last_accessed < NOW() - INTERVAL '7 days'
  `);

  const deleted = await db.query(`
    DELETE FROM claw_memory_entries
    WHERE importance < 0.05 AND access_count = 0
      AND category != 'user_profile'
      AND created_at < NOW() - INTERVAL '30 days'
    RETURNING id
  `);

  if (deleted.rowCount) logger.info({ deletedCount: deleted.rowCount }, "memory.decay_cleanup");
}
```

---

## 6. save_memory / save_skill Tool Design

### 6.1 Two Tool Definitions

```typescript
const saveMemoryTool: ToolSchema = {
  name: "save_memory",
  description:
    "Save a durable fact to long-term memory for future sessions. " +
    "Use when: (1) user explicitly asks to remember something, " +
    "(2) you discover an important environment/project fact, " +
    "(3) user corrects you and the correction is generally applicable. " +
    "Do NOT save task progress or session-specific details.",
  input_schema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["preference", "correction", "env_fact", "tool_quirk", "pattern"],
      },
      content: { type: "string", description: "One concise sentence" },
      importance: { type: "number", minimum: 0, maximum: 1, description: "Default 0.7" },
    },
    required: ["category", "content"],
  },
};

const saveSkillTool: ToolSchema = {
  name: "save_skill",
  description:
    "Save the current approach as a reusable skill for future tasks. " +
    "Use when: (1) user explicitly asks to save a workflow, " +
    "(2) you completed a complex multi-step task with reusable value. " +
    "Provide a clear name and structured content.",
  input_schema: {
    type: "object",
    properties: {
      skill_name: { type: "string", description: "Short kebab-case name, e.g. 'react-scaffold'" },
      content: { type: "string", description: "Full skill text with ## Goal, ## Steps, ## Notes" },
    },
    required: ["skill_name", "content"],
  },
};
```

### 6.2 Execution Path

```
API (routes/sessions.ts)
    │ Read local active Skills from DB → write to task.skills field
    │ Submit NATS task
    ▼
Brain (claude.ts)
    │ resolveToolIds downloads marketplace Skills
    │ Merge skills: marketplace(overrides) > request.skills(including local)
    │ Write to .skills/ directory (Agent reads on demand via bash cat)
    ▼
Brain (agent-loop)
    │ LLM calls save_memory or save_skill
    ▼
tools/router.ts
    │ Handle locally, not through Hands MCP
    │ Cache to router.pendingMemories / router.pendingSkills
    │ Return confirmation text to LLM
    ▼
exec_complete event carries memories_to_save / skills_to_save / skills_used
    ▼
events/consumer.ts (handleComplete)
    │ Security scan → write to DB
    │ save_memory → claw_memory_entries (directly active)
    │ save_skill → claw_skills (directly active, version=1)
    ▼
Next dispatch task automatically reads from DB into task.skills
```

> **Note**: Skill content is not directly injected into system prompt but uses the existing file-based mechanism — Brain writes Skill content to `.skills/{name}/SKILL.md`, Agent reads on demand via `bash cat`. Local Skills merge point is at API dispatch task time (written to `task.skills` field), merged with marketplace Skills on Brain side.

### 6.3 Brain Side

```typescript
// tools/router.ts
async route(toolName: string, input: Record<string, unknown>): Promise<string> {
  if (toolName === "save_memory") {
    this.pendingMemories.push({
      category: input.category as string,
      content: input.content as string,
      importance: (input.importance as number) ?? 0.7,
    });
    return "Memory saved. It will be available in future sessions.";
  }
  if (toolName === "save_skill") {
    this.pendingSkills.push({
      skill_name: input.skill_name as string,
      content: input.content as string,
    });
    return `Skill '${input.skill_name}' saved. It will be used automatically in future tasks.`;
  }
  // ... Hands/MCP routing ...
}
```

### 6.4 API Side Processing

```typescript
// events/consumer.ts — in handleComplete
// Process save_memory
for (const mem of (event.memories_to_save as any[]) || []) {
  const blocked = scanMemoryContent(mem.content);
  if (blocked) { logger.warn({ reason: blocked }, "memory.blocked"); continue; }
  await insertMemoryEntry(userId, { ...mem, sourceSession: sessionId, sourceType: "explicit" });
}

// Process save_skill — directly active, no approval needed
for (const skill of (event.skills_to_save as any[]) || []) {
  const blocked = scanMemoryContent(skill.content);
  if (blocked) { logger.warn({ reason: blocked }, "skill.blocked"); continue; }
  await db.query(`
    INSERT INTO claw_skills (skill_name, user_id, version, content, source, status, source_session)
    VALUES ($1, $2, 1, $3, 'manual', 'active', $4)
    ON CONFLICT (skill_name, user_id, version) DO UPDATE SET content = $3, status = 'active'
  `, [skill.skill_name, userId, skill.content, sessionId]);
}
```

### 6.5 Security Scanning

```typescript
const THREAT_PATTERNS = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { pattern: /you\s+are\s+now\s+/i, id: "role_hijack" },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: "deception" },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules)/i, id: "disregard" },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD)/i, id: "exfil" },
];

function scanMemoryContent(content: string): string | null {
  for (const { pattern, id } of THREAT_PATTERNS) {
    if (pattern.test(content)) return `Blocked: threat pattern '${id}'`;
  }
  if (content.length > 2000) return "Blocked: content too long (max 2000 chars)";
  return null;
}
```

---

## 7. Skill Full Lifecycle (Creation + Evolution + Usage)

### 7.1 Three Ways to Create Skills

| Method | Trigger | Initial Status |
|------|------|---------|
| **Auto distillation** | After complex task succeeds (turns≥5, tools≥3 types) | **active** |
| **save_skill tool** | User says "save this workflow" during conversation | **active** |
| **Manual API creation** | `POST /v1/users/:userId/skills` | **active** |

**No manual approval needed throughout. Creation goes directly to active, evolution auto-updates with statistical rollback as safety net.**

### 7.2 Auto Distillation (maybeCreateSkill)

```typescript
async function maybeCreateSkill(sessionId: string, userId: string, event: any): Promise<void> {
  if (event.failed) return;
  if ((event.turns as number) < 5) return;
  if ((event.error_count as number) > 5) return;

  const toolEvents = await getSessionToolEvents(sessionId);
  const toolTypes = new Set(toolEvents.map((e: any) => e.tool));
  if (toolTypes.size < 3) return;

  const existingSkills = await getUserSkillNames(userId);

  const result = await callMemoryLLM(CREATE_SKILL_PROMPT, {
    user_prompt: event.prompt,
    tool_sequence: formatToolSequence(toolEvents),
    final_result: (event.final_text as string)?.slice(0, 2000),
    existing_skills: existingSkills,
  });

  if (result.should_create && result.skill_content) {
    await db.query(`
      INSERT INTO claw_skills (skill_name, user_id, version, content, source, status, change_reason, source_session)
      VALUES ($1, $2, 1, $3, 'auto', 'active', $4, $5)
      ON CONFLICT (skill_name, user_id, version) DO NOTHING
    `, [result.skill_name, userId, result.skill_content, result.reason, sessionId]);

    logger.info({ skillName: result.skill_name, userId }, "skill.auto_created");
  }
}
```

**Skill Distillation Prompt**:

```
You are a Skill distiller. Analyze the following successfully completed task and determine if it's worth distilling into a reusable Skill.

## User's original request:
{user_prompt}

## Tool call sequence executed:
{tool_sequence}

## Final result:
{final_result}

## Existing Skills (avoid duplicates):
{existing_skills}

Criteria:
1. Is the workflow generalizable? (not a one-off special operation)
2. Are the steps sufficiently complex? (3+ tools coordinated)
3. Does it contain non-obvious tricks or ordering?
4. Does it duplicate existing Skills?

If worth it, return:
{
  "should_create": true,
  "skill_name": "kebab-case-name",
  "reason": "Why it's worth saving",
  "skill_content": "## Goal\n...\n## Steps\n1. ...\n## Notes\n- ..."
}
Otherwise: { "should_create": false, "reason": "..." }
```

### 7.3 Self-Evolution (maybeEvolveSkill)

**Trigger condition: statistical trend**, not single failure.

```typescript
async function shouldEvolveSkill(skillName: string): Promise<boolean> {
  const stats = await getSkillStats(skillName, 7);
  if (stats.total < 5) return false;
  const failRate = (stats.total - stats.successes) / stats.total;
  return failRate > 0.3 || stats.avg_turns > 20 || stats.avg_errors > 3;
}
```

**Evolution flow** (auto-update, no approval needed):

```typescript
async function maybeEvolveSkill(sessionId: string, userId: string, event: any): Promise<void> {
  // skills_used format is {"skill-name": 1, "other": 2}, key=skill name, value=version number
  const skillsUsed = (event.skills_used as Record<string, number>) || {};

  for (const skillName of Object.keys(skillsUsed)) {
    // Only evolve local Skills, don't touch marketplace Skills
    const activeSkill = (await db.query(
      "SELECT id, version FROM claw_skills WHERE skill_name = $1 AND user_id = $2 AND status = 'active'",
      [skillName, userId]
    )).rows[0];
    if (!activeSkill) continue;

    // First check if previous evolution needs rollback
    await maybeAutoRollback(skillName, userId);

    if (!(await shouldEvolveSkill(skillName))) continue;

    const currentContent = await getActiveSkillContent(skillName, userId);
    if (!currentContent) continue;

    const stats = await getSkillStats(skillName, 7);
    const toolEvents = await getSessionToolEvents(sessionId);

    const analysis = await callMemoryLLM(EVOLVE_SKILL_PROMPT, {
      skill_name: skillName,
      skill_content: currentContent,
      stats: JSON.stringify(stats),
      latest_execution_log: formatToolSequence(toolEvents),
    });

    if (analysis.needs_revision && analysis.revised_content) {
      const currentVersion = await getLatestVersion(skillName, userId);

      // Archive old version
      await db.query(
        "UPDATE claw_skills SET status = 'archived' WHERE skill_name = $1 AND user_id = $2 AND status = 'active'",
        [skillName, userId]
      );

      // New version directly active
      await db.query(`
        INSERT INTO claw_skills (skill_name, user_id, version, content, source, status, change_reason, source_session, analysis)
        VALUES ($1, $2, $3, $4, 'evolved', 'active', $5, $6, $7)
      `, [skillName, userId, currentVersion + 1, analysis.revised_content,
          analysis.reason, sessionId, JSON.stringify(analysis)]);

      logger.info({ skillName, newVersion: currentVersion + 1, reason: analysis.reason }, "skill.auto_evolved");
    }
  }
}
```

### 7.4 Version Lifecycle

```
Creation (auto/manual/save_skill)
    │
    ▼
v1 (active)
    │
    │ Statistics worsen (≥5 executions, failure rate >30%)
    │ LLM analysis → auto-generate improved version
    ▼
v2 (active), v1 (archived)
    │
    ├── Statistics improve within 5 runs → keep v2 ✓
    └── Statistics worse within 5 runs → auto-rollback: v1 restored to active, v2 (rolled_back)
```

**No manual approval throughout; statistical rollback ensures safety.**

### 7.5 Auto-Rollback Mechanism

After a new version goes live, if performance is worse than the old version within 5 executions, automatically roll back to the old version.

```typescript
async function maybeAutoRollback(skillName: string, userId: string): Promise<void> {
  // Only check rollback for self-evolved versions
  const current = (await db.query(
    "SELECT version, created_at FROM claw_skills WHERE skill_name = $1 AND user_id = $2 AND status = 'active' AND source = 'evolved'",
    [skillName, userId]
  )).rows[0];
  if (!current) return;

  // Stats since new version went live
  const newStats = await getSkillStatsSince(skillName, current.created_at);
  if (newStats.total < 5) return; // Insufficient samples

  // Historical stats of previous version (most recent archived)
  const prevVersion = current.version - 1;
  const prevStats = await getSkillStatsForVersion(skillName, userId, prevVersion);
  if (!prevStats || prevStats.total < 5) return;

  const newFailRate = (newStats.total - newStats.successes) / newStats.total;
  const oldFailRate = (prevStats.total - prevStats.successes) / prevStats.total;

  if (newFailRate > oldFailRate) {
    // New version is worse → rollback
    await db.query(
      "UPDATE claw_skills SET status = 'rolled_back' WHERE skill_name = $1 AND user_id = $2 AND version = $3",
      [skillName, userId, current.version]
    );
    await db.query(
      "UPDATE claw_skills SET status = 'active' WHERE skill_name = $1 AND user_id = $2 AND version = $3",
      [skillName, userId, prevVersion]
    );

    logger.info({
      skillName, rolledBackFrom: current.version, restoredTo: prevVersion,
      newFailRate: newFailRate.toFixed(2), oldFailRate: oldFailRate.toFixed(2),
    }, "skill.auto_rollback");
  }
}
```

### 7.6 Skill Usage (Resolution Priority)

```typescript
async function mergeSkills(
  marketplaceSkills: Record<string, string>,
  requestSkills: Record<string, { content: string; enabled: boolean }>,
  userId: string,
): Promise<Record<string, string>> {
  // 1. Load user's local active skills
  const localSkills = await getUserActiveSkills(userId);

  // 2. Merge: marketplace highest priority, local only supplements
  const merged: Record<string, string> = {};

  // Layer 3: Local Skill (lowest priority, added first)
  for (const [name, content] of Object.entries(localSkills)) {
    merged[name] = content;
  }

  // Layer 2: Request inline (overrides local same-name)
  for (const [name, spec] of Object.entries(requestSkills)) {
    if (spec.enabled) merged[name] = spec.content;
  }

  // Layer 1: SaFE Marketplace (highest priority, overrides everything same-name)
  for (const [name, content] of Object.entries(marketplaceSkills)) {
    if (merged[name] && merged[name] !== content) {
      logger.warn({ skillName: name }, "skill.local_overridden_by_marketplace");
    }
    merged[name] = content;
  }

  return merged;
}

async function getUserActiveSkills(userId: string): Promise<Record<string, string>> {
  const rows = (await db.query(`
    SELECT DISTINCT ON (skill_name) skill_name, content
    FROM claw_skills
    WHERE user_id = $1 AND status = 'active'
    ORDER BY skill_name, version DESC
  `, [userId])).rows;

  const skills: Record<string, string> = {};
  for (const row of rows) skills[row.skill_name] = row.content;
  return skills;
}
```

### 7.6 Skill API

| Method | Path | Description |
|------|------|------|
| GET | `/v1/users/:userId/skills` | All user Skills (including active/archived/rolled_back) |
| GET | `/v1/users/:userId/skills/:name` | Skill details (including version history + evolution reasons) |
| POST | `/v1/users/:userId/skills` | Manual Skill creation (directly active) |
| PUT | `/v1/users/:userId/skills/:name` | Manual edit (creates new active version, old version archived) |
| DELETE | `/v1/users/:userId/skills/:name` | Delete all versions |
| POST | `/v1/users/:userId/skills/:name/rollback` | Manual rollback to previous version |
| GET | `/v1/users/:userId/skills/:name/stats` | Execution statistics (aggregated from claw_session_events) |

---

## 8. Skill and SaFE Marketplace Relationship

### 8.1 Three-Layer Skill Sources and Priority

```
Priority from highest to lowest:

1. SaFE Marketplace (downloaded by resolveToolIds, platform-controlled, cannot be overridden)
   └── Platform-level Skills, guaranteed quality and safety, local cannot interfere

2. Request inline (ExecuteRequest.skills, passed per request)
   └── Explicitly specified by caller

3. Local claw_skills (user-level, auto-created/manual/self-evolved)
   └── User's personal accumulation, only supplements, never overrides
```

**Core principle: SaFE Marketplace Skills are the authoritative platform source; local Skills can only supplement, never override same-named marketplace Skills.**

### 8.2 Self-Evolution and Marketplace Relationship

Self-evolution **only acts on local Skills**, does not touch marketplace Skills:

```
Scenario A: Marketplace Skill performs poorly
  → Do not auto-rewrite marketplace version
  → Handle through platform-side feedback mechanism (file issue / contact Skill maintainer)

Scenario B: User's self-created local Skill performs poorly
  → Self-evolution generates improved version → directly active → auto-rollback as safety net
  → Normal flow

Scenario C: User wants to personalize a marketplace Skill
  → Create a differently-named local Skill as supplement (e.g., "nodejs-deploy-custom-notes")
  → Both injected into prompt simultaneously, no interference
```

### 8.3 Handling Marketplace Updates

| Scenario | Handling |
|------|------|
| Marketplace updates a Skill | Next resolveToolIds automatically pulls new version, no local action needed |
| User has same-named local Skill | **Not effective** — marketplace takes priority, local same-name ignored with warning logged |

---

## 9. Self-Learning Loop (Nudge Mechanism)

### 9.1 Comparison with Hermes Agent

| Dimension | Hermes Agent | Claw (This Design) |
|------|-------------|----------------------|
| Review entity | Background new AIAgent instance (full Agent loop) | Direct LLM API call (single call) |
| Storage | MEMORY.md / USER.md files | PostgreSQL (claw_memory_entries) |
| Trigger location | Brain (after main conversation ends, background thread) | event-consumer (API layer, async) |
| Memory capacity | 3575 characters (hardcoded) | 50 entries/user, 3K tokens injection budget |
| Active save | `memory` tool | `save_memory` + `save_skill` tools |
| Skill creation | Prompt guides Agent to call `skill_manage` | Background auto-distillation + `save_skill` tool |
| Skill evolution | Prompt guides Agent to patch during use | Statistics trigger + LLM analysis + auto-update + statistical rollback safety net |

### 9.2 handleComplete Complete Flow

```typescript
async function handleComplete(sessionId: string, event: Record<string, unknown>): Promise<void> {
  const userId = (event as any).user_id || "default";

  // ===== Core logic (synchronous, must not fail) =====
  await updateSessionStatus(sessionId, event);
  await saveConversationTurns(sessionId, event);
  await processSaveMemoryEvents(sessionId, userId, event);   // save_memory tool
  await processSaveSkillEvents(sessionId, userId, event);    // save_skill tool
  await dispatchPending(sessionId);                          // Must be in sync chain for timely dispatch

  // ===== Background tasks (async, failure allowed, doesn't block pending dispatch) =====
  setImmediate(() => {
    maybeSummarize(sessionId).catch(err =>                   // LLM summary may be slow, go async
      logger.error({ err, sessionId }, "summarize_failed"));
    maybeExtractMemory(sessionId, userId).catch(err =>
      logger.error({ err, sessionId }, "memory.extraction_failed"));
    maybeCreateSkill(sessionId, userId, event).catch(err =>
      logger.error({ err, sessionId }, "skill.creation_failed"));
    maybeEvolveSkill(sessionId, userId, event).catch(err =>
      logger.error({ err, sessionId }, "skill.evolution_failed"));
  });
}
```

---

## 10. Observability

```typescript
const metrics = {
  memoriesExtracted:      counter("claw_memories_extracted_total"),
  memoriesExplicit:       counter("claw_memories_explicit_total"),
  memoriesInjected:       gauge("claw_memories_injected_count"),
  memoriesBlocked:        counter("claw_memories_blocked_total"),
  extractionLatency:      histogram("claw_memory_extraction_duration_ms"),
  extractionErrors:       counter("claw_memory_extraction_errors_total"),
  skillsAutoCreated:      counter("claw_skills_auto_created_total"),
  skillsExplicitCreated:  counter("claw_skills_explicit_created_total"),
  skillEvolutionTriggered: counter("claw_skill_evolution_triggered_total"),
  skillAutoRollbacks:      counter("claw_skill_auto_rollbacks_total"),
};
```

---

## 11. Phased Implementation Plan

### Phase 0: Prerequisite Modifications (No Memory/Skill Business Logic)

> Paving the way for subsequent Phases, fixing existing issues + extending data channels.

| File | Change Type | Description |
|------|---------|------|
| `packages/protocol/src/types.ts` | Modify | `ExecuteResult` adds `pendingMemories` / `pendingSkills` / `skillsUsed` / `errorCount` |
| `packages/brain/src/agent/agent-loop.ts` | Modify | `LoopResult` synchronized extension; track `errorCount` |
| `packages/brain/src/tools/router.ts` | Modify | Add `pendingMemories` / `pendingSkills` instance arrays (routing not implemented yet, added in Phase 2) |
| `packages/brain/src/index.ts` | Modify | `exec_complete` event completes `user_id`, `skills_used`, `error_count`; **fix bug where failure branch missing `session_id`** |
| `packages/api/src/sessions/context-builder.ts` | Modify | `buildMessages` adds `userId` parameter (doesn't query memory yet, only adds parameter) |
| `packages/api/src/routes/sessions.ts` | Modify | `buildMessages` caller passes `userId` |
| `packages/api/src/events/consumer.ts` | Modify | `buildMessages` caller passes `userId`; `handleComplete` reads `user_id` from event |
| `packages/api/src/llm/client.ts` | **New** | API layer single LLM completion wrapper (used by memory/skill services) |

New environment variable: `MEMORY_LLM_MODEL` (defaults to reusing `ANTHROPIC_DEFAULT_SONNET_MODEL`)

### Phase 1: Long-Term Memory + Summary Upgrade

| File | Change Type | Description |
|------|---------|------|
| `packages/api/src/infra/db.ts` | Modify | initDb adds `claw_memory_entries` |
| `packages/api/src/memory/service.ts` | **New** | Memory extraction/injection/decay/capacity management/profile |
| `packages/api/src/sessions/context-builder.ts` | Modify | `buildMessages` injects memory + profile |
| `packages/api/src/events/consumer.ts` | Modify | `handleComplete` async calls `maybeExtractMemory` + `maybeSummarize` (LLM version) |
| `packages/api/src/routes/memory.ts` | **New** | User memory CRUD API |

### Phase 2: save_memory + save_skill Tools

| File | Change Type | Description |
|------|---------|------|
| `packages/brain/src/tools/router.ts` | Modify | Implement `save_memory` / `save_skill` routing + tool schema registration |
| `packages/brain/src/engines/claude.ts` | Modify | Read pending lists from router, pass into `ExecuteResult` |
| `packages/brain/src/index.ts` | Modify | `exec_complete` event carries `memories_to_save` / `skills_to_save` (read from result) |
| `packages/api/src/events/consumer.ts` | Modify | `handleComplete` processes both save events (with security scanning) |

### Phase 3: Skill Auto-Creation + Self-Evolution

| File | Change Type | Description |
|------|---------|------|
| `packages/api/src/infra/db.ts` | Modify | initDb adds `claw_skills` |
| `packages/api/src/marketplace/skill-service.ts` | **New** | Auto-creation/evolution/statistics/version management/auto-rollback |
| `packages/api/src/routes/skills.ts` | **New** | Skill CRUD + rollback API |
| `packages/api/src/routes/sessions.ts` | Modify | Read local active skills from DB before dispatch task and write to `task.skills` |
| `packages/api/src/events/consumer.ts` | Modify | `handleComplete` async calls `maybeCreateSkill` / `maybeEvolveSkill` (with rollback check) |

---

## 12. Review Records

| # | Issue | Fix |
|---|------|------|
| 1 | tsvector query-based retrieval cannot cover semantic scenarios | Changed to unconditional top-K memory injection |
| 2 | Agent cannot actively save memories | Added save_memory tool |
| 3 | No memory capacity limit | Hard limit 50 entries/user + LRU eviction |
| 4 | Skill rewrite triggered by single failure | Changed to statistical trend trigger (≥5 times, failure rate >30%) |
| 5 | Skill version scope undefined | All Skills isolated by user_id |
| 6 | LLM API Key source unclear | Added MEMORY_LLM_* environment variables |
| 7 | maybeSummarize is placeholder implementation | Phase 1 upgrade to LLM summary |
| 8 | Missing user data management API | Memory CRUD + Skill CRUD API |
| 9 | Missing observability | Prometheus metrics + structured logging |
| 10 | Memory extraction blocks main flow | setImmediate + catch, fire-and-forget |
| 11 | 4 tables over-designed | Simplified to 2 tables (profile merged into memory, execution stats reuse events) |
| 12 | Skill creation doesn't need approval but design required it | Creation directly active, evolution also auto-updates |
| 13 | Missing Skill auto-creation mechanism | Added maybeCreateSkill + save_skill tool |
| 14 | Conflict with SaFE marketplace | Clarified priority: marketplace > request > local, local only supplements |
| 15 | Evolution approval process increases user burden and draft backlog | Removed approval, auto-update + statistical rollback safety net (new version worse → auto-restore old version) |
| 16 | `exec_complete` event missing `user_id`/`skills_used`/`error_count`; failure branch even missing `session_id` | Need to extend event fields, Brain passes through `request.user_id`, adds `skills_used` (with version numbers), `error_count` |
| 17 | `LoopResult`/`ExecuteResult` only has 3 fields, cannot carry `pendingMemories`/`pendingSkills` | Extend type definitions, `ToolRouter` adds instance state to cache pending lists |
| 18 | `buildMessages` doesn't accept `userId` parameter | Add `userId` parameter, synchronize changes in `routes/sessions.ts` and `events/consumer.ts` callers |
| 19 | Sessions route doesn't pass `skills` field when submitting NATS task | Read local active skills from DB before dispatch and merge into task object |
| 20 | `agent/prompt.ts` doesn't actually inject Skill content, only lists paths for Agent to read via `cat` | Need to decide: change to direct injection, or maintain file-based but pre-write merged files to `.skills/` |
| 21 | Skill stats query depends on `exec_complete.skills_used` but field doesn't exist | Brain needs to track used Skills and write to completion event (with version numbers like `react-scaffold:v2`) |
| 22 | Self-evolution rollback cannot distinguish Skill version attribution | `skills_used` should include version numbers |
| 23 | No `callMemoryLLM` utility function, `agentLoop` too heavy, `fetchWithRetry` too low-level | Create `llm/client.ts` wrapping single completion, for API layer memory/skill service use |
| 24 | `maybeSummarize` upgraded to LLM call would block `handleComplete` sync chain | Changed to `setImmediate` async execution, doesn't block pending dispatch |
| 25 | `content_tsv GENERATED ALWAYS AS` requires PostgreSQL >= 12 | Need to confirm shared cluster version |
| 26 | Pending message re-dispatch loses `tool_ids`/`mcp_servers`/`skills` | Extend `claw_pending_messages` or recover from session config during re-dispatch |
| 27 | Brain `claude.ts` and API `sessions/context-builder.ts` each inject system messages, possibly resulting in multiple system messages | Unify system prompt construction location, or confirm Claude API behavior with multiple system messages |
| 28 | Section 4.1 still says exec_complete "already contains" skills_used | Changed to "contains after Phase 0 extension" |
| 29 | Section 4.3 `skills_used` uses array `["name:v1"]` format, JSONB `?` key-based query would fail | Changed to object format `{"name": version}`, `?` key query directly matches skill name |
| 30 | Section 7.3 skills_used parsing uses `split(":")` but format changed to object | Changed to `Object.keys(skillsUsed)` |
| 31 | Section numbering duplicate (two 7.5s) | Second one changed to 7.6 |
| 32 | Section 10 metrics reference deleted draft/approval names | Changed to `skillEvolutionTriggered` / `skillAutoRollbacks` |
| 33 | Phase 2 says modify `claude.ts` for exec_complete, but exec_complete is actually emitted in `index.ts` | Split into claude.ts (read pending → ExecuteResult) + index.ts (result → exec_complete event) |

---

## 13. v3.0 Implementation Status (Source of Truth)

> This section records the **actual behavior** after all Phase 0-3 are landed, including v3.0 second-round improvements (from SkillClaw lessons + testing feedback).
> When conflicts arise with Sections 1-12, **this section takes precedence**.

### 13.1 Data Model (Actual Schema)

#### `claw_memory_entries` (11 columns + 5 indexes)

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| user_id | TEXT NOT NULL | Multi-user isolation |
| category | TEXT NOT NULL | `preference` / `correction` / `env_fact` / `tool_quirk` / `pattern` / `user_profile` |
| content | TEXT NOT NULL | English (enforced) |
| content_tsv | tsvector GENERATED | Only for full-text search (management side), not used in conversation injection |
| importance | REAL DEFAULT 0.5 | 0.0-1.0, user_profile fixed at 1.0 |
| source_session | TEXT | Source session_id |
| source_type | TEXT DEFAULT 'auto' | `auto`(background extraction) / `explicit`(save_memory tool) / `manual`(API creation) |
| access_count | INT DEFAULT 0 | Times injected |
| created_at, last_accessed | TIMESTAMPTZ | |
| **deleted_at** | TIMESTAMPTZ NULL | **Soft delete**, all SELECTs add `deleted_at IS NULL` |

Indexes: `user_id` / `(user_id, importance DESC)` / GIN(content_tsv) / partial unique `(user_id) WHERE category='user_profile'`

#### `claw_skills` (19 columns + 4 indexes)

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| skill_name | TEXT NOT NULL | kebab-case |
| user_id | TEXT NOT NULL | |
| version | INT DEFAULT 1 | **Evolution increments (in-place UPDATE same row)**, no longer INSERT new row |
| content | TEXT NOT NULL | Skill body (Markdown) |
| **description** | TEXT DEFAULT '' | For YAML frontmatter, 2-4 sentence trigger conditions |
| source | TEXT DEFAULT 'auto' | `auto` / `manual` / `evolved` |
| status | TEXT DEFAULT 'active' | `active` / `archived` / `rolled_back` |
| change_reason | TEXT | |
| source_session | TEXT | |
| analysis | JSONB DEFAULT '{}' | `{ latest: {...}, history: [...] }` evolution history audit |
| created_at | TIMESTAMPTZ | |
| **deleted_at** | TIMESTAMPTZ NULL | Soft delete |
| **access_count** | INT DEFAULT 0 | Times loaded into prompt |
| **last_accessed** | TIMESTAMPTZ | |
| **positive_count** | INT DEFAULT 0 | +1 after task success |
| **negative_count** | INT DEFAULT 0 | +1 after task failure |
| **neutral_count** | INT DEFAULT 0 | +1 after mixed (high turns/errors but not failed) |
| **effectiveness** | REAL DEFAULT 0.5 | `positive_count / total`, used for eviction sorting |

Indexes: `(user_id, status)` / `(skill_name, user_id, version DESC)` / unique `(skill_name, user_id, version)`

### 13.2 Long-Term Memory — Actual Behavior

#### Dual-Channel Writing

**Path A: Agent active (`save_memory` tool)**
- LLM determines there are facts worth remembering in conversation → calls `save_memory({category, content, importance})`
- Brain caches to `pendingMemories` → `exec_complete` event carries `memories_to_save`
- API event-consumer security scan → `insertMemoryEntry` (source_type='explicit')
- Triggers `maybeUpdateUserProfile`

**Path B: Background auto-extraction (`maybeExtractMemory`)**
- Executed via setImmediate async after `exec_complete`
- Threshold: `turnCount >= 3`
- **Path A trigger skips Path B** (avoid duplication) — `if (!explicitMemorySaved) maybeExtractMemory(...)`
- Takes last 10 conversation turns + existing memories (dedup hint) → LLM extraction → write (source_type='auto')
- If at least one entry extracted → triggers `maybeUpdateUserProfile`

#### Capacity and Eviction
- **Hard limit: 50 entries/user** (including profile)
- **Over-limit eviction**: Find `importance ASC, last_accessed ASC` lowest entry → **soft delete** `deleted_at = NOW()` (user_profile cannot be evicted)

#### Decay (Daily Scheduled)
- First execution 1 minute after API startup, then every 24h
- **rate = 0.967/day** (v3.0 adjusted from 0.98 to ~3 month lifespan)
- 7-day grace period with no decay
- `importance < 0.05 AND access_count = 0 AND created_at > 30 days` → soft delete

#### User Profile
- `category='user_profile'` special entry, exactly **1 per user** (partial unique index)
- Triggered: after Path A or B writes new memory, auto-called
- LLM input: top-30 preference + correction → regenerated (not appended)
- Prompt limited to 1000 words (English), code hard limit 2000 chars
- `ON CONFLICT (user_id) WHERE category='user_profile' DO UPDATE`
- Injection: independent block `## User Profile`

#### Context Injection
`buildMessages` injects into system prompt in order:
1. `## User Profile` (if exists)
2. `## Long-term Memory` — top-30 by `importance DESC, last_accessed DESC`, budget 3K tokens
3. `## Session Summary` (if exists)
4. Rules + System Append

On injection, synchronously `access_count++`, `last_accessed = NOW()`.

### 13.3 Skill — Actual Behavior (v3.0 Major Rework)

#### Three Creation Methods

| Method | Trigger | Threshold | source |
|---|---|---|---|
| Auto distillation | `maybeCreateSkill` | turns≥8, error_count≤5, **tool_types≥4**, LLM `should_create=true` | `auto` |
| save_skill tool | LLM calls tool | None (requires description) | `manual` |
| Manual API | POST `/v1/users/:userId/skills` | None | `manual` |

#### Capacity and Eviction (v3.0 Improvement)
- **Hard limit: 20 entries/user**
- **Over-limit eviction strategy changed to value-based scoring**:
  - Scoring formula: `score = effectiveness × LN(1 + access_count)`
  - `ORDER BY score ASC, last_accessed ASC LIMIT 1` → soft delete
  - High effectiveness low usage / high usage low effectiveness / completely unused items naturally evicted
- **Updating existing skills is not subject to the limit**

#### Evolution Flow (v3.0 Complete Rewrite)

**Trigger `shouldEvolveSkill`** (filtered by current active version stats, avoids old version data causing infinite loops):
- `data->>'user_id' = userId AND (data->'skills_used'->>skill_name)::int = currentVersion`
- Single skill execution (`jsonb_object_keys count = 1`), past 7 days ≥5 times
- Any of: failure rate >30% / avg_turns >20 / avg_errors >3

**4 LLM decisions** (inspired by SkillClaw):

```
1. skip                    — Default, prompt guides "in doubt, skip"
2. optimize_description    — Only change description, don't touch content
3. improve_skill           — In-place UPDATE same row content + version+1
4. create_new_skill        — Don't touch current skill, INSERT new skill (with description)
```

**Verifier secondary review** (reject threshold 0.75):
- 4-dimension scoring: grounded_in_evidence / preserves_existing_value / specificity_and_reusability / safe_to_publish
- LLM decision is accept and score ≥ 0.75 to pass
- All actions go through verifier

**Key difference of in-place evolution**:
- Old design: INSERT new row per evolution (v2 active, v1 archived)
- v3.0: UPDATE same row (content + version + change_reason), analysis JSONB appends history
- Benefits: reduced version bloat, no database row explosion
- Side effect: removed `maybeAutoRollback` (no "previous version row" to restore), natural eviction via effectiveness

#### Effectiveness Feedback (v3.0 New)

`handleComplete` **only scores during single-skill execution** (avoids multi-skill misattribution):
```
failed = true                  → score = -1 → negative_count++
errorCount > 5 || turns > 25   → score =  0 → neutral_count++
clean success                  → score = +1 → positive_count++
effectiveness = positive_count / (positive + negative + neutral)
```

#### Skill Content Injection

API side (`routes/sessions.ts`):
- Load user active skills (including content + description + version)
- Write to `task.skills` field passed to Brain

Brain side (`claude.ts`):
- Three-layer merge priority: **marketplace > request/local** (local cannot override marketplace)
- **Local skills written to disk at `.skills/{name}/SKILL.md`** (single bash call batch write)
- File includes YAML frontmatter:
  ```yaml
  ---
  name: skill-name
  description: "2-4 sentences..."
  ---

  ## Goal
  ...
  ```
- Prompt hint tells Agent: use `bash cat .skills/{name}/SKILL.md` to read on demand
- `skillsUsed = { skill_name: version }` written to ExecuteResult

### 13.4 Security Scanning

`scanMemoryContent(content, maxLength)` shared function, 5 threat patterns:
- prompt_injection / role_hijack / deception / disregard / exfil
- Memory length limit 2000 chars, **Skill limit 5000 chars**

Applied to: all write paths (save_memory, save_skill, auto-extraction, auto-creation, evolution).

### 13.5 Async Task Orchestration (handleComplete)

```
[Synchronous chain] Must complete first
1. UPDATE session status (running → idle/failed)
2. INSERT conversation turns (user + assistant)
3. Process memories_to_save (with security scan) → maybeUpdateUserProfile
4. Process skills_to_save (with security scan) → saveSkill
5. Dispatch pending messages (avoid delaying user's subsequent messages)
6. Record skill effectiveness feedback (only for single-skill execution)

[Async chain] setImmediate, fire-and-forget, failures don't block
- maybeSummarize        (LLM summary, triggers only above 80K tokens)
- maybeExtractMemory    (LLM memory extraction, only when Path A not triggered)
- maybeCreateSkill      (LLM skill distillation)
- maybeEvolveSkill      (LLM evolution + verifier)
```

### 13.6 SKILL.md File Format (v3.0 New)

Following SkillClaw / OpenClaw standard:

```yaml
---
name: react-deploy
description: "Deploy React app to S3 + CloudFront. Use when: deploying static frontend. NOT for: server-side rendering."
---

## Goal
...

## Steps
1. ...

## Notes
- ...
```

Write timing: at each task start, Brain writes all local active skills to `.skills/` in **a single bash call** batch.

### 13.7 Tool Schema (save_memory / save_skill)

```typescript
save_memory: {
  category: enum["preference", "correction", "env_fact", "tool_quirk", "pattern"],
  content:  "One concise English sentence (max 2000 chars)",
  importance: 0.0-1.0 (default 0.7),
}

save_skill: {
  skill_name:  "kebab-case-name",
  description: "REQUIRED. 2-4 English sentences for triggering",
  content:     "Full skill body in English (max 5000 chars)",
}
```

LLM Prompts enforce English to avoid profile/memory/skill Chinese mixing causing retrieval/readability issues.

### 13.8 Core Differences from v2.x

| Dimension | v2.x | v3.0 |
|---|---|---|
| Skill evolution | INSERT new row each time (v1, v2, v3...) | **In-place UPDATE same row** + version counter |
| Skill evolution decision | Binary: needs_revision true/false | **4 options**: skip / optimize_description / improve_skill / create_new_skill |
| Skill evolution quality | Direct publish | **Verifier secondary review**, 4 dimensions ≥0.75 |
| Skill capacity over-limit | Reject | **Evict lowest effectiveness × log(usage)** |
| Skill auto-rollback | newFailRate > oldFailRate comparison | **Removed** (in-place has no rollback version, natural eviction via effectiveness) |
| Skill feedback | access_count only | **positive/negative/neutral three counters + effectiveness score** |
| Skill injection | Pure markdown | **YAML frontmatter + body**, following SkillClaw / OpenClaw standard |
| Deletion | Hard delete `DELETE FROM` | **All soft delete** `deleted_at = NOW()`, all queries add `deleted_at IS NULL` |
| Memory decay | 0.98/day, ~5 months | **0.967/day, ~3 months** |
| Memory + save_memory duplication | Both execute | **save_memory trigger skips maybeExtractMemory** |
| Multi-skill failure attribution | All skills marked as failure | **Only score during single-skill execution** |
| Skill creation threshold | turns≥5, tools≥3 | **turns≥8, tools≥4** (avoid bloat) |
| Content length limit | Shared 2000 chars | **Memory 2000 / Skill 5000** separate |
| Language | Mixed Chinese/English | **Enforced English** (Prompt + tool description) |

### 13.9 v3.0 Fixed Bugs

| # | Bug | Fix |
|---|---|---|
| 1 | save_skill on already-evolved skill INSERTs v1 which gets shadowed by v2+ | Changed to: if exists, UPDATE active row; if not, INSERT |
| 2 | shouldEvolveSkill doesn't filter by version, old version failures cause infinite loop | Added user_id + currentVersion filter |
| 3 | create_new_skill evolution loses description | Added skill_description to EvolveDecision and prompt |
| 4 | `\` not escaped in YAML frontmatter | Escape order: `\\` → `\"` → `\n` |
| 5 | recordSkillFeedback SQL string concatenation (functionally correct but SQL injection risk) | Column name whitelist + parameterized $3 |

### 13.10 Intentionally Not Implemented (Explicit Decisions)

- **Phase 10 metrics (Prometheus counters)**: Covered by existing structured logging, not introducing prom-client dependency
- **Skill embedding retrieval**: 20-entry limit is sufficient, no semantic matching needed
- **Skill multi-user sharing / Hub**: Maintain per-user isolation
- **Skill auto-rollback**: Replaced by natural eviction via effectiveness

### 13.11 TODO (Identified But Not Yet Done)

> v3.1 landed: T1 local skill multi-file, T6 evidence-based evolution, T7 task pattern aggregation, T8 probation mechanism.
> See Section 13.12.

| # | Item | Impact | Estimate | Priority |
|---|---|---|---|---|
> v3.3 review concluded won't-do (unless future requirements drive): T2/T3/T4/T5/T9/T10 all not doing.
> Rationale: This system focuses on "long-term memory + user profile + Skill self-evolution" three things; T2 is performance optimization (current performance sufficient), T3/T4 are independent UI engineering, T5 is SaFE quota management (not in scope), T9 depends on whether Pi/Codex upgrades to tool-using agent, T10 is unnecessary after Q4 LLM tags land.

These are all "could do but not doing now" — either product form is undecided, or current mechanisms are sufficient.

### 13.12 v3.1 Enhancements: Evidence-Based Evolution + Multi-File + Pattern Aggregation + Probation (E1-E4)

After v3.0 launch we identified 4 core pain points, v3.1 addresses them all:

| # | Pain Point | v3.1 Approach |
|---|---|---|
| **E1** | Evolution prompt only shows LLM statistics, no real cases | Feed LLM 2 good cases + 2 bad cases with complete trajectory (prompt + tool sequence + final result) each, so model reasons from evidence not metrics |
| **E2** | save_skill only supports single file SKILL.md; marketplace skills already support multi-file but no path for LLM to add its own | Add `claw_skill_files` table + 3 tools (`add/update/remove_skill_file`) + 4 REST endpoints; Brain-side base64 disk write to sandbox; evolution prompt adds 2 new actions (`improve_file` / `add_file` / `delete_file`) |
| **E3** | "Generate skill after one successful complex task" mistakes one-off tasks for patterns | Introduce `claw_skill_patterns` table, aggregate by (sorted tool set + first 8 words of intent); same pattern appearing ≥3 times feeds all trajectories to LLM for skill distillation |
| **E4** | Auto-generated skills go directly to active pool, quality varies | Auto skills default to `status='probation'`, after 5 feedback events use effectiveness threshold (≥0.5) to determine graduation / soft delete; probation skills injected into prompt but not eligible for evolution |

#### E1: Evidence-Based Evolution (Real Cases, Not Stats Only)

`maybeEvolveSkill` → `getEvolveEvidence(skill, user, version)`:

- Good case: sole-skill execution, `failed=false`, `error_count<=1`, sorted by turns ascending take 2
- Bad case: sole-skill execution, `failed=true` or `error_count>=3` or `turns>=20`, sorted by severity take 2
- Each case rendered as: `"User asked / Tool sequence / Outcome"` three sections
- All fed into `EVOLVE_SKILL_PROMPT`, LLM sees both statistics + evidence

#### E2: Multi-File Skill

| Layer | Changes |
|---|---|
| **DB** | New table `claw_skill_files(skill_id, user_id, file_path, content, is_binary, size_bytes)`, no foreign keys (user_id prevents cross-user leaks); scheduled orphan row cleanup |
| **Service** | `addSkillFile` / `updateSkillFile` / `removeSkillFile` / `getSkillFile` / `getSkillFiles` / `cleanupOrphanSkillFiles`; path whitelist `references/, templates/, scripts/, assets/`; single file ≤10 KB, total per skill ≤50 KB, sub-files ≤20 |
| **API** | `POST/PUT/DELETE/GET /v1/users/:userId/skills/:name/files` + `GET .../files/*` |
| **Protocol** | `ExecuteRequest.skills[name].files` + `PendingSkillFileMutation` |
| **Brain Tool** | `add_skill_file` / `update_skill_file` / `remove_skill_file` tools, scanContent sync validation; write failure immediately returns error to Agent |
| **Brain Engine (Claude)** | `localSkillEntries` disk write changed to base64 batch; writes both SKILL.md + all sub-files |
| **EventConsumer** | Process `skill_file_mutations`, dispatch to add/update/remove respectively |
| **Evolve Prompt** | New actions: `improve_file` / `add_file` / `delete_file` (paths also whitelisted), verifier still runs |
| **Rollback** | `analysis.history` adds `file_path` field; `manualRollback` stack-based undo (improve_file → restore file, add_file → delete file, delete_file → add back file) |

> **Limitation**: Currently only Claude engine materializes sub-files to sandbox. Pi/Codex directly concatenate SKILL.md into prompt, sub-files are ignored (see T9). **Update**: Pi/Codex engines have since been removed (unused in production, zero test coverage); Brain is Claude-only, so this limitation no longer applies.

#### E3: Task Pattern Aggregation

Old path `maybeCreateSkill` called LLM after every successful complex task (turns≥8, tools≥4, errors≤5) to decide whether to build a skill — easy to mistake one-off tasks for patterns.

New path `maybeRecordTaskPattern → promotePatternToSkill`:

```
exec_complete (success + complex)
  ↓ computePatternSignature(toolEvents, prompt)
  ↓   pattern_hash = FNV1a( sorted(unique(tools)) + intent_first_8_words )
  ↓   signature   = "intent='deploy a python web service' tools=[bash,read,write,grep,glob]"
  ↓
UPSERT claw_skill_patterns(user, hash) — bump occurrences, append session_id
  ↓
  if occurrences == 3 and not promoted:
    setImmediate(promotePatternToSkill)
       ↓ Pull first 3 example_session_ids' complete trajectories
       ↓ LLM sees 3 trajectories → "what skill to distill?"
       ↓ saveSkill(source='auto-pattern') → enters probation
       ↓ UPDATE claw_skill_patterns SET promoted_to_skill_id = ?
```

Old `maybeCreateSkill` retained (no longer called) for manual testing.

#### E4: Probation Period Mechanism

```
saveSkill(source='auto' or 'auto-pattern') → status='probation'
saveSkill(source='manual')                 → status='active'  (user-endorsed, exempt from probation)

probation skill:
  - Injected into prompt (for user testing)
  - recordSkillFeedback counts positive/negative/neutral
  - maybeEvolveSkill skips (insufficient samples, evolution would oscillate)

checkProbationGraduation (synchronous after each feedback):
  total = positive + negative + neutral
  if total >= 5:
    if effectiveness >= 0.5: status='active'        (graduated)
    else:                    deleted_at = NOW()    (evicted, soft delete)
```

#### Implementation Statistics

| Dimension | Value |
|---|---|
| Files changed | 14 files |
| Lines added | ~1500 lines |
| Lines deleted | ~150 lines |
| New tables | 2 (`claw_skill_files`, `claw_skill_patterns`) |
| New API endpoints | 5 (4 sub-file + reuse sessions/skills) |
| New Brain tools | 3 (add/update/remove_skill_file) |
| Evolution actions | 4 → 7 (add improve_file / add_file / delete_file) |
| Unit tests | All green (24 cases) |
| E2E tests | New `e2e-e1-e4.ts`, 27/27 passed |
| Regression E2E | `e2e-memory-decay.ts` all green |

### 13.13 v3.2 Improvements: Batch Evolution + LLM Intent Tags (Q2/Q3/Q4)

After v3.1 launch, 3 more design granularity issues were found, v3.2 resolves them all:

| # | Pain Point | v3.2 Approach |
|---|---|---|
| **Q2** | Top 2 evidence too few, can't see patterns | good=3 / bad=4 (env vars `EVOLVE_EVIDENCE_GOOD_COUNT` / `EVOLVE_EVIDENCE_BAD_COUNT` configurable), more bad cases because bad cases drive changes |
| **Q3** | LLM single-action decision too narrow; real bad cases often need "fix SKILL.md + add script + delete old ref" combo fix | `EvolveDecision` changed to `{ reason, mutations: Mutation[] }`; LLM plans complete batch at once; validate + verify each mutation, all pass then BEGIN/COMMIT atomic transaction; `manualRollback` adds `batch` action handling (reverse traverse each mutation) |
| **Q4** | "First 8 words" hash has >50% false negatives across languages/synonyms | LLM extracts 5 fixed fields (`action / target / platform / technology / domain`) → normalized snake_case → joined into hash; LLM failure degrades to original "first 5 words" hash, doesn't block main flow |

#### Q4 Test Results

```
EN: "deploy a python web service to kubernetes"
ZH: "deploy this python web service to k8s"

→ Both extracted: { action=deploy, target=web_service, platform=k8s, technology=python, domain=backend }
→ Same pattern_hash → same bucket → same occurrences counter
```

Old algorithm ("deploy a python web service" vs "deploy this python...") would be misclassified into 2 buckets, never reaching threshold 3.

#### Q3 Batch Evolution Flow

```
LLM returns { reason, mutations: [m1, m2, m3] }
  ↓ Cross-mutation sanity (same file_path can't have two / create_new_skill must be exclusive)
  ↓ Cumulative capacity pre-check (add - delete + improve_delta + main_size ≤ 50KB)
  ↓
validate + verify each mutation:
  - path validation (sub-file whitelist)
  - scanMemoryContent security scan
  - LLM verifier (4 dimensions score ≥ 0.75)
  - any reject → entire batch abandoned (logger.warn)
  ↓
db.pool.connect()
BEGIN
  loop mutations:
    optimize_description → UPDATE claw_skills SET description
    improve_skill        → UPDATE claw_skills SET content, source='evolved' (accumulate bumpVersion=true)
    improve_file         → UPDATE claw_skill_files SET content
    add_file             → INSERT claw_skill_files
    delete_file          → DELETE claw_skill_files
  UPDATE claw_skills SET analysis = analysis || {batch entry with all mutations + previous_content}
  if bumpVersion: UPDATE claw_skills SET version = version + 1
  UPDATE claw_skills SET change_reason = combined
COMMIT  ← any step throws → ROLLBACK
client.release()
```

`create_new_skill` is still single-mutation exclusive (spawns sibling skill, not a modification of parent skill), separately takes `INSERT INTO claw_skills` path, not in parent transaction.

#### Rollback Upgrade

`analysis.history` entry for a `batch` contains all `previous_content` for the entire batch. `manualRollback` detects `batch` action and reverse traverses the `mutations` array, undoing each in a new transaction (`add_file → DELETE`, `delete_file → INSERT`, `improve_file → UPDATE back to previous_content`, `improve_skill → UPDATE content + version-1`), the entire undo is also transactional, partial rollback won't leave inconsistent state.

#### Implementation Statistics

| Dimension | Value |
|---|---|
| Files changed | 3 (config.ts / marketplace/skill-service.ts / e2e-e1-e4.ts) |
| Net lines added | ~600 lines |
| Lines deleted | ~210 lines (old 7-choice single-action path completely removed) |
| New env vars | 2 (`EVOLVE_EVIDENCE_GOOD_COUNT`, `EVOLVE_EVIDENCE_BAD_COUNT`) |
| New exported functions | 1 (`extractIntentTags`) |
| Unit tests | 24/24 all green |
| E2E tests | `e2e-e1-e4.ts` expanded to 35/35 passed (+8 cases: 4 batch/rollback + 2 intent tags + 2 fallback) |

#### Compatibility with v3.1

- Old `analysis.history` entries with `improve_skill / improve_file / add_file / delete_file` single actions, `manualRollback` still recognizes (old branch code retained, `batch` branch added)
- Evolution prompt completely replaced: live LLM won't receive both old and new prompt sets simultaneously (one-time switch)
- No DB schema changes, pure code upgrade

### 13.14 v3.3 Full Code Review: 5 Consistency / Vulnerability Fixes

Second full code review found 8 issues (B1-B8), of which B2 verified not a bug, B5/B7/B8 assessed as optimization or non-urgent items not doing, **B1/B3/B4/B6 + associated cleanup resolved at once**.

| # | Severity | Issue | Fix |
|---|---|---|---|
| **B1** | ★★★ | `saveSkill` Case 1 only queries `status='active'`, hits probation skill → Case 2/3 don't match → `INSERT ... ON CONFLICT DO NOTHING` silently drops content (user's save_skill tool/API call directly lost) | Case 1 changed to `status IN ('active','probation')` both go to in-place update; when probation meets `source='manual'` (user manual) → auto-graduate to active; auto-pattern second promote hitting probation → keep probation |
| **B2** | — | `formatToolSequence` filter depends on event's `status` field | Verified: Brain-side `agent/agent-loop.ts:123/137`, `claude.ts:117`, `codex.ts:161/175` 100% emit `status`; filter correct, **not a bug**, reverted |
| **B3** | ★★ | `PUT /skills/:name` route still uses old archive+insert flow (archived rows invisible to `evictLeastUsedSkill`, storage leak), conflicts with v3.0+ in-place model | Changed to use `saveSkill("manual")`, same path as save_skill tool, automatically reuses B1's "manual hitting probation auto-graduates" logic |
| **B4** | ★★ | `promotePatternToSkill` two concurrent `setImmediate` both see `promoted_to_skill_id IS NULL` → both run LLM → both INSERT skill, wasting LLM calls + possible result overwrite | Claim phase first `UPDATE ... SET promoted_to_skill_id = -1 WHERE id=? AND promoted_to_skill_id IS NULL RETURNING ...`, rowCount=0 caller returns immediately; all LLM failure/skip paths have matching `releaseClaim()` restoring `-1` to `NULL` |
| **B5** | — | LLM intent extraction also called for already-promoted patterns (~100ms) | Assessed: cost acceptable (pattern hit rate not high, daily call count limited), **not doing** |
| **B6** | ★★ | `claw_skill_patterns` table has no cleanup mechanism, promoted patterns + 1-time cold patterns permanently occupy rows | Added `cleanupOldPatterns()`: ① delete `promoted_to_skill_id > 0 AND last_seen > 30 days` ② delete `occurrences=1 AND last_seen > 14 days` ③ release `promoted_to_skill_id = -1 AND last_seen > 1 hour` stuck claims (fallback for B4 race + crash scenarios); integrated into existing daily cron |
| **B7** | — | Frontend doesn't distinguish active vs probation badge | Related to T3 frontend work, **not doing** |
| **B8** | — | `getSessionToolEvents` uses `OFFSET 1` to get previous exec_complete boundary, logic fragile | Assessed: no actual incidents, **not doing** (left as TODO) |

#### Implementation Statistics

| Dimension | Value |
|---|---|
| Files changed | 4 (skill-service / index / routes/skills / e2e) |
| Net lines added | ~150 |
| New exported functions | 1 (`cleanupOldPatterns`) |
| Unit tests | 24/24 all green |
| E2E tests | `e2e-e1-e4.ts` expanded to 47/47 passed (v3.2's 35 + v3.3 new 12: B1×3 / B4×2 / B6×7) |

#### Long-Term Won't-Do Items (Assessed and Explicitly Decided)

T2 / T3 / T4 / T5 / T9 / T10 all won't-do (13.11 table updated with reasons). This system's responsibility boundary is limited to **long-term memory + user profile + Skill self-evolution** three things.

### 13.15 v3.4 Refinement / Idempotency / Defensiveness (After Second Full Code Review)

Second round code review found 5 non-bug but worth addressing details (N1-N5). N2 is a design trade-off, confirmed with you to **keep current behavior** (protect untested skills), other 4 items all got code fixes.

| # | Type | Issue | Resolution |
|---|---|---|---|
| **N1** | Naming consistency | `getActiveSkillVersions` only queries `status='active'`, but `getUserActiveSkills` includes probation → callers rely on `\|\| 1` fallback for probation skill version number (actually correct but by coincidence) | SQL changed to `status IN ('active', 'probation')`, eliminating implicit assumption |
| **N2** | Design trade-off | `evictLeastUsedSkill` only selects eviction targets from `active`, probation skills (effectiveness=0.5, inject=0, score=0) are protected instead | **Keep current behavior**: give untested skills an observation period, don't kill them before they get a chance. Design intent explicitly documented |
| **N3** | Idempotency | `manualRollback` second call would again find the same batch history entry, executing duplicate undo (mostly no-ops but logs still say `"success"`) | Success path appends `rollback_marker` to history; search uses **pair counting method** to skip consumed ROLLBACKABLE entries. For batch branch, marker append written in same transaction for atomicity |
| **N4** | Defensiveness | `promotePatternToSkill` if LLM suggests a `skill_name` that collides with user's existing same-name skill, `saveSkill` Case 1 would in-place overwrite — potential data loss | Explicitly query same-name active/probation skill before calling `saveSkill`; if exists, `releaseClaim()` + abandon, log `skill.pattern_promote_name_collision` |
| **N5** | Cost optimization | `cleanupOldPatterns` deletes promoted patterns with 30-day threshold too aggressive — after 30 days if user does similar task again, pattern table is cleared, will recount to 3 → call LLM for distillation again (LLM sees `existing_skills` to know it exists, wastes one call) | Threshold 30 days → **90 days**; retain longer "dedup memory" |

#### N3 Idempotency Algorithm Description

```
history = [A1, A2, batch, A3, batch, rollback_marker]  # Second call scenario
                                        ↑ newest

Reverse traverse, skipCount initially 0:
  see rollback_marker → skipCount = 1, continue
  see batch (ROLLBACKABLE) → skipCount > 0, skipCount = 0, continue
  see A3 (ROLLBACKABLE) → skipCount = 0 → last = A3, break

→ last = A3 (i.e., second rollback will undo A3, not second undo of batch)
```

This guarantees:
- Rollback immediately followed by another rollback → finds next earlier ROLLBACKABLE (doesn't duplicate-undo same one)
- N consecutive rollbacks → undoes at most N different entries in history
- No remaining rollbackable entries → `return false` + log `skill.manual_rollback_nothing_to_undo`

#### N2 Rationale for Keeping "Protect Probation" Design

| Approach | Pros | Cons |
|---|---|---|
| **Current: evict only from active** | Probation skills get full 5-execution observation period, won't be killed before getting a chance to prove themselves | When user hits 20-skill limit, a new skill entering forces eviction of one "worst active", even if that active is more valuable than probation |
| Alternative: probation evicted first | More aggressively cleans untested items, active 100% preserved | New pattern-distilled skills may be evicted by next pattern, never reaching 5 feedback events |

**Chose current approach**: Because users rarely reach the 20-skill limit, and not giving probation skills an observation period would severely damage auto-distillation signal quality. If user skill counts explode in the future, consider switching.

#### Implementation Statistics

| Dimension | Value |
|---|---|
| Files changed | 3 (skill-service / design doc / e2e) |
| Net lines added | ~100 |
| New history entry type | `rollback_marker` |
| Unit tests | 24/24 all green |
| E2E tests | `e2e-e1-e4.ts` expanded to 57/57 passed (v3.3's 47 + v3.4 new 10: N1×1 / N3×5 / N4×2 / N5×2) |

### 13.16 v3.5 Independent Codex Review: 6 Bug Fixes

I did 5 rounds of self-review without finding these issues; having an independent codex agent run a review uncovered 7, of which 6 are real bugs + 1 is a known won't-do (T9 related). This taught an important lesson: **self-review tends to follow known bug patterns; independent perspective enables adversarial attacks**.

| # | Severity | Issue | Fix |
|---|---|---|---|
| **#1** | ★★★ | event-consumer idempotency gap: first INSERT event then handleComplete; if latter throws and naks, retry's ON CONFLICT DO NOTHING → `isNewEvent=false` → handleComplete permanently skipped → loses explicit save_memory/skill + skill feedback + pattern count + evolution | Added `claw_session_events.processed_at` column; INSERT only for audit write, processing state determined by processed_at; handleComplete success → UPDATE processed_at = NOW(); failure keeps processed_at NULL, nak retry re-runs |
| **#2** | ★★ | `trackSkillRead` records before `hands.callTool`; bash cat failure still counted in skillsRead → pollutes feedback / probation / evolution stats; especially Pi/Codex don't write to disk so all skill cat calls fail but still "used" | tool-router moved trackSkillRead after hands.callTool success; Pi/Codex added engine-level warn `skill.subfiles_ignored_by_engine` prompting user sub-files dropped |
| **#3** | ★★★ | `routes/memory.ts` POST/PUT/DELETE don't call `maybeUpdateUserProfile` → user manually editing memory leaves profile stale; DELETE of entire batch soft-deletes profile itself, never auto-rebuilt | Added `scheduleProfileRefresh()` helper (setImmediate background run), all 3 mutation handlers call at end |
| **#4** | ★★★ | `manualRollback` first line `if (current.version <= 1) return false` → if v1 skill only had file/description evolution (no version bump), rollback forever blocked, even if history has complete batch entry waiting to undo | Removed version<=1 guard; let subsequent history check decide rollback eligibility; legacy path's v-1 query moved inside `if (current.version > 1)`; improve_skill's version-1 operation added `GREATEST(1, ...)` fallback |
| **#5** | ★★ | Decay dead code: `GREATEST(0.05, ...)` floor 0.05; cleanup `WHERE importance < 0.05` (strict less than) → always false, 3-month lifespan promise broken | Floor changed to `GREATEST(0, ...)`; importance can actually decay to 0, cleanup can now trigger |
| **#6** | ★ (narrow) | Engine crash (not agent task failure) → exec_complete doesn't carry pendingMemories/Skills/FileMutations → that session's save_memory calls all lost | **Not fixing this round**: extremely narrow scenario (only engine uncaught throw), and engine crash makes entire session unusable, losing pending is secondary |
| **#7** | ★★ | `getSkillStats` has no version filter, `maybeEvolveSkill` feeds cross-version stats to LLM → v1's old failures pollute v2's evolution decisions | getSkillStats added optional `version` parameter; `maybeEvolveSkill` passes current version on call; consistent with `getEvolveEvidence` |

#### Review Limitations to Acknowledge

- **Document divergence**: codex pointed out `docs/architecture-design.md` (then named `docs/v2-architecture-design.md`) still says "long-term memory pending implementation / pgvector" — this is genuinely outdated, this system design document (this document) is the source of truth. If that architecture document is still maintained, should add a stub pointing to this document.
- **e2e tests not in git**: `packages/*/test/` is in `.gitignore`, intentionally (test files kept locally). Codex didn't read .gitignore so thought tests were missing. Not a bug.

#### Implementation Statistics

| Dimension | Value |
|---|---|
| Files changed | 5 (db.ts / event-consumer / memory-service / routes/memory / skill-service / brain×3) |
| Net lines added | ~150 |
| New DB column | `claw_session_events.processed_at` |
| Unit tests | 24/24 all green |
| E2E tests | `e2e-e1-e4.ts` expanded to 70/70 passed (v3.4's 57 + v3.5 new 13: #1×2 / #2×2 / #3×2 / #4×2 / #5×3 / #7×3 / associated correction −1) |

#### Lesson: Independent Review Catches Structural Bugs

I reviewed 5 rounds myself and didn't find #1 (the most severe bug). Reason: I only looked for problems in code I'd written, didn't think about "are event persistence and processing separated" — a structural question. An independent reviewer found 6 real bugs in ~1 hour, 3 of which are data-loss level (#1/#3/#4).

---

> Version: v2.0
> v2.0 changes: 4 tables → 2 tables; added Skill creation mechanism; creation exempt from approval/evolution needs approval; clarified marketplace priority
> v2.1 changes: SaFE marketplace Skill as highest priority, local Skill only supplements never overrides
> v2.2 changes: Removed approval process, Skill evolution auto-updates + auto-rollback; status simplified to active/archived/rolled_back
> v2.3 changes: Code review corrections (#16-#27):
>   - Architecture diagram fix: Skill merge point moved from context-builder to routes/sessions.ts dispatch
>   - Clarified Skill injection is file-based (.skills/ directory), not direct prompt injection
>   - exec_complete fields marked as "needs extension" instead of "existing"
>   - skills_used includes version numbers (e.g., "react-scaffold:v2") for rollback attribution
>   - maybeSummarize moved to async block, doesn't block pending dispatch
>   - Removed leftover "approval" references (Scenario B + comparison table)
>   - Added Phase 0 (prerequisite modifications)
> v2.3.1 changes: Second review corrections (#28-#33):
>   - skills_used format changed from array `["name:v1"]` to object `{"name": version}`, fixing JSONB query
>   - Added `getSkillStatsForVersion` for version attribution
>   - Fixed Phase 2 exec_complete modification location (index.ts not claude.ts)
>   - Fixed metrics names, section numbering, redundant comments
> v3.0 changes (2026-04-16, implementation complete + second-round improvements):
>   - **All Phase 0-3 landed**, merged to main
>   - Added Section 13 "Implementation Status"; conflicts with Sections 1-12 resolved in favor of Section 13
>   - **Skill evolution changed to in-place UPDATE** (no new version rows each time, reduced version bloat)
>   - **Skill evolution 4-choice decision** (skip / optimize_description / improve_skill / create_new_skill)
>   - **Verifier secondary review** (4 dimensions score ≥0.75 to pass)
>   - **Effectiveness feedback** (positive/negative/neutral three counters) + smart eviction (`effectiveness × log(usage)`)
>   - **YAML frontmatter** disk write (following SkillClaw / OpenClaw standard)
>   - Fixed 5 bugs (saveSkill shadowing / evolution infinite loop / description lost / YAML escaping / SQL safety)
>   - All hard deletes changed to soft delete (deleted_at), memory decay changed to ~3 month lifespan
>   - Enforced English (avoid profile/memory/skill Chinese mixing)
>   - Explicitly not implementing: Prometheus metrics / embedding retrieval / multi-user sharing / auto-rollback
>   - TODO (see 13.11): local skill multi-file, Skill architecture refactor, frontend notification/edit panel, admin panel, Session idle TTL
> v3.0.1 changes (based on external review + multiple internal reviews): Fixed 9 bugs (skills_used attribution / getSkillStats cross-user privacy / user_profile soft-delete resurrection / same-name skill rebuild failure / marketplace skill production fs bug / multi-file marketplace support / handleComplete idempotency / memory injection top-K truncation / profile security scan / pi-codex priority unification)
> v3.1 changes (2026-04-20, 4 enhancements landed together, see 13.12):
>   - **E1: Evidence-based evolution** — maybeEvolveSkill expanded stats to stats + good cases + bad cases complete trajectories fed to LLM
>   - **E2: Multi-file skill** — added claw_skill_files table + 3 new tools (add/update/remove_skill_file) + 4 REST endpoints + evolution prompt adds 3 new actions (improve_file / add_file / delete_file); rollback upgraded to stack-based undo; Claude engine disk write base64 includes sub-files
>   - **E3: Task pattern aggregation** — maybeRecordTaskPattern replaces maybeCreateSkill; aggregates by (sorted tool set + first 8 words of intent); occurrences ≥3 triggers LLM distillation, feeds 3 trajectories (no longer single-case decision)
>   - **E4: Probation period** — auto-created skills default to probation; 5 feedback events → effectiveness ≥ 0.5 graduates / soft-deletes; probation skills injected into prompt but skip evolution (avoid insufficient-data oscillation)
>   - New e2e-e1-e4 tests 27/27 passed; retained old maybeCreateSkill uncalled (backward-compatible manual testing)
> v3.2 changes (2026-04-20, second round review 4 issues fixed, see 13.13):
>   - **Q2: Evidence count raised to good=3 / bad=4**, added `EVOLVE_EVIDENCE_GOOD_COUNT` / `EVOLVE_EVIDENCE_BAD_COUNT` env vars
>   - **Q3: Evolution changed to batch** — LLM returns mutations[] at once; validate all pass → BEGIN/COMMIT atomic transaction; any reject abandons entire batch; manualRollback adds batch branch reverse-traverse undo
>   - **Q4: Pattern hash changed to LLM-extracted 5-field intent tags** (action/target/platform/technology/domain), cross-language/synonym hits same bucket; LLM failure degrades to "first 5 words" hash
>   - e2e-e1-e4 expanded to 35/35 (+8 cases); EN/ZH tests demonstrate both languages extract identical tags
> v3.3 changes (2026-04-20, full code review 5 consistency / vulnerability fixes, see 13.14):
>   - **B1: saveSkill hitting probation silently drops content** — Case 1 changed to `status IN ('active','probation')`; manual hitting probation auto-graduates; auto hitting probation keeps status
>   - **B3: PUT /skills/:name old archive+insert flow leaks storage** — changed to unified saveSkill path
>   - **B4: promotePatternToSkill race** — claim phase atomic UPDATE occupies sentinel = -1; all early-return paths have matching releaseClaim
>   - **B6: claw_skill_patterns permanent growth** — added cleanupOldPatterns daily cron (delete promoted+30 days / cold pattern+14 days / release stuck claim+1 hour)
>   - **B2/B5/B7/B8 assessed not doing**: B2 not a bug, B5/B7/B8 optimization or non-urgent
>   - **T2/T3/T4/T5/T9/T10 won't-do**: system responsibility limited to long-term memory + user profile + Skill self-evolution
>   - e2e-e1-e4 expanded to 47/47 (+12 cases: B1×3 / B4×2 / B6×7)
> v3.4 changes (2026-04-20, second full code review refinement, see 13.15):
>   - **N1: getActiveSkillVersions SQL adds probation**, eliminates "coincidentally correct via `|| 1` fallback"
>   - **N2: evict only from active, preserve untested skill observation period** (design trade-off, not a fix; explicitly documented)
>   - **N3: manualRollback idempotent** — append rollback_marker + pair counting method skips consumed entries
>   - **N4: promotePatternToSkill name collision check** — LLM-suggested name colliding with same-name skill → releaseClaim + skip
>   - **N5: cleanup promoted pattern threshold 30→90 days**, avoid re-distillation after 30 days wasting LLM
>   - e2e-e1-e4 expanded to 57/57 (+10 cases: N1×1 / N3×5 / N4×2 / N5×2)
> v3.5 changes (2026-04-20, independent codex review revealed 6 real bugs, see 13.16):
>   - **#1: event-consumer idempotency gap** — added `processed_at` column, handleComplete failure nak retry no longer permanently skipped
>   - **#2: trackSkillRead before callTool** — pollutes feedback; moved to after callTool success; Pi/Codex added subfile notice warn
>   - **#3: manual memory doesn't refresh profile** — routes/memory 3 mutation handlers add scheduleProfileRefresh
>   - **#4: manualRollback version<=1 guard blocks non-improve_skill evolution** — removed guard, let history check decide
>   - **#5: decay dead code** — floor 0.05→0; importance can actually decay through cleanup threshold
>   - **#7: getSkillStats cross-version pollutes evolution** — added optional version parameter; maybeEvolveSkill passes current version
>   - **#6 not fixing** (engine crash loses pending, extremely narrow scenario)
>   - e2e-e1-e4 expanded to 70/70 (+13 cases)
