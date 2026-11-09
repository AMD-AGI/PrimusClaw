// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Lang } from "../locales/lang.js";
import { ASSISTANT_STEPS, SAFE_OBJECTS, stepText } from "../locales/step-labels.js";
import { PY_W_CHARS } from "../text/py-regex.js";
import { cpHead, pyStrip, squashSpaces } from "../text/py-text.js";

/** A derived name is clipped to this. */
export const NAME_MAX = 60;
const MCP = /^mcp__(.+?)__(.+)$/isu;
const SEPARATORS = /[_\-\s]+/gu;
const CAMEL = /(?<=[a-z0-9])(?=[A-Z])/gu;
/** What a derived name keeps: it is shown as text, whatever the tool is called. */
const UNSAFE = new RegExp(`[^${PY_W_CHARS} .:/+-]`, "gu");
export const SKILL_NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,40}";
const SKILL_DIR = new RegExp(`\\.skills/(${SKILL_NAME})/`, "u");
const SHELLS = new Set(["bash", "shell", "sh"]);

/** The servers a deployment registers (its integration module): name -> what people see, and those whose reads are named. */
export interface StepServers {
  readonly mcpServers: ReadonlyMap<string, string>;
  readonly queryServers: ReadonlySet<string>;
}

export const NO_SERVERS: StepServers = { mcpServers: new Map(), queryServers: new Set() };

/** The line of one step, and of the same step repeated. */
export class Label {
  constructor(
    /** "Reading a file"; also what consecutive repeats are collapsed by. */
    readonly one: string,
    /** "Reading files": when the same step repeats; null: reuse `one`. */
    readonly many: string | null = null,
  ) {}

  text(count = 1): string {
    return count > 1 ? `${this.many || this.one} (${String(count)})` : this.one;
  }
}

type Kind = "read" | "edit" | "shell" | "search" | "web" | "task" | "board_read" | "safe";

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

function labelOf(kind: Kind, lang: Lang): Label {
  const text = stepText.in(lang);
  return new Label(text[kind], text[`${kind}Many`] || null);
}

function words(name: string): string {
  const spaced = pyStrip(name.replace(CAMEL, " ").replace(SEPARATORS, " ")).toLowerCase();
  return pyStrip(cpHead(spaced.replace(UNSAFE, ""), NAME_MAX));
}

/** The skill directory a shell command works in (`.../.skills/<name>/...`), when it is a plain name; else null. */
export function skillInCommand(command: unknown): string | null {
  return typeof command === "string" ? (SKILL_DIR.exec(command)?.[1] ?? null) : null;
}

export function isShell(tool: string): boolean {
  return SHELLS.has(pyStrip(tool).toLowerCase());
}

/** (server, verb) of a tool name: `mcp__server__verb`, or ("", the name without a leading `mcp__`). */
function partsOf(raw: string): readonly [string, string] {
  const match = MCP.exec(raw);
  return match ? [match[1] ?? "", match[2] ?? ""] : ["", raw.replace(/^mcp__/iu, "")];
}

function serverLabel(server: string, verb: string, lang: Lang, servers: StepServers): Label | null {
  const text = stepText.in(lang);
  const s = server.toLowerCase();
  const v = verb.toLowerCase();
  if (s === "agent-board" && v === "issue_read") return labelOf("board_read", lang);
  if (s === "agent-board" && v.startsWith("list_")) {
    return new Label(text.boardList({ what: lang === "zh" ? text.boardListed : words(verb.slice(5)) || "items" }));
  }
  const shown = servers.mcpServers.get(s);
  if (servers.queryServers.has(s) && shown !== undefined && (v.startsWith("get_") || v.startsWith("list_"))) {
    return new Label(text.serverLookup({ server: shown }));
  }
  return s === "safe" ? labelOf("safe", lang) : null;
}

/**
 * The label of the step `tool` is: `skill` (a shell step that runs a skill's script) first, then the plain tools, then
 * the MCP servers Claw ships and those a deployment registers, then "Working: <server> <verb>" derived from the name, so
 * a raw `mcp__server__verb` name never reaches a person. The same tool always gets the same label.
 */
export function labelFor(tool: unknown, skill: string | null = null, lang: Lang = "en", servers = NO_SERVERS): Label {
  const text = stepText.in(lang);
  const raw = squashSpaces(typeof tool === "string" ? tool : "");
  if (skill) return new Label(text.skill({ skill }));
  const kind = PLAIN[raw.toLowerCase()];
  if (kind !== undefined) return labelOf(kind, lang);
  const [server, verb] = partsOf(raw);
  const known = serverLabel(server, verb, lang, servers);
  if (known !== null) return known;
  const what = [words(server), words(verb)].filter((w) => w).join(" ");
  return new Label(text.generic({ what: what || "a step" }));
}

/**
 * The step an assistant's turn is on, for its receipt: a SaFE lookup by what it reads ("查询 SaFE 节点"), one of
 * another known server by the server, the assistant's own tools by what they do; anything else is `labelFor`'s.
 */
export function lookupLabel(tool: unknown, lang: Lang = "en", servers = NO_SERVERS): string {
  const [server, verb] = mcpParts(tool);
  return ownLookup(server, verb, lang, servers) ?? labelFor(tool, null, lang, servers).one;
}

/** (server, verb) in lower case of an `mcp__server__verb` name; ("", "") for any other. */
function mcpParts(tool: unknown): readonly [string, string] {
  const match = MCP.exec(squashSpaces(typeof tool === "string" ? tool : ""));
  return [(match?.[1] ?? "").toLowerCase(), (match?.[2] ?? "").toLowerCase()];
}

function ownLookup(server: string, verb: string, lang: Lang, servers: StepServers): string | null {
  const at = lang === "zh" ? 1 : 0;
  const own = server === "assistant" ? ASSISTANT_STEPS[verb] : undefined;
  if (own !== undefined) return own[at];
  const objects = server === "safe" ? SAFE_OBJECTS[verb.split("_")[0] ?? ""] : undefined;
  if (objects !== undefined) return stepText.in(lang).safeLookup({ what: objects[at] });
  const shown = server === "safe" ? "SaFE" : servers.mcpServers.get(server);
  return shown ? stepText.in(lang).serverLookup({ server: shown }) : null;
}

/** The line a failed step stays visible as. */
export function failedLine(label: Label, lang: Lang = "en"): string {
  return stepText.in(lang).failed({ label: label.one });
}
