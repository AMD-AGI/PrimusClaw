// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import pino from "pino";
import { HandsClient, withHandsTimeout, type ShellClassProbe, type ToolImage } from "../clients/hands.js";
import { isSandboxTool, toolTimeoutCeilingSec } from "./hands.js";
import { handleA2ACall } from "../clients/a2a.js";
import { LEASE_LOST_ABORT_REASON, SIGTERM_ABORT_REASON } from "../tasks/abort-registry.js";
import { callBackendMcpTool } from "../clients/backend-mcp.js";
import type { McpToolCaller } from "../clients/mcp.js";
import { getPluginToolScope } from "./scope.js";
import { toolNotAllowedMessage, type ReadTaint, type ToolAllowlist } from "./allowlist.js";
import type { RunCitations } from "./citations.js";
import {
  CITED_FILE_MAX_BYTES, isCitedReport, CITED_FILE_PATTERNS, CITED_FILE_REFUSAL, CITED_FILE_TOO_LARGE, CITED_FILE_UNREADABLE, REPORT_FILE_EXTENSIONS, checkNote,
  checkReport, type CiteCheck,
} from "./cite-check.js";
import type { LogReads } from "./log-reads.js";
import { citeReviseFor } from "./cite-revise.js";
import { callWithWorkspaceFanout, fansOut } from "./workspace-fanout.js";
import type { ToolSchema, PendingSkill, PendingSkillFileMutation } from "@claw/protocol";
import { MEMORY_TOOLS, MEMORY_TOOL_SCHEMAS, callMemoryTool } from "./memory-tools.js";
import {
  WEB_SEARCH_PROVIDER, WEB_FETCH_ENABLED, TODO_WRITE_ENABLED, BG_SHELL_ENABLED,
  EXIT_PLAN_MODE_ENABLED, ASK_USER_QUESTION_ENABLED, A2A_CLIENT_ENABLED,
  BASH_FOREGROUND_DEFAULT_SEC, WAIT_DEFAULT_SEC, SUB_AGENT_MODELS,
  HANDS_CALL_DEFAULT_TIMEOUT_MS,
  DELIVER_FILE_ENABLED, DELIVER_FILE_MAX_BYTES,
} from "../config.js";
import type { Delivery } from "@claw/protocol";
import { DELIVER_FILE_TOOL, deliverFile, deliverFileSchema, workspaceFile } from "./deliver-file.js";
import type { WebSearchService } from "./web/search.js";
import type { WebFetchService } from "./web/fetch.js";
import { LOAD_SKILL_TOOL, type SkillStore } from "../agent/skill-store.js";
import { TOOL_RESULTS_DIR } from "../workspace/excludes.js";
import { metrics } from "../infra/metrics.js";

const logger = pino({ name: "tool-router" });

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

/**
 * How a model that backgrounds a command gets back to it: `wait` (block until it ends) and `bash_output` (look at it), only one of
 * them, or not at all.
 *
 * The bash schema names that tool, so it has to be one the run is offered: a run whose allow-list keeps `bash` but not `wait` (a
 * requested review, a sub-agent profile, a list a request carries) was told "then call wait", called it, and was refused, a turn spent
 * on nothing each time. `fitShellSchemas` picks the variant from what is actually offered after every filter.
 */
export type BackgroundFollow = "wait" | "wait_only" | "bash_output" | null;

function bashSchema(follow: BackgroundFollow): ToolSchema {
  const head = "Execute a shell command in the workspace directory. Blocks until the command exits; if it hits the timeout the whole process group is killed and only the output so far comes back";
  const cap = `Timeout in seconds (default ${BASH_FOREGROUND_DEFAULT_SEC}, capped at ${BASH_TIMEOUT_CEILING_SEC}): a higher value is reduced to the cap`;
  if (follow === null) {
    return { name: "bash", description: `${head}, so give a long command a timeout to match rather than splitting it up. When you need to wait — for a job to finish, for a file to appear — wait once for the whole interval in a single call and raise \`timeout\` to cover it. Every call is a separate model request that re-sends the entire conversation, so three chained sleeps cost three times what one longer sleep costs and tell you nothing extra.`,
      input_schema: {
        type: "object", properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout: { type: "number", description: `${cap}. The default is a default, not a budget — there is no background mode in this session, so a command or a wait that needs longer should say so here, up to the cap, in one call.` },
        }, required: ["command"],
      }};
  }
  const then = follow !== "bash_output"
    ? { tail: "then call wait to block until it finishes", timeout: "run_in_background plus wait",
      start: follow === "wait" ? "Follow with wait to block until it finishes, or bash_output to look at it without waiting." : "Follow with wait to block until it finishes." }
    : { tail: "then read what it printed, and its exit status once it ends, with bash_output", timeout: "run_in_background plus bash_output", start: "Follow with bash_output to read what it printed and, once it has finished, its exit status." };
  return { name: "bash", description: `${head}. For anything that may outlast the timeout — servers, training runs, long builds, watchers — pass run_in_background=true instead of raising the timeout, ${then.tail}.`,
    input_schema: {
      type: "object", properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: `${cap}, so use ${then.timeout} for anything longer instead of raising this.` },
        run_in_background: { type: "boolean", description: `Return a shell_id immediately and keep the command running. ${then.start}` },
        shell_id: { type: "string", description: "Name this shell instead of taking a generated id (advanced). Private to this conversation, so a plain name like 'server' is fine." },
        background_kind: { type: "string", enum: ["background", "monitor"], description: "Only with run_in_background=true. monitor shells skip stall-prompt notifications." },
      }, required: ["command"],
    }};
}

