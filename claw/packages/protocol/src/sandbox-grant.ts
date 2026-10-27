// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Client for Agent Sandbox grant issuance.
 *
 * Claw signs an ES256 attestation and calls `/internal/v1/grants` with the
 * pod service-account token. A repeated issue of the same id returns 200 and
 * no keys; that answer is a failure here, and the id is revoked so the caller
 * can try a new one.
 */
import { createPrivateKey, sign as signRaw, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { APP_SANDBOX_ROLES, type AppSandboxRole, type AppSandboxRoles } from "./app-manifest.js";
import type { AppGrantLimits } from "./app-resources.js";

export const GRANT_KID = "sandbox-grant-1";
export const GRANT_ISSUER = "primus-claw";
export const GRANT_AUDIENCE = "agent-sandbox-workload";
export const DEFAULT_GRANT_URL = "http://agent-sandbox-router.agent-sandbox-system.svc.cluster.local:8080/internal/v1/grants";
/** Brain's revoke waits this long for the sandboxes under the grant to go. */
export const GRANT_REVOKE_TIMEOUT_MS = 60_000;
const TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const ROLES = new Set<string>(APP_SANDBOX_ROLES);

/** Claims the sandbox checks on the attestation. */
export interface GrantAttestationClaims {
  grantId: string;
  userId: string;
  workspaces: string[];
  maxGpusPerSandbox: number;
  expiresAt: Date;
}

/** What issue needs, already clamped by the caller. */
export interface SandboxGrantMaterial {
  grantId: string;
  appRunId: string;
  sessionId: string;
  userId: string;
  userName?: string;
  platformKey: string;
  workspaces: string[];
  limits: AppGrantLimits;
  templates: Array<Record<string, unknown>>;
  roles?: AppSandboxRoles;
  /** When set, this expiry is used instead of now + max_runtime_sec. */
  expiresAt?: Date;
}

export interface BuiltSandboxGrant {
  body: Record<string, unknown>;
  claims: GrantAttestationClaims;
}

/** Signs attestations with the sandbox-grant key. */
export class GrantSigner {
  constructor(private readonly key: KeyObject) {
    if (key.type !== "private" || key.asymmetricKeyType !== "ec") {
      throw new Error("grant signing key must be an EC private key");
    }
  }

  /** ES256 JWT. `exp` is the unix second of `claims.expiresAt`. */
  sign(claims: GrantAttestationClaims, now: Date = new Date()): string {
    const header = b64url(JSON.stringify({ alg: "ES256", kid: GRANT_KID, typ: "JWT" }));
    const payload = b64url(JSON.stringify({
      iss: GRANT_ISSUER,
      aud: GRANT_AUDIENCE,
      jti: claims.grantId,
      sub: claims.userId,
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(claims.expiresAt.getTime() / 1000),
      workspaces: claims.workspaces,
      kinds: ["Sandbox"],
      maxGpusPerSandbox: claims.maxGpusPerSandbox,
    }));
    const input = `${header}.${payload}`;
    const raw = signRaw("sha256", Buffer.from(input), { key: this.key, dsaEncoding: "ieee-p1363" });
    return `${input}.${b64url(raw)}`;
  }
}

/** Load a P-256 PKCS8 PEM. Throws when the PEM is not a signing key. */
export function loadGrantSigner(pem: string): GrantSigner {
  return new GrantSigner(createPrivateKey(pem));
}

/**
 * The signer from `GRANT_SIGNING_KEY_FILE` or `GRANT_SIGNING_KEY`.
 * Absent configuration returns null so a deployment without the key keeps the empty hooks.
 * A configured file that cannot be read throws, so a broken mount fails at startup.
 */
export function loadGrantSignerFromEnv(): GrantSigner | null {
  const file = process.env.GRANT_SIGNING_KEY_FILE?.trim();
  const inline = process.env.GRANT_SIGNING_KEY;
  if (!file && !inline?.trim()) return null;
  const pem = file ? readFileSync(file, "utf8") : inline!;
  return loadGrantSigner(pem);
}

/** Issue returned 200 without keys: the id was already signed and must be discarded. */
export class GrantKeysMissingError extends Error {
  constructor(readonly grantId: string) {
    super(`grant ${grantId} issued without keys`);
    this.name = "GrantKeysMissingError";
  }
}

/** The grant service refused or failed. `code` is its reason, never a key. */
export class GrantHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`grant service answered ${status}${code ? ` ${code}` : ""}`);
    this.name = "GrantHttpError";
  }
}

export type GrantPresence = "active" | "missing" | "revoked";

