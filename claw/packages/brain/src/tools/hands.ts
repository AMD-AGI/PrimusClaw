// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which tools the sandbox executes, and how long one call of them can be given.
 *
 * Both questions are asked from more than one place -- `tool-router` dispatches
 * on the first, `hands-client` builds a deadline and an error message from the
 * second -- and its own module because the two files would otherwise import each
 * other. Kept together because the second is only answerable for the first: a
 * tool Brain calls over some other transport has no sandbox limit to read.
 */

import { BASH_FOREGROUND_MAX_SEC, WAIT_MAX_SEC } from "../config.js";

/** Tools served by the Hands MCP server, i.e. run inside the sandbox. */
const HANDS_TOOLS = new Set([
  "bash", "read", "write", "edit", "glob", "grep", "ls",
  "notebook_edit", "multi_edit", "upload_to_s3", "download_from_s3",
  "log_s3_upload_manifest", "bash_output", "kill_shell", "wait",
]);

/**
 * Whether this tool call goes to the sandbox.
 *
 * The router also dispatches `mcp__*` tools, `a2a_call` and backend MCP tools,
 * which reach a different server over a different transport and are bounded by
 * that transport's own timeout. Nothing said here about sandbox deadlines,
 * sandbox files or surviving sandbox processes is true of them.
 */
export function isSandboxTool(name: string): boolean {
  return HANDS_TOOLS.has(name);
}

/**
 * Hard ceiling on any single MCP call, when the tool has no shorter limit.
 *
 * Exists so a half-dead sandbox -- TCP up, MCP server hung -- cannot hold a run
 * indefinitely. It is not a work budget, and a tool that states how long it
 * intends to take is granted that instead, up to its own limit below.
 */
const MCP_HARD_CAP_MS = 60 * 60 * 1000;

/** Slack for transport and teardown on top of a tool's declared timeout. */
export const MCP_DEADLINE_SLACK_MS = 60_000;

/**
 * The limits Hands puts on the tools that take a timeout, mirrored through
 * config so the two sides cannot disagree about them.
 *
 * A Map rather than an object literal because the name looked up here is not
 * always one of ours: a hook and a script step both name the tool they call and
 * reach HandsClient with it. An object answers `toString` from its prototype
 * with a function, which `?? Infinity` does not replace and `Math.min` turns
 * into NaN -- and a NaN deadline is a call the MCP SDK abandons on its first
 * tick, so a mistyped tool name would fail as an instant request timeout.
 */
const TOOL_MAX_SEC = new Map<string, number>([
  ["bash", BASH_FOREGROUND_MAX_SEC],
  ["wait", WAIT_MAX_SEC],
]);

/**
 * The largest timeout, in seconds, one call of a tool can actually make use of.
 *
 * Hands clamps a timeout it will not honour rather than refusing it, so a
 * deadline built from the argument as sent is one the tool can never reach: with
 * background shells on, a `bash {timeout: 3600}` returns after 120s and the RPC
 * would then wait out the remaining 58 minutes -- against a sandbox that has
 * either already answered or stopped answering, which is exactly the hang the
 * hard cap exists to prevent.
 *
 * Held under the hard cap for the other direction: with background shells off
 * the foreground ceiling is ten hours, longer than any single call may hold a
 * run open for. The slack is subtracted so the number is a timeout a caller can
 * pass and still be inside the cap, rather than one that would be clamped again.
 */
export function toolTimeoutCeilingSec(toolName: string): number {
  return Math.min(
    TOOL_MAX_SEC.get(toolName) ?? Infinity,
    (MCP_HARD_CAP_MS - MCP_DEADLINE_SLACK_MS) / 1000,
  );
}

/**
 * Whether a call of this tool can name its own timeout.
 *
 * Read from the same map as the ceiling rather than listed again: a second list
 * is how a message comes to explain a granted timeout to `read`, which has none
 * to grant and no argument to raise.
 */
export function toolTakesTimeout(toolName: string): boolean {
  return TOOL_MAX_SEC.has(toolName);
}
