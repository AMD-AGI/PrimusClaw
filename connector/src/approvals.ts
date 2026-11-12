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
 * Nothing here can approve anything by itself: a request is answered only with an option the card offered, chosen by the owner
 * (a `decision` command from Claw), and a request that cannot be put on a card, or that meets a connector without Claw, is
 * left to the terminal at once. Claude Code's own deny and ask rules are still applied after a hook allows a call.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { type CursorDecision, type CursorRules, cursorWouldAsk, loadCursorRules, mapCursorRequest, parseCursorEvent } from "./cursor-approvals.js";
import { boundedInput, type OfferedOption } from "./permissions.js";
import { redactDeep } from "./redact.js";

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
  | { v: 1; type: "ask"; event: Record<string, unknown>; agent?: "claude" | "cursor"; hold_ms?: number }
  | { v: 1; type: "settled"; event: Record<string, unknown>; agent?: "claude" | "cursor" };
export type ConnectorReply = { v: 1; decision: AnyDecision | null; why?: string };

/** Which coding agent's hooks a request came from. */
export type HookAgent = "claude" | "cursor";

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

  constructor(private readonly d: BrokerDeps) {}

  /** Whether a Claw session is one of these (its commands come here, not to an agent). */
  owns(sessionId: string): boolean { return this.owned.has(sessionId); }

  get size(): number { return this.pending.size; }

  /**
   * A hook asks. `reply` is called exactly once. `configDir` is the Claude config directory the hook was installed for, which
   * says which agent the conversation belongs to.
   */
  async ask(raw: Record<string, unknown>, configDir: string, reply: (r: ConnectorReply) => void): Promise<() => void> {
    let done = false;
    const once = (r: ConnectorReply) => { if (!done) { done = true; reply(r); } };
    const e = parsePermissionEvent(raw);
    if (!e) { once({ v: 1, decision: null, why: "not_a_permission_request" }); return () => {}; }
    const mapping = mapRequest(e);
    if (!mapping) {
      this.d.audit("approval_skipped", { ref: e.session_id, tool: e.tool_name, reason: "no_card_shape" });
      once({ v: 1, decision: null, why: "no_card_shape" });
      return () => {};
    }
    return this.put({ agent: "claude", configDir, ref: e.session_id, cwd: e.cwd, tool: e.tool_name, input: canon(e.tool_input), toolUseId: null, mapping, waitMs: this.d.ttlMs }, once, () => done);
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
    const waitMs = Math.min(Math.max(Number.isFinite(holdMs) ? holdMs : 0, 1_000), this.d.ttlMs);
    return this.put({ agent: "cursor", configDir, ref: e.ref, cwd: e.cwd, tool, input, toolUseId: e.toolUseId, mapping, waitMs }, once, () => done);
  }

  /** Open (or find) the conversation's Claw session, put the request's cards on it and wait for them to be settled. */
  private async put(
    q: { agent: HookAgent; configDir: string; ref: string; cwd: string; tool: string; input: string; toolUseId: string | null; mapping: Mapping; waitMs: number },
    once: (r: ConnectorReply) => void, isDone: () => boolean,
  ): Promise<() => void> {
    const { mapping } = q;
    const title = oneLine(path.basename(q.cwd), 80) || q.cwd;
    const opened = await this.d.openSession({ agent: q.agent, configDir: q.configDir, ref: q.ref, cwd: q.cwd, title }).catch((err: unknown) => ({ refused: `open_failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) }));
    if ("refused" in opened) {
      this.d.audit("approval_not_sent", { ref: q.ref, tool: q.tool, reason: opened.refused });
      once({ v: 1, decision: null, why: opened.refused });
      return () => {};
    }
    if (isDone()) return () => {};
    const sid = opened.sessionId;
    if (this.sessions.get(q.ref) !== sid) {
      this.sessions.set(q.ref, sid);
      this.owned.add(sid);
      // Not `read_only`: Claw refuses a decision on a read-only session. What makes it carry nothing but cards is its origin.
      this.d.emit(sid, "session_started", { origin: "terminal_hook", ref: q.ref, title, agent: q.agent, cwd: q.cwd });
    }
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
        ...(c.spec.questionCount ? { question_index: c.spec.questionIndex, question_count: c.spec.questionCount } : {}),
      });
    }
    this.d.audit("approval_requested", { session_id: sid, ref: q.ref, agent: q.agent, tool: q.tool, actions: p.cards.map((c) => c.actionId) });
    // The hook went away (SIGTERM: the terminal's answer interrupted the turn): settled as answered there.
    return () => this.settle(p, null, "terminal");
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
  settled(raw: Record<string, unknown>): void {
    if (!isObject(raw)) return;
    if (typeof raw.conversation_id === "string") { this.settledCursor(raw); return; }
    if (typeof raw.session_id !== "string") return;
    const ref = raw.session_id;
    const event = raw.hook_event_name;
    const mine = [...this.pending.values()].filter((p) => p.ref === ref);
    if (event === "PostToolUse" || event === "PostToolUseFailure" || event === "PermissionDenied") {
      const tool = typeof raw.tool_name === "string" ? raw.tool_name : "";
      const input = canon(raw.tool_input);
      const hit = mine.find((p) => p.tool === tool && p.input === input) ?? (MATCH_BY_NAME.has(tool) ? mine.find((p) => p.tool === tool) : undefined);
      if (hit) this.settle(hit, null, "terminal");
    } else if (event === "UserPromptSubmit" || event === "Stop" || event === "SessionEnd") {
      for (const p of mine) this.settle(p, null, "terminal");
    }
    if (event === "SessionEnd") this.ended(ref);
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
      if (msg.type === "settled") { broker.settled(event); sock.end(); return; }
      if (msg.type !== "ask") { sock.destroy(); return; }
      const onReply = (r: ConnectorReply) => {
        gone = null;
        if (!sock.destroyed) sock.end(`${JSON.stringify(r)}\n`);
      };
      const asked = msg.agent === "cursor"
        ? broker.askCursor(event, configDirOf(msg as Record<string, unknown>), Number(msg.hold_ms), onReply)
        : broker.ask(event, configDirOf(msg as Record<string, unknown>), onReply);
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
