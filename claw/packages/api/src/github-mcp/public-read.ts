// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A read-only GitHub App of the deployment's own, for reads of public repositories made for a person with no GitHub here.
 *
 * Such a read was made with no credential at all, and GitHub allows 60 of those an hour for the deployment's whole address: once they
 * were used up every read failed (parity 2026-11-09, G3 and H2: `pr_state_read_failed status=403`). An installation token of an App
 * raises that to the App's own allowance. Each token is narrowed when it is made, whatever the App itself may do: it is asked for
 * with `metadata: read` alone (which reads any public repository and writes nothing), and, when `CLAW_GITHUB_PUBLIC_READ_REPOSITORIES`
 * names them, for those of the installation's repositories alone. What GitHub grants is then checked: a token whose permissions are
 * not exactly `metadata: read`, or that reaches a repository GitHub does not say is public, is revoked, logged and not used.
 * A person who has GitHub here is still read for as themselves (`resolveGithubToken`); this is never their credential.
 *
 *   CLAW_GITHUB_PUBLIC_READ_APP_ID           the App's id
 *   CLAW_GITHUB_PUBLIC_READ_INSTALLATION_ID  the id of its installation (on a public repository or an account with only public ones)
 *   CLAW_GITHUB_PUBLIC_READ_KEY_FILE         the App's private key (PEM), read when a token is made, so a rotated key is picked up
 *   CLAW_GITHUB_PUBLIC_READ_REPOSITORIES     optional: comma-separated names of the installation's (public) repositories a token is
 *                                            limited to; a token still reads every public repository, as any GitHub token does
 *
 * The first three all, or none: with none, such reads stay anonymous.
 */
import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import pino from "pino";

const logger = pino({ name: "github-public-read" });

/** A token is made again this long before GitHub says it expires (an hour after it was made). */
const RENEW_BEFORE_MS = 5 * 60_000;
const MINT_TIMEOUT_MS = 5_000;
/** The only permission asked for, and the only one a token may come back with. */
const PERMISSIONS = { metadata: "read" } as const;

export interface PublicReadSettings {
  appId: string;
  installationId: string;
  keyFile: string;
  /** Names of the installation's repositories a token is limited to; empty: not limited by name. */
  repositories?: string[];
}

type Env = Readonly<Record<string, string | undefined>>;
const NAMES = ["CLAW_GITHUB_PUBLIC_READ_APP_ID", "CLAW_GITHUB_PUBLIC_READ_INSTALLATION_ID", "CLAW_GITHUB_PUBLIC_READ_KEY_FILE"] as const;
const REPOSITORIES = "CLAW_GITHUB_PUBLIC_READ_REPOSITORIES";
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const repositoriesOf = (env: Env): string[] => (env[REPOSITORIES] ?? "").split(",").map((r) => r.trim()).filter(Boolean);

/** The App, when all three are set; null when none is (or the set is incomplete: `publicReadConfigErrors` refuses that at start). */
export function readPublicReadSettings(env: Env = process.env): PublicReadSettings | null {
  const [appId, installationId, keyFile] = NAMES.map((n) => (env[n] ?? "").trim());
  if (!(appId && installationId && keyFile)) return null;
  const repositories = repositoriesOf(env);
  return repositories.length ? { appId, installationId, keyFile, repositories } : { appId, installationId, keyFile };
}

/** What is wrong with the App's settings, as sentences: some of them set and not all, an id that is not a number, a key not readable. */
export function publicReadConfigErrors(env: Env = process.env, readKey: (file: string) => string = (f) => readFileSync(f, "utf8")): string[] {
  const set = NAMES.filter((n) => (env[n] ?? "").trim());
  if (!set.length) return repositoriesOf(env).length ? [`${REPOSITORIES} is set without ${NAMES.join(", ")}`] : [];
  if (set.length < NAMES.length) return [`${NAMES.filter((n) => !set.includes(n)).join(", ")} must be set with ${set.join(", ")}`];
  const s = readPublicReadSettings(env)!;
  const errors: string[] = [];
  if (!/^\d{1,20}$/.test(s.appId)) errors.push("CLAW_GITHUB_PUBLIC_READ_APP_ID must be a number");
  if (!/^\d{1,20}$/.test(s.installationId)) errors.push("CLAW_GITHUB_PUBLIC_READ_INSTALLATION_ID must be a number");
  if ((s.repositories ?? []).some((r) => !REPO_NAME.test(r))) errors.push(`${REPOSITORIES} must be repository names (no owner), separated by commas`);
  try {
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(readKey(s.keyFile))) errors.push("CLAW_GITHUB_PUBLIC_READ_KEY_FILE does not hold a PEM private key");
  } catch {
    errors.push("CLAW_GITHUB_PUBLIC_READ_KEY_FILE cannot be read");
  }
  return errors;
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

