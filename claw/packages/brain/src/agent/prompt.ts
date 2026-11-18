// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { A2A_CLIENT_ENABLED, RULES_DIR, SAFETY_PREAMBLE_ENABLED } from "../config.js";
import { LOAD_SKILL_TOOL } from "./skill-store.js";
import { PERSONAL_SKILLS_DIR } from "../workspace/excludes.js";

const SAFETY_PREAMBLE_FILE = path.join(RULES_DIR, "safety-preamble.txt");
const EXECUTION_POLICY_FILE = path.join(RULES_DIR, "execution-policy.txt");

function readFile(filePath: string): string {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8").trim();
  } catch { /* skip */ }
  return "";
}

let _preamble: string | null = null;
let _policy: string | null = null;

/** Safety preamble (skipped for Claude models — they have built-in safety). */
export function getSafetyPreamble(model = ""): string {
  if (!SAFETY_PREAMBLE_ENABLED) return "";
  if (model && model.toLowerCase().includes("claude")) return "";
  if (_preamble === null) _preamble = readFile(SAFETY_PREAMBLE_FILE);
  return _preamble;
}

function getExecutionPolicy(): string {
  if (_policy === null) _policy = readFile(EXECUTION_POLICY_FILE);
  return _policy;
}

/**
 * Build the final **user** turn payload with skill/MCP hints and execution policy.
 * Ported from V1 executor-ts/src/prompt.ts.
 *
 * ``pluginRulesFromMessage`` is rule bodies loaded from ``plugin_tools`` (S3);
 * kept in the user block (with ``userPrompt``) so they align with inlined skills
 * from the same message instead of a separate system slice.
 */
/** Per-skill inline SKILL.md cap — prevents token blowups for large skills. */
const SKILL_INLINE_MAX = 20_000;

/**
 * A skill listed by name and description only. `source: "user"` is one of the user's personal skills: listed in its
 * own section, with its own share of the list (see listProgressiveSkills); `user.shadows` says what of the same name it
 * replaces in this turn.
 */
export interface ProgressiveSkill {
  name: string;
  description: string;
  source?: string;
  user?: { imported?: boolean; shadows?: "platform" | "repository" };
}

const PROGRESSIVE_MAX_ENTRIES = 50;
const PROGRESSIVE_MAX_CHARS = 8000;
/** The share of the list kept for personal skills; what they leave is the others', and what the others leave is theirs. */
const PERSONAL_RESERVE_CHARS = 3000;
const PERSONAL_RESERVE_ENTRIES = 20;

/** The directory a listed skill is read from in the sandbox, for a run without `load_skill`. */
function sandboxSkillDir(s: ProgressiveSkill, skillBase: string): string {
  return s.source === "user" ? `${skillBase}/${PERSONAL_SKILLS_DIR}/${s.name}` : `${skillBase}/${s.name}`;
}

function listLine(s: ProgressiveSkill, skillBase: string, loadSkill: boolean): string {
  const label = s.source === "user" && s.user?.imported ? `${s.name} (imported)` : s.name;
  return loadSkill
    ? `\n  - ${label}: ${s.description}`
    : `\n  - ${label}: ${s.description}   [read ${sandboxSkillDir(s, skillBase)}/SKILL.md]`;
}

/**
 * The skills the on-demand list has room for, in order, and how many it leaves
 * out. The list stops at the first skill that does not fit, so `listed` is
 * always a prefix of `skills`. Exported so a caller that must not lose a skill
 * to the cap (the engine, for plugin skills) can ask which ones fit before it
 * decides what to inline instead.
 *
 * `loadSkill` is whether the run has the `load_skill` tool. Without it a skill
 * can only be opened by path, so each line carries the path to read and counts
 * against the cap; the engine asks with the same flag the prompt is built with,
 * so what it decides fits is what the prompt lists.
 *
 * Personal skills (`source: "user"`, most recently used first) are fitted separately: they have the first
 * PERSONAL_RESERVE_CHARS (and PERSONAL_RESERVE_ENTRIES) of the list to themselves, the other skills fit in what that
 * leaves, and personal skills that did not fit their share then take what the others left. So a user with many skills
 * cannot push the platform's out of the list, a platform with many cannot push the user's out, and neither share is
 * wasted. Each kind stays a prefix of its own order, and the others are fitted before the personal ones' second pass,
 * so which of the others fit does not depend on how many personal skills there are beyond their share. `listed`,
 * `omitted` and `lines` are the other skills'; `personal` is the personal ones'.
 */
