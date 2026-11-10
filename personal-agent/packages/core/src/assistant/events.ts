// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an assistant event asks of the chat beyond its words (teams_agent/assistant.py): a command it puts to the person
 * (`confirm_action`), a write Claw holds for them (`confirm_write`), the replies to tap under it (`suggested_replies`), a pull
 * request a result names, and what it says of an agent session on the person's machine (`remote`, proactive.py). Every field is
 * Claw's and is read defensively: anything not of the expected shape is as if absent.
 */
import type { Lang } from "../locales/lang.js";
import { pickLang } from "../language/detect.js";
import type { SuggestedReply } from "../direct-chat/direct-chat.js";
import { cpLength, pySplit, pyStrip } from "../text/py-text.js";
import { CONTEXT_TEXT_MAX } from "./chat.js";

/** A result's words that link a pull request: its card offers to watch it. */
export const PULL_LINK = /github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+/;
/** Code points of one of Claw's suggested replies (Claw sends at most 30): a button's few words. */
export const SUGGESTED_REPLY_MAX = 30;
/** Teams shows the first three suggested replies only. */
export const SUGGESTIONS_MAX = 3;
/** The writes Claw holds for the person that this worker draws as a card. */
export const CONFIRM_KINDS = [
  "trigger_create",
  "trigger_cancel",
  "devenv_send",
  "github_comment",
  "devenv_hide",
] as const;

/** The default replies under what the assistant said: (what the button says, what it sends). */
export const ASSISTANT_SUGGESTED_REPLIES: Readonly<Record<Lang, readonly SuggestedReply[]>> = {
  zh: [
    ["详细说说", "详细说说"],
    ["我的任务", "/board"],
  ],
  en: [
    ["Tell me more", "Tell me more"],
    ["My tasks", "/board"],
  ],
};

type Event = Readonly<Record<string, unknown>>;

function record(value: unknown): Event | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Event) : undefined;
}

/** Python's `str(x or "")` for a field Claw sends as text. */
function field(value: unknown): string {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value === true) return "True";
  return "";
}

/** A pull request's link as people say it in a chat: #381. */
export function shortPull(url: string): string {
  const match = /\/pull\/([0-9]+)/.exec(url);
  return match ? `#${match[1] ?? ""}` : url;
}

export interface ConfirmAction {
  readonly channelMessageId: string;
  readonly name: string;
  readonly args: string;
}

/**
 * The command an `assistant.say` puts to the person (the assistant did not run it, since the message was not that command typed
 * whole); undefined when it carries none that could be one. `exactCommand` is the router's test of a command typed whole.
 */
export function confirmActionOf(event: Event, exactCommand: (text: string) => boolean): ConfirmAction | undefined {
  const confirm = record(event["confirm_action"]);
  if (event["type"] !== "assistant.say" || confirm === undefined) return undefined;
  const name = pyStrip(field(confirm["name"])).replace(/^\/+/, "");
  const args = pySplit(field(confirm["args"])).join(" ");
  const channelMessageId = field(confirm["channel_message_id"]);
  if (!name || !channelMessageId || cpLength(args) > CONTEXT_TEXT_MAX || !exactCommand(`/${name} ${args}`.trim()))
    return undefined;
  return { channelMessageId, name, args };
}

export interface ConfirmWrite {
  readonly confirmationId: string;
  readonly kind: (typeof CONFIRM_KINDS)[number];
  readonly allowLabel: string;
}

/** The write Claw holds for the person (`confirm_write` of an `assistant.say`); undefined when it carries none this worker draws. */
export function confirmWriteOf(event: Event): ConfirmWrite | undefined {
  const confirm = record(event["confirm_write"]);
  if (event["type"] !== "assistant.say" || confirm === undefined) return undefined;
  const confirmationId = field(confirm["confirmation_id"]);
  const kind = CONFIRM_KINDS.find((k) => k === field(confirm["kind"]));
  if (!confirmationId || cpLength(confirmationId) > 64 || kind === undefined) return undefined;
  return {
    confirmationId,
    kind,
    allowLabel: Array.from(pySplit(field(confirm["allow_label"])).join(" "))
      .slice(0, 40)
      .join(""),
  };
}

/**
 * The suggested replies under an `assistant.say` (none under anything else, or with the style off): Claw's own, each one plain
 * line that is no command, else the defaults in the person's language (`lang`; without it, the language of `text`).
 */
export function suggestedRepliesOf(event: Event, text: string, styleOn: boolean, lang?: Lang): SuggestedReply[] {
  if (event["type"] !== "assistant.say" || !styleOn) return [];
  const own = event["suggested_replies"];
  const replies: SuggestedReply[] = [];
  for (const raw of Array.isArray(own) ? own : []) {
    const reply = typeof raw === "string" ? pySplit(raw).join(" ") : "";
    const fits =
      reply && !reply.startsWith("/") && cpLength(reply) <= SUGGESTED_REPLY_MAX && !String(raw).includes("\n");
    if (fits && !replies.some(([title]) => title === reply)) replies.push([reply, reply]);
  }
  if (replies.length) return replies.slice(0, SUGGESTIONS_MAX);
  return [...ASSISTANT_SUGGESTED_REPLIES[lang ?? pickLang(text)]];
}

export interface RemoteNotice {
  readonly kind: "done" | "needs_you" | "error";
  readonly sessionId: string;
  readonly ask: Event | undefined;
  readonly machine: string;
  readonly agent: string;
}

/** What an `assistant.say` says of an agent session on the person's machine, or undefined for any other message. */
export function remoteNoticeOf(event: Event): RemoteNotice | undefined {
  const remote = event["type"] === "assistant.say" ? record(event["remote"]) : undefined;
  const kind = remote?.["kind"];
  if (remote === undefined || (kind !== "done" && kind !== "needs_you" && kind !== "error")) return undefined;
  const sessionId = remote["session_id"];
  if (typeof sessionId !== "string" || !sessionId) return undefined;
  return {
    kind,
    sessionId,
    ask: record(remote["ask"]),
    machine: field(remote["machine"]),
    agent: field(remote["agent"]),
  };
}
