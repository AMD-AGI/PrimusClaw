// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { HandsClient } from "../clients/hands.js";
import { isSandboxTool, toolTimeoutCeilingSec } from "./hands.js";
import { handleA2ACall } from "../clients/a2a.js";
import { callBackendMcpTool } from "../clients/backend-mcp.js";
import { getPluginToolScope } from "./scope.js";
import type { ToolSchema, PendingMemory, PendingSkill, PendingSkillFileMutation } from "@claw/protocol";
import {
  WEB_SEARCH_PROVIDER, WEB_FETCH_ENABLED, TODO_WRITE_ENABLED, BG_SHELL_ENABLED,
  EXIT_PLAN_MODE_ENABLED, ASK_USER_QUESTION_ENABLED,
  BASH_FOREGROUND_DEFAULT_SEC, WAIT_DEFAULT_SEC,
} from "../config.js";
import type { WebSearchService } from "./web/search.js";
import type { WebFetchService } from "./web/fetch.js";

/**
 * The bash timeout ceiling the schema states.
 *
 * Read from where the deadline is built rather than from the sandbox's own
 * limit, because those are two numbers and the schema is the one the model
 * plans against: told the larger, it plans a command the smaller stops, and the
 * timeout message it then gets names a ceiling the schema never mentioned.
 */
const BASH_TIMEOUT_CEILING_SEC = toolTimeoutCeilingSec("bash");

/** The same, for the tool whose whole purpose is to wait longer than bash may. */
const WAIT_TIMEOUT_CEILING_SEC = toolTimeoutCeilingSec("wait");

/** Sub-file path validation (matches API skill-service.validateSubFilePath). */
const ALLOWED_SUB_DIRS = ["references", "templates", "scripts", "assets"];
function validateSubFilePath(filePath: string): string | null {
  if (!filePath || typeof filePath !== "string") return "file_path required";
  if (filePath.startsWith("/")) return "absolute paths not allowed";
  if (filePath.includes("..")) return "path traversal '..' not allowed";
  const head = filePath.split("/")[0];
  if (!ALLOWED_SUB_DIRS.includes(head)) {
    return `path must start with one of: ${ALLOWED_SUB_DIRS.join("/, ")}/`;
  }
  if (filePath.split("/").length < 2 || filePath.endsWith("/")) {
    return "must be a file path under the directory";
  }
  return null;
}

const BRAIN_NETWORK_TOOLS = new Set(["web_search", "web_fetch"]);

const BG_SHELL_TOOLS = new Set(["bash_output", "kill_shell", "wait"]);

/**
 * Whether a call would use the background-shell feature.
 *
 * `BG_SHELL_ENABLED` only ever removed fields and tools from the schemas handed
 * to the model, which is not the same as turning the feature off: `route()`
 * forwarded whatever name it was given, and a resumed conversation whose
 * transcript already contains a `bash_output` call, a sub-agent, or a plugin
 * would sail straight through to a Hands that happily ran it.
 */
export function isBackgroundShellCall(name: string, input: Record<string, unknown>): boolean {
  if (BG_SHELL_TOOLS.has(name)) return true;
  return name === "bash" && input.run_in_background === true;
}

const BG_SHELL_DISABLED_MESSAGE =
  "Error: background shells are disabled in this deployment. "
  + "Run the command in the foreground with an appropriate bash timeout instead.";

/**
 * Tools handled by the engine loop BEFORE calling router.route().
 * They need loop state mutation, custom onEvent payloads, or NATS suspension.
 */
const LOOP_INTERCEPTED_TOOLS = new Set([
  "todo_write",
  "exit_plan_mode",
  "ask_user_question",
]);

export interface WebToolServices {
  webSearch?: WebSearchService;
  webFetch?: WebFetchService;
}

/**
 * Same threat patterns as API's scanMemoryContent — duplicated here so the
 * save_memory / save_skill tools can give Agent immediate accurate feedback
 * (instead of "saved" optimistically followed by silent server-side rejection).
 */
