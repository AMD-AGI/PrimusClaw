// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The sandbox workspace a dispatched task is stamped with when its session names none.
 *
 * Brain obeys a task's `workspace_id` over its own default, so what is stamped here
 * decides where every sandbox of the task goes. With one workspace that is
 * SANDBOX_NAMESPACE, as before. With a separate CPU workspace (SANDBOX_CPU_NAMESPACE)
 * nothing is stamped: only Brain sees what each sandbox asks for, and stamping the GPU
 * workspace here would pin the task's CPU-only sandboxes to it.
 */
export function defaultTaskWorkspaceId(env: Record<string, string | undefined> = process.env): string {
  if ((env.SANDBOX_CPU_NAMESPACE || "").trim()) return "";
  return (env.SANDBOX_NAMESPACE || "").trim();
}
