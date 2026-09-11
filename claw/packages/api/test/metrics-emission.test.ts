// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// metrics-emission.test.ts
//
// Deltas over the rendered exposition. The first half covers the emissions
// whose whole decision lives in infra/metrics.ts: which exits read the
// queue-sojourn marker, what a row-count increment does, and that two calls
// move a series by exactly two.
//
// The second half proves each counter moves from its real call site, over the
// port seams the product already has -- an injected `openRun` / `publish`, the
// `limits` a hand-off decides against, and the four internal claim routes --
// so no database and no NATS is needed. The functions that own the counters
// are never the ones replaced.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

import { DOORBELL_SEMANTICS_VERSION } from "@claw/protocol";

import { metrics, registry, type DispatchPath } from "../src/infra/metrics.js";
import { initUserEnvCrypto } from "../src/crypto/user-env.js";
import { registerInternalRunRoutes } from "../src/routes/internal-runs.js";
import {
  ADMISSION_REJECT_REASONS, decideAdmission,
  type AdmissionAsk, type AdmissionStage, type AdmitLimits,
} from "../src/tasks/admission.js";
import { runClaimPorts } from "../src/tasks/run-claim.js";
import { sealRunCredentials } from "../src/tasks/run-secrets.js";
import {
  handOffAssembledRun, type HandOffInput, type HandOffResult,
} from "../src/tasks/run-dispatch.js";
import { sweeperPorts } from "../src/tasks/sweeper.js";
import { startHarness, seedRun, seedSession, type Harness } from "./scenario-harness.js";
import { stubDb, type DbStub } from "./support/db-stub.js";

/** The value of one sample, matched by family name and the labels that identify it. */
function sample(text: string, name: string, labels: Record<string, string> = {}): number {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(`${name}{`)) continue;
    const head = line.slice(0, line.lastIndexOf(" "));
    if (!head.startsWith(`${name}{`)) continue;
    if (!wanted.every((pair) => head.includes(pair))) continue;
    return Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return 0;
}

/** Every labelled sample of one family, added up: what a family moved in total. */
function familySum(text: string, name: string): number {
  let total = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(`${name}{`)) continue;
    total += Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return total;
}

/** What one action moved, as a reader of `/metrics` would see it. */
/**
 * How far below a nominal lower bound a measured sum may legitimately land.
 *
 * `delta` reads an accumulating histogram sum before and after, so what it
 * returns is a difference of two floats, not the observations themselves. Three
 * observations of exactly 10, 20 and 30 seconds subtract to 59.99999999999999
 * whenever the accumulator's earlier value has the wrong fractional part -- a
 * property of what ran before, and so of wall-clock timing, which is why it
 * shows up on a loaded machine and not on an idle one. The bound is about
 * telling one sojourn from three, and a hundredth of a second does not blur it.
 */
const SUM_EPSILON = 0.01;

async function delta(
  act: () => unknown,
  probes: ReadonlyArray<{ name: string; labels?: Record<string, string> }>,
): Promise<number[]> {
  const before = await registry.metrics();
  await act();
  const after = await registry.metrics();
  return probes.map((p) =>
    sample(after, p.name, p.labels) - sample(before, p.name, p.labels));
}

/** The same, for whole families: what a boundary case must leave untouched. */
async function familyDelta(act: () => unknown, names: readonly string[]): Promise<number[]> {
  const before = await registry.metrics();
  await act();
  const after = await registry.metrics();
  return names.map((name) => familySum(after, name) - familySum(before, name));
}

const DECISION = "claw_api_admission_decision_total";
const REJECTED = "claw_api_admission_rejected_total";
const DISPATCH = "claw_api_run_dispatch_total";
const HELD = "claw_api_run_dispatch_held_total";
const CLAIM = "claw_api_run_claim_total";
const SKIPPED = "claw_api_run_claim_skipped_total";
const EXHAUSTED = "claw_api_run_claim_exhausted_total";
const UNCLAIM = "claw_api_run_unclaim_total";
const FAILCLAIM = "claw_api_run_fail_claim_total";
const MESSAGE_DISPATCHED = "claw_api_message_dispatched_total";
const ENTERED = "claw_api_run_queue_entered_total";
const WAIT = "claw_api_run_queue_wait_seconds";
const EXITED = "claw_api_run_queue_exited_total";

test("a claimed exit with a marker books the exit and one observed wait", async () => {
  const marker = new Date(Date.now() - 45_000).toISOString();
  const [exits, count, sum] = await delta(
    () => metrics.observeQueueExit("chat", marker, "claimed"),
    [
      { name: EXITED, labels: { outcome: "claimed" } },
      { name: `${WAIT}_count`, labels: { origin: "chat", outcome: "claimed" } },
      { name: `${WAIT}_sum`, labels: { origin: "chat", outcome: "claimed" } },
    ],
  );
  assert.equal(exits, 1);
  assert.equal(count, 1);
  assert.ok(
    sum >= 45 - SUM_EPSILON && sum < 50,
    `expected roughly 45s of wait, got ${sum}`,
  );
});

test("a claimed exit without a marker still books the exit and observes nothing", async () => {
  const [exits, count] = await delta(
    () => metrics.observeQueueExit("chat", null, "claimed"),
    [
      { name: EXITED, labels: { outcome: "claimed" } },
      { name: `${WAIT}_count`, labels: { origin: "chat", outcome: "claimed" } },
    ],
  );
  assert.equal(exits, 1);
  assert.equal(count, 0);
});

test("an unparseable marker is not a zero-length wait", async () => {
  const [exits, count] = await delta(
    () => metrics.observeQueueExit("chat", "not-a-timestamp", "timed_out"),
    [
      { name: EXITED, labels: { outcome: "timed_out" } },
      { name: `${WAIT}_count`, labels: { origin: "chat", outcome: "timed_out" } },
    ],
  );
  assert.equal(exits, 1);
  assert.equal(count, 0);
});

test("the five exits that cannot measure a wait count only", async () => {
  const marker = new Date(Date.now() - 60_000).toISOString();
  for (const outcome of [
    "budget_exhausted", "duplicate_closed", "dispatch_failed", "chat_closed", "cancelled",
  ] as const) {
    const [exits, count] = await delta(
      () => metrics.observeQueueExit("chat", marker, outcome),
      [
        { name: EXITED, labels: { outcome } },
        { name: `${WAIT}_count`, labels: { origin: "chat", outcome } },
      ],
    );
    assert.equal(exits, 1, `${outcome} should book one exit`);
    assert.equal(count, 0, `${outcome} cannot read the marker and must observe nothing`);
  }
});

test("a marker re-stamped between sojourns is measured per sojourn, not cumulatively", async () => {
  const [count, sum] = await delta(
    () => {
      for (const seconds of [10, 20, 30]) {
        metrics.observeQueueExit(
          "chat", new Date(Date.now() - seconds * 1000).toISOString(), "claimed",
        );
      }
    },
    [
      { name: `${WAIT}_count`, labels: { origin: "chat", outcome: "claimed" } },
      { name: `${WAIT}_sum`, labels: { origin: "chat", outcome: "claimed" } },
    ],
  );
  assert.equal(count, 3);
  // A cumulative marker would put 10 + 30 + 60 here; three sojourns put 60.
  assert.ok(
    sum >= 60 - SUM_EPSILON && sum < 65,
    `expected the three waits to sum to about 60s, got ${sum}`,
  );
});

test("a marker ahead of this pod's clock reads as no wait rather than a negative one", async () => {
  const [count, sum] = await delta(
    () => metrics.observeQueueExit(
      "task", new Date(Date.now() + 30_000).toISOString(), "claimed",
    ),
    [
      { name: `${WAIT}_count`, labels: { origin: "task", outcome: "claimed" } },
      { name: `${WAIT}_sum`, labels: { origin: "task", outcome: "claimed" } },
    ],
  );
  assert.equal(count, 1);
  assert.equal(sum, 0);
});

