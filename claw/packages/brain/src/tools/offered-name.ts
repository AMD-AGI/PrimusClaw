// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A call the model made by a tool's short name: `say` for the `mcp__assistant__say` it was offered.
 *
 * An MCP tool reaches the model as `mcp__<server>__<tool>`, beside Brain's own tools, which have plain names (`web_search`,
 * `web_fetch`). An assistant router turn that looks something up offers both kinds at once, and the model now and then calls
 * the server's tool by its short name, as it calls the web tools. That call names no tool, so it was refused, and on a router
 * turn the refused tool is `say`, the only way to reach the user: the answer went out as the turn's plain text, without the
 * sources `say` carries, telling the user that its message tool was not available.
 *
 * The short name is read as the one offered tool it can only mean: the call is renamed before anything looks at it (the tool
 * allowlist, hooks, approval, the router, the history the next request replays), so every check sees the full name, as if the
 * model had written it. Nothing is ever offered by this: a name that is offered itself, has a server part, or could mean two
 * offered tools is left as it is, and refused as before when it is no tool.
 */

/** What separates an MCP tool's server from its name. */
const MCP_PREFIX = "mcp__";

/**
 * The offered tool a call of `name` means: `mcp__<server>__<name>` when exactly one offered tool is named so and `name` itself is
 * neither offered nor an MCP name. Null otherwise (the call keeps its name).
 */
export function offeredToolName(name: unknown, offered: Iterable<string>): string | null {
  if (typeof name !== "string" || name === "" || name.startsWith(MCP_PREFIX) || name.includes("__")) return null;
  const suffix = `__${name}`;
  let found: string | null = null;
  for (const full of offered) {
    if (full === name) return null;
    if (!full.startsWith(MCP_PREFIX) || !full.endsWith(suffix)) continue;
    // `mcp__<server>__<name>` with a server part of its own: `mcp____say` names no server.
    const server = full.slice(MCP_PREFIX.length, full.length - suffix.length);
    if (!server || server.includes("__")) continue;
    if (found !== null && found !== full) return null;
    found = full;
  }
  return found;
}
