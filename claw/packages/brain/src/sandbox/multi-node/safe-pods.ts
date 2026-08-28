// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Group a SaFE GetWorkloadResponse's pods by Infera service role.
 *
 * Ported from Hyperloom `multi_node/_internal/infera_support.discover_role_pods`.
 * Hyperloom's external mode wants GPU pod IPs per role
 * (`HYPERLOOM_MN_EXT_PREFILL_IPS` / `_DECODE_IPS` / `_WORKER_IPS`), and the
 * only place they surface is the workload detail's `pods` list.
 *
 * Kept import-free apart from the pure port math so it is directly testable.
 */

import { serviceRolesFor, sshPortForPod } from "./safe-body.js";

/** Substrings marking a pod as the LWS worker role rather than the frontend. */
const WORKER_PODID_HINTS = ["worker", "-lws-", "lws-"];

/** Pods in these phases keep a stale podIP but no live sshd. */
const DEAD_PHASES = new Set(["failed", "succeeded", "terminating"]);

export interface RolePodTarget {
  podId: string;
  podIp: string;
  role: string;
  /** LeaderWorkerSet ordinal (leader = 0), or null when unparseable. */
  lwsIndex: number | null;
  sshPort: number;
}

export interface RolePodGroups {
  frontend: RolePodTarget[];
  prefill: RolePodTarget[];
  decode: RolePodTarget[];
  worker: RolePodTarget[];
}

/** Slot index from an Infera pod name `<wid>-role<N>-<hash>`. */
function parseRoleIndex(podId: string): number | null {
  const m = /-role(\d+)-/.exec(podId);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/** LWS ordinal from a pod name; leader pods end without a worker suffix. */
function parseLwsOrdinal(podId: string): number | null {
  const m = /-(\d+)$/.exec(podId);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/**
 * Classify one pod. Explicit role substrings win; otherwise the slot index
 * from the pod name maps onto the positional serviceRoles. `resourceId` is only
 * a fallback because SaFE leaves it 0 for Infera pods, which would otherwise
 * map every pod onto role 0.
 */
function classifyPodRole(podId: string, resourceId: unknown, serviceRoles: string[]): string | null {
  const pl = podId.toLowerCase();
  if (pl.includes("prefill")) return "prefill";
  if (pl.includes("decode")) return "decode";
  if (pl.includes("frontend")) return "frontend";

  let idx = parseRoleIndex(podId);
  if (idx === null && typeof resourceId === "number") idx = resourceId;
  if (idx !== null && idx >= 0 && idx < serviceRoles.length) return serviceRoles[idx]!;

  if (WORKER_PODID_HINTS.some((h) => pl.includes(h))) return "worker";
  return null;
}

/**
 * Group a workload detail's pods by role, dropping pods without an IP and pods
 * in a terminal phase (a crashed role pod lingers in the list and SSHing to it
 * would fail the round). Each group is sorted by LWS ordinal for a
 * deterministic rank order.
 */
export function discoverRolePods(
  workload: Record<string, unknown>,
  pdMode: string,
  sshPortBase: number,
): RolePodGroups {
  const serviceRoles = serviceRolesFor(pdMode);
  const groups: RolePodGroups = { frontend: [], prefill: [], decode: [], worker: [] };

  const pods = Array.isArray(workload.pods) ? workload.pods : [];
  for (const raw of pods) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const podIp = String(p.podIP ?? "").trim();
    if (!podIp) continue;
    if (DEAD_PHASES.has(String(p.phase ?? "").trim().toLowerCase())) continue;

    const podId = String(p.podId ?? "");
    const role = classifyPodRole(podId, p.resourceId, serviceRoles);
    if (!role || !(role in groups)) continue;

    const lwsIndex = parseLwsOrdinal(podId);
    groups[role as keyof RolePodGroups].push({
      podId,
      podIp,
      role,
      lwsIndex,
      sshPort: sshPortForPod(role, lwsIndex, sshPortBase),
    });
  }

  for (const role of Object.keys(groups) as (keyof RolePodGroups)[]) {
    groups[role].sort((a, b) => {
      const ai = a.lwsIndex ?? Number.MAX_SAFE_INTEGER;
      const bi = b.lwsIndex ?? Number.MAX_SAFE_INTEGER;
      return ai !== bi ? ai - bi : a.podId.localeCompare(b.podId);
    });
  }
  return groups;
}

/**
 * IP of the Ray head pod in a workload detail. KubeRay names the head pod
 * `<rayClusterName>-head-<hash>`, which is the only marker available here.
 */
export function headPodIp(workload: Record<string, unknown>): string | undefined {
  const pods = Array.isArray(workload.pods) ? workload.pods : [];
  for (const raw of pods) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const podId = String(p.podId ?? "").toLowerCase();
    if (!podId.includes("-head")) continue;
    if (DEAD_PHASES.has(String(p.phase ?? "").trim().toLowerCase())) continue;
    const ip = String(p.podIP ?? "").trim();
    if (ip) return ip;
  }
  return undefined;
}

/**
 * RayCluster name behind a RayJob workload, read off its head pod.
 *
 * KubeRay names the head pod `<rayClusterName>-head-<hash>` and publishes the
 * control-plane ports (Dashboard 8265, GCS 6379) on `<rayClusterName>-head-svc`.
 * The cluster name carries a generated suffix, so it cannot be derived from the
 * workload id -- but the head pod name embeds it, and the workload detail
 * already lists that pod. Reading it here keeps the RayJob CR (and with it any
 * direct Kubernetes access) out of the picture.
 *
 * @param workload SaFE GetWorkloadResponse.
 * @returns The RayCluster name, or undefined when no live head pod is listed.
 */
export function rayClusterName(workload: Record<string, unknown>): string | undefined {
  const pods = Array.isArray(workload.pods) ? workload.pods : [];
  for (const raw of pods) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (DEAD_PHASES.has(String(p.phase ?? "").trim().toLowerCase())) continue;
    const podId = String(p.podId ?? "");
    const m = /^(.+)-head-[^-]+$/.exec(podId);
    if (m) return m[1];
  }
  return undefined;
}

/** True once every GPU role the topology needs has at least one live pod IP. */
export function gpuPodsReady(groups: RolePodGroups, pdMode: string): boolean {
  return pdMode.toLowerCase() === "disaggregated"
    ? groups.prefill.length > 0 && groups.decode.length > 0
    : groups.worker.length > 0;
}