test("row-count increments move by the row count, not by one", async () => {
  const [requeued, entered] = await delta(
    () => {
      metrics.onDoorbellLeaseRequeued(7);
      metrics.onQueueEntered("requeue", 7);
    },
    [
      { name: "claw_api_doorbell_lease_requeued_total" },
      { name: ENTERED, labels: { cause: "requeue" } },
    ],
  );
  assert.equal(requeued, 7);
  assert.equal(entered, 7);
});

test("a zero-row sweep increments nothing", async () => {
  const [requeued, entered, exits] = await delta(
    () => {
      metrics.onDoorbellLeaseRequeued(0);
      metrics.onQueueEntered("requeue", 0);
      metrics.onQueueExited("duplicate_closed", 0);
    },
    [
      { name: "claw_api_doorbell_lease_requeued_total" },
      { name: ENTERED, labels: { cause: "requeue" } },
      { name: EXITED, labels: { outcome: "duplicate_closed" } },
    ],
  );
  assert.deepEqual([requeued, entered, exits], [0, 0, 0]);
});

/** One helper, the series its two calls must land on, and nothing else. */
const TWICE: ReadonlyArray<{
  what: string;
  call: () => void;
  name: string;
  labels: Record<string, string>;
}> = [
  {
    what: "onSessionCreated",
    call: () => metrics.onSessionCreated("ok"),
    name: "claw_api_session_created_total", labels: { outcome: "ok" },
  },
  {
    what: "onSessionDeleted",
    call: () => metrics.onSessionDeleted("ok"),
    name: "claw_api_session_deleted_total", labels: { outcome: "ok" },
  },
  {
    what: "onMessageDispatched",
    call: () => metrics.onMessageDispatched("error"),
    name: "claw_api_message_dispatched_total", labels: { outcome: "error" },
  },
  {
    what: "onEventPersisted",
    call: () => metrics.onEventPersisted("error"),
    name: "claw_api_event_persisted_total", labels: { outcome: "error" },
  },
  {
    what: "onAdmissionDecision",
    call: () => metrics.onAdmissionDecision("a2a", "admit"),
    name: DECISION, labels: { origin: "a2a", decision: "admit" },
  },
  {
    what: "onAdmissionRejected",
    call: () => metrics.onAdmissionRejected("a2a", "post_insert", "tree_depth_exceeded"),
    name: REJECTED, labels: { origin: "a2a", stage: "post_insert", reason: "tree_depth_exceeded" },
  },
  {
    what: "onRunDispatch",
    call: () => metrics.onRunDispatch("pending", "publish_unknown"),
    name: DISPATCH, labels: { path: "pending", outcome: "publish_unknown" },
  },
  {
    what: "onRunDispatchHeld",
    call: () => metrics.onRunDispatchHeld("doorbell_publish_failed"),
    name: HELD, labels: { cause: "doorbell_publish_failed" },
  },
  {
    what: "onRunClaim",
    call: () => metrics.onRunClaim("by_id", "unclaimable"),
    name: CLAIM, labels: { mode: "by_id", outcome: "unclaimable" },
  },
  {
    what: "onRunClaimSkipped",
    call: () => metrics.onRunClaimSkipped("deferred"),
    name: SKIPPED, labels: { cause: "deferred" },
  },
  {
    what: "onRunClaimExhausted",
    call: () => metrics.onRunClaimExhausted("by_id", "max_retries_exceeded"),
    name: EXHAUSTED, labels: { mode: "by_id", reason: "max_retries_exceeded" },
  },
  {
    what: "onRunUnclaim",
    call: () => metrics.onRunUnclaim("hydrate_failed", "not_holder"),
    name: UNCLAIM, labels: { reason: "hydrate_failed", outcome: "not_holder" },
  },
  {
    what: "onRunFailClaim",
    call: () => metrics.onRunFailClaim("workspace_unbound", "not_holder"),
    name: FAILCLAIM, labels: { reason: "workspace_unbound", outcome: "not_holder" },
  },
  {
    what: "onQueueEntered",
    call: () => metrics.onQueueEntered("direct"),
    name: ENTERED, labels: { cause: "direct" },
  },
  {
    what: "onQueueExited",
    call: () => metrics.onQueueExited("chat_closed"),
    name: EXITED, labels: { outcome: "chat_closed" },
  },
  {
    what: "observeQueueExit",
    call: () => metrics.observeQueueExit("dag_node", null, "budget_exhausted"),
    name: EXITED, labels: { outcome: "budget_exhausted" },
  },
  {
    what: "onQueueTimeout",
    call: () => metrics.onQueueTimeout("false"),
    name: "claw_api_run_queue_timeout_total", labels: { ever_held: "false" },
  },
  {
    what: "onDoorbellLeaseRequeued",
    call: () => metrics.onDoorbellLeaseRequeued(1),
    name: "claw_api_doorbell_lease_requeued_total", labels: {},
  },
];

test("calling every helper twice moves its series by exactly two", async () => {
  for (const helper of TWICE) {
    const [moved] = await delta(
      () => { helper.call(); helper.call(); },
      [{ name: helper.name, labels: helper.labels }],
    );
    assert.equal(moved, 2, `${helper.what} should move its series by two`);
  }
});

test("the two ever_held values are separate series", async () => {
  const [held, notHeld] = await delta(
    () => metrics.onQueueTimeout("true"),
    [
      { name: "claw_api_run_queue_timeout_total", labels: { ever_held: "true" } },
      { name: "claw_api_run_queue_timeout_total", labels: { ever_held: "false" } },
    ],
  );
  assert.equal(held, 1);
  assert.equal(notHeld, 0);
});

const TOKEN = "cluster-internal-token";
const originalEnvToken = process.env.AUTH_INTERNAL_TOKEN;
const originalClaimPorts = { ...runClaimPorts };

/** The session whose history rebuild fails, which is a hydrate fault that is not a credential one. */
const HYDRATE_FAULT_SESSION = "s-history-down";

let app: FastifyInstance;
let blob: string;

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  blob = sealRunCredentials({ llm_api_key: "sk-live", platform_key: "pk-live" });
  runClaimPorts.publishSessionEvent = (async () => {}) as never;
  runClaimPorts.buildHistory = (async (sessionId: string) => {
    if (sessionId === HYDRATE_FAULT_SESSION) throw new Error("history unavailable");
    return [];
  }) as never;
  app = Fastify();
  await registerInternalRunRoutes(app);
  await app.ready();
});

