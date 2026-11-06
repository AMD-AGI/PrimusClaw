// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The fixed profile of a review one person asked another to make (`requested-by.ts`): an allow-list, not a list of what is taken away.
 *
 * The session acts with X's GitHub account and X's model quota, and its model reads what strangers wrote in a pull request. What X has
 * gathered for their own work (skills, memory, triggers, stored variables, default and application MCP servers, a2a peers, a file handed
 * to them) is therefore none of its business: a prompt injection in the pull request would otherwise use it as X. So the turn gets the
 * review tools and the sandbox's file and shell tools, and nothing else exists for it, whatever the request or the session carried. The
 * profile is applied where every turn of a session is finished (`applySandboxKeyPolicyToTask`: the immediate turn, the queued one and the
 * claimed one) and where a task of the session is built (`tasks/dispatcher.ts`); Brain applies the same list again (`sandbox_profile`).
 *
 * Limits of the review agent are X's: how many reviews others may have open with X at once, and how many model turns they may spend. They
 * are X's personal review-agent settings; until a person can set their own, every person has the deployment's defaults below, which are
 * deliberately large (a guard against a loop or a flood, not a quota a person is meant to meet).
 */
import { envInt, isKubernetesMode, SANDBOX_CPU_NAMESPACE } from "../config.js";
import { db, type StatementRunner } from "../infra/db.js";

/** The review tools' server; `session-tools.ts` names it for the turn under the same name. */
export const GITHUB_REVIEW_SERVER_NAME = "github_review";

export const REVIEW_PROFILE_SANDBOX_TOOLS: readonly string[] = ["read", "glob", "grep", "ls", "bash", "bash_output", "wait", "kill_shell", "task", "todo_write"];
export const REVIEW_PROFILE_GITHUB_TOOLS = `mcp__${GITHUB_REVIEW_SERVER_NAME}__*`;

/** What a review asked of another person may use: the review tools, and the sandbox's tools only where there is a sandbox for it. */
export function reviewProfileTools(sandbox: boolean = reviewSandboxAvailable()): string[] {
  return sandbox ? [REVIEW_PROFILE_GITHUB_TOOLS, ...REVIEW_PROFILE_SANDBOX_TOOLS] : [REVIEW_PROFILE_GITHUB_TOOLS];
}

/**
 * Whether a requested review may have a sandbox: on SaFE only in the deployment's existing CPU sandbox workspace (SANDBOX_CPU_NAMESPACE),
 * where Brain builds it without the owner's storage. A deployment that names none reviews from the diff alone rather than in a
 * workspace that would mount the owner's directory. Kubernetes mode has no per-user storage: its sandbox namespace serves.
 */
export function reviewSandboxAvailable(): boolean {
  return isKubernetesMode() || SANDBOX_CPU_NAMESPACE.trim() !== "";
}

/** Fields of a task that carry the owner's own choices or belongings, none of which a requested review gets. */
const OWNER_FIELDS = ["skills", "tool_ids", "plugin_id", "plugin_tools", "user_env", "workspace_id", "topology", "agent_hooks", "rules_text"] as const;

/**
 * A turn of a requested review that has no turn left: it is not sent. Brain reads `max_turns` 0 (or none) as no limit at all, so a review
 * whose budget is used up must never reach it with the budget it has left.
 */
export class ReviewTurnBudgetUsedError extends Error {
  readonly code = "review_turn_budget_used";
  constructor(readonly left: number) {
    super(`review_turn_budget_used: a requested review has ${left} model turns left and is not run`);
    this.name = "ReviewTurnBudgetUsedError";
  }
}

/**
 * Put the profile on a turn or a task: the allow-list (Brain enforces it), only the review tools' server, no owner belongings, no memory
 * and no skill evolution, the review sandbox, and the turns it may still take (`reviewTurnsLeft`). A budget below 1 throws
 * `ReviewTurnBudgetUsedError` and leaves the task as it was: `max_turns` 0 is no limit to Brain, so nothing under the profile is sent with
 * it. Every path that sends a turn refuses such a turn before it gets here (`assistant/review-items.ts` `refuseReviewTurnOverBudget`: the
 * immediate turn, `sessions/dispatch.ts`; and the queued one, `gateRequestedReviewTurn`); the throw is what stops one that got past them
 * (a claim, a task of the session, a turn that ran out meanwhile). Brain refuses a marked request without a positive budget as well.
 */
