// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Sandbox provider factory. safe mode → SafeWorkloadProvider (SaFE Workload
 * API); kubernetes mode → AgentSandboxProvider (PrimusClaw/Sandbox router).
 * Providers are singletons.
 */

import { CLAW_DEPLOY_MODE } from "../config.js";
import type { SandboxProvider } from "./provider.js";
import { AgentSandboxProvider } from "./agent-sandbox-provider.js";
import { SafeWorkloadProvider } from "./safe-workload-provider.js";

let agentSandbox: SandboxProvider | null = null;
let safeWorkload: SandboxProvider | null = null;

export function getAgentSandboxProvider(): SandboxProvider {
  if (!agentSandbox) agentSandbox = new AgentSandboxProvider();
  return agentSandbox;
}

export function getSafeWorkloadProvider(): SandboxProvider {
  if (!safeWorkload) safeWorkload = new SafeWorkloadProvider();
  return safeWorkload;
}

/** Returns the sandbox provider for the active deploy mode. */
export function getSandboxProvider(): SandboxProvider {
  return CLAW_DEPLOY_MODE === "kubernetes" ? getAgentSandboxProvider() : getSafeWorkloadProvider();
}

/**
 * Override the provider singletons; returns the call that puts them back.
 *
 * The same seam bindContainerProbeEffects and bindHandsKv offer, for the reason
 * they exist: teardown's behaviour is decided entirely by what `stop` does, and
 * with no way to say what that is, the only part of destroyHands a test could
 * reach was its KV helper. The paths that matter -- a stop that fails, and one
 * this deployment cannot issue at all -- were untestable.
 */
export function bindSandboxProviders(over: {
  agentSandbox?: SandboxProvider;
  safeWorkload?: SandboxProvider;
}): () => void {
  const prevAgent = agentSandbox;
  const prevSafe = safeWorkload;
  if (over.agentSandbox) agentSandbox = over.agentSandbox;
  if (over.safeWorkload) safeWorkload = over.safeWorkload;
  return () => { agentSandbox = prevAgent; safeWorkload = prevSafe; };
}
