// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * agents.toml: which agents this machine offers to Claw, and the limits the
 * machine puts on them. The policy is enforced here, on the user's machine;
 * nothing Claw sends can widen it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { isObject } from "./util.js";
import { realRoot } from "./roots.js";

export interface AutoAllowRule {
  kind: string;
  /** Glob relative to the session's working directory: `*` within a segment, `**` across segments. */
  pathGlob: string;
}

export interface AgentConfig {
  id: string;
  /** An opaque label the chat client picks an icon from. */
  kind: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Directories a session's working directory must be inside. Never empty. */
  roots: string[];
  /** The mode every session is forced into, and read back, before its first prompt. */
  askMode: string;
  /** Modes a user may select from the phone. Anything else needs `allow_unsafe_modes`. */
  safeModes: string[];
  autoAllow: AutoAllowRule[];
}

export interface ConnectorConfig {
  server: string | null;
  identityUrl: string | null;
  name: string;
  allowUnsafeModes: boolean;
  /** Text filters: an agent message chunk matching one is not uploaded (known adapter warnings). */
  dropMessagePatterns: RegExp[];
  agents: AgentConfig[];
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`agents.toml: ${problems.join("; ")}`);
  }
}

interface Preset {
  kind: string;
  name: string;
  command: string;
  args: string[];
  askMode: string;
  safeModes: string[];
}

/**
 * Tested adapter versions are pinned; override `command`/`args` to move.
 * Safe modes are the ones in which every write and every command is asked
 * about (or nothing can be written at all). `acceptEdits`, `auto`,
 * `bypassPermissions` and the Codex write modes are not, so a phone cannot
 * select them unless the machine's owner allows it. Measured on Cursor's
 * `agent acp`: in its `agent` mode a shell command asks (allow-once /
 * allow-always / reject-once) but a file edit is applied without asking, in
 * every approval setting; its `ask` and `plan` modes cannot write. So the Cursor
 * preset starts read-only, and `agent` needs `allow_unsafe_modes` plus
 * `ask_mode = "agent"` from the owner.
 */
export const PRESETS: Record<string, Preset> = {
  claude: {
    kind: "claude", name: "Claude Code", command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.99.0"], askMode: "default", safeModes: ["default", "plan"],
  },
  codex: {
    kind: "codex", name: "Codex", command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@2.3.0"], askMode: "read-only", safeModes: ["read-only"],
  },
  cursor: {
    kind: "cursor", name: "Cursor", command: "agent", args: ["acp"], askMode: "ask", safeModes: ["ask", "plan"],
  },
};

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const KIND_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** Flags that turn a tool's own approval prompts off. They would defeat the ask mode below it. */
const BYPASS_ARG_RE = /^--?(?:force|yolo|dangerously[\w-]*|trust|auto-?approve[\w-]*|approve-mcps|full-auto|bypass[\w-]*)$/i;

const strList = (v: unknown, what: string, problems: string[]): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    problems.push(`${what} must be a list of strings`);
    return [];
  }
  return v as string[];
};

const expandHome = (p: string): string => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

