// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Plain words as the command they mean: the sentences help teaches (and a few ways of saying the same) read as the command, so
 * `晚上 10 点到早上 8 点别打扰我` sets quiet hours just as `/quiet 22:00-08:00` does. A sentence is read only when it is the whole
 * message and says exactly that; anything else is a request for Claw, as before.
 */
import { pyLower, pyLstrip, pyRstrip, pySplit, pyStrip } from "../text/py-text.js";
import { pyFullmatch } from "../text/py-regex.js";
import * as P from "./phrases.js";
import { sessionControl, switchCommand } from "./sessions-words.js";
import { clockOf, flatten, NUM, phraseKey, PUNCT, spokenDuration, TIME } from "./spoken.js";

export { clockOf, sessionControl, switchCommand };

function keys(phrases: readonly string[]): ReadonlySet<string> {
  return new Set(phrases.map(phraseKey));
}

function whole(source: string, flags = ""): RegExp {
  return pyFullmatch(source, flags);
}

const BY_LONGEST = (a: string, b: string): number => b.length - a.length;
const DETACH_LEAD = [...P.DETACH_LEAD].sort(BY_LONGEST);
const DETACH_TAIL = [...P.DETACH_TAIL].sort(BY_LONGEST);

/** `key` (a whole message as `phraseKey` makes it) without the words people put around a detach, from either end, repeatedly. */
export function detachKey(key: string): string {
  let rest = key;
  let changed = true;
  while (changed && rest !== "") {
    changed = false;
    for (const lead of DETACH_LEAD) {
      if (rest.startsWith(lead) && rest.length > lead.length) {
        rest = pyLstrip(rest.slice(lead.length), PUNCT);
        changed = true;
      }
    }
    for (const tail of DETACH_TAIL) {
      if (rest.endsWith(tail) && rest.length > tail.length) {
        rest = pyRstrip(rest.slice(0, -tail.length), PUNCT);
        changed = true;
      }
    }
  }
  return rest;
}

const TO = String.raw`\s*(?:到|至|-|~|～|—)\s*`;
const QUIET_PATTERNS: readonly RegExp[] = [
  whole(
    String.raw`(?:每天)?\s*(?:从)?\s*(?<a>${TIME})${TO}(?<b>${TIME})\s*(?:之间)?\s*(?:都)?\s*(?:别|不要|勿|请勿|不用)\s*(?:打扰|吵|通知|找)\s*我?`,
  ),
  whole(
    String.raw`(?:把)?\s*免打扰(?:时间|时段)?\s*(?:改成|设成|设为|设置为|改为|是)?\s*(?<a>${TIME})${TO}(?<b>${TIME})`,
  ),
  whole(String.raw`quiet hours\s+(?<a>\d{1,2}:\d{2})\s*-\s*(?<b>\d{1,2}:\d{2})`, "i"),
];
const PAUSE_PATTERNS: readonly RegExp[] = [
  whole(
    String.raw`(?:先)?\s*(?:暂停(?:通知|消息)?|别给我发(?:通知|消息)?)\s*(?<n>${NUM}|半)\s*(?<u>分钟|分|个小时|小时|个钟头|钟头|天)`,
  ),
  whole(
    String.raw`(?<n>${NUM}|半)\s*(?<u>分钟|个小时|小时|个钟头|钟头|天)\s*(?:内|之内)?\s*(?:别|不要)\s*(?:打扰|给我发消息|通知)\s*我?`,
  ),
  whole(String.raw`pause notifications for (?<n>\d{1,4}) ?(?<u>minutes?|hours?|days?)`, "i"),
];
const BRIEF_PATTERNS: readonly RegExp[] = [
  whole(
    String.raw`(?:每个?)?\s*(?:工作日|每天|每日)?\s*(?<t>${TIME})\s*(?:给我)?\s*发\s*(?:一份)?\s*(?:简报|日报|每日简报)(?:给我)?`,
  ),
  whole(String.raw`send me a brief every (?:week)?day at (?<t>\d{1,2}:\d{2})`, "i"),
];
const TIMEZONE_PATTERNS: readonly RegExp[] = [
  whole(
    String.raw`(?:把)?\s*(?:我的)?\s*时区\s*(?:改成|设成|设为|设置为|改为|是)\s*(?<z>[A-Za-z_]+(?:/[A-Za-z0-9_+-]+){0,2})`,
  ),
  whole(String.raw`set my time ?zone to (?<z>[A-Za-z_]+(?:/[A-Za-z0-9_+-]+){0,2})`, "i"),
];
const LANG_PATTERNS: readonly RegExp[] = [
  whole(
    String.raw`(?:以后|之后|今后|从现在起|从现在开始)?\s*(?:请|麻烦)?\s*(?:都|一律)?\s*(?:用|说)\s*(?<l>中文|汉语|英文|英语)` +
      String.raw`\s*(?:回复|回答|回我|跟我说|和我说|跟我交流|和我交流|交流)?\s*(?:吧|好吗|好不好|可以吗)?`,
  ),
  whole(
    String.raw`(?:please\s+)?(?:reply|answer|talk|speak|respond)(?:\s+to\s+me)?\s+in\s+(?<l>english|chinese)` +
      String.raw`(?:\s+from\s+now\s+on)?(?:\s+please)?`,
    "i",
  ),
];
const LANG_WORDS: Readonly<Record<string, string>> = {
  中文: "zh",
  汉语: "zh",
  英文: "en",
  英语: "en",
  english: "en",
  chinese: "zh",
};
/** Python's Unicode `[\w.-]` and `[\w./-]`. */
const NAME_CHARS = String.raw`[\p{L}\p{N}_.-]`;
const BRANCH_CHARS = String.raw`[\p{L}\p{N}_./-]`;
const REPO_PATTERNS: readonly RegExp[] = [
  whole(
    String.raw`(?:切到|换到|进到)\s*(?:仓库)?\s*(?<r>[A-Za-z0-9]${NAME_CHARS}*/${NAME_CHARS}+)(?:\s*仓库)?` +
      String.raw`(?:\s+(?<b>${BRANCH_CHARS}+)\s*分支)?`,
  ),
  whole(String.raw`switch to repo (?<r>[A-Za-z0-9]${NAME_CHARS}*/${NAME_CHARS}+)(?: (?<b>${BRANCH_CHARS}+))?`, "i"),
];
const FEEDBACK = whole(String.raw`(?:我要)?(?:反馈|报告问题|报个问题|feedback)\s*[:：]\s*(?<t>.+)`, "is");

