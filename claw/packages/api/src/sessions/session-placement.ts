// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where a session's sandboxes may run, as a turn reads it.
 *
 * `claw_sessions.config.placement` is checked when the session is created (see
 * routes/sessions.ts and `parseSandboxPlacement` in @claw/protocol) and handed
 * to Brain on every execute request of the session -- a chat turn, a queued
 * message, a task, a DAG node or an application run -- because the sandbox a
 * request opens may be a rebuild, and a rebuild must land where the first one
 * was allowed to.
 */
import { parseSandboxPlacement, type SandboxPlacement } from "@claw/protocol";
import pino from "pino";

const logger = pino({ name: "session-placement" });

/**
 * The value of `config.placement` from a `claw_sessions` row, ready for the request.
 *
 * Undefined when the session has none: an absent field keeps the request, a run's
 * persisted spec and the workload SaFE is sent byte-identical to what they were
 * before the field existed.
 *
 * A stored value that does not pass the check is passed on as stored, not dropped:
 * dropping it would put the sandbox on nodes the session excluded, which is the one
 * outcome a placement exists to prevent. Brain checks it again and refuses to create
 * the sandbox, so the run fails with a reason instead of running in the wrong place.
 */
export function sessionPlacementFromRow(
  row: { placement?: unknown } | null | undefined,
  sessionId?: string,
): SandboxPlacement | undefined {
  const raw = row?.placement;
  const parsed = parseSandboxPlacement(raw);
  if (parsed.ok) return parsed.placement ?? undefined;
  logger.error({ sessionId, reason: parsed.error }, "session.placement_invalid_sent_for_refusal");
  return raw as SandboxPlacement;
}
