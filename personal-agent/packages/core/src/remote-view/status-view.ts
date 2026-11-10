// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The status card of a chat that talks to a remote session: ONE card that says where its messages go (which machine and agent,
 * the folder, whether the agent is working, and when that was last true). It is sent once, when the chat attaches, and after that
 * only edited in place. Its buttons are the system operations (switch, back to the assistant, stop, mode), so the chat itself
 * holds only the conversation with the agent. Every button names the session, which the worker checks against the chat's own.
 */
import type { StatusInput } from "../remote/ports.js";
import type { Lang } from "../locales/lang.js";
import { remoteText } from "../locales/remote.js";
import { type RemoteButton, remoteButton } from "../remote/actions.js";
import { lit, plain } from "../remote/inert.js";
import { clawyLine, whereLine } from "../remote/lines.js";
import { pyStrip } from "../text/py-text.js";
import { utcClock } from "../remote/time.js";

/** Where a chat stands with its session. */
import type { StatusPhase } from "../remote/lines.js";

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

const PHASE_WORDS = {
  idle: "phaseIdle",
  working: "phaseWorking",
  starting: "phaseStarting",
  offline: "phaseOffline",
  watching: "phaseWatching",
} as const;

function phaseWords(phase: StatusPhase, lang: Lang): string {
  // (said only while attached: no words for detached/ended)
  return Object.hasOwn(PHASE_WORDS, phase)
    ? remoteText.in(lang)[PHASE_WORDS[phase as keyof typeof PHASE_WORDS]]
    : phase;
}

function titleOf(input: StatusInput, attached: boolean, named: string, where: string): string {
  const words = remoteText.in(input.lang ?? "en");
  if (input.phase === "watching") return words.titleWatching({ where });
  if (attached && named) return words.titleExisting({ named });
  if (attached) return words.titleConnected({ where });
  return input.phase === "detached" ? words.titleDetached : words.titleEnded;
}

/** The lines only a chat still in the session gets: how it stands, the unattended note, and which messages stay with the
 * assistant. (No card links a web page of the session: a phone, where the cards are used, cannot open one.) */
function attachedLines(input: StatusInput, lang: Lang): StatusLine[] {
  const words = remoteText.in(lang);
  const lines: StatusLine[] = [{ kind: "phase", text: words.status + phaseWords(input.phase, lang) }];
  if (input.unattended) lines.push({ kind: "unattended", text: words.unattendedNote });
  lines.push({ kind: "assistant", text: clawyLine(lang, input.bot) });
  return lines;
}

function linesOf(input: StatusInput, attached: boolean, named: string, where: string): StatusLine[] {
  const lang = input.lang ?? "en";
  const words = remoteText.in(lang);
  const lines: StatusLine[] = input.lead ? [{ kind: "lead", text: input.lead }] : [];
  // (the title names the conversation: where it runs is the line under it)
  if (attached && named && input.phase !== "watching") lines.push({ kind: "where", text: plain(where) });
  if (!attached) lines.push({ kind: "lastSession", text: plain(words.lastSession({ where })) });
  const folder = lit(input.cwd, 120) + (input.mode ? words.modeSuffix({ mode: lit(input.mode, 40) }) : "");
  if (pyStrip(folder)) lines.push({ kind: "folder", text: folder });
  if (attached) lines.push(...attachedLines(input, lang));
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
