// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the collector is allowed to know about a workspace.
 *
 * The workspace collector runs in Brain, which has no database by design, so
 * it decides what to delete from what it can see: a directory's mtime, and
 * whether a checkpoint or a lock happens to exist in NATS. That is guesswork
 * pointed at user data, and it errs so far toward keeping that disks fill up
 * instead.
 *
 * This hands it the facts it cannot see: whether anything still references the
 * workspace, and when its retention lease runs out. Deliberately facts and not
 * a verdict -- the decision stays with the collector, which is the only party
 * that can also see the filesystem, and which must keep working when this
 * endpoint is unreachable.
 */
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { internalTokenAuth } from "../auth/middleware.js";
import { workspaceState } from "../workspace/store.js";

const logger = pino({ name: "internal-workspaces" });

export async function registerInternalWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  // Cluster-token auth. Unlike the task endpoints there is no per-run token to
  // check against: the collector is a CronJob, not a run, and it asks about
  // sessions it did not execute.
  app.get<{ Params: { sessionId: string } }>(
    "/v1/internal/workspaces/by-session/:sessionId",
    { preHandler: internalTokenAuth },
    async (req, reply) => {
      const { sessionId } = req.params;
      let state;
      try {
        state = await workspaceState(sessionId);
      } catch (err) {
        // Answered as a failure, not as 404. The collector treats 404 as "decide
        // for yourself" and anything else as "do not decide", so a database
        // outage reported as 404 would give every session at once permission to
        // be judged on mtime alone -- deleting the files of live sessions whose
        // rows exist and say keep. This is the one shape of answer that stops it.
        logger.error({ sessionId, err }, "workspace.state_read_failed");
        return reply.status(503).send({ ok: false, error: "workspace state unavailable" });
      }
      if (!state) {
        // No row means this session predates workspace rows, or its workspace
        // was never recorded. Answered as a distinct case rather than as "no
        // references", because the two must lead to opposite decisions: the
        // collector falls back to its own evidence here, and deleting on the
        // strength of a missing row would reap every workspace written before
        // this existed.
        return reply.status(404).send({ ok: false, error: "no workspace recorded" });
      }
      logger.debug({ sessionId, workspaceId: state.workspace_id }, "workspace.state_read");
      return { ok: true, workspace: state };
    },
  );
}
