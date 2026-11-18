// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The chat itself as the window of an agent session on the person's machine (PA_DIRECT_CHAT, teams_agent/direct_chat.py).
 *
 * For the people it is on for, a chat attached to an agent session is a plain conversation with that agent: every message says in
 * its first line who speaks (`agentHead`, `botHead`), a line of the agent's that looks like a head is escaped (`guardHeads`),
 * entering and leaving are one line each, and the way back and forth is a suggested reply. Off (the default) changes nothing.
 */

import { BOT_NAME } from "../branding.js";
import type { Lang } from "../locales/lang.js";
import { neutral } from "../text/neutral.js";
import { pyStrip } from "../text/py-text.js";

/** A suggested reply: (what the button says, what it sends). */
export type SuggestedReply = readonly [title: string, value: string];

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
  return pyStrip(neutral(text, limit).replace(MARKUP, ""));
}

function splitLabel(label: string): [icon: string, name: string] {
  const trimmed = pyStrip(label);
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

/** The first line of what the bot itself says in a chat attached to an agent: `💬 **<the bot's name>**`. */
export function botHead(bot: string): string {
  return `💬 **${plain(bot, 60) || BOT_NAME}**`;
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
const GO_ON: Readonly<Record<Lang, SuggestedReply>> = { zh: ["继续", "继续"], en: ["Continue", "Continue"] };

function lang2(lang: string): Lang {
  return lang === "zh" ? "zh" : "en";
}

/** The suggested replies under what the agent said: go on with it, or back to the bot (`bot`: its name in this deployment). */
export function agentReplies(lang: string, bot: string): SuggestedReply[] {
  return [GO_ON[lang2(lang)], backReply(lang, bot)];
}

/** "Back to <bot>": what it says and sends (the words `naturalCommand` reads as `/agent detach`). */
export function backReply(lang: string, bot: string): SuggestedReply {
  return lang2(lang) === "zh" ? [`回到 ${bot}`, `回到 ${bot}`] : [`Back to ${bot}`, `back to ${bot}`];
}

/** The reply that attaches the chat to the agent it last talked to again (`/agent attach MACHINE/AGENT`); undefined when none. */
export function returnReply(label: string, host: string, agentId: string, lang: string): SuggestedReply | undefined {
  const id = pyStrip(agentId);
  if (!id || /\s/u.test(id)) return undefined;
  const [, rest] = splitLabel(label);
  const name = plain(rest || label, 24) || "agent";
  const machine = pyStrip(host);
  const ref = machine && !/\s/u.test(machine) ? `${machine}/${id}` : id;
  return [lang === "zh" ? `切回 ${name}` : `Back to ${name}`, `/agent attach ${ref}`];
}

export interface EnteredLine {
  readonly label: string;
  readonly host: string;
  readonly cwd: string;
  readonly mode: string;
  readonly lang: string;
  /** The bot's name in this deployment. */
  readonly bot: string;
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
  const bot = entered.bot;
  const lines = [
    zh
      ? `→ 现在发给 ${where}${detail}。以 @${bot} 开头的消息发给 ${bot}；点「回到 ${bot}」回来。`
      : `→ Your messages now go to ${where}${detail}. Start a message with @${bot} to talk to ${bot}; tap "Back to ${bot}" to come back.`,
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

/** The one line a chat gets when it leaves the session: its messages go to the bot (`bot`) again. */
export function leftLine(lang: string, bot: string): string {
  return lang === "zh" ? `→ 现在发给 ${bot}。` : `→ Your messages go to ${bot} now.`;
}

/** `/agent mode card|chat` while this is on: the chat is the window, for everybody it is on for. */
export function modeUnifiedLine(lang: string): string {
  return lang === "zh"
    ? "现在直连会话就在聊天里：你的消息直接发给 agent，不再用会话卡。"
    : "An attached chat talks to the agent right here now: what you type goes to it, and there is no session card.";
}

/** Where a person's chat is attached, as far as the bot's own words need it. */
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

export interface BotExtras {
  readonly head: string;
  readonly replies: readonly SuggestedReply[];
}

/** The switch: off (undefined), on for everybody (empty set) or on for the people listed (lower-case ids). */
export class DirectChat {
  private readonly users: ReadonlySet<string> | undefined;

  /** `botName`: the bot's name in this deployment (`Settings.botName`), for its head and the way back to it. */
  constructor(
    on: boolean,
    users: Iterable<string> = [],
    readonly botName: string = BOT_NAME,
  ) {
    this.users = on ? new Set([...users].map((u) => pyStrip(u).toLowerCase()).filter(Boolean)) : undefined;
  }

  /** Whether the chat of this person (or a group binding of theirs: the part before '|') is an agent's window when attached. */
  on(aadId: string): boolean {
    if (this.users === undefined) return false;
    const person = pyStrip(aadId.split("|", 1)[0] ?? "").toLowerCase();
    return this.users.size === 0 || this.users.has(person);
  }

  describe(): string {
    if (this.users === undefined) return "off";
    return this.users.size === 0 ? "on for everybody" : `on for ${String(this.users.size)} people`;
  }

  /**
   * The head and suggested replies of what the bot says to this person: attached, `botHead` and "Back to <bot>"; not attached,
   * no head and the way back to the agent it last talked to; nothing when this is off for them.
   */
  botExtras(state: AttachedStateReader, aadId: string, lang: string): BotExtras {
    if (!this.on(aadId)) return { head: "", replies: [] };
    const found = state.remoteState(aadId);
    if (found?.sessionId) return { head: botHead(this.botName), replies: [backReply(lang, this.botName)] };
    const back = found?.agentLabel ? returnReply(found.agentLabel, found.host, found.agentId, lang) : undefined;
    return { head: "", replies: back ? [back] : [] };
  }
}
