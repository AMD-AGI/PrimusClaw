// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `approval.requested`: a tool call held for a person's decision becomes a
 * notification in the outbox. PGlite running the production statements, the real
 * event consumer on the way in and the real delivery worker on the way out.
 *
 *   O1 a permissionRequest event becomes one outbox row with the contract's payload
 *   O2 the same request seen again is still one row (redelivery, a resumed run)
 *   O3 who is told: the opt-in table, the owner, the subscription's event_types and sources
 *   O4 what is said: tool_use_id, tool, target redacted and clipped, expires_at
 *   O5 the run notifications are untouched, and the min-run-seconds rule does not apply
 *   O6 delivery: signed, same event id header, the approval block in the body
 *   O7 the subscription route accepts the type but does not put it in the default set
 *   O8 an event that cannot be an approval is dropped without failing the delivery
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

process.env.CLAW_NOTIFICATIONS_ENABLED = "true";
process.env.NOTIFY_LINK_BASE = "https://claw.example.invalid/app";
process.env.NOTIFY_MIN_RUN_SECONDS = "60";

const { db } = await import("../src/infra/db.js");
const { startHarness } = await import("./scenario-harness.js");
const { ensureNotificationSchema } = await import("../src/notifications/schema.js");
const outbox = await import("../src/notifications/outbox.js");
const { encryptUserEnvValue, decryptUserEnvValue } = await import("../src/crypto/user-env.js");
const { consumeEventDelivery, tombstoneReader, eventNotificationPorts } = await import("../src/events/consumer.js");
const { verifySignature, SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_ID_HEADER } = await import("../src/notifications/signing.js");
type Harness = Awaited<ReturnType<typeof startHarness>>;

const NOW = Date.parse("2026-10-29T08:00:00.000Z");
let h: Harness;
let originalHas: typeof tombstoneReader.has;
let seq = 0;

before(async () => {
  h = await startHarness();
  originalHas = tombstoneReader.has;
  tombstoneReader.has = async () => false;
  await ensureNotificationSchema({ query: (t: string, p?: unknown[]) => db.query(t, p) } as never);
});
beforeEach(async () => {
  await h.reset();
  await h.sql("DELETE FROM claw_notification_outbox");
  await h.sql("DELETE FROM claw_notification_subscriptions");
  seq = 0;
});
after(async () => {
  tombstoneReader.has = originalHas;
  await h.close();
});

async function session(sid: string, o: { owner?: string; config?: Record<string, unknown>; name?: string } = {}) {
  await h.sql(
    "INSERT INTO claw_sessions (session_id, name, user_id, mode, config) VALUES ($1, $2, $3, 'claw', $4::jsonb)",
    [sid, o.name ?? "fix the build", o.owner ?? "u1", JSON.stringify(o.config ?? {})],
  );
}
async function subscribe(owner = "u1", o: { types?: string[]; sources?: string[]; url?: string } = {}) {
  const id = outbox.newSubscriptionId();
  await h.sql(
    `INSERT INTO claw_notification_subscriptions (subscription_id, owner_user_id, url, secret_enc, event_types, sources)
     VALUES ($1, $2, $3, $4, COALESCE($5::text[], ARRAY['run.completed','run.failed']), COALESCE($6::text[], ARRAY['trigger','long_run']))`,
    [id, owner, o.url ?? "https://hooks.example.com/claw", encryptUserEnvValue(`secret-${owner}`), o.types ?? null, o.sources ?? null],
  );
  return id;
}
const APPROVALS = ["approval.requested"];
const rows = async () => (await h.sql("SELECT * FROM claw_notification_outbox ORDER BY id")) as any[];

/** The event Brain emits when it starts waiting (hitl.ts): tool_use_id, tool, input, timeout_ms, ts, message_id. */
function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "permissionRequest", actionId: "tu-1", tool_use_id: "tu-1", tool: "bash",
    input: { command: "git push origin feat/x" },
    description: "[git push (publishes commits to a remote)] bash: {...}",
    approval_label: "git push (publishes commits to a remote)",
    timeout_ms: 300_000, ts: NOW, message_id: "m-1", ...over,
  };
}

