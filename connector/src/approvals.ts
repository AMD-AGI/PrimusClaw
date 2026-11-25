// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Approvals asked in a terminal, answered from the phone.
 *
 * A Claude Code session that a person started in their own terminal asks them before it runs a command, edits a file, leaves
 * plan mode or puts a multiple-choice question (`AskUserQuestion`). With the approval hooks installed (`hooks install
 * --approvals`), Claude Code runs `approval-hook.js` at that moment (its `PermissionRequest` hook) and, measured on 2.1.322,
 * keeps showing its own dialog while the hook runs: whichever answers first, the terminal or the hook, decides, and a hook
 * that returns no decision changes nothing. The hook hands the request to this connector over a local socket; the connector
 * puts it to the owner as a card on a session of its own at Claw (origin `terminal_hook`, one per conversation) and gives the
 * owner's choice back to the hook.
 *
 * Claude Code does not tell a waiting hook that the terminal answered first (it lets it run on, and ignores what it prints
 * later); it sends SIGTERM only when the answer interrupts the turn. So the same program also runs, without holding anything
 * up (`async`), on the events that follow an answer (`PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`,
 * `SessionEnd`): the first of those for the same call settles the request as answered at the terminal, the card is withdrawn
 * (`permission_resolved` by `terminal`) and the waiting hook is let go.
 *
 * OpenAI Codex (the `codex` TUI, measured on 0.153.4) has the same `PermissionRequest` hook, for a command, a patch and an MCP
 * tool, but runs it before it shows its own prompt, not alongside it: while the hook waits, the terminal shows only that a hook
 * is running. So for Codex the hook puts the question on the phone only when nobody has typed in that terminal for a while
 * (its tty's access time, as `w` reads it), and gives the question back to the terminal as soon as someone types there
 * (approval-hook.ts); a card for Codex offers only *Yes* and *No*, the decisions Codex reads (it refuses a hook that returns
 * anything more).
 *
 * Nothing here can approve anything by itself: a request is answered only with an option the card offered, chosen by the owner
 * (a `decision` command from Claw), and a request that cannot be put on a card, or that meets a connector without Claw, is
 * left to the terminal at once. Claude Code's own deny and ask rules are still applied after a hook allows a call.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { UNATTENDED_MODES } from "./approval-skip.js";
import {
  CURSOR_HOLD_DEFAULT_S, CURSOR_HOLD_MAX_S, CURSOR_HOLD_MIN_S, type CursorDecision, type CursorRules, cursorWouldAsk, loadCursorRules, mapCursorRequest,
  parseCursorEvent,
} from "./cursor-approvals.js";
import { lastInputMs as ttyLastInputMs } from "./codex-terminal.js";
import { boundedInput, type OfferedOption } from "./permissions.js";
import { REMOTE_EVENT_TERMINAL_TURN_END, turnAsksPerson } from "./protocol.js";
import { redactDeep } from "./redact.js";
import { turnOrigin, type TurnOrigin } from "./turn-origin.js";

/** What a card's options say, in the order shown. */
export interface CardSpec {
  tool: string;
  kind: string;
  input: unknown;
  options: OfferedOption[];
  /** For a question put as several cards: which one, and of how many. */
  questionIndex?: number;
  questionCount?: number;
}

/** The decision a `PermissionRequest` hook prints (`hookSpecificOutput.decision`). */
export type HookDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: Array<Record<string, unknown>> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

/** What a hook prints: Claude Code's `PermissionRequest` decision, or a Cursor before-hook's answer (cursor-approvals.ts). */
export type AnyDecision = HookDecision | CursorDecision;

/** How a request is put to the owner: one card or several (a question each), and how the choices become the hook's decision. */
export interface Mapping<D extends AnyDecision = AnyDecision> {
  cards: CardSpec[];
  /**
   * The decision for the options chosen, one per card in order; null when the choices make none (for Claude Code never expected;
   * for Cursor, "ask me at the terminal").
   */
  decide(chosen: string[]): D | null;
}

/** What Claude Code hands a `PermissionRequest` hook (measured on 2.1.322); everything else in it is ignored. */
export interface PermissionEvent {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_mode?: string;
  permission_suggestions?: unknown[];
  transcript_path?: string;
  agent_id?: string;
  agent_type?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The end of `s`, at most `max` characters (where an answer sums up), marked as cut when it is. */
const cutEnd = (s: string, max: number): string => (s.length > max ? `…${s.slice(-(max - 1))}` : s);

const oneLine = (s: unknown, max: number): string => {
  const t = typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A question card offers at most this many answers: the chat shows at most four buttons on a card. */
export const MAX_QUESTION_OPTIONS = 4;
/**
 * The most of a request's input (as JSON, after masking credentials) a card carries. A request is approved from the phone only
 * when the card shows all of it: one that is longer is shown cut, with only the options that turn it down, and has to be
 * approved at the terminal, so nothing can be approved that the owner was not shown. Well inside one event's limit.
 */
export const CARD_INPUT_MAX = 12 * 1024;
/** The longest option name the wire carries whole (`OfferedOption.name`). */
export const OPTION_NAME_MAX = 200;
export const TOO_LONG_NOTE = "Too long to show in full here: it can only be turned down from the phone; approve it at the terminal.";
/** What Claude reads when the owner turns a request down from the phone. */
export const DENIED_MESSAGE = "The user declined this from their phone (Claw).";
export const PLAN_KEEP_MESSAGE = "The user asked to keep planning (answered from their phone via Claw); do not start yet.";

/** Parse what the hook was handed; null for anything that is not a permission request it can describe. */
export function parsePermissionEvent(raw: unknown): PermissionEvent | null {
  if (!isObject(raw) || raw.hook_event_name !== "PermissionRequest") return null;
  const { session_id: sid, cwd, tool_name: tool, tool_input: input } = raw;
  if (typeof sid !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(sid)) return null;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || typeof tool !== "string" || tool === "" || !isObject(input)) return null;
  return {
    session_id: sid, cwd, tool_name: tool, tool_input: input,
    ...(typeof raw.permission_mode === "string" ? { permission_mode: raw.permission_mode } : {}),
    ...(Array.isArray(raw.permission_suggestions) ? { permission_suggestions: raw.permission_suggestions } : {}),
    ...(typeof raw.transcript_path === "string" ? { transcript_path: raw.transcript_path } : {}),
    ...(typeof raw.agent_id === "string" ? { agent_id: raw.agent_id } : {}),
    ...(typeof raw.agent_type === "string" ? { agent_type: raw.agent_type } : {}),
  };
}

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** The card kind (the ACP tool kinds the chat already knows) for a tool. */
export function toolKind(tool: string): string {
  if (tool === "Bash" || tool === "PowerShell") return "execute";
  if (EDIT_TOOLS.has(tool)) return "edit";
  if (tool === "AskUserQuestion") return "question";
  if (tool === "ExitPlanMode") return "switch_mode";
  if (tool.startsWith("mcp__")) return "mcp";
  if (tool === "WebFetch" || tool === "WebSearch") return "fetch";
  return "other";
}

/** A card's title: what is being asked, in one line. */
export function toolTitle(e: PermissionEvent): string {
  const i = e.tool_input;
  const who = e.agent_id ? `Subagent${e.agent_type ? ` ${oneLine(e.agent_type, 40)}` : ""}: ` : "";
  let what: string;
  if (e.tool_name === "Bash" || e.tool_name === "PowerShell") what = `Run: ${oneLine(i.command, 160)}`;
  else if (EDIT_TOOLS.has(e.tool_name)) what = `${e.tool_name === "Write" ? "Write" : "Edit"} ${oneLine(i.file_path ?? i.notebook_path, 160)}`;
  else if (e.tool_name === "WebFetch") what = `Fetch ${oneLine(i.url, 160)}`;
  else what = e.tool_name.startsWith("mcp__") ? `MCP tool ${oneLine(e.tool_name.slice(5).replace("__", " / "), 120)}` : oneLine(e.tool_name, 80);
  return oneLine(`${who}${what}`, 200);
}

/** The rule suggestions Claude Code offered that may be kept for this session only: allow rules, nothing that changes the mode. */
export function sessionRules(suggestions: unknown[] | undefined): Array<Record<string, unknown>> {
  if (!suggestions) return [];
  return suggestions
    .filter((s): s is Record<string, unknown> => isObject(s) && s.type === "addRules" && s.behavior === "allow" && Array.isArray(s.rules) && s.rules.length > 0)
    .map((s) => ({ type: "addRules", rules: s.rules, behavior: "allow", destination: "session" }));
}

const ruleText = (rules: Array<Record<string, unknown>>): string =>
  rules.flatMap((r) => (r.rules as unknown[])).filter(isObject)
    .map((r) => (typeof r.ruleContent === "string" ? `${r.toolName}(${r.ruleContent})` : String(r.toolName))).join(", ");

/**
 * How one request is put to the owner, or null when no card can carry it (the terminal answers it as before). Every option is
 * one the terminal also offers; none switches the session into a mode that stops asking (auto, accept edits, bypass), and an
 * "always" answer is kept for this session only.
 */
export function mapRequest(e: PermissionEvent): Mapping<HookDecision> | null {
  if (e.tool_name === "AskUserQuestion") return mapQuestions(e);
  if (e.tool_name === "ExitPlanMode") return mapPlan(e);
  const shown = shownInput(redactDeep(e.tool_input));
  // The rule an "always" answer adds is named in that option itself, in full (never added to the input, which is the request's own
  // and must show exactly what will run); a rule too long to name there is not offered.
  const always = `Always allow this session: ${ruleText(sessionRules(e.permission_suggestions))}`;
  const rules = always.length <= OPTION_NAME_MAX ? sessionRules(e.permission_suggestions) : [];
  const options: OfferedOption[] = [
    ...(shown.complete ? [{ optionId: "allow", name: "Yes", kind: "allow_once" }] : []),
    ...(shown.complete && rules.length ? [{ optionId: "allow-session", name: always, kind: "allow_always" }] : []),
    { optionId: "deny", name: "No", kind: "reject_once" },
    { optionId: "deny-stop", name: "No, and stop", kind: "reject_once" },
  ];
  return {
    cards: [{ tool: toolTitle(e), kind: toolKind(e.tool_name), input: shown.input, options }],
    decide([c]) {
      if (c === "allow" && shown.complete) return { behavior: "allow" };
      if (c === "allow-session" && shown.complete && rules.length) return { behavior: "allow", updatedPermissions: rules };
      if (c === "deny") return { behavior: "deny", message: DENIED_MESSAGE };
      if (c === "deny-stop") return { behavior: "deny", message: DENIED_MESSAGE, interrupt: true };
      return null;
    },
  };
}

/** The files a Codex patch (`apply_patch`) adds, changes or deletes, as its own headers name them. */
export function patchFiles(patch: unknown): string[] {
  if (typeof patch !== "string") return [];
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim()).filter((f) => f !== "");
}

/** A Codex card's title (measured on 0.153.4: `Bash` with `command`, `apply_patch` with the patch as `command`, `mcp__<server>__<tool>`). */
export function codexTitle(e: PermissionEvent): string {
  const i = e.tool_input;
  if (e.tool_name === "Bash") return oneLine(`Run: ${oneLine(i.command, 160)}`, 200);
  if (e.tool_name === "apply_patch") {
    const files = patchFiles(i.command);
    return oneLine(files.length ? `Edit ${files.join(", ")}` : "Apply a patch", 200);
  }
  if (e.tool_name.startsWith("mcp__")) return oneLine(`MCP tool ${oneLine(e.tool_name.slice(5).replace("__", " / "), 120)}`, 200);
  return oneLine(e.tool_name, 80);
}

/** The card kind for a Codex tool. */
export function codexKind(tool: string): string {
  if (tool === "Bash") return "execute";
  if (tool === "apply_patch") return "edit";
  if (tool.startsWith("mcp__")) return "mcp";
  return "other";
}

/**
 * How a Codex request is put to the owner: *Yes* or *No*. Codex 0.153.4 reads only `behavior` and `message` from a
 * `PermissionRequest` hook and treats `updatedInput`, `updatedPermissions` or `interrupt` as a failure (it refuses the call),
 * so there is no "always" and no "stop" here; those stay at the terminal.
 */
export function mapCodexRequest(e: PermissionEvent): Mapping {
  const shown = shownInput(redactDeep(e.tool_input));
  const options: OfferedOption[] = [
    ...(shown.complete ? [{ optionId: "allow", name: "Yes", kind: "allow_once" }] : []),
    { optionId: "deny", name: "No", kind: "reject_once" },
  ];
  return {
    cards: [{ tool: codexTitle(e), kind: codexKind(e.tool_name), input: shown.input, options }],
    decide([c]) {
      if (c === "allow" && shown.complete) return { behavior: "allow" };
      if (c === "deny") return { behavior: "deny", message: DENIED_MESSAGE };
      return null;
    },
  };
}

/** The input as the card carries it: whole when it fits, else cut and marked (`complete: false`). */
export function shownInput(masked: unknown): { input: unknown; complete: boolean } {
  const text = JSON.stringify(masked ?? null);
  if (Buffer.byteLength(text, "utf8") <= CARD_INPUT_MAX) return { input: masked ?? null, complete: true };
  return { input: { truncated: true, note: TOO_LONG_NOTE, shown: boundedInput(text, CARD_INPUT_MAX - 512) }, complete: false };
}

interface Question { question: string; header: string; labels: string[]; descriptions: string[] }

function mapQuestions(e: PermissionEvent): Mapping<HookDecision> | null {
  const raw = e.tool_input.questions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) return null;
  const qs: Question[] = [];
  for (const q of raw) {
    if (!isObject(q) || typeof q.question !== "string" || q.question === "" || q.multiSelect === true || !Array.isArray(q.options)) return null;
    const opts = q.options.filter(isObject);
    if (opts.length === 0 || opts.length > MAX_QUESTION_OPTIONS || opts.length !== q.options.length) return null;
    if (opts.some((o) => typeof o.label !== "string" || o.label === "")) return null;
    const labels = opts.map((o) => o.label as string);
    if (new Set(labels).size !== labels.length) return null;
    qs.push({ question: q.question, header: typeof q.header === "string" ? q.header : "", labels, descriptions: opts.map((o) => (typeof o.description === "string" ? o.description : "")) });
  }
  const cards: CardSpec[] = [];
  for (const [qi, q] of qs.entries()) {
    // The answers are the buttons (their labels, as the terminal shows them); what each means is in the card's body.
    const shown = shownInput(redactDeep({ header: q.header, question: q.question, options: q.labels.map((l, i) => ({ label: l, description: q.descriptions[i] })) }));
    if (!shown.complete) return null;
    cards.push({
      tool: oneLine(q.question, 200),
      kind: "question",
      input: shown.input,
      options: q.labels.map((l, i) => ({ optionId: `a${i}`, name: oneLine(l, 200), kind: "allow_once" })),
      ...(qs.length > 1 ? { questionIndex: qi, questionCount: qs.length } : {}),
    });
  }
  return {
    cards,
    decide(chosen) {
      if (chosen.length !== qs.length) return null;
      const answers: Record<string, string> = {};
      for (let i = 0; i < qs.length; i++) {
        const m = /^a(\d+)$/.exec(chosen[i]!);
        const label = m ? qs[i]!.labels[Number(m[1])] : undefined;
        if (label === undefined) return null;
        answers[qs[i]!.question] = label;
      }
      return { behavior: "allow", updatedInput: { ...e.tool_input, answers } };
    },
  };
}

