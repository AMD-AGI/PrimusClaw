// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Resolve where a tool call should be dispatched (task-design.md §7.5).
 *
 * Brain holds the `plugin_tools` array from `ExecuteRequest` verbatim. Each
 * tool row carries `type` (mcp / skill / rule / hooks / prompt) plus an
 * optional `config.scope` of `hands` or `backend`. Default is `hands`; only
 * `type='mcp'` rows are allowed to declare `scope='backend'`.
 *
 * Helper functions in this file are pure data transforms so both the
 * agent-loop ToolRouter (mode=llm) and ScriptRunner (mode=script) can call
 * them without picking up additional dependencies.
 */

export type ToolScope = "hands" | "backend";

/**
 * Find the tool row in `plugin_tools` whose `name` matches `toolName` and
 * return its declared scope (defaulting to "hands").
 *
 * Tool names in `plugin_tools` are stored exactly as they appear in the
 * `tools` table. Brain's existing `mcp__<server>__<name>` rewriting does not
 * apply to backend-scope tools because they are addressed by their plain
 * `name` (the JSON-RPC `params.name` field).
 */
export function getPluginToolScope(
  toolName: string,
  pluginTools: unknown[] | null | undefined,
): ToolScope {
  if (!Array.isArray(pluginTools)) return "hands";
  for (const raw of pluginTools) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (String(row.name ?? "") !== toolName) continue;
    const cfg = row.config;
    if (cfg && typeof cfg === "object" && (cfg as Record<string, unknown>).scope === "backend") {
      return "backend";
    }
    return "hands";
  }
  return "hands";
}

/**
 * Return the subset of `plugin_tools` whose scope matches the given value.
 *
 * Used by:
 *  - agent-loop ToolRouter: filter `scope='backend'` tools into Brain-side
 *    callable list (mode=llm)
 *  - admission validation: enforce that script DAGs only reference
 *    `scope='backend'` tools when `sandbox === "none"`
 */
export function filterToolsByScope(
  pluginTools: unknown[] | null | undefined,
  scope: ToolScope,
): Array<Record<string, unknown>> {
  if (!Array.isArray(pluginTools)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const raw of pluginTools) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const cfg = row.config && typeof row.config === "object"
      ? (row.config as Record<string, unknown>)
      : {};
    const declared = cfg.scope === "backend" ? "backend" : "hands";
    if (declared === scope) out.push(row);
  }
  return out;
}
