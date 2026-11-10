// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The HTTP plumbing of the fake remote-agents server: reading a request, writing an answer. */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { FakeSession, Json } from "./remote-fake-data.js";

export interface Reply {
  status: number;
  body: unknown;
}

export const reply = (status: number, body: unknown): Reply => ({
  status,
  body,
});

export const refuse = (status: number, error: string): Reply => reply(status, { ok: false, error });

export const notARoute = (method: string, path: string): Reply =>
  reply(404, { message: `Route ${method}:${path} not found` });

/** The stream is still there to write to (a function: the state changes while the pump waits). */
export function open(res: ServerResponse): boolean {
  return !res.destroyed;
}

/** A query parameter as a number, `fallback` when it is missing or empty. */
export function numberParam(url: URL, name: string, fallback: number): number {
  const value = url.searchParams.get(name);
  return value ? Number(value) : fallback;
}

export function publicOf(row: FakeSession): Json {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "owner"));
}

export async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

export function send(res: ServerResponse, answer: Reply): void {
  res.writeHead(answer.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(answer.body));
}
