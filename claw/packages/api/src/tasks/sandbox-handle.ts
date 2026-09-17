// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

export type SandboxHandle = {
  provider: "safe-workload" | "agent-sandbox";
  handle: string;
};

export function parseSandboxHandle(value: unknown): SandboxHandle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { provider, handle } = value as Record<string, unknown>;
  if (provider !== "safe-workload" && provider !== "agent-sandbox") return null;
  if (typeof handle !== "string" || !handle.trim() || handle.length > 1024) return null;
  if (handle === "." || handle === ".." || /[\u0000-\u001f\u007f-\u009f]/.test(handle)) return null;
  return { provider, handle };
}