after(async () => {
  Object.assign(runClaimPorts, originalClaimPorts);
  if (originalEnvToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalEnvToken;
  await app.close();
});

const UNLIMITED: AdmitLimits = {
  softRuns: 0, hardRuns: 0,
  softSandboxes: 0, hardSandboxes: 0,
  softGpuNodes: 0, hardGpuNodes: 0,
  treeMaxNodes: 0, treeMaxDepth: 0,
};

const BASE_ASK: AdmissionAsk = { origin: "chat", newRunRoots: 1, sandboxes: 0, gpuNodes: 0 };

const ZERO_USAGE = {
  run_roots: 0, executing_roots: 0,
  sandboxes: 0, executing_sandboxes: 0,
  gpu_nodes: 0, executing_gpu_nodes: 0,
};

interface UsageStub {
  usage?: Record<string, number>;
  ahead?: Record<string, number>;
  queued?: number;
  /** The statement that fails, so a fault reaches the counted funnel from a real query. */
  fail?: RegExp;
}

/** Answer admission's three statements by their normalised SQL. */
function stubUsage(opts: UsageStub = {}): DbStub {
  return stubDb((sql) => {
    if (opts.fail?.test(sql)) throw new Error("pg down");
    if (sql.includes("AS executing_roots")) return [{ ...ZERO_USAGE, ...opts.usage }];
    if (sql.includes("AS n FROM claw_tasks")) return [{ n: opts.queued ?? 0 }];
    if (sql.startsWith("WITH self AS")) {
      return [{ run_roots: 0, sandboxes: 0, gpu_nodes: 0, ...opts.ahead }];
    }
    return [];
  });
}

function rejectProbes(stage: AdmissionStage): Array<{ name: string; labels: Record<string, string> }> {
  return ADMISSION_REJECT_REASONS.map((reason) => ({
    name: REJECTED, labels: { origin: "chat", stage, reason },
  }));
}

const NO_REASONS = ADMISSION_REJECT_REASONS.map(() => 0);

test("an unmetered process admits and counts the admit without touching the database", async () => {
  const stub = stubDb();
  try {
    let decision: unknown;
    const moved = await delta(
      async () => { decision = await decideAdmission({ ...BASE_ASK }); },
      [
        { name: DECISION, labels: { origin: "chat", decision: "admit" } },
        { name: DECISION, labels: { origin: "chat", decision: "queue" } },
        { name: DECISION, labels: { origin: "chat", decision: "reject" } },
        { name: DECISION, labels: { origin: "chat", decision: "error" } },
        ...rejectProbes("pre_insert"),
      ],
    );
    assert.deepEqual(decision, { kind: "admit" });
    assert.deepEqual(moved, [1, 0, 0, 0, ...NO_REASONS]);
    assert.deepEqual(stub.sql(), []);
  } finally {
    stub.restore();
  }
});

test("a soft ceiling below usage queues and counts a queue, not a reject", async () => {
  const stub = stubUsage({ usage: { run_roots: 2, executing_roots: 2 }, queued: 4 });
  try {
    let decision: unknown;
    const [queued, rejected, ...reasons] = await delta(
      async () => {
        decision = await decideAdmission(
          { ...BASE_ASK }, undefined, { ...UNLIMITED, softRuns: 2 },
        );
      },
      [
        { name: DECISION, labels: { origin: "chat", decision: "queue" } },
        { name: DECISION, labels: { origin: "chat", decision: "reject" } },
        ...rejectProbes("pre_insert"),
      ],
    );
    assert.deepEqual(decision, { kind: "queue", position: 5 });
    assert.equal(queued, 1);
    assert.equal(rejected, 0);
    assert.deepEqual(reasons, NO_REASONS);
  } finally {
    stub.restore();
  }
});

const REJECT_CASES = [
  {
    what: "a runs ceiling already full",
    ask: {}, limits: { hardRuns: 1 }, usage: { run_roots: 1 },
    reason: "runs_hard_limit", queries: 1,
  },
  {
    what: "a sandbox ceiling already full",
    ask: { sandboxes: 1 }, limits: { hardSandboxes: 1 }, usage: { sandboxes: 1 },
    reason: "sandboxes_hard_limit", queries: 1,
  },
  {
    what: "a GPU-node ceiling already full",
    ask: { gpuNodes: 2 }, limits: { hardGpuNodes: 2 }, usage: { gpu_nodes: 1 },
    reason: "gpu_nodes_hard_limit", queries: 1,
  },
  {
    what: "a tree wider than its cap",
    ask: { treeNodeCount: 9 }, limits: { hardRuns: 1, treeMaxNodes: 8 }, usage: {},
    reason: "tree_nodes_exceeded", queries: 0,
  },
  {
    what: "a tree deeper than its cap",
    ask: { treeDepth: 4 }, limits: { hardRuns: 1, treeMaxDepth: 3 }, usage: {},
    reason: "tree_depth_exceeded", queries: 0,
  },
] as const;

for (const c of REJECT_CASES) {
  test(`${c.what} is refused, counted once, and named at pre_insert`, async () => {
    const stub = stubUsage({ usage: { ...c.usage } });
    try {
      let decision: unknown;
      const [rejects, named, atPostInsert] = await delta(
        async () => {
          decision = await decideAdmission(
            { ...BASE_ASK, ...c.ask }, undefined, { ...UNLIMITED, ...c.limits },
          );
        },
        [
          { name: DECISION, labels: { origin: "chat", decision: "reject" } },
          { name: REJECTED, labels: { origin: "chat", stage: "pre_insert", reason: c.reason } },
          { name: REJECTED, labels: { origin: "chat", stage: "post_insert", reason: c.reason } },
        ],
      );
      assert.deepEqual(decision, { kind: "reject", reason: c.reason });
      assert.equal(rejects, 1);
      assert.equal(named, 1);
      assert.equal(atPostInsert, 0);
      assert.equal(stub.sql().length, c.queries);
    } finally {
      stub.restore();
    }
  });
}

const FAULT_CASES = [
  { what: "a usage read", fail: /AS executing_roots/, limits: { hardRuns: 5 }, usage: {} },
  {
    what: "a queue-length read", fail: /AS n FROM claw_tasks/,
    limits: { softRuns: 1 }, usage: { run_roots: 1, executing_roots: 1 },
  },
] as const;

for (const c of FAULT_CASES) {
  test(`${c.what} that faults counts an error and still propagates`, async () => {
    const stub = stubUsage({ usage: { ...c.usage }, fail: c.fail });
    try {
      const [errors, admits, queues, rejects, ...reasons] = await delta(
        () => assert.rejects(
          () => decideAdmission({ ...BASE_ASK }, undefined, { ...UNLIMITED, ...c.limits }),
          /pg down/,
        ),
        [
          { name: DECISION, labels: { origin: "chat", decision: "error" } },
          { name: DECISION, labels: { origin: "chat", decision: "admit" } },
          { name: DECISION, labels: { origin: "chat", decision: "queue" } },
          { name: DECISION, labels: { origin: "chat", decision: "reject" } },
          ...rejectProbes("pre_insert"),
        ],
      );
      assert.equal(errors, 1);
      assert.deepEqual([admits, queues, rejects], [0, 0, 0]);
      assert.deepEqual(reasons, NO_REASONS);
    } finally {
      stub.restore();
    }
  });
}

const TASK = {
  prompt: "hello",
  session_id: "s-1",
  llm_api_key: "sk-live",
  platform_key: "pk-live",
};

const OPENED = { taskId: "ktsk_1" };

function handOff(over: Partial<HandOffInput> = {}): Promise<HandOffResult> {
  return handOffAssembledRun({
    task: { ...TASK },
    sessionId: "s-1",
    userId: "u-1",
    messageId: "claw-1",
    prompt: "hello",
    limits: UNLIMITED,
    publish: async () => {},
    openRun: (async () => OPENED) as never,
    ...over,
  });
}

test("the doorbell publish call site counts both broker outcomes", async () => {
  const stub = stubUsage();
  try {
    const moved = await delta(
      async () => {
        assert.equal((await handOff()).kind, "dispatched");
        await assert.rejects(
          () => handOff({
            publish: async () => { throw new Error("nats down"); },
            failRun: async () => "unknown",
          }),
          /nats down/,
        );
      },
      [
        { name: MESSAGE_DISPATCHED, labels: { outcome: "ok" } },
        { name: MESSAGE_DISPATCHED, labels: { outcome: "error" } },
      ],
    );
    assert.deepEqual(moved, [1, 1]);
  } finally {
    stub.restore();
  }
});

test("a real post-insert refusal books post_insert and does not re-book a decision", async () => {
  const stub = stubUsage({ ahead: { run_roots: 1 } });
  try {
    let result: HandOffResult | undefined;
    const [postInsert, rejects, admits, dispatched] = await delta(
      async () => {
        result = await handOff({
          limits: { ...UNLIMITED, hardRuns: 1 },
          discardRun: async () => "closed" as const,
        });
      },
      [
        { name: REJECTED, labels: { origin: "chat", stage: "post_insert", reason: "runs_hard_limit" } },
        { name: DECISION, labels: { origin: "chat", decision: "reject" } },
        { name: DECISION, labels: { origin: "chat", decision: "admit" } },
        { name: DISPATCH, labels: { path: "chat", outcome: "rejected" } },
      ],
    );
    assert.deepEqual(result, { kind: "rejected", reason: "runs_hard_limit", taskId: "ktsk_1" });
    assert.equal(postInsert, 1);
    assert.equal(rejects, 0);
    assert.equal(admits, 1);
    assert.equal(dispatched, 1);
  } finally {
    stub.restore();
  }
});

const HAND_OFF_CEILINGS = [
  {
    what: "a soft runs ceiling",
    limits: { softRuns: 1 }, usage: { run_roots: 1, executing_roots: 1 },
    task: {}, outcome: "queued", decision: "queue", reason: null,
  },
  {
    what: "a hard runs ceiling",
    limits: { hardRuns: 1 }, usage: { run_roots: 1 },
    task: {}, outcome: "rejected", decision: "reject", reason: "runs_hard_limit",
  },
  {
    what: "a hard sandbox ceiling",
    limits: { hardSandboxes: 1 }, usage: { sandboxes: 1 },
    task: { sandbox_image: "rocm:6" }, outcome: "rejected", decision: "reject",
    reason: "sandboxes_hard_limit",
  },
  {
    what: "a hard GPU-node ceiling",
    limits: { hardGpuNodes: 2 }, usage: { gpu_nodes: 1 },
    task: { topology: { nodes: 2 } }, outcome: "rejected", decision: "reject",
    reason: "gpu_nodes_hard_limit",
  },
] as const;

for (const c of HAND_OFF_CEILINGS) {
  test(`${c.what} reaches the instrumented decision through the hand-off`, async () => {
    const stub = stubUsage({ usage: { ...c.usage } });
    const published: string[] = [];
    const opened: unknown[] = [];
    try {
      let result: HandOffResult | undefined;
      const [decided, named, dispatched] = await delta(
        async () => {
          result = await handOff({
            task: { ...TASK, ...c.task },
            limits: { ...UNLIMITED, ...c.limits },
            publish: async (subject) => { published.push(subject); },
            openRun: (async (input: unknown) => { opened.push(input); return OPENED; }) as never,
          });
        },
        [
          { name: DECISION, labels: { origin: "chat", decision: c.decision } },
          {
            name: REJECTED,
            labels: { origin: "chat", stage: "pre_insert", reason: c.reason ?? "runs_hard_limit" },
          },
          { name: DISPATCH, labels: { path: "chat", outcome: c.outcome } },
        ],
      );
      assert.equal(result?.kind, c.outcome);
      assert.equal(decided, 1);
      assert.equal(named, c.reason ? 1 : 0);
      assert.equal(dispatched, 1);
      assert.deepEqual(published, []);
      assert.equal(opened.length, c.reason ? 0 : 1);
    } finally {
      stub.restore();
    }
  });
}

test("mixed traffic keeps the failure share's denominator whole", async () => {
  const stub = stubUsage({ usage: { run_roots: 1, executing_roots: 1 } });
  const failing = { publish: async () => { throw new Error("nats down"); }, failRun: async () => "unknown" as const };
  try {
    const moved = await delta(
      async () => {
        for (let i = 0; i < 3; i++) await handOff();
        for (let i = 0; i < 2; i++) await handOff({ limits: { ...UNLIMITED, softRuns: 1 } });
        for (let i = 0; i < 2; i++) await handOff({ limits: { ...UNLIMITED, hardRuns: 1 } });
        await handOff({ openRun: (async () => null) as never });
        for (let i = 0; i < 2; i++) {
          await assert.rejects(() => handOff(failing), /nats down/);
        }
      },
      (["dispatched", "queued", "rejected", "open_failed", "error"] as const)
        .map((outcome) => ({ name: DISPATCH, labels: { path: "chat", outcome } })),
    );
    assert.deepEqual(moved, [3, 2, 2, 1, 2]);
    const total = moved.reduce((a, b) => a + b, 0);
    assert.equal(total, 10);
    assert.equal((moved[3] + moved[4]) / total, 3 / 10);
  } finally {
    stub.restore();
  }
});

const RESULT_KINDS = ["dispatched", "queued", "rejected", "publish_unknown", "open_failed"] as const;

function inputForKind(kind: (typeof RESULT_KINDS)[number], path: DispatchPath): Partial<HandOffInput> {
  if (kind === "queued") return { path, limits: { ...UNLIMITED, softRuns: 1 } };
  if (kind === "rejected") return { path, limits: { ...UNLIMITED, hardRuns: 1 } };
  if (kind === "open_failed") return { path, openRun: (async () => null) as never };
  if (kind === "publish_unknown") {
    return { path, openRun: (async () => ({ ...OPENED, reconcileToken: "claim-taken" })) as never };
  }
  return { path };
}

for (const path of ["chat", "pending"] as const) {
  for (const kind of RESULT_KINDS) {
    test(`a ${kind} hand-off on the ${path} path counts only that pair`, async () => {
      const stub = stubUsage({ usage: { run_roots: 1, executing_roots: 1 } });
      try {
        const probes = (["chat", "pending"] as const).flatMap((p) =>
          RESULT_KINDS.map((k) => ({ name: DISPATCH, labels: { path: p, outcome: k } })));
        const moved = await delta(
          async () => {
            const result = await handOff(inputForKind(kind, path));
            assert.equal(result.kind, kind);
          },
          probes,
        );
        const expected = probes.map((p) =>
          p.labels.path === path && p.labels.outcome === kind ? 1 : 0);
        assert.deepEqual(moved, expected);
      } finally {
        stub.restore();
      }
    });
  }
}

const THROW_CASES = [
  {
    what: "an admission that throws",
    stub: {} as UsageStub,
    input: { admit: async () => { throw new Error("admit blew up"); } } as Partial<HandOffInput>,
    message: /admit blew up/,
  },
  {
    what: "a post-insert recheck that throws",
    stub: { fail: /^WITH self AS/ } as UsageStub,
    input: {
      limits: { ...UNLIMITED, hardRuns: 1 },
      failRun: async () => "unknown" as const,
    } as Partial<HandOffInput>,
    message: /pg down/,
  },
  {
    what: "a doorbell publish that throws",
    stub: {} as UsageStub,
    input: {
      publish: async () => { throw new Error("nats down"); },
      failRun: async () => "unknown" as const,
    } as Partial<HandOffInput>,
    message: /nats down/,
  },
] as const;

for (const c of THROW_CASES) {
  test(`${c.what} counts an error and still propagates`, async () => {
    const stub = stubUsage(c.stub);
    try {
      const [errors, ...heldCauses] = await delta(
        () => assert.rejects(() => handOff({ ...c.input }), c.message),
        [
          { name: DISPATCH, labels: { path: "chat", outcome: "error" } },
          ...(["hard_limit_exceeded", "hard_limit_recheck_threw", "doorbell_publish_failed"] as const)
            .map((cause) => ({ name: HELD, labels: { cause } })),
        ],
      );
      assert.equal(errors, 1);
      assert.deepEqual(heldCauses, [0, 0, 0]);
    } finally {
      stub.restore();
    }
  });
}

const HELD_CASES = [
  {
    what: "a post-insert refusal",
    stub: { ahead: { run_roots: 1 } } as UsageStub,
    input: {
      limits: { ...UNLIMITED, hardRuns: 1 },
      discardRun: async () => "held" as const,
    } as Partial<HandOffInput>,
    cause: "hard_limit_exceeded",
  },
  {
    what: "a recheck that threw",
    stub: { fail: /^WITH self AS/ } as UsageStub,
    input: {
      limits: { ...UNLIMITED, hardRuns: 1 },
      failRun: async () => "held" as const,
    } as Partial<HandOffInput>,
    cause: "hard_limit_recheck_threw",
  },
  {
    what: "a publish that failed",
    stub: {} as UsageStub,
    input: {
      publish: async () => { throw new Error("nats down"); },
      failRun: async () => "held" as const,
    } as Partial<HandOffInput>,
    cause: "doorbell_publish_failed",
  },
] as const;

const HELD_CAUSES = ["hard_limit_exceeded", "hard_limit_recheck_threw", "doorbell_publish_failed"] as const;

for (const c of HELD_CASES) {
  test(`${c.what} over a row a worker holds is counted as the dispatch it is`, async () => {
    const stub = stubUsage(c.stub);
    try {
      let result: HandOffResult | undefined;
      const moved = await delta(
        async () => { result = await handOff({ ...c.input }); },
        [
          ...HELD_CAUSES.map((cause) => ({ name: HELD, labels: { cause } })),
          { name: DISPATCH, labels: { path: "chat", outcome: "dispatched" } },
          { name: DISPATCH, labels: { path: "chat", outcome: "error" } },
        ],
      );
      assert.deepEqual(result, { kind: "dispatched", taskId: "ktsk_1", messageId: "claw-1" });
      assert.deepEqual(moved, [
        ...HELD_CAUSES.map((cause) => (cause === c.cause ? 1 : 0)), 1, 0,
      ]);
    } finally {
      stub.restore();
    }
  });
}

type ClaimShape =
  | "claimed" | "claimed_from_queue" | "missing" | "busy" | "unclaimable"
  | "hydrate_error" | "exhausted_contention" | "exhausted_retries";

function claimRowFor(shape: ClaimShape, taskId: string): Record<string, unknown> {
  const row: Record<string, unknown> = {
    task_id: taskId,
    session_id: "s-1",
    status: "preparing",
    deadline_at: null,
    claim_count: 1,
    metadata: { message_id: `m-${taskId}` },
    input: { prompt: "hello", session_id: "s-1", user_id: "u-1", credentials: blob },
  };
  // `claimed_from_queue` differs from `claimed` only in where the row came
  // from, which is the prior read's answer rather than the claim's -- see
  // priorStateFor.
  if (shape === "unclaimable") {
    return { ...row, input: { prompt: "hello", session_id: "s-1", user_id: "u-1" } };
  }
  if (shape === "hydrate_error") return { ...row, session_id: HYDRATE_FAULT_SESSION };
  if (shape === "exhausted_contention") {
    return {
      ...row, claim_count: 999,
      metadata: { message_id: `m-${taskId}`, last_release: "lock_contention" },
    };
  }
  if (shape === "exhausted_retries") return { ...row, claim_count: 999 };
  return row;
}

interface ClaimStub {
  /** Candidates `peekNextQueued` may offer, minus whatever the loop has skipped. */
  queue?: string[];
  shape?: (taskId: string) => ClaimShape;
  fail?: RegExp;
  releaseRows?: number;
  failClaimRows?: number;
}

/**
 * The pre-claim state, which the claim reads under its own lock.
 *
 * It cannot come off the claim's own UPDATE: `RETURNING` answers with what the
 * row became, and whether this was a queue exit is a fact about what it was.
 */
function priorStateFor(shape: ClaimShape): Record<string, unknown> {
  return shape === "claimed_from_queue"
    ? { prior_status: "queued", queued_since: new Date(Date.now() - 5_000).toISOString() }
    : { prior_status: "preparing", queued_since: null };
}

/**
 * The task id a statement names.
 *
 * `applyTaskStatusTransition` numbers its own values before the caller's, so
 * `$1` is the writer's first value rather than the call site's. Read the
 * placeholder the predicate actually uses instead of a fixed index.
 */
function taskIdOf(sql: string, params: unknown[]): string {
  const at = sql.match(/task_id = \$(\d+)/);
  return String((at ? params[Number(at[1]) - 1] : params[0]) ?? "");
}

/** Answer the claim path's statements the way a database holding those rows would. */
function stubClaims(opts: ClaimStub = {}): DbStub {
  const shapeOf = opts.shape ?? (() => "claimed" as ClaimShape);
  const claimShape = new Map<string, ClaimShape>();
  return stubDb((sql, params) => {
    if (opts.fail?.test(sql)) throw new Error("pg down");
    if (sql.startsWith("SELECT task_id FROM claw_tasks")) {
      const skip = (params[0] as string[] | undefined) ?? [];
      const next = (opts.queue ?? []).find((id) => !skip.includes(id));
      return next ? [{ task_id: next }] : [];
    }
    const taskId = taskIdOf(sql, params);
    // One claim sees one row state. The prior read takes the lock and the
    // write and the diagnostic that follow it report under that same lock, so
    // the shape is decided once per claim rather than once per statement --
    // otherwise a `shape` callback that advances, which is how a race is
    // written here, advances twice for a single claim and the claimer that
    // won reads as the one that lost.
    if (sql.startsWith("SELECT status AS prior_status")) {
      const fresh = shapeOf(taskId);
      claimShape.set(taskId, fresh);
      return fresh === "missing" ? [] : [priorStateFor(fresh)];
    }
    const shape = () => claimShape.get(taskId) ?? shapeOf(taskId);
    if (sql.startsWith("UPDATE claw_tasks SET status = 'preparing'")) {
      const s = shape();
      return s === "missing" || s === "busy" ? [] : [claimRowFor(s, taskId)];
    }
    if (sql.startsWith("SELECT status, lease_expires_at")) {
      return shape() === "missing" ? [] : [{ status: "preparing", lease_expires_at: null }];
    }
    if (sql.includes("SET status = 'queued'")) {
      return (opts.releaseRows ?? 1) > 0 ? [{ task_id: taskId }] : [];
    }
    // One writer means one spelling, so the three ways a claim can end in
    // `failed` are told apart by the fence each carries rather than by which
    // `$n` the reason took: only the held-claim path asks whether this brain
    // is still the holder. `lease_owner` appears in every SET, so the match
    // has to be on the predicate.
    if (sql.includes("SET status = 'failed'")) {
      return /WHERE .*lease_owner = \$\d+/.test(sql)
        ? ((opts.failClaimRows ?? 1) > 0 ? [{ task_id: taskId }] : [])
        : [{ task_id: taskId }];
    }
    return [];
  });
}

function post(url: string, payload: Record<string, unknown>): ReturnType<FastifyInstance["inject"]> {
  return app.inject({
    method: "POST", url, headers: { authorization: `Bearer ${TOKEN}` }, payload,
  });
}

const BY_ID_CASES = [
  { what: "a free row", shape: "claimed", status: 200, error: null, outcome: "claimed", exhaustion: null },
  { what: "a row that is gone", shape: "missing", status: 404, error: "not_found", outcome: "missing", exhaustion: null },
  { what: "a row somebody else holds", shape: "busy", status: 409, error: "busy", outcome: "busy", exhaustion: null },
  {
    what: "a row whose spec will not open", shape: "unclaimable", status: 422,
    error: "unclaimable", outcome: "unclaimable", exhaustion: null,
  },
  {
    what: "a row out of claims after a busy workspace", shape: "exhausted_contention",
    status: 422, error: "lock_contention_exhausted", outcome: "exhausted",
    exhaustion: "lock_contention_exhausted",
  },
  {
    what: "a row out of claims after repeated retries", shape: "exhausted_retries",
    status: 422, error: "max_retries_exceeded", outcome: "exhausted",
    exhaustion: "max_retries_exceeded",
  },
] as const;

for (const c of BY_ID_CASES) {
  test(`claiming ${c.what} answers ${c.status} and counts ${c.outcome} under by_id`, async () => {
    const stub = stubClaims({ shape: () => c.shape });
    try {
      let res: Awaited<ReturnType<typeof post>> | undefined;
      const [outcome, exhausted] = await delta(
        async () => {
          res = await post("/v1/internal/tasks/ktsk_1/claim", { brain_id: "brain-7" });
        },
        [
          { name: CLAIM, labels: { mode: "by_id", outcome: c.outcome } },
          {
            name: EXHAUSTED,
            labels: { mode: "by_id", reason: c.exhaustion ?? "max_retries_exceeded" },
          },
        ],
      );
      assert.equal(res?.statusCode, c.status);
      if (c.error) assert.equal(res?.json().error, c.error);
      assert.equal(outcome, 1);
      assert.equal(exhausted, c.exhaustion ? 1 : 0);
    } finally {
      stub.restore();
    }
  });
}

const SKIP_CAUSES = ["raced", "unclaimable", "deferred", "exhausted", "error"] as const;

function skipProbes(): Array<{ name: string; labels: Record<string, string> }> {
  return SKIP_CAUSES.map((cause) => ({ name: SKIPPED, labels: { cause } }));
}

test("a claim-next that takes a row counts a claim and skips nothing", async () => {
  const stub = stubClaims({ queue: ["ktsk_1"] });
  try {
    let res: Awaited<ReturnType<typeof post>> | undefined;
    const [claimed, ...skips] = await delta(
      async () => { res = await post("/v1/internal/runs/claim-next", { brain_id: "brain-7" }); },
      [{ name: CLAIM, labels: { mode: "next", outcome: "claimed" } }, ...skipProbes()],
    );
    assert.equal(res?.statusCode, 200);
    assert.ok(res?.json().request);
    assert.equal(claimed, 1);
    assert.deepEqual(skips, [0, 0, 0, 0, 0]);
  } finally {
    stub.restore();
  }
});

test("an empty queue counts empty rather than all_skipped", async () => {
  const stub = stubClaims({ queue: [] });
  try {
    let res: Awaited<ReturnType<typeof post>> | undefined;
    const [empty, allSkipped, ...skips] = await delta(
      async () => { res = await post("/v1/internal/runs/claim-next", { brain_id: "brain-7" }); },
      [
        { name: CLAIM, labels: { mode: "next", outcome: "empty" } },
        { name: CLAIM, labels: { mode: "next", outcome: "all_skipped" } },
        ...skipProbes(),
      ],
    );
    assert.equal(res?.statusCode, 200);
    assert.equal(res?.json().request, null);
    assert.equal(empty, 1);
    assert.equal(allSkipped, 0);
    assert.deepEqual(skips, [0, 0, 0, 0, 0]);
  } finally {
    stub.restore();
  }
});

const CLAIM_FAULTS = [
  {
    what: "a by-id claim", url: "/v1/internal/tasks/ktsk_1/claim",
    fail: /^SELECT status AS prior_status/, mode: "by_id", other: "next",
  },
  {
    what: "the claim-next peek", url: "/v1/internal/runs/claim-next",
    fail: /^SELECT task_id FROM claw_tasks/, mode: "next", other: "by_id",
  },
] as const;

for (const c of CLAIM_FAULTS) {
  test(`${c.what} that faults counts an error under ${c.mode} and reaches Fastify`, async () => {
    const stub = stubClaims({ queue: ["ktsk_1"], fail: c.fail });
    try {
      let res: Awaited<ReturnType<typeof post>> | undefined;
      const [mine, theirs] = await delta(
        async () => { res = await post(c.url, { brain_id: "brain-7" }); },
        [
          { name: CLAIM, labels: { mode: c.mode, outcome: "error" } },
          { name: CLAIM, labels: { mode: c.other, outcome: "error" } },
        ],
      );
      assert.equal(res?.statusCode, 500);
      assert.equal(mine, 1);
      assert.equal(theirs, 0);
    } finally {
      stub.restore();
    }
  });
}

// CLAIM_NEXT_ATTEMPTS in run-claim.ts, which does not export it.
const CLAIM_NEXT_ATTEMPTS = 8;

test("fewer skips than the attempt limit is all_skipped, not retry_limit", async () => {
  const shapes: Record<string, ClaimShape> = {
    "t-missing": "missing",
    "t-busy": "busy",
    "t-unclaimable": "unclaimable",
    "t-lock": "exhausted_contention",
    "t-retries": "exhausted_retries",
    "t-history": "hydrate_error",
  };
  const stub = stubClaims({ queue: Object.keys(shapes), shape: (id) => shapes[id] });
  try {
    let res: Awaited<ReturnType<typeof post>> | undefined;
    const [raced, unclaimable, deferred, exhausted, errored, lock, retries, all, limit] =
      await delta(
        async () => { res = await post("/v1/internal/runs/claim-next", { brain_id: "brain-7" }); },
        [
          ...skipProbes(),
          { name: EXHAUSTED, labels: { mode: "next", reason: "lock_contention_exhausted" } },
          { name: EXHAUSTED, labels: { mode: "next", reason: "max_retries_exceeded" } },
          { name: CLAIM, labels: { mode: "next", outcome: "all_skipped" } },
          { name: CLAIM, labels: { mode: "next", outcome: "retry_limit" } },
        ],
      );
    assert.equal(res?.statusCode, 200);
    assert.equal(res?.json().request, null);
    assert.deepEqual([raced, unclaimable, deferred, exhausted, errored], [2, 1, 0, 2, 1]);
    assert.deepEqual([lock, retries], [1, 1]);
    assert.deepEqual([all, limit], [1, 0]);
    const skips = raced + unclaimable + exhausted + errored;
    assert.ok(
      skips < CLAIM_NEXT_ATTEMPTS,
      `all_skipped must be reached below the attempt limit, took ${skips}`,
    );
  } finally {
    stub.restore();
  }
});

test("exhausting every attempt is retry_limit, not all_skipped", async () => {
  const queue = Array.from({ length: CLAIM_NEXT_ATTEMPTS }, (_, i) => `t-${i}`);
  const stub = stubClaims({ queue, shape: () => "busy" });
  try {
    let res: Awaited<ReturnType<typeof post>> | undefined;
    const [limit, all, raced] = await delta(
      async () => { res = await post("/v1/internal/runs/claim-next", { brain_id: "brain-7" }); },
      [
        { name: CLAIM, labels: { mode: "next", outcome: "retry_limit" } },
        { name: CLAIM, labels: { mode: "next", outcome: "all_skipped" } },
        { name: SKIPPED, labels: { cause: "raced" } },
      ],
    );
    assert.equal(res?.statusCode, 200);
    assert.equal(res?.json().request, null);
    assert.deepEqual([limit, all], [1, 0]);
    assert.equal(raced, CLAIM_NEXT_ATTEMPTS);
  } finally {
    stub.restore();
  }
});

test("two claimers over one queued row leave one exit and one raced skip", async () => {
  let taken = false;
  const stub = stubClaims({
    queue: ["ktsk_1"],
    shape: () => {
      if (taken) return "busy";
      taken = true;
      return "claimed_from_queue";
    },
  });
  try {
    const [claimed, allSkipped, raced, exits] = await delta(
      async () => {
        await post("/v1/internal/runs/claim-next", { brain_id: "brain-a" });
        await post("/v1/internal/runs/claim-next", { brain_id: "brain-b" });
      },
      [
        { name: CLAIM, labels: { mode: "next", outcome: "claimed" } },
        { name: CLAIM, labels: { mode: "next", outcome: "all_skipped" } },
        { name: SKIPPED, labels: { cause: "raced" } },
        { name: EXITED, labels: { outcome: "claimed" } },
      ],
    );
    assert.deepEqual([claimed, allSkipped, raced], [1, 1, 1]);
    assert.equal(exits, 1);
  } finally {
    stub.restore();
  }
});

const UNCLAIM_REASONS = [
  { what: "lock contention", body: { reason: "lock_contention" }, label: "lock_contention" },
  { what: "a retry", body: { reason: "retry" }, label: "retry" },
  { what: "a drain", body: { reason: "drain" }, label: "drain" },
  { what: "a failed hydrate", body: { reason: "hydrate_failed" }, label: "hydrate_failed" },
  { what: "no reason at all", body: {}, label: "unspecified" },
] as const;

for (const c of UNCLAIM_REASONS) {
  test(`an unclaim citing ${c.what} is counted under ${c.label}`, async () => {
    const stub = stubClaims({ releaseRows: 1 });
    try {
      let res: Awaited<ReturnType<typeof post>> | undefined;
      const [accepted] = await delta(
        async () => {
          res = await post("/v1/internal/tasks/ktsk_1/unclaim", { brain_id: "brain-7", ...c.body });
        },
        [{ name: UNCLAIM, labels: { reason: c.label, outcome: "accepted" } }],
      );
      assert.equal(res?.statusCode, 200);
      assert.deepEqual(res?.json(), { ok: true });
      assert.equal(accepted, 1);
    } finally {
      stub.restore();
    }
  });
}

// `unspecified` labels a body that named no reason. A body that names it, or
// anything else outside the protocol set, is refused before any counter moves:
// a label invented from a malformed request measures the client, not the fleet.
test("an unclaim citing a reason nobody defined moves no counter at all", async () => {
  const stub = stubClaims({ releaseRows: 1 });
  try {
    let res: Awaited<ReturnType<typeof post>> | undefined;
    const moved = await delta(
      async () => {
        res = await post("/v1/internal/tasks/ktsk_1/unclaim", {
          brain_id: "brain-7", reason: "nonsense",
        });
      },
      [
        { name: UNCLAIM, labels: { reason: "unspecified", outcome: "accepted" } },
        { name: UNCLAIM, labels: { reason: "unspecified", outcome: "error" } },
      ],
    );
    assert.equal(res?.statusCode, 400);
    assert.equal(res?.json().error, "reason_invalid");
    assert.deepEqual(moved, [0, 0]);
  } finally {
    stub.restore();
  }
});

const GUARDED_WRITES = [
  {
    what: "an unclaim", url: "/v1/internal/tasks/ktsk_1/unclaim",
    body: { reason: "retry" }, name: UNCLAIM, label: "retry",
    stub: { releaseRows: 0 } as ClaimStub, fail: /SET status = 'queued'/,
  },
  {
    what: "a fail-claim", url: "/v1/internal/tasks/ktsk_1/fail-claim",
    body: { reason: "claim_abandoned" }, name: FAILCLAIM, label: "claim_abandoned",
    stub: { failClaimRows: 0 } as ClaimStub,
    fail: /SET status = 'failed'.*WHERE .*lease_owner = \$\d+/,
  },
] as const;

for (const c of GUARDED_WRITES) {
  test(`${c.what} the generation guard refuses is counted as not_holder`, async () => {
    const stub = stubClaims(c.stub);
    try {
      let res: Awaited<ReturnType<typeof post>> | undefined;
      const [notHolder, accepted] = await delta(
        async () => { res = await post(c.url, { brain_id: "brain-7", ...c.body }); },
        [
          { name: c.name, labels: { reason: c.label, outcome: "not_holder" } },
          { name: c.name, labels: { reason: c.label, outcome: "accepted" } },
        ],
      );
      assert.equal(res?.statusCode, 409);
      assert.deepEqual(res?.json(), { ok: false, error: "not_holder" });
      assert.equal(notHolder, 1);
      assert.equal(accepted, 0);
    } finally {
      stub.restore();
    }
  });

  test(`${c.what} whose write faults carries its own reason on the error`, async () => {
    const stub = stubClaims({ fail: c.fail });
    try {
      let res: Awaited<ReturnType<typeof post>> | undefined;
      const [errored, accepted, notHolder, unspecified] = await delta(
        async () => { res = await post(c.url, { brain_id: "brain-7", ...c.body }); },
        [
          { name: c.name, labels: { reason: c.label, outcome: "error" } },
          { name: c.name, labels: { reason: c.label, outcome: "accepted" } },
          { name: c.name, labels: { reason: c.label, outcome: "not_holder" } },
          { name: c.name, labels: { reason: "unspecified", outcome: "error" } },
        ],
      );
      assert.equal(res?.statusCode, 500);
      assert.equal(errored, 1);
      assert.deepEqual([accepted, notHolder], [0, 0]);
      assert.equal(unspecified, 0);
    } finally {
      stub.restore();
    }
  });
}

const CLAIM_FAMILIES = [CLAIM, SKIPPED, EXHAUSTED, UNCLAIM, FAILCLAIM] as const;

test("a request with no brain id is refused before any counter moves", async () => {
  const stub = stubClaims();
  try {
    const responses: Array<{ statusCode: number; body: unknown }> = [];
    const moved = await familyDelta(
      async () => {
        for (const url of [
          "/v1/internal/tasks/ktsk_1/claim",
          "/v1/internal/tasks/ktsk_1/unclaim",
          "/v1/internal/tasks/ktsk_1/fail-claim",
          "/v1/internal/runs/claim-next",
        ]) {
          const res = await post(url, {});
          responses.push({ statusCode: res.statusCode, body: res.json() });
        }
      },
      CLAIM_FAMILIES,
    );
    for (const res of responses) {
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { ok: false, error: "brain_id_required" });
    }
    assert.deepEqual(moved, [0, 0, 0, 0, 0]);
    assert.deepEqual(stub.sql(), []);
  } finally {
    stub.restore();
  }
});

