// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Asking SaFE why a workload died, once, at the moment we notice it has.
 *
 * Separate from the parser next door so that stays pure and checkable against
 * captured payloads. This half is the network, and it is deliberately meagre:
 * one GET, a short timeout, and null for every way it can go wrong.
 *
 * The timing is the point. A pod's account of its own ending is not durable --
 * SaFE serves it from the pod, and a reclaimed node's pods are garbage-collected
 * within minutes -- so a reader that comes back later finds a workload that
 * failed for no stated reason. Reading it when the run ends is the only way the
 * answer exists at all, which is also why nothing here retries hard: a caller is
 * on a teardown path, and a lost reason is better than a delayed teardown.
 */
import pino from "pino";
import { SAFE_API_URL } from "../config.js";
import { platformFactsFromWorkloadDetail, type PlatformFacts } from "@claw/protocol";

const logger = pino({ name: "sandbox-platform-facts" });

/** One GET, capped: this runs while a run is being torn down. */
const FETCH_TIMEOUT_MS = 10_000;

export interface PlatformFactsReadDeps {
  fetch: typeof globalThis.fetch;
}

/**
 * What the platform says about `workloadId`'s ending, or null.
 *
 * Null covers every failure mode on purpose -- no key, an unreachable SaFE, a
 * 404 for a workload already collected, a body that parses to nothing. The
 * caller records facts when there are facts and records nothing otherwise;
 * "the platform said nothing" and "we could not ask" must both leave the row
 * untouched rather than stamp an empty reason over it.
 */
export async function fetchPlatformFacts(
  workloadId: string | undefined | null,
  apiKey: string | undefined | null,
  deps: PlatformFactsReadDeps = { fetch: globalThis.fetch },
): Promise<PlatformFacts | null> {
  if (!workloadId || !apiKey) return null;
  try {
    const resp = await deps.fetch(`${SAFE_API_URL}/api/v1/workloads/${workloadId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      logger.warn({ workloadId, status: resp.status }, "platform_facts.read_not_ok");
      return null;
    }
    const detail = (await resp.json()) as Record<string, unknown>;
    const facts = platformFactsFromWorkloadDetail(detail);
    logger.info(
      { workloadId, found: Boolean(facts), node: facts?.node, reason: facts?.containerReason },
      "platform_facts.read",
    );
    return facts;
  } catch (err) {
    logger.warn({ err, workloadId }, "platform_facts.read_failed");
    return null;
  }
}
