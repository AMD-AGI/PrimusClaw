// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * AgentSandboxProvider — kubernetes-mode sandbox backend over the
 * PrimusClaw/Sandbox Router public API:
 *   POST   /v1/templates                              (idempotent, content-hash name)
 *   POST   /v1/code-interpreter                       (blocks until pod healthy)
 *   POST   /v1/namespaces/{ns}/code-interpreters/{name}/invocations/api/execute
 *   GET    /v1/code-interpreter/sessions/{id}         (also refreshes lastActivity)
 *   DELETE /v1/code-interpreter/sessions/{id}
 *
 * See sandbox/README.md and the Router API docs for the endpoint contracts.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import pino from "pino";
import {
  AGENT_SANDBOX_ROUTER_URL,
  AGENT_SANDBOX_NAMESPACE,
  AGENT_SANDBOX_TEMPLATE_FILE,
  AGENT_SANDBOX_WARM_POOL_SIZE,
  AGENT_SANDBOX_SESSION_TIMEOUT,
  AGENT_SANDBOX_MAX_SESSION_DURATION,
} from "../config.js";
import { SandboxStopUnavailable } from "./errors.js";
import { EXEC_TRANSPORT_SLACK_MS, parseExecTimeoutMs } from "./provider.js";
import type {
  SandboxProvider,
  SandboxCreateParams,
  SandboxInstance,
  SandboxStatus,
  SandboxExecResult,
} from "./provider.js";

const logger = pino({ name: "agent-sandbox-provider" });

const HANDS_MCP_PORT = 9100;
const TEMPLATE_READY_TIMEOUT_MS = 90_000;
const TEMPLATE_POLL_INTERVAL_MS = 2_000;
const CREATE_TIMEOUT_MS = 300_000;
const BASE_TEMPLATE_NAME = "primus-claw-hands";

interface RenderedTemplate {
  name: string;
  spec: Record<string, unknown>;
}

