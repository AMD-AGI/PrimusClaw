// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An HTTP route a deployment adds to the worker's server (the Python worker's `POST /primus-claw-agent/on-behalf`:
 * a request a person's coordinator sends into the person's own 1:1 chat). The runtime's server mounts every extension
 * it is given; the extension is built by the deployment's assembly, with whatever core services it needs.
 *
 * The body is unvalidated: the extension reads it through its own schema. The response body is JSON.
 */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface RouteRequest {
  /** Header names lower case. */
  readonly headers: Readonly<Record<string, string>>;
  /** The bearer token of the Authorization header ("" when there is none). */
  readonly bearer: string;
  readonly body: unknown;
}

export interface RouteResponse {
  readonly status: number;
  readonly body: JsonValue;
}

export interface RouteExtension {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  /** Absolute path, e.g. "/personal-agent/on-behalf". */
  readonly path: string;
  handle(request: RouteRequest): Promise<RouteResponse>;
}

/** No extensions: the server has only its own routes. */
export const noRouteExtensions: readonly RouteExtension[] = [];