/** Phrase lists that are read in a group chat too (what a group may do), in the order they are tried. */
const GROUP_PHRASES: readonly (readonly [ReadonlySet<string>, string])[] = [
  [keys(P.HELP), "/help"],
  [keys(P.STOP), "/stop"],
  [keys(P.NEW), "/new"],
  [keys(P.WHOAMI), "/whoami"],
];
const STOP_IT = keys(P.STOP_IT);
const DETACH = keys(P.DETACH);
const FEEDBACK_ALONE = keys(P.FEEDBACK_ALONE);
/** Phrase lists read only in a 1:1 chat, in the order they are tried. */
const PERSONAL_PHRASES: readonly (readonly [ReadonlySet<string>, string])[] = [
  [keys(P.SESSIONS), "/sessions"],
  [keys(P.BOARD), "/board"],
  [keys(P.MEMORY), "/memory"],
  [keys(P.MEMORY_ON), "/memory on"],
  [keys(P.MEMORY_OFF), "/memory off"],
  [keys(P.UNLINK), "/unlink"],
  [keys(P.AGENTS), "/agents"],
  [keys(P.AGENT_SESSIONS), "/agent sessions"],
  [DETACH, "/agent detach"],
  [keys(P.RESUME), "/resume"],
  [keys(P.QUIET_SHOW), "/quiet"],
  [keys(P.QUIET_OFF), "/quiet off"],
  [keys(P.BRIEF_OFF), "/brief off"],
  [keys(P.BRIEF_NOW), "/brief now"],
  [keys(P.PAUSE_ALL), "/pause"],
  [keys(P.GITHUB_BIND), "/github bind"],
  [keys(P.GITHUB_UNBIND), "/github unbind"],
  [keys(P.GITHUB_STATUS), "/github status"],
  [keys(P.DELEGATION_ON), "/github auto-merge on"],
  [keys(P.DELEGATION_OFF), "/github auto-merge off"],
  [keys(P.TIMEZONE_SHOW), "/timezone"],
  [keys(P.LANG_AUTO), "/lang auto"],
];

