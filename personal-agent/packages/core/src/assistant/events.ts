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
/** The suggested replies kept under a message when the channel's own limit is not given (`SurfaceCaps.suggestionsMax`). */
export const SUGGESTIONS_MAX = 3;
/** The writes Claw holds for the person that this worker draws as a card. */
export const CONFIRM_KINDS = [
  "trigger_create",
  "trigger_cancel",
  "devenv_send",
  "github_comment",
  "devenv_hide",
  "skill_save",
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
 * line that is no command (at most `max`, the channel's `SurfaceCaps.suggestionsMax`), else the defaults in the person's
 * language (`lang`; without it, the language of `text`).
 */
export function suggestedRepliesOf(
  event: Event,
  text: string,
  styleOn: boolean,
  lang?: Lang,
  max = SUGGESTIONS_MAX,
): SuggestedReply[] {
  if (event["type"] !== "assistant.say" || !styleOn) return [];
  const own = event["suggested_replies"];
  const replies: SuggestedReply[] = [];
  for (const raw of Array.isArray(own) ? own : []) {
    const reply = typeof raw === "string" ? pySplit(raw).join(" ") : "";
    const fits =
      reply && !reply.startsWith("/") && cpLength(reply) <= SUGGESTED_REPLY_MAX && !String(raw).includes("\n");
    if (fits && !replies.some(([title]) => title === reply)) replies.push([reply, reply]);
  }
  if (replies.length) return replies.slice(0, max);
  return [...ASSISTANT_SUGGESTED_REPLIES[lang ?? pickLang(text)]];
}

/** What a skill's card is about (`skill_card.kind`): done already, or a draft to save. */
export const SKILL_CARD_KINDS = ["saved", "deleted", "disabled", "enabled", "draft"] as const;
/** Code points of a skill's description on its card (Claw sends at most 300). */
export const SKILL_DESCRIPTION_MAX = 300;
/** Code points of the start of SKILL.md a card shows (Claw sends at most 1500). */
export const SKILL_PREVIEW_MAX = 1500;
/** The files a skill's card lists (Claw keeps at most 20). */
export const SKILL_FILES_MAX = 20;

/** One of the person's personal skills as an `assistant.say` shows it (`skill_card`). */
export interface SkillCardEvent {
  readonly kind: (typeof SKILL_CARD_KINDS)[number];
  readonly name: string;
  readonly version: number | null;
  /** `saved`: a new skill (true) or a new version of one (false). */
  readonly created: boolean;
  readonly description: string;
  readonly manual: boolean;
  readonly files: readonly string[];
  readonly preview: string;
  /** What Undo takes back ("" none). */
  readonly changeId: string;
}

/** A skill's name as a card shows it and a request path carries it: Claw's own names, nothing else. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** An id a button may carry (a change Claw made: a uuid). */
const CHANGE_ID = /^[A-Za-z0-9-]{1,64}$/;

function clipped(value: unknown, max: number): string {
  const all = Array.from(field(value));
  return all.length > max ? `${all.slice(0, max - 1).join("")}…` : all.join("");
}

/**
 * The skill an `assistant.say` is about (`skill_card`); undefined when it carries none this worker draws. Read whole or not at all:
 * a name that is not one, or a kind it does not know, and there is no card (the words still say it).
 */
export function skillCardOf(event: Event): SkillCardEvent | undefined {
  const card = record(event["skill_card"]);
  if (event["type"] !== "assistant.say" || card === undefined) return undefined;
  const kind = SKILL_CARD_KINDS.find((k) => k === card["kind"]);
  const name = typeof card["name"] === "string" ? card["name"] : "";
  if (kind === undefined || !SKILL_NAME.test(name)) return undefined;
  const version = typeof card["version"] === "number" && Number.isSafeInteger(card["version"]) ? card["version"] : null;
  const changeId = typeof card["change_id"] === "string" && CHANGE_ID.test(card["change_id"]) ? card["change_id"] : "";
  const files = (Array.isArray(card["files"]) ? (card["files"] as unknown[]) : [])
    .map((f) => record(f)?.["path"])
    .filter((p): p is string => typeof p === "string" && p !== "" && cpLength(p) <= 200 && !p.includes("\n"))
    .slice(0, SKILL_FILES_MAX);
  return {
    kind,
    name,
    version,
    created: card["created"] === true,
    description: pySplit(clipped(card["description"], SKILL_DESCRIPTION_MAX)).join(" "),
    manual: card["invocation"] === "manual",
    files,
    preview: clipped(card["preview"], SKILL_PREVIEW_MAX),
    changeId,
  };
}

/** The fewest options a choice card shows (Claw sends from 2). */
export const CHOICE_OPTIONS_MIN = 2;
/** The most options a choice card shows (Claw sends at most 10). */
export const CHOICE_OPTIONS_MAX = 10;
/** Code points of one option (Claw sends at most 80): one line beside a radio button or a check box. */
export const CHOICE_OPTION_MAX = 80;

/** A choice an `assistant.say` puts to the person: the options, and whether several may be picked. */
export interface SayChoice {
  readonly options: readonly string[];
  readonly multiple: boolean;
}

/**
 * The choice an `assistant.say` puts to the person (`choices`); undefined when it carries none this worker draws. Read whole or not
 * at all: an option that is not one plain line of text, or too many or too few of them, and there is no card (the words still name
 * the options, for the person to type).
 */
export function choiceOf(event: Event): SayChoice | undefined {
  const choice = record(event["choices"]);
  if (event["type"] !== "assistant.say" || choice === undefined) return undefined;
  const raw = choice["options"];
  if (!Array.isArray(raw)) return undefined;
  const options: string[] = [];
  for (const entry of raw as unknown[]) {
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
    if (typeof entry !== "string" || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(entry)) return undefined;
    const option = pySplit(entry).join(" ");
    if (!option || cpLength(option) > CHOICE_OPTION_MAX) return undefined;
    if (!options.includes(option)) options.push(option);
  }
  if (options.length < CHOICE_OPTIONS_MIN || options.length > CHOICE_OPTIONS_MAX) return undefined;
  return { options, multiple: choice["multiple"] === true };
}

export interface RemoteNotice {
  /** `resolved`: a question a terminal asked no longer waits here (answered there, or given up); `resolved` says which. */
  readonly kind: "done" | "needs_you" | "error" | "resolved";
  readonly sessionId: string;
  readonly ask: Event | undefined;
  readonly machine: string;
  /** Who asked, as the person knows it: the tool's name (Claude Code, Codex, Cursor) when Claw said which, else the agent's id. */
  readonly agent: string;
  readonly resolved?: { readonly actionId: string; readonly by: string };
}

const REMOTE_KINDS = new Set(["done", "needs_you", "error", "resolved"]);

/**
 * The tools a terminal's question can come from (`remote.tool`, Claw names it when the connector said which), by the names their
 * users know them by: the card says these instead of the connector's id for the agent (`claude-sessions`).
 */
const TERMINAL_TOOL_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** A `resolved` notice's request and who ended it; undefined when it names no request. */
function resolvedOf(remote: Event): RemoteNotice["resolved"] {
  const resolved = record(remote["resolved"]);
  const actionId = resolved?.["action_id"];
  return resolved && typeof actionId === "string" && actionId ? { actionId, by: field(resolved["by"]) } : undefined;
}

const toolName = (tool: unknown): string | undefined =>
  typeof tool === "string" && Object.hasOwn(TERMINAL_TOOL_NAMES, tool) ? TERMINAL_TOOL_NAMES[tool] : undefined;

/** What an `assistant.say` says of an agent session on the person's machine, or undefined for any other message. */
export function remoteNoticeOf(event: Event): RemoteNotice | undefined {
  const remote = event["type"] === "assistant.say" ? record(event["remote"]) : undefined;
  const kind = remote?.["kind"];
  if (remote === undefined || typeof kind !== "string" || !REMOTE_KINDS.has(kind)) return undefined;
  const sessionId = remote["session_id"];
  if (typeof sessionId !== "string" || !sessionId) return undefined;
  const resolved = kind === "resolved" ? resolvedOf(remote) : undefined;
  if (kind === "resolved" && resolved === undefined) return undefined;
  return {
    ...(resolved ? { resolved } : {}),
    kind: kind as RemoteNotice["kind"],
    sessionId,
    ask: record(remote["ask"]),
    machine: field(remote["machine"]),
    agent: toolName(remote["tool"]) ?? field(remote["agent"]),
  };
}
