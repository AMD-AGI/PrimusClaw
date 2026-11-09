// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The status card of a chat that talks to a remote session: ONE card that says where its messages go (which machine and agent,
 * the folder, whether the agent is working, and when that was last true). It is sent once, when the chat attaches, and after that
 * only edited in place. Its buttons are the system operations (switch, back to the assistant, stop, mode), so the chat itself
 * holds only the conversation with the agent. Every button names the session, which the worker checks against the chat's own.
 */
import type { Lang } from "../locales/lang.js";
import { remoteText } from "../locales/remote.js";
import { type ButtonFields, type RemoteButton, remoteButton } from "./actions.js";
import { lit, plain } from "./inert.js";
import { clawyLine, whereLine } from "./lines.js";
import { strip } from "./py-text.js";
import { utcClock } from "./time.js";

/** Where a chat stands with its session. */
export type StatusPhase = "idle" | "working" | "starting" | "offline" | "detached" | "ended" | "watching";

/** Each line of the status card, by what it says. */
export type StatusLine =
  | { readonly kind: "lead"; readonly text: string }
  /** Where the named conversation runs, under the title. */
  | { readonly kind: "where"; readonly text: string }
  | { readonly kind: "lastSession"; readonly text: string }
  | { readonly kind: "folder"; readonly text: string }
  | { readonly kind: "phase"; readonly text: string }
  | { readonly kind: "unattended"; readonly text: string }
  /** Which messages stay with the assistant. */
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "window"; readonly text: string }
  | { readonly kind: "updated"; readonly text: string };

export interface StatusView {
  readonly lang: Lang;
  readonly title: string;
  /** Attached: the accent band; back at the assistant or ended: none. */
  readonly tone: "accent" | "default";
  /** In order; the lead, when there is one, comes before the title. */
  readonly lines: readonly StatusLine[];
  readonly buttons: readonly RemoteButton[];
  /** The chat's system operations must each stay one tap away: this card alone may carry four. */
  readonly buttonsMax: number;
}

export interface StatusInput {
  /** `icon name` of the agent. */
  readonly label: string;
  readonly host: string;
  readonly cwd: string;
  readonly mode: string | null;
  readonly sessionId: string;
  readonly phase: StatusPhase;
  /** When the phase was last true, seconds since the epoch (shown as UTC, so a phone that did not redraw shows its age). */
  readonly at: number;
  readonly lang?: Lang;
  /** The agent said its modes: Mode is offered. */
  readonly hasModes?: boolean;
  readonly unattended?: boolean;
  readonly lead?: string;
  /** The title of the conversation the chat joined, "" for none. */
  readonly conversation?: string;
  /** What Take over… carries, for a watched conversation the connector can take over; null for none. */
  readonly takeover?: ButtonFields | null;
  /** The link to the same session in a page of its own, "" for none. */
  readonly page?: string;
  /** What is sent is typed into a terminal on the machine, so Stop says it interrupts the turn running there. */
  readonly terminal?: boolean;
  /** The assistant's display name. */
  readonly bot: string;
}

const PHASE_WORDS = {
  idle: "phaseIdle",
  working: "phaseWorking",
  starting: "phaseStarting",
  offline: "phaseOffline",
  watching: "phaseWatching",
} as const;

function phaseWords(phase: StatusPhase, lang: Lang): string {
  // (said only while attached: no words for detached/ended)
  return Object.hasOwn(PHASE_WORDS, phase) ? remoteText.in(lang)[PHASE_WORDS[phase as keyof typeof PHASE_WORDS]] : phase;
}

/** One small line with the link to open a session (or the list) in a window of its own; null with no link. */
export function windowText(url: string, lang: Lang, listing = false): string | null {
  if (!url) return null;
  const words = remoteText.in(lang);
  return listing ? words.openSessionsWindow({ url }) : words.openWindow({ url });
}

function titleOf(input: StatusInput, attached: boolean, named: string, where: string): string {
  const words = remoteText.in(input.lang ?? "en");
  if (input.phase === "watching") return words.titleWatching({ where });
  if (attached && named) return words.titleExisting({ named });
  if (attached) return words.titleConnected({ where });
  return input.phase === "detached" ? words.titleDetached : words.titleEnded;
}

function linesOf(input: StatusInput, attached: boolean, named: string, where: string): StatusLine[] {
  const lang = input.lang ?? "en";
  const words = remoteText.in(lang);
  const lines: StatusLine[] = input.lead ? [{ kind: "lead", text: input.lead }] : [];
  // (the title names the conversation: where it runs is the line under it)
  if (attached && named && input.phase !== "watching") lines.push({ kind: "where", text: plain(where) });
  if (!attached) lines.push({ kind: "lastSession", text: plain(words.lastSession({ where })) });
  const folder = lit(input.cwd, 120) + (input.mode ? words.modeSuffix({ mode: lit(input.mode, 40) }) : "");
  if (strip(folder)) lines.push({ kind: "folder", text: folder });
  if (attached) lines.push({ kind: "phase", text: words.status + phaseWords(input.phase, lang) });
  if (input.unattended && attached) lines.push({ kind: "unattended", text: words.unattendedNote });
  if (attached) lines.push({ kind: "assistant", text: clawyLine(lang, input.bot) });
  const window = attached ? windowText(input.page ?? "", lang) : null;
  if (window) lines.push({ kind: "window", text: window });
  lines.push({ kind: "updated", text: words.updated({ stamp: utcClock(input.at) }) });
  return lines;
}

function buttonsOf(input: StatusInput, attached: boolean): RemoteButton[] {
  const words = remoteText.in(input.lang ?? "en");
  const session = { session_id: input.sessionId };
  if (!attached) {
    const back = input.phase === "detached" ? [remoteButton(words.goBackToIt, "attach", "positive", session)] : [];
    return [...back, remoteButton(words.sessions, "switch", null, session)];
  }
  const buttons = [
    remoteButton(words.switch, "switch", null, session),
    remoteButton(words.backToAssistant, "detach", null, session),
  ];
  if (input.phase === "watching") {
    // (nothing here can act on a conversation that is only watched: no Stop, no Mode; but it can be taken over)
    if (input.takeover) buttons.push(remoteButton(words.takeOverConfirm, "takeover", null, input.takeover));
    return buttons;
  }
  buttons.push(remoteButton(input.terminal ? words.stopTerminal : words.stop, "stop", null, session));
  if (input.hasModes) buttons.push(remoteButton(words.mode, "mode", null, session));
  return buttons;
}

/** The chat's status card as a view. */
export function statusView(input: StatusInput): StatusView {
  const attached = input.phase !== "detached" && input.phase !== "ended";
  const named = lit(input.conversation ?? "", 80);
  const where = whereLine(input.label, input.host);
  const title = titleOf(input, attached, named, where);
  const watching = input.phase === "watching";
  return {
    lang: input.lang ?? "en",
    title: attached && named ? title : plain(title),
    tone: attached ? "accent" : "default",
    lines: linesOf(input, attached, named, where),
    buttons: buttonsOf(input, attached),
    buttonsMax: attached && !watching ? 4 : 3,
  };
}