const REQUEUED = "claw_api_doorbell_lease_requeued_total";
const TIMEOUT = "claw_api_run_queue_timeout_total";
const CLAIMED_WAIT = { name: `${WAIT}_count`, labels: { origin: "chat", outcome: "claimed" } };

let h: Harness;
let originalSweeperPublish: (typeof sweeperPorts)["publishSessionEvent"];

before(async () => {
  h = await startHarness();
  originalSweeperPublish = sweeperPorts.publishSessionEvent;
  sweeperPorts.publishSessionEvent = (async () => {}) as never;
});

after(async () => {
  sweeperPorts.publishSessionEvent = originalSweeperPublish;
  await h?.close();
});

async function queuedRows(): Promise<number> {
  const rows = await h.sql("SELECT COUNT(*)::int AS n FROM claw_tasks WHERE status = 'queued'");
  return Number(rows[0].n);
}

/**
 * What one run of the product moved, on both sides of `Δentered = Δexited + ΔQ`.
 *
 * The queue depth is read from the table rather than from a counter, so the
 * identity is checked against the rows themselves: a missing emission shows up
 * as an imbalance instead of as two counters agreeing about nothing.
 */
async function conserved(
  act: () => Promise<unknown>,
  probes: ReadonlyArray<{ name: string; labels?: Record<string, string> }> = [],
): Promise<{ e: number; x: number; dq: number; moved: number[] }> {
  const queuedBefore = await queuedRows();
  const before = await registry.metrics();
  await act();
  const after = await registry.metrics();
  return {
    e: familySum(after, ENTERED) - familySum(before, ENTERED),
    x: familySum(after, EXITED) - familySum(before, EXITED),
    dq: (await queuedRows()) - queuedBefore,
    moved: probes.map((p) => sample(after, p.name, p.labels) - sample(before, p.name, p.labels)),
  };
}

