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

/** A value of the type `schema` accepts, else `undefined`: a field Claw sent wrong is read as one it did not send. */
function lenient<T extends z.ZodType>(schema: T) {
  return z.optional(
    z.unknown().transform((value): z.output<T> | undefined => {
      const parsed = schema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    }),
  );
}

const text = lenient(z.string());
const flag = lenient(z.boolean());
const objectOf = lenient(z.record(z.string(), z.unknown()));

/** One agent a connector reports (`RemoteAgentDescriptor`, read leniently). */
export const remoteAgentSchema = z.looseObject({
  agent_id: text,
  kind: text,
  name: text,
  /** Opaque: whatever the connector reported, passed on unread. */
  capabilities: objectOf,
});
export type RemoteAgent = z.output<typeof remoteAgentSchema>;

/** Rows of a list: the objects among them, each read with `schema`. */
function rowsOf<T extends z.ZodType>(schema: T): z.ZodType<Array<z.output<T>>> {
  return z.array(z.unknown()).transform((rows) =>
    rows.flatMap((row) => {
      const parsed = schema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    }),
  );
}

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
