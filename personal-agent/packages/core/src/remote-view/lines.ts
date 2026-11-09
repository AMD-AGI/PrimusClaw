// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The one-line messages of a chat attached to a remote session: where it is, what happened, what a refusal means. */
import type { Lang } from "../locales/lang.js";
import { remoteQueuedText, remoteStopText, remoteText } from "../locales/remote.js";
import { inertLinks, neutral, masked as redactText } from "./inert.js";
import { TYPED_LINES_MAX } from "./limits.js";
import { pyStr, rstrip, slice, splitlines, squash, strip } from "./py-text.js";

/** What Claw writes for an instruction or a start its machine never got (a reason code, said by the connector reasons). */
export const NOT_DELIVERED = "not_delivered";
/** ... or, when Claw cannot tell (the machine was alive moments before it was queued): it may have run. */
export const DELIVERY_UNCONFIRMED = "delivery_unconfirmed";
/** The connector's and Claw's refusal of input to a watched session. */
export const READ_ONLY_REASONS: readonly string[] = ["read_only_live_session", "session_read_only"];
/** A watched conversation's terminal let it go: the watch is over. */
export const TERMINAL_CLOSED = "terminal_closed";
/** The connector's own word for a turn it ended because it restarted. */
export const CONNECTOR_RESTARTED = "connector_restarted";

/** A terminal's permission modes in which Claude Code acts without asking, and what they are called. */
export const NO_ASK_MODES: Readonly<Record<string, string>> = {
  bypassPermissions: "bypass permissions",
  auto: "auto",
  acceptEdits: "accept edits",
  dontAsk: "don't ask",
};

/** The warning for a terminal whose mode does not ask, or null for one that asks (or whose mode is not known). */
export function noAskLine(mode: string | null, lang: Lang): string | null {
  const name = mode && Object.hasOwn(NO_ASK_MODES, mode) ? NO_ASK_MODES[mode] : undefined;
  return name === undefined ? null : remoteText.in(lang).noAsk({ name });
}

export type StopReason = "cancelled" | "max_tokens" | "max_turn_requests" | "refusal";
const STOP_KEYS = {
  cancelled: "cancelled",
  max_tokens: "maxTokens",
  max_turn_requests: "maxTurnRequests",
  refusal: "refusal",
} as const;

/** Whether `reason` is a way a turn stopped that has a line of its own. */
export function isStopReason(reason: string): reason is StopReason {
  return Object.hasOwn(STOP_KEYS, reason);
}

/** The line for how a turn stopped. */
export function stopNote(reason: StopReason, lang: Lang = "en"): string {
  return remoteStopText.in(lang)[STOP_KEYS[reason]];
}

/** What a new session is called once something was sent to it: its first line, at most 30 characters. */
export function sessionTitle(text: string): string {
  const stripped = strip(text);
  const first = neutral(stripped ? squash(splitlines(stripped)[0] ?? "") : "", 200);
  return Array.from(first).length <= 30 ? first : rstrip(slice(first, 0, 29)) + "…";
}

/** The last part of a folder (`…/repo`), which tells two sessions apart better than the whole path does (inert, for a card). */
export function placeOf(cwd: unknown, lit: (text: unknown, limit: number) => string): string {
  const path = (cwd ? pyStr(cwd) : "").replace(/[/\\]+$/, "");
  const tail = path ? (path.split(/[\\/]/).at(-1) ?? "") : "";
  return lit(tail || path, 40);
}

const SCHEME = /\b(https?):(?=\/\/)/gi;

/** `text` with no address the chat's rich text would make a link by itself (it links a bare `http(s)://...`): a zero-width space
 * after the scheme's colon. */
function noAutolink(text: string): string {
  return text.replace(SCHEME, "$1:\u{200b}");
}

/** How a prompt typed at the terminal shows in the chat: said as the terminal's, quoted, credentials masked, and unable to make a
 * link, an image or a tag, nor an address the rich text links by itself (whoever types at that terminal reaches the chat through the
 * connector: what they typed is shown, never followed). */
