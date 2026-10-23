// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Issue, inject, extend, and revoke the grant for one app run.
 *
 * A retry of the same app run keeps the grant id and the stored keys.
 * A takeover asks the execution copy once. A missing copy is reissued only
 * while the app sandbox is still running. A revoked copy is not reissued.
 * A failed extend leaves the stored expiry unchanged.
 */
import { inTransaction, type Querier } from "../infra/db.js";
import { decryptUserEnvValue, encryptUserEnvValue } from "../crypto/user-env.js";
import { atSecond, newGrantId, signAttestation } from "./attestation.js";
import { computeCaps, parsePlatformCaps, type GrantCaps, type GrantRequest } from "./caps.js";
import { GrantClientError, grantCallerFromEnv, type GrantCaller, type GrantTemplateBody, type IssueGrantBody } from "./client.js";
import { grantEnv } from "./env.js";
import { insertPending, lockGrant, markActive, markExtended, markRevoked, type StoredClaims } from "./store.js";

export interface AppRunTemplate {
  name: string;
  perGpuCount?: number[];
  spec?: unknown;
  roles?: string[];
}

/** Resources Claw reads. input is the application's own document and is not read here. */
export interface AppRunResources {
  image?: string;
  cpu?: string;
  memory?: string;
  gpus?: number;
  workspace?: string;
  grant?: GrantRequest;
  templates?: AppRunTemplate[];
}

export interface OpenAppRunInput {
  appRunId: string;
  userId: string;
  userName: string;
  workspaces: string[];
  platformKey: string;
  sessionId: string;
  /** Passed through to the application. Caps are not taken from this object. */
  input?: unknown;
  resources?: AppRunResources;
  kinds?: string[];
  startAt?: Date;
}

export interface OpenAppRunResult {
  grantId: string;
  expiresAt: string;
  reused: boolean;
  env: Record<string, string>;
}

export interface ReconcileResult {
  action: "leave" | "keep" | "reissued";
  reason?: "run_ended" | "revoked" | "inactive" | "copy_unavailable" | "no_grant";
  grantId?: string;
  expiresAt?: string;
  env?: Record<string, string>;
}

export interface GrantRuntime {
  now: () => Date;
  sign: typeof signAttestation;
  caller: () => GrantCaller;
  seal: (plain: string) => string;
  open: (sealed: string) => string;
  apiUrl: string;
  sandboxUrl: string;
  platformCapsRaw: string;
}

const DEFAULT_KINDS = ["PyTorchJob", "Sandbox"];

/** Production wiring. Signing and the grant URL are read when a call runs. */
export function runtimeFromEnv(env: NodeJS.ProcessEnv = process.env): GrantRuntime {
  const apiUrl = env.E2B_API_URL?.trim() || "";
  const sandboxUrl = env.E2B_SANDBOX_URL?.trim() || "";
  return {
    now: () => new Date(),
    sign: (claims) => signAttestation(claims, env),
    caller: () => grantCallerFromEnv(env),
    seal: encryptUserEnvValue,
    open: decryptUserEnvValue,
    apiUrl,
    sandboxUrl,
    platformCapsRaw: env.APP_SANDBOX_CAPS || "",
  };
}

type Transact = <T>(run: (query: Querier) => Promise<T>) => Promise<T>;

/** Issue a grant, or return the one already stored for this app run. */
export async function openAppRunGrant(
  input: OpenAppRunInput,
  rt: GrantRuntime = runtimeFromEnv(),
  transact: Transact = inTransaction,
): Promise<OpenAppRunResult> {
  requireUrls(rt);
  validateOpen(input);
  return transact((query) => openLocked(query, input, rt));
}

/** Return the stored grant for injection. Does not issue a new one. */
export async function readAppRunGrant(
  appRunId: string,
  rt: GrantRuntime = runtimeFromEnv(),
  transact: Transact = inTransaction,
): Promise<OpenAppRunResult> {
  requireUrls(rt);
  return transact(async (query) => {
    const row = await lockGrant(query, appRunId);
    if (!row || row.state !== "active" || !row.keysCiphertext) {
      throw new GrantClientError(404, "grant_not_found", "app run has no active grant");
    }
    return resultOf(row.grantId, row.expiresAt, true, rt.open(row.keysCiphertext), rt, row.claims.grantLimits);
  });
}