export function listProgressiveSkills(
  skills: ProgressiveSkill[],
  sessionDir = "",
  loadSkill = true,
): {
  listed: ProgressiveSkill[]; omitted: number; lines: string;
  personal: { listed: ProgressiveSkill[]; omitted: number; lines: string };
} {
  const skillBase = sessionDir ? `${sessionDir}/.skills` : ".skills";
  const mine = skills.filter((s) => s.source === "user");
  const others = skills.filter((s) => s.source !== "user");
  let chars = 0;
  let entries = 0;
  const personal = { listed: [] as ProgressiveSkill[], lines: "" };
  let i = 0;
  const takePersonal = (maxChars: number, maxEntries: number) => {
    for (; i < mine.length; i++) {
      const line = listLine(mine[i], skillBase, loadSkill);
      if (personal.listed.length >= maxEntries || entries >= PROGRESSIVE_MAX_ENTRIES || personal.lines.length + line.length > maxChars || chars + line.length > PROGRESSIVE_MAX_CHARS) break;
      personal.lines += line;
      personal.listed.push(mine[i]);
      chars += line.length;
      entries++;
    }
  };
  takePersonal(PERSONAL_RESERVE_CHARS, PERSONAL_RESERVE_ENTRIES);
  let lines = "";
  const listed: ProgressiveSkill[] = [];
  for (const s of others) {
    const line = listLine(s, skillBase, loadSkill);
    if (entries >= PROGRESSIVE_MAX_ENTRIES || chars + line.length > PROGRESSIVE_MAX_CHARS) break;
    lines += line;
    listed.push(s);
    chars += line.length;
    entries++;
  }
  takePersonal(PROGRESSIVE_MAX_CHARS, PROGRESSIVE_MAX_ENTRIES);
  return {
    listed, omitted: others.length - listed.length, lines,
    personal: { listed: personal.listed, omitted: mine.length - personal.listed.length, lines: personal.lines },
  };
}

/**
 * The on-demand skill list: one line per skill, no body. The agent loads a
 * skill with the `load_skill` tool when a description matches; Brain serves it
 * from its own copy, so no sandbox is involved. The skill's files reach the
 * sandbox only when a command there first names `.skills`, which is where its
 * scripts run from. Descriptions are untrusted marketplace text and are only
 * concatenated here.
 *
 * A run whose `tools_allowlist` leaves `load_skill` out (every list written
 * before the tool existed) is not offered it, and a hint that sends the model
 * to it, and forbids the `read` it does have, leaves its skills unusable. For
 * such a run (`loadSkill` false) the hint is the one from before the tool: read
 * SKILL.md with `read`, from the path on each line.
 *
 * The user's personal skills come after the platform's, under their own heading, with what they replace and how
 * many the list had no room for; one left out is still loaded by name.
 */
