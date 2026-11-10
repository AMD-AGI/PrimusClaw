// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The shared GitHub REST client of the worker: one place that knows GitHub's base URL, headers and how a token is used. The
 * review service reads public pull requests through it with no credential; feedback files issues with a GitHub App installation
 * token (`app-token.ts`). Nothing here ever logs or keeps a response body: an error carries a status and a code only.
 */

import { pyRstrip } from "@primusclaw/personal-agent";

export const GITHUB_API = "https://api.github.com";

export const GITHUB_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "primusclaw-teams-agent",
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** GitHub refused, or could not be reached (status 0). `code` never carries a body or a secret. */
export class GithubApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code = "") {
    const resolved = code || `github_${String(status)}`;
    super(resolved);
    this.name = "GithubApiError";
    this.status = status;
    this.code = resolved;
  }
}

/** Where the token of an authenticated call comes from. */
export interface GithubTokenSource {
  token(): Promise<string>;
  /** A token the server no longer accepts: the next `token()` mints or reads a new one. */
  invalidate(): void;
}

export interface GithubRequest {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** The path under the API root, starting with "/" (query included). */
  readonly path: string;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export interface GithubApiOptions {
  readonly fetch?: FetchLike;
  readonly apiUrl?: string;
  /** None: calls are anonymous (public reads only). */
  readonly tokens?: GithubTokenSource;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class GithubApi {
  readonly apiUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly tokens: GithubTokenSource | undefined;
  private readonly timeoutMs: number;

  constructor(options: GithubApiOptions = {}) {
    this.apiUrl = pyRstrip(options.apiUrl ?? GITHUB_API, "/");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.tokens = options.tokens;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * One call. With a token source, a 401 invalidates the cached token and the call is made once more with a fresh one. A
   * transport failure is GithubApiError(0, "transport_<name>"); any HTTP answer is returned to the caller to read.
   */
  async request(request: GithubRequest): Promise<Response> {
    for (const attempt of [0, 1]) {
      const response = await this.once(request);
      if (response.status === 401 && attempt === 0 && this.tokens !== undefined) {
        this.tokens.invalidate();
        continue;
      }
      return response;
    }
    throw new GithubApiError(0, "unreachable");
  }

  private async once(request: GithubRequest): Promise<Response> {
    const headers: Record<string, string> = { ...GITHUB_HEADERS };
    if (this.tokens !== undefined) headers.Authorization = `Bearer ${await this.tokens.token()}`;
    const init: RequestInit = {
      method: request.method,
      headers,
      signal: AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs),
    };
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(request.body);
    }
    try {
      return await this.fetchImpl(`${this.apiUrl}${request.path}`, init);
    } catch (err) {
      throw new GithubApiError(0, `transport_${errorName(err)}`);
    }
  }
}

export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}

/** A path segment as GitHub's URLs take it (`quote(x, safe='')`). */
export function segment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
