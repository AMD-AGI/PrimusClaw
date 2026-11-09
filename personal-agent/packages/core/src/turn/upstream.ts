// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * INTERIM (W4b): the one file through which the turn module reaches what other lines own. Until their branches land,
 * minimal stand-ins live here; each block is replaced by a re-export of the owning line's module:
 * - Claw stream types and errors, `clipPrSummary`, `errorKind`, `serviceRefusal`: W2 (core/src/claw, ClawPort).
 * - step labels (`labelFor`, `failedLine`, `isShell`, `skillInCommand`): W2.
 * - public error (`looksLikeFailure`, `splitErrorTail`, `withhold`): W2.
 * - `pickLang`: W5 (approval view).
 */

import { clipWithEllipsis, collapseSpaces, pySlice, pyStrip } from "../text/python-str.js";

// --- Claw (W2) -------------------------------------------------------------------------------------------------------

export { HISTORY_COMPLETE_EVENT as HISTORY_COMPLETE } from "../protocol.js";
export { ClawAnswerInvalid, ClawError, ClawUnreachable, errorKind, ReplayRefused } from "../claw/errors.js";
export type { SseEvent } from "../claw/model.js";

/** The message id of a turn Claw runs from its queue (api tasks/chat-run.ts). */
export const QUEUED_PREFIX = "claw-pending-";

export const SERVICE_REFUSAL_REASONS: Readonly<Record<string, string>> = {
  service_client_not_allowed:
    "PrimusClaw does not take answers from me yet: its operator has to allow this worker's client.",
  interactive_sign_in_required: "PrimusClaw did not take my credential for you as a sign-in; tell the operator.",
  only_the_acting_user_can_decide: "PrimusClaw says this answer is not yours to give.",
};

/** The sentence for a refusal of Claw's: its reason (a word it does not name is the last one) and what was not done. */
export function serviceRefusal(code: string, undone: string): string {
  const reason = SERVICE_REFUSAL_REASONS[code] ?? SERVICE_REFUSAL_REASONS["only_the_acting_user_can_decide"];
  return `${reason ?? ""} ${undone}`;
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\u{20000}-\u{2fa1f}]/u;
const SUMMARY_MARKUP: Readonly<Record<string, string>> = { "[": "［", "]": "］", "<": "‹", ">": "›" };

/** A review's sentence of what the pull request does, as shown (interim: without credential masking). */
export function clipPrSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  const line = pyStrip(collapseSpaces(value).replace(/[[\]<>]/g, (c) => SUMMARY_MARKUP[c] ?? c));
  if (!line) return "";
  return clipWithEllipsis(line, CJK.test(line) ? 80 : 160);
}

// --- language (W5) ---------------------------------------------------------------------------------------------------

export { hasCjk, pickLang } from "../language/detect.js";

// --- step labels (W2) ------------------------------------------------------------------------------------------------

/**
 * The MCP servers a deployment registers (INTERIM stand-in for W4's IntegrationRegistry): their shown names, and the ones
 * whose reads a progress line names ("Querying <server>").
 */
const INTEGRATIONS: { mcpServers: Readonly<Record<string, string>>; queryServers: ReadonlySet<string> } = {
  mcpServers: {},
  queryServers: new Set(),
};

/** Registers a deployment's MCP servers (tests: a fictional one). */
export function setIntegrations(mcpServers: Readonly<Record<string, string>>, queryServers: Iterable<string>): void {
  INTEGRATIONS.mcpServers = mcpServers;
  INTEGRATIONS.queryServers = new Set(queryServers);
}

export class Label {
  constructor(
    readonly one: string,
    readonly many?: string,
  ) {}

  text(count = 1): string {
    return count > 1 ? `${this.many ?? this.one} (${String(count)})` : this.one;
  }
}

/** A derived name is clipped to this. */
const NAME_MAX = 60;
const PY_SPACES = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SEPARATORS = new RegExp(`[_\\-${PY_SPACES}]+`, "gu");
const CAMEL = /(?<=[a-z0-9])(?=[A-Z])/g;
/** What a derived name keeps (Python's `[^\\w .:/+-]` with Unicode `\\w`): it is shown as text. */
const UNSAFE = /[^\p{L}\p{N}_ .:/+-]/gu;
const SKILL_DIR = /\.skills\/([A-Za-z0-9][A-Za-z0-9._-]{0,40})\//;
const MCP = /^mcp__(.+?)__(.+)$/i;
const SHELLS: ReadonlySet<string> = new Set(["bash", "shell", "sh"]);

type Kind = "read" | "edit" | "shell" | "search" | "web" | "task" | "board_read" | "safe";

const LABELS: Readonly<Record<"en" | "zh", Readonly<Record<Kind, Label>>>> = {
  en: {
    read: new Label("Reading a file", "Reading files"),
    edit: new Label("Editing a file", "Editing files"),
    shell: new Label("Running a command", "Running commands"),
    search: new Label("Searching files"),
    web: new Label("Looking something up online"),
    task: new Label("Running a sub-task", "Running sub-tasks"),
    board_read: new Label("Reading a board topic", "Reading board topics"),
    safe: new Label("Querying SaFE"),
  },
  zh: {
    read: new Label("读取文件"),
    edit: new Label("修改文件"),
    shell: new Label("执行命令"),
    search: new Label("搜索文件"),
    web: new Label("在线查询"),
    task: new Label("执行子任务"),
    board_read: new Label("读取看板话题"),
    safe: new Label("查询 SaFE"),
  },
};

