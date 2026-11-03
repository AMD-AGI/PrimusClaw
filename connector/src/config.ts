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
  /** Modes a user may select from the phone without the owner's opt-in: the owner's (or the preset's) list, plus the ask mode. */
  safeModes: string[];
  /**
   * Modes known to ask before every write and command: what the preset measured, or for a custom agent what the owner
   * declared. A session whose mode is not in this list is unattended, whoever listed the mode as selectable.
   */
  askingModes: string[];
  /**
   * Whether a phone may select a mode outside `safeModes` for this agent, and whether the machine accepts an
   * adapter's warning that it will not ask. The owner's opt-in: `approval = "never"` on the agent, else the
   * file-level `allow_unsafe_modes` (and `approval = "ask"` turns it off for this agent).
   */
  allowUnsafeModes: boolean;
  /** Sessions start in a mode outside `askingModes`: no per-step approval. Never true without `allowUnsafeModes`. */
  unattended: boolean;
  autoAllow: AutoAllowRule[];
  /**
   * Set for an agent that takes over sessions that already exist on this machine instead of starting new ones.
   * `cli` is the command that lists the processes holding a session open (see attach.ts).
   */
  attach: { cli: string } | null;
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
  /** What `approval = "never"` turns the preset into: the adapter's mode that never asks, and the flags that go with it. */
  unattended: { askMode: string; args?: string[] };
  attach?: boolean;
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
 * preset starts read-only, and `agent` needs the owner's `approval = "never"` for that agent.
 *
 * `unattended` is what `approval = "never"` selects: the mode in which the agent runs like it does in the owner's
 * terminal, without asking. Measured on the pinned adapters: claude-agent-acp offers `bypassPermissions`;
 * codex-acp 2.3.0 offers `read-only`, `workspace-write`, `agent` (asks only for actions it judges unsafe) and
 * `agent-full-access` (no limits); Cursor's `agent` mode applies edits without asking and asks for shell commands,
 * so its root flag `--force` goes with it (the flag is global: `agent --force acp`).
 */