function mapPlan(e: PermissionEvent): Mapping<HookDecision> {
  const plan = typeof e.tool_input.plan === "string" ? e.tool_input.plan : "";
  const heading = /^\s*#+\s*(.+)$/m.exec(plan)?.[1] ?? plan.split("\n").find((l) => l.trim() !== "") ?? "";
  const shown = shownInput(redactDeep({ plan, ...(typeof e.tool_input.planFilePath === "string" ? { planFilePath: e.tool_input.planFilePath } : {}) }));
  return {
    cards: [{
      tool: oneLine(`Plan: ${oneLine(heading, 150) || "ready to start"}`, 200),
      kind: "switch_mode",
      input: shown.input,
      options: [
        ...(shown.complete ? [{ optionId: "plan-approve", name: "Approve (ask before each edit)", kind: "allow_once" }] : []),
        { optionId: "plan-keep", name: "Keep planning", kind: "reject_once" },
      ],
    }],
    decide([c]) {
      // Approved with the mode set back to the one that asks: leaving it out would continue in `acceptEdits` (measured on 2.1.322),
      // a mode a phone may not choose.
      if (c === "plan-approve" && shown.complete) return { behavior: "allow", updatedInput: e.tool_input, updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }] };
      if (c === "plan-keep") return { behavior: "deny", message: PLAN_KEEP_MESSAGE };
      return null;
    },
  };
}