export function parseConfig(text: string, defaults: { hostname?: string } = {}): ConnectorConfig {
  const problems: string[] = [];
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError([`not valid TOML (${(e as Error).message.split("\n")[0]})`]);
  }
  const allowUnsafeModes = doc.allow_unsafe_modes === true;
  if (doc.allow_unsafe_modes !== undefined && typeof doc.allow_unsafe_modes !== "boolean") problems.push("allow_unsafe_modes must be true or false");
  const server = typeof doc.server === "string" && doc.server.trim() ? doc.server.trim().replace(/\/+$/, "") : null;
  const identityUrl = typeof doc.identity_url === "string" && doc.identity_url.trim() ? doc.identity_url.trim().replace(/\/+$/, "") : null;
  const name = typeof doc.name === "string" && doc.name.trim() ? doc.name.trim().slice(0, 64) : (defaults.hostname ?? os.hostname()).slice(0, 64);
  const dropMessagePatterns: RegExp[] = [];
  for (const p of strList(doc.drop_message_patterns, "drop_message_patterns", problems)) {
    try { dropMessagePatterns.push(new RegExp(p)); } catch { problems.push(`drop_message_patterns: invalid regular expression ${JSON.stringify(p)}`); }
  }

  const globalAllow = parseAutoAllow(doc.auto_allow, "auto_allow", problems);
  const agents: AgentConfig[] = [];
  const seen = new Set<string>();
  const rawAgents = doc.agents === undefined ? [] : doc.agents;
  if (!Array.isArray(rawAgents)) problems.push("agents must be a list of [[agents]] tables");
  else rawAgents.forEach((raw, i) => {
    const at = `agents[${i}]`;
    if (!isObject(raw)) return void problems.push(`${at} must be a table`);
    const id = raw.id;
    if (typeof id !== "string" || !ID_RE.test(id)) return void problems.push(`${at}.id must be 1-64 characters of A-Z a-z 0-9 . _ -`);
    if (seen.has(id)) return void problems.push(`${at}.id ${id} is used twice`);
    seen.add(id);
    const label = `agent ${id}`;
    const presetName = typeof raw.preset === "string" ? raw.preset : null;
    const preset = presetName ? PRESETS[presetName] : undefined;
    if (presetName && !preset) return void problems.push(`${label}: unknown preset ${JSON.stringify(presetName)} (known: ${Object.keys(PRESETS).join(", ")})`);
    const command = typeof raw.command === "string" && raw.command ? raw.command : preset?.command;
    if (!command) return void problems.push(`${label}: needs a preset or a command`);
    const args = raw.args !== undefined ? strList(raw.args, `${label}.args`, problems) : (preset?.args ?? []);
    const kind = typeof raw.kind === "string" ? raw.kind : (preset?.kind ?? "custom");
    if (!KIND_RE.test(kind)) problems.push(`${label}: kind must be 1-64 characters of A-Z a-z 0-9 . _ : -`);
    const askMode = typeof raw.ask_mode === "string" && raw.ask_mode ? raw.ask_mode : preset?.askMode;
    if (!askMode) return void problems.push(`${label}: ask_mode is required for a custom agent`);
    const safeModes = [...(raw.safe_modes !== undefined ? strList(raw.safe_modes, `${label}.safe_modes`, problems) : (preset?.safeModes ?? [askMode]))];
    if (!safeModes.includes(askMode)) safeModes.push(askMode);
    const roots = strList(raw.roots, `${label}.roots`, problems).map((r) => path.resolve(expandHome(r)));
    if (roots.length === 0) problems.push(`${label}: roots is required (an agent with no allowed directory is never offered)`);
    for (const r of roots) {
      if (r === path.parse(r).root) problems.push(`${label}: a root may not be the filesystem root`);
      else if (!realRoot(r)) problems.push(`${label}: root ${r} does not exist`);
    }
    const env: Record<string, string> = {};
    if (raw.env !== undefined) {
      if (!isObject(raw.env)) problems.push(`${label}.env must be a table of strings`);
      else for (const [k, v] of Object.entries(raw.env)) {
        if (typeof v !== "string") problems.push(`${label}.env.${k} must be a string`);
        else env[k] = v;
      }
    }
    if (!allowUnsafeModes) {
      const bad = args.find((a) => BYPASS_ARG_RE.test(a));
      if (bad) problems.push(`${label}: ${bad} turns the tool's own approvals off; remove it or set allow_unsafe_modes = true`);
    }
    const own = parseAutoAllow(raw.auto_allow, `${label}.auto_allow`, problems);
    agents.push({
      id, kind, name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 128) : (preset?.name ?? id),
      command, args, env, roots, askMode, safeModes, autoAllow: [...globalAllow, ...own],
    });
  });

  if (problems.length) throw new ConfigError(problems);
  return { server, identityUrl, name, allowUnsafeModes, dropMessagePatterns, agents };
}

function parseAutoAllow(raw: unknown, at: string, problems: string[]): AutoAllowRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push(`${at} must be a list of { kind, path_glob }`);
    return [];
  }
  const rules: AutoAllowRule[] = [];
  raw.forEach((r, i) => {
    if (!isObject(r) || typeof r.kind !== "string" || typeof r.path_glob !== "string" || !r.kind || !r.path_glob) {
      return void problems.push(`${at}[${i}] needs a kind and a path_glob`);
    }
    if (path.isAbsolute(r.path_glob) || r.path_glob.split("/").includes("..")) {
      return void problems.push(`${at}[${i}].path_glob must be relative to the working directory and may not contain ..`);
    }
    rules.push({ kind: r.kind, pathGlob: r.path_glob });
  });
  return rules;
}

export function loadConfig(file: string, defaults: { hostname?: string } = {}): ConnectorConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigError([`${file} does not exist; run "claw-connector init" to create one`]);
    throw e;
  }
  return parseConfig(text, defaults);
}

export const SAMPLE_CONFIG = `# claw-connector: the agents this machine offers, and what they may touch.
# Policy lives here, on your machine; nothing Claw sends can widen it.

# server = "https://claw.example.com/claw-api"
# identity_url = "https://identity.example.com"
# name = "my-laptop"

# Modes in which the agent does not ask before it writes or runs something
# (bypassPermissions, acceptEdits, full access...) are refused unless you set this.
# allow_unsafe_modes = false

[[agents]]
id = "claude"
preset = "claude"
roots = ["~/work"]

# [[agents]]
# id = "codex"
# preset = "codex"
# roots = ["~/work"]

# [[agents]]
# id = "cursor"
# preset = "cursor"
# roots = ["~/work"]

# Let one kind of change through without asking, inside the session's directory.
# Every automatic approval is written to audit.jsonl and shown on the phone.
# auto_allow = [{ kind = "edit", path_glob = "docs/**" }]
`;
