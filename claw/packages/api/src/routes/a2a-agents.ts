// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// ---------------------------------------------------------------------------
// A2A agent identity: where an agent card says it can be reached, and what a
// per-plugin agent looks like.
//
// Kept free of database, NATS and Fastify imports so the URL and card rules
// can be driven directly by table tests.
// ---------------------------------------------------------------------------

import type { AgentCard, AgentSkill } from "./a2a-types.js";

/** The generic agent's JSON-RPC endpoint, relative to the API's own root. */
export const A2A_ENDPOINT_PATH = "/a2a";

/** The JSON-RPC endpoint of the agent that runs one plugin. */
export function pluginAgentPath(pluginId: number): string {
  return `${A2A_ENDPOINT_PATH}/plugins/${pluginId}`;
}

type HeaderBag = Record<string, string | string[] | undefined>;

// ---------------------------------------------------------------------------
// Public base URL
//
// The API is served behind an ingress that rewrites a path prefix away, so the
// path the process sees (`/a2a`) is not the path a caller has to use
// (`<prefix>/a2a`). An agent card that advertises the former sends every client
// to the wrong place.
//
// Precedence:
//   1. CLAW_PUBLIC_URL, when set: the operator said where the API is.
//   2. The proxy's forwarded headers, when any is present: `X-Forwarded-Host`
//      (else `Host`), `X-Forwarded-Proto` and `X-Forwarded-Prefix`.
//   3. Nothing: the empty base, i.e. the relative `/a2a` this always returned.
//
// The headers are the caller's to send when the API is reachable without a
// proxy, so each is validated against the narrowest shape it can legitimately
// have and a value that does not fit is ignored, never repaired. The result
// only ever describes the request that produced it, which `Vary` (set by the
// route) keeps a shared cache from handing to anyone else.
// ---------------------------------------------------------------------------

const MAX_HEADER_VALUE = 256;
// A DNS name or IPv4 literal, or a bracketed IPv6 literal, with an optional
// port. One character class and bounded repetition: no backtracking to abuse.
const HOST_RE = /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,252}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
// Plain path segments only. The separator is outside the segment class, so the
// repetition cannot overlap itself.
const PREFIX_RE = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;

function firstHeaderValue(raw: string | string[] | undefined): string {
  const joined = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  // A chain of proxies appends to a list; the outermost entry is the first.
  const first = joined.split(",", 1)[0]?.trim() ?? "";
  return first.length > MAX_HEADER_VALUE ? "" : first;
}

function forwardedHost(headers: HeaderBag): string {
  const host = firstHeaderValue(headers["x-forwarded-host"]) || firstHeaderValue(headers["host"]);
  return HOST_RE.test(host) ? host : "";
}

function forwardedProto(headers: HeaderBag): string {
  const proto = firstHeaderValue(headers["x-forwarded-proto"]).toLowerCase();
  return proto === "http" || proto === "https" ? proto : "";
}

function forwardedPrefix(headers: HeaderBag): string {
  let prefix = firstHeaderValue(headers["x-forwarded-prefix"]);
  while (prefix.endsWith("/")) prefix = prefix.slice(0, -1);
  if (!prefix) return "";
  if (!PREFIX_RE.test(prefix)) return "";
  if (prefix.split("/").some((seg) => seg === "." || seg === "..")) return "";
  return prefix;
}

function stripTrailingSlashes(value: string): string {
  let out = value;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * The externally reachable base of this API, without a trailing slash, or ""
 * when nothing says what it is (the card then carries a relative URL).
 */
export function publicBaseUrl(
  headers: HeaderBag,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = stripTrailingSlashes((env.CLAW_PUBLIC_URL ?? "").trim());
  if (configured) return configured;

  const proxied = Boolean(
    headers["x-forwarded-host"] || headers["x-forwarded-proto"] || headers["x-forwarded-prefix"],
  );
  if (!proxied) return "";

  const host = forwardedHost(headers);
  if (!host) return "";
  // A proxy that forwards the host and says nothing of the scheme is a TLS
  // terminator in practice; plain http is what an operator has to declare.
  const proto = forwardedProto(headers) || "https";
  return `${proto}://${host}${forwardedPrefix(headers)}`;
}

// ---------------------------------------------------------------------------
// Agent cards
// ---------------------------------------------------------------------------

function cardEnvelope(url: string): Pick<
  AgentCard,
  | "supportedInterfaces" | "provider" | "capabilities" | "securitySchemes"
  | "securityRequirements" | "defaultInputModes" | "defaultOutputModes"
> {
  return {
    supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    provider: { url: "https://www.amd.com", organization: "AMD" },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: "bearer", description: "Bearer token authentication" } },
    },
    securityRequirements: [{ bearer: [] }],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
  };
}

