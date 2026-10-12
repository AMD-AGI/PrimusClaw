// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Per-workspace Hugging Face token for sandboxes.
 *
 * Every sandbox in a workspace shares one egress IP, and anonymous Hugging Face
 * Hub access from that IP is rate limited (HTTP 429). A workload that downloads
 * a model or a dataset then fails in a way that looks like its own fault. The
 * fix is a token per workspace, delivered the way the LLM key is delivered:
 * Brain puts it into the sandbox env, so it never has to travel in a prompt, a
 * request body or a caller's config.
 *
 * SaFE mode only; see workspaceHfTokenFor for why.
 *
 * The value comes from a Kubernetes Secret the operator creates and the chart
 * mounts into Brain (`brain.workspaceHfTokenSecret`): one key per workspace,
 * named exactly as the workspace (the sandbox namespace), holding that
 * workspace's token. SANDBOX_HF_TOKEN_DIR is the mount path. A workspace with
 * no key gets no HF_TOKEN, which is exactly the behaviour before this existed.
 *
 * The file is re-read after a short TTL rather than cached for the life of the
 * process, so a rotated Secret reaches new sandboxes once the kubelet has
 * synced the volume, without a Brain restart.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { ExecuteRequest } from "@claw/protocol";
import {
  AGENT_SANDBOX_NAMESPACE,
  SANDBOX_HF_TOKEN_DIR,
  SANDBOX_NAMESPACE,
  isKubernetesMode,
} from "../config.js";

const logger = pino({ name: "workspace-hf-token" });

/** The env name every Hugging Face client reads. */
export const HF_TOKEN_ENV = "HF_TOKEN";

/**
 * A Secret data key, and a Kubernetes namespace, are both within this shape.
 * Anything else -- above all `..`, `/`, or a leading dot, which would reach
 * the `..data` symlinks a Secret volume carries or a file outside the mount --
 * is refused before it is joined to a path. The workspace id arrives on the
 * request, so this is what stops a caller from choosing which Brain-readable
 * file is copied into its sandbox's environment.
 */
const WORKSPACE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

const CACHE_TTL_MS = 30_000;

/** The workspace (namespace) a request's sandbox lands in. */
export function sandboxNamespaceFor(request: Pick<ExecuteRequest, "workspace_id">): string {
  const fallback = isKubernetesMode() ? AGENT_SANDBOX_NAMESPACE : SANDBOX_NAMESPACE;
  return request.workspace_id?.trim() || fallback;
}

interface CacheEntry {
  value: string | undefined;
  at: number;
}
const cache = new Map<string, CacheEntry>();

/** For tests: forget everything read so far. */
export function resetWorkspaceHfTokenCache(): void {
  cache.clear();
}

/**
 * The HF token configured for `workspace`, or undefined when none is.
 *
 * Undefined covers: the feature is off (no dir), the workspace has no key, the
 * key is empty, or the workspace name is not a valid key. A read that fails for
 * any other reason is logged by error code -- never by value -- and also yields
 * undefined: a sandbox without a token degrades to anonymous Hub access, which
 * is what it had before; refusing to start it would turn a rate-limit risk into
 * an outage.
 */
export function readWorkspaceHfToken(
  workspace: string,
  dir: string = SANDBOX_HF_TOKEN_DIR,
  now: number = Date.now(),
): string | undefined {
  if (!dir || !workspace || !WORKSPACE_KEY_RE.test(workspace) || workspace.includes("..")) {
    return undefined;
  }
  const cacheKey = `${dir}\0${workspace}`;
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;

  let value: string | undefined;
  try {
    value = readFileSync(join(dir, workspace), "utf8").trim() || undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logger.warn({ workspace, code: code ?? "unknown" }, "workspace_hf_token.read_failed");
    }
    value = undefined;
  }
  cache.set(cacheKey, { value, at: now });
  return value;
}

/**
 * The token for the workspace this request's sandbox lands in -- SaFE mode only.
 *
 * The workspace id is chosen by the caller, so which workspace's token a
 * sandbox receives is an authorization question, and this module cannot answer
 * it. In SaFE mode SaFE does: the sandbox workload is created with the caller's
 * own platform key in that workspace, and SaFE refuses it unless the caller may
 * run there, so a token only ever lands in a sandbox its workspace admitted.
 * Kubernetes mode has no such binding between a caller and a namespace, and
 * handing out a token there would let any caller who names another workspace
 * read that workspace's token from its own sandbox. So it gets none until that
 * mode has a check of its own.
 */
export function workspaceHfTokenFor(request: Pick<ExecuteRequest, "workspace_id">): string | undefined {
  if (isKubernetesMode()) return undefined;
  return readWorkspaceHfToken(sandboxNamespaceFor(request));
}

/**
 * Put the workspace token into a sandbox's base env.
 *
 * Set on the base layer, the same layer as ANTHROPIC_API_KEY, so it wins over
 * the sandbox spec's own env but a user or session HF_TOKEN still overrides it
 * through composeSandboxEnv: someone who brings their own token gets theirs.
 */
export function applyWorkspaceHfToken(
  env: Record<string, string>,
  token: string | undefined,
): void {
  if (token) env[HF_TOKEN_ENV] = token;
}