/** The hook's stdout for a decision. */
export function hookOutput(d: HookDecision): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d } });
}

// --- the local socket ------------------------------------------------------------------

/** Where the hooks reach the connector. Its directory is the state directory, which only this user can enter. */
export const approvalSocketFile = (stateDir: string): string => path.join(stateDir, "approvals.sock");

/** One line each way: the hook's request, the connector's answer. */
export type HookMessage =
  | { v: 1; type: "ask"; event: Record<string, unknown>; agent?: HookAgent; hold_ms?: number }
  | { v: 1; type: "settled"; event: Record<string, unknown>; agent?: HookAgent; tty?: string };
export type ConnectorReply = { v: 1; decision: AnyDecision | null; why?: string };

/** Which coding agent's hooks a request came from. */
export type HookAgent = "claude" | "cursor" | "codex";

/** The largest line either side reads: a plan or a file written whole can be long. */
export const MAX_LINE_BYTES = 2 * 1024 * 1024;

/** What the broker needs from the running connector. */
export interface BrokerDeps {
  /** Open (or find) the Claw session for this conversation; null when Claw cannot or will not take it (the reason is returned). */
  openSession(p: { agent: HookAgent; configDir: string; ref: string; cwd: string; title: string }): Promise<{ sessionId: string } | { refused: string }>;
  emit(sessionId: string, type: string, data: Record<string, unknown>): void;
  audit(event: string, detail: Record<string, unknown>): void;
  /** How long a card waits before it is withdrawn (the hook then leaves the question to the terminal). */
  ttlMs: number;
  /** Cursor's rules for a Cursor config directory and the conversation's workspace roots (default: read from their files). */
  cursorRules?: (configDir: string, workspaceRoots: string[]) => CursorRules;
  /**
   * Whether a chat follows this conversation through a session of this connector (attached, watched or typed into from the phone):
   * that chat shows the turn's end itself, so it is not told again.
   */
  attached?: (ref: string) => boolean;
  /** How long a terminal must go without input after a turn ends before its owner is told (default {@link TURN_END_AWAY_MS}). */
  awayMs?: number;
  /** When a terminal last had input (default: its device's access time). */
  lastInputMs?: (tty: string) => number | null;
  /** How old a run of folded ends may get before it is told without waiting (default {@link TURN_END_RUN_MAX_MS}). */
  runMaxMs?: number;
}