export function buildProgressiveSkillHint(skills: ProgressiveSkill[], sessionDir = "", loadSkill = true): string {
  if (!skills.length) return "";
  const { listed, omitted, lines, personal } = listProgressiveSkills(skills, sessionDir, loadSkill);
  const skillBase = sessionDir ? `${sessionDir}/.skills` : ".skills";
  let hint = "";
  if (listed.length || omitted) {
    hint += `\n- Platform Skills (load on demand):${lines}`;
    if (omitted > 0) hint += `\n  - (${omitted} more skills not listed)`;
  }
  if (personal.listed.length || personal.omitted) {
    hint += `\n- Personal Skills (the user's own, saved by them; use one the same way when its description matches):${personal.lines}`;
    if (personal.omitted > 0) {
      hint += `\n  - (${personal.omitted} more of the user's personal skills not listed; when the user names one, `
        + (loadSkill ? `load it with ${LOAD_SKILL_TOOL} by that name)` : `read ${skillBase}/${PERSONAL_SKILLS_DIR}/<name>/SKILL.md)`);
    }
    for (const s of personal.listed) {
      if (s.user?.shadows) hint += `\n  - Note: personal skill '${s.name}' replaces the ${s.user.shadows} skill of the same name in this conversation.`;
    }
  }
  if (!loadSkill) {
    hint += `\nBefore starting a task, if a skill's description matches, read its SKILL.md with the read tool and follow it. `;
    hint += `Supporting files live next to SKILL.md in the same directory; read them only when SKILL.md points to them.`;
    return hint;
  }
  hint += `\nBefore starting a task, if a skill's description matches, load it with the ${LOAD_SKILL_TOOL} tool (name = the skill's name) and follow it. `;
  hint += `Loading a skill needs no sandbox: do not read or cat its files for that. Other files of a skill are listed at the end of its SKILL.md; `;
  hint += `load one with ${LOAD_SKILL_TOOL} (name and file) only when SKILL.md points to it. `;
  hint += `A long file comes in parts: when a result says it is not the whole file, call ${LOAD_SKILL_TOOL} again with the offset it gives, until the end. `;
  hint += personal.listed.length || personal.omitted
    ? `A skill's scripts run in the sandbox with bash, from ${skillBase}/<name>/ (a personal skill's from ${skillBase}/${PERSONAL_SKILLS_DIR}/<name>/).`
    : `A skill's scripts run in the sandbox with bash, from ${skillBase}/<name>/.`;
  return hint;
}

/**
 * The skill and MCP server hints of a turn: the inlined SKILL.md bodies, the on-demand skill list and the server names. Where they go is
 * the caller's (`buildPrompt` puts them after the user's message; with `SKILL_HINTS_IN_SYSTEM` the engine puts them in the system message).
 */
export function buildSkillAndMcpHints(
  skillContents: Record<string, string>,
  mcpServerNames: string[],
  sessionDir = "",
  progressiveSkills: ProgressiveSkill[] = [],
  loadSkill = true,
): { skillHint: string; mcpHint: string } {
  let skillHint = "";
  const skillNames = Object.keys(skillContents);
  if (skillNames.length) {
    const skillBase = sessionDir ? `${sessionDir}/.skills` : ".skills";
    skillHint = `\n- Available Skills: ${skillNames.join(", ")}.`;
    // Inline SKILL.md contents so the agent has the primary instructions even
    // if sandbox file writes fail. Supporting files (actions/**, etc.) still
    // live under ${skillBase}/{name}/ and can be read with bash/read.
    for (const name of skillNames) {
      const content = skillContents[name] || "";
      if (!content) continue;
      const truncated = content.length > SKILL_INLINE_MAX
        ? content.slice(0, SKILL_INLINE_MAX) + `\n\n…(truncated, read full file at ${skillBase}/${name}/SKILL.md)`
        : content;
      skillHint += `\n\n=== SKILL: ${name} (SKILL.md) ===\n${truncated}\n=== END SKILL: ${name} ===`;
    }
    skillHint += `\n\nSupporting files for each skill are at ${skillBase}/{name}/. `;
    skillHint += `Use bash/read to load them (e.g. \`cat ${skillBase}/{name}/actions/<step>.md\`). `;
    skillHint += `Follow the SKILL.md orchestrator above precisely.`;
  }

  if (progressiveSkills.length) skillHint += (skillHint ? "\n\n" : "") + buildProgressiveSkillHint(progressiveSkills, sessionDir, loadSkill).replace(/^\n/, "");

  let mcpHint = "";
  if (mcpServerNames.length) {
    mcpHint = `\n- Available MCP servers: ${mcpServerNames.join(", ")}. Use these tools when relevant.`;
  }
  return { skillHint, mcpHint };
}

