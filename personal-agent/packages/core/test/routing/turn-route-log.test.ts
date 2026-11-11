// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's "turn started from Teams client" line says which path the message took: the person's assistant, a plain Claw
 * session (the old path), or a review's turn. The daily failure mining counts people per path from it, so it must be there
 * on every path, and it carries no words of the message and no id.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Logger, LogFields } from "@primusclaw/personal-agent";

import { logTurnStarted } from "../../src/routing/turn-start.js";
import { ALICE } from "./fixtures.js";
import { link, message, world } from "./world.js";

const STARTED = "turn started from Teams client";
const MARK = "MSG-route-5d1c";
const KEY = "ak-EXAMPLEroutekeyvalue00000000000000000000000";

function recording(): { logger: Logger; started: LogFields[]; lines: string[] } {
  const started: LogFields[] = [];
  const lines: string[] = [];
  const push = (m: string, f?: LogFields) => {
    lines.push(`${m} ${JSON.stringify(f ?? {})}`);
    if (m === STARTED) started.push(f ?? {});
  };
  const logger: Logger = { debug: push, info: push, warn: push, error: push, child: () => logger };
  return { logger, started, lines };
}

function noWordsOrIds(lines: string[]): void {
  const logged = lines.join("\n");
  for (const mark of [MARK, KEY, ALICE.id, `dm-${ALICE.id}`]) assert.ok(!logged.includes(mark), mark);
}

test("a message that starts a plain Claw session is logged as the legacy route", async () => {
  const w = world();
  const { logger, started, lines } = recording();
  Object.assign(w.deps, { logger });
  link(w, ALICE.id, KEY);
  await w.router.handle(message(`${MARK} what is the plan`));
  await w.router.settled();
  assert.equal(w.turns.calls.length, 1, "(a plain session was used)");
  assert.deepEqual(started, [{ platform: "unknown", chat: "1:1", route: "legacy" }]);
  noWordsOrIds(lines);
});

test("a group message that starts a turn is logged as the legacy route", async () => {
  const w = world();
  const { logger, started } = recording();
  Object.assign(w.deps, { logger });
  link(w, ALICE.id, KEY);
  await w.router.handle(message(`${MARK} what is the plan`, { kind: "group" }));
  await w.router.settled();
  assert.deepEqual(
    started.map((f) => [f["chat"], f["route"]]),
    [["group", "legacy"]],
  );
});

test("a message the assistant takes (assistant on) is logged as the assistant route, and no plain turn starts", async () => {
  const w = world({ assistant: { on: () => true, route: () => Promise.resolve(true) } });
  const { logger, started, lines } = recording();
  Object.assign(w.deps, { logger });
  link(w, ALICE.id, KEY);
  await w.router.handle(message(`${MARK} what is new`));
  await w.router.settled();
  assert.deepEqual(w.turns.calls, []);
  assert.deepEqual(started, [{ platform: "unknown", chat: "1:1", route: "assistant" }]);
  noWordsOrIds(lines);
});

test("a message the assistant does not take after all is logged once, as the legacy route", async () => {
  const w = world({ assistant: { on: () => true, route: () => Promise.resolve(false) } });
  const { logger, started } = recording();
  Object.assign(w.deps, { logger });
  link(w, ALICE.id, KEY);
  await w.router.handle(message(`${MARK} what is new`));
  await w.router.settled();
  assert.deepEqual(
    started.map((f) => f["route"]),
    ["legacy"],
  );
});

test("a message of a person the assistant understands is logged as the assistant route", async () => {
  const w = world({
    assistant: {
      on: () => true,
      understands: () => true,
      reachable: () => true,
      understand: () => Promise.resolve(true),
    },
  });
  const { logger, started, lines } = recording();
  Object.assign(w.deps, { logger });
  link(w, ALICE.id, KEY);
  await w.router.handle(message(`${MARK} connect my dev environment`));
  await w.router.settled();
  assert.deepEqual(w.turns.calls, []);
  assert.deepEqual(started, [{ platform: "unknown", chat: "1:1", route: "assistant" }]);
  noWordsOrIds(lines);
});

test("the line names the client platform and the review route, and nothing else", () => {
  const { logger, started } = recording();
  logTurnStarted(logger, "android", false, "review");
  logTurnStarted(logger, "", true, "legacy");
  assert.deepEqual(started, [
    { platform: "android", chat: "1:1", route: "review" },
    { platform: "unknown", chat: "group", route: "legacy" },
  ]);
});
