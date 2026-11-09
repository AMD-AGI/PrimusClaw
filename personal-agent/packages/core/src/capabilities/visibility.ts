/** Which capabilities a chat offers: what help shows and what the assistant may ask a chat to do. */
import { words } from "../text/words.js";
import { CAPABILITIES, type Capability, type Part } from "./registry.js";

export interface ChatShape {
  readonly group: boolean;
  readonly assistant: boolean;
  readonly parts: ReadonlySet<Part>;
  readonly understanding?: boolean;
}

/** Whether help shows `c` in this chat: a group shows what works in a group, a 1:1 chat what works there. */
export function shown(c: Capability, chat: ChatShape): boolean {
  if (c.category === "" || (c.needs !== "" && !chat.parts.has(c.needs))) return false;
  if ((chat.group && c.where === "dm") || (!chat.group && c.where === "group")) return false;
  if (c.mode === "understanding") return (chat.understanding ?? false) && !chat.group;
  if (chat.group) return c.mode !== "assistant"; // a group always has sessions
  return c.mode !== (chat.assistant ? "session" : "assistant");
}

/**
 * What the assistant may never ask a chat to do, whatever a message says: what cannot be undone (/unlink, /github unbind), what binds
 * an account (/link, /github bind), and what loosens a safety setting (/github auto-merge, the confirmation setting).
 */
export const NOT_ACTIONS: ReadonlySet<string> = new Set(["link", "unlink", "github", "review_mode", "unlink_ask"]);

/**
 * `agent` is declared only with these verbs: switching the chat to a session, back, and the list. Starting, closing, a mode that does
 * not ask and disconnecting a machine are the person's own taps.
 */
export const AGENT_ACTION_VERBS = ["attach", "detach", "sessions"] as const;
export const AGENT_ACTION_USAGE =
  "/agent attach MACHINE/AGENT (switch the chat to that agent's session, e.g. /agent attach rohan-dev-pod/claude; " +
  "a session's number or id also works) | /agent detach (back to the assistant) | /agent sessions (every session, " +
  "to tap one)";
const AGENT_ACTION_SUMMARY = "开发环境：切到某台机器上的 agent 会话、回到助理、看会话列表";

/** The arguments of an `agent` action the assistant asked for are one of AGENT_ACTION_VERBS, with at most one reference. */
export function agentActionAllowed(args: string): boolean {
  const parts = words(args);
  const verb = parts[0]?.toLowerCase();
  if (verb === undefined || !(AGENT_ACTION_VERBS as readonly string[]).includes(verb)) return false;
  return parts.length <= (verb === "attach" ? 2 : 1);
}

export interface ChannelAction {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
}

/**
 * The actions a 1:1 chat with the assistant declares: the capabilities marked `action` that this chat shows, as the command the
 * assistant may ask for, how it is written, and what it is for. `agent` is declared once, with one usage line for its verbs.
 */
export function channelActions(parts: ReadonlySet<Part>): ChannelAction[] {
  const out: ChannelAction[] = [];
  const chat: ChatShape = { group: false, assistant: true, parts, understanding: true };
  for (const c of CAPABILITIES) {
    if (!c.action || !shown(c, chat)) continue;
    const name = words(c.reaches)[0] ?? "";
    if (name === "agent") {
      if (!out.some((action) => action.name === name)) {
        out.push({ name, usage: AGENT_ACTION_USAGE, summary: AGENT_ACTION_SUMMARY });
      }
      continue;
    }
    out.push({ name, usage: `/${c.reaches}`, summary: c.zh });
  }
  return out;
}
