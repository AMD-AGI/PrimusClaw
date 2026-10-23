// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Issued grant caps are the smaller of the request and APP_SANDBOX_CAPS,
 * field by field. Sandbox and GPU counts are per role. GPU hours are one
 * shared budget. A field omitted from the request takes the platform value.
 */

export interface RoleCap {
  maxSandboxes: number;
  maxGpus: number;
}

export interface RoleGrant {
  max_sandboxes?: number;
  max_gpus?: number;
}

export interface GrantRequest {
  roles?: {
    measurement?: RoleGrant;
    subrun?: RoleGrant;
    dev?: RoleGrant;
  };
  gpu_hours?: number;
  max_runtime_sec?: number;
}

/** APP_SANDBOX_CAPS uses the same shape as the grant request. */
export type PlatformCaps = GrantRequest;

export interface GrantCaps {
  roles: {
    measurement: RoleCap;
    subrun: RoleCap;
    dev: RoleCap;
  };
  gpuHoursBudget: number;
  maxSandboxSeconds: number;
  expiresAt: Date;
  maxGpusPerSandbox: number;
}

const DEFAULT_GRANT_HOURS = 24;
const ROLES = ["measurement", "subrun", "dev"] as const;

/** Parse APP_SANDBOX_CAPS. An empty value is an empty ceiling. */
export function parsePlatformCaps(raw: string | undefined): PlatformCaps {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as PlatformCaps;
  if (!parsed || typeof parsed !== "object") return {};
  return parsed;
}

/**
 * Compute the caps written onto a grant.
 * A zero GPU-hour budget means the grant has no GPU-hour cap.
 */
export function computeCaps(
  request: GrantRequest,
  platform: PlatformCaps,
  start: Date,
  perGpuCounts: number[],
): GrantCaps {
  const roles = {
    measurement: roleCap(request, platform, "measurement"),
    subrun: roleCap(request, platform, "subrun"),
    dev: roleCap(request, platform, "dev"),
  };
  const fromTemplates = perGpuCounts.filter((n) => n > 0);
  const maxGpusPerSandbox = fromTemplates.length > 0 ? Math.max(...fromTemplates) : 0;
  return {
    roles,
    gpuHoursBudget: capField(request.gpu_hours, platform.gpu_hours),
    maxSandboxSeconds: capField(request.max_runtime_sec, platform.max_runtime_sec),
    expiresAt: new Date(start.getTime() + DEFAULT_GRANT_HOURS * 60 * 60 * 1000),
    maxGpusPerSandbox,
  };
}

function roleCap(request: GrantRequest, platform: PlatformCaps, role: (typeof ROLES)[number]): RoleCap {
  return {
    maxSandboxes: capField(request.roles?.[role]?.max_sandboxes, platform.roles?.[role]?.max_sandboxes),
    maxGpus: capField(request.roles?.[role]?.max_gpus, platform.roles?.[role]?.max_gpus),
  };
}

/** Keep the smaller of the request and the ceiling. An omitted request uses the ceiling. */
function capField(asked: number | undefined, ceiling: number | undefined): number {
  if (!defined(asked) && !defined(ceiling)) return 0;
  if (!defined(asked)) return ceiling as number;
  if (!defined(ceiling)) return asked;
  return Math.min(asked, ceiling as number);
}

function defined(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}
