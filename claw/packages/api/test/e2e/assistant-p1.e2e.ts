// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant's end-to-end scenario against a real deployment, with a real model: two long tasks in one
 * conversation, three interjections while both run, both finish and each is told, the user accepts, and the
 * system survives the faults it is meant to. Every fact it reports is a measurement taken here with
 * `Date.now()`; nothing is slept for and assumed, and a read that failed or timed out is a failure.
 *
 *   CLAW=https://claw.example KEY=<api key> RECEIVER_URL=http://<address the API can reach>:<port> \
 *     npx tsx test/e2e/assistant-p1.e2e.ts
 *
 * Required: CLAW, KEY, RECEIVER_URL (the API must be able to reach it, and its host must be allowed by
 * NOTIFY_WEBHOOK_ALLOWED_HOSTS if it is a private address). The deployment needs CLAW_ASSISTANT_ENABLED and
 * CLAW_NOTIFICATIONS_ENABLED, and the user's key must be a real user's.
 * Optional:
 *   RECEIVER_PORT        the port to listen on (default: any)
 *   KEY_B                a second user's key: enables the cross-user check
 *   SOAK_ROUNDS          extra short A/B rounds, for the latency distribution (the plan's soak is 20)
 *   CHAOS                comma list of: stale (needs ASSISTANT_MCP_URL and CLAW_ASSISTANT_TOKEN_KEY),
 *                        restart (needs KUBECTL_ROLLOUT, e.g. "deployment/claw-api -n claw"),
 *                        receiver (a receiver that refuses, then a fallback; takes SILENT_SWEEP_SEC)
 *   SILENT_SWEEP_SEC     the deployment's CLAW_ASSISTANT_SILENT_SWEEP_SEC (default 300)
 *   RECEIVER_HOLD_SEC    how long the receiver refuses in the "receiver" chaos step (default SILENT_SWEEP_SEC + 60;
 *                        must be longer than SILENT_SWEEP_SEC, or the system's own message is not yet due)
 *   DONE_WAIT_SEC        how long to wait for a task to finish (default 1200)
 *   RUN_TAG              prefix of every task name (default: one per run); the Router answers a task it closed in
 *                        the last day from that item, so a rerun must not repeat an earlier run's names
 *   SOAK_DONE_WAIT_SEC   how long a soak round waits for its two tasks to be ready (default 600)
 *   SANDBOX_MAX          the soak stops with a failure when more of this run's sandboxes are alive before a round
 *                        (default 4); counted with kubectl (SaFE workloads labelled with the run's session ids)
 *   KUBECTL_ARGS         extra kubectl arguments for that count, e.g. "--context global"
 *
 * Exit 0 only if every check passed. The last line is a JSON summary.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { mintAssistantToken } from "../../src/assistant/token.js";
import {
  SESSION_ID_LABEL, aliveSandboxes, apiClient, duplicateEventIds, latencyMs, newItemsSince, percentile, renderTimings,
  runTag, settle, startReceiver, until, type Received, type Timing,
} from "./assistant-p1-lib.js";

const run = promisify(execFile);
const need = (name: string): string => {
  const v = process.env[name];
  if (!v) { console.error(`${name} is required`); process.exit(2); }
  return v;
};

const CLAW = need("CLAW").replace(/\/+$/, "");
const KEY = need("KEY");
const RECEIVER_URL = need("RECEIVER_URL").replace(/\/+$/, "");
const KEY_B = process.env.KEY_B;
const SOAK_ROUNDS = Number(process.env.SOAK_ROUNDS ?? 0);
const CHAOS = new Set((process.env.CHAOS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const SILENT_SWEEP_SEC = Number(process.env.SILENT_SWEEP_SEC ?? 300);
const RECEIVER_HOLD_SEC = Number(process.env.RECEIVER_HOLD_SEC ?? SILENT_SWEEP_SEC + 60);
const DONE_WAIT_MS = Number(process.env.DONE_WAIT_SEC ?? 1200) * 1000;
const SOAK_DONE_WAIT_MS = Number(process.env.SOAK_DONE_WAIT_SEC ?? 600) * 1000;
const SANDBOX_MAX = Number(process.env.SANDBOX_MAX ?? 4);
const KUBECTL_ARGS = (process.env.KUBECTL_ARGS ?? "").split(/\s+/).filter(Boolean);
const RUN_TAG = runTag(process.env.RUN_TAG);
if (CHAOS.has("receiver") && RECEIVER_HOLD_SEC <= SILENT_SWEEP_SEC) {
  console.error(`RECEIVER_HOLD_SEC (${RECEIVER_HOLD_SEC}) must be longer than SILENT_SWEEP_SEC (${SILENT_SWEEP_SEC})`);
  process.exit(2);
}
/** The plan's budget for the assistant to answer a message the user sends while work runs. */
const SAY_BUDGET_MS = 10_000;

const api = apiClient(CLAW, KEY);
const apiAs = (key: string) => (method: string, path: string, body?: unknown) => apiClient(CLAW, key)(method, path, body);
const iso = () => new Date().toISOString();
const log = (...a: unknown[]) => console.log(iso(), ...a);
const failures: string[] = [];
const check = (cond: boolean, what: string): boolean => {
  if (cond) log("ok  ", what);
  else { failures.push(what); log("FAIL", what); }
  return cond;
};

interface ItemView {
  item_id: string; seq: number; title: string; board_state: string; last_report_kind: string | null;
  result_version: number; can_accept: boolean; outcome: string | null; updated_at: string; worker_session_id?: string;
  events?: Array<{ kind: string; run_id: string | null; created_at: string }>;
}

const taskText = (name: string, file: string, sleepSec: number) =>
  `Task ${RUN_TAG}-${name}: run two steps, each one \`sleep ${sleepSec}\` as its own command, then write "${name}-done" into /workspace/${file}, and report when it is written.`;

async function board(state?: string): Promise<ItemView[]> {
  const r = await api("GET", `/v1/work-items${state ? `?state=${state}` : ""}`);
  if (r.status !== 200) throw new Error(`GET /v1/work-items answered ${r.status}`);
  return r.json.data as ItemView[];
}
async function itemOf(id: string, key = KEY): Promise<ItemView | null> {
  const r = await apiAs(key)("GET", `/v1/work-items/${id}`);
  return r.status === 200 ? (r.json.data as ItemView) : null;
}

/** What this run created, so that it is stopped and deleted whatever happens: items, their workers, the subscription. */
const cleanups: Array<{ what: string; run: () => Promise<void> }> = [];
const runItems = new Map<string, { workerSessionId: string | null; retired: boolean }>();
/** The sessions whose sandboxes count against SANDBOX_MAX: the assistant's and every worker of this run. */
const runSessions = new Set<string>();

/** Counts an item as this run's: it is stopped and its worker deleted at the latest when the run ends. */
async function track(id: string): Promise<ItemView | null> {
  const it = await itemOf(id);
  if (!runItems.has(id)) runItems.set(id, { workerSessionId: it?.worker_session_id ?? null, retired: false });
  if (it?.worker_session_id) { runItems.get(id)!.workerSessionId = it.worker_session_id; runSessions.add(it.worker_session_id); }
  return it;
}

/** Stops an item that is not done and deletes its worker session (and with it the sandbox). */
async function retire(id: string): Promise<boolean> {
  const t = runItems.get(id);
  if (!t || t.retired) return true;
  const it = await itemOf(id);
  const stop = it && it.board_state !== "done" ? (await api("POST", `/v1/work-items/${id}/stop`)).status : 200;
  const wid = it?.worker_session_id ?? t.workerSessionId;
  const del = wid ? (await api("DELETE", `/v1/sessions/${wid}`)).status : 404;
  t.retired = stop === 200 && (del === 200 || del === 204 || del === 404);
  if (!t.retired) log("could not retire", id, `stop ${stop}, delete worker ${del}`);
  return t.retired;
}
const retireAll = async (ids: Iterable<string>) => (await Promise.all([...ids].map(retire))).every(Boolean);

async function main(): Promise<void> {
  log("run tag", RUN_TAG);
  const code = await settle(scenario, cleanups, failures);
  for (const f of failures.filter((f) => f.startsWith("cleanup:") || f.startsWith("the scenario"))) log("FAIL", f);
  if (!summaryPrinted) console.log(JSON.stringify({ ok: false, failures }));
  process.exit(code);
}

let summaryPrinted = false;

async function scenario(): Promise<"finished" | void> {
  const receiver = await startReceiver(Number(process.env.RECEIVER_PORT ?? 0));
  cleanups.push({ what: "close the receiver", run: () => receiver.close() });
  cleanups.push({ what: "stop this run's items and delete their workers", run: async () => {
    if (!await retireAll(runItems.keys())) throw new Error("some items or workers could not be retired (see the log)");
  } });
  const hookUrl = `${RECEIVER_URL.replace(/:\d+$/, "")}:${RECEIVER_URL.match(/:(\d+)$/) ? RECEIVER_URL.match(/:(\d+)$/)![1] : receiver.port}/hook`;
  log("receiver listening on", receiver.port, "and registered as", hookUrl);

  // 0. The user, the subscription, the assistant.
  const sub = await api("POST", "/v1/notification-subscriptions", { url: hookUrl, event_types: ["assistant.say", "work_item.needs_you"] });
  if (!check(sub.status === 201, `a subscription for assistant.say and work_item.needs_you is accepted (${sub.status}${sub.status === 201 ? "" : ` ${JSON.stringify(sub.json?.error ?? sub.json).slice(0, 120)}`})`)) return;
  receiver.setSecret(sub.json.data.secret);
  const subscriptionId = sub.json.data.subscription_id ?? sub.json.data.id;
  cleanups.push({ what: "delete the subscription", run: async () => {
    const r = await api("DELETE", `/v1/notification-subscriptions/${subscriptionId}`);
    if (r.status !== 200 && r.status !== 204) throw new Error(`DELETE answered ${r.status}`);
  } });
  const assistant = await api("POST", "/v1/assistant");
  if (!check(assistant.status === 200 && Boolean(assistant.json.data.session_id), "the assistant session exists")) return;
  const sid: string = assistant.json.data.session_id;
  runSessions.add(sid);
  const again = await api("POST", "/v1/assistant");
  check(again.json?.data?.session_id === sid && again.json?.data?.created === false, "asking again returns the same session");

  const send = async (content: string): Promise<number> => {
    const at = Date.now();
    const r = await api("POST", `/v1/sessions/${sid}/messages`, { content, messageType: "text" });
    if (r.status !== 200) throw new Error(`sending a message answered ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
    return at;
  };
  const sayAfter = (since: number, match: (r: Received) => boolean = () => true) =>
    receiver.received.find((r) => r.type === "assistant.say" && r.at >= since && match(r));
  const waitSay = (since: number, budgetMs: number, match?: (r: Received) => boolean) =>
    until(() => sayAfter(since, match), since + budgetMs, 100);
  const known = new Set((await board()).map((i) => i.item_id));
  const newItem = async (since: number): Promise<ItemView | null> => {
    const found = await until(async () => (await board("in_progress")).find((i) => !known.has(i.item_id) && !runItems.has(i.item_id)), since + SAY_BUDGET_MS);
    if (found) await track(found.item_id);
    return found;
  };

  // 1. Task A: taken on within the budget.
  const tA = await send(taskText("A", "a.txt", 45));
  const sayA = await waitSay(tA, SAY_BUDGET_MS);
  check(sayA !== null, `A is acknowledged within ${SAY_BUDGET_MS}ms (${sayA ? sayA.at - tA : "no say"}ms)`);
  const itemA = await newItem(tA);
  if (!check(itemA !== null, "the board shows A as in progress")) return;
  known.add(itemA!.item_id);
  check(Boolean(sayA && (sayA.item?.item_id === itemA!.item_id || sayA.text.includes(`#${itemA!.seq}`))), "the acknowledgement names A");

  // 2. Task B while A runs.
  const tB = await send(taskText("B", "b.txt", 45));
  const sayB = await waitSay(tB, SAY_BUDGET_MS, (r) => r.at > (sayA?.at ?? 0));
  check(sayB !== null, `B is acknowledged within ${SAY_BUDGET_MS}ms (${sayB ? sayB.at - tB : "no say"}ms)`);
  const itemB = await newItem(tB);
  if (!check(itemB !== null, "the board shows B as in progress")) return;
  known.add(itemB!.item_id);
  const [fullA, fullB] = await Promise.all([itemOf(itemA!.item_id), itemOf(itemB!.item_id)]);
  check(Boolean(fullA?.worker_session_id && fullB?.worker_session_id && fullA.worker_session_id !== fullB.worker_session_id), "A and B have different workers");
  const running = async (wid: string) => (await api("GET", `/v1/sessions/${wid}`)).json?.data?.agent_status === "running";
  const bothRunning = await until(async () => (await running(fullA!.worker_session_id!) && await running(fullB!.worker_session_id!)) ? true : undefined, tB + 60_000, 500);
  check(bothRunning === true, "both workers are running at the same time");
  const runStarts = (it: ItemView | null) => (it?.events ?? []).filter((e) => e.kind === "run_started").map((e) => e.run_id);
  const bRunBefore = runStarts(await itemOf(itemB!.item_id));

  // 3. Three interjections while both run, at +10s, +30s and +50s after B was sent.
  const timings: Timing[] = [];
  const interject = async (label: string, at: number, text: string, match: (r: Received) => boolean): Promise<Received | null> => {
    const wait = at - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const sent = await send(text);
    const said = await waitSay(sent, SAY_BUDGET_MS * 2, match);
    timings.push({ label, sentAt: sent, answeredAt: said ? said.at : null });
    return said;
  };
  const one = await interject("1 where is A", tB + 10_000, "Where is A up to?", () => true);
  check(Boolean(one && (one.text.includes(`#${itemA!.seq}`) || one.item?.item_id === itemA!.item_id || /\bA\b/.test(one.text))), "the answer to 'where is A' is about A");
  const two = await interject("2 tell me when B is done", tB + 30_000, "When B is done, tell me briefly.", (r) => r.at > (one?.at ?? 0));
  check(two !== null, "'tell me when B is done' is answered");
  check(JSON.stringify(runStarts(await itemOf(itemB!.item_id))) === JSON.stringify(bRunBefore), "B's worker was not interrupted by it (same run)");
  const three = await interject("3 how many things", tB + 50_000, "By the way, how many things are you working on right now? Answer with the number.", (r) => r.at > (two?.at ?? 0));
  check(Boolean(three && /\b(2|two)\b/i.test(three.text)), "the count it gives is 2");
  console.log("\n" + renderTimings(timings, SAY_BUDGET_MS) + "\n");
  check(timings.length === 3 && timings.every((t) => (latencyMs(t) ?? Infinity) < SAY_BUDGET_MS), `all three interjections were answered in under ${SAY_BUDGET_MS}ms`);

  // 4. Both finish, each is told with its own result.
  const doneAt = Date.now() + DONE_WAIT_MS;
  const [readyA, readyB] = await Promise.all([ready(itemA!.item_id, doneAt), ready(itemB!.item_id, doneAt)]);
  check(readyA !== null && readyA.can_accept && readyA.result_version === 1, "A is ready at version 1");
  check(readyB !== null && readyB.can_accept && readyB.result_version === 1, "B is ready at version 1");
  const toldAbout = (id: string) => receiver.received.some((r) => r.type === "assistant.say" && r.item?.item_id === id && r.item.can_accept);
  check(await until(() => (toldAbout(itemA!.item_id) ? true : undefined), Date.now() + 60_000, 500) === true, "the user was told A is ready, with something to accept");
  check(await until(() => (toldAbout(itemB!.item_id) ? true : undefined), Date.now() + 60_000, 500) === true, "the user was told B is ready, with something to accept");
  for (const [name, file, item] of [["A", "a.txt", fullA], ["B", "b.txt", fullB]] as const) {
    const f = await api("GET", `/v1/sessions/${item!.worker_session_id}/files/${file}`);
    check(f.status === 200 && String(typeof f.json === "string" ? f.json : JSON.stringify(f.json)).includes(`${name}-done`), `${file} holds ${name}-done`);
    const other = name === "A" ? "B" : "A";
    check(!String(typeof f.json === "string" ? f.json : JSON.stringify(f.json)).includes(`${other}-done`), `${file} does not hold ${other}'s result`);
  }

  // 5. Acceptance is of a version.
  check((await api("POST", `/v1/work-items/${itemA!.item_id}/accept`, { version: 1 })).status === 200, "accepting A at version 1 succeeds");
  check((await api("POST", `/v1/work-items/${itemB!.item_id}/accept`, { version: 0 })).status === 409, "accepting B at version 0 is refused");
  check((await api("POST", `/v1/work-items/${itemB!.item_id}/accept`, { version: 1 })).status === 200, "accepting B at version 1 succeeds");
  const done = await board("done");
  check([itemA!, itemB!].every((i) => done.find((d) => d.item_id === i.item_id)?.outcome === "accepted"), "both are done and accepted");

  // 6. Faults.
  if (KEY_B) {
    const other = await Promise.all([
      apiAs(KEY_B)("GET", `/v1/work-items/${itemA!.item_id}`),
      apiAs(KEY_B)("POST", `/v1/work-items/${itemA!.item_id}/accept`, { version: 1 }),
      apiAs(KEY_B)("POST", `/v1/work-items/${itemA!.item_id}/stop`),
    ]);
    check(other.every((r) => r.status === 404), "another user's read, accept and stop of A are all 404");
  } else log("skip", "cross-user check (KEY_B not given)");

  if (CHAOS.has("stale")) await staleReport(itemA!);
  if (CHAOS.has("restart")) await restartDuringWork(send, receiver, newItem, known);
  if (CHAOS.has("receiver")) await refusedReceiver(send, receiver, newItem, known, subscriptionId);

  // 7. The soak, and the totals that must be zero. The workers so far are done with: their sandboxes go first.
  check(await retireAll(runItems.keys()), "the items so far are closed and their workers deleted");
  const soak: number[] = [];
  let roundsRun = 0;
  for (let round = 1; round <= SOAK_ROUNDS; round++) {
    if (!await sandboxGuard(round)) { log("FAIL", `soak round ${round}: stopping the run, too many of its sandboxes are alive`); break; }
    soak.push(...await soakRound(round, send, receiver));
    roundsRun = round;
  }
  if (SOAK_ROUNDS) check(roundsRun === SOAK_ROUNDS, `all ${SOAK_ROUNDS} soak rounds ran (${roundsRun})`);

  const dups = duplicateEventIds(receiver.received);
  check(dups.length === 0, `no event was accepted twice (${dups.length})`);
  const needing = (await board("needs_you")).filter((i) => Date.now() - Date.parse(i.updated_at) > (SILENT_SWEEP_SEC + 120) * 1000);
  const silent = needing.filter((i) => !receiver.received.some((r) => r.item?.item_id === i.item_id));
  check(silent.length === 0, `no item has needed the user for over ${SILENT_SWEEP_SEC + 120}s without a message (${silent.length})`);

  const all = [...timings.map((t) => latencyMs(t) as number), ...soak];
  const summary = {
    ok: failures.length === 0, failures,
    interjections: timings.map((t) => ({ label: t.label, ms: latencyMs(t) })),
    run_tag: RUN_TAG,
    soak: SOAK_ROUNDS ? { rounds: roundsRun, samples: soak.length, p95_ms: percentile(soak, 95), max_ms: soak.length ? Math.max(...soak) : null } : null,
    p95_ms: percentile(all.filter((n) => n !== null), 95),
    says: receiver.received.filter((r) => r.type === "assistant.say").length,
    needs_you_fallbacks: receiver.received.filter((r) => r.type === "work_item.needs_you").length,
    duplicate_event_ids: dups.length, silent_items: silent.length,
  };
  if (SOAK_ROUNDS) check((summary.soak!.p95_ms ?? Infinity) < SAY_BUDGET_MS, `the soak's P95 is under ${SAY_BUDGET_MS}ms (${summary.soak!.p95_ms}ms, max ${summary.soak!.max_ms}ms)`);
  summary.ok = failures.length === 0;
  console.log(JSON.stringify(summary));
  summaryPrinted = true;
  return "finished";
}

/** Waits until the item is ready to accept, or the deadline passes (null). */
const ready = async (id: string, deadlineAt: number) => until(async () => {
  const it = await itemOf(id);
  return it && it.board_state === "needs_you" && it.last_report_kind === "ready" ? it : undefined;
}, deadlineAt, 2000);

/** Before a soak round: no more than SANDBOX_MAX of this run's sandboxes may still be alive. Unreadable is a failure. */
async function sandboxGuard(round: number): Promise<boolean> {
  let alive: string[];
  try {
    const out = await run("kubectl", [...KUBECTL_ARGS, "get", "workloads.amd.com", "-l", SESSION_ID_LABEL, "-o", "json"], { maxBuffer: 256 << 20 });
    alive = aliveSandboxes(JSON.parse(out.stdout), runSessions);
  } catch (err) {
    return check(false, `soak round ${round}: this run's sandboxes could be counted (${err instanceof Error ? err.message.split("\n")[0] : err})`);
  }
  return check(alive.length <= SANDBOX_MAX, `soak round ${round}: at most ${SANDBOX_MAX} of this run's sandboxes are alive (${alive.length}${alive.length ? `: ${alive.join(" ")}` : ""})`);
}

type Send = (content: string) => Promise<number>;
type NewItem = (since: number) => Promise<ItemView | null>;
type Rec = Awaited<ReturnType<typeof startReceiver>>;

/** A worker's token for a run that is over, used to report: refused, and the item does not move. */
async function staleReport(item: ItemView): Promise<void> {
  const url = need("ASSISTANT_MCP_URL");
  const key = need("CLAW_ASSISTANT_TOKEN_KEY");
  const before = await itemOf(item.item_id);
  const token = mintAssistantToken({
    sid: before!.worker_session_id!, role: "worker", item_id: item.item_id, gen: 0,
    mid: "claw-e2e-stale", task_id: "ktsk_e2e_stale", exp: Math.floor(Date.now() / 1000) + 300,
  }, key);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report", arguments: { kind: "ready", summary: "forged" } } }),
  });
  const text = await res.text();
  check(res.status === 200 && /turn_not_live|stale_run/.test(text), `a report with a stale token is refused (${text.slice(0, 120)})`);
  const after = await itemOf(item.item_id);
  check(JSON.stringify([before?.board_state, before?.result_version]) === JSON.stringify([after?.board_state, after?.result_version]), "and the item did not move");
}

/** The API is restarted while work runs: the items are still there, finish, and nothing is said twice. */
async function restartDuringWork(send: Send, receiver: Rec, newItem: NewItem, known: Set<string>): Promise<void> {
  const rollout = need("KUBECTL_ROLLOUT").split(/\s+/);
  const t = await send(taskText("R", "r.txt", 30));
  const item = await newItem(t);
  if (!check(item !== null, "chaos restart: the task was taken on")) return;
  known.add(item!.item_id);
  const restarted = await run("kubectl", ["rollout", "restart", ...rollout]);
  log("kubectl rollout restart:", restarted.stdout.trim());
  const status = await run("kubectl", ["rollout", "status", ...rollout, "--timeout=600s"]).then(() => true, () => false);
  check(status, "chaos restart: the rollout completed");
  const again = await itemOf(item!.item_id);
  check(again !== null, "chaos restart: the item is still on the board");
  const done = await ready(item!.item_id, Date.now() + DONE_WAIT_MS);
  check(done !== null, "chaos restart: it still finished");
  check(duplicateEventIds(receiver.received).length === 0, "chaos restart: and nothing was delivered twice");
}

/** A receiver that refuses: the board still says so, and once it answers the user is told exactly once. */
async function refusedReceiver(send: Send, receiver: Rec, newItem: NewItem, known: Set<string>, subscriptionId: string): Promise<void> {
  receiver.setRejecting(true);
  const t = await send(taskText("F", "f.txt", 5));
  const item = await newItem(t);
  if (!check(item !== null, "chaos receiver: the task was taken on")) { receiver.setRejecting(false); return; }
  known.add(item!.item_id);
  const needs = await until(async () => (await itemOf(item!.item_id))?.board_state === "needs_you" ? true : undefined, Date.now() + DONE_WAIT_MS, 2000);
  check(needs === true, "chaos receiver: the board shows it needs the user while no message could be delivered");
  const waitUntil = Date.now() + RECEIVER_HOLD_SEC * 1000;
  log(`chaos receiver: holding the receiver closed until ${new Date(waitUntil).toISOString()}`);
  await until(() => (Date.now() >= waitUntil ? true : undefined), waitUntil + 1000, 5000);
  receiver.setRejecting(false);
  await api("PATCH", `/v1/notification-subscriptions/${subscriptionId}`, { enabled: true });
  const fallbacks = () => receiver.received.filter((r) => r.type === "work_item.needs_you" && r.item?.item_id === item!.item_id);
  const got = await until(() => (fallbacks().length ? true : undefined), Date.now() + 5 * 60_000, 2000);
  check(got === true, "chaos receiver: the system's own message arrived once the receiver answered");
  await until(() => undefined, Date.now() + 30_000, 5000);
  check(fallbacks().length === 1, `chaos receiver: and there is exactly one (${fallbacks().length})`);
}

/**
 * One short A/B round with two interjections, for the latency distribution. Everything the round creates is closed
 * in the round: both items accepted (or stopped when not ready in time) and their workers deleted. Returns the
 * interjection latencies.
 */
async function soakRound(round: number, send: Send, receiver: Rec): Promise<number[]> {
  const floor = Math.max(0, ...(await board()).map((i) => Number(i.seq)));
  const startedAt = Date.now();
  const name = (x: string) => `${RUN_TAG}-S${round}${x}`;
  const t = await send(`Task ${name("a")}: write "${name("a")}" into /workspace/s${round}a.txt. Task ${name("b")}: write "${name("b")}" into /workspace/s${round}b.txt. Start both now.`);
  const mine = new Map<string, number>();
  const collect = async () => {
    for (const i of newItemsSince(await board(), floor, new Set(runItems.keys()))) { mine.set(i.item_id, i.seq); await track(i.item_id); }
  };
  await until(async () => { await collect(); return mine.size >= 2 ? true : undefined; }, t + SAY_BUDGET_MS * 3, 1000);
  check(mine.size === 2, `soak round ${round}: both tasks are on the board (${mine.size})`);
  const out: number[] = [];
  for (const q of ["How are the two tasks going?", "Which of them is done?"]) {
    const sent = await send(q);
    // A "ready, accept it" message is the system reporting a task, not the answer to this question.
    const said = await until(() => receiver.received.find((r) => r.type === "assistant.say" && r.at >= sent && !r.item?.can_accept), sent + SAY_BUDGET_MS * 3, 100);
    out.push(said ? said.at - sent : Number.POSITIVE_INFINITY);
  }
  const deadline = startedAt + SOAK_DONE_WAIT_MS;
  for (const [id, seq] of mine) {
    const it = await ready(id, deadline);
    if (check(it !== null, `soak round ${round}: #${seq} is ready in time`)) {
      check((await api("POST", `/v1/work-items/${id}/accept`, { version: it!.result_version })).status === 200, `soak round ${round}: #${seq} is accepted`);
    }
  }
  await collect();
  check(await retireAll(mine.keys()), `soak round ${round}: its ${mine.size} items are closed and their workers deleted`);
  log(`soak round ${round}:`, out.map((n) => (Number.isFinite(n) ? `${n}ms` : "no answer")).join(", "));
  return out;
}

main().catch((err) => {
  console.error(iso(), "the scenario could not be carried out:", err instanceof Error ? err.message : err);
  console.log(JSON.stringify({ ok: false, failures: [...failures, String(err)] }));
  process.exit(1);
});