/** The App's own short token (RS256, ten minutes at most), with which an installation token is asked for. */
export function appJwt(appId: string, keyPem: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const data = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))}`;
  return `${data}.${b64url(sign("RSA-SHA256", Buffer.from(data), keyPem))}`;
}

export interface PublicReadDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  readKey?: (file: string) => Promise<string>;
}

/** Installation tokens of the App, one at a time, made when needed and kept until shortly before they expire. Never printed. */
export class PublicReadTokens {
  #cached: { token: string; renewAt: number } | null = null;
  #making: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly readKey: (file: string) => Promise<string>;

  constructor(private readonly settings: PublicReadSettings, private readonly apiUrl: string, deps: PublicReadDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.readKey = deps.readKey ?? ((f) => readFile(f, "utf8"));
  }

  toJSON(): Record<string, never> { return {}; }
  toString(): string { return "[PublicReadTokens]"; }

  /** A token that reads public repositories, made now when there is none to use. Throws when none can be made. */
  async token(): Promise<string> {
    if (this.#cached && this.now() < this.#cached.renewAt) return this.#cached.token;
    this.#making ??= this.#make().finally(() => { this.#making = null; });
    return this.#making;
  }

  /** GitHub no longer takes `token` (401): the next read makes another. */
  drop(token: string): void {
    if (this.#cached?.token === token) this.#cached = null;
  }

  async #make(): Promise<string> {
    const jwt = appJwt(this.settings.appId, await this.readKey(this.settings.keyFile), this.now());
    const res = await this.fetchImpl(new URL(`${this.apiUrl}/app/installations/${encodeURIComponent(this.settings.installationId)}/access_tokens`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "primus-claw-public-read", "Content-Type": "application/json",
      },
      body: JSON.stringify(this.settings.repositories?.length ? { permissions: PERMISSIONS, repositories: this.settings.repositories } : { permissions: PERMISSIONS }),
      redirect: "error",
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
    if (res.status !== 201) {
      await res.body?.cancel().catch(() => undefined);
      throw Object.assign(new Error(`GitHub answered ${res.status} for a public read token`), { status: res.status });
    }
    const body = await res.json() as { token?: unknown; expires_at?: unknown; permissions?: unknown; repositories?: unknown };
    const expires = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    if (typeof body.token !== "string" || !body.token || !Number.isFinite(expires)) throw new Error("GitHub answered no token");
    const perms = body.permissions && typeof body.permissions === "object" ? Object.entries(body.permissions as Record<string, unknown>) : [];
    const repos = Array.isArray(body.repositories) ? body.repositories as Array<{ full_name?: unknown; name?: unknown; private?: unknown }> : [];
    const wanted = this.settings.repositories ?? [];
    let refusal = "";
    if (perms.length !== 1 || perms[0]![0] !== "metadata" || perms[0]![1] !== "read") refusal = "permissions other than metadata: read";
    else if (repos.some((r) => !r || r.private !== false)) refusal = "a repository GitHub does not say is public";
    else if (wanted.length && (repos.length !== wanted.length
      || repos.some((r) => !wanted.some((w) => w.toLowerCase() === String(r.name).toLowerCase())))) refusal = "repositories other than those asked for";
    if (refusal) {
      // Names and levels only: never the token.
      logger.warn({
        installationId: this.settings.installationId,
        granted: perms.map(([k, v]) => `${k}:${String(v)}`).slice(0, 40),
        repositories: repos.map((r) => `${String(r?.full_name)}${r?.private === false ? "" : " (not public)"}`).slice(0, 40),
      }, "github.public_read_token_refused");
      await this.#revoke(body.token);
      throw new Error(`the public read token came back with ${refusal}; it is not used`);
    }
    logger.info({
      installationId: this.settings.installationId, permissions: "metadata:read", expiresAt: body.expires_at,
      repositories: repos.map((r) => String(r.full_name)),
    }, "github.public_read_token_made");
    this.#cached = { token: body.token, renewAt: expires - RENEW_BEFORE_MS };
    return body.token;
  }

  /** Best effort: a token refused here is revoked at GitHub rather than left to expire. */
  async #revoke(token: string): Promise<void> {
    try {
      const res = await this.fetchImpl(new URL(`${this.apiUrl}/installation/token`), {
        method: "DELETE",
        headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "primus-claw-public-read" },
        redirect: "error",
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => undefined);
    } catch { /* it expires within the hour regardless */ }
  }
}

let shared: { apiUrl: string; tokens: PublicReadTokens } | null | undefined;

/** The deployment's App for reads against `apiUrl`, or null when it has none. */
export function publicReadTokens(apiUrl: string): PublicReadTokens | null {
  if (shared === undefined || (shared && shared.apiUrl !== apiUrl)) {
    const s = readPublicReadSettings();
    shared = s ? { apiUrl, tokens: new PublicReadTokens(s, apiUrl) } : null;
  }
  return shared?.tokens ?? null;
}