export interface SandboxGrantClientOptions {
  baseUrl?: string;
  signer: GrantSigner;
  token: () => Promise<string> | string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** HTTP client for issue, get, extend and revoke. */
export class SandboxGrantClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly opts: SandboxGrantClientOptions) {
    this.baseUrl = (opts.baseUrl ?? process.env.AGENT_SANDBOX_GRANT_URL ?? DEFAULT_GRANT_URL).replace(/\/$/, "");
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Sign and create the grant. One transport retry uses the same id.
   * A 200 without keys revokes that id and throws {@link GrantKeysMissingError}.
   */
  async issue(material: SandboxGrantMaterial, signal?: AbortSignal): Promise<{ keys: Record<string, string>; expiresAt: Date }> {
    const built = buildSandboxGrant(material, this.now());
    const body = { ...built.body, attestation: this.opts.signer.sign(built.claims, this.now()) };
    const resp = await this.postRetry(body, signal);
    const keys = keysOf(resp);
    if (!keys) {
      await this.revoke(material.grantId, signal).catch(() => undefined);
      throw new GrantKeysMissingError(material.grantId);
    }
    return { keys, expiresAt: built.claims.expiresAt };
  }

  /** The execution copy. 404 is `missing`. A revoked copy is not re-signed. */
  async inspect(grantId: string, signal?: AbortSignal): Promise<GrantPresence> {
    const resp = await this.send("GET", grantId, undefined, signal);
    if (resp.status === 404) return "missing";
    if (resp.status < 200 || resp.status >= 300) throw new GrantHttpError(resp.status, await errorCode(resp));
    const body = await resp.json().catch(() => null) as { state?: unknown } | null;
    return body?.state === "revoked" ? "revoked" : "active";
  }

  /** Move expiry later. The attestation is re-signed for the new time. */
  async extend(material: SandboxGrantMaterial, expiresAt: Date, signal?: AbortSignal): Promise<{ expiresAt: string }> {
    const at = truncateSeconds(expiresAt);
    if (!(at.getTime() > this.now().getTime())) throw new GrantHttpError(400, "expires_not_later");
    const claims: GrantAttestationClaims = {
      grantId: material.grantId,
      userId: material.userId,
      workspaces: material.workspaces,
      maxGpusPerSandbox: maxCards(wireTemplates(material.templates).templates),
      expiresAt: at,
    };
    const resp = await this.send("PATCH", material.grantId, {
      expiresAt: at.toISOString(),
      attestation: this.opts.signer.sign(claims, this.now()),
    }, signal);
    if (resp.status < 200 || resp.status >= 300) throw new GrantHttpError(resp.status, await errorCode(resp));
    const body = await resp.json().catch(() => null) as { expiresAt?: unknown } | null;
    const answered = typeof body?.expiresAt === "string" ? body.expiresAt : at.toISOString();
    return { expiresAt: answered };
  }

  /** Delete the grant. An unknown id is already done. */
  async revoke(grantId: string, signal?: AbortSignal): Promise<void> {
    const resp = await this.send("DELETE", grantId, undefined, signal);
    if (resp.status === 404 || (resp.status >= 200 && resp.status < 300)) {
      await resp.body?.cancel().catch(() => undefined);
      return;
    }
    throw new GrantHttpError(resp.status, await errorCode(resp));
  }

  /** POST once, and once more on a lost response. An explicit 4xx is not retried. */
  private async postRetry(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let resp: Response;
    try {
      resp = await this.send("POST", "", body, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      resp = await this.send("POST", "", body, signal);
    }
    if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
      await resp.body?.cancel().catch(() => undefined);
      if (signal?.aborted) throw new GrantHttpError(resp.status, "unavailable");
      resp = await this.send("POST", "", body, signal);
    }
    if (resp.status < 200 || resp.status >= 300) throw new GrantHttpError(resp.status, await errorCode(resp));
    return resp.json().catch(() => null);
  }