/** Through the real consumer: the way an event from Brain reaches the outbox. */
async function deliver(sid: string, event: Record<string, unknown>): Promise<string[]> {
  const verdicts: string[] = [];
  await consumeEventDelivery({
    subject: `events.${sid}`,
    data: new TextEncoder().encode(JSON.stringify(event)),
    seq: ++seq,
    ack: () => { verdicts.push("ack"); },
    nak: (ms?: number) => { verdicts.push(`nak:${ms ?? ""}`); },
  });
  return verdicts;
}

test("O1 a permissionRequest becomes one outbox row with the contract's payload", async () => {
  // Through the real consumer, which reads the real clock; Brain's timestamp is used when it is close to it.
  const ts = Date.now() - 1_000;
  await session("s1", { config: { notify_on_finish: true } });
  await h.sql(
    "INSERT INTO claw_tasks (task_id, session_id, name, status, metadata) VALUES ('run-9', 's1', 'run', 'running', $1::jsonb)",
    [JSON.stringify({ message_id: "m-1" })],
  );
  await subscribe("u1", { types: ["run.completed", "approval.requested"] });
  assert.deepEqual(await deliver("s1", request({ ts })), ["ack"]);
  const out = await rows();
  assert.equal(out.length, 1);
  const p = out[0].payload;
  assert.deepEqual(Object.keys(p).sort(), [
    "approval", "event_id", "link", "occurred_at", "session_id", "summary", "task_id", "title", "trigger_id", "type", "user_id",
  ]);
  assert.equal(p.type, "approval.requested");
  assert.equal(p.event_id, outbox.deterministicEventId("approval.requested", "s1", "tu-1"));
  assert.equal(out[0].event_id, p.event_id);
  assert.equal(p.user_id, "u1");
  assert.equal(p.session_id, "s1");
  assert.equal(p.task_id, "run-9", "the run the turn belongs to");
  assert.equal(p.trigger_id, null);
  assert.equal(p.title, "Approval needed: bash (fix the build)");
  assert.equal(p.summary, "git push (publishes commits to a remote)");
  assert.equal(p.link, "https://claw.example.invalid/app/sessions/s1");
  assert.equal(p.occurred_at, new Date(ts).toISOString());
  assert.deepEqual(p.approval, {
    tool_use_id: "tu-1", tool: "bash", target: "git push origin feat/x", expires_at: new Date(ts + 300_000).toISOString(),
  });
});

test("O1 the event itself is still stored and acked: the outbox is a side effect", async () => {
  await session("s1", { config: { notify_on_finish: true } });
  await subscribe("u1", { types: APPROVALS });
  await deliver("s1", request());
  const stored = await h.sql("SELECT event FROM claw_session_events WHERE session_id = 's1'");
  assert.deepEqual(stored.map((r) => r.event), ["permissionRequest"]);
});

test("O2 the same request again is still one row: a redelivery, a resumed run, a repeat", async () => {
  await session("s1", { config: { notify_on_finish: true } });
  await subscribe("u1", { types: APPROVALS });
  await deliver("s1", request());
  await deliver("s1", request());                                   // another stream sequence, same request
  await deliver("s1", request({ ts: NOW + 60_000 }));                  // re-emitted a minute later
  await deliver("s1", request({ actionId: undefined, input: { command: "something else" } }));   // same tool_use_id, different body
  assert.equal((await rows()).length, 1);
  const first = (await rows())[0].payload;
  assert.equal(first.approval.target, "git push origin feat/x", "the first one is the one kept");
  // A different tool_use_id is a different request; the same one in another session is too.
  await deliver("s1", request({ tool_use_id: "tu-2", actionId: "tu-2" }));
  await session("s2", { config: { notify_on_finish: true } });
  await deliver("s2", request());
  assert.equal((await rows()).length, 3);
  assert.equal(new Set((await rows()).map((r) => r.event_id)).size, 3);
});

