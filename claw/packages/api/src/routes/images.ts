// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Container image search for the image fields of the web client.
 *
 *   GET /v1/images?search=<text>&limit=<n>
 *     -> { items: [{ name, tag?, createdAt? }], total }
 *
 * The list is SaFE's registry of images, asked for as the caller: the caller's
 * own credential (their session cookie or `ak-` key) is what is forwarded, never
 * a service credential, so what comes back is what SaFE lets that user list.
 *
 * `name` is the complete image reference, the string an image field takes as
 * its value (SaFE calls it `tag`). `tag` is the tag part of that reference when
 * it has one, and `createdAt` is when SaFE registered it. Nothing else of
 * SaFE's answer is passed on.
 *
 * When SaFE cannot answer, the reply says so with a status of its own and
 * `{ error, reason }`, and never a 500: 503 when it is unreachable or this
 * deployment has none, 502 when it answered with something that is not a list,
 * 401 / 403 when it refuses the caller.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import pino from "pino";
import { safePreview } from "@claw/utils";
import { getUser } from "../auth/middleware.js";
import { SAFE_API_URL, isKubernetesMode } from "../config.js";
import { callerAuthOf } from "./app-run-create.js";

const logger = pino({ name: "images" });

export const IMAGES_DEFAULT_LIMIT = 50;
export const IMAGES_MAX_LIMIT = 200;
export const IMAGES_SEARCH_MAX_CHARS = 256;
/** How long SaFE is given to answer before the route gives up on it. */
export const IMAGES_UPSTREAM_TIMEOUT_MS = 10_000;

const SAFE_IMAGES_PATH = "/api/v1/images";

export interface ImageItem {
  name: string;
  tag?: string;
  createdAt?: string;
}

/**
 * The tag of an image reference, if it has one.
 *
 * `host:5000/repo` has a colon and no tag: a colon only separates a tag when it
 * comes after the last slash. A digest (`@sha256:...`) is not a tag either, and
 * is dropped before looking.
 */
export function imageTagOf(reference: string): string | undefined {
  const withoutDigest = reference.split("@")[0];
  const colon = withoutDigest.indexOf(":", withoutDigest.lastIndexOf("/") + 1);
  if (colon === -1) return undefined;
  return withoutDigest.slice(colon + 1) || undefined;
}

/** SaFE's flat image list, reduced to what an image field uses. Entries without a reference are dropped. */
export function toImageItems(raw: unknown[], limit: number): ImageItem[] {
  const items: ImageItem[] = [];
  for (const entry of raw) {
    if (items.length >= limit) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { tag: reference, created_at: createdAt } = entry as Record<string, unknown>;
    if (typeof reference !== "string" || reference.trim() === "") continue;
    const item: ImageItem = { name: reference };
    const tag = imageTagOf(reference);
    if (tag) item.tag = tag;
    if (typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt > 0) {
      const when = new Date(createdAt * 1000);
      // SaFE sends Unix seconds; a value outside what a Date can hold is
      // dropped rather than turned into a thrown RangeError.
      if (Number.isFinite(when.getTime())) item.createdAt = when.toISOString();
    }
    items.push(item);
  }
  return items;
}

export type ImageQuery =
  | { ok: true; search: string; limit: number }
  | { ok: false; error: string; reason: string };

/** The query string, or why it is refused. A limit above the maximum is lowered to it. */
export function parseImageQuery(query: unknown): ImageQuery {
  const q = (typeof query === "object" && query !== null ? query : {}) as Record<string, unknown>;
  let search = "";
  if (q.search !== undefined) {
    if (typeof q.search !== "string") {
      return { ok: false, error: "invalid_search", reason: "search must be given once, as text" };
    }
    search = q.search.trim();
    if (search.length > IMAGES_SEARCH_MAX_CHARS) {
      return { ok: false, error: "invalid_search", reason: `search must be at most ${IMAGES_SEARCH_MAX_CHARS} characters` };
    }
  }
  let limit = IMAGES_DEFAULT_LIMIT;
  if (q.limit !== undefined) {
    if (typeof q.limit !== "string" || !/^[0-9]+$/.test(q.limit) || Number(q.limit) < 1) {
      return { ok: false, error: "invalid_limit", reason: "limit must be a whole number of at least 1" };
    }
    limit = Math.min(Number(q.limit), IMAGES_MAX_LIMIT);
  }
  return { ok: true, search, limit };
}

