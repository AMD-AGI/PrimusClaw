# Built-in Tools Design (V2 Brain)

> Closing the V1 → V2 built-in tool gap: web search/fetch, task planning, background shell, notebook reading, plan mode, end-user HITL approval, and agent-initiated user questions.
>
> Design reference: the publicly documented behavior and tool schemas of Anthropic Claude Code's built-in tools. No Claude Code source code was consulted or ported — the implementation described here is original to PrimusClaw.
>
> **Summary**: This document designs the 9 built-in tools (including ask_user_question) and the HITL approval channel that the V2 Brain lacks relative to V1. Following the design of Claude Code's public tool surface, it specifies tool schemas, routing rules, Hands-side changes, and a phased rollout plan.
>
> **Update**: `engines/codex.ts` and `engines/pi.ts` were removed (security review found them unused in production, with zero test coverage, and Pi was an explicit placeholder). Brain is now Claude-only — every "Engine: Codex" / "Engine: Pi" column and Codex/Pi-specific caveat below is historical design intent, not current behavior.

---

## Table of Contents

1. [Background](#1-background)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [Gap Analysis: V1 vs V2](#3-gap-analysis-v1-vs-v2)
4. [Routing Architecture](#4-routing-architecture)
   - [4.5 Loop-Intercepted Tools](#45-loop-intercepted-tools)
5. [Tool Specifications](#5-tool-specifications)
   - [5.1 `web_search`](#51-web_search)
   - [5.2 `web_fetch`](#52-web_fetch)
   - [5.3 `todo_write`](#53-todo_write)
   - [5.4 `bash_output`](#54-bash_output)
   - [5.5 `kill_shell`](#55-kill_shell)
   - [5.6 `read` notebook handling (merged, no separate tool)](#56-read-notebook-handling-merged-no-separate-tool)
   - [5.7 `exit_plan_mode`](#57-exit_plan_mode)
   - [5.8 HITL Approval Channel (`PreToolUse` integration)](#58-hitl-approval-channel-pretooluse-integration)
   - [5.9 `ask_user_question`](#59-ask_user_question)
6. [Hands-side Changes](#6-hands-side-changes)
7. [Configuration & Feature Flags](#7-configuration--feature-flags)
8. [Backward Compatibility](#8-backward-compatibility)
9. [Implementation Phases](#9-implementation-phases)
10. [Enhancement Decisions](#10-enhancement-decisions)

---

## 1. Background

V2 Brain replaced the Claude Agent SDK with a self-built `agentLoop` (`packages/brain/src/agent/agent-loop.ts`) that talks to the Anthropic Messages API directly. The benefit is full control over the loop (multi-engine support was explored but the Codex/Pi engines were later removed — see update note above) and proper Brain↔Hands separation.

The cost: every tool that the SDK used to inject for free has to be re-implemented or it disappears. Today V2 only ships:

- Hands-routed file/shell tools: `bash`, `read`, `write`, `edit`, `multi_edit`, `glob`, `grep`, `ls`, `notebook_edit`
- Brain-local memory/skill tools: `save_memory`, `save_skill`, `add_skill_file`, `update_skill_file`, `remove_skill_file`
- Sub-agent / cross-agent: `task`, `a2a_call`
- Platform MCP: `mcp__<server>__<tool>`

Compared with V1's Claude engine (which inherited the SDK's full tool catalog via its `permissions.allow` list and `HITL_DEFAULT_AUTO_ALLOW` default), V2 is missing:

| Capability | V1 | V2 | Severity |
|---|---|---|---|
| Web search | `WebSearch` | — | High (no internet at all) |
| URL fetch | `WebFetch` | — | High |
| Task planning | `TodoWrite` | — | High (`inference-optimization` skill depends on it) |
| Background shell | `BashOutput` / `KillShell` | — | Medium (long-running jobs only) |
| Notebook read | `NotebookRead` (SDK-implicit) | — | Low (merged into `read`, see §5.6) |
| Plan mode | `ExitPlanMode` | — | Low |
| End-user approval | `permissionRequest` / `decisionResult` SSE flow | API endpoint exists, Brain not wired | High (security/UX) |
| Agent-initiated user question | `AskUserQuestion` (Claude Code) | — | Medium (UX; reduces guess-and-check) |

**Summary**: After V2 built its own agent loop, the built-in tools originally provided by the Claude SDK (web access, task planning, background shell, user approval, etc.) were all lost. This document re-lands these capabilities inside the V2 system, following V2's "Brain routing + Hands sandbox" architecture.

---

## 2. Goals & Non-Goals

### 2.1 Goals

1. Restore parity with V1 for the missing built-in tools listed above (8 tools + 1 ask_user_question).
2. Keep tool names and schemas **engine-agnostic** — Claude / Codex / Pi all see the same `ToolSchema[]`.
3. Reuse the existing routing layer (`tools/router.ts`) — no engine-specific tool registration.
4. Wire the existing API endpoint `POST /v1/chat/sessions/:id/decisions` into the Brain tool-use path so end users can approve dangerous tool calls after plugin `PreToolUse` hooks have produced the final input.
5. Pluggable web search backend (Anthropic native → Tavily → Brave → Serper) selected via env, all behind the same `web_search` schema.
6. Match Claude Code's observable behavior where pragmatic (HITL semantics, plan mode FSM, BG shell stall watchdog), but adapt to V2's Brain↔Hands separation and SSE event protocol.
7. Zero new dependency on the Claude Agent SDK.

### 2.2 Non-Goals

- Re-introducing the SDK or any SDK-only message format.
- Solving in-process headless browsing for `web_fetch` (Markdown conversion only; JS-rendered pages handled by external browser/Playwright MCP; see §5.2 JS-rendered page policy).
- Multi-tenant rate limiting on web tools (separate concern).
- Persisting `todo_write` state across `exec_complete` cycles (in-memory only, matches Pi engine's V1 behavior).

---

## 3. Gap Analysis: V1 vs V2

### 3.1 Tool Inventory Diff

| V1 (SDK-injected) | V2 (today) | Action |
|---|---|---|
| `Bash` / `Read` / `Write` / `Edit` / `MultiEdit` / `Glob` / `Grep` / `NotebookEdit` | `bash` / `read` / `write` / `edit` / `multi_edit` / `glob` / `grep` / `notebook_edit` | ✅ Equivalent (renamed lowercase) |
| `Task` (sub-agent) | `task` | ✅ Equivalent (Claude/Pi only; Codex filters out) |
| `mcp__*` | `mcp__<server>__<tool>` | ✅ Equivalent |
| `WebSearch` | — | **Add `web_search`** (§5.1) |
| `WebFetch` | — | **Add `web_fetch`** (§5.2) |
| `TodoWrite` | — | **Add `todo_write`** (§5.3) |
| `BashOutput` | — | **Add `bash_output`** (§5.4) — depends on Hands BG support |
| `KillShell` | — | **Add `kill_shell`** (§5.5) — depends on Hands BG support |
| `NotebookRead` (implicit in SDK) | — | **Extend `read` to handle `.ipynb`** (§5.6) — no separate tool, mirrors Claude Code |
| `ExitPlanMode` | — | **Add `exit_plan_mode`** (§5.7) |
| `permissionRequest` / `decisionResult` SSE | API endpoint only, Brain disconnected | **Wire HITL into `PreToolUse`** (§5.8) |
| `AskUserQuestion` (Claude Code) | — | **Add `ask_user_question`** (§5.9) — reuses HITL SSE channel |
| — | `save_memory` / `save_skill` / `*_skill_file` | V2-only (keep) |
| — | `a2a_call` | V2-only (keep) |
| — | `ls` | V2-only (keep) |
| — | `upload_to_s3` / `download_from_s3` | V2-only, internal Brain↔Hands plumbing (not exposed to LLM, keep) |

### 3.2 Where Each New Tool Runs

```
Brain receives LLM tool_use:
    │
    ├─ tool ∈ {bash, read, write, edit, glob, grep, ls,
    │          notebook_edit, multi_edit,
    │          bash_output, kill_shell}      ← NEW (Hands, BG mgr)
    │   → router.hands.callTool() — sandbox execution
    │   (read auto-detects .ipynb and formats cells; no separate notebook_read)
    │
    ├─ tool ∈ {save_memory, save_skill, add_skill_file,
    │          update_skill_file, remove_skill_file,
    │          todo_write,                   ← NEW (loop intercept + onEvent)
    │          exit_plan_mode,               ← NEW (loop state machine)
    │          ask_user_question}            ← NEW (loop intercept + suspend)
    │   → router internal OR loop-intercepted (§4.5)
    │
    ├─ tool ∈ {web_search, web_fetch}        ← NEW (Brain-local HTTP)
    │   → Brain executes directly
    │   → No sandbox, no platform MCP
    │
    ├─ tool = task / a2a_call
    │   → existing dispatch
    │
    └─ tool = mcp__<server>__<tool>
        → platform MCP client (existing)

Tool approval (HITL):                         ← NEW wiring
    For every tool above (configurable allow-list bypass), Brain may emit
    `permissionRequest` to the event store, suspend the call, and resume
    when API publishes `decision.<sessionId>` on NATS.
    `ask_user_question` reuses the same NATS subject with a different
    event type (`userQuestion` / `questionAnswer`).
```

---

## 4. Routing Architecture

### 4.1 ToolRouter Extension

`tools/router.ts` gains new dispatch buckets **and** a clear split between router-dispatched tools and loop-intercepted tools. The engine loop handles some `BRAIN_LOCAL_TOOLS` itself (see §4.5) — they never reach `route()`.

```ts
// --- Sandbox tools (tools/hands.ts) ---
// The set of tools the sandbox runs lives in its own module, because the
// deadline built for a call in clients/hands.ts is read off the same set and the
// two files would otherwise import each other.
//   isSandboxTool("bash") -> true
//   HANDS_TOOLS = bash, read, write, edit, glob, grep, ls, notebook_edit,
//                 multi_edit, upload_to_s3, download_from_s3,
//                 log_s3_upload_manifest, bash_output, kill_shell, wait

const BRAIN_LOCAL_TOOLS = new Set([
  "save_memory", "save_skill",
  "add_skill_file", "update_skill_file", "remove_skill_file",
  "todo_write",                            // + planning (P1)
  "exit_plan_mode",                        // + plan mode (P4)
  "ask_user_question",                     // + agent-initiated questions (P5)
]);

const BRAIN_NETWORK_TOOLS = new Set([
  "web_search", "web_fetch",               // + internet (P0)
]);

// --- Loop-intercepted subset (§4.5) ---
// These tools require loop state mutation, custom onEvent payloads, or NATS
// suspension. The engine loop handles them BEFORE calling router.route().
const LOOP_INTERCEPTED_TOOLS = new Set([
  "todo_write",          // loop owns todoState + custom argumentsDetail event
  "exit_plan_mode",      // loop owns planMode state machine
  "ask_user_question",   // loop suspends on NATS answer
]);

// --- route() dispatch (pseudo-code) ---
async route(name: string, input: Record<string, unknown>): Promise<string> {
  // Guard: loop-intercepted tools must never reach here.
  if (LOOP_INTERCEPTED_TOOLS.has(name))
    throw new Error(`${name} must be handled by engine loop, not router`);

  if (isSandboxTool(name))           return this.hands.callTool(name, input);
  if (BRAIN_NETWORK_TOOLS.has(name)) return this.networkTool(name, input);
  if (name === "save_memory")        return this.handleSaveMemory(input);
  // ... save_skill, add_skill_file, etc. (existing)
  if (name === "a2a_call")           return this.handleA2ACall(input);
  if (name.startsWith("mcp__"))      return this.callPlatformMcp(name, input);
  throw new Error(`Unknown tool: ${name}`);
}

// networkTool delegates to WebSearchService / WebFetchService.
private async networkTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === "web_search") return this.webSearch.execute(input);
  if (name === "web_fetch")  return this.webFetch.execute(input);
  throw new Error(`Unknown network tool: ${name}`);
}
```

> **Note**: `read` is extended on the Hands side to recognize `.ipynb` path suffix and format cells — no separate `notebook_read` tool, mirroring Claude Code's design.

`WebSearchService` and `WebFetchService` require request-scoped model context (API key, base URL, active model, session id, abort signal). Keep `route(name, input)` unchanged by injecting these services into `ToolRouter` when the engine constructs it for a request:

```ts
interface WebToolContext {
  sessionId: string;
  apiKey: string;
  apiUrl: string;
  model: string;
  anthropic: Anthropic;           // pre-built Anthropic SDK client (reused from engine)
  sessionCost: SessionCostTracker; // accumulates token usage across all sub-LLM calls
  binaryWriter?: WebFetchBinaryWriter; // optional Hands-backed writer for binary web_fetch artifacts (P6)
  signal?: AbortSignal;
}

interface WebFetchBinaryWriter {
  writeArtifact(input: {
    filename: string;
    contentType: string;
    data: Buffer;
  }): Promise<{ path: string; bytes: number; sha256: string }>;
}

new ToolRouter(hands, platformMcp, {
  webSearch: new WebSearchService(webToolContext),
  webFetch: new WebFetchService(webToolContext),
});
```

If an engine constructs `ToolRouter` before request-scoped credentials are available, P0 must refactor construction so web tools receive the same credentials as the main model call.

### 4.2 Per-Engine Schema Filtering

The same schema registry is shared by all engines, but not every engine gets the same loop-level features automatically. Schema exposure and tool dispatch are separate concerns:

- **Claude engine** uses `agent/agent-loop.ts`; P2/P4/P5 features land there first.
- **Pi engine** also uses `agent/agent-loop.ts` but does not connect platform MCP; it gets the same built-ins except MCP.
- **Codex engine** runs its own inline OpenAI tool loop in `engines/codex.ts`; it strips `task` today and must receive explicit P2/P4/P5 wiring. Do not assume changes in `agent/agent-loop.ts` affect Codex.

**Summary**: Tool schemas can be shared, but loop capabilities cannot be assumed shared. In particular, Codex does not go through `agent/agent-loop.ts`, so HITL, Plan Mode, and AskUserQuestion must be wired in separately.

### 4.3 Tool State Lifecycles

| Tool | State Owner | Persisted? | Cross-Sub-Agent? |
|---|---|---|---|
| `web_search` / `web_fetch` | Stateless (web_fetch has process-local LRU cache) | No | N/A |
| `todo_write` | Engine loop `todoState` (§4.5) | No (in-memory per execute) | No — sub-agents get their own loop context, so their todo state is keyed separately |
| `exit_plan_mode` | `agentLoop.planMode` | No | No (sub-agent runs in agent mode) |
| `bash_output` / `kill_shell` | Hands BG manager (per-sandbox) | No | Yes (shared sandbox) |
| `read` (notebook path) | Stateless | N/A | N/A |
| HITL decision | `HitlController.pendingDecisions` Map | No | Shared by Claude/Pi agentLoop; Codex needs explicit loop adapter |
| `ask_user_question` | `QuestionController.pendingQuestions` Map | No | Reuses NATS subject; Codex needs explicit loop adapter |

### 4.4 Engine Loop Integration

P2/P4/P5 are not pure `ToolRouter` features. They need a small engine-facing control layer:

| Feature | Claude | Pi | Codex |
|---|---|---|---|
| HITL approval | `agent/agent-loop.ts` runs plugin `PreToolUse`, then calls `HitlController.beforeToolUse()` on the final input before `router.route()` | Same as Claude | `engines/codex.ts` applies the same order inside its OpenAI tool-call loop |
| `exit_plan_mode` | `agent/agent-loop.ts` owns `planMode` and filters schemas each turn | Same as Claude | `engines/codex.ts` must filter OpenAI function schemas and handle `exit_plan_mode` tool result |
| `ask_user_question` | `agent/agent-loop.ts` suspends on `QuestionController.ask()` | Same as Claude | `engines/codex.ts` must suspend inside its tool loop before appending the OpenAI `tool` message |

Implementation rule: common policy lives in `packages/brain/src/agent/hitl.ts` and `packages/brain/src/ask-user.ts`; engine loops only decide where to call it.

### 4.5 Loop-Intercepted Tools

Current `ToolRouter.route()` signature is `(name, input) → Promise<string>` with no access to `onEvent` or loop state. Three new tools cannot be pure router calls:

| Tool | Why intercepted |
|---|---|
| `todo_write` | Needs to emit custom `argumentsDetail.todo_write.todos` event for frontend rendering. Generic `toolUsed` event from `runRegularTool` does not carry this payload. |
| `exit_plan_mode` | Needs to flip `agentLoop.planMode` and rebuild the tool schema list for the next turn. Router has no handle on loop state. |
| `ask_user_question` | Needs to suspend the loop on `QuestionController.ask()` (NATS await). Router is synchronous dispatch; suspending inside it would block all other tool handling. |

**Intercept point**: in `agent/agent-loop.ts`'s `runRegularTool` (and the equivalent block in `engines/codex.ts`), **before** calling `router.route()`:

```ts
// agent/agent-loop.ts — inside runRegularTool(tc)
if (toolName === "todo_write") {
  const todos = (input.todos as TodoItem[]) ?? [];
  if (todos.some(t => !t.id)) {
    resultText = "Error: every todo item must include id.";
    resultByToolId.set(toolId, resultText);
    return;
  }
  // merge=false requires full items (id + content + status); merge=true allows partial
  if (!input.merge && todos.some(t => !t.content || !t.status)) {
    resultText = "Error: when merge=false, every todo item must include id, content, and status.";
    resultByToolId.set(toolId, resultText);
    return;
  }
  if (input.merge && todos.some(t => !todoState.some(e => e.id === t.id) && (!t.content || !t.status))) {
    resultText = "Error: when merge=true, new todo items must include content and status.";
    resultByToolId.set(toolId, resultText);
    return;
  }
  todoCallSeq++;
  todoState = input.merge ? mergeTodos(todoState, todos) : todos;

  // All-Done Clear: emit the final list for UI, then reset stored state
  const eventTodos = todoState;
  const allDone = eventTodos.length > 0
    && eventTodos.every(t => t.status === "completed" || t.status === "cancelled");
  if (allDone) todoState = [];

  resultText = "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable.";
  await onEvent({
    type: "toolUsed", tool: "todo_write", actionId: toolId, status: "success",
    argumentsDetail: { todo_write: { todos: eventTodos } },
    description: `${eventTodos.length} todos updated`,
  });
  resultByToolId.set(toolId, resultText);
  return;
}

if (toolName === "exit_plan_mode") {
  // Guard: reject if not actually in plan mode
  if (!planMode) {
    resultText = "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.";
    await onEvent({ type: "toolUsed", tool: "exit_plan_mode", actionId: toolId, status: "error",
      description: resultText });
    resultByToolId.set(toolId, resultText);
    return;
  }
  // §5.7 — check plan_mode_requires_approval before flipping state
  if (request.plan_mode_requires_approval) {
    const hitlResult = await hitl.beforeToolUse({
      sessionId, actionId: toolId, tool: "exit_plan_mode",
      input: toolInput, signal,
    });
    if (hitlResult.action === "deny" || hitlResult.action === "skip") {
      resultText = `Plan rejected: ${hitlResult.reason ?? "denied by user"}`;
      await onEvent({ type: "toolUsed", tool: "exit_plan_mode", actionId: toolId, status: "error",
        description: resultText });
      resultByToolId.set(toolId, resultText);
      return; // stay in plan mode
    }
  }
  planMode = false;
  resultText = "Plan accepted. Write tools now available.";
  await onEvent({ type: "toolUsed", tool: "exit_plan_mode", actionId: toolId, status: "success",
    description: resultText, full_output: (input.plan as string) ?? "" });
  resultByToolId.set(toolId, resultText);
  return; // next turn rebuilds effectiveTools with full schema set
}

if (toolName === "ask_user_question") {
  const validationError = validateAskUserQuestionInput(input.questions);
  if (validationError) {
    resultText = `Error: ${validationError}`;
    resultByToolId.set(toolId, resultText);
    return;
  }
  // Suspends until NATS answer — see §5.9
  const answer = await questionController.ask({ sessionId, actionId: toolId, questions: input.questions, signal });
  resultText = formatAnswerResult(answer);
  await onEvent({ type: "toolUsed", tool: "ask_user_question", actionId: toolId, status: "success",
    description: resultText.slice(0, 200) });
  resultByToolId.set(toolId, resultText);
  return;
}

// --- All other tools go through router ---
resultText = await router.route(toolName, toolInput);
```

**Codex engine** (`engines/codex.ts`) must replicate the same three intercept blocks in its OpenAI tool-call loop, since it does not use `agentLoop`.

**Sub-agent isolation**: `runSubagent` creates its own `todoState`, `planMode=false`, and `QuestionController` for the child. The parent's state is never modified by sub-agent tool calls.

---

## 5. Tool Specifications

### 5.1 `web_search`

#### Motivation

Restore the most-requested missing capability. Engineers running long inference-optimization tasks frequently need to look up release notes, API references, or framework changelogs the model was not trained on.

#### Schema

```json
{
  "name": "web_search",
  "description": "Search the web for up-to-date information. Use for facts the model may not know (recent releases, APIs, errors). Returns links for each hit. You MUST cite sources using markdown hyperlinks.",
  "input_schema": {
    "type": "object",
    "properties": {
      "query":           { "type": "string", "description": "Search query (min 2 chars)" },
      "allowed_domains": { "type": "array", "items": { "type": "string" },
                           "description": "Only include results from these domains" },
      "blocked_domains": { "type": "array", "items": { "type": "string" },
                           "description": "Never include results from these domains" },
      "max_results":     { "type": "number", "description": "1-10 (default 5). For 3rd-party providers only; Anthropic native uses max_uses." },
      "site":            { "type": "string", "description": "Shorthand for allowed_domains: ['<site>']. Ignored if allowed_domains is set." },
      "freshness":       { "type": "string", "enum": ["day", "week", "month", "year", "any"],
                           "description": "Bias toward recency. 3rd-party providers only; Anthropic native ignores." }
    },
    "required": ["query"]
  }
}
```

> **Validation**: `allowed_domains` and `blocked_domains` cannot both be non-empty. If `site` is set and `allowed_domains` is empty, map `site` → `allowed_domains: [site]` before dispatch. Apply `WEB_SEARCH_DOMAIN_DENYLIST` after this normalization: if `allowed_domains` is set, reject/drop any allowed domain that matches the global denylist and **do not** also send `blocked_domains` to Anthropic, because the server-side web search API rejects requests containing both allow and block domain lists.

#### Output Format

The auxiliary LLM may return interleaved `text` blocks (model prose) and `web_search_tool_result` blocks. `formatWebSearchResult` walks them in order:

```
Web search results for query: "<query>"

<model prose block, if any>

Links: [{"title":"<title>","url":"<url>"},...]

<more model prose, if any>

No links found.

REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.
```

Key rules:
- `web_search_tool_result` blocks with an array `content` → `Links: ${JSON.stringify(content)}`.
- `web_search_tool_result` with **non-array** `content` → in-band error: push string `"Web search error: <error_code>"` (e.g. rate limit, quota). Log the error but do **not** throw.
- `text` blocks → append as-is (model may explain query refinements between searches).
- `server_tool_use` blocks → skip (delimiter only, URLs not extracted from them).
- `null` / `undefined` entries → skip.
- If a result set has zero `Links:` entries, emit `No links found.` as placeholder.
- Total output capped at 100 KB (`maxResultSizeChars`).
- Suffix always ends with the REMINDER line.

For third-party providers that return snippets, append snippet text per hit. The agent decides whether to follow up with `web_fetch` for any hit.

#### Backend Selection

A single `WebSearchProvider` interface with multiple implementations selected at startup:

```ts
interface WebSearchProvider {
  search(q: string, opts: {
    maxResults?: number;
    allowedDomains?: string[];
    blockedDomains?: string[];
    freshness?: string;
  }): Promise<SearchHit[]>;
}

// config: WEB_SEARCH_PROVIDER = "anthropic" | "tavily" | "brave" | "serper" | "disabled"
```

Default order:
1. **`anthropic`** — server-side `web_search_20250305` tool (Claude API only; auto-disabled for Codex/Pi).
2. **`tavily`** — `https://api.tavily.com/search`, requires `TAVILY_API_KEY`. Engine-agnostic.
3. **`brave`** — `https://api.search.brave.com/res/v1/web/search`, requires `BRAVE_API_KEY`.
4. **`serper`** — `https://google.serper.dev/search`, requires `SERPER_API_KEY`.
5. **`disabled`** — returns `Error: web search disabled` so the LLM stops trying.

The router probes the provider chain in order on first use; failures fall through to the next provider with an info log. If all fail, the tool result is `Error: no web search provider available`.

#### Third-Party Provider Parameter Mapping

The unified `web_search` schema exposes `query`, `allowed_domains`, `blocked_domains`, `max_results`, `freshness`. For the Anthropic native path, `allowed_domains`/`blocked_domains` pass through directly; `max_results`/`freshness` are ignored (server-side tool uses `max_uses`). For third-party providers, parameters are mapped:

| Schema field | Tavily | Brave | Serper |
|---|---|---|---|
| `query` | `query` | `q` | `q` |
| `allowed_domains` | `include_domains` | append `site:${d}` to `q` per domain | append `site:${d}` to `q` per domain |
| `blocked_domains` | `exclude_domains` | filter results post-fetch | filter results post-fetch |
| `max_results` | `max_results` | `count` | `num` |
| `freshness` | `days` mapping: day→1, week→7, month→30, year→365 | `freshness` (native: `pd`, `pw`, `pm`, `py`) | `tbs` param: `qdr:d`, `qdr:w`, `qdr:m`, `qdr:y` |

Each provider class is responsible for this mapping inside its `search()` implementation. Unsupported fields are silently ignored.

#### Anthropic Native Specialization (Sub-LLM wrapper, decided)

When the active engine is `claude` and `WEB_SEARCH_PROVIDER=anthropic`, keep the main agent loop clean: expose `web_search` as a normal **client-side** tool, and have `WebSearchService.execute()` open a short auxiliary Anthropic beta Messages call that contains only the server-side search tool. This mirrors how Claude Code surfaces Anthropic's server-side search as an ordinary client-side tool.

```ts
// packages/brain/src/tools/web/search.ts
async function executeAnthropicSearch(input: WebSearchInput, ctx: WebToolContext): Promise<string> {
  const query = normalizeQuery(input.query);
  const globalDenylist = WEB_SEARCH_DOMAIN_DENYLIST.split(",").filter(Boolean);
  const rawAllowedDomains = input.allowed_domains ?? (input.site ? [input.site] : undefined);
  const allowedDomains = rawAllowedDomains?.filter(d => !domainMatchesAny(d, globalDenylist));
  if (rawAllowedDomains && allowedDomains?.length !== rawAllowedDomains.length) {
    return "Error: allowed_domains contains a domain blocked by WEB_SEARCH_DOMAIN_DENYLIST";
  }
  const blockedDomains = allowedDomains?.length
    ? undefined
    : [...(input.blocked_domains ?? []), ...globalDenylist];

  const stream = ctx.anthropic.beta.messages.stream({
    model: WEB_SEARCH_MODEL || ctx.model,       // small fast model if configured, else main model
    max_tokens: 2048,
    system: "You are an assistant for performing a web search tool use",
    messages: [{ role: "user", content: `Perform a web search for the query: ${query}` }],
    tools: [{
      type: "web_search_20250305",
      name: "web_search",
      max_uses: WEB_SEARCH_MAX_USES,            // default 8
      allowed_domains: allowedDomains,
      blocked_domains: blockedDomains?.length ? blockedDomains : undefined,
    }],
    tool_choice: WEB_SEARCH_FORCE_TOOL
      ? { type: "tool", name: "web_search" }    // force search (default: true)
      : undefined,                               // let model decide whether to search
  });

  // Drain stream; SDK accumulates content blocks internally.
  // Use beta.messages.stream(), not create({ stream: true }), because only
  // MessageStream exposes finalMessage().
  for await (const event of stream) {
    // Optional: progress hooks for server_tool_use / web_search_tool_result.
  }
  // stream.finalMessage() returns the complete Message with all content blocks
  const finalMsg = await stream.finalMessage();
  accumulateUsage(finalMsg.usage, ctx.sessionCost);
  return formatWebSearchResult(query, finalMsg.content);
}
```

This approach deliberately **does not** inject `{ type: "web_search_20250305" }` into the main loop `tools` array. It avoids:

- client-side `web_search` schema name colliding with Anthropic's server-side `web_search` tool;
- widening the main `streamingTurn()` type to beta content blocks;
- teaching the main loop to preserve `server_tool_use` / `web_search_tool_result` assistant blocks;
- bypassing HITL/plugin semantics for the client-side `web_search` call.

For non-Claude engines (Codex/Pi), `web_search` uses one of the third-party providers via `BRAIN_NETWORK_TOOLS` dispatch. For Claude deployments where the beta endpoint is not available, `WEB_SEARCH_PROVIDER=anthropic` falls back to `WEB_SEARCH_FALLBACK` providers; it must not send the server-side tool spec to the stable Messages endpoint.

#### Sub-LLM Token / Cost Attribution

The auxiliary Anthropic call is a separate `beta.messages.stream()` invocation with its own final `usage` field (input/output tokens + `server_tool_use.web_search_requests`). `WebSearchService` must forward this usage to the session-level cost tracker (`ctx.sessionCost`) so the operator's billing dashboard reflects the true cost of each `web_search` call — including the Anthropic per-request search fee. If the cost tracker is not wired, the sub-LLM tokens are invisible to the user.

#### Security

- Strip `Authorization` headers from any URL the model passes through `site:` filter.
- Respect `WEB_SEARCH_DOMAIN_DENYLIST` (CSV env var) and drop hits matching it.
- Rate limit: 30 req/min per session (per-Brain in-memory leaky bucket — sufficient pre-multi-tenant).

#### Event Emission

`web_search` is dispatched through `router.route()` → `networkTool()`, which returns a plain string. The engine loop's `runRegularTool` already emits generic `toolUsed` events (`start` + `success`/`error`) for **all** router-dispatched tools. `WebSearchService` does **not** call `onEvent` internally — this avoids duplicate events and keeps the service decoupled from the event protocol.

If richer detail is needed (e.g. exposing `hits.length` in `description`), `runRegularTool` can inspect the tool name and returned text to enrich the generic event, rather than threading `onEvent` into every service.

#### Prompt Guidance

System prompt fragment injected when `web_search` is available:

```
You have access to web_search to look up current information. Searches are performed
automatically within a single API call. Use it when:
- The user asks about recent events, releases, or APIs that may postdate your training data.
- You need to verify a fact you are uncertain about.
Do NOT use web_search for questions you can confidently answer from training data.
After searching, use web_fetch to read promising URLs if the snippet is insufficient.

CRITICAL: When you use web search results, you MUST add a "Sources:" section at the end
of your response with markdown hyperlinks [Title](URL) for every source you referenced.
This is mandatory — never omit sources when search results informed your answer.
```

> **Year interpolation**: The prompt should include the current year (e.g. `"Today's date is April 2026. You MUST use this year when searching for recent information."`) to prevent the model from searching with stale year references.

---

### 5.2 `web_fetch`

#### Motivation

Lets the agent read a single URL after `web_search` selects a promising hit. Lighter and cheaper than spawning a headless browser MCP.

#### Schema

The `prompt` field enables optional Haiku-based summarization (see below) — when omitted or summarization is disabled, raw Markdown is returned.

```json
{
  "name": "web_fetch",
  "description": "Fetch a URL and return its content. Use after web_search to read a specific page. Does not execute JavaScript. If `prompt` is set and summarization is enabled, content is condensed by a small fast model before returning.",
  "input_schema": {
    "type": "object",
    "properties": {
      "url":        { "type": "string", "description": "Absolute http(s) URL" },
      "prompt":     { "type": "string", "description": "Optional task to apply to the fetched content (e.g. 'extract the API examples'). Triggers Haiku summarization when WEB_FETCH_SUMMARIZE is enabled." },
      "max_bytes":  { "type": "number", "description": "1024-10485760 (default 10 MiB). HTTP body cutoff." },
      "raw":        { "type": "boolean", "description": "true → bypass any Markdown conversion AND summarization (default false)" }
    },
    "required": ["url"]
  }
}
```

#### Implementation Notes

- HTTP client: `axios` (matches reference; cleaner redirect introspection than fetch).
- **`MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024`** (10 MiB). Honor `max_bytes` (default = `WEB_FETCH_MAX_BYTES`, also 10 MiB) via `maxContentLength` on axios; streamed body cutoff.
- **`responseType: 'arraybuffer'`** — never assume UTF-8 until content-type is checked.
- **User-Agent**: `Claw-User (primus-claw/${VERSION}; +https://support.anthropic.com/)`.
- `Content-Type` dispatch:
  - `text/html` → `turndown` for Markdown conversion (lazy-import; ~1.4 MB heap).
  - `text/markdown` / `text/plain` / `application/json` → return body as-is.
  - `application/pdf` and other binary → P0 returns `Error: unsupported binary content-type <ct>`. P6 adds binary persistence via Hands workspace artifacts (see "Binary Persistence Enhancement" below).
  - Everything else → return raw text with content-type header.
- **Redirect policy**: max 10 hops, **same-host only** (`hostname.replace(/^www\./, '')` equality, same protocol, same port, no userinfo in redirect URL). Cross-host redirect → return `RedirectInfo` block (see format below). Reject `file://`, `gopher://`, any non-`http(s)` scheme. Disable axios automatic redirects (`maxRedirects: 0`) and follow redirects manually so every `Location` target is validated and DNS-checked **before** the next request; do not rely on `beforeRedirect` alone because a missed branch could follow an SSRF redirect before validation.

**Cross-host redirect response format**:
```
REDIRECT DETECTED: The URL redirects to a different host.
Original URL: <original_url>
Redirected URL: <redirect_url>
Status: <code> <text>  (301 Moved Permanently / 302 Found / 307 Temporary Redirect / 308 Permanent Redirect)

Please call web_fetch again with the redirected URL and the same prompt if you still want this content.
```
- **Auto-upgrade** `http://` → `https://` before request.
- **URL validation**: reject username/password embedded in URL, hostname must have ≥ 1 dot.
- 60-second per-hop timeout (matches reference's `FETCH_TIMEOUT_MS`).
- **SSRF guard**: resolve hostname via `dns.lookup` before request and after every redirect. Refuse `localhost`, IPv4 loopback/private/link-local/reserved ranges (`0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, multicast/reserved), IPv6 loopback/link-local/private ranges (`::1`, `fc00::/7`, `fe80::/10`), and IPv4-mapped IPv6 addresses that resolve into blocked IPv4 ranges. Re-resolve and re-check the hostname for every redirect to reduce DNS rebinding risk. Also apply configurable `WEB_FETCH_DOMAIN_DENYLIST`.

  > **Why local DNS checks**: V2 Brain runs in a controlled cluster and cannot assume an external domain-reputation preflight service is reachable, so SSRF protection is enforced locally via DNS resolution plus IP-range checks. If operators later deploy an egress proxy with allowlisting, these DNS checks become defense-in-depth.
- **Egress proxy guard**: if axios returns `403` with header `X-Proxy-Error: blocked-by-allowlist`, surface a structured `EGRESS_BLOCKED` error.
- **LRU cache**: 15 min TTL, 50 MB cap. Cache only the fetched/decoded page content keyed by normalized final URL + response content type + `raw` mode. Do **not** cache summarized output by URL alone; if summary caching is added later, its key must include `prompt`, summarization model, guideline tier, and truncation settings.
- **Output budget**: regardless of `max_bytes`, the returned tool result is capped by `WEB_FETCH_MAX_OUTPUT_CHARS` (default 50,000 chars) with a `[Content truncated due to length...]` marker. This prevents a single URL from consuming the main loop context when `prompt` is empty or summarization is disabled.

#### Dependency Policy

Current `@claw/brain` dependencies do not include `axios`, `turndown`, or `lru-cache`. P0 uses the **full implementation** profile below:

| Profile | Dependencies | Trade-off |
|---|---|---|
| Full implementation (recommended) | Add `axios`, `turndown`, `lru-cache` to `packages/brain/package.json` | Cleaner redirect handling and cache semantics. |
| Minimal dependency | Use Node 22 `fetch`, a tiny in-memory Map TTL cache, and a basic HTML text extractor | Smaller dependency surface, but less faithful Markdown conversion and redirect behavior. |

Decision for this document: **reference parity**. P0 therefore includes `packages/brain/package.json` and lockfile changes.

#### Haiku Summarization (configurable, default ON per decision)

When `WEB_FETCH_SUMMARIZE=true` (default) AND `prompt` is non-empty AND `raw=false`:

1. Truncate Markdown to `MAX_MARKDOWN_LENGTH = 100,000` chars with `[Content truncated due to length...]` marker.
2. Send to a small fast model (configurable `WEB_FETCH_SUMMARIZE_MODEL`, default `claude-3-5-haiku-latest` for Anthropic provider; `gpt-4o-mini` for OpenAI; skip for Pi).
3. Build the summarization prompt using **two-tier compliance guidelines**:

   ```
   Web page content:
   ---
   ${markdown}
   ---

   ${prompt}

   ${guidelines}
   ```

   Where `guidelines` depends on domain trust:
   - **Preapproved domain** (documentation / code sites from a curated allowlist — see below): `"Be concise. Include relevant code examples and documentation details."`
   - **Non-preapproved domain**: `"Quote at most 125 characters from the source. Paraphrase or summarize instead. Do not reproduce song lyrics, full articles, or legal commentary."`

   The system prompt for the Haiku call is **empty**.

4. Return summarized text in the body. If the model returns no text blocks, return `"No response from model"`.

**Preapproved Domain List**: a curated `Set<string>` of ~150 documentation/code hosts (e.g. `docs.python.org`, `developer.mozilla.org`, `github.com/anthropics`). Entries can be hostname-only or `hostname/path` prefix. Matching uses `isPreapprovedHost(hostname, pathname)` — exact hostname match + optional `pathname.startsWith(prefix + '/')` to avoid prefix collision (e.g. `/anthropics-evil`). The list affects summarization guideline tier only.

The list is maintained in `packages/brain/src/tools/web/preapproved.ts` and is curated for PrimusClaw — it covers the documentation sites the agent most often needs to read.

Preapproved domains affect summarization guidance only. They do **not** bypass HITL for `web_fetch` by default; operators can still add explicit entries to `HITL_AUTO_ALLOW` if their deployment policy allows it.

When `WEB_FETCH_SUMMARIZE=false` OR `prompt` is empty OR `raw=true`: return raw Markdown.

**Fast path (skip summarization)**: If `prompt` is empty AND the URL is a preapproved domain AND `Content-Type` is `text/markdown` AND content length < `MAX_MARKDOWN_LENGTH` (100K), return content directly without calling the summarization model — the page is already clean Markdown from a trusted source. If `prompt` is non-empty, still run summarization/extraction with the preapproved-domain guideline tier; otherwise the tool would ignore the caller's requested extraction task.

#### `raw=true` Semantics

`raw=true` bypasses HTML → Markdown conversion and summarization, but it does **not** bypass safety or output limits:

1. URL validation, SSRF checks, redirect checks, timeout, denylist, and `max_bytes` still apply.
2. The body is decoded as UTF-8 with replacement characters for invalid sequences.
3. Binary content types return `Error: unsupported binary content-type <ct>` in P0. When `WEB_FETCH_BINARY_ENABLED=true` (P6), binary responses are saved through `ctx.binaryWriter` after the same URL/SSRF/redirect checks.
4. The final returned text is still capped by `WEB_FETCH_MAX_OUTPUT_CHARS`.

> **Why default ON**: saves main-LLM context for large pages. Operators that prefer to avoid the extra LLM round-trip can flip the env to `false`.

#### JS-Rendered Page Policy (P6 decision)

Do **not** embed Playwright/headless Chrome into Brain or Hands. `web_fetch` stays a deterministic HTTP + Markdown tool with no JavaScript execution. For JS-rendered pages:

1. `web_fetch` returns the fetched static HTML/Markdown as usual.
2. If the page appears JS-shell-only (very short body, common app-root markers like `<div id="root">`, or text such as "enable JavaScript"), append:

   ```
   JS_RENDER_REQUIRED: This page appears to require JavaScript rendering.
   Use the configured browser/Playwright MCP tool to inspect it.
   ```

3. Operators should deploy a browser MCP such as Playwright/browser-use separately for rendered pages. This keeps `web_fetch` cheap, sandbox-independent, and safe for server-side URL fetching.

#### Binary Persistence Enhancement (P6 decision)

When `WEB_FETCH_BINARY_ENABLED=true`, `web_fetch` persists supported binary responses to the Hands workspace instead of returning an unsupported-content error:

1. Apply all existing URL validation, SSRF checks, redirect checks, denylist checks, timeout, and `max_bytes` limits before writing anything.
2. Allow only configured content types (`WEB_FETCH_BINARY_ALLOWLIST`, default: `application/pdf`) and reject everything else as unsupported.
3. Compute `sha256` and choose a deterministic filename:

   ```ts
   const ext = extensionFromContentType(contentType) ?? ".bin";
   const filename = `${new URL(url).hostname}-${sha256.slice(0, 16)}${ext}`;
   ```

4. Use `ctx.binaryWriter.writeArtifact()` backed by Hands to write under `WEB_FETCH_BINARY_DIR` (default `/workspace/.claw/webfetch`). Do not let the model choose the path.
5. Return a text result, not bytes:

   ```
   URL: https://example.com/file.pdf
   Status: 200
   Content-Type: application/pdf
   Length: 123456 bytes
   Saved: /workspace/.claw/webfetch/example.com-abcd1234ef567890.pdf
   SHA256: <sha256>
   ```

If `WEB_FETCH_BINARY_ENABLED=true` but `ctx.binaryWriter` is unavailable, return `Error: binary web_fetch is enabled but no Hands artifact writer is configured`.

#### Summarization API Key Source

The summarization LLM call **reuses the same `apiKey` and `ANTHROPIC_BASE_URL`** as the main model. This means the LiteLLM proxy (or direct Anthropic gateway) routing table **must include the Haiku model** for summarization to work. If the call returns a 404/model-not-found error, `web_fetch` falls back to returning raw Markdown with a `Summarized: failed (model unavailable)` header — never throws.

No separate `WEB_FETCH_SUMMARIZE_API_KEY` or `WEB_FETCH_SUMMARIZE_BASE_URL` env var. The trade-off is simplicity over decoupling; operators who run a restricted proxy that only routes the main model must either add the Haiku model to the route table or set `WEB_FETCH_SUMMARIZE=false`.

**Summary**: The summarization call reuses the main model's apiKey and baseUrl, and requires the LiteLLM routing table to include the Haiku model. On failure it degrades to returning raw Markdown without interruption.

#### Output Header

```
URL: https://example.com/foo
Status: 200
Content-Type: text/html; charset=utf-8
Length: 12345 bytes (truncated to 10485760)
Summarized: yes (claude-3-5-haiku-latest, prompt="extract the API examples")
---
<markdown or summarized body>
```

When summarization is off, omit the `Summarized:` line.

#### Prompt Guidance

```
You have access to web_fetch to read a URL's content as Markdown. Use it after web_search
to read a page that looks promising. Set `prompt` to extract only the relevant section
(e.g. "extract the API examples") — this triggers server-side summarization and saves context.
Do NOT use web_fetch to download binary files (images, PDFs). If the URL requires JavaScript
rendering, use the browser MCP instead.
```

---

### 5.3 `todo_write`

#### Motivation

Several skills (notably `inference-optimization`) rely on a structured task list to coordinate multi-phase execution. Without it the agent loses track of progress and re-does work.

#### Schema

Based on V1's `buildTodoWriteTool`, with a schema shaped like Claude Code's public `TodoWrite` tool. `id`, `merge`, and `cancelled` are **V2 extensions** to support incremental updates and frontend diff rendering; they are not present in Claude Code's `TodoWrite` schema.

> **`merge` conditional required**: When `merge=false` (replace), every item MUST provide `id`, `content`, and `status` — the engine validates this at runtime and returns an error to the LLM if missing. When `merge=true` (upsert), existing items may be partially updated by `id`; omitted `content`/`status` fields keep their existing values via spread. A new `id` in merge mode still MUST include `content` and `status`, otherwise the list would contain an incomplete todo. This allows partial updates like `{ id: "x", status: "completed" }` without repeating `content`. The JSON Schema `required` only lists `["id"]` to permit both modes; the additional validation is enforced in the intercept code.

```json
{
  "name": "todo_write",
  "description": "Create or update a structured task list. Call to outline phases, update as you complete them. When merge=true, only provided items are upserted by id; when merge=false (default), the list is replaced entirely.",
  "input_schema": {
    "type": "object",
    "properties": {
      "todos": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id":         { "type": "string", "description": "Unique item id (stable across updates)" },
            "content":    { "type": "string", "description": "Description of the task/phase" },
            "status":     { "type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"] },
            "activeForm": { "type": "string", "description": "Brief status text shown in UI" }
          },
          "required": ["id"]
        }
      },
      "merge": { "type": "boolean", "default": false,
                 "description": "true = upsert items by id into existing list; false = replace entire list" }
    },
    "required": ["todos"]
  }
}
```

#### State

In-memory on the **engine loop** (not on `ToolRouter` — see §4.5 for why):

```ts
// Inside agentLoop / codex engine loop
let todoState: TodoItem[] = [];
let todoCallSeq = 0;

function mergeTodos(existing: TodoItem[], incoming: TodoItem[]): TodoItem[] {
  const map = new Map(existing.map(t => [t.id, t]));
  for (const t of incoming) map.set(t.id, { ...map.get(t.id), ...t });
  return [...map.values()];
}
```

#### Routing

`todo_write` is in `LOOP_INTERCEPTED_TOOLS` — the engine loop handles it directly (§4.5 pseudo-code). It never reaches `router.route()`.

See §4.5 pseudo-code for the complete `todo_write` intercept (includes validation, merge, allDone clear, and event emission). Not duplicated here to avoid drift.

#### UI Compatibility

V1 Pi engine emits `toolUsed` events with `argumentsDetail.todowrite.todos`. We keep the same shape (key renamed to `todo_write` to match tool name):

```ts
argumentsDetail: { todo_write: { todos: eventTodos } }
```

Frontend diff rendering: with `id` on each item, the frontend can animate individual item status transitions instead of replacing the entire list.

#### All-Done Clear Behavior

When every item in `todoState` has reached a terminal state (`completed` or `cancelled`), the stored state is cleared to `[]`. This prevents stale completed lists from consuming context in subsequent turns. The `toolUsed` event still reports the full completed list so the frontend can render the final state, but `todoState` itself is empty for the next turn.

```ts
const eventTodos = todoState;
const allDone = eventTodos.length > 0
  && eventTodos.every(t => t.status === "completed" || t.status === "cancelled");
if (allDone) todoState = [];
// onEvent receives eventTodos; stored todoState is empty for the next turn
```

#### Sub-Agent Behavior

Sub-agents share the parent's `ToolRouter` skill-tracking infrastructure but get their own `todoState` (sub-agents have isolated context windows; their plans should not leak up). Implementation: `runSubagent` builds a fresh loop context for the child; that gives a fresh `todoState`.

#### Prompt Guidance

```
You have access to todo_write to track multi-step task progress. Use it when:
- The task has 3+ distinct phases or steps.
- You need to coordinate work across multiple files or tools.
Call todo_write at the start to outline your plan, then update individual items
(merge=true) as you complete them. Keep exactly one item as in_progress at a time.
Do NOT use todo_write for single-step or trivial tasks.
```

---

### 5.4 `bash_output`

#### Motivation

Long-running benchmark / training jobs can't sit on a synchronous bash call for hours. V1's `BashOutput` lets the agent start a background process and poll its output later.

#### Prerequisite

Hands must support background processes. Today `packages/hands/src/tools/shell/bash.ts` only does `execSync`-style synchronous execution. See [§6.1 Background Shell Manager](#61-background-shell-manager).

#### Schema

```json
{
  "name": "bash_output",
  "description": "Read incremental output from a background shell started with bash(run_in_background=true). Returns new bytes since last poll plus exit status if finished.",
  "input_schema": {
    "type": "object",
    "properties": {
      "shell_id":  { "type": "string", "description": "ID returned by bash(run_in_background=true)" },
      "filter":    { "type": "string", "description": "Optional regex; only matching lines are returned" }
    },
    "required": ["shell_id"]
  }
}
```

#### `bash` Schema Extension

Existing `bash` tool gains two optional fields (no breaking change for callers omitting them):

```json
"run_in_background": { "type": "boolean", "description": "Start in background; returns shell_id immediately" },
"shell_id":          { "type": "string",  "description": "Reuse this id (advanced); auto-generated when omitted" },
"background_kind":   { "type": "string", "enum": ["background", "monitor"],
                       "description": "Only with run_in_background=true. Use monitor for expected long-running log watchers such as tail -f; monitor shells skip stall-prompt notifications." }
```

When `run_in_background=true`, bash returns:

```
Started background shell <shell_id>. Poll output with bash_output, terminate with kill_shell.
```

#### Output Format

```
Shell: <shell_id>
Status: running | exited (exit_code=N) | killed
New stdout (bytes 1234..2345):
<lines>
New stderr:
<lines>
```

#### Stall Watchdog

Long-running BG shells often block on interactive prompts (`(y/n)`, `Press Enter`, etc.) and never produce more output. The Hands BG manager runs a per-shell watchdog:

- Check interval: 5 s.
- Stall threshold: 45 s with **no new output bytes**.
- On stall: read tail (1 KB) and apply `looksLikePrompt(tail)` heuristic (regexes for `(y/n)`, `[Y/n]`, `Press Enter`, `Continue?`, `Are you sure...?$`, etc.).
- If it looks like a prompt: send a one-shot `task_notification` event through NATS → Brain consumes it and injects it into the next LLM turn as a synthetic user message:

```xml
<task_notification>
<task_id>bg-shell-abc123</task_id>
<tool_use_id>toolu_01...</tool_use_id>
<output_file>/tmp/claw-shells/abc123.log</output_file>
<summary>Background command "pip install ..." appears to be waiting for interactive input</summary>
</task_notification>
Last output:
Proceed (Y/n)?

The command is likely blocked on an interactive prompt. Kill this task and re-run with piped input (e.g., `echo y | command`) or a non-interactive flag if one exists.
```

- After firing once per shell, the watchdog cancels itself (latched).
- If no prompt pattern matches, watchdog resets and keeps observing.

#### Completion Notification

When a BG shell exits (or is killed), Hands also pushes a notification through the same channel:

```xml
<task_notification>
<task_id>...</task_id>
<output_file>/tmp/claw-shells/abc123.log</output_file>
<status>completed | failed | killed</status>
<summary>Background command "..." completed (exit code 0)</summary>
</task_notification>
```

The Brain agent loop drains a `pendingNotifications` queue at the start of each turn and prepends them as `user` messages so the LLM is aware without needing to poll `bash_output`.

---

### 5.5 `kill_shell`

#### Schema

```json
{
  "name": "kill_shell",
  "description": "Terminate a background shell started with bash(run_in_background=true). Sends SIGTERM, then SIGKILL after 5s.",
  "input_schema": {
    "type": "object",
    "properties": {
      "shell_id": { "type": "string", "description": "ID returned by bash(run_in_background=true)" }
    },
    "required": ["shell_id"]
  }
}
```

#### Result

```
Shell <shell_id> terminated (was: running, exit_code=143)
```

---

### 5.6 `read` notebook handling (merged, no separate tool)

#### Decision

Claude Code does **not** expose a separate notebook-read tool — its generic file-read tool handles `.ipynb` inline. We adopt the same design (decision Q&A: `notebook_read=merge_into_read`) — no schema changes for the LLM, less surface area to maintain.

#### Implementation

Inside `packages/hands/src/tools/fs/read.ts`, after path validation and before regular UTF-8 read:

```ts
if (resolvedPath.endsWith(".ipynb")) {
  const nb = JSON.parse(await fs.readFile(resolvedPath, "utf-8"));
  return formatNotebook(nb, { cellIndexFilter: input.notebook_cell_index });
}
```

- Add an **optional** `notebook_cell_index?: number` field to `read`'s input schema (no breaking change for non-notebook reads).
- `formatNotebook` produces the format below.
- All existing `read` features (offset/limit, large-file handling, image previews) bypass the notebook path.

#### Output Format

```
Notebook: <path>
Cells: 12 (kernel: python3)

[0] markdown:
# My analysis

[1] code (3 outputs):
import pandas as pd
df = pd.read_csv("data.csv")
df.head()

[2] code (no outputs): ...
```

Outputs that are `image/png` etc. show only `<binary output, N bytes>`; text outputs are inlined truncated to 1 KB per cell. When `notebook_cell_index` is provided, only that one cell's section is returned.

#### Why merge instead of separate tool

- Reduces tool count (LLM picks the right tool more reliably).
- The existing `read` permission policy (path scoping, deny-list) automatically applies.
- Matches Claude Code's observable behavior — easier to validate skill compatibility.

---

### 5.7 `exit_plan_mode`

#### Motivation

Some agents prefer to brainstorm/plan first, then commit to a plan before touching the filesystem. The V1 SDK's `ExitPlanMode` lets the agent declare "here's the plan, switch me to write mode now."

#### Behavior

When the engine starts in **plan mode** (a new `ExecuteRequest.plan_mode?: boolean = false` field), schemas are filtered by an explicit allowlist. Do not infer safety from broad buckets like "Brain-local" because tools such as `save_memory` and `save_skill` are Brain-local but still mutate state.

Allowed in plan mode:

- `read` (including `.ipynb` formatting)
- `glob`
- `grep`
- `ls`
- `bash_output` (read-only: polls output from an already-running BG shell)
- `web_search`
- `web_fetch`
- `todo_write`
- `ask_user_question` (if enabled)
- `exit_plan_mode`

Blocked in plan mode:

- File/sandbox mutation: `write`, `edit`, `multi_edit`, `notebook_edit`
- Shell mutation: `bash`, `kill_shell`
- Brain mutation: `save_memory`, `save_skill`, `add_skill_file`, `update_skill_file`, `remove_skill_file`
- Cross-agent mutation: `task`, `a2a_call`
- MCP tools unless the MCP schema is marked read-only by server metadata or an explicit allowlist

The filtered schema list is rebuilt every turn until the agent calls `exit_plan_mode`.

#### Schema

```json
{
  "name": "exit_plan_mode",
  "description": "Exit plan mode and switch to agent mode. Only call when you have a concrete plan and the user has approved it (or no approval is required). After this call, write/edit tools become available.",
  "input_schema": {
    "type": "object",
    "properties": {
      "plan": { "type": "string", "description": "The final plan you intend to execute (markdown)" }
    },
    "required": ["plan"]
  }
}
```

#### Loop State Transition

```
agentLoop state: planMode = true
    │
    ├─ allowed schemas = read-only subset
    │
    ▼
LLM calls exit_plan_mode(plan="…")
    │
    ├─ tool result = "Plan accepted. Write tools now available."
    ├─ planMode = false
    ├─ next turn rebuilds tools list with full schema set
    │
    ▼
LLM continues with write/bash tools available.
```

If the loop is configured with `request.plan_mode_requires_approval=true`, `exit_plan_mode` triggers a HITL `permissionRequest` (see §5.8) before flipping the state. On `deny`, the result text is `Plan rejected: <reason>` and the loop continues in plan mode.

> **Note**: `exit_plan_mode` is in `LOOP_INTERCEPTED_TOOLS` (§4.5) — handled by the engine loop directly, not `router.route()`.

#### Prompt Guidance

```
You are currently in PLAN MODE. You can read files, search, and browse — but you
cannot write, edit, or run mutating commands. Use this time to formulate a complete plan.
When your plan is ready, call exit_plan_mode with the plan in markdown.
After exiting plan mode, write/edit/bash tools become available.
```

#### Divergence from Claude Code

| Aspect | Claude Code | V2 (this design) |
|---|---|---|
| Enforcement mechanism | System prompt tells model "read-only except plan file"; write tool schemas are **not** removed | **Explicit schema allowlist** — write tools are removed from `getToolSchemas()` while `planMode=true` |
| Plan storage | Written to disk file; SDK/user can edit file before `exit_plan_mode` | In-memory `plan` string parameter only; **no** disk persistence |
| `allowedPrompts` field | Optional: permits specific bash commands in plan mode (e.g. `{ tool: "Bash", prompt: "run tests" }`) | Not implemented in P4/P6; V2 keeps explicit schema allowlist enforcement |

V2's explicit schema filtering is **intentionally stronger** — it prevents the model from bypassing prompt restrictions by directly calling write tools, which is a known weakness of prompt-only enforcement in adversarial/jailbreak scenarios.

---

### 5.8 HITL Approval Channel (`PreToolUse` integration)

#### Background

V1 had a complete end-user approval flow:

- Brain emits `{ type: "permissionRequest", tool_use_id, tool, input, ... }` SSE event.
- Frontend renders an Approve / Deny / Edit dialog.
- User decision posts back via REST → Brain's `HumanInTheLoop.submit_decision()` → unblocks the SDK hook.
- Brain emits `{ type: "decisionResult", tool_use_id, action, by }` to close the loop.

V2 has the **API endpoint** (`POST /v1/chat/sessions/:id/decisions`, NATS publish on `decision.<sessionId>`) but Brain has no consumer wired into the agent loop.

#### Design

Do **not** implement HITL as a synthetic `HookRunner`. Hook decisions are plugin policy (`block`, optional `updatedInput` after P2), while HITL decisions are user/API policy (`allow | deny | edit | skip`) with timeout, UI events, and NATS suspension. Implement a separate `HitlController`:

```ts
type ApiHitlDecision =
  | { decision: "allow"; feedback?: string }
  | { decision: "deny" | "skip"; feedback?: string }
  | { decision: "edit"; edited_input: Record<string, unknown>; feedback?: string };

type HitlResult =
  | { action: "allow"; input: Record<string, unknown>; by: "auto_allow" | "user" | "timeout" }
  | { action: "deny" | "skip"; reason: string; by: "user" | "timeout" };

class HitlController {
  async beforeToolUse(req: {
    sessionId: string;
    userId?: string;
    actionId: string;
    tool: string;
    input: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<HitlResult>;
}
```

The controller is **disabled by default**. It only emits permission requests when `HITL_ENABLED=true`; otherwise it returns `{ action: "allow", input, by: "auto_allow" }` immediately. This keeps existing deployments unchanged until operators explicitly enable HITL.

The controller:

1. Subscribes to `decision.<sessionId>` NATS subject when the engine starts.
2. Checks `tool` against `HITL_AUTO_ALLOW` (env-configurable; safe default: `read`, `glob`, `grep`, `ls`, `todo_write`, `web_search`, `save_memory`). This is intentionally stricter than V1 for `web_fetch`, because URL fetching can touch untrusted hosts.
3. For non-allowlisted tools, when `HITL_ENABLED=true`:
   - Emits `permissionRequest` event with `actionId` (= LLM tool_use_id), `tool`, `input`, `description`, `timeout_ms`.
   - Awaits one of: matching NATS `decision` message, timeout (default 300 s), or `signal.aborted`.
  - Normalizes API `edit` into `{ action: "allow", input: edited_input, by: "user" }` before returning to the engine loop.
   - On timeout: defaults to `allow` (matches V1). Configurable to `deny`.
4. Emits `decisionResult` after the decision is resolved.

Loop integration:

- `agent/agent-loop.ts` runs plugin `PreToolUse` first. P2 extends `HookDecision` with optional `updatedInput?: Record<string, unknown>`; existing hooks that only return `{ block, reason }` remain compatible.
- The final input after plugin hooks is then passed to `hitl.beforeToolUse()`.
- User approval is therefore always for the exact input that will reach `router.route()`.
- If a future plugin hook is allowed to run after HITL and modifies input, the loop must re-run HITL for the modified input. P2 should avoid this by keeping all input-mutating hooks before HITL.
- `engines/codex.ts` applies the same order inside its OpenAI tool-call loop.

#### Event Protocol (V2-Native)

Aligned with the existing `toolUsed` event family (per the user's decision in design Q&A):

```ts
// Brain → API → SSE  (request side)
{
  type: "permissionRequest",
  actionId: <tool_use_id>,
  tool: <tool_name>,
  input: <tool_input>,
  description: <best-effort short description>,
  timeout_ms: 300000,
  ts: <epoch_ms>
}

// API → Brain (decision side, posted to /v1/chat/sessions/:id/decisions)
// Body:
{ "actionId": "...", "decision": "allow" | "deny" | "edit" | "skip",
  "feedback": "<optional reason>", "edited_input": { ... } }
// API validates session ownership before publishing:
// - session must exist and not be deleted
// - session.user_id must match authenticated user OR user must be admin
// Brain receives via NATS `decision.<sessionId>` subject.

// Brain → API → SSE  (resolution side)
{
  type: "decisionResult",
  actionId: <tool_use_id>,
  decision: "allow" | "deny" | "edit" | "skip",
  by: "user" | "auto_allow" | "timeout",
  feedback?: "...",
  ts: <epoch_ms>
}
```

#### Decision Semantics

| Decision | Effect on tool call |
|---|---|
| `allow` | Tool runs with original input. |
| `edit` | Tool runs with `edited_input` from the user. |
| `deny` | Tool returns `Error: denied by user — <feedback>` to the LLM (loop continues, no exception). |
| `skip` | Same as `deny` but with reason `Error: skipped by user`. |

#### Sequence Diagram

```
LLM ──tool_use──► Brain engine loop
                      │
                      ├─ plugin PreToolUse hooks
                      │       ├─ block? → tool result = error, no HITL
                      │       └─ edit?  → finalInput = updatedInput
                      │
                      ├─ HitlController.beforeToolUse(finalInput)
                      │       │
                      │       ├─ tool ∈ AUTO_ALLOW? → fall through, run tool.
                      │       │
                      │       ├─ emit { type:"permissionRequest", actionId, ... }
                      │       │   to event store (Redis/NATS)
                      │       │
                      │       │     ┌── API SSE ──► Frontend ──► User clicks Approve
                      │       │     │
                      │       │     │   POST /v1/chat/sessions/:id/decisions
                      │       │     │   ► nc.publish("decision.<sid>", { actionId, decision })
                      │       │
                      │       └─ await decision (timeout 300s)
                      │              │
                      │              ▼
                      │       decision = "allow" → run tool
                      │       API decision = "edit" → normalized to allow with edited input
                      │       decision = "deny"  → result = "Error: denied by user — <reason>"
                      │
                      ├─ emit { type:"decisionResult", actionId, decision, by:"user" }
                      │
                      └─ continue loop
```

#### API Security Requirements

`POST /v1/chat/sessions/:id/decisions` currently publishes to NATS after checking that the session exists. P2 must also enforce the same owner/admin check used by `/interrupt`:

```ts
const session = await db.query(
  "SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
  [sessionId],
);
if (!session) return 404;
if (session.user_id && session.user_id !== userId && !isAdmin(user)) return 403;
```

The new `/answers` endpoint for `ask_user_question` must use the same check.

#### Mapping to Claude Code's Permission Model

Claude Code's documented permission model uses three behaviors: `allow | deny | ask`. There is no separate `edit` or `skip` action at the pipeline level — `edit` is modeled as `allow` with a non-null `updatedInput`, and `skip` does not exist. V2 extends this to four explicit decision values (`allow | deny | edit | skip`) for API clarity:

| V2 Decision | Claude Code equivalent | Behavior |
|---|---|---|
| `allow` | `{ behavior: "allow" }` | Run tool with original input |
| `edit` | `{ behavior: "allow", updatedInput: {...} }` | Run tool with user-modified input |
| `deny` | `{ behavior: "deny" }` | Tool returns error to LLM |
| `skip` | N/A (V2 extension) | Same as deny with canned reason "skipped by user" |

Internally `HitlController` normalizes `edit` → `{ action: "allow", input: edited_input }` before returning to the engine loop, so the loop only sees `allow` (with possibly modified input), `deny`, or `skip`.

#### Per-User `always_allow`

V1 supported "Allow + remember" — once the user clicks "always allow Bash", subsequent `Bash` calls auto-pass without prompting. V2 implementation: extend the decision request body with `remember: boolean`. Brain's HITL state stores the (sessionId, tool_name) pair in-memory (per-execution) — explicitly **not** persisted across sessions to keep each task's blast radius bounded.

Decision: do **not** persist `always_allow` across sessions in P2/P6. A single mistaken click should not grant future tasks access to mutating tools. If cross-session policy is ever needed, implement it as a separate admin-managed permission layer, not as an end-user "remember" checkbox side effect.

#### Recovery After Brain Restart

If a session is checkpointed mid-tool-call (the `CheckpointState` already exists in `engines/index.ts:10`), the `pendingDecisions` Map is **not** persisted. After resume, the tool call replays, `HitlController.beforeToolUse()` fires again, and the user is re-prompted. This is correct: Brain should not silently grant or deny on a stale decision.

#### Unified NATS Decision Dispatcher

HITL decisions and `ask_user_question` answers both arrive on the **same** NATS subject (`decision.<sessionId>`). To avoid routing ambiguity and support concurrent in-flight requests (e.g. a HITL approval pending while an `ask_user_question` is also waiting), implement a single `DecisionDispatcher`:

```ts
class DecisionDispatcher {
  private pending = new Map<string, {
    type: "decision" | "answer";
    resolve: (msg: NatsDecisionMessage) => void;
  }>();

  constructor(private nc: NatsConnection, private sessionId: string) {
    this.sub = nc.subscribe(`decision.${sessionId}`);
    this.drain();
  }

  private async drain() {
    for await (const raw of this.sub) {
      const msg = JSON.parse(sc.decode(raw.data)) as NatsDecisionMessage;
      const key = `${msg.type}:${msg.action_id}`;
      const entry = this.pending.get(key);
      if (!entry) continue; // stale or unknown — drop
      if (entry.type !== msg.type) continue; // type mismatch — drop (prevents answer→decision cross-fire)
      entry.resolve(msg);
      this.pending.delete(key);
    }
  }

  register(req: {
    actionId: string;
    type: "decision" | "answer";
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<NatsDecisionMessage> {
    const { actionId, type, timeoutMs, signal } = req;
    const key = `${type}:${actionId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error("decision_timeout"));
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(new Error("decision_aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(key, {
        type,
        resolve: (msg) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(msg);
        },
      });
    }).finally(() => this.pending.delete(key));
  }

  deregister(actionId: string, type: "decision" | "answer") { this.pending.delete(`${type}:${actionId}`); }
  async close() { await this.sub.drain(); }
}
```

- `HitlController` calls `dispatcher.register({ actionId, type: "decision", timeoutMs, signal })` and awaits.
- `QuestionController` calls `dispatcher.register({ actionId, type: "answer", timeoutMs, signal })` and awaits.
- One subscription, one message loop, no race. `actionId` + `type` jointly key the dispatch.
- Timeout, abort, and engine close must remove pending entries to avoid leaking unresolved promises.

Both controllers receive the dispatcher via constructor injection from the engine setup (created once per session).

**Summary**: HITL approval and ask_user_question share the same NATS subject. A unified `DecisionDispatcher` dispatches messages keyed by the `(actionId, type)` tuple to avoid concurrency races.

---

### 5.9 `ask_user_question`

#### Motivation

HITL approval (§5.8) is **reactive** — Brain pauses on a tool the agent already decided to run. `ask_user_question` is **proactive** — the agent realizes it needs a decision (e.g. "Redis or Postgres?", "Which auth strategy?") and explicitly asks before committing to an architecture. This mirrors the intent of Claude Code's public `AskUserQuestion` tool.

#### Schema (modeled on the public `AskUserQuestion` tool, simplified)

```json
{
  "name": "ask_user_question",
  "description": "Ask the user a multiple-choice question and wait for their answer. Use sparingly when a design decision genuinely requires user input (e.g. trade-off between approaches, library choice). Do NOT use for trivial confirmations — those go through the standard HITL approval flow.",
  "input_schema": {
    "type": "object",
    "properties": {
      "questions": {
        "type": "array",
        "minItems": 1,
        "maxItems": 4,
        "items": {
          "type": "object",
          "properties": {
            "id":            { "type": "string", "description": "Unique question id (used to key the answer)" },
            "question":      { "type": "string", "description": "Full question, ends with '?'" },
            "header":        { "type": "string", "description": "Short tag shown as chip (≤ 12 chars)" },
            "options": {
              "type": "array",
              "minItems": 2,
              "maxItems": 4,
              "items": {
                "type": "object",
                "properties": {
                  "id":          { "type": "string" },
                  "label":       { "type": "string", "description": "1-5 word display text" },
                  "description": { "type": "string", "description": "What this choice means" }
                },
                "required": ["id", "label"]
              }
            },
            "multiSelect":   { "type": "boolean", "default": false }
          },
          "required": ["id", "question", "options"]
        }
      }
    },
    "required": ["questions"]
  }
}
```

#### Input Validation

Before suspending on NATS, the engine loop validates:

- All `questions[].id` values must be **unique**.
- All `questions[].question` texts must be **unique** (no duplicate questions).
- Within each question, all `options[].id` values must be **unique**.
- Within each question, all `options[].label` values must be **unique**.
- Violation returns tool error: `"Question ids/texts must be unique, option ids/labels must be unique within each question"`.

#### Routing

In `BRAIN_LOCAL_TOOLS` / `LOOP_INTERCEPTED_TOOLS` (§4.5) — handled by engine loop, not `router.route()`. Suspends the agent loop via `QuestionController.ask()`, which registers with the shared `DecisionDispatcher` (§5.8) on the `decision.<sessionId>` NATS subject using `type="answer"`. Frontend renders a question dialog (not approval dialog) based on the `userQuestion` event type.

#### Event Protocol

```ts
// Brain → API → SSE  (question side)
{
  type: "userQuestion",
  actionId: <tool_use_id>,
  questions: [ { id, question, header, options, multiSelect } ],
  timeout_ms: 600000,                      // 10 min; longer than HITL approval
  ts: <epoch_ms>
}

// API → Brain  (answer side, posted to /v1/chat/sessions/:id/answers)
// Body:
{ "actionId": "...",
  "answers": { "<question_id>": ["<option_id_1>", "<option_id_2>"] },
  "skipped": ["<question_id_skipped>"] }
// Brain receives via NATS `decision.<sessionId>` subject (envelope distinguishes
// type=decision vs type=answer; existing endpoint extended to dispatch).

// Brain → API → SSE  (resolution side)
{
  type: "questionAnswer",
  actionId: <tool_use_id>,
  answers: { <question_id>: [<selected_option_id>, ...] },
  ts: <epoch_ms>
}
```

#### Tool Result Format

```
User answered:
  Q[storage]: "Which database for the cache layer?"
    → Redis  (chosen for low-latency reads)
  Q[auth]: "Which auth strategy?"
    → JWT, OAuth2  (multi-select)

You can now continue with the user's answers in mind.
```

#### Answer Validation

The `/answers` endpoint can only validate request shape and session ownership before publishing to NATS. It does **not** know the pending question schema unless API persists `userQuestion` payloads. Semantic answer validation therefore happens in Brain's `QuestionController`, which still has the original pending `questions` array:

- every answer key must match an existing `questions[].id`;
- every selected option id must exist in that question's `options[].id`;
- when `multiSelect=false`, the answer array must contain exactly one option id;
- when `multiSelect=true`, the answer array must contain at least one option id and no duplicates;
- missing answers are rejected unless the request's `skipped` array includes that question id;
- `skipped` is optional (defaults to `[]`); a question id may appear in `skipped` OR have an entry in `answers`, never both;
- when a question is in `skipped`, the Brain tool result shows `"Q[<id>]: skipped by user"` for that question.

Invalid body shape returns HTTP 400 and is **not** published to `decision.<sessionId>`. Semantically invalid answers published by a stale/buggy client are rejected by Brain and converted into a tool error: `Error: invalid answer payload — <reason>`.

#### Behavior on Timeout / Skip

- 10-minute timeout: tool result becomes `Error: user did not answer within 600s. Proceed with your best judgment, default to the first option for each question, OR re-ask later.` (Decision-driven; alternative would be to abort the loop — opted against because long-running benchmarks shouldn't die on a missed answer.)
- User explicitly skips: `Error: user declined to answer. Proceed with your best judgment.`

#### API Endpoint Reuse

Extend `packages/api/src/routes/admin.ts`'s existing `/decisions` endpoint to accept either body shape, OR add a parallel `/answers` endpoint. The latter is cleaner — recommended.

```ts
app.post<{ Params: { id: string } }>("/v1/chat/sessions/:id/answers", { preHandler: authMiddleware }, async (req, reply) => {
  const sessionId = req.params.id;
  const userId = req.user.id;

  // Same owner/admin check as /decisions (see §5.8 API Security Requirements)
  const session = await db.query(
    "SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
    [sessionId],
  );
  if (!session) return reply.code(404).send({ error: "session_not_found" });
  if (session.user_id && session.user_id !== userId && !isAdmin(req.user)) {
    return reply.code(403).send({ error: "forbidden" });
  }

  const { actionId, answers, skipped } = req.body;
  // Shape validation only: actionId string, answers object, skipped string[].
  // Semantic validation against option ids happens in Brain's QuestionController.
  nc.publish(`decision.${sessionId}`, sc.encode(JSON.stringify({
    type: "answer",
    session_id: sessionId,
    user_id: userId,
    action_id: actionId,
    answers,
    skipped: skipped ?? [],
  })));
  return { ok: true, session_id: sessionId, action_id: actionId };
});
```

Brain's `DecisionDispatcher` (§5.8) discriminates on `(actionId, type)` to route to the correct pending Map.

#### Prompt Guidance

```
You have access to ask_user_question when you face a genuine design decision with
meaningful trade-offs (e.g. "Redis vs Postgres for caching?", "REST vs GraphQL?").
Do NOT use it for trivial yes/no confirmations — those happen automatically via HITL.
Limit to 1-4 questions at a time, each with 2-4 concrete options.
```

---

## 6. Hands-side Changes

### 6.1 Background Shell Manager

`packages/hands/src/tools/shell/bash.ts` needs a per-process registry:

```ts
interface BgShell {
  pid: number;
  child: ChildProcess;
  kind: "background" | "monitor";  // "monitor" shells are skipped by stall watchdog
  stdoutBuf: Buffer[];      // ring buffer chunks, 1 MB cap total; string concat per-write is O(n)
  stderrBuf: Buffer[];
  stdoutOffset: number;     // bytes already returned by bash_output
  stderrOffset: number;
  stdoutDroppedBytes: number; // absolute bytes removed from stdoutBuf after overflow
  stderrDroppedBytes: number;
  truncated: boolean;
  startedAt: number;
  exitCode: number | null;
  exitedAt: number | null;
  lastGrowthAt: number;     // for stall watchdog
  notified: boolean;        // latch for one-shot stall notification
  description: string;      // command summary for notifications
}

const shells = new Map<string, BgShell>();
```

- Set `BgShell.kind = input.background_kind ?? "background"`; only `"monitor"` skips stall notifications.
- Spawn via `child_process.spawn("bash", ["-lc", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true })`. `detached: true` gives the shell its own process group so `process.kill(-pid, signal)` can terminate the whole tree without adding a `tree-kill` dependency.
- Stream stdout/stderr into ring buffers (drop oldest on overflow, mark `truncated=true`).
- Each write updates `lastGrowthAt` so the stall watchdog knows the shell is alive.
- `bash_output(shell_id)` returns the slice `[stdoutOffset, end]` and advances the offset.
- `kill_shell(shell_id)` sends `SIGTERM` first; if the process group is still alive after 5 s, sends `SIGKILL`. Use `process.kill(-pid, signal)` against the detached process group to kill the entire **process tree**, not just the shell process itself — child processes spawned by the command must also die.

  > **Note on signal handling**: V2 gives the process a 5-second grace window for cleanup (writing partial results, closing files). If experience shows shells ignore `SIGTERM`, switch to immediate `SIGKILL`.

- **Buffer overflow behavior**: when total `stdoutBuf` chunks exceed `BG_SHELL_BUFFER_BYTES` (default 1 MB), the oldest chunks are dropped and a `truncated` flag is set on the `BgShell` entry. `bash_output` prepends `[Output truncated — oldest N bytes dropped]` to the returned slice so the LLM knows context is missing.
- Shells outliving the sandbox are cleaned by Hands shutdown handler (best-effort `SIGKILL` to each detached process group).
- Shells are filed under two names: the owner (`x-claw-owner`, the DAG root for a DAG node and otherwise the session) decides who may poll or kill them, and the run (`x-claw-run`, the task id) records which single execution started them. A finished DAG node ends its own shells — Brain posts `/internal/shells/reap` on its terminal paths — because nothing will poll a completed node's dev server and it keeps consuming the shared sandbox's CPU. A chat turn does not: the user is still there, and polling in a later turn is the point. An interrupted run (SIGTERM, lost lease, retryable failure) keeps its shells, since the pod that resumes it lands in the same sandbox.
- Limit: max 16 concurrent BG shells per Hands process; over-limit returns `Error: too many background shells, kill some first`.

#### Hands `sessionId` Propagation

Hands must know the `sessionId` to publish notifications to `task_notification.<sessionId>`. Decision: use **MCP metadata injection**. Brain passes `sessionId` as metadata when establishing the MCP connection to Hands. Hands stores it process-wide (one Hands = one session), which matches the current sandbox lifecycle because Brain creates one Hands sandbox per session. Do not add `_session_id` to tool inputs; hidden tool parameters would pollute schema validation and are easy to leak into model-visible prompts.

### 6.2 Stall Watchdog & Task Notifications

A single `setInterval(checkAllShells, 5000)` per Hands process iterates `shells.values()`:

```ts
const STALL_THRESHOLD_MS = 45_000;
const STALL_TAIL_BYTES = 1024;
const PROMPT_PATTERNS: RegExp[] = [
  /\(y\/n\)/i, /\[y\/n\]/i, /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\?\s*$/i,
  /Press (any key|Enter)/i, /Continue\?/i, /Overwrite\?/i,
];

function looksLikePrompt(tail: string): boolean {
  const lastLine = tail.trimEnd().split("\n").pop() ?? "";
  return PROMPT_PATTERNS.some(p => p.test(lastLine));
}
```

- **Skip shells with `kind === "monitor"`**: monitoring shells (e.g. `tail -f`, log watchers) are expected to be long-running with intermittent output; the stall watchdog does not apply to them. Only shells with `kind === "background"` (default) are checked.
- For each running `background` shell where `Date.now() - lastGrowthAt >= STALL_THRESHOLD_MS` and `notified === false`:
  - Read tail (last 1 KB of `stdoutBuf`).
  - If `looksLikePrompt(tail)`: latch `notified=true`, publish a `<task_notification>` event to `task_notification.<sessionId>` via NATS.
  - Else: keep watching (reset growth window so we re-check 45 s later).
- On exit/kill: push the completion notification (see §5.4).

#### Hands → Brain Notification Channel

Do **not** rely on a reverse Hands → Brain MCP call. The current Brain → Hands MCP client path is request/response oriented, and a reverse callback would add lifecycle complexity. Use the existing event infrastructure instead:

- Hands publishes task notifications to `task_notification.<sessionId>` over NATS.
- Brain subscribes when the engine starts and appends messages to `agentLoop.pendingNotifications: string[]`.
- At the start of each turn, the loop drains the queue and prepends notifications as `user` messages.
- On engine shutdown, Brain unsubscribes; stale notifications are safe to drop because background shell state is not persisted across Brain restarts.

> This bypasses the LLM-tool-call protocol entirely — notifications are out-of-band events injected into context, but transported over NATS rather than reverse MCP.

#### Shell Lost Notification (P6 decision)

Background shell state is not persisted across Brain/Hands restarts. To avoid silent confusion after sandbox rebuilds:

1. Brain tracks active background shell ids from successful `bash(run_in_background=true)` results and removes them on `kill_shell` or completion notifications.
2. When `sandbox-keepalive.ts` rebuilds or reattaches a Hands sandbox, Brain emits one synthetic notification per active shell and clears the active-shell set:

   ```xml
   <task_notification>
   <task_id>bg-shell-abc123</task_id>
   <status>shell_lost</status>
   <summary>Background shell bg-shell-abc123 was lost because the sandbox was rebuilt</summary>
   </task_notification>
   ```

3. `bash_output(shell_id)` for an unknown shell returns:

   ```
   Error: shell <shell_id> not found (possibly lost after sandbox rebuild)
   ```

4. The LLM should treat `shell_lost` as a retry signal: restart the command if it is still needed, preferably with checkpoint/output paths so progress is recoverable.

### 6.3 Read Tool — Notebook Formatting

Extend `packages/hands/src/tools/fs/read.ts`:

```ts
export const readTool = {
  name: "read",
  schema: z.object({
    path: z.string(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
    notebook_cell_index: z.number().int().nonnegative().optional(),  // + new
  }),
  async execute(input) {
    const safePath = ensurePathInWorkspace(input.path);

    // .ipynb dispatch (no separate tool)
    if (safePath.endsWith(".ipynb")) {
      const nb = JSON.parse(await fs.readFile(safePath, "utf-8"));
      return formatNotebook(nb, input.notebook_cell_index);
    }

    // ... existing logic
  },
};
```

`formatNotebook` follows the output spec in §5.6. No new dependency: parse with `JSON.parse`.

### 6.4 Dependencies

- Background shell uses `node:child_process` (already used).
- Stall watchdog uses `setInterval` (no extra lib).
- Notebook read uses `JSON.parse` (no `nbformat` dependency needed for read-only).
- Path safety reuses existing `runtime/path-guard.ts`.
- Task notifications require Hands to publish to NATS, so P3 adds `nats` to `packages/hands/package.json` and reuses the existing `NATS_URL`, `NATS_USER`, and `NATS_PASSWORD` env vars. Do not introduce Redis-specific code unless the rest of the deployment already routes events through Redis.

---

## 7. Configuration & Feature Flags

All new behavior is gated by env vars so deployments can opt in:

| Env var | Default | Effect |
|---|---|---|
| `WEB_SEARCH_PROVIDER` | `"disabled"` | `anthropic` / `tavily` / `brave` / `serper` / `disabled`; recommended for Claude deployments: `anthropic` |
| `WEB_SEARCH_FALLBACK` | `""` | Comma-separated providers to try if primary fails |
| `WEB_SEARCH_MAX_USES` | `8` | Anthropic native: `max_uses` field; 3rd-party: max calls per loop turn |
| `TAVILY_API_KEY` / `BRAVE_API_KEY` / `SERPER_API_KEY` | unset | Required for the matching provider |
| `WEB_SEARCH_MODEL` | `""` | Override model for Anthropic sub-LLM wrapper (e.g. `claude-3-5-haiku-latest`); empty = use main model |
| `WEB_SEARCH_FORCE_TOOL` | `true` | When true, sub-LLM call uses `tool_choice: { type: "tool" }` to force search; when false, model decides |
| `WEB_SEARCH_DOMAIN_DENYLIST` | `""` | CSV; hits matching are dropped (also passed as `blocked_domains` to Anthropic) |
| `WEB_FETCH_ENABLED` | `false` | Master switch for `web_fetch`; keep false until egress policy is reviewed |
| `WEB_FETCH_MAX_BYTES` | `10485760` | Hard ceiling (10 MiB) regardless of `max_bytes` arg |
| `WEB_FETCH_MAX_OUTPUT_CHARS` | `50000` | Hard cap on returned tool result text |
| `WEB_FETCH_DOMAIN_DENYLIST` | `""` | CSV; URLs matching return error |
| `WEB_FETCH_TIMEOUT_MS` | `60000` | Per-hop request timeout |
| `WEB_FETCH_SUMMARIZE` | `true` | When true AND `prompt` is set, run Haiku/small-model summarization |
| `WEB_FETCH_SUMMARIZE_MODEL` | `"claude-3-5-haiku-latest"` | Override for summarization model |
| `WEB_FETCH_CACHE_TTL_MS` | `900000` | LRU cache TTL (15 min default) |
| `WEB_FETCH_CACHE_MAX_BYTES` | `52428800` | LRU cache size cap (50 MB default) |
| `WEB_FETCH_BINARY_ENABLED` | `false` | P6: persist supported binary responses to Hands workspace artifacts |
| `WEB_FETCH_BINARY_DIR` | `"/workspace/.claw/webfetch"` | P6: fixed artifact directory for binary web_fetch output |
| `WEB_FETCH_BINARY_ALLOWLIST` | `"application/pdf"` | P6: comma-separated binary content-types allowed for persistence |
| `TODO_WRITE_ENABLED` | `true` | Disables the tool; useful for benchmarking without it |
| `BG_SHELL_ENABLED` | `false` | Master switch for `bash(run_in_background)`, `bash_output`, `kill_shell` |
| `BG_SHELL_MAX_CONCURRENT` | `16` | Per-Hands |
| `BG_SHELL_BUFFER_BYTES` | `1048576` | Ring buffer per shell |
| `BG_SHELL_STALL_THRESHOLD_MS` | `45000` | Stall watchdog: no-output window before checking for prompt |
| `BG_SHELL_STALL_CHECK_INTERVAL_MS` | `5000` | Watchdog tick interval |
| `EXIT_PLAN_MODE_ENABLED` | `true` | When false, plan mode never engages |
| `HITL_ENABLED` | `false` | Master switch for permissionRequest emission |
| `HITL_AUTO_ALLOW` | `"read,glob,grep,ls,todo_write,web_search,save_memory"` | CSV (note: `notebook_read` removed since merged into `read`) |
| `HITL_DECISION_TIMEOUT_MS` | `300000` | |
| `HITL_DECISION_DEFAULT` | `"allow"` | `"allow"` or `"deny"` on timeout |
| `ASK_USER_QUESTION_ENABLED` | `false` | Master switch; keep off until P5 backend + frontend are both deployed |
| `ASK_USER_QUESTION_TIMEOUT_MS` | `600000` | 10 min wait before timeout |

Default posture: **HITL off, BG shell off, web tools off until provider configured, ask_user_question off, todo/exit_plan on.** Notebook reading is always available via `read`. This keeps existing deployments behaving identically until they opt in.

#### Schema Exposure Rules

Feature flags must affect **schema exposure**, not only runtime execution:

- If `WEB_SEARCH_PROVIDER="disabled"`, omit `web_search` from `getToolSchemas()`; if a stale model call still reaches the router, return `Error: web search disabled`.
- If `WEB_FETCH_ENABLED=false`, omit `web_fetch`; stale calls return `Error: web fetch disabled`.
- If `WEB_FETCH_BINARY_ENABLED=false`, keep `web_fetch` visible but binary content returns unsupported-content errors.
- If `TODO_WRITE_ENABLED=false`, omit `todo_write`; stale loop-intercepted calls return `Error: todo_write disabled`.
- If `BG_SHELL_ENABLED=false`, omit `bash_output` and `kill_shell`, and remove `run_in_background` / `shell_id` / `background_kind` from the `bash` schema. Stale calls return a disabled-feature error.
- If `EXIT_PLAN_MODE_ENABLED=false`, ignore `request.plan_mode` and omit `exit_plan_mode`.
- If `ASK_USER_QUESTION_ENABLED=false`, omit `ask_user_question`; stale calls return `Error: ask_user_question disabled`.

This prevents the model from repeatedly calling unavailable tools and keeps disabled deployments prompt-compatible with today's behavior.

---

## 8. Backward Compatibility

| Concern | Resolution |
|---|---|
| Existing tasks calling old tool names (e.g. `Bash`) | Already case-mapped in router via lowercase; no impact. |
| Plugin `hooks.json` referencing `PreToolUse` | Unchanged — plugin hooks run before HITL. If they edit input, the user approves the edited/final input. |
| `inference-optimization` skill referencing `TodoWrite` | We expose **lowercase** `todo_write` to match the V2 naming convention. The skill text has to be patched **or** the router accepts both `todo_write` and `TodoWrite` as aliases. **Decision: alias both names** to avoid skill churn. |
| Frontend rendering `permissionRequest` | API SSE event payload is identical to V1 down to field names → frontend lifts unchanged once the Brain emits them. |
| `ExecuteRequest` schema | All new fields (`plan_mode`, `plan_mode_requires_approval`) are optional with sane defaults. No breaking change. |
| `ExecuteResult` schema | Adds optional `pendingPlan?: string` (last `exit_plan_mode` content) for audit. Optional → no break. |
| Codex / Pi engines | Pi shares `agent/agent-loop.ts`; Codex has its own OpenAI loop and needs explicit P2/P4/P5 integration. |
| Sub-agents | `runSubagent` builds a fresh ToolRouter; new tools propagate automatically. |

---

## 9. Implementation Phases

| Phase | Scope | Files touched |
|---|---|---|
| **P0** | `web_search` (Anthropic sub-LLM wrapper + Tavily backend) and `web_fetch` (with optional Haiku summarization). Main agent loop continues to see `web_search` as a normal client-side tool; Anthropic server-side blocks stay inside `WebSearchService`. Codex/Pi use third-party search only. | `tools/router.ts` (add `BRAIN_NETWORK_TOOLS` dispatch + `networkTool()`), new `packages/brain/src/tools/web/{search.ts,fetch.ts,summarize.ts,providers/*.ts}`, `config.ts`, `packages/brain/package.json`, lockfile |
| **P1** | `todo_write` (with `id`/`merge` fields, §5.3) + `read`-tool notebook handling. Both unblock `inference-optimization` skill. | `agent/agent-loop.ts` (add `todo_write` intercept + `todoState`/`mergeTodos`), `engines/codex.ts` (same intercept), `tools/router.ts` (add `todo_write` schema with `id`/`merge` to `getToolSchemas()`, add `LOOP_INTERCEPTED_TOOLS` guard), `packages/hands/src/tools/fs/read.ts` (.ipynb branch + `formatNotebook`), `packages/hands/src/tools/index.ts` (export `formatNotebook`), `packages/brain/src/tools/index.ts` (schema registry) |
| **P2** | HITL approval channel wired to existing `decision.<sessionId>` NATS subject, with `DecisionDispatcher` (§5.8), independent `HitlController`, plugin `PreToolUse.updatedInput` support, `edited_input` support, and API owner/admin checks. | `agent/agent-loop.ts`, `engines/codex.ts`, `agent/hooks.ts` (`HookDecision.updatedInput`), new `packages/brain/src/delivery/decision-dispatcher.ts`, new `packages/brain/src/agent/hitl.ts`, `packages/api/src/routes/admin.ts`, `config.ts`, end-to-end test in `packages/api/test/decisions.spec.ts` |
| **P3** | Background shell (`bash` extension + `bash_output` + `kill_shell`) **including stall watchdog and task notification injection**. Highest-risk because Hands lifecycle changes. | `packages/hands/src/tools/shell/bash.ts`, new `packages/hands/src/tools/shell/bg-manager.ts`, new `packages/hands/src/tools/shell/bg-watchdog.ts`, `packages/hands/package.json` (`nats` dependency), NATS `task_notification.<sessionId>` publisher/subscriber, `agent/agent-loop.ts` (`pendingNotifications` queue), `tools/router.ts` schema additions |
| **P4** | `exit_plan_mode` and remaining wiring. | `agent/agent-loop.ts` (planMode state), `engines/codex.ts` (schema filter + tool result), `tools/router.ts` (schema filter), `engines/claude.ts` / `engines/pi.ts` / `engines/codex.ts` (request.plan_mode hookup) |
| **P5** | `ask_user_question` (reuses NATS plumbing from P2, default feature flag off until frontend is deployed). | new `packages/brain/src/ask-user.ts`, `tools/router.ts`, `agent/agent-loop.ts`, `engines/codex.ts`, new endpoint `POST /v1/chat/sessions/:id/answers` in `packages/api/src/routes/admin.ts`, frontend SSE renderer |
| **P6** | Enhancement closure: JS-rendered page MCP guidance, binary `web_fetch` persistence to Hands workspace, BG shell `shell_lost` notifications, and final HITL remember scope. | `packages/brain/src/tools/web/fetch.ts` (`JS_RENDER_REQUIRED`, binary writer), `ToolRouter`/engine setup (`WebFetchBinaryWriter` injection), `packages/hands/src/tools/webfetch-artifact.ts` or equivalent internal writer, `agent/agent-loop.ts` active BG shell tracking + `shell_lost` injection, `sandbox-keepalive.ts` rebuild hook |

Each phase is independently shippable, gated by its env flag from §7. CI must add at least one e2e test per phase (mock provider for web tools, real Hands for BG shell).

**Note on P3 scope**: Per the decision (`bash_advanced=phase1`), the stall watchdog and task notification injection ship in P3 — not deferred to a P3.5. This adds ~50% complexity to P3 but delivers the full behavior on day one.

---

## 10. Enhancement Decisions

All previously open enhancement questions are resolved:

1. **JS-rendered pages**: do not embed Playwright/headless Chrome into Brain or Hands. `web_fetch` remains static HTTP fetch; rendered-page support belongs to an external browser/Playwright MCP. `web_fetch` may emit `JS_RENDER_REQUIRED` guidance when it detects a JS shell.
2. **HITL remember scope**: keep `always_allow` session-scoped and in-memory only. Do not persist end-user remember decisions across sessions.
3. **Background shell loss**: implement `shell_lost` task notifications when sandbox rebuilds invalidate active background shell ids. Unknown-shell `bash_output` still returns a clear error.
4. **Binary web_fetch**: add opt-in Hands workspace artifact persistence under `/workspace/.claw/webfetch`; do not use S3 for this path in P6.

---

## Appendix A: Reference Index

Behavior-parity targets. The Claude Code column names the **public tool surface** (tool names and schemas as exposed to users); it is not a reference to Claude Code source code.

| V2 tool | V1 behavior reference | Public Claude Code tool |
|---|---|---|
| `web_search` | V1 Claude engine (SDK injection) | `WebSearch` — server-side search wrapped as a client-side tool |
| `web_fetch` | V1 Claude engine (SDK injection) | `WebFetch` — including optional summarization |
| `todo_write` | V1 `buildTodoWriteTool` | `TodoWrite` |
| `bash_output` / `kill_shell` | Claude Agent SDK built-ins (no V1 source) | background shell output / kill, with foreground-background switching |
| Stall watchdog + task notification | None | no public equivalent — V2 addition |
| `read` notebook handling | None | generic file read handles `.ipynb` inline |
| `exit_plan_mode` | Claude Agent SDK built-in | `ExitPlanMode` |
| `ask_user_question` | None | `AskUserQuestion` |
| HITL flow | V1 `HumanInTheLoop` and its HITL API docs | the permission model's `ask` behavior |

## Appendix B: Tool Coverage Matrix After Implementation

> Codex/Pi columns are historical (both engines have since been removed; Brain is Claude-only). Kept for reference on original per-engine design intent.

| Tool | Engine: Claude | Engine: Codex | Engine: Pi |
|---|:---:|:---:|:---:|
| bash / write / edit / multi_edit / glob / grep / ls / notebook_edit | ✅ | ✅ | ✅ |
| **read (incl. .ipynb)** | ✅ | ✅ | ✅ |
| **bash_output / kill_shell + stall watchdog** | ✅ (with `BG_SHELL_ENABLED`) | ✅ | ✅ |
| save_memory / save_skill / *_skill_file | ✅ | ✅ | ✅ |
| **todo_write** | ✅ | ✅ | ✅ |
| **exit_plan_mode** | ✅ | ✅ | ✅ |
| **web_search** | ✅ (Anthropic sub-LLM wrapper) | ✅ (3rd party) | ✅ (3rd party) |
| **web_fetch (+ optional Haiku summarize)** | ✅ | ✅ (uses gpt-4o-mini for summarize) | ✅ (raw only — no summarize) |
| **ask_user_question** | ✅ (with `ASK_USER_QUESTION_ENABLED`) | ✅ | ✅ |
| task (sub-agent) | ✅ | ❌ (no agentLoop) | ✅ |
| a2a_call | ✅ | ✅ | ✅ |
| mcp__&lt;server&gt;__&lt;tool&gt; | ✅ | ✅ | ❌ (Pi skips MCP) |
| **HITL approval** | ✅ (with `HITL_ENABLED`) | ✅ | ✅ |