/**
 * The offered schemas with `bash` told only of the background tools that are among them: `wait` and `bash_output` as offered, and no
 * background mode at all when neither is (a shell nothing offered can read is a shell the model cannot use). Apply it to the final
 * list, after every allow-list, profile and deny-list filter.
 */
export function fitShellSchemas(schemas: ToolSchema[]): ToolSchema[] {
  if (!BG_SHELL_ENABLED) return schemas;
  const names = new Set(schemas.map((s) => s.name));
  if (!names.has("bash") || (names.has("wait") && names.has("bash_output"))) return schemas;
  const fitted = bashSchema(names.has("wait") ? "wait_only" : names.has("bash_output") ? "bash_output" : null);
  return schemas.map((s) => (s.name === "bash" ? fitted : s));
}

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

/** A sandbox tool input that touches the skills directory. */
const SKILLS_PATH_RE = /\.skills\b/;

/** Most of a result kept on disk; past this a command's output is better re-run into a file of its own. */
export const SPILL_MAX_CHARS = 4 * 1024 * 1024;

/** The tools that write skills, which the API keeps only when skill self-evolution is on. */
export const SKILL_WRITE_TOOLS = new Set(["save_skill", "add_skill_file", "update_skill_file", "remove_skill_file"]);
/** The API's personal-skill limits (`api/src/marketplace/skill-service.ts`), so a write refused there is refused here first. */
export const SKILL_MD_MAX_CHARS = 20_000;
export const SKILL_FILE_MAX_BYTES = 64 * 1024;

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

/** What `route()` fills in for its caller; see its `outcome` parameter. */
export type RouteOutcome = {
  isError: boolean;
  structured?: Record<string, unknown>;
  images?: ToolImage[];
  /** A `deliver_file` that copied its file: what the terminal event tells the client. */
  delivery?: Delivery;
  /**
   * The sources the call returned, as its own code produced them (Brain's web tools, an MCP result's `_meta["claw/sources"]`):
   * what `ExecuteRequest.cite` keeps, when it believes the tool (`RunCitations.producedBy`). Never read from the result's text.
   */
  sources?: unknown[];
};

/**
 * Answer with a refusal, recorded as one.
 *
 * `by_tool_ok` is counted from `outcome.isError` and from nothing else -- the
 * result text is deliberately not read, because a failure's wording is the
 * tool's to choose. That makes an error branch which returns its message and
 * leaves the bit alone indistinguishable from work that was done: a run whose
 * every search was refused ships the same `by_tool_ok` as one whose every
 * search answered, and that is the number `deploy/rollout-lib.sh` gates on.
 * Every error return in `route()` and its helpers goes through here, so a
 * branch added later cannot quietly be written without the bit.
 */
function refuse(outcome: RouteOutcome | undefined, text: string): string {
  if (outcome) outcome.isError = true;
  return text;
}

/**
 * Tools handled by the engine loop BEFORE calling router.route().
 * They need loop state mutation, custom onEvent payloads, or NATS suspension.
 */
const LOOP_INTERCEPTED_TOOLS = new Set([
  "todo_write",
  "exit_plan_mode",
  "ask_user_question",
]);

/** The `task` tool's `model` value that keeps a sub-agent on the run's own model. */
export const INHERIT_MODEL = "inherit";

/** The tool that hands the model a skill the prompt listed; offered only when one is listed. */
function loadSkillSchema(): ToolSchema {
  return {
    name: LOAD_SKILL_TOOL,
    description: "Load a skill listed under 'Platform Skills' or 'Personal Skills' in the prompt, or a personal skill the user names: with only `name` you get its SKILL.md (instructions, plus the list of its other files); with `file` you get one of those files. A long file comes in parts of up to ~16000 characters: the end of each part says the `offset` of the next, so keep calling with that offset until the end. Served without a sandbox, so use it, not read or bash, to read any part of a skill. Run a skill's scripts with bash.",
    input_schema: {
      type: "object", properties: {
        name: { type: "string", description: "The skill's name, as listed in the prompt" },
        file: { type: "string", description: "Path of a text file inside the skill's directory, e.g. references/api.md; omit for SKILL.md" },
        offset: { type: "integer", minimum: 0, description: "Character to start from, for the next part of a file that did not fit; omit (0) for the beginning" },
      }, required: ["name"],
    },
  };
}

export interface WebToolServices {
  webSearch?: WebSearchService;
  webFetch?: WebFetchService;
}

/**
 * Same threat patterns as API's scanMemoryContent — duplicated here so the
 * save_skill tool can give Agent immediate accurate feedback
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
 * - save_skill → local pending buffers (flushed via exec_complete)
 * - the memory tools → the API, during the turn (clients/memory.ts)
 *
 * Feature-flag contract: the API tells Brain per request whether this
 * conversation has memory (`memory_enabled`) and whether skill self-evolution
 * is on (`skill_evolution_enabled`). When one is not, its tools are not offered
 * and a call is refused, so the agent is never told "saved" for a write the API
 * will drop.
 */
export class ToolRouter {
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

  /** True only when the API said this conversation has memory; the memory tools are withheld otherwise. */
  memoryEnabled = false;
  /** The turn the memory tools act in, which the API checks is a live chat turn. Set by the engine. */
  memoryTurn: { sessionId?: string; messageId?: string } = {};