const THREAT_PATTERNS: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { pattern: /you\s+are\s+now\s+/i, id: "role_hijack" },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: "deception" },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules)/i, id: "disregard" },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD)/i, id: "exfil" },
];

function scanContent(content: string, maxLength: number): string | null {
  for (const { pattern, id } of THREAT_PATTERNS) {
    if (pattern.test(content)) return `threat pattern '${id}'`;
  }
  if (content.length > maxLength) return `content too long (max ${maxLength} chars)`;
  return null;
}

/**
 * Routes tool calls to the correct backend:
 * - Hands tools → Hands MCP Server (sandbox)
 * - Platform MCP tools (mcp__server__tool) → remote MCP servers (Brain-side)
 * - save_memory / save_skill → local pending buffers (flushed via exec_complete)
 *
 * Feature-flag contract (intentional design): save_memory / save_skill /
 * *_skill_file schemas stay exposed here regardless of API-side flag state
 * (CLAW_MEMORY_ENABLED / CLAW_SKILL_EVOLUTION_ENABLED) — the API silently
 * discards the exec_complete payload when a flag is OFF, so brain stays
 * stateless w.r.t. flags at the cost of an optimistic "saved" reply that
 * never reaches the DB.
 */
export class ToolRouter {
  readonly pendingMemories: PendingMemory[] = [];
  readonly pendingSkills: PendingSkill[] = [];
  readonly pendingSkillFileMutations: PendingSkillFileMutation[] = [];
  /**
   * Skill names that the Agent actually read during this execution
   * (detected by intercepting bash cat / read tool calls targeting .skills/NAME/SKILL.md).
   * Used to populate skillsUsed accurately instead of "all loaded skills".
   */
  readonly skillsRead: Set<string> = new Set();
  /** Sub-routers spawned by this router (sub-agent path). When the parent's
   *  Hands sandbox is rebuilt mid-task, every child router is updated too so
   *  in-flight sub-agents transparently switch over to the new sandbox. */
  private readonly children: Set<ToolRouter> = new Set();

  private webServices: WebToolServices;

  private bearerToken: string;

  /**
   * Backend-side MCP connection (task-design.md §7.5). When provided, tool
   * calls whose `plugin_tools[*].config.scope === "backend"` are routed to
   * `${backendMcpUrl}` instead of Hands.
   */
  private backendMcp: { url: string; token: string } | null = null;
  /** Plugin tool array carried through ExecuteRequest; used to decide scope. */
  private pluginTools: unknown[] | null | undefined = undefined;

  /**
   * Opens the sandbox for a run that started without one. Set only on the root
   * router of a lazily-attached run; sub-agent routers inherit an already-open
   * client, since a sub-agent only exists once the parent has run a tool.
   */
  private attachHands?: () => Promise<HandsClient>;

  constructor(
    private hands: HandsClient | null,
    private platformMcp: Map<string, { callTool: (name: string, args: Record<string, unknown>) => Promise<string> }> = new Map(),
    webServices?: WebToolServices,
    bearerToken?: string,
    attachHands?: () => Promise<HandsClient>,
  ) {
    this.webServices = webServices ?? {};
    this.bearerToken = bearerToken || "";
    this.attachHands = attachHands;
  }

  /**
   * The sandbox, opening one first if this run deferred it. Every path that
   * reaches Hands goes through here, so a tool call is the thing that decides
   * a sandbox is needed — no caller has to remember to ask for one.
   */
  private async requireHands(): Promise<HandsClient> {
    if (this.hands) return this.hands;
    if (!this.attachHands) throw new Error("No sandbox is attached to this run");
    const hands = await this.attachHands();
    this.hands = hands;
    return hands;
  }

  /**
   * Configure Backend-side MCP routing for this task. Must be called by the
   * engine before any `route()` call that may target a `scope=backend` tool.
   * Pass `null` for `backendMcp` to disable backend routing entirely.
   */
  setTaskContext(opts: {
    backendMcp?: { url: string; token: string } | null;
    pluginTools?: unknown[] | null;
  }): void {
    this.backendMcp = opts.backendMcp ?? null;
    this.pluginTools = opts.pluginTools ?? undefined;
  }

