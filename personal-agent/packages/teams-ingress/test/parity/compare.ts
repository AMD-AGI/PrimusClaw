// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The form a parity result is compared in (and python-answers.json is stored in): the uuid a request without
 * x-correlation-id gets is random on both sides, a transport failure's text is the HTTP library's own, a Connector
 * call's body is compared as JSON, and a queued body over 512 bytes as its sha256 and length.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { own } from "@primusclaw/personal-agent";

import { type Result } from "./driver.js";

export type Answer = Readonly<Record<string, unknown>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LARGE = 512;

function body(base64: unknown): unknown {
  const bytes = Buffer.from(String(base64), "base64");
  if (bytes.length <= LARGE) return bytes.toString("latin1");
  return { sha256: createHash("sha256").update(bytes).digest("hex"), length: bytes.length };
}

function parsed(text: unknown): unknown {
  try {
    return JSON.parse(String(text)) as unknown;
  } catch {
    return text; // compared as text
  }
}

/** A result in the compared form; `server` is what the case asked of the local server. */
export function normalise(result: Result, server: readonly string[]): Answer {
  const sent = result.sent.map((m) => {
    const ids = Object.fromEntries(
      (["correlationId", "sessionId", "messageId"] as const).map((field) => {
        const value = own(m, field);
        return [field, typeof value === "string" && UUID.test(value) ? "<uuid4>" : value];
      }),
    );
    return { ...m, body: body(own(m, "body")), ...ids };
  });
  const calls = result.calls.map((c) => {
    const { body: text, ...rest } = c;
    return { ...rest, json: parsed(text) };
  });
  const rest: Omit<Result, "everything" | "driverError"> & Partial<Result> = { ...result };
  delete rest.everything;
  delete rest.driverError;
  // The text of a transport failure is the HTTP library's own ("connection refused" from urllib3, "fetch failed" from
  // undici); the behaviour is the prefix, which the trigger's retry and the logs depend on.
  const raised =
    typeof rest.raised === "string"
      ? rest.raised.replace(/^(bot connector \w+ failed: ).*$/s, "$1<transport error>")
      : rest.raised;
  return { ...rest, raised, sent, calls, server: [...server] };
}

/** The fields in which two answers differ. */
export function differences(a: Answer, b: Answer): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => !isDeepStrictEqual(own(a, k), own(b, k))).sort();
}
