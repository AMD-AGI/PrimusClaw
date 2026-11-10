// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The session card as the window (Python `session_window.window_card`): where the session runs and how it stands, the end of its
 * output (more behind a toggle, the whole as messages), what waits for the person, and the text box while it is idle. Every word
 * an agent or its connector supplied is inert. The window's state and policy (WindowView, takesInput, what is shown of the output)
 * are the remote domain's (`remote/window/`); this says what the card shows.
 */
import type { WindowInput } from "../remote/ports.js";
import type { Lang } from "../locales/lang.js";
import { remoteWindowCardText } from "../locales/remote-window-card.js";
import { chatBoxLine, masked, sentLabel, tailLines } from "../remote/window/output.js";
import { INPUT_ID, INPUT_MAX, takesInput } from "../remote/window/view.js";
import { type DecisionButton, type RemoteButton, remoteButton } from "../remote/actions.js";
import { lit } from "../remote/inert.js";
import { remoteText } from "../locales/remote.js";
import { cpLength, cpSlice, pyLstrip, pyRstrip } from "../text/py-text.js";
import type { StatusPhase } from "../remote/lines.js";
import { whereLine } from "../remote/lines.js";
import { clock, utcClock } from "../remote/time.js";

/** The output the card shows at once (a phone screen of it), and behind its "more" toggle. */
export const TAIL_CHARS = 900;
export const TAIL_LINES = 14;
export const MORE_CHARS = 3500;
export const MORE_LINES = 60;
/** What the person sent from the card, shown back on it. */
export const SENT_SHOWN_CHARS = 200;
export const APPROVALS_SHOWN = 3;
/** One line of output (a minified file is not one card). */
export const LINE_MAX = 400;

