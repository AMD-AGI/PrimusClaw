// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review that one person (R) asked another (X) to make. The work is X's: the session, the item, the model quota and the board are X's
 * (`assistant/review-items.ts`), and R is only who asked. The session's stored config says so in two fields that only the server writes:
 *
 *   - `requested_by: {user_id, label}`: R, the authenticated caller of `POST /v1/assistant/reviews`. Replaces `acting_as_requester`, which
 *     older sessions still carry and which is still read for them.
 *   - `sandbox_profile: "review"`: the session runs with the fixed review profile (`review-profile.ts`), not with X's own tools, and its
 *     sandbox is the deployment's CPU sandbox workspace, built without X's storage (Brain).
 *
 * Neither can be set by a caller: `POST /v1/sessions` refuses both as server-managed, and nothing else writes a session's config.
 */
import { CLAW_ASSISTANT_ENABLED, CLAW_ASSISTANT_REVIEW_ITEMS, CLAW_GITHUB_REVIEW_ENABLED } from "../config.js";
import { actingUserOf, parseActingAs } from "./acting-as.js";

export const REVIEW_SANDBOX_PROFILE = "review";
const LABEL_MAX_CHARS = 100;

export interface RequestedBy {
  user_id: string;
  label: string;
}

/** The config keys only the server writes for a review asked of another person; a create that sends one is refused. */
export const REQUESTED_REVIEW_CONFIG_KEYS = ["requested_by", "sandbox_profile", "requester_note"] as const;

/** `config.requested_by` as the server wrote it, or null: unset, malformed, or naming the acting user (a review of one's own is not asked). */
export function requestedByOf(config: unknown): RequestedBy | null {
  const c = config !== null && typeof config === "object" ? config as Record<string, unknown> : null;
  const raw = c?.requested_by;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const parsed = parseActingAs(r.user_id);
  if (!parsed.ok || parsed.actingAs === null) return null;
  const actingAs = actingUserOf(config);
  if (actingAs === null || parsed.actingAs === actingAs) return null;
  const label = typeof r.label === "string" && r.label.trim() ? r.label.trim().slice(0, LABEL_MAX_CHARS) : parsed.actingAs;
  return { user_id: parsed.actingAs, label };
}

/**
 * Who asked for the work of this session, as the review tools name the requester: the owner, unless the owner is the acting user and the
 * server wrote who asked them (`requested_by`). One function for the two places that must agree, the token the tools are offered with
 * (`session-tools.ts`) and the check of that token on every call (`mcp.ts`). A session whose owner is not the acting user (an older one, or
 * one R made for themselves naming X) is never read as asked by anyone else: its requester is its owner, so it cannot pass for X's own.
 */
export function requesterOf(row: { user_id: string | null; config: unknown }): string | null {
  if (!row.user_id) return null;
  if (actingUserOf(row.config) !== row.user_id) return row.user_id;
  return requestedByOf(row.config)?.user_id ?? row.user_id;
}

/** The name a review's footer gives for who asked: `requested_by.label`, else the older `acting_as_requester`. */
export function requesterLabelOf(config: unknown): string | undefined {
  const c = config !== null && typeof config === "object" ? config as Record<string, unknown> : null;
  const by = requestedByOf(config);
  if (by) return by.label;
  return typeof c?.acting_as_requester === "string" && c.acting_as_requester ? c.acting_as_requester : undefined;
}

/**
 * Whether the session runs with the review profile. Read wide on purpose: a session that acts as a user and carries either field the server
 * writes for a requested review is held to the profile, so a malformed `requested_by` does not let it fall back to its owner's own tools.
 * Nothing while the review feature is off: such a session is then an ordinary one, as `withholdsSandboxKeys` reads it.
 */
export function usesReviewProfile(config: unknown): boolean {
  if (!CLAW_GITHUB_REVIEW_ENABLED || actingUserOf(config) === null) return false;
  const c = config as Record<string, unknown>;
  return c.sandbox_profile === REVIEW_SANDBOX_PROFILE || c.requested_by !== undefined;
}

/** Whether `POST /v1/assistant/reviews` exists on this deployment: the one way to ask a review of someone else when it does. */
export function reviewItemsAvailable(): boolean {
  return CLAW_ASSISTANT_ENABLED && CLAW_ASSISTANT_REVIEW_ITEMS && CLAW_GITHUB_REVIEW_ENABLED;
}
