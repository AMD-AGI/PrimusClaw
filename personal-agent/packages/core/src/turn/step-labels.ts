// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The one live line a running tool step gets in the progress view: a short human label, never the tool's raw name
 * (step_labels.py). Nothing here knows a tool's input. Names it does not know become "Working: <server> <verb>", derived
 * from the name itself, so an `mcp__server__verb` name never reaches the user.
 */

import type { Lang } from "../locales/lang.js";
import { ASSISTANT_STEPS, SAFE_OBJECTS, stepText } from "../locales/steps.js";
import { type Integrations, noIntegrations } from "../plugins/integrations.js";
import { cpSlice, pyStrip, squashSpaces } from "../text/py-text.js";

export class Label {
  constructor(
    /** "Reading a file"; also what consecutive repeats are collapsed by. */
    readonly one: string,
    /** "Reading files": used when the same step repeats; undefined: reuse `one`. */
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
/** What a derived name keeps (Python's `[^\w .:/+-]` with Unicode `\w`): it is shown as text, whatever the tool is called. */
const UNSAFE = /[^\p{L}\p{N}_ .:/+-]/gu;
const SKILL_DIR = /\.skills\/([A-Za-z0-9][A-Za-z0-9._-]{0,40})\//;
const MCP = /^mcp__(.+?)__(.+)$/i;
const SHELLS: ReadonlySet<string> = new Set(["bash", "shell", "sh"]);
/** A lookup names these servers by name. */
const SERVERS: Readonly<Record<string, string>> = { safe: "SaFE" };

type Kind = "read" | "edit" | "shell" | "search" | "web" | "task";

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

function plainLabel(kind: Kind, lang: Lang): Label {
  const t = stepText.in(lang);
  switch (kind) {
    case "read":
      return new Label(t.read, lang === "en" ? t.reads : undefined);
    case "edit":
      return new Label(t.edit, lang === "en" ? t.edits : undefined);
    case "shell":
      return new Label(t.shell, lang === "en" ? t.shells : undefined);
    case "task":
      return new Label(t.task, lang === "en" ? t.tasks : undefined);
    case "search":
      return new Label(t.search);
    case "web":
      return new Label(t.web);
  }
}

function words(name: string): string {
  const spaced = pyStrip(name.replace(CAMEL, " ").replace(SEPARATORS, " ")).toLowerCase();
  return pyStrip(cpSlice(spaced.replace(UNSAFE, ""), 0, NAME_MAX));
}

/** The skill directory a shell command works in (`python3 /workspace/.skills/<name>/scripts/x.py`), else undefined. */
export function skillInCommand(command: unknown): string | undefined {
  return typeof command === "string" ? SKILL_DIR.exec(command)?.[1] : undefined;
}

export function isShell(tool: string): boolean {
  return SHELLS.has(pyStrip(tool).toLowerCase());
}

/** (server, verb) of an `mcp__server__verb` name; ('', the name without a leading `mcp__`) for anything else. */
function mcpParts(raw: string): readonly [string, string] {
  const match = MCP.exec(raw);
  return match ? [match[1] ?? "", match[2] ?? ""] : ["", raw.replace(/^mcp__/i, "")];
}

/** A label from an MCP name's server and verb: the board's reads and lists, a deployment's queries, SaFE. */
function serverLabel(server: string, verb: string, lang: Lang, integrations: Integrations): Label | undefined {
  const t = stepText.in(lang);
  const s = server.toLowerCase();
  const v = verb.toLowerCase();
  if (s === "agent-board" && v === "issue_read")
    return new Label(t.boardRead, lang === "en" ? t.boardReads : undefined);
  if (s === "agent-board" && v.startsWith("list_")) {
    return new Label(t.boardList({ what: t.boardListWhat({ verb: words(verb.slice("list_".length)) || "items" }) }));
  }
  const shown = integrations.mcpServers.get(s);
  if (shown !== undefined && integrations.queryServers.has(s) && (v.startsWith("get_") || v.startsWith("list_"))) {
    return new Label(t.query({ server: shown }));
  }
  return s === "safe" ? new Label(t.safe) : undefined;
}

/**
 * The label of the step `tool` is: `skill` (a shell step that runs a skill's script) first, then the plain tools, then the
 * MCP servers Claw ships and those a deployment registers, then the generic fallback. The same tool always gets the same
 * label.
 */
export function labelFor(
  tool: string,
  skill?: string,
  lang = "en",
  integrations: Integrations = noIntegrations,
): Label {
  const key: Lang = lang === "zh" ? "zh" : "en";
  const t = stepText.in(key);
  const raw = squashSpaces(tool);
  if (skill) return new Label(t.skill({ skill }));
  const kind = own(PLAIN, raw.toLowerCase());
  if (kind) return plainLabel(kind, key);
  const [server, verb] = mcpParts(raw);
  const known = serverLabel(server, verb, key, integrations);
  if (known) return known;
  return new Label(t.generic({ what: [words(server), words(verb)].filter((w) => w).join(" ") || "a step" }));
}

/**
 * The step an assistant's turn is on, for its receipt. A SaFE lookup is named by what it reads ("查询 SaFE 节点"), one of
 * another known server by the server, and the assistant's own tools by what they do; anything else is `labelFor`'s.
 */
export function lookupLabel(tool: string, lang = "en", integrations: Integrations = noIntegrations): string {
  const zh = lang === "zh";
  const match = MCP.exec(squashSpaces(tool));
  const server = (match?.[1] ?? "").toLowerCase();
  const verb = (match?.[2] ?? "").toLowerCase();
  return lookupOf(server, verb, zh, integrations) ?? labelFor(tool, undefined, lang, integrations).one;
}

/** A lookup's own words: the assistant's tools, what a SaFE read reads, a known server's name; undefined for none. */
function lookupOf(server: string, verb: string, zh: boolean, integrations: Integrations): string | undefined {
  const t = stepText.in(zh ? "zh" : "en");
  const mine = server === "assistant" ? own(ASSISTANT_STEPS, verb) : undefined;
  if (mine) return mine[zh ? 1 : 0];
  const objects = server === "safe" ? own(SAFE_OBJECTS, verb.split("_", 1)[0] ?? "") : undefined;
  if (objects) return t.safeQuery({ what: objects[zh ? 1 : 0] });
  const shown = own(SERVERS, server) ?? integrations.mcpServers.get(server);
  return shown ? t.query({ server: shown }) : undefined;
}

/** `table`'s own entry for `key` (a tool name is Claw's to choose: what every object inherits is no entry). */
function own<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function failedLine(label: Label, lang = "en"): string {
  return stepText.in(lang === "zh" ? "zh" : "en").failed({ label: label.one });
}