function assertConserved(r: { e: number; x: number; dq: number }): void {
  assert.equal(r.e, r.x + r.dq, `entered ${r.e} must equal exited ${r.x} plus queue delta ${r.dq}`);
}

function queuedRunInput(taskId: string, cause: "direct" | "admission"): Record<string, unknown> {
  return {
    sessionId: "s1",
    userId: "u-1",
    dispatch: "doorbell",
    taskId,
    queueEntryCause: cause,
    messageId: `m-${taskId}`,
    prompt: "hello",
    status: "queued",
    recordWorkspaceUse: false,
    spec: {
      prompt: "hello", session_id: "s1", user_id: "u-1",
      credentials: sealRunCredentials({ llm_api_key: "sk-live", platform_key: "pk-live" }),
    },
  };
}

/** Push this row's sojourn marker into the past, so a claim measures a known wait. */
async function ageMarker(taskId: string, seconds: number): Promise<void> {
  await h.sql(
    `UPDATE claw_tasks
        SET metadata = jsonb_set(metadata, '{queued_since}',
              to_jsonb((NOW() - ($2::int * INTERVAL '1 second'))::text))
      WHERE task_id = $1`,
    [taskId, seconds],
  );
}

test("a run that only passed through the queue balances it and measures no wait", async () => {
  await h.reset();
  await seedSession(h, "s1");
  const { openChatRun } = await import("../src/tasks/chat-run.js");
  const { claimRunById } = await import("../src/tasks/run-claim.js");

  const r = await conserved(
    async () => {
      await openChatRun(queuedRunInput("t-direct", "direct") as never);
      await claimRunById("t-direct", "brain-a", DOORBELL_SEMANTICS_VERSION);
    },
    [
      { name: ENTERED, labels: { cause: "direct" } },
      { name: EXITED, labels: { outcome: "claimed" } },
      CLAIMED_WAIT,
    ],
  );
  assertConserved(r);
  assert.deepEqual(r.moved, [1, 1, 0]);
  assert.equal(r.dq, 0);
});

