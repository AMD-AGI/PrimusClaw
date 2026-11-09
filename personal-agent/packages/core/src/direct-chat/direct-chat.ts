// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The chat itself as the window of an agent session on the person's machine (TEAMS_DIRECT_CHAT, teams_agent/direct_chat.py).
 *
 * For the people it is on for, a chat attached to an agent session is a plain conversation with that agent: every message says in
 * its first line who speaks (`agentHead`, `CLAWY_HEAD`), a line of the agent's that looks like a head is escaped (`guardHeads`),
 * entering and leaving are one line each, and the way back and forth is a suggested reply. Off (the default) changes nothing.
 */

import type { Lang } from "../locales/lang.js";
import { neutral } from "../text/neutral.js";

/** A suggested reply: (what the button says, what it sends). */
export type SuggestedReply = readonly [title: string, value: string];

export const CLAWY_HEAD = "💬 **Clawy**";
export const NEUTRAL_ICON = "🤖";
const HEAD_ICONS = ["💬", "\u{1F7E0}", "⬛", "\u{1F537}", NEUTRAL_ICON];
const LOOKS_LIKE_HEAD = new RegExp(
  `^(?<lead>[ \\t>]*(?:${HEAD_ICONS.map(escapeRegExp).join("|")})\\uFE0F?[ \\t]*)\\*\\*`,
  "gmu",
);
const MARKUP = /[*`[\]\\<>#|~]/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `text` with nothing markdown reads as markup: a name inside the bold of a head. */
function plain(text: string, limit: number): string {
  return neutral(text, limit).replace(MARKUP, "").trim();
}

function splitLabel(label: string): [icon: string, name: string] {
  const trimmed = label.trim();
  const space = trimmed.indexOf(" ");
  return space < 0 ? [trimmed, ""] : [trimmed.slice(0, space), trimmed.slice(space + 1)];
}

/** The first line of what an agent writes: its icon, then its name and its machine in bold (`🟠 **Claude Code · dev-pod**`). */
export function agentHead(label: string, host: string): string {
  let [icon, name] = splitLabel(label);
  if (!name || /[\p{L}\p{N}]/u.test(icon)) {
    icon = NEUTRAL_ICON;
    name = label;
  }
  const shownName = plain(name, 60) || "agent";
  const shownHost = plain(host, 80);
  return shownHost ? `${icon} **${shownName} · ${shownHost}**` : `${icon} **${shownName}**`;
}

/** The first line of the second and later messages of one answer: the agent's icon and where it is in the answer. */
export function continuedHead(label: string, n: number, total: number, lang: string): string {
  const icon = agentHead(label, "").split(" ", 1)[0] ?? NEUTRAL_ICON;
  return lang === "zh"
    ? `${icon} （续 ${String(n)}/${String(total)}）`
    : `${icon} (cont. ${String(n)}/${String(total)})`;
}

/** The agent's words with every line that would read as a head escaped (its bold shown as asterisks). */
export function guardHeads(text: string): string {
  return text.replace(LOOKS_LIKE_HEAD, (...args: unknown[]) => {
    const groups = args.at(-1) as { lead: string };
    return `${groups.lead}\\*\\*`;
  });
}

/** `text` under `head`, as its own paragraph. */
export function signed(head: string, text: string): string {
  return text ? `${head}\n\n${text}` : head;
}

/** The messages of one thing an agent said, each headed: the first with who said it (and `suffix`), the others with where they are. */
export function signedParts(
  label: string,
  host: string,
  parts: readonly string[],
  lang: string,
  suffix = "",
): string[] {
  return parts.map((part, i) =>
    signed(i === 0 ? agentHead(label, host) + suffix : continuedHead(label, i + 1, parts.length, lang), part),
  );
}

export const OWN_SUFFIX: Readonly<Record<Lang, string>> = { zh: "（自己说的）", en: " (on its own)" };
export const TYPED_SUFFIX: Readonly<Record<Lang, string>> = {
  zh: "（回复终端里的输入）",
  en: " (replying to what was typed in the terminal)",
};
export const BACK: Readonly<Record<Lang, SuggestedReply>> = {
  zh: ["回到 Clawy", "回到 Clawy"],
  en: ["Back to Clawy", "back to Clawy"],
};
const GO_ON: Readonly<Record<Lang, SuggestedReply>> = { zh: ["继续", "继续"], en: ["Continue", "Continue"] };

function lang2(lang: string): Lang {
  return lang === "zh" ? "zh" : "en";
}

/** The suggested replies under what the agent said: go on with it, or back to Clawy. */
export function agentReplies(lang: string): SuggestedReply[] {
  return [GO_ON[lang2(lang)], BACK[lang2(lang)]];
}

export function backReply(lang: string): SuggestedReply {
  return BACK[lang2(lang)];
}

/** The reply that attaches the chat to the agent it last talked to again (`/agent attach MACHINE/AGENT`); undefined when none. */
export function returnReply(label: string, host: string, agentId: string, lang: string): SuggestedReply | undefined {
  const id = agentId.trim();
  if (!id || /\s/u.test(id)) return undefined;
  const [, rest] = splitLabel(label);
  const name = plain(rest || label, 24) || "agent";
  const machine = host.trim();
  const ref = machine && !/\s/u.test(machine) ? `${machine}/${id}` : id;
  return [lang === "zh" ? `切回 ${name}` : `Back to ${name}`, `/agent attach ${ref}`];
}

export interface EnteredLine {
  readonly label: string;
  readonly host: string;
  readonly cwd: string;
  readonly mode: string;
  readonly lang: string;
  readonly unattended?: boolean;
  readonly lead?: string;
}

/** The one line a chat gets when it attaches to (or switches to) a session. */
export function enteredLine(entered: EnteredLine): string {
  const zh = entered.lang === "zh";
  const where = `${neutral(entered.host, 80)} · ${neutral(entered.label, 80)}`;
  const mode = neutral(entered.mode, 40);
  const extra = [
    entered.cwd ? `\`${neutral(entered.cwd, 120)}\`` : "",
    entered.mode ? (zh ? `${mode} 模式` : `${mode} mode`) : "",
  ].filter(Boolean);
  const detail = extra.length ? (zh ? `（${extra.join("，")}）` : ` (${extra.join(", ")})`) : "";
  const lines = [
    zh
      ? `→ 现在发给 ${where}${detail}。以 @Clawy 开头的消息发给 Clawy；点「回到 Clawy」回来。`
      : `→ Your messages now go to ${where}${detail}. Start a message with @Clawy to talk to Clawy; tap "Back to Clawy" to come back.`,
  ];
  if (entered.unattended) {
    lines.push(
      zh
        ? "⚠️ 这个会话是无人值守模式：它改文件、跑命令不会先问你。"
        : "⚠️ This session is unattended: it changes files and runs commands without asking you first.",
    );
  }
  if (entered.lead) lines.push(entered.lead);
  return lines.join("\n\n");
}

