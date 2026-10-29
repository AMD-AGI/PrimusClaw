// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Sign-in state: a 0600 file holding either a development API key or the
 * rotating refresh token of a device grant, and the provider that turns it into
 * the bearer credential each request carries.
 */
import fs from "node:fs";
import path from "node:path";
import { errMessage, isObject, secureUrl } from "./util.js";

export const DEFAULT_CLIENT_ID = "claw-connector";

export interface Credentials {
  v: 1;
  server: string;
  kind: "device" | "key";
  /** A development API key, for `login --key`. */
  key?: string;
  /** Device grant: where to refresh, as whom, and the current (rotating) refresh token. */
  identity_url?: string;
  client_id?: string;
  refresh_token?: string;
  device_name?: string;
  saved_at: string;
}

export class CredentialsError extends Error {}
/** The identity service says the grant is gone: stop, do not retry. */
export class GrantRevokedError extends Error {
  constructor(message = "the sign-in was revoked") { super(message); }
}
/** The identity service could not be asked (network, 5xx): retry later. */
export class TransientAuthError extends Error {}

export function loadCredentials(file: string): Credentials | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let text: string;
  try {
    // The mode is read from the very file that is then read (one descriptor), not from a path that could be swapped in between.
    const st = fs.fstatSync(fd);
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      throw new CredentialsError(`${file} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${file}`);
    }
    text = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new CredentialsError(`${file} is not valid JSON (${errMessage(e)})`);
  }
  if (!isObject(raw) || raw.v !== 1 || typeof raw.server !== "string" || (raw.kind !== "device" && raw.kind !== "key")) {
    throw new CredentialsError(`${file} is not a sign-in file written by this program; run login again`);
  }
  return raw as unknown as Credentials;
}

export function saveCredentials(file: string, creds: Credentials): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export interface TokenProvider {
  /** The value for `Authorization: Bearer`. */
  bearer(): Promise<string>;
  /** The server refused the last one: get a fresh one next time. */
  invalidate(): void;
}

export class KeyTokenProvider implements TokenProvider {
  constructor(private readonly key: string) {}
  async bearer(): Promise<string> { return this.key; }
  invalidate(): void {}
}

export interface TokenResponse { access_token: string; expires_in: number; refresh_token?: string }

export function parseTokenResponse(body: unknown): TokenResponse | null {
  if (!isObject(body) || typeof body.access_token !== "string" || !body.access_token) return null;
  const expires = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 300;
  return {
    access_token: body.access_token, expires_in: expires,
    refresh_token: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : undefined,
  };
}

export interface DeviceProviderOptions {
  creds: Credentials;
  save: (c: Credentials) => void;
  fetch?: typeof fetch;
  now?: () => number;
  /** Refresh this long before the access token expires. */
  skewMs?: number;
  /** A token fetched at login, so the first request needs no refresh. */
  initial?: TokenResponse;
}

export class DeviceTokenProvider implements TokenProvider {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private readonly skew: number;
  private creds: Credentials;

  constructor(private readonly opts: DeviceProviderOptions) {
    this.f = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.skew = opts.skewMs ?? 60_000;
    this.creds = opts.creds;
    if (opts.initial) {
      this.token = opts.initial.access_token;
      this.expiresAt = this.now() + opts.initial.expires_in * 1000;
    }
  }

  async bearer(): Promise<string> {
    if (this.token && this.now() < this.expiresAt - this.skew) return this.token;
    return this.refresh();
  }

  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  /** One refresh at a time; the refresh token rotates, so two in flight would revoke the grant. */
  private refresh(): Promise<string> {
    this.inflight ??= this.doRefresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async doRefresh(): Promise<string> {
    const c = this.creds;
    if (!c.identity_url || !c.refresh_token) throw new CredentialsError("the sign-in file has no refresh token; run login again");
    const identity = secureUrl(c.identity_url, "the identity service URL");
    let res: Response;
    try {
      res = await this.f(`${identity}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: c.client_id ?? DEFAULT_CLIENT_ID }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new TransientAuthError(`could not reach the identity service: ${errMessage(e)}`);
    }
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 400 || res.status === 401) {
      const err = isObject(body) ? body.error : undefined;
      if (err === "invalid_grant" || err === "invalid_client" || err === "unauthorized_client") throw new GrantRevokedError(`the identity service refused the refresh token (${String(err)})`);
    }
    const parsed = res.ok ? parseTokenResponse(body) : null;
    if (!parsed) throw new TransientAuthError(`the identity service answered ${res.status} to a refresh`);
    // The old refresh token is dead the moment the server answers: keep the new one before anything else.
    if (parsed.refresh_token) {
      this.creds = { ...c, refresh_token: parsed.refresh_token, saved_at: new Date(this.now()).toISOString() };
      this.opts.save(this.creds);
    }
    this.token = parsed.access_token;
    this.expiresAt = this.now() + parsed.expires_in * 1000;
    return this.token;
  }
}

export function providerFor(creds: Credentials, save: (c: Credentials) => void, extra: Partial<DeviceProviderOptions> = {}): TokenProvider {
  if (creds.kind === "key") {
    if (!creds.key) throw new CredentialsError("the sign-in file has no key; run login again");
    return new KeyTokenProvider(creds.key);
  }
  return new DeviceTokenProvider({ creds, save, ...extra });
}