/**
 * Decide what a takeover does with the grant.
 * An ended app sandbox is left alone. A missing execution copy is reissued
 * only while that sandbox is still running. Timeouts and 503 keep the old grant.
 */
export async function reconcileAppRunGrant(
  input: OpenAppRunInput & { runEnded: boolean },
  rt: GrantRuntime = runtimeFromEnv(),
  transact: Transact = inTransaction,
): Promise<ReconcileResult> {
  if (input.runEnded) return { action: "leave", reason: "run_ended" };
  requireUrls(rt);
  return transact(async (query) => {
    try {
      return await reconcileLocked(query, input, rt);
    } catch (err) {
      if (copyUnavailable(err)) return { action: "leave", reason: "copy_unavailable" };
      throw err;
    }
  });
}

/** Push the grant expiry later and store the new attestation. A failure leaves the previous expiry. */
export async function extendAppRunGrant(
  appRunId: string,
  expiresAt: Date,
  rt: GrantRuntime = runtimeFromEnv(),
  transact: Transact = inTransaction,
): Promise<OpenAppRunResult> {
  requireUrls(rt);
  const expiry = atSecond(expiresAt);
  return transact(async (query) => {
    const row = await lockGrant(query, appRunId);
    if (!row || row.state !== "active" || !row.keysCiphertext) {
      throw new GrantClientError(404, "grant_not_found", "app run has no active grant");
    }
    if (expiry.getTime() <= row.expiresAt.getTime()) {
      throw new GrantClientError(400, "invalid_grant", "expiresAt must move later");
    }
    const attestation = rt.sign({
      grantId: row.grantId,
      userId: row.claims.userId,
      workspaces: row.claims.workspaces,
      kinds: row.claims.kinds,
      maxGpusPerSandbox: row.claims.maxGpusPerSandbox,
      expiresAt: expiry,
      issuedAt: rt.now(),
    });
    await rt.caller().extend(row.grantId, { expiresAt: expiry.toISOString(), attestation });
    await markExtended(query, appRunId, expiry, attestation);
    return resultOf(row.grantId, expiry, true, rt.open(row.keysCiphertext), rt, row.claims.grantLimits);
  });
}

/** Revoke the grant and drop the stored keys. A second call is a no-op. */
export async function revokeAppRunGrant(
  appRunId: string,
  rt: GrantRuntime = runtimeFromEnv(),
  transact: Transact = inTransaction,
): Promise<void> {
  await transact(async (query) => {
    const row = await lockGrant(query, appRunId);
    if (!row || row.state === "revoked") return;
    if (row.state === "active" || row.grantId) {
      await rt.caller().revoke(row.grantId);
    }
    await markRevoked(query, appRunId);
  });
}

async function reconcileLocked(query: Querier, input: OpenAppRunInput, rt: GrantRuntime): Promise<ReconcileResult> {
  const existing = await lockGrant(query, input.appRunId);
  if (!existing || existing.state !== "active" || !existing.keysCiphertext) {
    return { action: "leave", reason: existing?.state === "revoked" ? "revoked" : "no_grant" };
  }
  const copy = await rt.caller().get(existing.grantId);
  if (!copy) {
    validateOpen(input);
    const built = buildIssue(input, rt, newGrantId());
    const issued = await issueOrReplace(query, input, rt, built);
    return {
      action: "reissued",
      grantId: issued.grantId,
      expiresAt: issued.expiresAt.toISOString(),
      env: grantEnv({ apiUrl: rt.apiUrl, sandboxUrl: rt.sandboxUrl, keys: issued.keys, limits: built.claims.grantLimits }),
    };
  }
  if (copy.state === "active") {
    return {
      action: "keep",
      grantId: existing.grantId,
      expiresAt: existing.expiresAt.toISOString(),
      env: grantEnv({
        apiUrl: rt.apiUrl,
        sandboxUrl: rt.sandboxUrl,
        keys: JSON.parse(rt.open(existing.keysCiphertext)) as Record<string, string>,
        limits: existing.claims.grantLimits,
      }),
    };
  }
  return { action: "leave", reason: copy.state === "revoked" ? "revoked" : "inactive" };
}