function sha256Short(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** Minimal inline CodeInterpreter spec — the fallback used when no base template
 *  ConfigMap is mounted (AGENT_SANDBOX_TEMPLATE_FILE unset) or it fails to parse. */
function buildFallbackSpec(): Record<string, unknown> {
  return {
    authMode: "none",
    runtimePolicy: "agent-default",
    // The platform's own default, restated so the skeleton is self-contained.
    // Reachable now: renderTemplate replaces it when a deployment sets
    // AGENT_SANDBOX_SESSION_TIMEOUT or a caller passes params.sessionTimeout.
    sessionTimeout: "15m",
    // Likewise, via AGENT_SANDBOX_MAX_SESSION_DURATION or
    // params.maxSessionDuration. Not a platform ceiling -- the Workload Manager
    // takes any value and says so -- just this skeleton's default.
    maxSessionDuration: "24h",
    template: {
      fromImage: "<PLACEHOLDER_IMAGE>",
      imagePullPolicy: "IfNotPresent",
      environment: [{ name: "WORKSPACE_PATH", value: "/workspace" }],
      resources: {
        requests: { cpu: "1", memory: "2Gi" },
        limits: { cpu: "2", memory: "4Gi" },
      },
      steps: [
        { type: "workdir", args: ["/workspace"] },
      ],
    },
  };
}

export interface BaseTemplate {
  source: "router" | "configmap" | "inline";
  spec: Record<string, unknown>;
  digest: string;
}
let cachedConfigMapBase: BaseTemplate | null = null;

/** Load the base CodeInterpreter spec from the ConfigMap-mounted YAML file
 *  (AGENT_SANDBOX_TEMPLATE_FILE). Cached after first read (edits take effect on
 *  Brain restart). Falls back to the inline minimal skeleton when the file is
 *  unset, missing, or malformed. */
function digestSpec(spec: Record<string, unknown>): string {
  return sha256Short(JSON.stringify(spec));
}

function loadConfigMapBaseTemplate(): BaseTemplate {
  if (cachedConfigMapBase) return cachedConfigMapBase;
  const file = AGENT_SANDBOX_TEMPLATE_FILE.trim();
  if (file) {
    try {
      const raw = readFileSync(file, "utf8");
      const doc = parseYaml(raw) as { spec?: unknown } | null;
      if (doc && doc.spec && typeof doc.spec === "object") {
        const spec = doc.spec as Record<string, unknown>;
        cachedConfigMapBase = { source: "configmap", spec, digest: digestSpec(spec) };
        logger.info({ file }, "agent-sandbox.base_template_loaded");
        return cachedConfigMapBase;
      }
      logger.warn({ file }, "agent-sandbox.base_template_no_spec_using_fallback");
    } catch (err) {
      logger.warn({ file, err: String(err) }, "agent-sandbox.base_template_read_failed_using_fallback");
    }
  }
  const spec = buildFallbackSpec();
  cachedConfigMapBase = { source: "inline", spec, digest: digestSpec(spec) };
  logger.warn("agent-sandbox.base_template_inline_fallback");
  return cachedConfigMapBase;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeBody(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function extractHost(entryPoint?: string): string {
  if (!entryPoint) return "";
  try {
    return new URL(entryPoint).hostname;
  } catch {
    return "";
  }
}

/**
 * Everything that must select a different template when it changes.
 *
 * Templates are content-addressed and created idempotently, so anything left
 * out of here is a setting an operator cannot actually change: the render would
 * resolve to the name already built under the old value.
 *
 * Includes the base digest so editing the ConfigMap yields a new name rather
 * than reusing a template with stale steps/volumes, and the userId because
 * templates are private to the Router user unless marked public — one BYOK user
 * must never collide with another's.
 */
/**
 * The idle timeout this sandbox should carry: the caller's, else the
 * deployment default, else nothing -- "nothing" leaving the base template's own
 * value in place rather than substituting one.
 */
function resolveSessionTimeout(params: SandboxCreateParams): string {
  return params.sessionTimeout?.trim() || AGENT_SANDBOX_SESSION_TIMEOUT;
}

/**
 * The absolute lifetime this sandbox should carry, resolved the same way and
 * meaning the same thing by its absence: nothing here leaves the base
 * template's own value in place.
 */
function resolveMaxSessionDuration(params: SandboxCreateParams): string {
  return params.maxSessionDuration?.trim() || AGENT_SANDBOX_MAX_SESSION_DURATION;
}

export function templateHashKey(base: BaseTemplate, params: SandboxCreateParams): string {
  const r = params.resources;
  return [
    base.digest, params.userId ?? "", params.image,
    r.cpu, r.memory, r.ephemeralStorage, r.gpu,
    `warm=${AGENT_SANDBOX_WARM_POOL_SIZE}`,
    `idle=${resolveSessionTimeout(params)}`,
    `life=${resolveMaxSessionDuration(params)}`,
  ].join("|");
}

/**
 * Render a CodeInterpreter template from the base skeleton + per-request
 * overrides (fromImage / resources / gpu). Content-hash naming so identical
 * image+resources reuse the same template, and a differing spec selects a
 * different one.
 */
export function renderTemplate(base: BaseTemplate, params: SandboxCreateParams): RenderedTemplate {
  const r = params.resources;
  const gpu = Number(r.gpu ?? "0");
  const spec = structuredClone(base.spec) as Record<string, unknown>;

  // Override only the dynamic fields; everything else stays as the base configures.
  const tpl = (spec.template ?? {}) as Record<string, unknown>;
  spec.template = tpl;
  tpl.fromImage = params.image;

  // resources: params-provided keys override requests+limits; unset keys keep base defaults.
  const res = (tpl.resources ?? {}) as { requests?: Record<string, string>; limits?: Record<string, string> };
  tpl.resources = res;
  res.requests = { ...(res.requests ?? {}) };
  res.limits = { ...(res.limits ?? {}) };
  if (r.cpu) { res.requests.cpu = r.cpu; res.limits.cpu = r.cpu; }
  if (r.memory) { res.requests.memory = r.memory; res.limits.memory = r.memory; }
  if (r.ephemeralStorage) {
    res.requests["ephemeral-storage"] = r.ephemeralStorage;
    res.limits["ephemeral-storage"] = r.ephemeralStorage;
  }

  if (gpu > 0) {
    spec.gpu = { ...((spec.gpu as Record<string, unknown>) ?? {}), count: gpu, resourceName: "amd.com/gpu" };
  }

  // Set here rather than left to whichever base was loaded, so the knob means
  // the same thing for a Router template, a mounted ConfigMap and the inline
  // skeleton alike. What raising it costs, and what had to change before it
  // could be raised at all, is in the AGENT_SANDBOX_WARM_POOL_SIZE comment.
  spec.warmPoolSize = AGENT_SANDBOX_WARM_POOL_SIZE;

  // Only when asked for. Unlike the warm pool, unset here does not mean "use the
  // default" but "whatever the base decided": a mounted ConfigMap may carry a
  // deliberate sessionTimeout, and overwriting that with a value nobody asked
  // for would quietly shorten every sandbox the deployment builds.
  const idleTimeout = resolveSessionTimeout(params);
  if (idleTimeout) spec.sessionTimeout = idleTimeout;

  // Same rule, same reason. Worth stating separately because the failure is
  // quieter: an idle timeout that is too short reclaims a sandbox that could
  // have been kept alive, while this one reclaims it no matter what anybody
  // does, so a base that raised it deliberately must not be talked back down.
  const maxLifetime = resolveMaxSessionDuration(params);
  if (maxLifetime) spec.maxSessionDuration = maxLifetime;

  const name = "primus-claw-" + sha256Short(templateHashKey(base, params));
  logger.info({ source: base.source, digest: base.digest, renderedName: name, image: params.image, resources: r }, "agent-sandbox.template_rendered");
  return { name, spec };
}

export class AgentSandboxProvider implements SandboxProvider {
  readonly kind = "agent-sandbox" as const;

  private async routerFetch(
    path: string,
    init: RequestInit & { timeoutMs?: number; userId?: string } = {},
  ): Promise<Response> {
    if (!AGENT_SANDBOX_ROUTER_URL) {
      throw new Error("AGENT_SANDBOX_ROUTER_URL is not set (kubernetes mode)");
    }
    const { timeoutMs = 30_000, userId, ...rest } = init;
    // [security] Forward BYOK user identity so the Router/WM scopes ownership +
    // audit instead of treating an empty userId as system-admin.
    const headers: Record<string, string> = { ...(rest.headers as Record<string, string> | undefined) };
    if (userId) headers["userId"] = userId;
    return fetch(`${AGENT_SANDBOX_ROUTER_URL}${path}`, {
      ...rest,
      headers,
      signal: rest.signal
        ? AbortSignal.any([rest.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
  }

  async create(params: SandboxCreateParams): Promise<SandboxInstance> {
    const ns = params.namespace || AGENT_SANDBOX_NAMESPACE;
    const { name } = await this.ensureTemplate(params, ns);

    // Router blocks until pod Running + healthy before returning.
    const resp = await this.routerFetch(`/v1/code-interpreter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        namespace: ns,
        overrides: {
          environment: params.env,
          ...(params.labels ? { labels: params.labels } : {}),
        },
      }),
      timeoutMs: CREATE_TIMEOUT_MS,
      userId: params.userId,
    });
    if (!resp.ok) {
      throw new Error(`agent-sandbox create failed: ${resp.status} ${await safeBody(resp)}`);
    }
    const data = (await resp.json()) as {
      sessionId: string;
      sandboxName: string;
      entryPoints?: Record<string, string>;
    };
    // entryPoints.default is http://<podIP>:8080 — take host only, Hands is on 9100.
    const host = extractHost(data.entryPoints?.default) || data.sandboxName;
    logger.info({ sessionId: data.sessionId, sandboxName: data.sandboxName }, "agent-sandbox created");
    return {
      provider: "agent-sandbox",
      id: data.sessionId,
      sandboxName: data.sandboxName,
      namespace: ns,
      handsBaseUrl: `http://${host}:${HANDS_MCP_PORT}`,
      userId: params.userId,
    };
  }

  async get(inst: SandboxInstance): Promise<SandboxStatus> {
    const resp = await this.routerFetch(`/v1/code-interpreter/sessions/${inst.id}`, { timeoutMs: 15_000, userId: inst.userId });
    if (!resp.ok) return { running: false, healthy: false };
    const d = (await resp.json()) as { status?: string; healthy?: boolean; podIp?: string };
    return { running: d.status === "running", healthy: !!d.healthy, podIp: d.podIp };
  }

  async exec(
    inst: SandboxInstance,
    command: string,
    timeout: string,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    const path = `/v1/namespaces/${inst.namespace}/code-interpreters/${inst.sandboxName}/invocations/api/execute`;
    const resp = await this.routerFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": inst.id },
      body: JSON.stringify({ command: ["sh", "-c", command], timeout }),
      timeoutMs: parseExecTimeoutMs(timeout) + EXEC_TRANSPORT_SLACK_MS,
      userId: inst.userId,
      signal,
    });
    if (!resp.ok) {
      throw new Error(`agent-sandbox exec failed: ${resp.status} ${await safeBody(resp)}`);
    }
    const r = (await resp.json()) as {
      exit_code?: number; exitCode?: number; stdout?: string; stderr?: string;
    };
    return {
      exitCode: r.exit_code ?? r.exitCode ?? -1,
      stdout: String(r.stdout ?? ""),
      stderr: String(r.stderr ?? ""),
    };
  }

  async stop(inst: SandboxInstance): Promise<void> {
    if (!inst.id || !AGENT_SANDBOX_ROUTER_URL) {
      // The safe-workload counterpart's reasoning, for the fields this provider
      // needs instead: unavailable rather than failed, so teardown continues.
      throw new SandboxStopUnavailable(
        "agent-sandbox stop requires a session id and AGENT_SANDBOX_ROUTER_URL",
      );
    }
    const resp = await this.routerFetch(`/v1/code-interpreter/sessions/${inst.id}`, {
      method: "DELETE",
      timeoutMs: 30_000,
      userId: inst.userId,
    });
    if (![200, 202, 204, 404].includes(resp.status)) {
      throw new Error(`agent-sandbox stop failed: ${resp.status} ${await safeBody(resp)}`);
    }
  }

  private async loadRouterBaseTemplate(params: SandboxCreateParams, ns: string): Promise<BaseTemplate | null> {
    const url = `/v1/templates/${ns}/${BASE_TEMPLATE_NAME}`;
    try {
      const resp = await this.routerFetch(url, { timeoutMs: 15_000, userId: params.userId });
      if (!resp.ok) {
        logger.warn({ namespace: ns, baseName: BASE_TEMPLATE_NAME, status: resp.status }, "agent-sandbox.base_template_router_fallback");
        return null;
      }
      const doc = (await resp.clone().json()) as { spec?: unknown; status?: { ready?: boolean } };
      if (!doc.status?.ready || !doc.spec || typeof doc.spec !== "object") {
        logger.warn({ namespace: ns, baseName: BASE_TEMPLATE_NAME, ready: !!doc.status?.ready }, "agent-sandbox.base_template_router_fallback");
        return null;
      }
      const spec = doc.spec as Record<string, unknown>;
      const base = { source: "router" as const, spec, digest: digestSpec(spec) };
      logger.info({ namespace: ns, baseName: BASE_TEMPLATE_NAME, digest: base.digest }, "agent-sandbox.base_template_router_loaded");
      return base;
    } catch (err) {
      logger.warn({ namespace: ns, baseName: BASE_TEMPLATE_NAME, err: String(err) }, "agent-sandbox.base_template_router_fallback");
      return null;
    }
  }

  private async resolveBaseTemplate(params: SandboxCreateParams, ns: string): Promise<BaseTemplate> {
    return (await this.loadRouterBaseTemplate(params, ns)) ?? loadConfigMapBaseTemplate();
  }

  /** Resolve base → render → GET → (404) POST /v1/templates → poll Ready. Idempotent. */
  private async ensureTemplate(params: SandboxCreateParams, ns: string): Promise<RenderedTemplate> {
    const base = await this.resolveBaseTemplate(params, ns);
    const rendered = renderTemplate(base, params);
    const getUrl = `/v1/templates/${ns}/${rendered.name}`;

    const existing = await this.routerFetch(getUrl, { timeoutMs: 15_000, userId: params.userId });
    if (existing.ok) {
      if (await isTemplateReady(existing)) return rendered;
    } else if (existing.status === 404) {
      const created = await this.routerFetch(`/v1/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: rendered.name, namespace: ns, spec: rendered.spec }),
        timeoutMs: 30_000,
        userId: params.userId,
      });
      // 409 = concurrent create by another Brain/task; treat as success.
      if (!created.ok && created.status !== 409) {
        throw new Error(`agent-sandbox template create failed: ${created.status} ${await safeBody(created)}`);
      }
    } else {
      throw new Error(`agent-sandbox template lookup failed: ${existing.status}`);
    }

    const deadline = Date.now() + TEMPLATE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const r = await this.routerFetch(getUrl, { timeoutMs: 15_000, userId: params.userId });
      if (r.ok && (await isTemplateReady(r))) return rendered;
      await sleep(TEMPLATE_POLL_INTERVAL_MS);
    }
    throw new Error(`agent-sandbox template ${rendered.name} not Ready within ${TEMPLATE_READY_TIMEOUT_MS}ms`);
  }
}

async function isTemplateReady(resp: Response): Promise<boolean> {
  try {
    const d = (await resp.clone().json()) as { status?: { ready?: boolean } };
    return !!d.status?.ready;
  } catch {
    return false;
  }
}
