// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which workspaces (== Kubernetes namespaces) a sandbox may be created in.
 *
 * A request may name the workspace its sandbox lands in: `workspaceId` on a
 * message or a session's first message, `workspace_id` on an MCP or managed
 * agent call, `namespace` on a DAG node's sandbox, the `resources.workspace` of
 * an application run and the workspaces of its grant. The platform only checks
 * that the account may create workloads there. Whether the workspace isolates a
 * sandbox's network -- the egress and ingress policies a sandbox relies on --
 * is a property of the deployment, and nothing checked it: a sandbox could be
 * sent to any workspace its owner belongs to, including one with no policy at
 * all.
 *
 * SANDBOX_ALLOWED_NAMESPACES names the workspaces that do isolate sandboxes,
 * comma or space separated. Unset or empty keeps the old behaviour: every
 * workspace is allowed. Set, a sandbox is created only in a workspace on the
 * list, and a request naming any other is refused with
 * `sandbox_workspace_not_allowed` before anything is created.
 *
 * The deployment's own sandbox workspaces (SANDBOX_NAMESPACE,
 * SANDBOX_CPU_NAMESPACE and AGENT_SANDBOX_NAMESPACE, when set) are always on
 * the list: they are where a request that names nothing goes, so leaving one
 * off would refuse every such request rather than narrow anything.
 *
 * The API and Brain read the same setting: the API answers a request that
 * names a workspace off the list with 400, and Brain refuses to create a
 * sandbox there, for whatever reached it without passing the API's check.
 */

export const SANDBOX_ALLOWED_NAMESPACES_ENV = "SANDBOX_ALLOWED_NAMESPACES";

/** Stable reason for a refused workspace: the API's `error` and Brain's failure reason. */
export const SANDBOX_WORKSPACE_NOT_ALLOWED = "sandbox_workspace_not_allowed";

/** The deployment settings that name a sandbox workspace of its own. */
const DEPLOYMENT_SANDBOX_WORKSPACE_ENVS = ["SANDBOX_NAMESPACE", "SANDBOX_CPU_NAMESPACE", "AGENT_SANDBOX_NAMESPACE"] as const;

type Env = Record<string, string | undefined>;

function names(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * The workspaces sandboxes may be created in, or null when every workspace is
 * allowed (SANDBOX_ALLOWED_NAMESPACES unset, empty or only separators).
 */
export function allowedSandboxWorkspaces(env: Env = process.env): ReadonlySet<string> | null {
  const listed = names(env[SANDBOX_ALLOWED_NAMESPACES_ENV]);
  if (listed.length === 0) return null;
  const allowed = new Set(listed);
  for (const key of DEPLOYMENT_SANDBOX_WORKSPACE_ENVS) for (const n of names(env[key])) allowed.add(n);
  return allowed;
}

/**
 * Whether a sandbox may be created in `workspace`. An empty name is allowed:
 * it is not a workspace but "the deployment's default", which is on the list.
 */
export function sandboxWorkspaceAllowed(workspace: string | null | undefined, allowed: ReadonlySet<string> | null): boolean {
  if (allowed === null) return true;
  const ws = (workspace ?? "").trim();
  return ws === "" || allowed.has(ws);
}

/** The first of `workspaces` a sandbox may not be created in, or null when all may be. */
export function firstDisallowedSandboxWorkspace(
  workspaces: Iterable<string | null | undefined>,
  allowed: ReadonlySet<string> | null,
): string | null {
  if (allowed === null) return null;
  for (const w of workspaces) if (!sandboxWorkspaceAllowed(w, allowed)) return (w ?? "").trim();
  return null;
}

/** What the person is told: which workspace was refused, why, and where sandboxes may run. */
export function sandboxWorkspaceNotAllowedText(workspace: string, allowed: ReadonlySet<string>): string {
  const list = [...allowed].sort().join(", ");
  return `Sandboxes on this deployment may only run in workspaces that isolate their network (${list}).`
    + ` The ${workspace} workspace is not one of them: name one of those workspaces, or none to use the default.`;
}

/** The 400 body the API answers with for a refused workspace. */
export function sandboxWorkspaceNotAllowedBody(workspace: string, allowed: ReadonlySet<string>): {
  ok: false; error: typeof SANDBOX_WORKSPACE_NOT_ALLOWED; workspace: string; allowed: string[]; message: string;
} {
  return {
    ok: false,
    error: SANDBOX_WORKSPACE_NOT_ALLOWED,
    workspace,
    allowed: [...allowed].sort(),
    message: sandboxWorkspaceNotAllowedText(workspace, allowed),
  };
}