/** The hints as one block for the system message (`SKILL_HINTS_IN_SYSTEM`); "" when there are none. */
export function renderSystemHints(hints: { skillHint: string; mcpHint: string }): string {
  const body = [hints.skillHint, hints.mcpHint].map((h) => h.replace(/^\n+/, "")).filter(Boolean).join("\n");
  return body ? `[Skills and tools]\n${body}` : "";
}

export function buildPrompt(
  userPrompt: string,
  skillContents: Record<string, string>,
  mcpServerNames: string[],
  model = "",
  sessionDir = "",
  pluginRulesFromMessage = "",
  sessionContext?: { sessionId: string; userId: string; parentSessionId?: string; teamRole?: string },
  progressiveSkills: ProgressiveSkill[] = [],
  /** The bound repository's block (see workspace/repo-binding.ts); "" for a session with none. */
  repoBlock = "",
  /** Whether the run has the `load_skill` tool (see buildProgressiveSkillHint); false when its `tools_allowlist` leaves it out. */
  loadSkill = true,
  /** The hints are in the system message (`SKILL_HINTS_IN_SYSTEM`): none of them here. */
  hintsInSystem = false,
): string {
  const { skillHint, mcpHint } = hintsInSystem
    ? { skillHint: "", mcpHint: "" }
    : buildSkillAndMcpHints(skillContents, mcpServerNames, sessionDir, progressiveSkills, loadSkill);

  // Skip preamble/policy injection for very long user inputs (saves tokens),
  // but ALWAYS append skill/mcp hints — losing them silently disabled the
  // entire skill system whenever the user pasted a long log/diff/code block.
  if (userPrompt.length > 20000) {
    const hints = [skillHint, mcpHint].filter(Boolean).join("\n");
    // The repository is not a hint to drop with the policy: without it the agent
    // would not know it is standing in one.
    const long = hints ? `${userPrompt}\n${hints}` : userPrompt;
    return repoBlock ? `${long}\n\n${repoBlock}` : long;
  }

  const rulesFromPlugin = (pluginRulesFromMessage || "").trim();
  const userBlock = [userPrompt, rulesFromPlugin].filter(Boolean).join("\n\n");

  const preamble = getSafetyPreamble(model);
  const rawPolicy = getExecutionPolicy();
  const policy = rawPolicy
    ? rawPolicy.replace("{skill_hint}", skillHint).replace("{mcp_hint}", mcpHint)
    : "";

  // If no execution-policy file, append skill/mcp hints directly
  const extraHints = !rawPolicy ? [skillHint, mcpHint].filter(Boolean).join("\n") : "";

  let sessionCtx = "";
  if (sessionContext?.sessionId) {
    const parts = [`- Session ID: ${sessionContext.sessionId}`];
    if (sessionContext.userId) parts.push(`- User ID: ${sessionContext.userId}`);
    if (sessionContext.parentSessionId) parts.push(`- Parent Session ID: ${sessionContext.parentSessionId} (you are a worker in an agent team)`);
    if (sessionContext.teamRole) parts.push(`- Team Role: ${sessionContext.teamRole}`);
    if (A2A_CLIENT_ENABLED) {
      parts.push(`- A2A Auth: the a2a_call tool handles authentication automatically. Do NOT use bash/curl for A2A calls — always use the a2a_call tool.`);
    }
    sessionCtx = `\n[Session Context]\n${parts.join("\n")}`;
  }

  return [preamble, userBlock, policy, extraHints, repoBlock, sessionCtx].filter(Boolean).join("\n\n");
}