/** Reuse stored keys when the copy is active or the check itself failed. Null means the copy is gone. */
async function keptCopy(
  grantId: string,
  expiresAt: Date,
  keysCiphertext: string,
  limits: GrantRequest | undefined,
  rt: GrantRuntime,
): Promise<OpenAppRunResult | null> {
  try {
    const copy = await rt.caller().get(grantId);
    if (!copy) return null;
    return resultOf(grantId, expiresAt, true, rt.open(keysCiphertext), rt, limits);
  } catch (err) {
    if (copyUnavailable(err)) return resultOf(grantId, expiresAt, true, rt.open(keysCiphertext), rt, limits);
    throw err;
  }
}

function copyUnavailable(err: unknown): boolean {
  if (err instanceof GrantClientError) {
    return err.status === 408 || (err.status >= 502 && err.status <= 504);
  }
  return err instanceof Error && (err.name === "AbortError" || err.name === "TypeError");
}

async function openLocked(query: Querier, input: OpenAppRunInput, rt: GrantRuntime): Promise<OpenAppRunResult> {
  const existing = await lockGrant(query, input.appRunId);
  if (existing?.state === "active" && existing.keysCiphertext) {
    const kept = await keptCopy(existing.grantId, existing.expiresAt, existing.keysCiphertext, existing.claims.grantLimits, rt);
    if (kept) return kept;
  }
  const built = buildIssue(input, rt, existing?.state === "pending" ? existing.grantId : newGrantId());
  if (!existing) {
    await insertPending(query, {
      appRunId: input.appRunId,
      grantId: built.grantId,
      claims: built.claims,
      expiresAt: built.expiresAt,
    });
  }
  const issued = await issueOrReplace(query, input, rt, built);
  return resultOf(issued.grantId, issued.expiresAt, false, issued.keys, rt, built.claims.grantLimits);
}

async function issueOrReplace(
  query: Querier,
  input: OpenAppRunInput,
  rt: GrantRuntime,
  built: BuiltIssue,
): Promise<{ grantId: string; expiresAt: Date; keys: Record<string, string> }> {
  const caller = rt.caller();
  const first = await caller.issue(built.body);
  if (first.keys) {
    return storeIssued(query, caller, input.appRunId, rt, built, built.grantId, built.body.attestation, first.keys);
  }
  await caller.revoke(built.grantId).catch(() => undefined);
  const grantId = newGrantId();
  const attestation = resign(rt, built, grantId);
  const second = await caller.issue({ ...built.body, grantId, attestation });
  if (!second.keys) {
    throw new GrantClientError(502, "grant_keys_missing", "grant issue did not return keys");
  }
  return storeIssued(query, caller, input.appRunId, rt, built, grantId, attestation, second.keys);
}

async function storeIssued(
  query: Querier,
  caller: GrantCaller,
  appRunId: string,
  rt: GrantRuntime,
  built: BuiltIssue,
  grantId: string,
  attestation: string,
  keys: Record<string, string>,
): Promise<{ grantId: string; expiresAt: Date; keys: Record<string, string> }> {
  try {
    await markActive(query, appRunId, {
      grantId,
      expiresAt: built.expiresAt,
      keysCiphertext: rt.seal(JSON.stringify(keys)),
      attestation,
      claims: { ...built.claims },
    });
  } catch (err) {
    await caller.revoke(grantId).catch(() => undefined);
    throw err;
  }
  return { grantId, expiresAt: built.expiresAt, keys };
}

interface BuiltIssue {
  grantId: string;
  expiresAt: Date;
  claims: StoredClaims;
  body: IssueGrantBody;
  kinds: string[];
  maxGpusPerSandbox: number;
}

