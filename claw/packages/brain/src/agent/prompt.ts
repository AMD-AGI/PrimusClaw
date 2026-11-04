// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { A2A_CLIENT_ENABLED, RULES_DIR, SAFETY_PREAMBLE_ENABLED } from "../config.js";
import { LOAD_SKILL_TOOL } from "./skill-store.js";

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

/** A platform-default skill listed by name and description only. */
export interface ProgressiveSkill { name: string; description: string }

const PROGRESSIVE_MAX_ENTRIES = 50;
const PROGRESSIVE_MAX_CHARS = 8000;

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
 */
export function listProgressiveSkills(
  skills: ProgressiveSkill[],
  sessionDir = "",
  loadSkill = true,
): { listed: ProgressiveSkill[]; omitted: number; lines: string } {
  const skillBase = sessionDir ? `${sessionDir}/.skills` : ".skills";
  let lines = "";
  const listed: ProgressiveSkill[] = [];
  for (const s of skills) {
    const line = loadSkill
      ? `\n  - ${s.name}: ${s.description}`
      : `\n  - ${s.name}: ${s.description}   [read ${skillBase}/${s.name}/SKILL.md]`;
    if (listed.length >= PROGRESSIVE_MAX_ENTRIES || lines.length + line.length > PROGRESSIVE_MAX_CHARS) break;
    lines += line;
    listed.push(s);
  }
  return { listed, omitted: skills.length - listed.length, lines };
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
 */
export function buildProgressiveSkillHint(skills: ProgressiveSkill[], sessionDir = "", loadSkill = true): string {
  if (!skills.length) return "";
  const { omitted, lines } = listProgressiveSkills(skills, sessionDir, loadSkill);
  const skillBase = sessionDir ? `${sessionDir}/.skills` : ".skills";
  let hint = `\n- Platform Skills (load on demand):${lines}`;
  if (omitted > 0) hint += `\n  - (${omitted} more skills not listed)`;
  if (!loadSkill) {
    hint += `\nBefore starting a task, if a skill's description matches, read its SKILL.md with the read tool and follow it. `;
    hint += `Supporting files live next to SKILL.md in the same directory; read them only when SKILL.md points to them.`;
    return hint;
  }
  hint += `\nBefore starting a task, if a skill's description matches, load it with the ${LOAD_SKILL_TOOL} tool (name = the skill's name) and follow it. `;
  hint += `Loading a skill needs no sandbox: do not read or cat its files for that. Other files of a skill are listed at the end of its SKILL.md; `;
  hint += `load one with ${LOAD_SKILL_TOOL} (name and file) only when SKILL.md points to it. `;
  hint += `A long file comes in parts: when a result says it is not the whole file, call ${LOAD_SKILL_TOOL} again with the offset it gives, until the end. `;
  hint += `A skill's scripts run in the sandbox with bash, from ${skillBase}/<name>/.`;
  return hint;
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
): string {
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