/**
 * How long nobody may type in a terminal after a turn ended there before its owner is told it ended: the person who sent the
 * prompt and stayed sees the end themselves, and someone who walked away is told once a minute has passed, as Claw tells a wait.
 */
export const TURN_END_AWAY_MS = 60_000;
/** The most of the agent's last message an end carries (its end: where an answer sums up). Claw keeps less. */
export const TURN_END_MESSAGE_MAX = 2000;
/**
 * Turns started by something other than a person (another session's message, a scheduled prompt) that end one after another are
 * told as one end: at most this many of the earlier ones' last words go with the newest, each cut to {@link TURN_END_EARLIER_CHARS}.
 */
export const TURN_END_EARLIER_MAX = 5;
export const TURN_END_EARLIER_CHARS = 400;
/**
 * Such a run of ends is told once its first end is this old, without waiting for the terminal to be quiet after the newest one: a
 * conversation that works on its own without a minute's pause is still heard of.
 */
export const TURN_END_RUN_MAX_MS = 15 * 60_000;
/** What a hook names as the terminal a session runs in (codex-terminal.ts `terminalOf`). */
const TTY_RE = /^\/dev\/(?:pts\/\d+|tty[A-Za-z0-9]+)$/;
/** The errors Claude Code names in `StopFailure` are words; anything else is cut to one. */
const ERROR_RE = /^[a-z_]{1,40}$/;

/** A turn that ended in a terminal, waiting to see whether anyone is there. */
interface Ending {
  ref: string;
  agent: HookAgent;
  configDir: string;
  cwd: string;
  tty: string;
  at: number;
  outcome: "done" | "error";
  error: string | null;
  message: string;
  /**
   * Who started the turn (turn-origin.ts), null when the transcript does not say: Claw then tells the end as it did before it
   * knew. A run of ends of turns nobody typed is folded into its newest (`turns`, `earlier`, `since`).
   */
  origin: TurnOrigin | null;
  /** How many turns' ends this one stands for (itself and the earlier ones folded into it). */
  turns: number;
  /** The last words of the earlier turns folded into it, oldest first, at most {@link TURN_END_EARLIER_MAX}. */
  earlier: string[];
  /** Whether each of `earlier` is the last words of a turn that failed (same order, same length). */
  earlierFailed: boolean[];
  /** How many of the earlier turns folded into it failed: a failure is never hidden behind a later turn that finished. */
  failedEarlier: number;
  /** How many of the earlier turns folded into it asked the person something, counted whether or not their words are kept. */
  askedEarlier: number;
  /** When the first of the folded ends came. */
  since: number;
  timer: NodeJS.Timeout;
  /**
   * Why the end was taken back, when that also decides what becomes of a session opened for it meanwhile: the conversation
   * ended (`closed` is the session the end of it closed, if one was known then), or the connector is stopping.
   */
  gone?: { ended: true; closed: string | undefined } | { stopped: true };
}

interface Card { actionId: string; spec: CardSpec; chosen: string | null }
interface Pending {
  id: string;
  ref: string;
  sessionId: string;
  tool: string;
  input: string;
  /** Cursor: the call's id, which its after-hooks name. */
  toolUseId: string | null;
  mapping: Mapping;
  cards: Card[];
  reply: (r: ConnectorReply) => void;
  timer: NodeJS.Timeout;
}