export type ImagesOutcome =
  | { ok: true; items: ImageItem[]; total: number }
  | { ok: false; status: number; error: string; reason: string };

const refuse = (status: number, error: string, reason: string): ImagesOutcome => ({ ok: false, status, error, reason });

/**
 * Ask SaFE for the images matching `search`, as the caller.
 *
 * Two requests, made together: the flat list, which is what an image field
 * shows but carries no count, and a one-row page of the grouped list, which does
 * (`ready=true` because the flat list holds only images that are ready). `total`
 * is what matches, not how many came back.
 */
export async function searchImages(
  auth: { authorization?: string; cookie?: string },
  query: { search: string; limit: number },
  /** For tests: a shorter wait, or a SaFE other than the configured one. */
  opts: { timeoutMs?: number; baseUrl?: string } = {},
): Promise<ImagesOutcome> {
  if (isKubernetesMode()) return refuse(503, "images_unavailable", "this deployment has no image registry to search");
  const base = (opts.baseUrl ?? SAFE_API_URL).replace(/\/+$/, "");
  if (!base) return refuse(503, "images_unavailable", "the image registry is not configured");
  if (!auth.authorization && !auth.cookie) {
    return refuse(503, "images_unavailable", "the request carries no credential the image registry could be asked with");
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (auth.authorization) headers.authorization = auth.authorization;
  if (auth.cookie) headers.cookie = auth.cookie;

  const url = (extra: Record<string, string>): string => {
    const params = new URLSearchParams(extra);
    if (query.search) params.set("tag", query.search);
    return `${base}${SAFE_IMAGES_PATH}?${params.toString()}`;
  };
  // Not followed: a redirect is an answer from somewhere the caller's
  // credential was not meant for.
  const get = (target: string): Promise<Response> =>
    fetch(target, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? IMAGES_UPSTREAM_TIMEOUT_MS) });

  let flat: Response;
  let count: Response;
  try {
    [flat, count] = await Promise.all([
      get(url({ flat: "true", page_size: String(query.limit) })),
      get(url({ ready: "true", page_size: "1" })),
    ]);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "images.upstream_unreachable");
    return refuse(503, "upstream_unavailable", "the image registry did not answer");
  }

  // A response nobody reads holds its connection until it is collected.
  const discard = async (): Promise<void> => {
    await Promise.all([flat.body?.cancel(), count.body?.cancel()].map((p) => p?.catch(() => {})));
  };
  for (const resp of [flat, count]) {
    if (resp.ok) continue;
    await discard();
    if (resp.status === 401) return refuse(401, "unauthorized", "the image registry did not accept this credential");
    if (resp.status === 403) return refuse(403, "forbidden", "you are not allowed to list images");
    logger.warn({ status: resp.status }, "images.upstream_status");
    return refuse(502, "upstream_error", `the image registry answered with status ${resp.status}`);
  }

  let list: unknown;
  let grouped: unknown;
  try {
    [list, grouped] = await Promise.all([flat.json(), count.json()]);
  } catch (err) {
    logger.warn({ err: safePreview(err instanceof Error ? err.message : String(err), 200) }, "images.upstream_not_json");
    return refuse(502, "upstream_bad_response", "the image registry answered with something that is not JSON");
  }
  const totalCount = (grouped as { totalCount?: unknown } | null)?.totalCount;
  if (!Array.isArray(list) || typeof totalCount !== "number" || !Number.isFinite(totalCount)) {
    return refuse(502, "upstream_bad_response", "the image registry answered with something that is not an image list");
  }
  const items = toImageItems(list, query.limit);
  return { ok: true, items, total: Math.max(totalCount, items.length) };
}

function send(reply: FastifyReply, outcome: Extract<ImagesOutcome, { ok: false }>): FastifyReply {
  return reply.status(outcome.status).send({ ok: false, error: outcome.error, reason: outcome.reason });
}

export async function registerImageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/images", async (req, reply) => {
    if (!getUser(req)) {
      return reply.status(401).send({ ok: false, error: "authentication_required", reason: "authentication required" });
    }
    const query = parseImageQuery(req.query);
    if (!query.ok) return reply.status(400).send({ ok: false, error: query.error, reason: query.reason });
    const outcome = await searchImages(callerAuthOf(req), query);
    if (!outcome.ok) return send(reply, outcome);
    return { items: outcome.items, total: outcome.total };
  });
}
