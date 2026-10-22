// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Grant caps are the smaller of the demand, the hosting defaults, and the
 * platform ceiling in APP_SANDBOX_CAPS.
 */

export interface RoleCap {
  maxSandboxes: number;
  maxGpus: number;
}

export interface PlatformCaps {
  measurement?: RoleCap;
  subrun?: RoleCap;
  dev?: RoleCap;
  maxSandboxSeconds?: number;
  gpuHoursBudget?: number;
  graceMinutes?: number;
  maxHours?: number;
}

export interface HostingLimits {
  maxParallelTests?: number;
  tp?: number;
  maxGpuHours?: number;
  maxHours?: number;
  maxBranches?: number;
  devMaxSandboxes?: number;
  devMaxGpus?: number;
}

export interface Demand {
  placement?: { max_parallel_tests?: number };
  hardware?: { tp?: number };
  budget?: { max_gpu_hours?: number; max_hours?: number };
  multibranch?: { max_branches?: number };
}

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

const DEFAULT_GRACE_MINUTES = 30;
const DEFAULT_MAX_HOURS = 24;

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
  demand: Demand,
  limits: HostingLimits,
  platform: PlatformCaps,
  start: Date,
  perGpuCounts: number[],
): GrantCaps {
  const parallel = lesser(
    demand.placement?.max_parallel_tests,
    limits.maxParallelTests,
    platform.measurement?.maxSandboxes,
  );
  const tp = positive(demand.hardware?.tp ?? limits.tp) || 1;
  const measurement: RoleCap = {
    maxSandboxes: parallel,
    maxGpus: lesser(parallel * tp, undefined, platform.measurement?.maxGpus),
  };
  const branches = lesser(
    demand.multibranch?.max_branches,
    limits.maxBranches,
    platform.subrun?.maxSandboxes,
  );
  const subrun: RoleCap = {
    maxSandboxes: branches,
    maxGpus: lesser(branches * tp, undefined, platform.subrun?.maxGpus),
  };
  const dev: RoleCap = {
    maxSandboxes: lesser(undefined, limits.devMaxSandboxes, platform.dev?.maxSandboxes),
    maxGpus: lesser(undefined, limits.devMaxGpus, platform.dev?.maxGpus),
  };
  const hours = lesser(
    demand.budget?.max_hours,
    limits.maxHours ?? platform.maxHours,
    undefined,
  ) || DEFAULT_MAX_HOURS;
  const graceMin = platform.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const expiresAt = new Date(start.getTime() + (hours * 60 + graceMin) * 60 * 1000);
  const fromTemplates = perGpuCounts.filter((n) => n > 0);
  const maxGpusPerSandbox = fromTemplates.length > 0 ? Math.max(...fromTemplates) : tp;
  return {
    roles: { measurement, subrun, dev },
    gpuHoursBudget: lesser(
      demand.budget?.max_gpu_hours,
      limits.maxGpuHours,
      platform.gpuHoursBudget,
    ),
    maxSandboxSeconds: platform.maxSandboxSeconds ?? 0,
    expiresAt,
    maxGpusPerSandbox,
  };
}

function lesser(demand: number | undefined, fallback: number | undefined, ceiling: number | undefined): number {
  const asked = defined(demand) ? demand : fallback;
  if (!defined(asked) && !defined(ceiling)) return 0;
  if (!defined(asked)) return ceiling as number;
  if (!defined(ceiling)) return asked as number;
  return Math.min(asked as number, ceiling as number);
}

function defined(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function positive(n: number | undefined): number {
  return defined(n) && n > 0 ? n : 0;
}
