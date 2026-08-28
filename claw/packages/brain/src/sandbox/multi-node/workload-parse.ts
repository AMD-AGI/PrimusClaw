// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Pure parsing for SaFE `GET /api/v1/workloads` responses. Kept import-free so
// tests can exercise it without pulling in the HTTP stack.

export interface WorkloadRef {
  /** SaFE workload id, the handle every other endpoint takes. */
  id: string;
  /** `phase`, lowercased; "" when SaFE has not set one yet. */
  phase: string;
  /** `groupVersionKind.kind`, e.g. `RayJob`; "" when absent. */
  kind: string;
}

/** One page of a SaFE workload list. */
export interface WorkloadListPage {
  /** The addressable workloads on this page: those that parsed and have an id. */
  items: WorkloadRef[];
  /**
   * How many matches the server reports. Falls back to the number of entries
   * the page carried when the response omits the count, so a caller comparing
   * it against `items.length` still notices entries this parser had to skip.
   */
  totalCount: number;
}

/**
 * Parse a SaFE `GET /api/v1/workloads` page, skipping entries with no id.
 *
 * Returns null when the body is not a workload list at all — no `items` array.
 * That is deliberately distinct from a list that is legitimately empty: callers
 * read "no workloads" as proof that a session owns nothing, and an
 * unrecognised 200 body (an error object, a different envelope, a bare array)
 * must never reach that conclusion. Session teardown decides whether GPU
 * clusters can still be running from exactly this distinction.
 *
 * @param body Parsed `{ totalCount, items[] }` response body.
 */
export function parseWorkloadListPage(body: unknown): WorkloadListPage | null {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return null;
  const out: WorkloadRef[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.workloadId === "string" ? obj.workloadId : "";
    if (!id) continue;
    const gvk = obj.groupVersionKind as Record<string, unknown> | undefined;
    out.push({
      id,
      phase: typeof obj.phase === "string" ? obj.phase.toLowerCase() : "",
      kind: typeof gvk?.kind === "string" ? gvk.kind : "",
    });
  }
  const reported = (body as { totalCount?: unknown })?.totalCount;
  return {
    items: out,
    totalCount: typeof reported === "number" && reported >= 0 ? reported : items.length,
  };
}