function buildIssue(input: OpenAppRunInput, rt: GrantRuntime, grantId: string): BuiltIssue {
  const templates = input.resources?.templates ?? [];
  const counts = templates.flatMap((tpl) => tpl.perGpuCount ?? []);
  const caps = computeCaps(
    input.resources?.grant ?? {},
    parsePlatformCaps(rt.platformCapsRaw),
    atSecond(input.startAt ?? rt.now()),
    counts,
  );
  const expiresAt = atSecond(caps.expiresAt);
  const kinds = input.kinds?.length ? input.kinds : DEFAULT_KINDS;
  const claims: StoredClaims = {
    userId: input.userId,
    userName: input.userName,
    workspaces: input.workspaces,
    sessionId: input.sessionId,
    kinds,
    maxGpusPerSandbox: caps.maxGpusPerSandbox,
    grantLimits: issuedLimits(caps),
  };
  const attestation = rt.sign({
    grantId,
    userId: input.userId,
    workspaces: input.workspaces,
    kinds,
    maxGpusPerSandbox: caps.maxGpusPerSandbox,
    expiresAt,
    issuedAt: rt.now(),
  });
  const roles = {
    measurement: { templates: namesFor(templates, "measurement"), ...caps.roles.measurement },
    subrun: { templates: namesFor(templates, "subrun"), ...caps.roles.subrun },
    dev: { templates: namesFor(templates, "dev"), ...caps.roles.dev },
  };
  return {
    grantId,
    expiresAt,
    claims,
    kinds,
    maxGpusPerSandbox: caps.maxGpusPerSandbox,
    body: {
      grantId,
      owner: { userId: input.userId, userName: input.userName, workspaces: input.workspaces },
      platformKey: input.platformKey,
      issuer: { sessionId: input.sessionId, appRunId: input.appRunId },
      roles,
      templates: templates.map(templateBody),
      gpuHoursBudget: caps.gpuHoursBudget,
      maxSandboxSeconds: caps.maxSandboxSeconds,
      expiresAt: expiresAt.toISOString(),
      attestation,
    },
  };
}

function resign(rt: GrantRuntime, built: BuiltIssue, grantId: string): string {
  return rt.sign({
    grantId,
    userId: built.claims.userId,
    workspaces: built.claims.workspaces,
    kinds: built.kinds,
    maxGpusPerSandbox: built.maxGpusPerSandbox,
    expiresAt: built.expiresAt,
    issuedAt: rt.now(),
  });
}

function namesFor(templates: AppRunTemplate[], role: string): string[] {
  return templates.filter((tpl) => !tpl.roles || tpl.roles.includes(role)).map((tpl) => tpl.name);
}

function templateBody(tpl: AppRunTemplate): GrantTemplateBody {
  return { name: tpl.name, perGpuCount: tpl.perGpuCount, spec: tpl.spec };
}

function issuedLimits(caps: GrantCaps): GrantRequest {
  return {
    roles: {
      measurement: { max_sandboxes: caps.roles.measurement.maxSandboxes, max_gpus: caps.roles.measurement.maxGpus },
      subrun: { max_sandboxes: caps.roles.subrun.maxSandboxes, max_gpus: caps.roles.subrun.maxGpus },
      dev: { max_sandboxes: caps.roles.dev.maxSandboxes, max_gpus: caps.roles.dev.maxGpus },
    },
    gpu_hours: caps.gpuHoursBudget,
    max_runtime_sec: caps.maxSandboxSeconds,
  };
}

function resultOf(
  grantId: string,
  expiresAt: Date,
  reused: boolean,
  keysJson: string | Record<string, string>,
  rt: GrantRuntime,
  limits?: GrantRequest,
): OpenAppRunResult {
  const keys = typeof keysJson === "string" ? JSON.parse(keysJson) as Record<string, string> : keysJson;
  return {
    grantId,
    expiresAt: expiresAt.toISOString(),
    reused,
    env: grantEnv({ apiUrl: rt.apiUrl, sandboxUrl: rt.sandboxUrl, keys, limits }),
  };
}

function requireUrls(rt: GrantRuntime): void {
  if (!rt.apiUrl || !rt.sandboxUrl) {
    throw new GrantClientError(503, "grant_urls_missing", "E2B_API_URL and E2B_SANDBOX_URL are required");
  }
}

function validateOpen(input: OpenAppRunInput): void {
  const workspace = input.resources?.workspace;
  if (workspace && input.workspaces.length === 0) input.workspaces = [workspace];
  if (!input.appRunId || !input.userId || !input.platformKey || input.workspaces.length === 0) {
    throw new GrantClientError(400, "invalid_grant", "appRunId, userId, platformKey, and workspaces are required");
  }
}
