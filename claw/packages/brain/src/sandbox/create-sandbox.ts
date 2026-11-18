// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The one place a sandbox workload is labelled and handed to the provider.
 *
 * Hands sandboxes (ensure-hands.ts) and app sandboxes (apps/app-sandbox.ts)
 * differ in everything around creation -- admission, registration, bootstrap,
 * who reaps them -- and in nothing about creation itself. Keeping the labels
 * and the provider call here means the two cannot drift on the parts Pulse and
 * the sweepers read.
 */
import { parseSandboxPlacement, type ExecuteRequest } from "@claw/protocol";
import type { SandboxCreateParams, SandboxInstance } from "./provider.js";
import { getSafeWorkloadProvider } from "./factory.js";
import { SandboxProvisionTerminalError } from "./errors.js";

/** Idle TTL (ttlSecondsAfterFinished) create falls back to when the spec names none. */
export const DEFAULT_SANDBOX_TTL_SEC = 10;

/** The label Pulse attributes a workload to a session by. */
export const SESSION_ID_LABEL = "primus-claw/session-id";
/** Which kind of sandbox this is: `hands` or `app`. */
export const COMPONENT_LABEL = "primus-claw/component";

/**
 * The labels every sandbox carries: session, component, the team label, plus
 * whatever the caller adds. `own` lands before `team` and `extra`, which is the
 * order the hands path has always applied them in; `extra` (the spec's own
 * labels, which a DAG author writes) wins over `own` and `team`.
 *
 * The session and component labels always win, `extra` included: the sandbox
 * NetworkPolicies select the Hands pods by `primus-claw/component=hands`
 * (chart networkPolicy.sandboxEgress / sandboxIngress), and containment selects
 * them by component and session. A spec that could set them would take its
 * sandbox out of its own egress and ingress policies.
 */
export function composeSandboxLabels(args: {
  sessionId: string;
  component: string;
  own?: Record<string, string>;
  extra?: Record<string, string>;
}): Record<string, string> {
  return {
    ...(args.own ?? {}),
    team: "primus-claw",
    ...(args.extra ?? {}),
    [SESSION_ID_LABEL]: args.sessionId,
    [COMPONENT_LABEL]: args.component,
  };
}

/** Create a SaFE workload sandbox through the shared provider. */
export function createSafeWorkloadSandbox(params: SandboxCreateParams): Promise<SandboxInstance> {
  return getSafeWorkloadProvider().create(params);
}

/** Failure reason of a sandbox whose request carries a placement that does not pass the check. */
export const SANDBOX_PLACEMENT_INVALID = "sandbox_placement_invalid";

/**
 * The node labels every sandbox of this request must require (the session's
 * `placement.nodeLabels`), or undefined when it names none.
 *
 * Checked again here although the API checked it at create: Brain does not know
 * the value came through that door. A placement that does not pass is refused
 * rather than dropped, because a sandbox created without it would run on nodes the
 * session excluded; the run fails with a reason instead.
 */
export function placementNodeLabels(request: Pick<ExecuteRequest, "placement">): Record<string, string> | undefined {
  const parsed = parseSandboxPlacement(request.placement);
  if (!parsed.ok) {
    throw new SandboxProvisionTerminalError(SANDBOX_PLACEMENT_INVALID, `sandbox not created: ${parsed.error}`);
  }
  return parsed.placement?.nodeLabels;
}