/** Canonical JSON, to tell whether a later event is about the same call. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (isObject(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/** The tools whose input Claude Code changes between the request and the result (answers added, plan injected): matched by name. */
const MATCH_BY_NAME = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * Holds the requests the hooks are waiting on, one card (or one per question) each, and settles each exactly once: by the
 * owner's choice, by the terminal answering first, by the hook going away, or by the timeout.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly byAction = new Map<string, Pending>();
  /** Claw sessions this connector opened for terminal conversations, by conversation id. */
  private readonly sessions = new Map<string, string>();
  private readonly owned = new Set<string>();
  /** Turns that ended in a terminal, one per conversation: told once the terminal has had no input for `awayMs`. */
  private readonly endings = new Map<string, Ending>();
  /**
   * Ends a new prompt came after before they were told, one per conversation: who started that prompt's turn is known only once
   * it ends. A turn a person started drops it (they are at the terminal); a turn nobody typed carries it on (`turnEnded`).
   */
  private readonly held = new Map<string, Ending>();
  /**
   * Ends whose session Claw is opening, taken back meanwhile or not: the end of the conversation or a stop in that time still
   * marks them gone, so a session that opens after the conversation ended is closed rather than kept.
   */
  private readonly opening = new Set<Ending>();

  constructor(private readonly d: BrokerDeps) {}

  /** Whether a Claw session is one of these (its commands come here, not to an agent). */
  owns(sessionId: string): boolean { return this.owned.has(sessionId); }

  get size(): number { return this.pending.size; }

  /**
   * A hook asks. `reply` is called exactly once. `configDir` is the Claude config directory (or, for Codex, `CODEX_HOME`) the hook
   * was installed for, which says which agent the conversation belongs to.
   */
  async ask(raw: Record<string, unknown>, configDir: string, reply: (r: ConnectorReply) => void, agent: "claude" | "codex" = "claude"): Promise<() => void> {
    let done = false;
    const once = (r: ConnectorReply) => { if (!done) { done = true; reply(r); } };
    const e = parsePermissionEvent(raw);
    if (!e) { once({ v: 1, decision: null, why: "not_a_permission_request" }); return () => {}; }
    // The hook already leaves a session in such a mode alone (approval-skip.ts); this holds for a hook of another version too,
    // and for Codex, whose events carry the same `permission_mode` (`bypassPermissions` under approval policy `never`).
    if (e.permission_mode !== undefined && UNATTENDED_MODES.has(e.permission_mode)) {
      this.d.audit("approval_skipped", { ref: e.session_id, tool: e.tool_name, reason: "unattended_mode", mode: e.permission_mode });
      once({ v: 1, decision: null, why: "unattended_mode" });
      return () => {};
    }
    const mapping = agent === "codex" ? mapCodexRequest(e) : mapRequest(e);
    if (!mapping) {
      this.d.audit("approval_skipped", { ref: e.session_id, tool: e.tool_name, reason: "no_card_shape" });
      once({ v: 1, decision: null, why: "no_card_shape" });
      return () => {};
    }
    return this.put({ agent, configDir, ref: e.session_id, cwd: e.cwd, tool: e.tool_name, input: canon(e.tool_input), toolUseId: null, mapping, waitMs: this.d.ttlMs }, once, () => done);
  }

  /**
   * A Cursor before-hook asks (cursor-approvals.ts). A call Cursor would not ask about is answered at once with no decision;
   * any other is put on the phone for up to `holdMs` (Cursor waits that long), then left to Cursor's own question.
   */
  async askCursor(raw: Record<string, unknown>, configDir: string, holdMs: number, reply: (r: ConnectorReply) => void): Promise<() => void> {
    let done = false;
    const once = (r: ConnectorReply) => { if (!done) { done = true; reply(r); } };
    const e = parseCursorEvent(raw);
    if (!e) { once({ v: 1, decision: null, why: "not_a_cursor_request" }); return () => {}; }
    const rules = (this.d.cursorRules ?? loadCursorRules)(configDir, e.workspaceRoots);
    if (!cursorWouldAsk(e, rules)) { once({ v: 1, decision: null, why: "cursor_would_not_ask" }); return () => {}; }
    const mapping = mapCursorRequest(e);
    const tool = e.event === "beforeShellExecution" ? "Shell" : `MCP:${e.tool}`;
    const input = canon(e.event === "beforeShellExecution" ? e.command : e.args);
    // The hold the hook's entry names, within the bounds `hooks install --hold` takes (a value from the socket is never trusted further).
    const waitMs = holdMs >= CURSOR_HOLD_MIN_S * 1000 && holdMs <= CURSOR_HOLD_MAX_S * 1000
      ? Math.min(Math.round(holdMs), this.d.ttlMs)
      : Math.min(CURSOR_HOLD_DEFAULT_S * 1000, this.d.ttlMs);
    return this.put({ agent: "cursor", configDir, ref: e.ref, cwd: e.cwd, tool, input, toolUseId: e.toolUseId, mapping, waitMs }, once, () => done);
  }

  /** Open (or find) the conversation's Claw session, put the request's cards on it and wait for them to be settled. */
  private async put(
    q: { agent: HookAgent; configDir: string; ref: string; cwd: string; tool: string; input: string; toolUseId: string | null; mapping: Mapping; waitMs: number },
    once: (r: ConnectorReply) => void, isDone: () => boolean,
  ): Promise<() => void> {
    const { mapping } = q;
    // The conversation is at work again (a background task woke it): an end said before is not the end any more.
    this.dropEnding(q.ref, "asked");
    const title = oneLine(path.basename(q.cwd), 80) || q.cwd;
    const opened = await this.d.openSession({ agent: q.agent, configDir: q.configDir, ref: q.ref, cwd: q.cwd, title }).catch((err: unknown) => ({ refused: `open_failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) }));
    if ("refused" in opened) {
      this.d.audit("approval_not_sent", { ref: q.ref, tool: q.tool, reason: opened.refused });
      once({ v: 1, decision: null, why: opened.refused });
      return () => {};
    }
    if (isDone()) return () => {};
    const sid = opened.sessionId;
    this.started(sid, q.ref, title, q.agent, q.cwd);
    const p: Pending = {
      id: randomUUID(), ref: q.ref, sessionId: sid, tool: q.tool, input: q.input, toolUseId: q.toolUseId, mapping,
      cards: mapping.cards.map((spec) => ({ actionId: randomUUID(), spec, chosen: null })),
      reply: once,
      timer: setTimeout(() => this.settle(p, null, "timeout"), q.waitMs),
    };
    p.timer.unref?.();
    this.pending.set(p.id, p);
    for (const c of p.cards) {
      this.byAction.set(c.actionId, p);
      this.d.emit(sid, "permissionRequest", {
        actionId: c.actionId, tool: c.spec.tool, kind: c.spec.kind, input: c.spec.input, toolCallId: null, options: c.spec.options,
        timeout_ms: q.waitMs, origin: "terminal_hook", cwd: q.cwd,
        // Cursor asks at the terminal only once the card is answered or its time is up (cursor-approvals.ts), not meanwhile.
        ...(q.agent === "cursor" ? { terminal_asks: "after_card" } : {}),
        // Codex shows its own prompt once the owner types at the terminal (approval-hook.ts), not as soon as it asks.
        ...(q.agent === "codex" ? { terminal_asks: "on_input" } : {}),
        ...(c.spec.questionCount ? { question_index: c.spec.questionIndex, question_count: c.spec.questionCount } : {}),
      });
    }
    this.d.audit("approval_requested", { session_id: sid, ref: q.ref, agent: q.agent, tool: q.tool, actions: p.cards.map((c) => c.actionId) });
    // The hook went away (SIGTERM: the terminal's answer interrupted the turn): settled as answered there.
    return () => this.settle(p, null, "terminal");
  }

  /** The conversation's Claw session is known to be `sid`: said once, as the session's start. */
  private started(sid: string, ref: string, title: string, agent: HookAgent, cwd: string): void {
    if (this.sessions.get(ref) === sid) return;
    this.sessions.set(ref, sid);
    this.owned.add(sid);
    // Not `read_only`: Claw refuses a decision on a read-only session. What makes it carry nothing but cards is its origin.
    this.d.emit(sid, "session_started", { origin: "terminal_hook", ref, title, agent, cwd });
  }

  /** The owner chose `optionId` on card `actionId`. False when no card waits under that id or the option was not offered. */
  decide(actionId: string, optionId: string, by: string | null): boolean {
    const p = this.byAction.get(actionId);
    const card = p?.cards.find((c) => c.actionId === actionId);
    if (!p || !card || card.chosen !== null || !card.spec.options.some((o) => o.optionId === optionId)) {
      this.d.audit("decision_refused", { action_id: actionId, option_id: optionId, reason: p ? "option_not_offered" : "unknown_action" });
      return false;
    }
    card.chosen = optionId;
    this.byAction.delete(actionId);
    this.d.emit(p.sessionId, "permission_resolved", { actionId, optionId, by: by ?? "phone" });
    this.d.audit("permission_resolved", { session_id: p.sessionId, action_id: actionId, option_id: optionId, by: by ?? "phone" });
    // A question asked as several cards is answered once all of them are.
    if (p.cards.some((c) => c.chosen === null)) return true;
    const decision = p.mapping.decide(p.cards.map((c) => c.chosen!));
    this.settle(p, decision, "phone");
    return true;
  }

  /**
   * An event that follows an answer in the terminal. A tool's result settles the waiting request for the same call; a new
   * prompt, a turn's end or the session's end settles every request of that conversation.
   */
  settled(raw: Record<string, unknown>, from: { agent?: HookAgent; configDir?: string; tty?: unknown } = {}): void {
    if (!isObject(raw)) return;
    if (typeof raw.conversation_id === "string") { this.settledCursor(raw); return; }
    if (typeof raw.session_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.session_id)) return;
    const ref = raw.session_id;
    const event = raw.hook_event_name;
    const mine = [...this.pending.values()].filter((p) => p.ref === ref);
    if (event === "PostToolUse" || event === "PostToolUseFailure" || event === "PermissionDenied") {
      const tool = typeof raw.tool_name === "string" ? raw.tool_name : "";
      const input = canon(raw.tool_input);
      const hit = mine.find((p) => p.tool === tool && p.input === input) ?? (MATCH_BY_NAME.has(tool) ? mine.find((p) => p.tool === tool) : undefined);
      if (hit) this.settle(hit, null, "terminal");
    } else if (event === "UserPromptSubmit" || event === "Stop" || event === "StopFailure" || event === "SessionEnd") {
      for (const p of mine) this.settle(p, null, "terminal");
    }
    // A new prompt or the end of the conversation: someone is at the terminal, and an end not yet told is not news to them.
    if (event === "SessionEnd") {
      const gone = { ended: true as const, closed: this.sessions.get(ref) };
      const e = this.endings.get(ref);
      if (e && !e.gone) e.gone = gone;
      for (const o of this.opening) if (o.ref === ref && !o.gone) o.gone = gone;
    }
    if (event === "SessionEnd") { this.dropEnding(ref, "terminal_active"); this.dropHeld(ref, "terminal_active"); }
    if (event === "UserPromptSubmit") this.holdEnding(ref);
    if (event === "Stop" || event === "StopFailure") this.turnEnded(raw, ref, from);
    if (event === "SessionEnd") this.ended(ref);
  }

  /**
   * A turn ended in a terminal (Claude Code's `Stop` or `StopFailure`, Codex's `Stop`). Its owner is told (a `terminal_turn_end`
   * event on the conversation's Claw session, which Claw puts to them) only once the terminal has had no input for `awayMs` since:
   * someone who stayed at it saw the end there. Not told at all when the hook could not name the terminal (nobody can tell whether
   * a person is at it), when a chat follows the conversation (it shows the end itself), when a newer turn a person started ended
   * (that one is told instead), or when a new prompt a person typed or the end of the conversation came first. A `Stop` that leaves
   * background work running is not an end: Claude Code wakes the conversation again when that work finishes.
   *
   * The end says who started the turn (`origin`, from the transcript; turn-origin.ts), so Claw pushes only the ends of turns a
   * person started (or that ask the person something) and gathers the others into a summary. The end of a turn nobody typed
   * carries the ends before it that were not told yet (folded: `turns`, `earlier`), so the summary misses none of them.
   */
  private turnEnded(raw: Record<string, unknown>, ref: string, from: { agent?: HookAgent; configDir?: string; tty?: unknown }): void {
    const agent = from.agent ?? "claude";
    const failed = raw.hook_event_name === "StopFailure";
    const skip = (reason: string) => { this.d.audit("turn_end_not_sent", { ref, agent, reason }); };
    if (agent === "cursor") { this.dropEnding(ref, "superseded"); this.dropHeld(ref, "superseded"); return; }
    const origin = agent === "claude" && from.configDir ? turnOrigin(raw.transcript_path, from.configDir, ref) : null;
    // Background work still runs: the turn goes on when it finishes, and what waits to be told waits for that end.
    if (!failed && Array.isArray(raw.background_tasks) && raw.background_tasks.length > 0) { this.holdEnding(ref); skip("background_tasks"); return; }
    const prev = this.endings.get(ref) ?? this.held.get(ref);
    const fold = origin === "automation" && prev !== undefined && !prev.gone;
    if (fold) {
      clearTimeout(prev.timer);
      if (this.endings.get(ref) === prev) this.endings.delete(ref);
      this.held.delete(ref);
      this.d.audit("turn_end_not_sent", { ref, agent: prev.agent, reason: "folded" });
    } else {
      this.dropEnding(ref, "superseded");
      this.dropHeld(ref, "terminal_active");
    }
    const tty = typeof from.tty === "string" && TTY_RE.test(from.tty) ? from.tty : null;
    if (!tty) { skip("no_terminal"); return; }
    const cwd = typeof raw.cwd === "string" && path.isAbsolute(raw.cwd) ? raw.cwd : null;
    if (!cwd || !from.configDir) { skip("no_folder"); return; }
    const error = failed ? (typeof raw.error === "string" && ERROR_RE.test(raw.error) ? raw.error : "unknown") : null;
    const said = typeof raw.last_assistant_message === "string" ? raw.last_assistant_message : "";
    const at = Date.now();
    const earlier = fold ? [...prev.earlier, ...(prev.message ? [cutEnd(prev.message, TURN_END_EARLIER_CHARS)] : [])].slice(-TURN_END_EARLIER_MAX) : [];
    const earlierFailed = fold ? [...prev.earlierFailed, ...(prev.message ? [prev.outcome === "error"] : [])].slice(-TURN_END_EARLIER_MAX) : [];
    const since = fold ? prev.since : at;
    // A run that started with a person's turn stays theirs: that turn's end is in it, and it is told as theirs.
    const runOrigin: TurnOrigin | null = fold && prev.origin !== "automation" ? "person" : origin;
    const wait = at - since >= (this.d.runMaxMs ?? TURN_END_RUN_MAX_MS) ? 0 : this.d.awayMs ?? TURN_END_AWAY_MS;
    const e: Ending = {
      ref, agent, configDir: from.configDir, cwd, tty, at, outcome: failed ? "error" : "done", error,
      message: cutEnd(said, TURN_END_MESSAGE_MAX), origin: runOrigin, turns: fold ? prev.turns + 1 : 1, earlier, earlierFailed, since,
      failedEarlier: fold ? prev.failedEarlier + (prev.outcome === "error" ? 1 : 0) : 0,
      askedEarlier: fold ? prev.askedEarlier + (prev.outcome !== "error" && turnAsksPerson(prev.message) ? 1 : 0) : 0,
      timer: setTimeout(() => { void this.tellEnding(e); }, wait),
    };
    e.timer.unref?.();
    this.endings.set(ref, e);
  }

  /** A new prompt (or background work) came before the end was told: it waits for the end of that turn (`turnEnded`). */
  private holdEnding(ref: string): void {
    const e = this.endings.get(ref);
    if (!e) return;
    clearTimeout(e.timer);
    this.endings.delete(ref);
    this.dropHeld(ref, "superseded");
    this.held.set(ref, e);
    this.d.audit("turn_end_held", { ref, agent: e.agent });
  }

  private dropHeld(ref: string, reason: string): void {
    const e = this.held.get(ref);
    if (!e) return;
    this.held.delete(ref);
    this.d.audit("turn_end_not_sent", { ref, agent: e.agent, reason });
  }

  private dropEnding(ref: string, reason: string): void {
    const e = this.endings.get(ref);
    if (!e) return;
    clearTimeout(e.timer);
    this.endings.delete(ref);
    this.d.audit("turn_end_not_sent", { ref, agent: e.agent, reason });
  }

  /**
   * The time is up for a turn's end: told, unless someone typed in that terminal since, or a chat follows the conversation now.
   * The end stays listed while Claw opens the session, so a new prompt, a newer end, a question or a stop in that time still takes
   * it back; and the terminal and the chat are looked at again once the session is open, just before it is told.
   */
  private async tellEnding(e: Ending): Promise<void> {
    if (this.endings.get(e.ref) !== e) return;
    const skip = (reason: string) => {
      if (this.endings.get(e.ref) === e) this.endings.delete(e.ref);
      this.d.audit("turn_end_not_sent", { ref: e.ref, agent: e.agent, reason });
    };
    /** Why nobody is to be told now, or the terminal's last input when the owner is still away. */
    const away = (): { last: number } | { not: string } => {
      const last = (this.d.lastInputMs ?? ttyLastInputMs)(e.tty);
      // (a terminal that is gone was closed: by its person, who is not away)
      if (last === null) return { not: "terminal_gone" };
      if (last > e.at) return { not: "terminal_input" };
      if (this.d.attached?.(e.ref)) return { not: "attached" };
      return { last };
    };
    const before = away();
    if ("not" in before) { skip(before.not); return; }
    const title = oneLine(path.basename(e.cwd), 80) || e.cwd;
    this.opening.add(e);
    const opened = await this.d.openSession({ agent: e.agent, configDir: e.configDir, ref: e.ref, cwd: e.cwd, title })
      .catch((err: unknown) => ({ refused: `open_failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) }))
      .finally(() => { this.opening.delete(e); });
    // Taken back while the session was opening (dropEnding said why), or forgotten by a stop: nothing is told.
    if (this.endings.get(e.ref) !== e) { if (!("refused" in opened)) this.unused(e, opened.sessionId, title); return; }
    if ("refused" in opened) { skip(opened.refused); return; }
    const now = away();
    if ("not" in now) { skip(now.not); this.unused(e, opened.sessionId, title); return; }
    this.endings.delete(e.ref);
    this.started(opened.sessionId, e.ref, title, e.agent, e.cwd);
    this.d.emit(opened.sessionId, REMOTE_EVENT_TERMINAL_TURN_END, {
      ref: e.ref, outcome: e.outcome, ...(e.error ? { error: e.error } : {}), message: e.message, agent: e.agent, cwd: e.cwd,
      ended_at: new Date(e.at).toISOString(), away_ms: Math.max(0, Date.now() - now.last),
      ...(e.origin ? { origin: e.origin } : {}),
      ...(e.turns > 1 ? { turns: e.turns, earlier: e.earlier, since: new Date(e.since).toISOString() } : {}),
      ...(e.failedEarlier > 0 ? { failed_earlier: e.failedEarlier } : {}),
      // Which of `earlier` are the words of a turn that failed (their positions), so Claw can quote the failure itself.
      ...(e.turns > 1 && e.earlierFailed.some(Boolean) ? { earlier_failed: e.earlierFailed.flatMap((f, i) => (f ? [i] : [])) } : {}),
      ...(e.askedEarlier > 0 ? { asked_earlier: e.askedEarlier } : {}),
    });
    this.d.audit("turn_end_sent", { session_id: opened.sessionId, ref: e.ref, agent: e.agent, outcome: e.outcome });
  }

  /**
   * A session Claw opened for an end that is not told after all is not left open with nobody to close it: when the
   * conversation has ended meanwhile it is closed (unless the end of the conversation closed it already); otherwise it is the
   * conversation's session from now on, so its end closes it, and a later question finds it rather than opening another.
   * A connector that is stopping says nothing more.
   */
  private unused(e: Ending, sid: string, title: string): void {
    if (e.gone && "stopped" in e.gone) return;
    if (e.gone && "ended" in e.gone) {
      if (e.gone.closed !== sid) this.d.emit(sid, "session_closed", { reason: "terminal_ended" });
      return;
    }
    this.started(sid, e.ref, title, e.agent, e.cwd);
  }

  /**
   * A Cursor event after a call or a turn: the call's result (or failure) settles the request for that call; a new prompt or the
   * turn's end (Ctrl-C at the terminal ends it while the hook still waits) settles every request of the conversation; the
   * session's end also closes its Claw session.
   */
  private settledCursor(raw: Record<string, unknown>): void {
    const ref = String(raw.conversation_id);
    const event = raw.hook_event_name;
    const mine = [...this.pending.values()].filter((p) => p.ref === ref);
    if (event === "afterShellExecution" || event === "afterMCPExecution" || event === "postToolUseFailure") {
      const id = typeof raw.tool_use_id === "string" ? raw.tool_use_id : null;
      const hit = (id ? mine.find((p) => p.toolUseId === id) : undefined)
        ?? (event === "afterShellExecution" ? mine.find((p) => p.tool === "Shell" && p.input === canon(raw.command)) : undefined);
      if (hit) this.settle(hit, null, "terminal");
    } else if (event === "beforeSubmitPrompt" || event === "stop" || event === "sessionEnd") {
      for (const p of mine) this.settle(p, null, "terminal");
    }
    if (event === "sessionEnd") this.ended(ref);
  }

  /** The conversation ended in the terminal: its Claw session is closed. */
  private ended(ref: string): void {
    const sid = this.sessions.get(ref);
    if (!sid) return;
    this.sessions.delete(ref);
    this.owned.delete(sid);
    this.d.emit(sid, "session_closed", { reason: "terminal_ended" });
  }

  /** A close from Claw: its waiting requests go back to the terminal, and the next request opens a session again. */
  close(sessionId: string): void {
    for (const p of [...this.pending.values()]) if (p.sessionId === sessionId) this.settle(p, null, "session_end");
    for (const [ref, sid] of this.sessions) if (sid === sessionId) this.sessions.delete(ref);
    this.owned.delete(sessionId);
    this.d.emit(sessionId, "session_closed", { reason: "closed" });
  }

  /** The connector is stopping: every waiting hook is let go (the terminal still asks), every card withdrawn. */
  stopAll(): void {
    for (const p of [...this.pending.values()]) this.settle(p, null, "connector_restart");
    for (const e of this.endings.values()) { clearTimeout(e.timer); e.gone = { stopped: true }; }
    for (const e of this.opening) e.gone = { stopped: true };
    this.endings.clear();
    this.held.clear();
  }

  private settle(p: Pending, decision: AnyDecision | null, by: string): void {
    if (this.pending.get(p.id) !== p) return;
    this.pending.delete(p.id);
    clearTimeout(p.timer);
    for (const c of p.cards) {
      if (c.chosen !== null) continue;
      this.byAction.delete(c.actionId);
      this.d.emit(p.sessionId, "permission_resolved", { actionId: c.actionId, optionId: null, outcome: "cancelled", by });
    }
    if (by !== "phone") this.d.audit("approval_withdrawn", { session_id: p.sessionId, by, actions: p.cards.map((c) => c.actionId) });
    p.reply({ v: 1, decision, ...(decision ? {} : { why: by }) });
  }
}