/** The one line a chat gets when it leaves the session: its messages go to Clawy again. */
export function leftLine(lang: string): string {
  return lang === "zh" ? "→ 现在发给 Clawy。" : "→ Your messages go to Clawy now.";
}

/** `/agent mode card|chat` while this is on: the chat is the window, for everybody it is on for. */
export function modeUnifiedLine(lang: string): string {
  return lang === "zh"
    ? "现在直连会话就在聊天里：你的消息直接发给 agent，不再用会话卡。"
    : "An attached chat talks to the agent right here now: what you type goes to it, and there is no session card.";
}

/** Where a person's chat is attached, as far as Clawy's own words need it. */
export interface AttachedState {
  readonly sessionId: string;
  readonly agentLabel: string;
  readonly host: string;
  readonly agentId: string;
}

/** Reads where a person's chat is attached (the remote-agent state; W6 owns it). */
export interface AttachedStateReader {
  remoteState(aadId: string): AttachedState | undefined;
}

export interface ClawyExtras {
  readonly head: string;
  readonly replies: readonly SuggestedReply[];
}

/** The switch: off (undefined), on for everybody (empty set) or on for the people listed (lower-case ids). */
export class DirectChat {
  private readonly users: ReadonlySet<string> | undefined;

  constructor(on: boolean, users: Iterable<string> = []) {
    this.users = on ? new Set([...users].map((u) => u.trim().toLowerCase()).filter(Boolean)) : undefined;
  }

  /** Whether the chat of this person (or a group binding of theirs: the part before '|') is an agent's window when attached. */
  on(aadId: string): boolean {
    if (this.users === undefined) return false;
    const person = (aadId.split("|", 1)[0] ?? "").trim().toLowerCase();
    return this.users.size === 0 || this.users.has(person);
  }

  describe(): string {
    if (this.users === undefined) return "off";
    return this.users.size === 0 ? "on for everybody" : `on for ${String(this.users.size)} people`;
  }

  /**
   * The head and suggested replies of what Clawy says to this person: attached, `CLAWY_HEAD` and "Back to Clawy"; not attached,
   * no head and the way back to the agent it last talked to; nothing when this is off for them.
   */
  clawyExtras(state: AttachedStateReader, aadId: string, lang: string): ClawyExtras {
    if (!this.on(aadId)) return { head: "", replies: [] };
    const found = state.remoteState(aadId);
    if (found?.sessionId) return { head: CLAWY_HEAD, replies: [backReply(lang)] };
    const back = found?.agentLabel ? returnReply(found.agentLabel, found.host, found.agentId, lang) : undefined;
    return { head: "", replies: back ? [back] : [] };
  }
}
