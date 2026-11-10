// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The API's half of SANDBOX_ALLOWED_NAMESPACES (see @claw/protocol
 * sandbox-workspaces.ts): every route that lets a request name the workspace a
 * sandbox lands in asks here first and answers 400 with the returned body.
 */
import {
  allowedSandboxWorkspaces,
  firstDisallowedSandboxWorkspace,
  sandboxWorkspaceNotAllowedBody,
} from "@claw/protocol";

export type SandboxWorkspaceRefusal = ReturnType<typeof sandboxWorkspaceNotAllowedBody>;

/**
 * The 400 body for the first of `workspaces` a sandbox may not be created in,
 * or null when the deployment allows all of them (or sets no list at all).
 * Read at every call, not at import: the setting is the deployment's, and a
 * test or a restart that changes it must not be answered from a stale copy.
 */
export function sandboxWorkspaceRefusal(
  workspaces: Iterable<string | null | undefined>,
  env: Record<string, string | undefined> = process.env,
): SandboxWorkspaceRefusal | null {
  const allowed = allowedSandboxWorkspaces(env);
  if (allowed === null) return null;
  const refused = firstDisallowedSandboxWorkspace(workspaces, allowed);
  return refused === null ? null : sandboxWorkspaceNotAllowedBody(refused, allowed);
}
