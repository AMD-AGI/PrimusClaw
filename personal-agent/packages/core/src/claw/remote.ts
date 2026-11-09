// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The answers of Claw's remote-agents routes (the user side) as this agent reads them. Claw does not name these list
 * and response shapes in `@claw/protocol` yet (only `RemoteAgentDescriptor`); each field below is what the worker reads.
 * A field that is absent, or of another type than written here, is read as absent (`undefined`): the domain fills in
 * its own default, as the Python worker did with `dict.get`. A row that is not an object is left out.
 */
import type { JsonObject } from "../json.js";
import { z } from "zod";
import { anyText as text, flag, lenient, objectOf, rowsOf } from "./lenient.js";

/** One agent a connector reports (`RemoteAgentDescriptor`, read leniently). */
export const remoteAgentSchema = z.looseObject({
  agent_id: text,
  kind: text,
  name: text,
  /** Opaque: whatever the connector reported, passed on unread. */
  capabilities: objectOf,
});
export type RemoteAgent = z.output<typeof remoteAgentSchema>;

/** One of the caller's connectors (`GET /v1/remote-agents/connectors`). */
export const remoteConnectorSchema = z.looseObject({
  connector_id: text,
  name: text,
  online: flag,
  version: text,
  /** As Claw wrote them (ISO 8601): ages are computed from the text, never parsed here. */
  last_seen_at: text,
  heartbeat_at: text,
  agents: lenient(rowsOf(remoteAgentSchema)),
});
export type RemoteConnector = z.output<typeof remoteConnectorSchema>;

/** One remote session (`GET /v1/remote-agents/sessions[/:id]`, and the answer of `POST /sessions`). */
export const remoteSessionSchema = z.looseObject({
  session_id: text,
  status: text,
  connector_id: text,
  agent_id: text,
  cwd: text,
  read_only: flag,
  /** As Claw wrote it (ISO 8601), never parsed here. */
  updated_at: text,
});
export type RemoteSession = z.output<typeof remoteSessionSchema>;

/** One stored event of a remote session (`GET .../events?mode=replay`): `{id, seq, type, ts, data}`. */
export const remoteEventRowSchema = z.looseObject({
  id: lenient(z.union([z.string(), z.number()]).transform(String)),
  seq: lenient(z.number()),
  type: text,
  /** Milliseconds since the epoch (`RemoteEventIn.ts`); a numeric string (a bigint column) is read as its number. */
  ts: lenient(
    z.union([
      z.number(),
      z
        .string()
        .regex(/^\d{1,16}$/)
        .transform(Number),
    ]),
  ),
  data: objectOf,
});
export type RemoteEventRow = z.output<typeof remoteEventRowSchema>;

/** A list of rows read with `schema` (rows that are not objects are left out). */
export const remoteConnectorsSchema = rowsOf(remoteConnectorSchema);
export const remoteSessionsSchema = rowsOf(remoteSessionSchema);
export const remoteEventRowsSchema = rowsOf(remoteEventRowSchema);

/**
 * The answer of hiding conversations of a machine from the owner's lists, or showing them again
 * (`POST /v1/remote-agents/connectors/:cid/hidden`): the refs that changed, and the ones refused (`live`: a process has
 * it open; `unknown_conversation`: the machine does not report it now). Claw does not name this shape in
 * `@claw/protocol` (AMD-AGI/PrimusClaw#576).
 */
export const remoteHiddenSchema = z.looseObject({
  changed: lenient(z.array(z.string())),
  refused: lenient(rowsOf(z.looseObject({ ref: z.string(), reason: z.string() }))),
});
export type RemoteHiddenAnswer = z.output<typeof remoteHiddenSchema>;

/** How to connect a machine (`GET /setup`): the connector's package and the exact commands, passed on as Claw wrote them. */
export type RemoteSetup = JsonObject;

/** A one-time pairing (`POST /pairings`). */
export const remotePairingSchema = z.looseObject({
  code: text,
  expires_at: text,
  expires_in: lenient(z.number()),
  server: text,
  command: text,
});
export type RemotePairing = z.output<typeof remotePairingSchema>;