test("O2 recording the same request again directly writes nothing and does not throw", async () => {
  await session("s1", { config: { notify_on_finish: true } });
  await subscribe("u1", { types: APPROVALS });
  assert.equal(await outbox.recordApprovalRequested({ sessionId: "s1", event: request() }, () => NOW), 1);
  assert.equal(await outbox.recordApprovalRequested({ sessionId: "s1", event: request() }, () => NOW), 0);
  assert.equal((await rows()).length, 1);
});

test("O2 one row per subscription, however many times it is recorded", async () => {
  await session("s1", { config: { notify_on_finish: true } });
  await subscribe("u1", { types: APPROVALS, url: "https://a.example.com/x" });
  await subscribe("u1", { types: APPROVALS, url: "https://b.example.com/x" });
  for (let i = 0; i < 3; i++) await deliver("s1", request());
  const out = await rows();
  assert.equal(out.length, 2);
  assert.equal(new Set(out.map((r) => r.subscription_id)).size, 2);
  assert.equal(new Set(out.map((r) => r.event_id)).size, 1, "one event id: the receiver's dedup key");
});

test("O3 who is told: the session's opt-in decides, as it does for run notifications", async () => {
  const cases: Array<{ name: string; config?: Record<string, unknown>; owner?: string; told: boolean }> = [
    { name: "no opt-in at all", told: false },
    { name: "notify_on_finish true", config: { notify_on_finish: true }, told: true },
    { name: "notify_on_finish false", config: { notify_on_finish: false }, told: false },
    { name: "notify_on_finish is the string 'true'", config: { notify_on_finish: "true" }, told: false },
    { name: "notify_on_finish is 1", config: { notify_on_finish: 1 }, told: false },
    { name: "a trigger-started session", config: { trigger_id: "trg-1" }, told: true },
    { name: "a trigger-started session that also opted in", config: { trigger_id: "trg-1", notify_on_finish: true }, told: true },
    { name: "an empty trigger id", config: { trigger_id: "" }, told: false },
    { name: "an anonymous owner", config: { notify_on_finish: true }, owner: "default", told: false },
  ];
  for (const [i, c] of cases.entries()) {
    await h.sql("DELETE FROM claw_notification_outbox");
    await h.sql("DELETE FROM claw_notification_subscriptions");
    await h.sql("DELETE FROM claw_sessions");
    const owner = c.owner ?? "u1";
    await session(`s-${i}`, { owner, config: c.config });
    await subscribe(owner, { types: APPROVALS });
    await deliver(`s-${i}`, request());
    assert.equal((await rows()).length, c.told ? 1 : 0, c.name);
  }
});

test("O3 only the owner's own subscriptions, and only those that list the type and the source", async () => {
  await session("s1", { config: { notify_on_finish: true } });
  const wanted = await subscribe("u1", { types: ["run.completed", "approval.requested"] });
  await subscribe("u1", { types: ["run.completed", "run.failed"], url: "https://b.example.com/x" });          // the default set: not asked
  await subscribe("u2", { types: APPROVALS, url: "https://c.example.com/x" });                                  // someone else's
  await subscribe("u1", { types: APPROVALS, sources: ["trigger"], url: "https://d.example.com/x" });           // wrong source for this session
  const disabled = await subscribe("u1", { types: APPROVALS, url: "https://e.example.com/x" });
  await h.sql("UPDATE claw_notification_subscriptions SET enabled = FALSE WHERE subscription_id = $1", [disabled]);
  const longRunOnly = await subscribe("u1", { types: APPROVALS, sources: ["long_run"], url: "https://f.example.com/x" });
  await deliver("s1", request());
  assert.deepEqual((await rows()).map((r) => r.subscription_id).sort(), [wanted, longRunOnly].sort());
  // And the trigger source for a trigger-started session.
  await h.sql("DELETE FROM claw_notification_outbox");
  await session("s2", { config: { trigger_id: "trg" } });
  await deliver("s2", request());
  const triggerOnly = (await h.sql("SELECT subscription_id FROM claw_notification_subscriptions WHERE sources = ARRAY['trigger']"))[0].subscription_id;
  assert.deepEqual((await rows()).map((r) => r.subscription_id).sort(), [wanted, triggerOnly].sort(), "the trigger source, not the long_run one");
});

