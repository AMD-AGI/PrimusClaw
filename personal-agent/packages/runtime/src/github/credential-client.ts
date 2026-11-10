// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The identity service's `/oauth/external-credentials` calls, made as the worker's service client for a person it holds a
 * binding for (the same client and the same `external:<issuer>|<directory id>` reference as the token exchange). A person
 * with no binding is `not_bound`. Nothing of an answer is kept but its fields: a request that carries a token must not be
 * able to put it in a log line.
 */

import {
  type CredentialFailure,
  type GithubCredentials,
  type GithubState,
  type Result,
  credentialRefused,
  err,
  ok,
  pyRstrip,
} from "@primusclaw/personal-agent";
import { z } from "zod";

import { errorName, type FetchLike } from "./api.js";

const PROVIDER = "github";

const item = z
  .object({
    providerLogin: z.unknown().optional(),
    scopes: z.unknown().optional(),
    expiresAt: z.unknown().optional(),
    expired: z.unknown().optional(),
    delegation: z.unknown().optional(),
    lastUsedAt: z.unknown().optional(),
  })
  .loose();
const answer = z
  .object({
    user_id: z.unknown().optional(),
    item: z.unknown().optional(),
    bound: z.unknown().optional(),
    unbound: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .loose();

type Answer = z.infer<typeof answer>;

/** `str(value or "")`, for the few text fields read. */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof value === "number" && value !== 0 ? String(value) : "";
}

export function stateOf(data: Answer): GithubState {
  const userId = text(data.user_id);
  const parsed = item.safeParse(data.item);
  const none: GithubState = {
    userId,
    bound: false,
    login: "",
    scopes: [],
    expiresAt: "",
    expired: false,
    delegation: false,
    lastUsedAt: "",
  };
  if (!parsed.success || data.bound === false) return none;
  const it = parsed.data;
  return {
    userId,
    bound: true,
    login: text(it.providerLogin),
    scopes: Array.isArray(it.scopes) ? it.scopes.map((s) => (typeof s === "string" ? s : JSON.stringify(s))) : [],
    expiresAt: text(it.expiresAt),
    expired: it.expired === true,
    delegation: it.delegation === true,
    lastUsedAt: text(it.lastUsedAt),
  };
}

export interface CredentialClientOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly issuer: string;
  readonly fetch?: FetchLike;
}

export class IdentityCredentialClient implements GithubCredentials {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: CredentialClientOptions) {
    this.base = pyRstrip(options.baseUrl, "/");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private async call(
    action: string,
    userId: string,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<Result<Answer, CredentialFailure>> {
    const body = { user: `external:${this.options.issuer}|${userId}`, provider: PROVIDER, ...extra };
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${basic}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      // (the request holds a token: only the error's type)
      return err(credentialRefused(0, errorName(error)));
    }
    let data: Answer = {};
    try {
      const parsed = answer.safeParse(await response.json());
      if (parsed.success) data = parsed.data;
    } catch {
      data = {};
    }
    const code = text(data.error).slice(0, 40);
    if (response.status === 400 && code === "invalid_grant") return err({ kind: "not_bound" });
    if (response.status !== 200) return err(credentialRefused(response.status, code));
    return ok(data);
  }

  async status(userId: string): Promise<Result<GithubState, CredentialFailure>> {
    const data = await this.call("status", userId);
    return data.ok ? ok(stateOf(data.value)) : data;
  }

  async bind(userId: string, token: string): Promise<Result<GithubState, CredentialFailure>> {
    const data = await this.call("bind", userId, { token });
    return data.ok ? ok(stateOf(data.value)) : data;
  }

  async unbind(userId: string): Promise<Result<boolean, CredentialFailure>> {
    const data = await this.call("unbind", userId);
    return data.ok ? ok(data.value.unbound === true) : data;
  }

  async setDelegation(userId: string, enabled: boolean): Promise<Result<GithubState, CredentialFailure>> {
    const data = await this.call("delegation", userId, { enabled });
    return data.ok ? ok(stateOf(data.value)) : data;
  }
}
