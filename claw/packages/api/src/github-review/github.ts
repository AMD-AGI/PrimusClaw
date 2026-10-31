// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A small GitHub client for one acting user's token and one tool call.
 *
 * The token lives in a private field: it is not an enumerable property, so a
 * log line, a JSON dump or an error built from this object cannot carry it, and
 * every message that comes back from GitHub is redacted with it before it leaves
 * this file. The base address is fixed by configuration and every path is built
 * from a validated owner, repository and number, so a caller cannot aim the token
 * at another host.
 *
 * Reads are not retried here and writes never are: whether to try again is the
 * caller's decision, and a write that may have landed is checked for first.
 */
import { redactSecrets } from "@claw/utils";

export class GithubError extends Error {
  readonly status: number;
  readonly requestId: string;
  readonly rateLimited: boolean;
  readonly retryAfterSeconds?: number;

  constructor(status: number, message: string, requestId: string, rateLimited = false, retryAfterSeconds?: number) {
    super(`GitHub answered ${status}: ${message}`);
    this.name = "GithubError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = status;
    this.requestId = requestId;
    this.rateLimited = rateLimited;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface GithubClientOptions {
  token: string;
  apiUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export interface GithubAnswer<T = unknown> {
  status: number;
  requestId: string;
  json: T;
  text: string;
  headers: Headers;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/** `https://github.com/o/r/pull/N` or `o/r#N`, or null. Nothing else names a pull request. */
export function parsePrRef(input: unknown): PrRef | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  let owner: string | undefined;
  let repo: string | undefined;
  let num: string | undefined;
  const short = /^([^/\s#]+)\/([^/\s#]+)#(\d{1,9})$/.exec(text);
  if (short) {
    [, owner, repo, num] = short;
  } else {
    let u: URL;
    try { u = new URL(text); } catch { return null; }
    if (u.protocol !== "https:" || u.hostname.toLowerCase() !== "github.com" || u.username || u.password || u.port) return null;
    const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d{1,9})(?:\/.*)?$/.exec(u.pathname);
    if (!m) return null;
    [, owner, repo, num] = m;
  }
  if (!owner || !repo || !num || !OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") return null;
  const n = Number(num);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return { owner, repo, number: n };
}

async function readCapped(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new GithubError(502, "response too large", resp.headers.get("x-github-request-id") ?? "");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class GithubClient {
  readonly #token: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  /** Requests made, and the ids GitHub gave them, for the audit row. */
  requests = 0;
  readonly requestIds: string[] = [];
  lastStatus = 0;

  constructor(opts: GithubClientOptions) {
    if (!opts.token) throw new TypeError("a token is required");
    this.#token = opts.token;
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxBodyBytes = opts.maxBodyBytes ?? 8 * 1024 * 1024;
  }

  /** The token must not appear in what a caller prints. */
  toJSON(): Record<string, never> { return {}; }
  toString(): string { return "[GithubClient]"; }

  redact(text: string): string {
    return redactSecrets(text, [this.#token]).text;
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT",
    path: string,
    opts: { query?: Record<string, string | number>; body?: unknown; accept?: string; allow?: number[] } = {},
  ): Promise<GithubAnswer<T>> {
    if (!path.startsWith("/")) throw new TypeError("path must start with /");
    const url = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      Accept: opts.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "primus-claw-github-review",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    this.requests += 1;
    let resp: Response;
    let text: string;
    try {
      resp = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await readCapped(resp, this.maxBodyBytes);
    } catch (err) {
      if (err instanceof GithubError) throw err;
      // The cause can name the url, which never holds the token, but it is passed through the same redaction.
      throw new GithubError(0, this.redact((err as Error)?.message ?? "request failed").slice(0, 200), "");
    }
    const requestId = resp.headers.get("x-github-request-id") ?? "";
    this.lastStatus = resp.status;
    if (requestId) this.requestIds.push(requestId);
    const allowed = resp.ok || (opts.allow ?? []).includes(resp.status);
    if (!allowed) {
      let message = "";
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed.message === "string") message = parsed.message;
      } catch { message = ""; }
      const retry = Number(resp.headers.get("retry-after"));
      const limited = resp.status === 429
        || (resp.status === 403 && (resp.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message)));
      throw new GithubError(
        resp.status, this.redact(message || resp.statusText || "error").slice(0, 300), requestId, limited,
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
      );
    }
    let json: unknown = null;
    if ((resp.headers.get("content-type") ?? "").includes("json") && text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status: resp.status, requestId, json: json as T, text, headers: resp.headers };
  }

  async get<T = unknown>(path: string, query?: Record<string, string | number>, allow?: number[]): Promise<GithubAnswer<T>> {
    return this.request<T>("GET", path, { query, allow });
  }

  async getText(path: string, accept: string, query?: Record<string, string | number>): Promise<GithubAnswer<null>> {
    return this.request<null>("GET", path, { query, accept });
  }

  async graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    const answer = await this.request<{ data?: T; errors?: Array<{ message?: string }> }>("POST", "/graphql", { body: { query, variables } });
    const body = answer.json;
    if (!body || body.errors?.length || body.data === undefined) {
      const msg = this.redact(body?.errors?.[0]?.message ?? "no data").slice(0, 200);
      throw new GithubError(502, `GraphQL: ${msg}`, answer.requestId);
    }
    return body.data;
  }
}

export function repoPath(ref: Pick<PrRef, "owner" | "repo">, suffix = ""): string {
  return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}${suffix}`;
}