test("a run held back by a ceiling balances the queue and measures the wait it served", async () => {
  await h.reset();
  await seedSession(h, "s1");
  const { openChatRun } = await import("../src/tasks/chat-run.js");
  const { claimRunById } = await import("../src/tasks/run-claim.js");

  const r = await conserved(
    async () => {
      await openChatRun(queuedRunInput("t-held", "admission") as never);
      await ageMarker("t-held", 10);
      await claimRunById("t-held", "brain-a", DOORBELL_SEMANTICS_VERSION);
    },
    [
      { name: ENTERED, labels: { cause: "admission" } },
      { name: EXITED, labels: { outcome: "claimed" } },
      CLAIMED_WAIT,
    ],
  );
  assertConserved(r);
  assert.deepEqual(r.moved, [1, 1, 1]);
});

test("a dispatch that fails before execution balances the row it closes", async () => {
  await h.reset();
  await seedSession(h, "s1");
  const { openChatRun, failChatRunDispatch } = await import("../src/tasks/chat-run.js");

  const r = await conserved(
    async () => {
      await openChatRun(queuedRunInput("t-doomed", "direct") as never);
      await failChatRunDispatch("t-doomed", "publish_failed", "the stream refused it");
    },
    [
      { name: ENTERED, labels: { cause: "direct" } },
      { name: EXITED, labels: { outcome: "dispatch_failed" } },
    ],
  );
  assertConserved(r);
  assert.deepEqual(r.moved, [1, 1]);
  assert.equal(r.dq, 0);
});