/**
 * Serve the hooks on a unix socket in `stateDir`. Only this user can enter the state directory (it is created 0700 and
 * checked), and the socket is 0600. Returns a function that closes it.
 */
export async function serveApprovals(stateDir: string, broker: ApprovalBroker, configDirOf: (raw: Record<string, unknown>) => string, log: (msg: string, detail?: Record<string, unknown>) => void): Promise<() => Promise<void>> {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(stateDir);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${stateDir} is not owned by this user`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(stateDir, st.mode & 0o700);
  const file = approvalSocketFile(stateDir);
  fs.rmSync(file, { force: true });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sock.destroy());
    let buf = "";
    let handled = false;
    let gone: (() => void) | null = null;
    sock.on("close", () => { gone?.(); });
    sock.on("data", (chunk) => {
      if (handled) return;
      buf += chunk.toString("utf8");
      if (Buffer.byteLength(buf) > MAX_LINE_BYTES) { handled = true; sock.destroy(); return; }
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      handled = true;
      let msg: unknown;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch { sock.destroy(); return; }
      if (!isObject(msg) || msg.v !== 1 || !isObject(msg.event)) { sock.destroy(); return; }
      const event = msg.event;
      if (msg.type === "settled") {
        const agent = msg.agent === "codex" ? "codex" : msg.agent === "cursor" ? "cursor" : "claude";
        broker.settled(event, { agent, configDir: configDirOf(msg as Record<string, unknown>), tty: msg.tty });
        sock.end();
        return;
      }
      if (msg.type !== "ask") { sock.destroy(); return; }
      const onReply = (r: ConnectorReply) => {
        gone = null;
        if (!sock.destroyed) sock.end(`${JSON.stringify(r)}\n`);
      };
      const asked = msg.agent === "cursor"
        ? broker.askCursor(event, configDirOf(msg as Record<string, unknown>), Number(msg.hold_ms), onReply)
        : broker.ask(event, configDirOf(msg as Record<string, unknown>), onReply, msg.agent === "codex" ? "codex" : "claude");
      void asked.then((cancel) => {
        if (sock.destroyed) cancel(); else gone = cancel;
      }, (err: unknown) => {
        log("an approval request failed", { error: err instanceof Error ? err.message : String(err) });
        if (!sock.destroyed) sock.end(`${JSON.stringify({ v: 1, decision: null, why: "error" })}\n`);
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(file, () => { server.off("error", reject); resolve(); });
  });
  fs.chmodSync(file, 0o600);
  return async () => {
    broker.stopAll();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(file, { force: true });
  };
}