export function typedLine(text: string, lang: Lang): string {
  const quoted = splitlines(noAutolink(inertLinks(redactText(strip(text)))))
    .slice(0, TYPED_LINES_MAX)
    .map((line) => (strip(line) ? `> ${line}` : ">"))
    .join("\n");
  return remoteText.in(lang).typedInTerminal({ quoted });
}

type QueuedKey = "terminalWorking" | "terminalWaiting" | "terminalTyping" | "terminalScrolled";
const QUEUED_KEYS: Readonly<Record<string, QueuedKey>> = {
  terminal_working: "terminalWorking",
  terminal_waiting: "terminalWaiting",
  terminal_typing: "terminalTyping",
  terminal_scrolled: "terminalScrolled",
};

/** What a message for a conversation open in a terminal waits for (`terminal_input_queued`). */
export function queuedLine(reason: string, lang: Lang): string {
  const words = remoteQueuedText.in(lang);
  const key = Object.hasOwn(QUEUED_KEYS, reason) ? QUEUED_KEYS[reason] : undefined;
  return `⏳ ${key ? words[key] : words.other}`;
}

/** What a message to a watched session is answered with: it was not sent, and what makes sending possible without taking the
 * conversation from the terminal; `takeover`: the status card also offers Take over…, which ends the terminal's session. */
export function readOnlyRefused(lang: Lang, takeover = false): string {
  const words = remoteText.in(lang);
  return words.readOnly + (takeover ? words.readOnlyTakeoverTail : "");
}

/** The watch is over because the terminal let the conversation go. */
export function terminalClosedLine(lang: Lang): string {
  return remoteText.in(lang).terminalClosed;
}

/** `dev-pod · 🟠 Claude Code`: which session a chat talks to, in one line. */
export function whereLine(label: string, host: string): string {
  return `${neutral(host, 80)} · ${neutral(label, 80)}`;
}

/** The short line a switch leaves in the chat, so that on a phone the two stretches of conversation can be told apart. */
export function switchedLine(label: string, host: string, lang: Lang): string {
  return remoteText.in(lang).switched({ where: whereLine(label, host) });
}

/** What a chat is told, once, when the connector on the machine restarted and its session is back: whether a turn was cut off,
 * and whether the agent goes on with it by itself or waits for a word. */
export function recoveredLine(
  label: string,
  host: string,
  lang: Lang,
  interrupted: boolean,
  continuing: boolean,
): string {
  const words = remoteText.in(lang);
  const where = words.recoveredWhere({ host: neutral(host, 80), label: neutral(label, 80) });
  if (continuing) return words.recoveredContinuing({ where });
  return interrupted ? words.recoveredInterrupted({ where }) : words.recovered({ where });
}

export function backLine(lang: Lang): string {
  return remoteText.in(lang).back;
}

/** Which messages of an attached chat stay with the assistant: said on the status card, where the person looks. */
export function clawyLine(lang: Lang, bot: string): string {
  return remoteText.in(lang).clawyLine({ bot });
}

/** How to connect a machine with the one command line Claw gave (`claw-connector pair`): run it there, it does the rest. */
export function pairText(command: string, minutes: number, lang: Lang, lead = ""): string {
  const body = remoteText.in(lang).pairBody({ command, minutes: String(Math.max(1, Math.trunc(minutes || 10))) });
  return (lead ? `${lead}\n\n` : "") + body;
}

/** The disconnect card's title. */
export function disconnectTitle(host: unknown, lang: Lang = "en"): string {
  return remoteText.in(lang).disconnectTitle({ host: neutral(host, 80) });
}

/** What the disconnect card becomes once the machine is disconnected. A paired machine is told only the pairing way back. */
export function disconnectedText(host: unknown, login: string, lang: Lang = "en", paired = false): string {
  const words = remoteText.in(lang);
  if (paired) return words.disconnectedPaired({ host: neutral(host, 80) });
  return words.disconnected({ host: neutral(host, 80), login });
}