  /** Parse a file path for `.skills/{name}/SKILL.md` and record the skill name. */
  private trackSkillRead(path: string): void {
    const m = path.match(/\.skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md/i);
    if (m) this.skillsRead.add(m[1]);
  }

  /** Replace the underlying Hands client (called after an in-flight sandbox
   *  rebuild). Cascades to all child routers so sub-agents pick it up too. */
  setHands(newHands: HandsClient): void {
    this.hands = newHands;
    for (const child of this.children) child.setHands(newHands);
  }

  /** Return the web tool services for sub-agent propagation. */
  getWebToolServices(): WebToolServices {
    return this.webServices;
  }

  /** Register a child router so subsequent setHands() cascades to it. */
  registerChild(child: ToolRouter): void {
    this.children.add(child);
  }

  /**
   * Unregister a child router when its sub-agent has finished.
   * Merges the child's skillsRead set into ours so feedback attribution
   * (Phase 3 selected ∩ used) sees skills that were only consulted inside
   * sub-agents. Without this merge, complex multi-skill tasks dispatched
   * via the `task` tool would silently lose all skill usage signal — and
   * those are exactly the tasks most worth learning from.
   * Works recursively for nested sub-agents (depth > 1) by induction:
   * grandchild merges into child on its own unregister, then child merges
   * up to parent here.
   */
  unregisterChild(child: ToolRouter): void {
    for (const name of child.skillsRead) {
      this.skillsRead.add(name);
    }
    this.children.delete(child);
  }

  /** Dispatch to Brain-hosted web tool services. */
  private async networkTool(name: string, input: Record<string, unknown>): Promise<string> {
    if (name === "web_search") {
      if (!this.webServices.webSearch) return "Error: web search disabled";
      return this.webServices.webSearch.execute(input);
    }
    if (name === "web_fetch") {
      if (!this.webServices.webFetch) return "Error: web fetch disabled";
      return this.webServices.webFetch.execute(input);
    }
    throw new Error(`Unknown network tool: ${name}`);
  }

