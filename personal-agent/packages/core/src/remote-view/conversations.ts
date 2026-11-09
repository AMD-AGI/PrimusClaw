// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The conversations an agent offers to take over or share (`capabilities.resumable`, as its connector reports them), and the
 * folder a new session starts in.
 */
import { neutral } from "./inert.js";
import { RESUMABLE_READ_MAX, RESUME_REF_MAX, ROOT_MAX, SUBFOLDER_MAX, WAITING_FOR_MAX } from "./limits.js";
import { hasControl, length, strip } from "./py-text.js";
import type { RemoteAgent } from "./pending-model.js";
import { type Reported, list, objOrNull } from "./reported.js";

/** What a connector says about a conversation: no process runs it, a terminal has it open, a session of the chat's holds it. */
export type ConversationState = "idle" | "live" | "attached" | "unknown";
/** What a connector says a terminal is doing with a conversation it has open. */
export type TerminalActivity = "working" | "waiting" | "idle";

/** One conversation an agent offers, read defensively. */
export interface Conversation {
  readonly ref: string;
  /** One inert line, "" when the connector gave none. */
  readonly title: string;
  readonly cwd: string;
  /** Seconds since the epoch, or null. */
  readonly updatedAt: number | null;
  readonly state: ConversationState;
  /** Only for one a terminal has open. */
  readonly activity?: TerminalActivity;
  /** What its terminal waits for (only while `activity` is waiting), one inert line. */
  readonly waitingFor?: string;
  /** Its connector types what is sent into that terminal (only for one a terminal has open). */
  readonly input?: "terminal";
}

/** What a connector says about a conversation that may be taken over now. */
export const TAKEOVER_STATES: readonly ConversationState[] = ["idle", "attached"];
/** Open in a terminal: it can be watched, read-only (the connector shows it and refuses input). */
export const WATCH_STATE: ConversationState = "live";
const STATES = new Set<string>(["idle", "live", "attached"]);
const ACTIVITIES = new Set<string>(["working", "waiting", "idle"]);

function usableRef(ref: unknown): ref is string {
  return typeof ref === "string" && ref.length > 0 && length(ref) <= RESUME_REF_MAX && !hasControl(ref);
}

function usableCwd(cwd: unknown): cwd is string {
  return typeof cwd === "string" && strip(cwd) !== "" && length(cwd) <= ROOT_MAX && !hasControl(cwd);
}

function terminalFacts(item: Reported, state: ConversationState): Partial<Conversation> {
  if (state !== WATCH_STATE) return {};
  const facts: { activity?: TerminalActivity; waitingFor?: string; input?: "terminal" } = {};
  const activity = item["activity"];
  if (typeof activity === "string" && ACTIVITIES.has(activity)) {
    facts.activity = activity as TerminalActivity;
    const why = activity === "waiting" ? neutral(item["waiting_for"], WAITING_FOR_MAX) : "";
    if (why) facts.waitingFor = why;
  }
  if (item["input"] === "terminal") facts.input = "terminal";
  return facts;
}

/** The conversations an agent offers (newest first, as reported), at most twelve. An entry without a usable `ref` or `cwd` is
 * dropped, a repeated ref is kept once, and a state that is none of the four is "unknown". */
export function resumableOf(agent: RemoteAgent): Conversation[] {
  const entries: Conversation[] = [];
  for (const raw of list(agent.capabilities["resumable"])) {
    const item = objOrNull(raw);
    if (!item) continue;
    const { ref, cwd } = item;
    if (!usableRef(ref) || !usableCwd(cwd) || entries.some((e) => e.ref === ref)) continue;
    const when = item["updated_at"];
    const rawState = item["state"];
    const state: ConversationState =
      typeof rawState === "string" && STATES.has(rawState) ? (rawState as ConversationState) : "unknown";
    entries.push({
      ref,
      title: neutral(item["title"], 80),
      cwd,
      updatedAt: typeof when === "number" ? when : null,
      state,
      ...terminalFacts(item, state),
    });
  }
  return entries.slice(0, RESUMABLE_READ_MAX);
}

/** Its terminal waits for its person. */
export function needsYou(entry: Conversation): boolean {
  return entry.activity === "waiting";
}

const DRIVE = /^[A-Za-z]:/;

/** A subfolder typed under a root as `a/b` (separators `/` or `\`, `.` parts dropped); "" when nothing was typed; null for anything
 * that is not a plain path below the root: absolute, `~`, a drive, a `..` part, a control character, too long. */
export function cleanSubfolder(text: unknown): string | null {
  const sub = strip(typeof text === "string" ? text : "");
  if (!sub) return "";
  if (length(sub) > SUBFOLDER_MAX || hasControl(sub) || "/\\~".includes(sub.charAt(0)) || DRIVE.test(sub)) return null;
  const parts = sub.split(/[\\/]+/).filter((p) => p && p !== ".");
  return parts.includes("..") ? null : parts.join("/");
}

/** `root` with `sub` below it, with the separator the root itself uses. */
export function joinPath(root: string, sub: string): string {
  if (!sub) return root;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.replace(/[/\\]+$/, "") + sep + sub.replaceAll("/", sep);
}
