// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** One element of POST /api/v1/workloads `resources` (SaFE shape). */
export type WorkloadResourceEntry = Record<string, string | number>;

/**
 * Normalize a single DB `resources` JSON blob into one workload resources[] element.
 * Mirrors the original Python sandbox executor's `_normalize_workload_resources_entry`.
 */
export function normalizeWorkloadResourcesEntry(d: unknown): WorkloadResourceEntry | null {
  if (!d || typeof d !== "object") return null;
  const obj = d as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return null;
  const hasQuota =
    ["cpu", "memory", "gpu", "ephemeralStorage", "ephemeral-storage"].some((k) => k in obj) ||
    Object.keys(obj).some((k) => typeof k === "string" && k.includes("/"));
  if (!hasQuota) return null;
  const out: WorkloadResourceEntry = {};
  if ("cpu" in obj) out.cpu = String(obj.cpu);
  if ("gpu" in obj) out.gpu = String(obj.gpu);
  if ("memory" in obj) out.memory = String(obj.memory);
  if ("ephemeral-storage" in obj) {
    out.ephemeralStorage = String(obj["ephemeral-storage"]);
  } else if ("ephemeralStorage" in obj) {
    out.ephemeralStorage = String(obj.ephemeralStorage);
  }
  out.replica = 1;
  for (const [key, val] of Object.entries(obj)) {
    const sk = String(key);
    if (
      ["replica", "cpu", "memory", "gpu", "ephemeralStorage", "ephemeral-storage"].includes(sk)
    ) {
      continue;
    }
    if (sk.includes("/")) {
      out[sk] = String(val);
    }
  }
  const nonReplica = Object.keys(out).filter((k) => k !== "replica");
  if (nonReplica.length === 0) return null;
  return out;
}

/**
 * Map plugins `resources` column JSON to one workload resources[] element.
 * Mirrors `_extract_workload_resources_entry_from_db`.
 */
export function extractWorkloadResourcesEntryFromDb(raw: unknown): WorkloadResourceEntry | null {
  if (raw == null) return null;
  let v: unknown = raw;
  if (Array.isArray(v) && v.length === 1) v = v[0];
  if (!v || typeof v !== "object") return null;
  const norm = normalizeWorkloadResourcesEntry(v);
  if (norm != null) return norm;
  const obj = v as Record<string, unknown>;
  const tpl = obj.template;
  if (tpl && typeof tpl === "object") {
    const inner = (tpl as Record<string, unknown>).resources;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return normalizeWorkloadResourcesEntry(inner);
    }
    if (Array.isArray(inner) && inner.length === 1 && inner[0] && typeof inner[0] === "object") {
      return normalizeWorkloadResourcesEntry(inner[0]);
    }
  }
  return null;
}

/** Build workload `resources` array from DB JSON (workload API shape only). */
export function resourcesJsonToWorkloadArray(raw: unknown): WorkloadResourceEntry[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const out: WorkloadResourceEntry[] = [];
    for (const item of raw) {
      const spec = extractWorkloadResourcesEntryFromDb(item);
      if (spec != null) out.push(spec);
    }
    return out.length ? out : null;
  }
  const spec = extractWorkloadResourcesEntryFromDb(raw);
  return spec != null ? [spec] : null;
}