export function applyReviewProfile(task: Record<string, unknown>, maxTurns: number): void {
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new ReviewTurnBudgetUsedError(maxTurns);
  const servers = task.mcp_servers as Record<string, Record<string, unknown>> | undefined;
  const review = servers?.[GITHUB_REVIEW_SERVER_NAME];
  task.mcp_servers = review ? { [GITHUB_REVIEW_SERVER_NAME]: review } : {};
  task.tools_allowlist = reviewProfileTools();
  for (const field of OWNER_FIELDS) delete task[field];
  task.memory_enabled = false;
  task.skill_evolution_enabled = false;
  task.sandbox_profile = "review";
  task.max_turns = maxTurns;
}

// ------------------------------------------------------------------------------------------------ the owner's review-agent settings

export interface ReviewAgentSettings {
  /** Reviews others may have open with this person at once. */
  othersMaxActive: number;
  /** Of those, reviews one requester may have open with this person. */
  perRequesterMaxActive: number;
  /** Model turns one requested review may take. */
  turnsPerItem: number;
  /** Model turns all reviews others asked of this person may take in a UTC day. */
  turnsPerDay: number;
}

/** This person's review-agent settings: the deployment's defaults, until a person can set their own (a person may only tighten them). */
export function reviewAgentSettings(_userId: string): ReviewAgentSettings {
  return {
    othersMaxActive: envInt("CLAW_REVIEW_FOR_OTHERS_MAX_ACTIVE", 20, { min: 1 }),
    perRequesterMaxActive: envInt("CLAW_REVIEW_FOR_OTHERS_PER_REQUESTER_MAX_ACTIVE", 10, { min: 1 }),
    turnsPerItem: envInt("CLAW_REVIEW_FOR_OTHERS_TURNS_PER_ITEM", 200, { min: 1 }),
    turnsPerDay: envInt("CLAW_REVIEW_FOR_OTHERS_TURNS_PER_DAY", 2000, { min: 1 }),
  };
}

/**
 * The model turns this requested review may still take: the item's own budget less what its session's runs took, and the owner's daily
 * budget (UTC) less what every review others asked of them took today, the lower of the two. Counted from the runs' completion records
 * (`exec_complete.turns`), so a run still going counts when it ends; each run is capped at what was left when it started. A run's turns
 * there are its sub-agents' too: under the profile Brain takes every turn of the run and of its sub-agents from one pool of `max_turns`
 * and reports what the pool gave (`agent-loop.ts` `TurnPool`).
 */
export async function reviewTurnsLeft(sessionId: string, ownerUserId: string, q: StatementRunner = db): Promise<{ left: number; scope: "item" | "day" }> {
  const s = reviewAgentSettings(ownerUserId);
  const row = (await q.query(
    `SELECT
       (SELECT COALESCE(SUM(COALESCE((e.data->>'turns')::int, 0)), 0)::int FROM claw_session_events e
         WHERE e.session_id = $1 AND e.event = 'exec_complete') AS item,
       (SELECT COALESCE(SUM(COALESCE((e.data->>'turns')::int, 0)), 0)::int FROM claw_session_events e
          JOIN claw_sessions s ON s.session_id = e.session_id
         WHERE s.user_id = $2 AND s.config ? 'requested_by' AND e.event = 'exec_complete'
           AND e.created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS day`,
    [sessionId, ownerUserId],
  )).rows[0] as { item: number; day: number };
  const item = s.turnsPerItem - Number(row.item);
  const day = s.turnsPerDay - Number(row.day);
  return item <= day ? { left: Math.max(0, item), scope: "item" } : { left: Math.max(0, day), scope: "day" };
}
