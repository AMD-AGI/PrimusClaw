/**
 * What the review delegation needs from GitHub and from the identity service's GitHub credentials, as ports. The runtime
 * implements them over HTTP (`runtime/src/github/`); tests use fakes. No port ever returns or logs a GitHub token except
 * `DeviceFlow.waitForToken`, whose token goes straight to `GithubCredentials.bind`.
 */

import type { PullRef } from "../review/pull-ref.js";

/** The GitHub device flow ended without a token. Nothing but the reason is kept (no body, no code, no token). */
export type DeviceFlowFailure = "unavailable" | "expired" | "denied";

export class DeviceFlowError extends Error {
  readonly reason: DeviceFlowFailure;

  constructor(reason: DeviceFlowFailure) {
    super(reason);
    this.name = "DeviceFlowError";
    this.reason = reason;
  }
}

export interface DeviceCode {
  /** What the worker polls with; never shown. */
  readonly deviceCode: string;
  /** What the person types. */
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly interval: number;
}

/** RFC 8628 against github.com with a public client; the scope asked for is always `repo`. */
export interface DeviceFlow {
  start(): Promise<DeviceCode>;
  /** Polls until the person approves: the token, or DeviceFlowError. */
  waitForToken(code: DeviceCode): Promise<string>;
}

/**
 * The identity service refused or could not be asked. `status` is the HTTP status (0: no answer) and `code` its OAuth error
 * code; nothing else of the answer is kept.
 */
export class CredentialError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code = "") {
    super(`identity service answered ${String(status)} ${code}`.trim());
    this.name = "CredentialError";
    this.status = status;
    this.code = code;
  }
}

/** The identity service has no binding for this person: only they can make one, by connecting their Primus account. */
export class CredentialNotBound extends Error {
  constructor() {
    super("not bound");
    this.name = "CredentialNotBound";
  }
}

export interface GithubState {
  readonly userId: string;
  readonly bound: boolean;
  readonly login: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  readonly expired: boolean;
  readonly delegation: boolean;
  readonly lastUsedAt: string;
}

export function usable(state: GithubState): boolean {
  return state.bound && !state.expired;
}

export const SCOPE = "repo";
export const NARROW_SCOPE = "public_repo";

/** A binding whose permissions do not reach private and internal repositories (`public_repo` only, or none known). */
export function needsWiderScope(scopes: readonly string[]): boolean {
  return !scopes.includes(SCOPE);
}

/** The identity service's `/oauth/external-credentials` calls for a person (by their directory id). */
export interface GithubCredentials {
  status(aadId: string): Promise<GithubState>;
  bind(aadId: string, token: string): Promise<GithubState>;
  unbind(aadId: string): Promise<boolean>;
  setDelegation(aadId: string, enabled: boolean): Promise<GithubState>;
}

/** Who wrote a pull request, and other public facts, read with no credential. Any failure reads as "not known". */
export interface PullReader {
  /** The repository's own "owner/name" when GitHub has it public, '' when it does not (404), undefined when it could not be read. */
  repo(owner: string, name: string): Promise<string | undefined>;
  /** The branch the pull request goes into ('' when not read). */
  base(pull: PullRef): Promise<string>;
  /** Who wrote it (undefined: not read) and its title ('' not read). */
  read(pull: PullRef): Promise<{ readonly author: string | undefined; readonly title: string }>;
}

/** One mention as the model is shown it: its marker in the text, its id, and its display name. */
export interface ListedMention {
  readonly marker: string;
  readonly id: string;
  readonly name: string;
}

/**
 * One small model call that says what a message asks for, with the asker's own key. undefined for anything but an answer in
 * time (no model, the gateway refused or was slow): the rules read it instead. `{ intent: null }` when it answered something
 * that is not a JSON object.
 */
export interface IntentReader {
  read(key: string, text: string, mentions: readonly ListedMention[]): Promise<Record<string, unknown> | undefined>;
  readMode(key: string, text: string): Promise<Record<string, unknown> | undefined>;
  readAnswer(
    key: string,
    text: string,
    pending: readonly Readonly<Record<string, string>>[],
  ): Promise<Record<string, unknown> | undefined>;
}
