// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Not a port: how the ingress meets the Functions host. Each invocation's records go to its InvocationContext (the
 * Python Function's logging did the same through the host), records outside one go to the console, the registered
 * handlers turn a host request into the ingress's request and its reply into the host's response, and the deployable
 * entry (src/main.ts) registers the functions when it is loaded.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

import { own } from "@primusclaw/personal-agent";
import * as entry from "@primusclaw/personal-agent-teams-ingress";

import { consoleSink, contextSink, type Registrar, register } from "../src/functions.js";
import { type LogRecord } from "../src/log.js";
import { start } from "../src/app.js";
import { defined, FULL_ENV, load, MESSAGE, PACKAGE } from "./helpers.js";

type Calls = [string, unknown[]][];

function context(): { context: InvocationContext; calls: Calls } {
  const calls: Calls = [];
  const at =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push([name, args]);
    };
  const fake = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
  return { context: fake as unknown as InvocationContext, calls };
}

const RECORDS: LogRecord[] = [
  { logger: "function_app", level: "debug", message: "d" },
  { logger: "function_app", level: "info", message: "i" },
  { logger: "clawy.security", level: "warning", message: "w" },
  { logger: "function_app", level: "error", message: "e", error: new Error("boom") },
];

test("an invocation's records go to its context, at their level, with the error they carry", () => {
  const { context: ctx, calls } = context();
  const sink = contextSink(ctx);
  for (const record of RECORDS) sink(record);
  assert.deepEqual(
    calls.map(([name, args]) => [name, args.length, args[0]]),
    [
      ["debug", 1, "d"],
      ["info", 1, "i"],
      ["warn", 1, "w"],
      ["error", 2, "e"],
    ],
  );
});

test("records outside an invocation go to the console, at their level", (t) => {
  const seen: string[] = [];
  for (const method of ["debug", "info", "warn", "error"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      seen.push(`${method}:${String(args[0])}`);
    });
  }
  for (const record of RECORDS) consoleSink(record);
  assert.deepEqual(seen, ["debug:d", "info:i", "warn:w", "error:e"]);
});

interface Handlers {
  messages?: (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>;
  outbound?: (message: unknown, context: InvocationContext) => Promise<void>;
}

function registered(ingress: Parameters<typeof register>[1]): Handlers {
  const handlers: Handlers = {};
  const recorder: Registrar = {
    http: (_name, options) => {
      handlers.messages = options.handler;
    },
    serviceBusQueue: (_name, options) => {
      handlers.outbound = options.handler;
    },
  };
  register(recorder, ingress);
  return handlers;
}

test("the messages handler passes the request's headers and bytes, and answers with the ingress's reply", async () => {
  const { ingress, bus } = load(FULL_ENV);
  ingress.validate = () => Promise.resolve({});
  const handler = defined(registered(ingress).messages);
  const request = {
    headers: new Headers({ "x-correlation-id": "corr-7" }),
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(MESSAGE)).buffer),
  } as unknown as HttpRequest;
  const { context: ctx } = context();
  const response = await handler(request, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(response.headers, { "Content-Type": "text/plain; charset=utf-8" });
  assert.equal(bus.sent.length, 1);
  assert.equal(bus.sent[0]?.message.correlationId, "corr-7");
});

test("a refusal's security event is logged into the invocation's context", async () => {
  const { ingress } = load(FULL_ENV);
  const handler = defined(registered(ingress).messages);
  const request = {
    headers: new Headers({ "X-Forwarded-For": "203.0.113.7:4431" }),
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(MESSAGE)).buffer),
  } as unknown as HttpRequest;
  const { context: ctx, calls } = context();
  assert.equal((await handler(request, ctx)).status, 401);
  const warned = calls.filter(([name]) => name === "warn").map(([, args]) => String(args[0]));
  assert.deepEqual(
    warned.map((m) => JSON.parse(m) as unknown),
    [
      {
        event: "token_rejected",
        reason: "missing_token",
        service_url_host: "smba.trafficmanager.net",
        client_ip: "203.0.113.7",
      },
    ],
  );
});

test("the outbound handler delivers the queued envelope with the invocation's log", async () => {
  const { ingress, http } = load(FULL_ENV);
  const handler = defined(registered(ingress).outbound);
  const { context: ctx, calls } = context();
  const envelope = {
    operation: "send",
    reference: { serviceUrl: "https://smba.trafficmanager.net/teams", conversation: { id: "19:abc@thread.v2" } },
    activity: { text: "hi" },
  };
  await handler(envelope, ctx);
  assert.equal(http.calls.length, 1);
  assert.ok(
    calls.some(([name, args]) => name === "info" && String(args[0]).startsWith("acquired bot connector token")),
  );
});

test("start registers the messaging endpoint, and the outbound trigger when its connection is set", () => {
  const names: string[] = [];
  const recorder: Registrar = {
    http: (name) => names.push(name),
    serviceBusQueue: (name) => names.push(name),
  };
  start(recorder, { PRIMUSCLAW_BOT_APP_ID: "claw-app" });
  start(recorder, { PRIMUSCLAW_BOT_APP_ID: "claw-app", PRIMUSCLAW_OUTBOUND_SERVICEBUS__fullyQualifiedNamespace: "x" });
  assert.deepEqual(names, ["messages", "messages", "outbound"]);
});

test("the deployable entry registers the functions when it is loaded", () => {
  // Outside a Functions host, @azure/functions runs in its test mode and says it skips the registration.
  // The test's own environment (tsx needs its temporary directory and home), without the ingress's settings.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(PRIMUSCLAW_|BOT_|IDENTITY_|WEBSITE_|CONTAINER_NAME$)/.test(name),
    ),
  );
  const ran = spawnSync(process.execPath, ["--import", "tsx", join(PACKAGE, "src", "main.ts")], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout + ran.stderr, /register function "messages"/);
  assert.match(ran.stdout + ran.stderr, /outbound trigger not registered/);
});

test("the package's entry offers what a Function app of one's own needs", () => {
  for (const name of [
    "createIngress",
    "register",
    "consoleSink",
    "contextSink",
    "readSettings",
    "tokenRejected",
    "start",
  ]) {
    assert.equal(typeof own(entry as Record<string, unknown>, name), "function", name);
  }
  assert.equal(entry.SERVICE_BUS.fromIdentity.name.length > 0, true);
  assert.equal(entry.ACK_TYPE, "primusclaw.delivered");
  assert.deepEqual(entry.HOSTED_INSTANCE_SETTINGS, ["WEBSITE_POD_NAME", "CONTAINER_NAME", "WEBSITE_INSTANCE_ID"]);
});
