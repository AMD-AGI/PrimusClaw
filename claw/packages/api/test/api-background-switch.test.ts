// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * CLAW_API_BACKGROUND=off: the API answers HTTP and starts no background loop (`startup/background.ts`).
 *
 *   B1 the setting is on, off, or refused; unset is on
 *   B2 off calls no loop's start, each asserted by name; on calls every one, in order, as before
 *   B3 on keeps each loop's own setting: a loop its flag keeps off is not started, and logs what it always logged
 *   B4 every start, timer and one-shot job in index.ts goes through the switch
 *   B5 off: a request's kick delivers nothing from this process
 *   B6 off: the remote-agent routes register no timer and start no loop, each asserted by name; on starts each
 *   B7 off logs one line naming every skipped loop
 */
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Fastify from "fastify";

import {
  API_BACKGROUND_LOOPS,
  REMOTE_AGENT_BACKGROUND_LOOPS,
  REQUEST_DELIVERY,
  SKIPPED_WHEN_OFF,
  apiBackgroundLoops,
  logBackgroundOff,
  readApiBackground,
  startBackgroundLoops,
  startedBackgroundLoops,
  type ApiBackgroundFlags,
  type ApiBackgroundLoopName,
  type ApiBackgroundPorts,
} from "../src/startup/background.js";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

// Before anything imports config.ts, which reads it once: B6 needs the remote-agent routes, and B5 imports the database module.
process.env.CLAW_REMOTE_AGENTS_ENABLED = "true";

const ALL_ON: ApiBackgroundFlags = { skillEvolution: true, triggers: true, notifications: true, a2aPush: true, maintenance: true };
const ALL_OFF: ApiBackgroundFlags = { skillEvolution: false, triggers: false, notifications: false, a2aPush: false, maintenance: false };

/** Ports that record which loop was started, in order. */
function recordingPorts(): { ports: ApiBackgroundPorts; calls: ApiBackgroundLoopName[] } {
  const calls: ApiBackgroundLoopName[] = [];
  const ports = Object.fromEntries(API_BACKGROUND_LOOPS.map((name) => [name, () => { calls.push(name); }])) as ApiBackgroundPorts;
  return { ports, calls };
}

/** Run both phases as index.ts does. */
async function runIndexLoops(on: boolean, flags: ApiBackgroundFlags, log?: { info(obj: object, msg: string): void }) {
  const { ports, calls } = recordingPorts();
  const loops = apiBackgroundLoops(ports, flags);
  await startBackgroundLoops(on, loops.beforeListen, log);
  await startBackgroundLoops(on, loops.afterListen, log);
  return calls;
}

test("B1 the setting: unset and on run the loops, off does not, anything else is refused", () => {
  assert.deepEqual(readApiBackground(undefined), { on: true });
  assert.deepEqual(readApiBackground(""), { on: true });
  assert.deepEqual(readApiBackground("  "), { on: true });
  assert.deepEqual(readApiBackground("on"), { on: true });
  assert.deepEqual(readApiBackground("ON"), { on: true });
  assert.deepEqual(readApiBackground("off"), { on: false });
  assert.deepEqual(readApiBackground(" Off "), { on: false });
  for (const typo of ["of", "false", "0", "no", "true", "disabled"]) {
    const r = readApiBackground(typo);
    assert.equal(r.on, undefined, typo);
    assert.match(r.problem ?? "", new RegExp(`^CLAW_API_BACKGROUND=${typo} is neither on nor off$`), typo);
  }
});

describe("B2 off starts no loop of index.ts", () => {
  for (const name of API_BACKGROUND_LOOPS) {
    test(`off: ${name} is not started`, async () => {
      const calls = await runIndexLoops(false, ALL_ON);
      assert.equal(calls.filter((c) => c === name).length, 0);
    });
  }
  test("on: every loop is started once, in index.ts's order", async () => {
    assert.deepEqual(await runIndexLoops(true, ALL_ON), [...API_BACKGROUND_LOOPS]);
  });
  test("the before-listen phase is every loop but the deferred index build, which runs after listen", () => {
    const loops = apiBackgroundLoops(recordingPorts().ports, ALL_ON);
    assert.deepEqual(loops.afterListen.map((l) => l.name), ["deferred_index_build"]);
    assert.deepEqual([...loops.beforeListen, ...loops.afterListen].map((l) => l.name), [...API_BACKGROUND_LOOPS]);
  });
});

