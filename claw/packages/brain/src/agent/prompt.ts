// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { RULES_DIR, SAFETY_PREAMBLE_ENABLED } from "../config.js";

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

export function buildPrompt(
  userPrompt: string,
  skillContents: Record<string, string>,
  mcpServerNames: string[],
  model = "",
  sessionDir = "",
  pluginRulesFromMessage = "",
  sessionContext?: { sessionId: string; userId: string; parentSessionId?: string; teamRole?: string },
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

  let mcpHint = "";
  if (mcpServerNames.length) {
    mcpHint = `\n- Available MCP servers: ${mcpServerNames.join(", ")}. Use these tools when relevant.`;
  }

  // Skip preamble/policy injection for very long user inputs (saves tokens),
  // but ALWAYS append skill/mcp hints — losing them silently disabled the
  // entire skill system whenever the user pasted a long log/diff/code block.
  if (userPrompt.length > 20000) {
    const hints = [skillHint, mcpHint].filter(Boolean).join("\n");
    return hints ? `${userPrompt}\n${hints}` : userPrompt;
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
    parts.push(`- A2A Auth: the a2a_call tool handles authentication automatically. Do NOT use bash/curl for A2A calls — always use the a2a_call tool.`);
    sessionCtx = `\n[Session Context]\n${parts.join("\n")}`;
  }

  return [preamble, userBlock, policy, extraHints, sessionCtx].filter(Boolean).join("\n\n");
}
