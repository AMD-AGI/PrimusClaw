// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The download of a file the agent delivered with `deliver_file`.
 *
 *   GET /v1/sessions/:id/deliveries/:deliveryId
 *
 * What a client links the user to. It answers only a person who signed in (a
 * browser session or an identity-provider token) and owns the session, so the
 * link is no use to anyone it is forwarded to, and none to the key the session's
 * sandbox holds: that key is the owner's own and reaches this API, and a model
 * running in the sandbox must not be able to fetch a link the way the user does.
 * (The key can still read the session's files through `/files`, as it always
 * could; the delivered copy is one of them. What it cannot do is use this link.)
 *
 * Another user's session, a missing one and a malformed id are the same 404, as
 * on `/changes`, and an administrator is not the owner. A delivery older than
 * DELIVERY_TTL_DAYS is 410: the link was for the moment, the session keeps the file.
 */
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { DELIVERY_ID_RE, deliveryContentType, deliveryKeyPrefix } from "@claw/protocol";
import { getUser } from "../auth/middleware.js";
import { canAccessSession } from "../auth/models.js";
import { IDENTITY_TOKEN_METHOD } from "../auth/identity-token.js";
import { getAuthMethod } from "../auth/request-credential.js";
import { DELIVERY_TTL_DAYS, S3_BUCKET } from "../config.js";
import { db } from "../infra/db.js";
import { getS3Client } from "../infra/s3-client.js";
import { sessionWorkspacePrefix } from "../workspace/prefix.js";

/** How a request must have been authenticated to be a person who signed in, as the global hook records it. */
export const SIGNED_IN_METHODS: ReadonlySet<string> = new Set(["cookie", IDENTITY_TOKEN_METHOD]);

const DAY_MS = 24 * 60 * 60 * 1000;

export async function registerSessionDeliveryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string; deliveryId: string } }>("/v1/sessions/:id/deliveries/:deliveryId", async (req, reply) => {
    const method = getAuthMethod(req);
    if (method === null || !SIGNED_IN_METHODS.has(method)) {
      return reply.status(403).send({ ok: false, error: "interactive_sign_in_required" });
    }
    const { id: sessionId, deliveryId } = req.params;
    const notFound = () => reply.status(404).send({ ok: false, error: "delivery not found" });
    if (!DELIVERY_ID_RE.test(deliveryId)) return notFound();
    const row = (await db.query(
      "SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0] as { user_id: string | null } | undefined;
    if (!row || !canAccessSession(row.user_id, getUser(req)?.userId)) return notFound();

    const s3 = getS3Client();
    const prefix = deliveryKeyPrefix(sessionWorkspacePrefix(row.user_id, sessionId), deliveryId);
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, MaxKeys: 1 }));
    const obj = listed.Contents?.[0];
    const name = obj?.Key?.slice(prefix.length) ?? "";
    if (!obj?.Key || !name || name.includes("/")) return notFound();
    if (obj.LastModified && Date.now() - obj.LastModified.getTime() > DELIVERY_TTL_DAYS * DAY_MS) {
      return reply.status(410).send({ ok: false, error: "delivery_expired" });
    }

    const got = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
    reply
      .header("Content-Type", deliveryContentType(name))
      .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-store");
    if (got.ContentLength != null) reply.header("Content-Length", String(got.ContentLength));
    return reply.send(got.Body as Readable);
  });
}
