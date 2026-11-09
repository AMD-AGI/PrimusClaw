/**
 * A GitHub App installation token: an RS256 JWT signed with the App's key, exchanged for a short-lived token scoped to one
 * repository and the permissions asked for, cached until shortly before it expires. A plain token (a file, a secret) can stand
 * in when the App fails. Nothing here is ever logged; an error says only which step failed.
 */

import { createPrivateKey, sign, type KeyObject } from "node:crypto";

import { GITHUB_API, GITHUB_HEADERS, errorName, segment, type FetchLike, type GithubTokenSource } from "./api.js";

/** No usable GitHub credential right now. `code` says why and never carries a secret. */
export class GithubAuthError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "GithubAuthError";
    this.code = code;
  }
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

/** The JWT a GitHub App signs to prove itself (valid 10 minutes at most; iat is back-dated for clock skew). */
export function appJwt(appId: string, keyPem: string | Buffer, nowSeconds: number): string {
  let key: KeyObject;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw new GithubAuthError("key_invalid");
  }
  if (key.asymmetricKeyType !== "rsa") throw new GithubAuthError("key_invalid");
  const now = Math.floor(nowSeconds);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = sign("RSA-SHA256", Buffer.from(`${head}.${claims}`), key);
  return `${head}.${claims}.${b64url(signature)}`;
}

export interface AppTokenOptions {
  readonly appId: string;
  readonly installationId: string;
  /** The App's private key (PEM), read when a token is minted. */
  readonly key: () => Promise<string | Buffer>;
  /** The repository names (without owner) the minted token is limited to. */
  readonly repositories: readonly string[];
  /** The permissions the minted token is limited to, e.g. `{ issues: "write" }`. */
  readonly permissions: Readonly<Record<string, string>>;
  readonly fetch?: FetchLike;
  readonly apiUrl?: string;
  /** Seconds since the epoch. */
  readonly clock?: () => number;
}

const REFRESH_BEFORE_SECONDS = 120;

export class AppTokenSource implements GithubTokenSource {
  private cached: { token: string; expiresAt: number } | undefined;
  private minting: Promise<string> | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly apiUrl: string;
  private readonly clock: () => number;

  constructor(private readonly options: AppTokenOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.apiUrl = (options.apiUrl ?? GITHUB_API).replace(/\/+$/u, "");
    this.clock = options.clock ?? (() => Date.now() / 1000);
  }

  invalidate(): void {
    this.cached = undefined;
  }

  async token(): Promise<string> {
    const now = this.clock();
    if (this.cached !== undefined && this.cached.expiresAt - now > REFRESH_BEFORE_SECONDS) return this.cached.token;
    // (one mint at a time: concurrent callers share it)
    this.minting ??= this.mint(now).finally(() => {
      this.minting = undefined;
    });
    return this.minting;
  }

  private async mint(now: number): Promise<string> {
    let keyPem: string | Buffer;
    try {
      keyPem = await this.options.key();
    } catch {
      throw new GithubAuthError("key_file_unreadable");
    }
    const jwt = appJwt(this.options.appId, keyPem, now);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.apiUrl}/app/installations/${segment(this.options.installationId)}/access_tokens`,
        {
          method: "POST",
          headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
          body: JSON.stringify({ repositories: this.options.repositories, permissions: this.options.permissions }),
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch (err) {
      throw new GithubAuthError(`mint_transport_${errorName(err)}`);
    }
    if (response.status !== 201) throw new GithubAuthError(`mint_${String(response.status)}`);
    const minted = await readMinted(response);
    this.cached = minted;
    return minted.token;
  }
}

async function readMinted(response: Response): Promise<{ token: string; expiresAt: number }> {
  try {
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null) throw new TypeError("not an object");
    const { token, expires_at: expires } = data as Record<string, unknown>;
    const expiresAt = Date.parse(String(expires)) / 1000;
    if (typeof token !== "string" || !token || Number.isNaN(expiresAt)) throw new TypeError("fields");
    return { token, expiresAt };
  } catch {
    throw new GithubAuthError("mint_bad_response");
  }
}

/** A plain token, read when it is used (a mounted file or a secret); an App token first, when there is one. */
export class FallbackTokenSource implements GithubTokenSource {
  private appFailedAt: number | undefined;

  constructor(
    private readonly app: GithubTokenSource | undefined,
    private readonly plain: (() => Promise<string>) | undefined,
    private readonly clock: () => number = () => Date.now() / 1000,
    private readonly appRetrySeconds = 60,
    private readonly onAppFailure: (code: string) => void = () => undefined,
  ) {}

  invalidate(): void {
    this.app?.invalidate();
  }

  async token(): Promise<string> {
    const skipApp =
      this.plain !== undefined &&
      this.appFailedAt !== undefined &&
      this.clock() - this.appFailedAt < this.appRetrySeconds;
    if (this.app !== undefined && !skipApp) {
      try {
        return await this.app.token();
      } catch (err) {
        if (this.plain === undefined || !(err instanceof GithubAuthError)) throw err;
        this.appFailedAt = this.clock();
        this.onAppFailure(err.code);
      }
    }
    if (this.plain === undefined) throw new GithubAuthError("no_credential");
    let token: string;
    try {
      token = (await this.plain()).trim();
    } catch {
      throw new GithubAuthError("token_file_unreadable");
    }
    if (!token) throw new GithubAuthError("token_file_empty");
    return token;
  }
}