test("O3 a default subscription (the two run events) is not sent an approval", async () => {
  await session("s1", { config: { notify_on_finish: true } });
  await subscribe("u1");
  await deliver("s1", request());
  assert.equal((await rows()).length, 0);
});

test("O3 a deleted session and an unknown session record nothing, and the event is still acked", async () => {
  await session("gone", { config: { notify_on_finish: true } });
  await h.sql("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = 'gone'");
  await subscribe("u1", { types: APPROVALS });
  assert.deepEqual(await deliver("gone", request()), ["ack"]);
  assert.deepEqual(await deliver("nobody", request()), ["ack"]);
  assert.equal((await rows()).length, 0);
});

test("O4 what is said: the command is the target, redacted and clipped; expiry is when Brain stops waiting", async () => {
  await session("s1", { config: { notify_on_finish: true } });
  await subscribe("u1", { types: APPROVALS });
  const cases: Array<{ name: string; event: Record<string, unknown>; target: RegExp | string; expires: string }> = [
    { name: "a plain command", event: request({ tool_use_id: "a" }), target: "git push origin feat/x", expires: "2026-10-29T08:05:00.000Z" },
    { name: "a token in the command", event: request({ tool_use_id: "b", input: { command: "GH_TOKEN=abc123xyz git push" } }), target: "GH_TOKEN=<redacted> git push", expires: "2026-10-29T08:05:00.000Z" },
    { name: "an MCP tool", event: request({ tool_use_id: "c", tool: "mcp__jobs__create_run", input: { plan_id: "p-1", gpus: 8 } }), target: "mcp__jobs__create_run plan_id=p-1 gpus=8", expires: "2026-10-29T08:05:00.000Z" },
    { name: "a long command", event: request({ tool_use_id: "d", input: { command: `echo ${"x".repeat(1000)}` } }), target: /^echo x{290,}…$/, expires: "2026-10-29T08:05:00.000Z" },
    { name: "a 30 minute window", event: request({ tool_use_id: "e", timeout_ms: 1_800_000 }), target: "git push origin feat/x", expires: "2026-10-29T08:30:00.000Z" },
    { name: "no timeout given: Brain's 5 minute default", event: request({ tool_use_id: "f", timeout_ms: undefined }), target: "git push origin feat/x", expires: "2026-10-29T08:05:00.000Z" },
    { name: "a nonsense timeout", event: request({ tool_use_id: "g", timeout_ms: -5 }), target: "git push origin feat/x", expires: "2026-10-29T08:05:00.000Z" },
    { name: "a timeout longer than a day", event: request({ tool_use_id: "i", timeout_ms: 99 * 86_400_000 }), target: "git push origin feat/x", expires: "2026-10-29T08:05:00.000Z" },
  ];
  for (const c of cases) {
    await h.sql("DELETE FROM claw_notification_outbox");
    // The clock the API reads is pinned to the event's own timestamp.
    assert.equal(await outbox.recordApprovalRequested({ sessionId: "s1", event: c.event }, () => NOW), 1, c.name);
    const a = (await rows())[0].payload.approval;
    if (typeof c.target === "string") assert.equal(a.target, c.target, c.name);
    else assert.match(a.target, c.target, c.name);
    assert.ok(a.target.length <= 300, c.name);
    assert.equal(a.expires_at, c.expires, c.name);
    assert.match(a.expires_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "ISO-8601 with an offset");
  }
});