const MARKUP = /([\\*_`~#[\]|])/g;
const LIST_ITEM = /^\s*\d+[.)]\s/;

function isLineControl(code: number): boolean {
  return (code <= 0x1f && code !== 0x09 && code !== 0x0a) || code === 0x7f;
}

/** One line of the agent's output as a TextBlock shows it: control characters gone, no link or tag can be built from it, the
 * markdown a TextBlock reads escaped, never read as a list item, clipped. */
export function outputLine(raw: string): string {
  let line = Array.from(raw, (ch) => (isLineControl(ch.charCodeAt(0)) ? " " : ch)).join("");
  line = pyRstrip(line.replaceAll("\t", "    "));
  line = line.replaceAll("](", "]\u{200b}(").replaceAll("<", "\u{2039}").replaceAll(">", "\u{203a}");
  line = line.replace(MARKUP, "\\$1");
  if (pyLstrip(line).startsWith("-") || pyLstrip(line).startsWith("+") || LIST_ITEM.test(line))
    line = "\u{200b}" + line;
  return cpLength(line) <= LINE_MAX ? line : cpSlice(line, 0, LINE_MAX - 1) + "…";
}

export interface WindowOutput {
  /** The end of the output, line by line (inert); empty with `empty` said instead. */
  readonly lines: readonly string[];
  readonly empty: string | null;
  /** The lines before them, behind the toggle (null: nothing more to show). */
  readonly more: readonly string[] | null;
  readonly moreToggle: string;
  /** Full output and Mode, under the output. */
  readonly buttons: readonly RemoteButton[];
}

export interface WindowCardView {
  readonly lang: Lang;
  readonly lead: string;
  readonly title: string;
  readonly waiting: boolean;
  /** The conversation, folder and mode, in one subtle line ("" for none). */
  readonly sub: string;
  readonly state: string;
  readonly unattended: string | null;
  readonly sent: string | null;
  readonly output: WindowOutput;
  readonly note: string | null;
  readonly approvals: readonly { readonly text: string; readonly buttons: readonly DecisionButton[] }[];
  readonly moreApprovals: string | null;
  readonly groupNote: string | null;
  /** The text box, while the session takes input; null otherwise. */
  readonly box: {
    readonly id: string;
    readonly placeholder: string;
    readonly value: string;
    readonly maxLength: number;
  } | null;
  readonly boxNote: string | null;
  readonly chatBox: string;
  readonly updated: string;
  readonly actions: readonly RemoteButton[];
  /** Whether the card carries the text box (what a later refresh reads instead of the card's JSON). */
  readonly takesInput: boolean;
}

type ShownPhase = StatusPhase | "waiting" | "terminal_busy";

function shownPhase(input: WindowInput): ShownPhase {
  const live = input.phase === "idle" || input.phase === "working";
  if (input.approvals.length > 0 && live) return "waiting";
  if (input.view.queued && live) return "terminal_busy";
  return input.phase;
}

const PHASE_WORDS = {
  idle: "phaseIdle",
  working: "phaseWorking",
  waiting: "phaseWaiting",
  terminal_busy: "phaseTerminalBusy",
  starting: "phaseStarting",
  offline: "phaseOffline",
  watching: "phaseWatching",
} as const;

function stateLine(input: WindowInput, shown: ShownPhase): string {
  const words = remoteWindowCardText.in(input.lang);
  const key = Object.hasOwn(PHASE_WORDS, shown) ? PHASE_WORDS[shown as keyof typeof PHASE_WORDS] : null;
  let state = words.status + (key ? words[key] : shown);
  if (shown === "working" && input.view.step) state += words.aside({ text: lit(input.view.step, 80) });
  if (shown === "terminal_busy" && input.view.queued) state += words.aside({ text: lit(input.view.queued, 120) });
  return state;
}

/** The header names the agent without its icon (the header carries one emoji, the plug). */
function agentOf(label: string): string {
  const at = label.indexOf(" ");
  if (at < 0) return label;
  const icon = label.slice(0, at);
  const name = label.slice(at + 1);
  return name && !/[\p{L}\p{N}]/u.test(icon) ? name : label;
}

function subLine(input: WindowInput): string {
  const words = remoteWindowCardText.in(input.lang);
  const named = lit(input.conversation ?? "", 80);
  const parts = [
    named ? words.conversation({ named }) : "",
    lit(input.cwd, 120),
    input.mode ? words.mode({ mode: lit(input.mode, 40) }) : "",
  ];
  return parts.filter((p) => p).join(" · ");
}

function outputOf(input: WindowInput): WindowOutput {
  const words = remoteWindowCardText.in(input.lang);
  const text = input.view.text;
  const tail = tailLines(text, TAIL_CHARS, TAIL_LINES);
  const more = tailLines(text, MORE_CHARS, MORE_LINES);
  const hidden = tail.cut && more.lines.length > tail.lines.length;
  const session = { session_id: input.sessionId };
  const buttons: RemoteButton[] = [];
  if (tail.cut || more.cut || cpLength(masked(text)) > TAIL_CHARS) {
    buttons.push(remoteButton(words.fullOutput, "full", null, session));
  }
  if (input.hasModes && input.phase !== "watching") buttons.push(remoteButton(words.modeButton, "mode", null, session));
  return {
    lines: tail.lines.map(outputLine),
    empty: tail.lines.length > 0 ? null : words.noOutput,
    more: hidden ? more.lines.slice(0, more.lines.length - tail.lines.length).map(outputLine) : null,
    moreToggle: words.moreOrLess,
    buttons,
  };
}

function approvalsOf(input: WindowInput): Pick<WindowCardView, "approvals" | "moreApprovals" | "groupNote"> {
  const words = remoteWindowCardText.in(input.lang);
  const zone = input.zone ?? "UTC";
  if (input.group) {
    return { approvals: [], moreApprovals: null, groupNote: input.approvals.length > 0 ? words.groupWaits : null };
  }
  const hidden = input.approvals.length - APPROVALS_SHOWN;
  return {
    approvals: input.approvals.slice(0, APPROVALS_SHOWN).map((a) => ({
      text: words.needsApproval({ tool: lit(a.tool, 100), until: clock(a.expiresAt, zone) }),
      buttons: a.buttons,
    })),
    moreApprovals: hidden > 0 ? words.moreRequests({ n: hidden }) : null,
    groupNote: null,
  };
}

function boxOf(input: WindowInput): Pick<WindowCardView, "box" | "boxNote"> {
  const words = remoteWindowCardText.in(input.lang);
  if (takesInput(input.phase)) {
    return {
      box: {
        id: INPUT_ID,
        placeholder: words.placeholder,
        value: cpSlice(input.view.draft, 0, INPUT_MAX),
        maxLength: INPUT_MAX,
      },
      boxNote: null,
    };
  }
  if (input.phase === "working") return { box: null, boxNote: words.boxAfterTurn };
  if (input.phase === "starting") return { box: null, boxNote: words.boxAfterStart };
  return { box: null, boxNote: null };
}

function actionsOf(input: WindowInput): RemoteButton[] {
  const words = remoteWindowCardText.in(input.lang);
  const session = { session_id: input.sessionId };
  const back = remoteButton(words.back, "detach", null, session);
  const switchTo = remoteButton(words.switch, "switch", null, session);
  if (input.phase === "watching") {
    // (takeover names a connector, not the session)
    return [
      back,
      switchTo,
      ...(input.takeover ? [remoteButton(words.takeOver, "takeover", null, input.takeover)] : []),
    ];
  }
  const send = takesInput(input.phase) ? [remoteButton(words.send, "send", "positive", session)] : [];
  return [
    ...send,
    remoteButton(input.terminal ? words.stopTerminal : words.stop, "stop", null, session),
    back,
    switchTo,
  ];
}

/** The session card as a view. */
export function windowView(input: WindowInput): WindowCardView {
  const words = remoteWindowCardText.in(input.lang);
  const shown = shownPhase(input);
  const where = whereLine(agentOf(input.label), input.host);
  const sent = input.view.sent
    ? sentLabel(input.view.sentFrom, input.lang) + lit(input.view.sent, SENT_SHOWN_CHARS)
    : null;
  return {
    lang: input.lang,
    lead: input.lead ?? "",
    title: lit(words.title({ where }), 160),
    waiting: shown === "waiting",
    sub: subLine(input),
    state: stateLine(input, shown),
    unattended: input.unattended ? remoteText.in(input.lang).unattendedNote : null,
    sent,
    output: outputOf(input),
    note: input.view.note ? lit(input.view.note, 300) : null,
    ...approvalsOf(input),
    ...boxOf(input),
    chatBox: chatBoxLine("card", input.lang, input.bot),
    updated: words.updated({ stamp: utcClock(input.at) }),
    actions: actionsOf(input),
    takesInput: takesInput(input.phase),
  };
}