test("B3 on: a loop its own flag keeps off is not started, and logs what it always logged", async () => {
  const logged: string[] = [];
  const calls = await runIndexLoops(true, ALL_OFF, { info: (_obj, msg) => { logged.push(msg); } });
  const gated: ApiBackgroundLoopName[] = ["evolve_worker", "trigger_scheduler", "notification_worker", "a2a_push_worker", "maintenance_cron"];
  assert.deepEqual(calls, API_BACKGROUND_LOOPS.filter((n) => !gated.includes(n)));
  assert.deepEqual(logged, ["evolve_worker.skipped_flag_off", "maintenance_cron.skipped_all_flags_off"]);
  // Each flag gates its own loop and nothing else.
  for (const [flag, loop] of [
    ["skillEvolution", "evolve_worker"], ["triggers", "trigger_scheduler"], ["notifications", "notification_worker"],
    ["a2aPush", "a2a_push_worker"], ["maintenance", "maintenance_cron"],
  ] as const) {
    const one = await runIndexLoops(true, { ...ALL_OFF, [flag]: true });
    assert.ok(one.includes(loop), `${flag} starts ${loop}`);
    assert.equal(one.length, calls.length + 1, `${flag} starts only ${loop}`);
  }
});

describe("B4 index.ts starts nothing around the switch", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const open = index.indexOf("const loops = apiBackgroundLoops({");
  const close = index.indexOf("await startBackgroundLoops(background, loops.beforeListen, logger);");
  const inside = index.slice(open, close);
  const outside = index.slice(0, open) + index.slice(close);

  test("the loops are built once and run in both phases behind the switch", () => {
    assert.ok(open > 0 && close > open);
    assert.match(index, /\n {2}await startBackgroundLoops\(background, loops\.afterListen, logger\);\n/);
    assert.ok(index.indexOf("await startBackgroundLoops(background, loops.afterListen, logger);") > index.indexOf("await app.listen("));
    assert.match(index, /const background = CLAW_API_BACKGROUND\.on === true;/);
    assert.match(index, /await registerRemoteAgentRoutes\(app, \{ closing: shutdown\.closing, crossReplicaWake: true, background \}\)/);
  });

  test("off: the refusal comes first, then request delivery stops and the line is logged", () => {
    const main = index.slice(index.indexOf("async function main()"));
    assert.match(main, /^async function main\(\) \{\n {2}validateStartupConfig\(\);\n {2}assertApiBackgroundSetting\(\);\n/);
    assert.match(main, /if \(!background\) \{\n {4}deliverNotificationsOnRequest\(false\);\n {4}logBackgroundOff\(logger\);\n {2}\}/);
  });

  test("every loop has its port inside the block", () => {
    for (const name of API_BACKGROUND_LOOPS) assert.match(inside, new RegExp(`\\n {4}${name}: `), name);
  });

  test("outside the block, no start, timer or one-shot job but the identity client", () => {
    const starts = [...outside.matchAll(/\bstart[A-Z]\w*\(/g)].map((m) => m[0]).filter((s) => s !== "startBackgroundLoops(");
    assert.deepEqual(starts, ["startIdentityClient("]);
    assert.doesNotMatch(outside, /\bset(Timeout|Interval)\(/);
    assert.doesNotMatch(outside, /\bbuildDeferredIndexes\(\)/);
    assert.doesNotMatch(outside, /\bpublishSystemEnvToKv\(\)/);
    for (const fn of ["startScheduler", "startSweeper", "startExternalResolver", "startEventConsumer", "startEvolveWorker",
      "startUploadSweeper", "startPluginExpirySweeper", "startTriggerScheduler", "startNotificationWorker", "startA2aPushWorker",
      "startGithubEventWatch", "startJobWatch", "buildDeferredIndexes", "publishSystemEnvToKv", "setInterval"]) {
      assert.match(inside, new RegExp(`\\b${fn}\\(`), fn);
    }
  });
});

describe("B5 off: a request's kick delivers nothing from this process", () => {
  let db: typeof import("../src/infra/db.js").db;
  let outbox: typeof import("../src/notifications/outbox.js");
  let originalQuery: typeof db.query;
  const seen: string[] = [];
  before(async () => {
    ({ db } = await import("../src/infra/db.js"));
    outbox = await import("../src/notifications/outbox.js");
    originalQuery = db.query;
    db.query = (async (text: string) => {
      seen.push(text.replace(/\s+/g, " ").trim());
      return { rows: [], rowCount: 0 };
    }) as unknown as typeof db.query;
  });
  after(() => {
    db.query = originalQuery;
    outbox.deliverNotificationsOnRequest(true);
  });
  const claims = () => seen.filter((s) => /^UPDATE claw_notification_outbox SET attempts/.test(s)).length;

  test(`off: ${REQUEST_DELIVERY} claims no row`, async () => {
    outbox.deliverNotificationsOnRequest(false);
    await outbox.kickDelivery({ allowedHosts: new Set() });
    assert.equal(seen.length, 0, "not one statement");
  });
  test("on: the same kick claims", async () => {
    outbox.deliverNotificationsOnRequest(true);
    await outbox.kickDelivery({ allowedHosts: new Set() });
    assert.equal(claims(), 1);
  });
});

/** Every setTimeout and setInterval registered while `fn` runs. */
async function timersDuring(fn: () => Promise<void>): Promise<number> {
  const realTimeout = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  let n = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => { n += 1; return realTimeout(...args); }) as typeof setTimeout;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { n += 1; return realInterval(...args); }) as typeof setInterval;
  try {
    await fn();
  } finally {
    globalThis.setTimeout = realTimeout;
    globalThis.setInterval = realInterval;
  }
  return n;
}