  async route(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (LOOP_INTERCEPTED_TOOLS.has(name)) {
      throw new Error(`${name} must be handled by engine loop, not router`);
    }

    if (BRAIN_NETWORK_TOOLS.has(name)) return this.networkTool(name, input);

    // Backend-side MCP routing (task-design.md §7.5). When the tool's
    // plugin_tools row declares config.scope='backend' AND the engine wired
    // a backend MCP endpoint via setTaskContext(), forward the call there
    // instead of Hands. Anything else falls through to the existing
    // Hands / platform-MCP / a2a paths below.
    if (this.backendMcp && getPluginToolScope(name, this.pluginTools) === "backend") {
      const out = await callBackendMcpTool(
        this.backendMcp.url,
        this.backendMcp.token,
        name,
        input,
        { signal },
      );
      if (out.isError) {
        return out.error || out.text || `backend tool '${name}' reported isError`;
      }
      return out.text;
    }

    // save_memory / save_skill → validate immediately, buffer, flush via exec_complete.
    // Synchronous scan ensures Agent gets accurate feedback (not optimistic "saved").
    if (name === "save_memory") {
      const content = input.content as string || "";
      const blocked = scanContent(content, 2000);
      if (blocked) {
        return `Error: memory not saved — blocked by safety check (${blocked}).`;
      }
      this.pendingMemories.push({
        category: input.category as string,
        content,
        importance: (input.importance as number) ?? 0.7,
      });
      return "Memory saved. It will be available in future sessions.";
    }
    if (name === "save_skill") {
      const content = input.content as string || "";
      const skillName = input.skill_name as string || "";
      const blocked = scanContent(content, 5000);
      if (blocked) {
        return `Error: skill '${skillName}' not saved — blocked by safety check (${blocked}).`;
      }
      this.pendingSkills.push({
        skill_name: skillName,
        content,
        description: input.description as string,
      });
      return `Skill '${skillName}' saved. It will be used automatically in future tasks.`;
    }
    if (name === "add_skill_file") {
      const skillName = input.skill_name as string || "";
      const filePath = input.file_path as string || "";
      const content = input.content as string || "";
      const pathErr = validateSubFilePath(filePath);
      if (pathErr) return `Error: invalid file_path — ${pathErr}.`;
      const blocked = scanContent(content, 10 * 1024);
      if (blocked) return `Error: file content blocked by safety check (${blocked}).`;
      this.pendingSkillFileMutations.push({
        action: "add", skill_name: skillName, file_path: filePath, content, is_binary: !!input.is_binary,
      });
      return `File '${filePath}' queued to add to skill '${skillName}'.`;
    }
    if (name === "update_skill_file") {
      const skillName = input.skill_name as string || "";
      const filePath = input.file_path as string || "";
      const content = input.content as string || "";
      const pathErr = validateSubFilePath(filePath);
      if (pathErr) return `Error: invalid file_path — ${pathErr}.`;
      const blocked = scanContent(content, 10 * 1024);
      if (blocked) return `Error: file content blocked by safety check (${blocked}).`;
      this.pendingSkillFileMutations.push({
        action: "update", skill_name: skillName, file_path: filePath, content, is_binary: !!input.is_binary,
      });
      return `File '${filePath}' queued to update in skill '${skillName}'.`;
    }
    if (name === "remove_skill_file") {
      const skillName = input.skill_name as string || "";
      const filePath = input.file_path as string || "";
      const pathErr = validateSubFilePath(filePath);
      if (pathErr) return `Error: invalid file_path — ${pathErr}.`;
      this.pendingSkillFileMutations.push({
        action: "remove", skill_name: skillName, file_path: filePath,
      });
      return `File '${filePath}' queued to remove from skill '${skillName}'.`;
    }

    if (!BG_SHELL_ENABLED && isBackgroundShellCall(name, input)) {
      return BG_SHELL_DISABLED_MESSAGE;
    }

    if (isSandboxTool(name)) {
      // v3.5 #2: track skill reads ONLY after the tool call succeeded.
      // Doing it before led to false positives — when the agent ran
      //   `bash cat .skills/foo/SKILL.md`
      // and the file was missing (e.g. Pi/Codex don't materialize skills to disk),
      // the skill name still landed in skillsRead and polluted feedback / probation /
      // evolution stats with attribution to a skill that never actually loaded.
      const result = await (await this.requireHands()).callTool(name, input, signal);
      if (name === "bash" && typeof input.command === "string") {
        this.trackSkillRead(input.command);
      } else if ((name === "read" || name === "grep" || name === "glob") && typeof input.path === "string") {
        this.trackSkillRead(input.path);
      }
      return result;
    }

    if (name === "a2a_call") {
      return handleA2ACall(input, this.bearerToken);
    }

    if (name.startsWith("mcp__")) {
      const [, server, ...rest] = name.split("__");
      const client = this.platformMcp.get(server);
      if (!client) throw new Error(`Unknown MCP server: ${server}`);
      return client.callTool(rest.join("__"), input);
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Tool schemas matching Hands Zod definitions exactly.
   * Field names MUST match what Hands tools expect.
   */
  getToolSchemas(): ToolSchema[] {
    return [
      { name: "save_memory", description: "Save a durable fact to long-term memory for future sessions. Use when: (1) user explicitly asks to remember something, (2) you discover an important environment/project fact, (3) user corrects you and the correction is generally applicable. Do NOT save task progress or session-specific details. Write content in the same language the user uses.", input_schema: {
        type: "object", properties: {
          category: { type: "string", enum: ["preference", "correction", "env_fact", "tool_quirk", "pattern"], description: "Memory category" },
          content: { type: "string", description: "One concise sentence describing the fact, in the user's language" },
          importance: { type: "number", minimum: 0, maximum: 1, description: "Importance score 0-1 (default 0.7)" },
        }, required: ["category", "content"],
      }},
      { name: "save_skill", description: "Save the current approach as a reusable skill (the main SKILL.md). Use when: (1) user explicitly asks to save a workflow, (2) you completed a complex multi-step task with reusable value. To attach supporting scripts/templates/docs to this skill, follow up with add_skill_file. Write content and description in the user's language.", input_schema: {
        type: "object", properties: {
          skill_name: { type: "string", description: "Short kebab-case English slug, e.g. 'react-scaffold' (name is always English for consistency, content/description follow user language)" },
          description: { type: "string", description: "2-4 sentences: what the skill does, when to use it, when NOT to use it" },
          content: { type: "string", description: "Full SKILL.md text with ## Goal, ## Steps, ## Notes (max 5000 chars)" },
        }, required: ["skill_name", "content", "description"],
      }},
      { name: "add_skill_file", description: "Attach a supporting file to an existing skill (script, template, reference doc). Use after save_skill when the skill needs accompanying assets the Agent can later read or execute. file_path must start with one of: references/, templates/, scripts/, assets/", input_schema: {
        type: "object", properties: {
          skill_name: { type: "string", description: "Name of an existing skill" },
          file_path: { type: "string", description: "Relative path under the skill dir, e.g. 'scripts/deploy.sh' (whitelist: references/, templates/, scripts/, assets/)" },
          content: { type: "string", description: "File contents (max 10 KB)" },
          is_binary: { type: "boolean", description: "Set true if content is base64-encoded binary; default false" },
        }, required: ["skill_name", "file_path", "content"],
      }},
      { name: "update_skill_file", description: "Replace the content of an existing supporting file on a skill.", input_schema: {
        type: "object", properties: {
          skill_name: { type: "string" },
          file_path: { type: "string" },
          content: { type: "string", description: "New file contents (max 10 KB)" },
          is_binary: { type: "boolean" },
        }, required: ["skill_name", "file_path", "content"],
      }},
      { name: "remove_skill_file", description: "Remove a supporting file from a skill.", input_schema: {
        type: "object", properties: {
          skill_name: { type: "string" },
          file_path: { type: "string" },
        }, required: ["skill_name", "file_path"],
      }},
      { name: "bash", description: BG_SHELL_ENABLED
        ? "Execute a shell command in the workspace directory. Blocks until the command exits; if it hits the timeout the whole process group is killed and only the output so far comes back. For anything that may outlast the timeout — servers, training runs, long builds, watchers — pass run_in_background=true instead of raising the timeout, then call wait to block until it finishes."
        : "Execute a shell command in the workspace directory. Blocks until the command exits; if it hits the timeout the whole process group is killed and only the output so far comes back, so keep each command inside the timeout rather than raising it.",
        input_schema: {
        type: "object", properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout: { type: "number", description: BG_SHELL_ENABLED
            ? `Timeout in seconds (default ${BASH_FOREGROUND_DEFAULT_SEC}, capped at ${BASH_TIMEOUT_CEILING_SEC}): a higher value is reduced to the cap, so use run_in_background plus wait for anything longer instead of raising this.`
            : `Timeout in seconds (default ${BASH_FOREGROUND_DEFAULT_SEC}, capped at ${BASH_TIMEOUT_CEILING_SEC}): a higher value is reduced to the cap. There is no background mode in this deployment, so a long command needs a timeout to match.` },
          ...(BG_SHELL_ENABLED ? {
            run_in_background: { type: "boolean", description: "Return a shell_id immediately and keep the command running. Follow with wait to block until it finishes, or bash_output to look at it without waiting." },
            shell_id: { type: "string", description: "Name this shell instead of taking a generated id (advanced). Private to this conversation, so a plain name like 'server' is fine." },
            background_kind: { type: "string", enum: ["background", "monitor"], description: "Only with run_in_background=true. monitor shells skip stall-prompt notifications." },
          } : {}),
        }, required: ["command"],
      }},

      ...(BG_SHELL_ENABLED ? [
        { name: "bash_output", description: "Read output from a background shell started with bash(run_in_background=true). Returns only what the shell printed since your previous poll, plus the exit status once it has finished. Shells stay readable across turns of this conversation until the sandbox goes away.", input_schema: {
          type: "object", properties: {
            shell_id: { type: "string", description: "ID returned by bash(run_in_background=true)" },
            filter: { type: "string", description: "Optional regex; only matching lines are returned" },
          }, required: ["shell_id"],
        }} as ToolSchema,
        { name: "kill_shell", description: "Terminate a background shell started with bash(run_in_background=true). Sends SIGTERM to its whole process group, then SIGKILL after 5s. Use it as soon as a background shell is no longer needed; it keeps consuming the sandbox's CPU and memory until it is stopped or the sandbox is destroyed.", input_schema: {
          type: "object", properties: {
            shell_id: { type: "string", description: "ID returned by bash(run_in_background=true)" },
          }, required: ["shell_id"],
        }} as ToolSchema,
        { name: "wait", description: "Block until a background shell finishes and return its final output. This is how you run something longer than the bash timeout: start it with run_in_background=true, then wait. Prefer it to calling bash_output in a loop — each poll costs a turn, one wait costs one. If the wait times out the shell is still running and you can wait again.", input_schema: {
          type: "object", properties: {
            shell_id: { type: "string", description: "ID returned by bash(run_in_background=true)" },
            timeout_sec: { type: "number", description: `Give up waiting after this long and report it is still running (default ${WAIT_DEFAULT_SEC}, capped at ${WAIT_TIMEOUT_CEILING_SEC}): a higher value is reduced to the cap, and the shell keeps running either way, so wait again.` },
          }, required: ["shell_id"],
        }} as ToolSchema,
      ] : []),
      { name: "read", description: "Read file contents with optional line range. Automatically detects .ipynb and formats notebook cells.", input_schema: {
        type: "object", properties: {
          path: { type: "string", description: "File path relative to /workspace" },
          offset: { type: "number", description: "Start line (1-based)" },
          limit: { type: "number", description: "Number of lines to read" },
          notebook_cell_index: { type: "number", description: "For .ipynb files: return only this cell (0-based)" },
        }, required: ["path"],
      }},
      { name: "write", description: "Write or overwrite a file (creates parent dirs)", input_schema: {
        type: "object", properties: {
          path: { type: "string", description: "File path relative to /workspace" },
          contents: { type: "string", description: "Full file content" },
        }, required: ["path", "contents"],
      }},
      { name: "edit", description: "Replace a unique string in a file (old_string must match exactly once)", input_schema: {
        type: "object", properties: {
          path: { type: "string", description: "File path relative to /workspace" },
          old_string: { type: "string", description: "Exact text to find (must be unique)" },
          new_string: { type: "string", description: "Replacement text" },
        }, required: ["path", "old_string", "new_string"],
      }},
      { name: "glob", description: "Find files matching a glob pattern", input_schema: {
        type: "object", properties: {
          pattern: { type: "string", description: "Glob pattern (e.g. **/*.ts)" },
          directory: { type: "string", description: "Subdirectory to search in" },
        }, required: ["pattern"],
      }},
      { name: "grep", description: "Search file contents with a regex pattern", input_schema: {
        type: "object", properties: {
          pattern: { type: "string", description: "Regular expression pattern" },
          path: { type: "string", description: "File or directory to search" },
          context: { type: "number", description: "Lines of context around matches (default 2)" },
        }, required: ["pattern"],
      }},
      { name: "ls", description: "List directory contents with file types and sizes", input_schema: {
        type: "object", properties: {
          path: { type: "string", description: "Directory path (default /workspace)" },
        },
      }},
      { name: "notebook_edit", description: "Edit a Jupyter notebook cell by index", input_schema: {
        type: "object", properties: {
          path: { type: "string", description: "Path to .ipynb file" },
          cell_index: { type: "number", description: "Cell index (0-based)" },
          old_string: { type: "string", description: "Exact text to replace in cell (optional)" },
          new_string: { type: "string", description: "New cell content or replacement text" },
        }, required: ["path", "cell_index", "new_string"],
      }},
      { name: "multi_edit", description: "Apply multiple edits across files in one call", input_schema: {
        type: "object", properties: {
          edits: { type: "array", items: { type: "object", properties: {
            path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" },
          }, required: ["path", "old_string", "new_string"] }},
        }, required: ["edits"],
      }},
      // ── todo_write (P1, loop-intercepted) ──
      ...(TODO_WRITE_ENABLED ? [{
        name: "todo_write", description: "Create or update a structured task list. Use for complex multi-step tasks to track progress. Each todo has id, content, and status (pending/in_progress/completed/cancelled). Use merge=true for partial updates.", input_schema: {
          type: "object", properties: {
            todos: { type: "array", items: { type: "object", properties: {
              id: { type: "string", description: "Unique identifier for the todo item (auto-generated if omitted)" },
              content: { type: "string", description: "Description of the todo item" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"], description: "Current status" },
            } }, description: "Array of todo items" },
            merge: { type: "boolean", description: "When true, merge with existing todos by id (partial updates allowed). When false, replace all todos (full items required). Default: false." },
          }, required: ["todos"],
        },
      } as ToolSchema] : []),

      // ── Web tools (P0, gated by feature flags) ──
      ...(WEB_SEARCH_PROVIDER !== "disabled" ? [{
        name: "web_search", description: "Search the web for up-to-date information. Use for facts the model may not know (recent releases, APIs, errors). Returns links for each hit. You MUST cite sources using markdown hyperlinks.", input_schema: {
          type: "object", properties: {
            query: { type: "string", description: "Search query (min 2 chars)" },
            allowed_domains: { type: "array", items: { type: "string" }, description: "Only include results from these domains" },
            blocked_domains: { type: "array", items: { type: "string" }, description: "Never include results from these domains" },
            max_results: { type: "number", description: "1-10 (default 5). For 3rd-party providers only." },
            site: { type: "string", description: "Shorthand for allowed_domains: ['<site>']. Ignored if allowed_domains is set." },
            freshness: { type: "string", enum: ["day", "week", "month", "year", "any"], description: "Bias toward recency. 3rd-party providers only." },
          }, required: ["query"],
        },
      } as ToolSchema] : []),

      ...(WEB_FETCH_ENABLED ? [{
        name: "web_fetch", description: "Fetch a URL and return its content. Use after web_search to read a specific page. Does not execute JavaScript. If `prompt` is set and summarization is enabled, content is condensed by a small fast model before returning.", input_schema: {
          type: "object", properties: {
            url: { type: "string", description: "Absolute http(s) URL" },
            prompt: { type: "string", description: "Optional task to apply to the fetched content (e.g. 'extract the API examples'). Triggers Haiku summarization when enabled." },
            max_bytes: { type: "number", description: "1024-10485760 (default 10 MiB). HTTP body cutoff." },
            raw: { type: "boolean", description: "true → bypass Markdown conversion AND summarization (default false)" },
          }, required: ["url"],
        },
      } as ToolSchema] : []),

      // ── exit_plan_mode (P4, loop-intercepted) ──
      ...(EXIT_PLAN_MODE_ENABLED ? [{
        name: "exit_plan_mode", description: "Exit plan mode and switch to agent mode. Only call when you have a concrete plan and the user has approved it (or no approval is required). After this call, write/edit tools become available.", input_schema: {
          type: "object", properties: {
            plan: { type: "string", description: "The final plan you intend to execute (markdown)" },
          }, required: ["plan"],
        },
      } as ToolSchema] : []),

      // ── ask_user_question (P5, loop-intercepted) ──
      ...(ASK_USER_QUESTION_ENABLED ? [{
        name: "ask_user_question", description: "Ask the user a multiple-choice question and wait for their answer. Use sparingly when a design decision genuinely requires user input.", input_schema: {
          type: "object", properties: {
            questions: { type: "array", items: { type: "object", properties: {
              id: { type: "string", description: "Unique question ID" },
              question: { type: "string", description: "The question text" },
              options: { type: "array", items: { type: "object", properties: {
                id: { type: "string" }, label: { type: "string" },
              }, required: ["id", "label"] } },
              allow_multiple: { type: "boolean", description: "Allow multiple selections (default false)" },
            }, required: ["id", "question", "options"] } },
          }, required: ["questions"],
        },
      } as ToolSchema] : []),

      { name: "a2a_call", description: "Call an external AI agent using the A2A protocol. Authentication is handled automatically — do NOT use bash/curl for A2A calls. Use when: (1) the task requires expertise from another agent, (2) user explicitly asks to involve another agent, (3) creating worker agents in an agent team. Use mode='discover' first to check capabilities. Pass metadata.plugin_id to load a specific plugin/skill on the remote agent.", input_schema: {
        type: "object", properties: {
          agent: { type: "string", description: "Agent name (from registry) or full URL" },
          message: { type: "string", description: "The task/question to send to the remote agent" },
          skill: { type: "string", description: "Optional: target a specific skill on the remote agent" },
          mode: { type: "string", enum: ["stream", "fire_and_forget", "discover"], description: "stream (default): wait for full response. fire_and_forget: submit and return immediately. discover: fetch agent card only." },
          task_id: { type: "string", description: "Optional: existing task ID for multi-turn follow-up on the same remote session" },
          metadata: { type: "object", description: "Optional: A2A metadata passed to the remote agent. Key fields: plugin_id (number) to load a plugin/skill, workspace_id (string) for sandbox namespace, parent_session_id (string) for agent team, team_role (string) for team role name.", properties: {
            plugin_id: { type: "number", description: "Marketplace plugin ID — the remote Brain will download and load this plugin's skill/rules/tools" },
            workspace_id: { type: "string", description: "Target K8s namespace for the remote sandbox" },
            parent_session_id: { type: "string", description: "Parent session ID to form an agent team" },
            team_role: { type: "string", description: "Role name within the agent team" },
          }},
        }, required: ["agent", "message"],
      }},
      // NOTE: `upload_to_s3` is intentionally NOT exposed to the LLM. It is an
      // internal Brain↔Hands plumbing tool (used by syncWorkspaceToS3), and
      // the LLM has no S3 credentials to produce valid presigned URLs — any
      // attempt would fail, pollute toolUsed events, and waste tokens.
      // The route map above still includes it so Brain can call it directly.

      // Launch a sub-agent with its own clean context window. See agent/sub-agent.ts
      // for the permission profiles. The parent agent-loop decides whether to
      // actually expose this schema to the LLM based on the current recursion
      // depth vs SUB_AGENT_MAX_DEPTH, so this entry may be filtered out at
      // call time for deep sub-agents.
      { name: "task", description: "Launch a focused sub-agent to handle a well-defined subtask. Useful for parallelizable exploration, isolated multi-step operations, or reducing parent context pollution. The sub-agent has access to the same sandbox workspace and a curated tool subset, runs in a fresh message window, and returns only its final text as the tool result.", input_schema: {
        type: "object", properties: {
          description: { type: "string", description: "Short 3-5 word summary for UI display" },
          prompt: { type: "string", description: "The self-contained task description for the sub-agent" },
          subagent_type: {
            type: "string",
            enum: ["explore", "readonly", "shell", "generalPurpose"],
            description: "Permission profile. explore=read+bash, readonly=read-only, shell=bash only, generalPurpose=all parent tools. Default: generalPurpose.",
          },
          tools: {
            type: "array",
            items: { type: "string" },
            description: "Optional: exact tool base names allowed for this sub-agent (further narrows subagent_type). Omit to use the profile defaults.",
          },
        },
        required: ["description", "prompt"],
      }},
    ];
  }
}