  private async send(method: string, grantId: string, body: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<Response> {
    const token = await this.opts.token();
    const url = grantId ? `${this.baseUrl}/${encodeURIComponent(grantId)}` : this.baseUrl;
    return this.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  }
}

/** Signer plus client, or null when no signing key is configured. */
export function openSandboxGrantClient(fetchImpl?: typeof fetch): SandboxGrantClient | null {
  const signer = loadGrantSignerFromEnv();
  if (!signer) return null;
  return new SandboxGrantClient({
    signer,
    fetch: fetchImpl,
    token: clusterServiceAccountToken,
  });
}

/** The pod's service-account token, or `GRANT_SERVICE_ACCOUNT_TOKEN` when set. */
export function clusterServiceAccountToken(): string {
  const inline = process.env.GRANT_SERVICE_ACCOUNT_TOKEN?.trim();
  if (inline) return inline;
  return readFileSync(TOKEN_PATH, "utf8").trim();
}

/**
 * The issue body without the attestation. Fails when a role, a cap, a workspace
 * or the platform key is missing: those are refused by the sandbox as a 400.
 */
export function buildSandboxGrant(material: SandboxGrantMaterial, now: Date): BuiltSandboxGrant {
  if (!material.platformKey) throw new Error("platform key is required");
  if (!material.userId) throw new Error("user id is required");
  const workspaces = unique(material.workspaces);
  if (workspaces.length === 0) throw new Error("workspace is required");
  const limits = material.limits ?? {};
  const maxSandboxes = whole(limits.max_sandboxes);
  const maxGpus = whole(limits.max_gpus);
  const runtime = whole(limits.max_runtime_sec);
  if (maxSandboxes === undefined || maxGpus === undefined) throw new Error("grant caps are required");
  if (runtime === undefined || runtime <= 0) throw new Error("max_runtime_sec is required");
  const gpuHours = typeof limits.gpu_hours === "number" && Number.isFinite(limits.gpu_hours) && limits.gpu_hours >= 0
    ? limits.gpu_hours
    : 0;
  const wired = wireTemplates(material.templates);
  const roles = wireRoles(material.roles, wired.names, maxSandboxes, maxGpus);
  const expiresAt = truncateSeconds(material.expiresAt ?? new Date(now.getTime() + runtime * 1000));
  if (!(expiresAt.getTime() > truncateSeconds(now).getTime())) throw new Error("grant expiry is not in the future");
  return {
    claims: {
      grantId: material.grantId,
      userId: material.userId,
      workspaces,
      maxGpusPerSandbox: maxCards(wired.templates),
      expiresAt,
    },
    body: {
      grantId: material.grantId,
      owner: { userId: material.userId, userName: material.userName || material.userId, workspaces },
      platformKey: material.platformKey,
      issuer: { sessionId: material.sessionId, appRunId: material.appRunId },
      roles,
      templates: wired.templates,
      gpuHoursBudget: gpuHours,
      maxSandboxSeconds: runtime,
      expiresAt: expiresAt.toISOString(),
    },
  };
}

/** Workspace ids named by the run and its templates, in a stable order. */
export function grantWorkspaces(
  workspaceId: string | null | undefined,
  sandboxWorkspace: string | null | undefined,
  templates: Array<Record<string, unknown>>,
): string[] {
  const found = [workspaceId, sandboxWorkspace];
  for (const t of templates) if (typeof t.workspace === "string") found.push(t.workspace);
  return unique(found);
}

interface WiredTemplate { name: string; perGpuCount?: number[]; spec?: Record<string, unknown> }

function wireTemplates(templates: Array<Record<string, unknown>>): { templates: WiredTemplate[]; names: Set<string> } {
  const names = new Set<string>();
  const out: WiredTemplate[] = [];
  for (const raw of templates) {
    const name = raw.name;
    if (typeof name !== "string" || !name) throw new Error("template name is required");
    if (names.has(name)) throw new Error(`duplicate template ${name}`);
    names.add(name);
    const perGpuCount = perGpu(raw.per_gpu_count);
    const spec: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === "name" || key === "per_gpu_count" || value === undefined) continue;
      spec[key] = value;
    }
    const tpl: WiredTemplate = { name };
    if (perGpuCount) tpl.perGpuCount = perGpuCount;
    if (Object.keys(spec).length > 0) tpl.spec = spec;
    out.push(tpl);
  }
  return { templates: out, names };
}

function wireRoles(roles: AppSandboxRoles | undefined, names: Set<string>, maxSandboxes: number, maxGpus: number): Record<string, { templates: string[]; maxSandboxes: number; maxGpus: number }> {
  const out: Record<string, { templates: string[]; maxSandboxes: number; maxGpus: number }> = {};
  for (const role of APP_SANDBOX_ROLES) {
    const listed = roles?.[role];
    if (!listed || listed.length === 0) continue;
    if (!ROLES.has(role)) continue;
    for (const name of listed) {
      if (!names.has(name)) throw new Error(`role ${role} names an unknown template ${name}`);
    }
    out[role] = { templates: [...listed], maxSandboxes, maxGpus };
  }
  if (Object.keys(out).length === 0) throw new Error("no sandbox role to issue");
  return out;
}

function perGpu(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error("per_gpu_count must list card counts");
  const nums: number[] = [];
  for (const n of value) {
    const w = whole(n);
    if (w === undefined || w <= 0) throw new Error("per_gpu_count must be positive whole numbers");
    nums.push(w);
  }
  return nums;
}

function maxCards(templates: WiredTemplate[]): number {
  let max = 0;
  for (const t of templates) for (const n of t.perGpuCount ?? []) if (n > max) max = n;
  return max;
}

function whole(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2_147_483_647) return undefined;
  return value;
}

function unique(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const v of values) if (v && !seen.has(v)) seen.add(v);
  return [...seen].sort();
}

function truncateSeconds(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

function keysOf(body: unknown): Record<string, string> | null {
  if (!body || typeof body !== "object") return null;
  const keys = (body as { keys?: unknown }).keys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) return null;
  const out: Partial<Record<AppSandboxRole, string>> = {};
  for (const role of APP_SANDBOX_ROLES) {
    const v = (keys as Record<string, unknown>)[role];
    if (typeof v === "string" && v) out[role] = v;
  }
  return Object.keys(out).length > 0 ? out as Record<string, string> : null;
}

async function errorCode(resp: Response): Promise<string> {
  const body = await resp.json().catch(() => null) as { reason?: unknown; code?: unknown } | null;
  if (typeof body?.reason === "string") return body.reason;
  if (typeof body?.code === "string") return body.code;
  return "";
}

function b64url(value: Buffer | string): string {
  const buf = typeof value === "string" ? Buffer.from(value) : value;
  return buf.toString("base64url");
}