export const PRESETS: Record<string, Preset> = {
  claude: {
    kind: "claude", name: "Claude Code", command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.99.0"], askMode: "default", safeModes: ["default", "plan"],
    unattended: { askMode: "bypassPermissions" },
  },
  // Existing Claude Code sessions, taken over from the phone. The kind is the opaque label a chat client picks an icon
  // from; it says what the entry is for, not which product serves it. Same adapter and same ask mode as `claude`.
  "claude-attach": {
    kind: "attach", name: "Claude Code (existing sessions)", command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.99.0"], askMode: "default", safeModes: ["default", "plan"], attach: true,
    unattended: { askMode: "bypassPermissions" },
  },
  codex: {
    kind: "codex", name: "Codex", command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@2.3.0"], askMode: "read-only", safeModes: ["read-only"],
    unattended: { askMode: "agent-full-access" },
  },
  cursor: {
    kind: "cursor", name: "Cursor", command: "agent", args: ["acp"], askMode: "ask", safeModes: ["ask", "plan"],
    unattended: { askMode: "agent", args: ["--force", "acp"] },
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
    if (raw.approval !== undefined && raw.approval !== "ask" && raw.approval !== "never") return void problems.push(`${label}: approval must be "ask" or "never"`);
    const approval = raw.approval === "ask" || raw.approval === "never" ? raw.approval : null;
    const never = approval === "never";
    // The owner's opt-in for this agent: its own `approval` setting wins over the file-level default.
    const allowUnsafe = approval === null ? allowUnsafeModes : never;
    const args = raw.args !== undefined ? strList(raw.args, `${label}.args`, problems) : [...((never ? preset?.unattended.args : undefined) ?? preset?.args ?? [])];
    const kind = typeof raw.kind === "string" ? raw.kind : (preset?.kind ?? "custom");
    if (!KIND_RE.test(kind)) problems.push(`${label}: kind must be 1-64 characters of A-Z a-z 0-9 . _ : -`);
    const explicitAsk = typeof raw.ask_mode === "string" && raw.ask_mode ? raw.ask_mode : null;
    const askMode = explicitAsk ?? (never ? preset?.unattended.askMode : preset?.askMode);
    if (!askMode) return void problems.push(never ? `${label}: approval = "never" needs ask_mode, the mode in which this agent does not ask, for a custom agent` : `${label}: ask_mode is required for a custom agent`);
    // `listed`: what a phone may select without the opt-in. `asking`: what is known to ask before every step: what the
    // preset measured, or for a custom agent the owner's own declaration. They differ only for a preset the owner edited.
    const listed = [...(raw.safe_modes !== undefined ? strList(raw.safe_modes, `${label}.safe_modes`, problems) : (preset?.safeModes ?? [askMode]))];
    const asking = new Set(preset ? preset.safeModes : (raw.safe_modes !== undefined ? listed : []));
    let safeModes = listed;
    if (preset && !allowUnsafe) {
      const extra = listed.filter((m) => !asking.has(m));
      if (extra.length) problems.push(`${label}: safe_modes lists ${extra.join(", ")}, which preset ${presetName} does not know to ask before every step; remove it, set approval = "never" (or allow_unsafe_modes = true), or define the agent without a preset`);
    }
    if (never) {
      // The mode every session starts in is the one that does not ask: it is neither asking nor a safe mode.
      if (explicitAsk && asking.has(explicitAsk)) problems.push(`${label}: approval = "never" but ask_mode ${explicitAsk} is a mode that asks before every step; remove ask_mode, or approval`);
      asking.delete(askMode);
      safeModes = safeModes.filter((m) => m !== askMode);
    } else if (!asking.has(askMode)) {
      // A preset knows which of its modes ask; one it does not list may not, and needs the owner's opt-in. A custom agent's ask mode asks by definition.
      if (preset && explicitAsk) { if (!allowUnsafe) problems.push(`${label}: ask_mode ${askMode} is not a mode that asks before every step; set approval = "never" (or allow_unsafe_modes = true) to use it`); }
      else asking.add(askMode);
    }
    if (asking.has(askMode) && !safeModes.includes(askMode)) safeModes.push(askMode);
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
    if (!allowUnsafe) {
      const bad = args.find((a) => BYPASS_ARG_RE.test(a));
      if (bad) problems.push(`${label}: ${bad} turns the tool's own approvals off; remove it or set approval = "never" (or allow_unsafe_modes = true)`);
    }
    const own = parseAutoAllow(raw.auto_allow, `${label}.auto_allow`, problems);
    let attach: AgentConfig["attach"] = null;
    if (preset?.attach) {
      const cli = raw.attach_cli === undefined ? "claude" : raw.attach_cli;
      if (typeof cli !== "string" || !cli.trim()) problems.push(`${label}.attach_cli must be a command name or path`);
      else attach = { cli: cli.trim() };
    } else if (raw.attach_cli !== undefined) {
      problems.push(`${label}: attach_cli only applies to an agent made from the claude-attach preset`);
    }
    agents.push({
      id, kind, name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 128) : (preset?.name ?? id),
      command, args, env, roots, askMode, safeModes, askingModes: [...asking], allowUnsafeModes: allowUnsafe, unattended: !asking.has(askMode),
      autoAllow: [...globalAllow, ...own], attach,
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

export type Approval = "ask" | "never";

/** The presets `init` can write, in the order they appear in the sample. */
export const SAMPLE_AGENTS = ["claude", "claude-attach", "codex", "cursor"] as const;

/** The ones the sample switches on. The others are written commented out, and an owner enables one by uncommenting it. */
export const SAMPLE_ACTIVE: readonly string[] = ["claude"];

/**
 * What the file `init` writes does with a requested `never`: `unattended` are agents that are on in it and run without
 * per-step approval; `parked` are agents that asked for it but whose block is commented out, so it has no effect until
 * the owner uncomments the block. The one place that says which agents are on, so the text and the message cannot differ.
 */
export function sampleApprovals(approval: Partial<Record<string, Approval>>): { unattended: string[]; parked: string[] } {
  const never = SAMPLE_AGENTS.filter((id) => approval[id] === "never");
  return { unattended: never.filter((id) => SAMPLE_ACTIVE.includes(id)), parked: never.filter((id) => !SAMPLE_ACTIVE.includes(id)) };
}

/** A line of explanation written above a sample block, for a preset whose purpose is not its name. */
const SAMPLE_NOTES: Record<string, string> = {
  "claude-attach": "# Take over a Claude Code conversation that already exists on this machine (exit it in the terminal first).",
};

const NEVER_NOTE = `# No per-step approval: this agent runs like it does in your terminal. A phone session writes files and runs
# commands without asking, and the phone shows it as unattended. To go back to asking, set it to "ask".`;

/**
 * The text `claw-connector init` writes. `approval` picks, per preset, whether the agent asks before every write
 * and command (the default) or never asks; a preset it does not name asks.
 */
export function sampleConfig(approval: Partial<Record<string, Approval>> = {}): string {
  const agent = (id: string): string => {
    const lines = [...(SAMPLE_NOTES[id] ? [SAMPLE_NOTES[id]!] : []), `[[agents]]`, `id = "${id}"`, `preset = "${id}"`, `roots = ["~/work"]`];
    if (approval[id] === "never") lines.push(...NEVER_NOTE.split("\n"), `approval = "never"`);
    return lines.map((l) => (SAMPLE_ACTIVE.includes(id) || l.startsWith("#") ? l : `# ${l}`)).join("\n");
  };
  return `# claw-connector: the agents this machine offers, and what they may touch.
# Policy lives here, on your machine; nothing Claw sends can widen it.

# server = "https://claw.example.com/claw-api"
# identity_url = "https://identity.example.com"
# name = "my-laptop"

# By default every agent asks before it writes a file or runs a command, and the phone answers each question.
# approval = "never" on an agent turns that off for it (a phone session runs like your terminal);
# approval = "ask" keeps it on. Modes in which an agent does not ask (bypassPermissions, acceptEdits, full access...)
# are refused for an agent without approval = "never" unless you set this for every agent at once:
# allow_unsafe_modes = false

${SAMPLE_AGENTS.map(agent).join("\n\n")}

# Let one kind of change through without asking, inside the session's directory.
# Every automatic approval is written to audit.jsonl and shown on the phone.
# auto_allow = [{ kind = "edit", path_glob = "docs/**" }]
`;
}

export const SAMPLE_CONFIG = sampleConfig();
