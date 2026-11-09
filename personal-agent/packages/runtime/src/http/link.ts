// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The account-linking endpoint, reached from the console on the same origin: the console page creates an API key for the
 * person and posts `{key}` here; the worker answers with a short code that the person types as `/link CODE` in the chat.
 * The code only ever travels from the console to the chat, so a chat identity can never be tied to a key by a link someone
 * else sent: anything but `key` in the body is ignored, and nothing is bound here.
 */
import { LINK_CODE_TTL_SECONDS, type LinkRepository } from "@primusclaw/personal-agent";
import { z } from "zod";

import { bodyJson, json, type HttpRoute } from "./routes.js";

/** Both routes of the link flow live under this prefix, so one ingress path exposes them. */
export const PREFIX = "/primus-claw-agent";

/** Whether Claw takes `key` (a key Claw refuses gets no code). */
export type KeyCheck = (key: string) => Promise<boolean>;

const LinkBody = z.object({ key: z.union([z.string(), z.number(), z.boolean()]) }).loose();

export function linkRoute(links: Pick<LinkRepository, "stashPending">, checkKey: KeyCheck): HttpRoute {
  return {
    method: "POST",
    path: `${PREFIX}/link`,
    async handle(request) {
      const body = LinkBody.safeParse(bodyJson(request));
      if (!body.success) return json(400, { error: "key_required" });
      // (Python's str(...) of a JSON scalar)
      const raw = body.data.key;
      const key = typeof raw === "boolean" ? (raw ? "True" : "False") : String(raw);
      if (!(await checkKey(key))) return json(422, { error: "key_rejected" });
      return json(200, { code: links.stashPending(key), expires_in: LINK_CODE_TTL_SECONDS });
    },
  };
}

export const healthzRoute: HttpRoute = {
  method: "GET",
  path: "/healthz",
  handle: () => Promise.resolve({ status: 200, text: "ok" }),
};
