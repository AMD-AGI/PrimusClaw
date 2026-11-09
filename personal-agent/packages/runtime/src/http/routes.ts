// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's HTTP routes, independent of the server library: a route sees the request as read (headers, path
 * parameters, query, the raw body) and answers with a status and a JSON or text body. The server (`server.ts`) mounts
 * them; tests call them directly.
 */
import { pyRepr, type JsonValue } from "@primusclaw/personal-agent";

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface HttpRequest {
  /** Header names lower case. */
  readonly headers: Readonly<Record<string, string>>;
  /** The path parameters (`:name` in the route's path), decoded. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /** The body exactly as it arrived (an HMAC is computed over these bytes). */
  readonly body: Uint8Array;
}

export type HttpResponse =
  | { readonly status: number; readonly json: JsonValue }
  | { readonly status: number; readonly text: string; readonly contentType?: string };

export interface HttpRoute {
  readonly method: Method;
  /** The path, with `:name` for a parameter (one segment). */
  readonly path: string;
  handle(request: HttpRequest): Promise<HttpResponse>;
}

export function json(status: number, body: JsonValue): HttpResponse {
  return { status, json: body };
}

/** The body as JSON; undefined when it is not JSON (or not UTF-8). */
export function bodyJson(request: HttpRequest): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body));
  } catch {
    return undefined;
  }
}

/** The bearer token of the Authorization header ("" when there is none). */
export function bearerOf(request: HttpRequest): string {
  const auth = request.headers["authorization"] ?? "";
  return auth.slice(0, 7).toLowerCase() === "bearer " ? auth.slice(7).trim() : "";
}

/** Python's `str(value)` of a JSON value: a string as it is, anything else its repr (`None`, `True`, `{'a': 1}`). */
export function pythonStr(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}
