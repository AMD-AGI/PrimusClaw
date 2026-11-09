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
import type { JsonObject } from "./json.js";

// --- Claw (W2) -------------------------------------------------------------------------------------------------------

/** One event of a session's stream. */
export interface SseEvent {
  readonly id: string;
  readonly name: string;
  readonly data: JsonObject;
}

/** The SSE frame that ends the replay of history. */
export const HISTORY_COMPLETE = "historyComplete";
/** The message id of a turn Claw runs from its queue. */
export const QUEUED_PREFIX = "claw-pending-";

/** Claw answered with an error status; `code` is its plain error word ('' none). */
export class ClawError extends Error {
  constructor(
    readonly status: number,
    readonly code = "",
  ) {
    super(code ? `HTTP ${String(status)} ${code}` : `HTTP ${String(status)}`);
    this.name = "ClawError";
  }
}

/** The request never got an answer (connection refused, reset, timed out): Python's httpx.HTTPError. */
export class ClawUnreachable extends Error {
  constructor(
    readonly kind: string,
    readonly connect = false,
  ) {
    super(kind);
    this.name = "ClawUnreachable";
  }
}

/** Claw answered with something that is not what its contract says (a body that is not JSON, a field of the wrong type). */
export class ClawReplyInvalid extends Error {
  constructor(what: string) {
    super(what);
    this.name = "ClawReplyInvalid";
  }
}

/** What a log line says about a failed call: Claw's status (and error word), or only the kind of error. */
export function errorKind(err: unknown): string {
  if (err instanceof ClawError) return err.message;
  if (err instanceof ClawUnreachable) return err.kind;
  if (err instanceof ClawReplyInvalid) return err.name;
  return err instanceof Error ? err.name : typeof err;
}

export const SERVICE_REFUSAL_REASONS: Readonly<Record<string, string>> = {
  service_client_not_allowed:
    "PrimusClaw does not take answers from me yet: its operator has to allow this worker's client.",
  interactive_sign_in_required: "PrimusClaw did not take my credential for you as a sign-in; tell the operator.",
  only_the_acting_user_can_decide: "PrimusClaw says this answer is not yours to give.",
};

export function serviceRefusal(err: ClawError, undone: string): string {
  const reason = SERVICE_REFUSAL_REASONS[err.code] ?? SERVICE_REFUSAL_REASONS["only_the_acting_user_can_decide"];
  return `${reason ?? ""} ${undone}`;
}

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿\u{20000}-\u{2fa1f}]/u;
const SUMMARY_MARKUP: Readonly<Record<string, string>> = { "[": "［", "]": "］", "<": "‹", ">": "›" };

/** A review's sentence of what the pull request does, as shown (interim: without credential masking). */
export function clipPrSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  const line = pyStrip(collapseSpaces(value).replace(/[[\]<>]/g, (c) => SUMMARY_MARKUP[c] ?? c));
  if (!line) return "";
  return clipWithEllipsis(line, CJK.test(line) ? 80 : 160);
}

// --- language (W5) ---------------------------------------------------------------------------------------------------

export function hasCjk(text: unknown): boolean {
  return CJK.test(typeof text === "string" ? text : "");
}

/** Chinese when the first text that has any letters has Chinese in it, else English. */
export function pickLang(...texts: unknown[]): "en" | "zh" {
  for (const text of texts) {
    if (typeof text === "string" && pyStrip(text)) return hasCjk(text) ? "zh" : "en";
  }
  return "en";
}

// --- step labels (W2) ------------------------------------------------------------------------------------------------

export class Label {
  constructor(
    readonly one: string,
    readonly many?: string,
  ) {}

  text(count = 1): string {
    return count > 1 ? `${this.many ?? this.one} (${String(count)})` : this.one;
  }
}

const PLAIN: Readonly<Record<string, [string, string?]>> = {
  read: ["Reading a file", "Reading files"],
  edit: ["Editing a file", "Editing files"],
  shell: ["Running a command", "Running commands"],
  search: ["Searching files"],
  web: ["Looking something up online"],
  task: ["Running a sub-task", "Running sub-tasks"],
};
const PLAIN_ZH: Readonly<Record<string, string>> = {
  read: "读取文件",
  edit: "修改文件",
  shell: "执行命令",
  search: "搜索文件",
  web: "在线查询",
  task: "执行子任务",
};
const KIND: Readonly<Record<string, string>> = {
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
const SKILL_DIR = /\.skills\/([A-Za-z0-9][A-Za-z0-9._-]{0,40})\//;
const MCP = /^mcp__(.+?)__(.+)$/is;

function words(name: string): string {
  const spaced = name
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .toLowerCase();
  return pyStrip(pySlice(spaced.replace(/[^\w .:/+-]/gu, ""), 0, 60));
}

export function skillInCommand(command: unknown): string | undefined {
  return typeof command === "string" ? SKILL_DIR.exec(command)?.[1] : undefined;
}

export function isShell(tool: string): boolean {
  return ["bash", "shell", "sh"].includes(pyStrip(tool).toLowerCase());
}

export function labelFor(tool: string, skill?: string, lang = "en"): Label {
  const zh = lang === "zh";
  const raw = collapseSpaces(tool);
  if (skill) return new Label(zh ? `使用 ${skill} 技能` : `Using the ${skill} skill`);
  const kind = KIND[raw.toLowerCase()];
  if (kind) {
    const [one, many] = PLAIN[kind] ?? [raw];
    return zh ? new Label(PLAIN_ZH[kind] ?? one) : new Label(one, many);
  }
  const match = MCP.exec(raw);
  const [server, verb] = match ? [match[1] ?? "", match[2] ?? ""] : ["", raw.replace(/^mcp__/i, "")];
  if (server.toLowerCase() === "safe") return new Label(zh ? "查询 SaFE" : "Querying SaFE");
  const what = [words(server), words(verb)].filter((w) => w).join(" ") || "a step";
  return new Label(zh ? `处理中：${what}` : `Working: ${what}`);
}

export function failedLine(label: Label, lang = "en"): string {
  return lang === "zh" ? `⚠️ ${label.one}失败，已继续` : `⚠️ ${label.one} failed, continuing`;
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

/** A new reference id for the user's sentence (interim: W2's `withhold` also logs the detail under it). */
export function withhold(where: string, detail: unknown = "", ids: Record<string, unknown> = {}): string {
  const ref = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  WITHHELD.push({ ref, where, detail, ids });
  return ref;
}

/** What `withhold` was given (interim, for tests: W2's logs it). */
export const WITHHELD: Array<{ ref: string; where: string; detail: unknown; ids: Record<string, unknown> }> = [];