function lookUp(key: string, table: readonly (readonly [ReadonlySet<string>, string])[]): string | null {
  for (const [phrases, command] of table) if (phrases.has(key)) return command;
  return null;
}

function firstMatch(flat: string, patterns: readonly RegExp[]): Record<string, string | undefined> | null {
  for (const pattern of patterns) {
    const groups = pattern.exec(flat)?.groups;
    if (groups !== undefined) return groups;
  }
  return null;
}

function quietCommand(flat: string): string | null {
  for (const pattern of QUIET_PATTERNS) {
    const groups = pattern.exec(flat)?.groups;
    if (groups === undefined) continue;
    const start = clockOf(groups["a"] ?? "");
    const end = clockOf(groups["b"] ?? "");
    if (start !== null && end !== null && start !== end) return `/quiet ${start}-${end}`;
  }
  return null;
}

function pauseCommand(flat: string): string | null {
  for (const pattern of PAUSE_PATTERNS) {
    const groups = pattern.exec(flat)?.groups;
    const span = groups === undefined ? null : spokenDuration(groups["n"] ?? "", groups["u"] ?? "");
    if (span !== null) return `/pause ${span}`;
  }
  return null;
}

function briefCommand(flat: string): string | null {
  for (const pattern of BRIEF_PATTERNS) {
    const groups = pattern.exec(flat)?.groups;
    const at = groups === undefined ? null : clockOf(groups["t"] ?? "");
    if (at !== null) return `/brief on ${at}`;
  }
  return null;
}

function settingCommand(flat: string): string | null {
  const zone = firstMatch(flat, TIMEZONE_PATTERNS);
  if (zone !== null) return `/timezone ${zone["z"] ?? ""}`;
  const lang = firstMatch(flat, LANG_PATTERNS);
  if (lang === null) return null;
  const word = pyLower(lang["l"] ?? "");
  return `/lang ${Object.hasOwn(LANG_WORDS, word) ? (LANG_WORDS[word] ?? "") : ""}`;
}

function repoCommand(flat: string): string | null {
  const repo = firstMatch(flat, REPO_PATTERNS);
  if (repo === null) return null;
  const branch = repo["b"];
  return `/repo ${repo["r"] ?? ""}${branch ? ` ${branch}` : ""}`;
}

/** The sentences with a value in them, in the order they are tried. */
const VALUED: readonly ((flat: string) => string | null)[] = [
  quietCommand,
  pauseCommand,
  briefCommand,
  settingCommand,
  switchCommand,
  repoCommand,
];

function personal(text: string, flat: string, key: string): string {
  if (STOP_IT.has(key)) return "/stop";
  if (DETACH.has(detachKey(key))) return "/agent detach";
  const phrase = lookUp(key, PERSONAL_PHRASES);
  if (phrase !== null) return phrase;
  for (const read of VALUED) {
    const command = read(flat);
    if (command !== null) return command;
  }
  return text;
}

function natural(text: string, group: boolean): string {
  if (text === "" || pyLstrip(text).startsWith("/")) return text;
  const flat = flatten(text);
  const key = phraseKey(text);
  const feedback = pyStrip(FEEDBACK.exec(flat)?.groups?.["t"] ?? "");
  if (feedback) return `/feedback ${feedback}`;
  if (FEEDBACK_ALONE.has(key)) return "/feedback";
  const command = lookUp(key, GROUP_PHRASES);
  if (command !== null) return command;
  return group ? text : personal(text, flat, key);
}

/**
 * `text` as the command it means when it is one of the plain sentences help teaches (or a close way of saying it), else `text`
 * itself. Only the whole message counts. `group`: a group chat reads only what a group may do (help, stop, a new session, which
 * account, feedback). `off`: what this chat cannot do right now, as a command word (`board` without the assistant, `github` without
 * the review service, `agents` and `agent` with remote agents off) or a command and its verb (`agent detach` with no agent
 * attached): a sentence that would mean one of them stays the words it is, for Claw.
 */
export function naturalCommand(text: string, group = false, off: ReadonlySet<string> = new Set()): string {
  const command = natural(text, group);
  if (command === text) return text;
  if (command === "/stop" && off.has("stop it") && STOP_IT.has(phraseKey(text))) return text;
  const parts = pySplit(command.slice(1));
  const first = parts[0] ?? "";
  return off.has(first) || off.has(parts.slice(0, 2).join(" ")) ? text : command;
}