describe("B6 the remote-agent routes", { skip: postgresSkipReason() }, () => {
  let h: AdmissionCluster;
  before(async () => {
    h = await startAdmissionCluster({ CLAW_REMOTE_AGENTS_ENABLED: "true", SAFE_API_URL: "http://127.0.0.1:9", AUTH_INTERNAL_TOKEN: "t" });
  });
  after(async () => { await h?.stop(); });

  // Every loop asked for: a relay, retention, presence and terminal-wait sweeps, the undelivered sweep, and the prune.
  const everyLoop = { crossReplicaWake: true, retentionDays: 1, presenceSweepMs: 60_000, undeliveredSweepMs: 60_000 };

  test("off: no timer is registered and no loop is started, each by name; the routes are the same", async () => {
    const { registerRemoteAgentRoutes } = await import("../src/routes/remote-agents.js");
    const before = startedBackgroundLoops().length;
    const app = Fastify();
    // Closed whatever the assertions say: a loop started by mistake would otherwise hold the process open.
    try {
      const timers = await timersDuring(() => registerRemoteAgentRoutes(app, { ...everyLoop, background: false }));
      await app.ready();
      assert.equal(timers, 0, "no timer");
      const now = startedBackgroundLoops().slice(before);
      for (const name of REMOTE_AGENT_BACKGROUND_LOOPS) assert.equal(now.includes(name), false, `${name} not started`);
      assert.equal(app.printRoutes().includes("remote-agents"), true, "the routes are registered");
    } finally {
      await app.close();
    }
  });

  test("on: each loop is started, by name, and registers its timer", async () => {
    const { registerRemoteAgentRoutes } = await import("../src/routes/remote-agents.js");
    const before = startedBackgroundLoops().length;
    const app = Fastify();
    try {
      const timers = await timersDuring(() => registerRemoteAgentRoutes(app, { ...everyLoop }));
      await app.ready();
      assert.deepEqual(startedBackgroundLoops().slice(before), [...REMOTE_AGENT_BACKGROUND_LOOPS]);
      // Retention, presence, terminal waits, undelivered, prune: one timer each at least (the relay's is only on a reconnect).
      assert.ok(timers >= 5, `timers: ${timers}`);
    } finally {
      await app.close();
    }
  });
});

test("B7 off logs one line that names every skipped loop", () => {
  const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  logBackgroundOff({ info: (obj, msg) => { lines.push({ obj: obj as Record<string, unknown>, msg }); } });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].obj.background, "off");
  assert.deepEqual(lines[0].obj.skipped, [...API_BACKGROUND_LOOPS, ...REMOTE_AGENT_BACKGROUND_LOOPS, REQUEST_DELIVERY]);
  assert.deepEqual(SKIPPED_WHEN_OFF, lines[0].obj.skipped);
  assert.match(lines[0].msg, /background=off/);
  for (const name of SKIPPED_WHEN_OFF) assert.ok(lines[0].msg.includes(name), name);
});