test("O4 Brain's timestamp is used when it is believable, this clock when it is not", async () => {
  await session("s1", { config: { notify_on_finish: true } });
  await subscribe("u1", { types: APPROVALS });
  const at = async (ts: unknown, now: number) => {
    await h.sql("DELETE FROM claw_notification_outbox");
    await outbox.recordApprovalRequested({ sessionId: "s1", event: request({ ts }) }, () => now);
    const p = (await rows())[0].payload;
    return [p.occurred_at, p.approval.expires_at];
  };
  assert.deepEqual(await at(NOW, NOW + 2_000), ["2026-10-29T08:00:00.000Z", "2026-10-29T08:05:00.000Z"], "emitted 2 s ago: the wait began then");
  assert.deepEqual(await at(NOW - 3_600_000, NOW), ["2026-10-29T08:00:00.000Z", "2026-10-29T08:05:00.000Z"], "an hour in the past is a bad clock");
  assert.deepEqual(await at(NOW + 3_600_000, NOW), ["2026-10-29T08:00:00.000Z", "2026-10-29T08:05:00.000Z"], "an hour in the future too");
  assert.deepEqual(await at(undefined, NOW), ["2026-10-29T08:00:00.000Z", "2026-10-29T08:05:00.000Z"]);
  assert.deepEqual(await at("soon", NOW), ["2026-10-29T08:00:00.000Z", "2026-10-29T08:05:00.000Z"]);
});

test("O4 the title and summary: the tool, the session's name, the rule's label; the task falls back to the message id", async () => {
  await session("s1", { config: { notify_on_finish: true }, name: "" });
  await subscribe("u1", { types: APPROVALS });
  await deliver("s1", request({ summary: "Pushes the branch to GitHub. Bearer abcdefghijklmnopqrstuvwxyz0123 leaked.", message_id: "m-no-row" }));
  const p = (await rows())[0].payload;
  assert.equal(p.title, "Approval needed: bash", "no session name, no parentheses");
  assert.equal(p.task_id, "m-no-row", "no run row for the message: its id");
  assert.equal(p.summary.includes("abcdefghijklmnopqrstuvwxyz0123"), false);
  assert.ok(p.summary.length <= 500);
  await h.sql("DELETE FROM claw_notification_outbox");
  await deliver("s1", request({ tool_use_id: "tu-9", message_id: undefined, approval_label: undefined }));
  const q = (await rows())[0].payload;
  assert.equal(q.task_id, "");
  assert.equal(q.summary, "");
  await h.sql("DELETE FROM claw_notification_outbox");
  await deliver("s1", request({ tool_use_id: "tu-10", tool: "x".repeat(400) }));
  const r = (await rows())[0].payload;
  assert.ok(r.title.length <= 200);
  assert.equal(r.approval.tool.length, 200);
});

test("O5 the run notifications are unchanged, and the short-run rule does not apply to an approval", async () => {
  await session("s1", { config: { notify_on_finish: true } });
  await h.sql(
    `INSERT INTO claw_tasks (task_id, session_id, name, status, started_at, completed_at, metadata)
     VALUES ('t-short', 's1', 'run', 'completed', NOW() - interval '3 seconds', NOW(), '{}'::jsonb)`,
  );
  await subscribe("u1", { types: ["run.completed", "run.failed", "approval.requested"] });
  assert.equal(await outbox.recordRunFinished({ sessionId: "s1", taskIds: ["t-short"], outcome: "completed" }), 0, "a 3 s run is not announced");
  assert.equal(await outbox.recordApprovalRequested({ sessionId: "s1", event: request() }, () => NOW), 1, "an approval in a 3 s old session is");
  await h.sql(
    `UPDATE claw_tasks SET started_at = NOW() - interval '300 seconds' WHERE task_id = 't-short'`,
  );
  assert.equal(await outbox.recordRunFinished({ sessionId: "s1", taskIds: ["t-short"], outcome: "completed" }), 1);
  const types = (await rows()).map((r) => r.payload.type).sort();
  assert.deepEqual(types, ["approval.requested", "run.completed"]);
  const run = (await rows()).find((r) => r.payload.type === "run.completed").payload;
  assert.equal("approval" in run, false, "a run event has no approval block");
});