  /**
   * True only when the API said it keeps the skills this turn saves (`user_skills_enabled`). Off, the API drops
   * every saved skill, so the skill-writing tools are withheld and refused.
   */
  skillEvolutionEnabled = false;

  /**
   * The run's `tools_allowlist`, null when it has none. Set by the engine from
   * the request; `route()` refuses any call outside it. A sub-agent's router is
   * not given it: that router's own guard is built from the schemas the
   * sub-agent was handed, which the same list has already narrowed.
   */
  private toolAllowlist: ToolAllowlist | null = null;
  /** The run's `read_taint` (`allowlist.ts`): set by the engine, null when the request has none. */
  readTaint: ReadTaint | null = null;
  /** The run's `cite` (`citations.ts`): set by the engine on the top-level router, null when the request has none. */
  citations: RunCitations | null = null;
  /** The run's `cite_check` (`cite-check.ts`): set by the engine on the top-level router, null when the request has none. */
  citeCheck: CiteCheck | null = null;
  /** The run's `log_reads` (`log-reads.ts`): set by the engine, null when the request has none. */
  logReads: LogReads | null = null;

  /**
   * Whom `a2a_call` acts for and how long the run has: the session's owner (an identity
   * peer is called as them), its id for logs, and the epoch ms its budget ends. Set by the
   * engine; sub-agent routers inherit it, so a sub-agent's call is the same user's.
   */
  a2aContext: { userId?: string; sessionId?: string; deadlineAtMs?: number } = {};

  private webServices: WebToolServices;

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

  /**
   * Platform-default skills are written into the sandbox on first need, not at
   * run start. Set by the engine only when defaults are mounted; absent, the
   * sandbox branch of route() is exactly what it was. Inherited by children so
   * a sub-agent reading a default skill triggers the same write.
   */
  lazySkillWriter?: { ensure(hands: HandsClient, text: string, coldSandbox: boolean): Promise<void> };

  /**
   * The skills the prompt lists, served to the model by `load_skill` from Brain's
   * own copy. Set by the engine only when the prompt lists skills; absent, the
   * tool is not offered and not routed. It never reaches a sandbox, so a turn
   * that only loads a skill and calls MCP tools starts none. Inherited by
   * children, like the writer.
   */
  skillStore?: SkillStore;

  constructor(
    private hands: HandsClient | null,
    private platformMcp: Map<string, McpToolCaller> = new Map(),
    webServices?: WebToolServices,
    attachHands?: () => Promise<HandsClient>,
  ) {
    this.webServices = webServices ?? {};
    this.attachHands = attachHands;
  }

  /**
   * The class of a background shell, read without consuming its output.
   *
   * Exists so a caller can decide whether a `wait` on it can block before the
   * wait is routed. A sandbox that cannot be reached answers `running`, which
   * is the reading that costs a slot for one call rather than for a timeout.
   */
  async classifyShell(shellId: string): Promise<ShellClassProbe> {
    // Only background-shell calls are ever classified here, and with
    // `BG_SHELL_ENABLED` off `route()` refuses every one of them below, before
    // any sandbox is reached -- so this probe must not be the thing that
    // reaches one. On a lazily-attached run `requireHands()` would provision a
    // whole sandbox on behalf of a call that is about to be turned away; on a
    // run that has none it throws "No sandbox is attached to this run", and the
    // loop reports that in place of the refusal the model needs to read to stop
    // retrying -- both out of a resumed transcript that merely still contains a
    // `wait`. A refused call never runs, so it can never block: a settled class
    // is the truthful answer and hands back no execution slot.
    if (!BG_SHELL_ENABLED) return { shellClass: "refused", collectorLive: false };
    return (await this.requireHands()).classifyShell(shellId);
  }

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

  /** Restrict this router to a run's `tools_allowlist`; null lifts the restriction. */
  setToolAllowlist(allowlist: ToolAllowlist | null): void {
    this.toolAllowlist = allowlist;
  }

  /** Parse a file path for `.skills/{name}/SKILL.md` and record the skill name. */
  private trackSkillRead(path: string): void {
    // A personal skill's SKILL.md is one directory further down: `.skills/.personal-skills/<name>/SKILL.md`.
    const m = path.match(/\.skills\/(?:\.personal-skills\/)?([a-z0-9][a-z0-9-]*)\/SKILL\.md/i);
    if (m) this.skillsRead.add(m[1]);
  }

  /** Replace the underlying Hands client (called after an in-flight sandbox
   *  rebuild). Cascades to all child routers so sub-agents pick it up too. */
  setHands(newHands: HandsClient): void {
    this.hands = newHands;
    for (const child of this.children) child.setHands(newHands);
  }

  /**
   * Keep a tool result whole in the sandbox and say where, or null when it was
   * not kept. Only into a sandbox the run already has: a turn that has not
   * needed one (MCP and skills only) must not start one to store an answer.
   */
  async spillToolResult(toolUseId: string, text: string): Promise<string | null> {
    if (!this.hands) return null;
    const path = `/workspace/${TOOL_RESULTS_DIR}/${toolUseId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`;
    try {
      const out = String(await withHandsTimeout(
        this.hands, "write", { path, contents: text.slice(0, SPILL_MAX_CHARS) }, HANDS_CALL_DEFAULT_TIMEOUT_MS,
      ));
      return out.startsWith("Error") ? null : path;
    } catch {
      return null;
    }
  }

  /** Return the web tool services for sub-agent propagation. */
  getWebToolServices(): WebToolServices {
    return this.webServices;
  }

