// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the model's trigger tools do. `mcp.ts` is the wire; this is the behaviour.
 *
 * The user is always the owner of the session the bearer names, asked while the turn is still the live one
 * (`assertLiveRun`): no argument names a user, so a turn reads and changes its own owner's triggers and nobody
 * else's. A trigger made from a work item's worker belongs to that item: its firings wake the worker and its
 * results come back as the item's reports, so the user meets it as the item, not as a list of schedules.
 */
import { assertLiveRun, ToolRefused } from "../assistant/tools.js";
import { sessionRole } from "../assistant/role-profile.js";
import { readTrustedSessionCredentials } from "../auth/session-credentials.js";
import { sessionWithholdsSandboxKeys } from "../github-review/session-tools.js";
import { CLAW_ASSISTANT_ENABLED, CLAW_DEPLOY_MODE, TRIGGER_MIN_INTERVAL_MINUTES } from "../config.js";
import { db } from "../infra/db.js";
import { deleteTrigger, insertTrigger, listTriggers, parseTriggerInput, sealTriggerCredentials } from "./store.js";
import type { TriggerTokenClaims } from "./token.js";

export { ToolRefused };

const query = (text: string, params?: unknown[]) => db.query(text, params);

/** A bearer minted before the session was set to act as a user is still valid, so that is asked per call. */
async function turnOwner(claims: TriggerTokenClaims): Promise<string> {
  const { userId } = await assertLiveRun(query, claims);
  if (await sessionWithholdsSandboxKeys(claims.sid)) {
    throw new ToolRefused("not_allowed", "a conversation that acts as a user has no scheduled tasks");
  }
  return userId;
}

/** What the model is told about a trigger: never its sealed credential. */
function view(row: Record<string, unknown>): Record<string, unknown> {
  const { trigger_id, name, prompt, schedule, timezone, paused_reason, next_fire_at, last_fire_at, ends_at, max_runs, runs, item_id } = row;
  return {
    trigger_id, name, prompt, schedule, timezone, next_fire_at, last_fire_at,
    until: ends_at ?? null, max_runs: max_runs ?? null, runs, item_id: item_id ?? null,
    state: paused_reason ? `paused: ${String(paused_reason)}` : "active",
  };
}

export async function triggerCreate(claims: TriggerTokenClaims, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const userId = await turnOwner(claims);
  const parsed = parseTriggerInput(args);
  if (!parsed.ok) throw new ToolRefused("invalid_arguments", parsed.error);
  const session = (await db.query("SELECT config FROM claw_sessions WHERE session_id = $1", [claims.sid])).rows[0] as
    { config: unknown } | undefined;
  const creds = readTrustedSessionCredentials(session?.config);
  // The same rule a trigger made through the API is held to: on SaFE it runs on its owner's key or not at all.
  if (CLAW_DEPLOY_MODE !== "kubernetes" && !creds.platformKey) {
    throw new ToolRefused("no_credentials", "this conversation holds no key of its owner, so nothing can run on their behalf later");
  }
  const role = CLAW_ASSISTANT_ENABLED ? await sessionRole(claims.sid) : null;
  if (role?.role === "router") throw new ToolRefused("not_allowed", "the assistant schedules work through an item, not itself");
  const itemId = role?.role === "worker" ? role.itemId : null;
  const row = await insertTrigger(
    userId, parsed.input,
    sealTriggerCredentials({ platformKey: creds.platformKey, virtualKey: creds.llmApiKey, userName: userId }),
    itemId,
  );
  if (!row) throw new ToolRefused("trigger_limit_reached", "the user has as many scheduled tasks as allowed: cancel one first");
  return {
    ok: true, trigger: view(row),
    delivery: itemId
      ? "Each run wakes you on this item with the prompt; report its result as usual."
      : "Each run starts a new conversation as the user; its result reaches them through their notifications.",
  };
}

export async function triggerList(claims: TriggerTokenClaims): Promise<Record<string, unknown>> {
  const userId = await turnOwner(claims);
  return { ok: true, min_interval_minutes: TRIGGER_MIN_INTERVAL_MINUTES, triggers: (await listTriggers(userId)).map(view) };
}

export async function triggerCancel(claims: TriggerTokenClaims, args: { trigger_id: string }): Promise<Record<string, unknown>> {
  const userId = await turnOwner(claims);
  if (!await deleteTrigger(userId, args.trigger_id)) throw new ToolRefused("not_found", "the user has no scheduled task with that id");
  return { ok: true, trigger_id: args.trigger_id, outcome: "cancelled" };
}
