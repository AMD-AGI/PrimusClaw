// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  ClawAnswerInvalid,
  REMOTE_HIDDEN_INCLUDE,
  remoteConnectorsSchema,
  remoteEventRowsSchema,
  remoteHiddenSchema,
  remotePairingSchema,
  remoteSessionSchema,
  remoteSessionsSchema,
  type ClawCredential,
  type ClawRemoteAgentsPort,
  type JsonObject,
  type NewRemoteSession,
  type RemoteConnector,
  type RemoteEventRow,
  type RemoteHidden,
  type RemotePairing,
  type RemoteSession,
  type RemoteSetup,
  type SseEvent,
} from "@primusclaw/personal-agent";
import type { z } from "zod";
import { anyDataOf, dataOf } from "./answers.js";
import { type ClawHttp, pyQuote, segment } from "./http.js";
import { sseEvents } from "./sse-stream.js";

/** The `enabled` of an approvals answer (`{ok, data: {enabled}}`); anything else is not an answer. */
function enabledOf(answer: unknown): boolean {
  const data = anyDataOf(answer, "the approvals setting");
  const enabled = data !== null && typeof data === "object" ? (data as Record<string, unknown>)["enabled"] : undefined;
  if (typeof enabled !== "boolean") throw new ClawAnswerInvalid("the approvals setting has no enabled");
  return enabled;
}

/** `ClawRemoteAgentsPort` over Claw's HTTP API; every call names this client (`X-Claw-Client`) in Claw's audit trail. */
export class HttpRemoteAgents implements ClawRemoteAgentsPort {
  constructor(
    private readonly http: ClawHttp,
    private readonly clientLabel: string,
  ) {}

  async setup(key: ClawCredential): Promise<RemoteSetup> {
    return dataOf(await this.#call("GET", "/setup", key), "the remote setup");
  }

  async connectors(key: ClawCredential, options: { includeHidden?: boolean } = {}): Promise<RemoteConnector[]> {
    const path = options.includeHidden === true ? `/connectors?hidden=${REMOTE_HIDDEN_INCLUDE}` : "/connectors";
    return read(remoteConnectorsSchema, anyDataOf(await this.#call("GET", path, key), "connectors"), "connectors");
  }

  async approvals(key: ClawCredential): Promise<boolean> {
    return enabledOf(await this.#call("GET", "/approvals", key));
  }

  async setApprovals(key: ClawCredential, enabled: boolean): Promise<boolean> {
    return enabledOf(await this.#call("PUT", "/approvals", key, { enabled }));
  }

  async pair(key: ClawCredential): Promise<RemotePairing> {
    return read(
      remotePairingSchema,
      anyDataOf(await this.#call("POST", "/pairings", key, {}), "a pairing"),
      "a pairing",
    );
  }

  async hide(
    key: ClawCredential,
    connectorId: string,
    refs: readonly string[],
    hidden: boolean,
  ): Promise<RemoteHidden> {
    const answer = await this.#call("POST", `/connectors/${segment(connectorId)}/hidden`, key, { refs, hidden });
    return read(remoteHiddenSchema, anyDataOf(answer, "hidden conversations"), "hidden conversations");
  }

  async revoke(key: ClawCredential, connectorId: string): Promise<void> {
    await this.#call("DELETE", `/connectors/${segment(connectorId)}`, key);
  }

  async createSession(key: ClawCredential, session: NewRemoteSession): Promise<RemoteSession> {
    const { connectorId, agentId, cwd, mode = "", resumeRef = "", takeover = false } = session;
    const body = {
      connector_id: connectorId,
      agent_id: agentId,
      cwd,
      ...(mode === "" ? {} : { mode }),
      ...(resumeRef === "" ? {} : { resume_ref: resumeRef }),
      ...(takeover && resumeRef !== "" ? { takeover: true } : {}),
    };
    return read(
      remoteSessionSchema,
      anyDataOf(await this.#call("POST", "/sessions", key, body), "a session"),
      "a session",
    );
  }

  async sessions(key: ClawCredential): Promise<RemoteSession[]> {
    return read(remoteSessionsSchema, anyDataOf(await this.#call("GET", "/sessions", key), "sessions"), "sessions");
  }

  async session(key: ClawCredential, sessionId: string): Promise<RemoteSession> {
    const answer = await this.#call("GET", `/sessions/${segment(sessionId)}`, key);
    return read(remoteSessionSchema, anyDataOf(answer, "a session"), "a session");
  }

  async command(
    key: ClawCredential,
    sessionId: string,
    body: Readonly<JsonObject>,
    idempotencyKey?: string,
  ): Promise<JsonObject> {
    const headers = idempotencyKey === undefined || idempotencyKey === "" ? {} : { "Idempotency-Key": idempotencyKey };
    const answer = await this.#call("POST", `/sessions/${segment(sessionId)}/commands`, key, body, headers);
    return dataOf(answer, "a command");
  }

  async decide(key: ClawCredential, sessionId: string, actionId: string, optionId: string): Promise<JsonObject> {
    const body = { action_id: actionId, option_id: optionId };
    return dataOf(await this.#call("POST", `/sessions/${segment(sessionId)}/decisions`, key, body), "a decision");
  }

  async events(key: ClawCredential, sessionId: string, after?: string, limit = 1000): Promise<RemoteEventRow[]> {
    const query =
      `?mode=replay&limit=${String(Math.trunc(limit))}` +
      (after === undefined || after === "" ? "" : `&after=${pyQuote(after)}`);
    const rows = anyDataOf(
      await this.#call("GET", `/sessions/${segment(sessionId)}/events${query}`, key),
      "remote replay",
    );
    if (!Array.isArray(rows)) throw new ClawAnswerInvalid("remote replay is not a list");
    return remoteEventRowsSchema.parse(rows);
  }

  stream(key: ClawCredential, sessionId: string, after?: string, signal?: AbortSignal): AsyncIterable<SseEvent> {
    return sseEvents(this.http, `/v1/remote-agents/sessions/${segment(sessionId)}/events`, key, after, signal);
  }

  #call(
    method: string,
    path: string,
    key: ClawCredential,
    body?: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    return this.http.json({
      method,
      path: `/v1/remote-agents${path}`,
      key,
      ...(body === undefined ? {} : { body }),
      headers: { "X-Claw-Client": this.clientLabel, ...headers },
    });
  }
}

/** `data` read with `schema`; an answer of another shape is one this client does not understand. */
function read<S extends z.ZodType>(schema: S, data: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ClawAnswerInvalid(`${what}: not what Claw answers`);
  return parsed.data;
}