  /** Register a child router so subsequent setHands() cascades to it. */
  registerChild(child: ToolRouter): void {
    child.lazySkillWriter = this.lazySkillWriter;
    child.skillStore = this.skillStore;
    child.a2aContext = this.a2aContext;
    child.skillEvolutionEnabled = this.skillEvolutionEnabled;
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
  private async networkTool(
    name: string, input: Record<string, unknown>, outcome?: RouteOutcome,
  ): Promise<string> {
    if (name === "web_search") {
      if (!this.webServices.webSearch) return refuse(outcome, "Error: web search disabled");
      return this.webServices.webSearch.execute(input, outcome);
    }
    if (name === "web_fetch") {
      if (!this.webServices.webFetch) return refuse(outcome, "Error: web fetch disabled");
      return this.webServices.webFetch.execute(input, outcome);
    }
    throw new Error(`Unknown network tool: ${name}`);
  }

  async route(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    /**
     * Filled with what the tool actually answered.
     *
     * The result text alone cannot say: a failure's wording is the tool's to
     * choose, and a caller matching prefixes counts every phrasing it did not
     * anticipate as a success. Anything that needs to know whether the work
     * happened reads this instead.
     */
    outcome?: RouteOutcome,
    /** Replay-stable identity of this call site; sealed on the reference row. */
    ctx?: { stepIdentity?: string },
  ): Promise<string> {
    // First, before any branch below can reach a sandbox, a server or a peer:
    // the schemas the model was given are advice, and this is the enforcement.
    if (this.toolAllowlist && !this.toolAllowlist.allows(name)) {
      return refuse(outcome, toolNotAllowedMessage(name));
    }
    // A research report is checked against its own sources before it is delivered, and only the checked text goes on
    // (`cite-check.ts`); the model is told what the check found before what the tool answered.
    const check = this.citeCheck;
    // The same report copied out of the sandbox would reach the user unchecked: a file that is one is read and delivered as checked
    // text instead (a report too long for one deliver_text call is written to a file, so this is how it is delivered).
    // The file is the one deliver_file would copy (`workspaceFile`: under /workspace, links followed); one it would refuse is left
    // to refuse.
    if (check && name === DELIVER_FILE_TOOL && typeof input.path === "string") {
      const found = await workspaceFile(await this.requireHands(), input.path, signal);
      if (found.ok) {
        // A file one text delivery can hold is read, and the check's own parsing decides whether it is a cited report. A larger one
        // cannot be delivered checked: one that may be a report (the search finds a source line and a citation in it, whatever its
        // type, or cannot search a text file) is refused; any other is copied as before.
        if (found.size <= CITED_FILE_MAX_BYTES) {
          const delivered = await this.deliverCitedFile(check, found, input, signal, outcome, ctx);
          if (delivered !== null) return delivered;
        } else if (await this.largeFileMayCite(found.real, REPORT_FILE_EXTENSIONS.test(found.real), signal)) {
          return refuse(outcome, CITED_FILE_TOO_LARGE);
        }
      }
    }
    if (check?.checks(name) && typeof input.text === "string" && input.text.trim()) {
      const result = await checkReport(input.text, check.ports, signal, check.verdicts);
      if (result.checked) {
        // Too much of it unverified: back to its writer before anything is delivered, a bounded number of times (`cite-revise.ts`).
        const revise = citeReviseFor(check)?.review(result);
        if (revise) {
          logger.info({ tool: name, claims: result.claims, unverified: result.unverified }, "cite_check.revise");
          return refuse(outcome, revise);
        }
        const answered: RouteOutcome = outcome ?? { isError: false };
        const text = await this.routeListed(name, { ...input, text: result.text }, signal, answered, ctx);
        return answered.isError ? text : `${checkNote(result)}\n\n${text}`;
      }
    }
    return this.routeListed(name, input, signal, outcome, ctx);
  }

  /**
   * Whether a file too large to be delivered checked may be a cited report, whatever its type: the sandbox's own `grep` (which reads
   * the whole file) counts both a line of a list of sources and a line with a citation number (`CITED_FILE_PATTERNS`). Two clean
   * answers, one of them without a match, rule it out. A search that failed, was cut short or could not search the file (over its
   * 8 MB) rules it out only for a file that is not a text file (`textType` false).
   */
  private async largeFileMayCite(path: string, textType: boolean, signal?: AbortSignal): Promise<boolean> {
    for (const pattern of CITED_FILE_PATTERNS) {
      const found: RouteOutcome = { isError: false };
      let text: string;
      try {
        text = await this.routeAllowed("grep", { pattern, path, output_mode: "count", case_sensitive: true }, signal, found);
      } catch {
        return textType;
      }
      // A search that did not answer, or did not read the whole file, rules nothing out for a text file; a file of another type
      // (a large archive, a dataset) is not taken for a report on that alone.
      if (found.isError || /^(Error|Invalid|Pattern)\b/.test(text.trim()) || /\bnot searched\b|\[scan aborted|\[grep aborted/.test(text)) return textType;
      // A match is the file's count line, `<path>:<n>` with n > 0, whatever the path's name; no note ends that way.
      if (!text.split("\n").some((l) => Number(l.trim().match(/.:(\d+)$/)?.[1] ?? 0) > 0)) return false;
    }
    return true;
  }

  /**
   * Deliver the sandbox file `file` (resolved as deliver_file resolves it), a cited report, as `deliver_text` would deliver its text:
   * read whole with the sandbox's own `read` at its resolved path, then handed to the run's checked `deliver_text` (`route`), so it is
   * checked against its sources before it is stored. Its name is the file's, with `.md` added when it is not a text file's; the
   * caption is the call's. Refused, with nothing delivered, when the file cannot be read, is larger than one text delivery, or the run
   * has no checked `deliver_text`. Null when the text read is not a report the check reads: deliver_file then copies it as it is.
   */
  private async deliverCitedFile(
    check: CiteCheck, file: { file: string; real: string }, input: Record<string, unknown>, signal?: AbortSignal, outcome?: RouteOutcome,
    ctx?: { stepIdentity?: string },
  ): Promise<string | null> {
    const path = file.real;
    const read: RouteOutcome = { isError: false };
    let text: string;
    // A text file that cannot be read back may be a report: refused. Any other (an image Hands cannot decode) is copied as before.
    const unreadable = (): string | null => (REPORT_FILE_EXTENSIONS.test(path) ? refuse(outcome, CITED_FILE_UNREADABLE) : null);
    try {
      text = await this.routeAllowed("read", { path, line_numbers: false }, signal, read);
    } catch {
      return unreadable();
    }
    if (read.isError || /^Error\b/.test(text)) return unreadable();
    // Not a report the check reads (a binary file, notes, citations only inside code blocks): deliver_file copies it as any other
    // file, as deliver_text would have passed its text on unchanged. Asked first: the text read may be longer than the file's bytes.
    if (!isCitedReport(text)) return null;
    if (Buffer.byteLength(text, "utf8") > CITED_FILE_MAX_BYTES) return refuse(outcome, CITED_FILE_TOO_LARGE);
    const tool = check.deliverTool();
    if (!tool) return refuse(outcome, CITED_FILE_REFUSAL);
    const base = file.file.split("/").filter(Boolean).pop() ?? "report.md";
    const fileName = /\.(md|markdown|txt)$/i.test(base) ? base : `${base.replace(/\.[^.]*$/, "")}.md`;
    const args: Record<string, unknown> = { name: fileName, text };
    if (typeof input.caption === "string" && input.caption.trim()) args.caption = input.caption;
    const answered: RouteOutcome = outcome ?? { isError: false };
    const answer = await this.route(tool, args, signal, answered, ctx);
    return answered.isError ? answer : `This file is a report with numbered citations: it was delivered as text (${fileName}), checked against its sources.\n\n${answer}`;
  }

  /** `route()` for a call the allow-list let through: the read taint and the citations, then the tool. */
  private async routeListed(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    outcome?: RouteOutcome,
    ctx?: { stepIdentity?: string },
  ): Promise<string> {
    const taint = this.readTaint;
    const cite = this.citations;
    if (!taint && !cite) return this.routeAllowed(name, input, signal, outcome, ctx);
    const tainted = taint?.refusal(name);
    if (tainted) return refuse(outcome, tainted);
    // Whether the call failed can decide whether it read anything (`ReadTaint.ran`) and whether its sources are kept, so the bit
    // is read here even when the caller passed no outcome. A call that threw failed.
    const answered: RouteOutcome = outcome ?? { isError: false };
    // A citing call's sources, as the run's lookups returned them; sent where the model's arguments cannot reach.
    const meta = cite?.metaFor(name, input);
    let failed = true;
    try {
      const text = await this.routeAllowed(name, input, signal, answered, ctx, meta);
      failed = answered.isError;
      if (!failed) {
        cite?.keep(name, answered.sources);
        cite?.keepLinks(name, text);
      }
      return text;
    } catch (err) {
      // A thrown message is not the source's own fixed words: it is whatever the transport or the server put in it (an HTTP
      // body, a JSON-RPC error's message). A failure that leaves the turn unmarked must hold nothing anyone else wrote, so the
      // model is told only that the call failed; the message goes to the log. An abort is the run ending, and is left as it is.
      if (!taint?.failsClean(name) || signal?.aborted) throw err;
      logger.warn({ tool: name, err: err instanceof Error ? err.message : String(err) }, "read_taint.clean_failure_threw");
      throw new Error(`${name} failed before it answered (what went wrong is not shown in this conversation)`);
    } finally {
      taint?.ran(name, failed);
    }
  }

  /** `route()` for a call the allow-list and the read taint let through. `meta`: an MCP call's request `_meta` (`citations.ts`). */
  private async routeAllowed(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    outcome?: RouteOutcome,
    ctx?: { stepIdentity?: string },
    meta?: Record<string, unknown>,
  ): Promise<string> {
    if (LOOP_INTERCEPTED_TOOLS.has(name)) {
      throw new Error(`${name} must be handled by engine loop, not router`);
    }

    if (BRAIN_NETWORK_TOOLS.has(name)) return this.networkTool(name, input, outcome);

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
        return refuse(outcome, out.error || out.text || `backend tool '${name}' reported isError`);
      }
      return out.text;
    }

    if (MEMORY_TOOLS.has(name)) {
      if (!this.memoryEnabled) {
        return refuse(outcome, "Error: long-term memory is not available in this conversation; nothing was done.");
      }
      const out = await callMemoryTool(name, this.memoryTurn, input, signal);
      return out.ok ? out.text : refuse(outcome, out.text);
    }
    if (SKILL_WRITE_TOOLS.has(name) && !this.skillEvolutionEnabled) {
      return refuse(outcome, "Error: saving skills is turned off in this deployment; nothing was saved.");
    }
    // save_skill → validate immediately, buffer, flush via exec_complete.
    // Synchronous scan ensures Agent gets accurate feedback (not optimistic "saved").
    if (name === "save_skill") {
      const content = input.content as string || "";
      const skillName = input.skill_name as string || "";
      const blocked = scanContent(content, SKILL_MD_MAX_CHARS);
      if (blocked) {
        return refuse(outcome, `Error: skill '${skillName}' not saved — blocked by safety check (${blocked}).`);
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
      if (pathErr) return refuse(outcome, `Error: invalid file_path — ${pathErr}.`);
      const blocked = scanContent(content, SKILL_FILE_MAX_BYTES);
      if (blocked) return refuse(outcome, `Error: file content blocked by safety check (${blocked}).`);
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
      if (pathErr) return refuse(outcome, `Error: invalid file_path — ${pathErr}.`);
      const blocked = scanContent(content, SKILL_FILE_MAX_BYTES);
      if (blocked) return refuse(outcome, `Error: file content blocked by safety check (${blocked}).`);
      this.pendingSkillFileMutations.push({
        action: "update", skill_name: skillName, file_path: filePath, content, is_binary: !!input.is_binary,
      });
      return `File '${filePath}' queued to update in skill '${skillName}'.`;
    }
    if (name === "remove_skill_file") {
      const skillName = input.skill_name as string || "";
      const filePath = input.file_path as string || "";
      const pathErr = validateSubFilePath(filePath);
      if (pathErr) return refuse(outcome, `Error: invalid file_path — ${pathErr}.`);
      this.pendingSkillFileMutations.push({
        action: "remove", skill_name: skillName, file_path: filePath,
      });
      return `File '${filePath}' queued to remove from skill '${skillName}'.`;
    }

    // Before any sandbox branch: the skill is Brain's to give, and this call must
    // never be the reason a sandbox is opened.
    if (name === LOAD_SKILL_TOOL && this.skillStore) {
      const skillName = typeof input.name === "string" ? input.name : "";
      const file = typeof input.file === "string" ? input.file : undefined;
      const loaded = await this.skillStore.load(skillName, file, input.offset);
      const wholeSkill = file === undefined || file === "" || file === "SKILL.md";
      if (wholeSkill && this.skillStore.get(skillName)?.source === "user") {
        // Whether a personal skill was really used: the signal that loading without being named happens at all.
        if (loaded.ok) metrics.onUserSkillRead("worker", "ok");
        else if (loaded.reason) metrics.onUserSkillRead("worker", loaded.reason === "failed" ? "failed" : "not_found");
      }
      if (!loaded.ok) return refuse(outcome, loaded.error);
      // Same rule as a read of `.skills/<name>/SKILL.md`: the skill counts as used when its SKILL.md was.
      if (file === undefined || file === "" || file === "SKILL.md") this.skillsRead.add(skillName);
      return loaded.text;
    }

    if (name === DELIVER_FILE_TOOL) {
      // The schema is withheld while the switch is off, but a resumed transcript can still hold a call.
      if (!DELIVER_FILE_ENABLED) return refuse(outcome, "Error: deliver_file is disabled in this deployment");
      const { userId, sessionId } = this.a2aContext;
      if (!sessionId) return refuse(outcome, "Error: deliver_file needs a session; nothing was delivered.");
      const delivered = await deliverFile(
        await this.requireHands(),
        // The owner segment the workspace sync uses (tasks/runner.ts): the API serves from the same prefix.
        { userId: userId || "default", sessionId, maxBytes: DELIVER_FILE_MAX_BYTES },
        input, signal,
      );
      if (!delivered.ok) return refuse(outcome, delivered.error);
      if (outcome) outcome.delivery = delivered.delivery;
      return delivered.text;
    }

    if (!BG_SHELL_ENABLED && isBackgroundShellCall(name, input)) {
      return refuse(outcome, BG_SHELL_DISABLED_MESSAGE);
    }

    if (isSandboxTool(name)) {
      // v3.5 #2: track skill reads ONLY after the tool call succeeded.
      // Doing it before led to false positives — when the agent ran
      //   `bash cat .skills/foo/SKILL.md`
      // and the file was missing (e.g. Pi/Codex don't materialize skills to disk),
      // the skill name still landed in skillsRead and polluted feedback / probation /
      // evolution stats with attribution to a skill that never actually loaded.
      const coldSandbox = !this.hands;
      const sandboxHands = await this.requireHands();
      // First touch of a platform-default skill: write it before the call that
      // would read it. Tied to the call naming `.skills`, so a chat that never
      // goes there never pays for the upload.
      if (this.lazySkillWriter && SKILLS_PATH_RE.test(JSON.stringify(input))) {
        await this.lazySkillWriter.ensure(sandboxHands, JSON.stringify(input), coldSandbox);
      }
      const answered = await sandboxHands.callToolFull(name, input, signal, ctx);
      if (outcome) {
        outcome.isError = answered.isError;
        // The durable state of a shell is a field, not a sentence. Dropping it
        // here left every read, wait and kill answerable only by matching the
        // prose a later reword would change.
        outcome.structured = answered.structured as Record<string, unknown> | undefined;
        outcome.images = answered.images;
      }
      const result = answered.text;
      if (name === "bash" && typeof input.command === "string") {
        this.trackSkillRead(input.command);
      } else if ((name === "read" || name === "grep" || name === "glob") && typeof input.path === "string") {
        this.trackSkillRead(input.path);
      }
      return result;
    }

    if (name === "a2a_call") {
      // The schema is withheld while the switch is off, but a resumed transcript can still hold a call.
      if (!A2A_CLIENT_ENABLED) return refuse(outcome, "Error: a2a_call is disabled in this deployment");
      return handleA2ACall(input, {
        ...this.a2aContext,
        signal,
        outcome,
        // A Stop ends the peer's task too. A restart does not: the run resumes and may still want it.
        cancelOnAbort: (reason) => reason !== SIGTERM_ABORT_REASON && reason !== LEASE_LOST_ABORT_REASON,
      });
    }

    if (name.startsWith("mcp__")) {
      const [, server, ...rest] = name.split("__");
      const client = this.platformMcp.get(server);
      if (!client) throw new Error(`Unknown MCP server: ${server}`);
      // A log read (`log_reads`): asked for no more than its bound, and its answer masked before anything reads it.
      if (this.logReads?.has(name)) return this.logReads.filter(await client.callTool(rest.join("__"), this.logReads.bound(name, input), outcome, meta, signal));
      // SaFE's workload or node list without a workspace, refused (or answered empty) to a member: read across the workspaces they
      // may use (`workspace-fanout.ts`).
      if (fansOut(name)) return callWithWorkspaceFanout(client, name, rest.join("__"), input, outcome, meta, signal);
      return client.callTool(rest.join("__"), input, outcome, meta, signal);
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Tool schemas matching Hands Zod definitions exactly.
   * Field names MUST match what Hands tools expect.
   */
  getToolSchemas(): ToolSchema[] {
    const out = this.allToolSchemas().filter((t) =>
      (this.memoryEnabled || !MEMORY_TOOLS.has(t.name))
      && (this.skillEvolutionEnabled || !SKILL_WRITE_TOOLS.has(t.name)));
    return this.skillStore ? [...out, loadSkillSchema()] : out;
  }

  private allToolSchemas(): ToolSchema[] {
    return [
      ...MEMORY_TOOL_SCHEMAS,
      { name: "save_skill", description: "Save the current approach as a reusable skill (the main SKILL.md). Use when: (1) user explicitly asks to save a workflow, (2) you completed a complex multi-step task with reusable value. To attach supporting scripts/templates/docs to this skill, follow up with add_skill_file. Write content and description in the user's language.", input_schema: {
        type: "object", properties: {
          skill_name: { type: "string", description: "Short kebab-case English slug, e.g. 'react-scaffold' (name is always English for consistency, content/description follow user language)" },
          description: { type: "string", description: "2-4 sentences: what the skill does, when to use it, when NOT to use it" },
          content: { type: "string", description: `Full SKILL.md text with ## Goal, ## Steps, ## Notes (max ${SKILL_MD_MAX_CHARS} chars)` },
        }, required: ["skill_name", "content", "description"],
      }},
      { name: "add_skill_file", description: "Attach a supporting file to an existing skill (script, template, reference doc). Use after save_skill when the skill needs accompanying assets the Agent can later read or execute. file_path must start with one of: references/, templates/, scripts/, assets/", input_schema: {
        type: "object", properties: {
          skill_name: { type: "string", description: "Name of an existing skill" },
          file_path: { type: "string", description: "Relative path under the skill dir, e.g. 'scripts/deploy.sh' (whitelist: references/, templates/, scripts/, assets/)" },
          content: { type: "string", description: `File contents (max ${SKILL_FILE_MAX_BYTES / 1024} KB)` },
          is_binary: { type: "boolean", description: "Set true if content is base64-encoded binary; default false" },
        }, required: ["skill_name", "file_path", "content"],
      }},
      { name: "update_skill_file", description: "Replace the content of an existing supporting file on a skill.", input_schema: {
        type: "object", properties: {
          skill_name: { type: "string" },
          file_path: { type: "string" },
          content: { type: "string", description: `New file contents (max ${SKILL_FILE_MAX_BYTES / 1024} KB)` },
          is_binary: { type: "boolean" },
        }, required: ["skill_name", "file_path", "content"],
      }},
      { name: "remove_skill_file", description: "Remove a supporting file from a skill.", input_schema: {
        type: "object", properties: {
          skill_name: { type: "string" },
          file_path: { type: "string" },
        }, required: ["skill_name", "file_path"],
      }},
      bashSchema(BG_SHELL_ENABLED ? "wait" : null),

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
      { name: "read", description: "Read a file. Lines come numbered as N|text (the number is not part of the file); at most 2000 lines per call, and the end says the offset to continue from. Automatically detects .ipynb and formats notebook cells.", input_schema: {
        type: "object", properties: {
          path: { type: "string", description: "File path relative to /workspace" },
          offset: { type: "number", description: "Start line (1-based)" },
          limit: { type: "number", description: "Number of lines to read (default 2000)" },
          notebook_cell_index: { type: "number", description: "For .ipynb files: return only this cell (0-based)" },
        }, required: ["path"],
      }},
      { name: "write", description: "Write or overwrite a file (creates parent dirs)", input_schema: {
        type: "object", properties: {
          path: { type: "string", description: "File path relative to /workspace" },
          contents: { type: "string", description: "Full file content" },
        }, required: ["path", "contents"],
      }},
      { name: "edit", description: "Replace exact text in a file. old_string must match exactly once, unless replace_all is set (e.g. to rename a variable everywhere in the file).", input_schema: {
        type: "object", properties: {
          path: { type: "string", description: "File path relative to /workspace" },
          old_string: { type: "string", description: "Exact text to find (must be unique unless replace_all); copy it without the N| prefix read adds" },
          new_string: { type: "string", description: "Replacement text" },
          replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
        }, required: ["path", "old_string", "new_string"],
      }},
      { name: "glob", description: "Find files matching a glob pattern", input_schema: {
        type: "object", properties: {
          pattern: { type: "string", description: "Glob pattern (e.g. **/*.ts)" },
          directory: { type: "string", description: "Subdirectory to search in" },
        }, required: ["pattern"],
      }},
      { name: "grep", description: "Search file contents with a regex pattern. Case-insensitive unless case_sensitive is set. output_mode picks matching lines with context (default), file paths only, or a count per file; head_limit keeps the first N entries. Searches dot-directories such as .github; skips .git, node_modules and caches.", input_schema: {
        type: "object", properties: {
          pattern: { type: "string", description: "Regular expression pattern" },
          path: { type: "string", description: "File or directory to search" },
          context: { type: "number", description: "Lines of context around matches (default 2)" },
          case_sensitive: { type: "boolean", description: "Match case exactly (default false)" },
          glob: { type: "string", description: "Only search files matching this glob, e.g. *.ts or src/**/*.py" },
          output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "content (default): matching lines with context; files_with_matches: only the paths of matching files; count: matching lines per file" },
          head_limit: { type: "integer", minimum: 1, description: "Return only the first N entries: matching lines for content, files otherwise (default: all)" },
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

      ...(DELIVER_FILE_ENABLED ? [deliverFileSchema()] : []),

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
        name: "web_fetch", description: "Fetch a URL and return its content. Use after web_search to read a specific page. Does not execute JavaScript. If `prompt` is set and summarization is enabled, content is condensed by a small fast model before returning. A page longer than one answer is read in parts: set find to a word of the part you need (a feature's or a product's name) to get the page around each place it appears, or offset to read on from where the last part ended.", input_schema: {
          type: "object", properties: {
            url: { type: "string", description: "Absolute http(s) URL" },
            find: { type: "string", description: "Optional: return only the page around each place this text appears (case-insensitive), for a large page such as a reference table or a compatibility matrix." },
            offset: { type: "number", description: "Optional: the character of the page to start from, as a previous answer's Part line gives it (default 0)." },
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

      ...(A2A_CLIENT_ENABLED ? [{ name: "a2a_call", description: "Call a peer AI agent that the operator has configured, using the A2A protocol. Only configured peers can be called (never a URL), and authentication is handled for you — do NOT use bash/curl for A2A calls. Use when: (1) the task requires expertise from another agent, (2) user explicitly asks to involve another agent, (3) creating worker agents in an agent team. Use mode='discover' first to check capabilities. Pass metadata.plugin_id to load a specific plugin/skill on the remote agent. The result is JSON: {state, task_id, context_id, text, artifacts, input_required?}. state is submitted, working, input_required, auth_required, completed, failed, canceled or rejected. A call that outlasts its wait returns state=working with a task_id: read it later with mode='get'. state=input_required means the peer is asking something: input_required.text is the question; answer by calling again with the same task_id and context_id and your answer in message (or approval for an approval request). Pass context_id alone to continue the same conversation in a new task.", input_schema: {
        type: "object", properties: {
          agent: { type: "string", description: "Name of a configured peer agent (not a URL); an unknown name is refused with the list of configured peers" },
          message: { type: "string", description: "The task/question to send to the remote agent, or your answer when task_id is set. Not needed for discover, get or cancel." },
          mode: { type: "string", enum: ["stream", "fire_and_forget", "discover", "get", "cancel"], description: "stream (default): wait for the response, up to an idle and a total limit. fire_and_forget: submit and return immediately. discover: fetch agent card only. get: read the task task_id (state and result). cancel: ask the peer to cancel task task_id." },
          task_id: { type: "string", description: "The peer's task: required for get and cancel; with stream or fire_and_forget it answers that task when it is input_required." },
          context_id: { type: "string", description: "Optional: the peer's conversation (from an earlier result) to continue in a new task." },
          approval: { type: "object", description: "Answer a peer's approval request (input_required.approval). allow is held for the user's own approval before it is sent.", properties: {
            action_id: { type: "string", description: "input_required.approval.action_id" },
            decision: { type: "string", enum: ["allow", "deny"] },
          }, required: ["action_id", "decision"] },
          metadata: { type: "object", description: "Optional: A2A metadata passed to the remote agent. Key fields: plugin_id (number) to load a plugin/skill, workspace_id (string) for sandbox namespace, parent_session_id (string) for agent team, team_role (string) for team role name.", properties: {
            plugin_id: { type: "number", description: "Marketplace plugin ID — the remote Brain will download and load this plugin's skill/rules/tools" },
            workspace_id: { type: "string", description: "Target K8s namespace for the remote sandbox" },
            parent_session_id: { type: "string", description: "Parent session ID to form an agent team" },
            team_role: { type: "string", description: "Role name within the agent team" },
          }},
        }, required: ["agent"],
      }} as ToolSchema] : []),
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
          // Offered only where the deployment names models to choose from: an
          // enum of nothing would be a field the model can only get wrong.
          ...(SUB_AGENT_MODELS.length ? { model: {
            type: "string",
            enum: [...SUB_AGENT_MODELS, INHERIT_MODEL],
            description: `Optional: the model this sub-agent runs on; "${INHERIT_MODEL}" runs it on your own. Omit to use the default (a lighter model for explore/readonly where one is configured, otherwise your own). Pick a lighter one for broad reading and searching, "${INHERIT_MODEL}" for work that needs judgement.`,
          } } : {}),
        },
        required: ["description", "prompt"],
      }},
    ];
  }
}
