// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import pino from "pino";
import { TOOLS_API_URL } from "../config.js";

const logger = pino({ name: "tools-lookup" });

/**
 * Why a default tool could not be looked up. The first three say something
 * about the tool or the caller; `endpoint_unreachable` says the request never
 * reached the Tools API at all (wrong base URL, a proxy that does not route
 * it), which an operator fixes in configuration, not in the marketplace.
 */
export type LookupFailure = "not_found" | "forbidden" | "endpoint_unreachable" | "lookup";
export type LookupResult = { ok: true; tool: Record<string, unknown> } | { ok: false; reason: LookupFailure };

/**
 * The Tools API base for default skills: the in-cluster API (the same
 * INTERNAL_BACKEND_URL Brain already uses to reach it for run claims), whose
 * routes live at `/v1/tools`. The `/claw-api` prefix is only the public
 * ingress's, and the SaFE apiserver behind SAFE_API_URL does not route it.
 * Without INTERNAL_BACKEND_URL (single-host setups) the gateway path is kept.
 * Read at call time.
 */
export function platformToolsBase(): string {
  const b = (process.env.INTERNAL_BACKEND_URL ?? "").trim().replace(/\/$/, "");
  return b ? `${b}/v1/tools` : TOOLS_API_URL;
}

/** An error answer from the Claw API itself: `{ ok: false, error: "<code>" }`. */
async function isClawApiError(resp: Response): Promise<boolean> {
  try {
    const body = (await resp.json()) as Record<string, unknown>;
    return body?.ok === false && typeof body.error === "string";
  } catch {
    return false;
  }
}

/** One tool, by id, with the caller's own key and a deadline. */
export async function lookupTool(toolId: number, platformKey: string, timeoutMs = 10_000): Promise<LookupResult> {
  const url = `${platformToolsBase()}/${toolId}`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${platformKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status === 401 || resp.status === 403) return { ok: false, reason: "forbidden" };
    if (resp.status === 404) {
      // A 404 is "no such tool" only when the Claw API said so. Anything else
      // (an HTML or empty 404 from a gateway that does not route this path)
      // means we never reached the endpoint.
      if (await isClawApiError(resp)) return { ok: false, reason: "not_found" };
      logger.error({ toolId, url: url.replace(/\/\d+$/, "/<id>"), status: 404 }, "tools.endpoint_unreachable");
      return { ok: false, reason: "endpoint_unreachable" };
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as { data?: Record<string, unknown> };
    if (!data.data || typeof data.data !== "object") return { ok: false, reason: "endpoint_unreachable" };
    return { ok: true, tool: data.data };
  } catch (err) {
    logger.error({ toolId, err: (err as Error).message }, "tools.lookup_failed");
    return { ok: false, reason: "lookup" };
  }
}