test("a lost-lease sweep books one entry per row, not one per sweep", async () => {
  await h.reset();
  await seedSession(h, "s1");
  for (const id of ["t-lost-1", "t-lost-2", "t-lost-3"]) {
    await seedRun(h, id, "s1", {
      status: "preparing", dispatch: "doorbell", leaseOwner: "brain-gone",
      leaseExpiresInSec: -86_400,
    });
  }
  const { requeueLostDoorbellLeases } = await import("../src/tasks/sweeper.js");

  let requeued = 0;
  const r = await conserved(
    async () => { requeued = await requeueLostDoorbellLeases(); },
    [{ name: REQUEUED }, { name: ENTERED, labels: { cause: "requeue" } }],
  );
  assert.equal(requeued, 3);
  assertConserved(r);
  assert.deepEqual(r.moved, [3, 3]);
  assert.deepEqual([r.x, r.dq], [0, 3]);
});

test("a queue timeout splits by whether a worker ever held the row", async () => {
  await h.reset();
  await seedSession(h, "s1");
  const { openChatRun } = await import("../src/tasks/chat-run.js");
  const { reapExpiredQueuedRuns } = await import("../src/tasks/sweeper.js");

  const r = await conserved(
    async () => {
      await openChatRun(queuedRunInput("t-cold", "admission") as never);
      await openChatRun(queuedRunInput("t-warm", "admission") as never);
      await h.sql(
        `UPDATE claw_tasks SET queued_at = NOW() - INTERVAL '400 days',
                claim_count = CASE WHEN task_id = 't-warm' THEN 3 ELSE 0 END`,
      );
      await ageMarker("t-cold", 10);
      await ageMarker("t-warm", 10);
      assert.equal(await reapExpiredQueuedRuns(), 2);
    },
    [
      { name: TIMEOUT, labels: { ever_held: "false" } },
      { name: TIMEOUT, labels: { ever_held: "true" } },
      { name: EXITED, labels: { outcome: "timed_out" } },
      { name: `${WAIT}_count`, labels: { origin: "chat", outcome: "timed_out" } },
    ],
  );
  assertConserved(r);
  assert.deepEqual(r.moved, [1, 1, 2, 2]);
  assert.deepEqual([r.e, r.dq], [2, 0]);
});