/** The generic agent: no plugin, whatever the caller's metadata names. */
export function genericAgentCard(baseUrl: string): AgentCard {
  return {
    name: "PrimusClaw",
    description: "AI Agent operating system for code generation, debugging, and deployment on AMD infrastructure",
    version: "2.0.0",
    ...cardEnvelope(`${baseUrl}${A2A_ENDPOINT_PATH}`),
    skills: [
      { id: "code-generation", name: "Code Generation", description: "Generate, edit, and refactor code in any language", tags: ["code", "generation", "refactor"] },
      { id: "debugging", name: "Debugging", description: "Debug code issues with automated root cause analysis", tags: ["debug", "error", "fix"] },
      { id: "code-review", name: "Code Review", description: "Review code for quality, security, and best practices", tags: ["review", "security", "quality"] },
      { id: "optimization", name: "Performance Optimization", description: "Optimize code and model inference performance on AMD GPUs", tags: ["performance", "gpu", "amd"] },
    ] satisfies AgentSkill[],
  };
}

/** The plugin as `GET /v1/plugins/:id` shows it to the caller. */
export interface PluginCardSource {
  id: number;
  name?: unknown;
  description?: unknown;
  version?: unknown;
  tools?: unknown;
}

// What a plugin can *do*, as opposed to what constrains it: skills and MCP
// servers extend the agent, rules and hooks only fence it in.
const SKILL_TOOL_TYPES = new Set(["skill", "mcp"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pluginSkills(plugin: PluginCardSource, name: string, description: string): AgentSkill[] {
  const skills: AgentSkill[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(plugin.tools) ? plugin.tools : []) {
    if (!raw || typeof raw !== "object") continue;
    const tool = raw as Record<string, unknown>;
    const type = text(tool.type);
    const toolName = text(tool.name);
    if (!SKILL_TOOL_TYPES.has(type) || !toolName) continue;
    const id = `${type}-${toolName}`;
    if (seen.has(id)) continue;
    seen.add(id);
    skills.push({
      id,
      name: toolName,
      description: text(tool.description) || `${type} ${toolName}`,
      tags: [type],
    });
  }
  // A card with no skills advertises an agent that cannot be asked anything.
  if (!skills.length) skills.push({ id: "chat", name, description, tags: [] });
  return skills;
}

/** The agent that runs `plugin`: its name, description and skills are the plugin's. */
export function pluginAgentCard(baseUrl: string, plugin: PluginCardSource): AgentCard {
  const name = text(plugin.name) || `plugin-${plugin.id}`;
  const description = text(plugin.description) || `PrimusClaw agent running the "${name}" plugin`;
  return {
    name,
    description,
    version: text(plugin.version) || "1",
    ...cardEnvelope(`${baseUrl}${pluginAgentPath(plugin.id)}`),
    skills: pluginSkills(plugin, name, description),
  };
}

// ---------------------------------------------------------------------------
// Binding a send to the plugin an endpoint serves
// ---------------------------------------------------------------------------

/**
 * The params of a send, with `metadata.plugin_id` fixed to the endpoint's
 * plugin. The endpoint decides which plugin runs; a caller that names a
 * different one is refused rather than silently overridden, because the
 * response would then come from an agent it did not ask for.
 */
export function bindPluginToSend(
  params: Record<string, unknown>,
  pluginId: number,
): { params: Record<string, unknown> } | { error: string } {
  const metadata = params.metadata;
  if (metadata !== undefined && metadata !== null
    && (typeof metadata !== "object" || Array.isArray(metadata))) {
    return { error: "metadata must be an object" };
  }
  const bag = (metadata ?? {}) as Record<string, unknown>;
  if (bag.plugin_id !== undefined && bag.plugin_id !== null && Number(bag.plugin_id) !== pluginId) {
    return { error: "metadata.plugin_id does not match the plugin this agent serves" };
  }
  return { params: { ...params, metadata: { ...bag, plugin_id: pluginId } } };
}
