// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/models` -- the models the caller's own LLM key can use.
 *
 * A browser cannot ask the LLM gateway directly (it holds no key, and the gateway
 * is not on the page's origin), and it should not have to ask the platform to
 * proxy for it: this API already resolves the caller's gateway key to hand to a
 * chat run, so it lists the models with that same key and the page needs one
 * origin only.
 *
 * Response (OpenAI list shape, so existing clients work unchanged):
 *
 *   { "object": "list", "data": [ { "id": "<model>", "owned_by"?: "<owner>" } ] }
 *
 * Only those two fields are returned. The gateway's entries carry whatever it
 * likes (creation times, routing metadata, in some deployments cost data); none
 * of it is part of this contract and none is passed through.
 *
 * Which key: `resolveUserLlmKey(user)`, the function `llm_api_key` is built with
 * for a chat run (sessions/dispatch.ts). Never a deployment-wide key: that would
 * list the models the *service* may use, which is a different set, and would make
 * the answer identical for everybody. No key resolves (the dev auth bypass, an
 * account SaFE has issued none to) -> 503, never an empty list, because an empty
 * list is a valid answer ("you may use nothing") and this is not that.
 *
 * Which gateway and how to authenticate to it: `gatewayModelsRequest`, shared with
 * BYOK verification (OPENAI_BASE_URL / BYOK_VERIFY_MODELS_URL / BYOK_VERIFY_API_STYLE).
 *
 * Failures, always `{ error, reason }` and never a 500 for a dependency:
 *   503 llm_key_unavailable           no key for this account
 *   503 llm_gateway_not_configured    no gateway URL (or protocol) configured
 *   503 llm_gateway_unreachable       DNS / TLS / reset / timeout
 *   502 llm_key_rejected              the gateway refused the key (401/403)
 *   502 llm_gateway_error             any other non-2xx
 *   502 llm_gateway_bad_response      2xx, but not a model list
 * A rejected key is a 502 and not a 401 on purpose: the caller authenticated to
 * *this* API fine; telling the page its session is invalid would send the user to
 * log in again for a fault that logging in does not fix.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import pino from "pino";
import { gatewayModelsRequest } from "../auth/byok.js";
import { getUser } from "../auth/middleware.js";
import { AuthServiceMisconfiguredError } from "../auth/safe-client.js";
import { resolveUserLlmKey } from "../llm/key-source.js";
import { UpstreamError, getUpstreamJson } from "../shared/upstream.js";

const logger = pino({ name: "models-route" });

export interface ModelEntry {
  id: string;
  owned_by?: string;
}

export interface ModelList {
  object: "list";
  data: ModelEntry[];
}

/**
 * The gateway's list reduced to the contract. An entry without a string id is
 * dropped (there is nothing a client could do with it); a body without a `data`
 * array is not a model list at all and returns null.
 */
export function toModelList(body: unknown): ModelList | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const out: ModelEntry[] = [];
  for (const raw of data) {
    const entry = raw as { id?: unknown; owned_by?: unknown } | null;
    if (typeof entry?.id !== "string" || entry.id === "") continue;
    out.push(
      typeof entry.owned_by === "string" && entry.owned_by !== ""
        ? { id: entry.id, owned_by: entry.owned_by }
        : { id: entry.id },
    );
  }
  return { object: "list", data: out };
}

function refuse(reply: FastifyReply, status: number, error: string, reason: string): FastifyReply {
  return reply.status(status).send({ error, reason });
}

export async function registerModelsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/models", async (req, reply) => {
    // The answer depends on whose key it is; nothing in between may reuse it.
    reply.header("cache-control", "no-store");
    const user = getUser(req);
    if (!user) return refuse(reply, 401, "authentication_required", "authentication is required");

    const key = resolveUserLlmKey(user);
    if (!key) return refuse(reply, 503, "llm_key_unavailable", "no LLM gateway key is available for this account");

    let request: { url: string; headers: Record<string, string> };
    try {
      request = gatewayModelsRequest(key);
    } catch (err) {
      if (err instanceof AuthServiceMisconfiguredError) {
        logger.warn({ errMessage: err.message }, "models.gateway_not_configured");
        return refuse(reply, 503, "llm_gateway_not_configured", "the LLM gateway is not configured for model listing");
      }
      throw err;
    }

    let body: unknown;
    try {
      body = await getUpstreamJson(request.url, request.headers);
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      const f = err.failure;
      logger.warn({ kind: f.kind, status: "status" in f ? f.status : null, detail: "detail" in f ? f.detail : null }, "models.upstream_failed");
      if (f.kind === "unreachable") return refuse(reply, 503, "llm_gateway_unreachable", "the LLM gateway did not answer");
      if (f.kind === "rejected") return refuse(reply, 502, "llm_key_rejected", `the LLM gateway refused this account's key (HTTP ${f.status})`);
      if (f.kind === "http") return refuse(reply, 502, "llm_gateway_error", `the LLM gateway answered HTTP ${f.status}`);
      return refuse(reply, 502, "llm_gateway_bad_response", "the LLM gateway answered with something that is not a model list");
    }

    const list = toModelList(body);
    if (!list) return refuse(reply, 502, "llm_gateway_bad_response", "the LLM gateway answered with something that is not a model list");
    return reply.send(list);
  });
}