test("O6 delivery: signed like every event, the same event-id header, the approval block in the body", async () => {
  await session("s1", { config: { notify_on_finish: true } });
  await subscribe("u1", { types: APPROVALS });
  await deliver("s1", request());
  const sent: Array<{ body: string; headers: Record<string, string> }> = [];
  const r = await outbox.deliverDue({
    transport: async (req) => { sent.push({ body: req.body, headers: req.headers }); return 200; },
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    allowedHosts: new Set(),
  });
  assert.deepEqual(r, { delivered: 1, failed: 0 });
  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].body);
  assert.equal(body.type, "approval.requested");
  assert.equal(body.approval.tool_use_id, "tu-1");
  assert.equal(sent[0].headers[EVENT_ID_HEADER], body.event_id);
  const secret = decryptUserEnvValue(encryptUserEnvValue("secret-u1"));
  assert.equal(verifySignature({
    secret, timestamp: sent[0].headers[TIMESTAMP_HEADER], signature: sent[0].headers[SIGNATURE_HEADER], body: sent[0].body,
  }), "ok");
  assert.equal(typeof (await rows())[0].delivered_at, "object", "marked delivered");
});

test("O7 the subscription route accepts the type, and the default set is still the two run events", async () => {
  const { registerNotificationSubscriptionRoutes } = await import("../src/routes/notification-subscriptions.js");
  const app: FastifyInstance = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as any).user = { userId: "u1", userName: "u1", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
  });
  await registerNotificationSubscriptionRoutes(app);
  await app.ready();
  try {
    const plain = await app.inject({ method: "POST", url: "/v1/notification-subscriptions", payload: { url: "https://93.184.216.34/hook" } });
    assert.equal(plain.statusCode, 201, plain.body);
    assert.deepEqual(plain.json().data.event_types, ["run.completed", "run.failed"], "a receiver that did not ask is not sent approvals");
    const asked = await app.inject({
      method: "POST", url: "/v1/notification-subscriptions",
      payload: { url: "https://93.184.216.35/hook", event_types: ["run.completed", "approval.requested"] },
    });
    assert.equal(asked.statusCode, 201, asked.body);
    assert.deepEqual(asked.json().data.event_types, ["run.completed", "approval.requested"]);
    const patched = await app.inject({
      method: "PATCH", url: `/v1/notification-subscriptions/${plain.json().data.subscription_id}`,
      payload: { event_types: ["run.completed", "run.failed", "approval.requested"] },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.deepEqual(patched.json().data.event_types, ["run.completed", "run.failed", "approval.requested"]);
    const bad = await app.inject({
      method: "POST", url: "/v1/notification-subscriptions",
      payload: { url: "https://93.184.216.36/hook", event_types: ["approval.granted"] },
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /event_types must be a non-empty subset of run\.completed, run\.failed, approval\.requested/);
  } finally {
    await app.close();
  }
});

test("O8 an event that cannot be an approval records nothing; a failure of the outbox does not fail the event", async () => {
  await session("s1", { config: { notify_on_finish: true } });
  await subscribe("u1", { types: APPROVALS });
  for (const bad of [
    request({ tool_use_id: undefined, actionId: undefined }),
    request({ tool_use_id: "", actionId: "" }),
    request({ tool: undefined }),
    request({ tool: "   " }),
    request({ tool_use_id: 5, actionId: undefined }),
  ]) {
    assert.deepEqual(await deliver("s1", bad), ["ack"]);
  }
  assert.equal((await rows()).length, 0);
  // The actionId alone is enough: it is the same value as tool_use_id.
  assert.deepEqual(await deliver("s1", request({ tool_use_id: undefined })), ["ack"]);
  assert.equal((await rows()).length, 1);
  assert.equal((await rows())[0].payload.approval.tool_use_id, "tu-1");
  // The outbox throws: the event is still acked, not retried for ever.
  const real = eventNotificationPorts.recordApprovalRequested;
  eventNotificationPorts.recordApprovalRequested = async () => { throw new Error("outbox is down"); };
  try {
    assert.deepEqual(await deliver("s1", request({ tool_use_id: "tu-77" })), ["ack"]);
  } finally {
    eventNotificationPorts.recordApprovalRequested = real;
  }
});

test("O8 only a permissionRequest reaches the outbox: other events from Brain do not", async () => {
  await session("s1", { config: { notify_on_finish: true } });
  await subscribe("u1", { types: APPROVALS });
  for (const type of ["decisionResult", "toolUsed", "statusUpdate", "permission_request", "PermissionRequest"]) {
    await deliver("s1", { ...request(), type });
  }
  assert.equal((await rows()).length, 0);
});
