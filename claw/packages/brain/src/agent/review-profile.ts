// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain's half of the review profile (`ExecuteRequest.sandbox_profile`, the API's `github-review/review-profile.ts`): a review one person
 * asked another to make runs as the reviewer, so its model reads a stranger's pull request with the reviewer's quota and GitHub account.
 *
 * The API already cuts the request down to the profile. Brain does it again from the mark alone and trusts no wider list the request
 * carries: the tools are the intersection of this fixed list and the request's own, the only MCP server kept is the review tools', and
 * every owner belonging (skills, plugins, stored variables, the owner's rules, memory, skill evolution, a multi-node topology, a workspace) is
 * dropped. It is applied where a request enters Brain (`tasks/dispatch.ts`, `tasks/runner.ts` `runHandleTask`), before anything decides
 * the run's sandbox, and again by the engine. The prompt is never read as configuration under the mark: what a requester wrote is in it
 * (`multi-node/prompt-flags.ts`, `resolveSandboxImageFromRequest`). The sandbox side is in `sandbox/ensure-hands.ts`
 * (`reviewSandboxNamespace`, `useWorkspaceStorage: false`). The run takes at most `max_turns` turns, its sub-agents' included (the engine's
 * `TurnPool`, whose count is the turns the run reports), and a request under the mark without a positive one is refused
 * (`reviewTurnBudgetRefusal`): 0 means no limit to the agent loop.
 */
import type { ExecuteRequest } from "@claw/protocol";
import { parseToolAllowlist, type ToolAllowlist } from "../tools/allowlist.js";

export const REVIEW_SERVER_NAME = "github_review";
/** The whole of what a requested review may use. */
export const REVIEW_PROFILE_TOOLS: readonly string[] = [
  `mcp__${REVIEW_SERVER_NAME}__*`, "read", "glob", "grep", "ls", "bash", "bash_output", "kill_shell", "task", "todo_write",
];

export function isReviewProfile(request: Pick<ExecuteRequest, "sandbox_profile">): boolean {
  return request.sandbox_profile === "review";
}

/** Strip a request marked with the review profile down to it, in place. Nothing for any other request. */
export function applyReviewProfileBackstop(request: ExecuteRequest): void {
  if (!isReviewProfile(request)) return;
  request.withhold_sandbox_keys = true;
  request.memory_enabled = false;
  request.skill_evolution_enabled = false;
  for (const field of ["skills", "tool_ids", "plugin_id", "plugin_tools", "user_env", "topology", "workspace_id", "rules_text"] as const) delete request[field];
  const review = request.mcp_servers?.[REVIEW_SERVER_NAME];
  request.mcp_servers = review ? { [REVIEW_SERVER_NAME]: review } : {};
}

/**
 * Why a request under the profile must not run, or null: it must carry a positive turn budget. The API sends what the review has left and
 * never less than 1; a 0 here would be read by the agent loop as no limit at all, on the reviewer's quota.
 */
export function reviewTurnBudgetRefusal(request: Pick<ExecuteRequest, "sandbox_profile" | "max_turns">): string | null {
  if (!isReviewProfile(request)) return null;
  const turns = request.max_turns;
  return typeof turns === "number" && Number.isSafeInteger(turns) && turns > 0
    ? null
    : `a requested review carries no turn budget (max_turns ${JSON.stringify(turns ?? null)}): refused rather than run without a limit`;
}

/** The run's allow-list under the profile: allowed only if the fixed list and the request's own (if it has one) both allow it. */
export function reviewProfileAllowlist(fromRequest: ToolAllowlist | null): ToolAllowlist {
  const fixed = parseToolAllowlist([...REVIEW_PROFILE_TOOLS])!;
  return {
    patterns: fixed.patterns,
    allows: (name: string) => fixed.allows(name) && (fromRequest === null || fromRequest.allows(name)),
  };
}