const PHRASES = {
  en: {
    boardList: (what: string) => `Listing board ${what}`,
    skill: (skill: string) => `Using the ${skill} skill`,
    generic: (what: string) => `Working: ${what}`,
    failed: (label: string) => `⚠️ ${label} failed, continuing`,
    query: (server: string) => `Querying ${server}`,
  },
  zh: {
    boardList: (what: string) => `查看看板${what}`,
    skill: (skill: string) => `使用 ${skill} 技能`,
    generic: (what: string) => `处理中：${what}`,
    failed: (label: string) => `⚠️ ${label}失败，已继续`,
    query: (server: string) => `查询 ${server}`,
  },
} as const;

/** "Listing board issues" names what is listed in English; Chinese says "the lists". */
const ZH_BOARD_LIST = "列表";

const PLAIN: Readonly<Record<string, Kind>> = {
  read: "read",
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  bash: "shell",
  shell: "shell",
  sh: "shell",
  grep: "search",
  glob: "search",
  ls: "search",
  find: "search",
  webfetch: "web",
  websearch: "web",
  task: "task",
};

function langKey(lang: string): "en" | "zh" {
  return lang === "zh" ? "zh" : "en";
}

function words(name: string): string {
  const spaced = pyStrip(name.replace(CAMEL, " ").replace(SEPARATORS, " ")).toLowerCase();
  return pyStrip(pySlice(spaced.replace(UNSAFE, ""), 0, NAME_MAX));
}

/** The skill directory a shell command works in (`/workspace/.skills/<name>/...`), else undefined. */
export function skillInCommand(command: unknown): string | undefined {
  return typeof command === "string" ? SKILL_DIR.exec(command)?.[1] : undefined;
}

export function isShell(tool: string): boolean {
  return SHELLS.has(pyStrip(tool).toLowerCase());
}

/** A label from the server and verb of an MCP name: the board's reads and lists, a deployment's queries, SaFE. */
function serverLabel(server: string, verb: string, lang: "en" | "zh"): Label | undefined {
  const s = server.toLowerCase();
  const v = verb.toLowerCase();
  if (s === "agent-board" && v === "issue_read") return LABELS[lang].board_read;
  if (s === "agent-board" && v.startsWith("list_")) {
    return new Label(PHRASES[lang].boardList(lang === "zh" ? ZH_BOARD_LIST : words(verb.slice(5)) || "items"));
  }
  const shown = INTEGRATIONS.mcpServers[s];
  if (INTEGRATIONS.queryServers.has(s) && (v.startsWith("get_") || v.startsWith("list_")) && shown !== undefined) {
    return new Label(PHRASES[lang].query(shown));
  }
  return s === "safe" ? LABELS[lang].safe : undefined;
}

/**
 * The label of the step `tool` is: `skill` first, then the plain tools, then the MCP servers Claw ships and those a
 * deployment registers, then the generic fallback ("Working: <server> <verb>"). The same tool always gets the same label.
 */
export function labelFor(tool: string, skill?: string, lang = "en"): Label {
  const key = langKey(lang);
  const raw = collapseSpaces(tool);
  if (skill) return new Label(PHRASES[key].skill(skill));
  const kind = PLAIN[raw.toLowerCase()];
  if (kind) return LABELS[key][kind];
  const match = MCP.exec(raw);
  const server = match?.[1] ?? "";
  const verb = match ? (match[2] ?? "") : raw.replace(/^mcp__/i, "");
  const known = serverLabel(server, verb, key);
  if (known) return known;
  const what = [words(server), words(verb)].filter((w) => w).join(" ") || "a step";
  return new Label(PHRASES[key].generic(what));
}

export function failedLine(label: Label, lang = "en"): string {
  return PHRASES[langKey(lang)].failed(label.one);
}

// --- public error (W2) -----------------------------------------------------------------------------------------------

const SERVICE_ERROR =
  /^\s*(?:(?:API |[A-Za-z_.]{1,40})Error:\s*){0,3}[1-5]\d\d\b|^\s*Traceback \(most recent call last\)|^\s*(?:API Error|[A-Za-z_.]{0,40}(?:Error|Exception))\s*:/;
const BRAIN_ERROR =
  /^\s*(?:(?:API |[A-Za-z_.]{1,40})Error:\s*){0,3}[1-5]\d\d\b|^\s*Traceback \(most recent call last\)|^\s*(?:API Error|[A-Za-z_]{1,30}\.[A-Za-z_.]{0,40}(?:Error|Exception))\s*:/;

/** True when `text` is the error a model call or a service failed with (interim: Brain's error shape only). */
export function looksLikeFailure(text: unknown): boolean {
  return typeof text === "string" && SERVICE_ERROR.test(text);
}

/** A failed turn's last text split into the model's own words and Brain's error that ended it (interim: no fences). */
export function splitErrorTail(text: unknown): [string, string] {
  if (typeof text !== "string" || !pyStrip(text)) return ["", ""];
  const paragraphs = text.split(/(\n[ \t]*\n)/);
  let at = 0;
  for (let i = 0; i < paragraphs.length; i += 2) {
    const para = paragraphs[i] ?? "";
    if (BRAIN_ERROR.test(para.replace(/^\n+/, ""))) {
      return [text.slice(0, at).trimEnd(), pyStrip(text.slice(at))];
    }
    at += para.length + (paragraphs[i + 1]?.length ?? 0);
  }
  return [text, ""];
}