test("two requeues and three claims yield three sojourns and two new queue entries", async () => {
  await h.reset();
  await seedSession(h, "s1");
  const { openChatRun } = await import("../src/tasks/chat-run.js");
  const { claimRunById, releaseClaim } = await import("../src/tasks/run-claim.js");

  const [count, sum, exits, entries] = await delta(
    async () => {
      await openChatRun(queuedRunInput("t-cycled", "admission") as never);
      for (let claim = 0; claim < 3; claim++) {
        await ageMarker("t-cycled", 10);
        const claimed = await claimRunById("t-cycled", "brain-a", DOORBELL_SEMANTICS_VERSION);
        assert.ok(typeof claimed !== "string" && !("kind" in claimed));
        if (claim < 2) {
          await releaseClaim("t-cycled", "brain-a", (claimed as { claimCount: number }).claimCount);
        }
      }
    },
    [
      CLAIMED_WAIT,
      { name: `${WAIT}_sum`, labels: { origin: "chat", outcome: "claimed" } },
      { name: EXITED, labels: { outcome: "claimed" } },
      { name: ENTERED, labels: { cause: "requeue" } },
    ],
  );
  assert.equal(count, 3);
  assert.equal(exits, 3);
  assert.equal(entries, 2);
  // A cumulative marker would put 10 + 20 + 30 here; three sojourns put 30.
  assert.ok(
    sum >= 30 - SUM_EPSILON && sum < 35,
    `expected three ten-second sojourns, got ${sum}`,
  );
});
