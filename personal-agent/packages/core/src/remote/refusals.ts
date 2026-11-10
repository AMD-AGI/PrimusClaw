// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a refusal from Claw's remote-agents API means for a person, in the chat's language. The refusals that have a sentence of
 * their own are a closed set, by (status, `error` code), then by status alone; a 400 names its code when that is a plain word
 * that names no service, else a reference to the log line that keeps it.
 */
import { ClawError } from "../claw/errors.js";
import type { Lang } from "../locales/lang.js";
import type { PublicErrors } from "../public-error/public-errors.js";
import { type RemoteSentence, remoteAgentText } from "../locales/remote-agents.js";
import { offlineText } from "./machines.js";
import type { Connector } from "./model.js";
import { pyRstrip, pyStrip } from "../text/py-text.js";

/**
 * How a detail that may be internal is kept from a person (`public-error`): whether text looks internal, and logging it under
 * a new reference that the person is given instead.
 */
export interface RefusalErrors extends Pick<PublicErrors, "withhold"> {
  looksInternal(text: string): boolean;
}

/** A new session refused as offline twice while the machine was reconnecting: said as that, never as "restart it". */
export class Reconnecting extends ClawError {
  override readonly name: string = "Reconnecting";

  constructor(readonly connector: Connector) {
    super(409, '{"ok": false, "error": "connector_offline"}');
  }
}

/** Claw's refusals that have a sentence of their own, by "status error" (`failureText`). */
export const REFUSALS: ReadonlyMap<string, RemoteSentence> = new Map([
  ["409 connector_offline", "offline"],
  ["409 connector_outdated", "outdated"],
  ["409 session_limit_reached", "sessionLimit"],
  ["409 session_closed", "sessionEnded"],
  ["409 already_resolved", "sessionEnded"],
  ["409 already_decided", "sessionEnded"],
  ["404 agent_not_found", "agentNotFound"],
]);

/** ... and by status alone. */
export const STATUS_REFUSALS: ReadonlyMap<number, RemoteSentence> = new Map([
  [404, "notFound"],
  [429, "rateLimited"],
  [401, "keyRejected"],
  [403, "keyRejected"],
]);

// Claw's `error` words are snake_case (invalid_cwd, connector_offline)
const ERROR_CODE = /^[a-z][a-z0-9_]{0,59}$/u;

/** A fixed sentence of remote agents in `lang`. */
export function saidIn(lang: Lang, sentence: RemoteSentence): string {
  return remoteAgentText.in(lang)[sentence];
}

/** What a refusal from Claw's remote-agents API means for a person, in `lang`. `now`: wall-clock seconds. */
export function failureText(err: ClawError, errors: RefusalErrors, now: number, lang: Lang = "en"): string {
  if (err instanceof Reconnecting) return offlineText(err.connector, now, lang);
  const code = err.code;
  const known = REFUSALS.get(`${String(err.status)} ${code}`) ?? STATUS_REFUSALS.get(err.status);
  if (known !== undefined) return saidIn(lang, known);
  const text = remoteAgentText.in(lang);
  if (err.status === 400 && code && ERROR_CODE.test(code) && !errors.looksInternal(code))
    return text.notAccepted({ code });
  if (err.status === 400 && code) {
    // a code that is no snake_case word, or names a service, may be anything: the log has it
    return text.notAcceptedRef({ ref: errors.withhold("remote_api_400", code) });
  }
  return text.couldNotTake({ status: err.status });
}

/** `base` as a sentence, with the reason an agent or a connector gave when there is one. */
export function withReason(base: string, reason: string | null | undefined): string {
  const bare = pyStrip(pyRstrip(pyStrip(reason ?? ""), "."));
  return bare ? `${base}: ${bare}.` : `${base}.`;
}

/** What makes one key per inbound message: a hash of the text (hex), and fresh randomness for a message that has no id. */
export interface KeyMaker {
  sha1Hex(text: string): string;
  hexId(): string;
}

/** One key per inbound message, so a redelivered message queues one prompt (Claw accepts `[A-Za-z0-9._:-]{1,64}`). */
export function idempotencyKey(keys: KeyMaker, userId: string, activityId: string): string {
  if (!activityId) return `clawy-${keys.hexId()}`;
  return `clawy-${keys.sha1Hex(`${userId}:${activityId}`)}`;
}
