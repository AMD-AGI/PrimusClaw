// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { ChildRegistry, processStart } from "../src/children.js";
import {
  CredentialsError, DeviceTokenProvider, GrantRevokedError, TransientAuthError, loadCredentials, saveCredentials, type Credentials,
} from "../src/credentials.js";
import { DeviceFlowError, deviceLogin } from "../src/deviceflow.js";
import { fileAudit } from "../src/audit.js";
import { DROPPABLE_TYPES, Outbox } from "../src/outbox.js";
import { PermissionBook, boundedInput, matchAutoAllow, normalizeOptions } from "../src/permissions.js";
import { CommandLedger } from "../src/connector.js";
import { SessionStore } from "../src/session-store.js";
import { UrlError, sleep } from "../src/util.js";
import { FakeIdentity } from "./support/fake-identity.js";

const tmp = (p = "cc-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SID = "11111111-1111-4111-8111-111111111111";
const SID2 = "22222222-2222-4222-8222-222222222222";

describe("outbox", () => {
  test("sequence numbers continue across a restart, and unacknowledged events survive it", () => {
    const dir = tmp();
    const a = new Outbox({ dir });
    assert.deepEqual([1, 2, 3].map(() => a.append(SID, "agent_message_chunk", { n: 1 }).seq), [1, 2, 3]);
    a.ack({ [SID]: 2 });
    const b = new Outbox({ dir });
    assert.deepEqual(b.pending(10).map((e) => e.seq), [3]);
    assert.equal(b.append(SID, "turn_end", {}).seq, 4, "the next number is never one that was already used");
  });
  test("a restart with nothing acknowledged yet (a crash) does not reuse a number either", () => {
    const dir = tmp();
    const a = new Outbox({ dir });
    for (let i = 0; i < 3; i++) a.append(SID, "x", {});
    const b = new Outbox({ dir });
    assert.deepEqual(b.pending(10).map((e) => e.seq), [1, 2, 3]);
    assert.equal(b.append(SID, "x", {}).seq, 4);
  });
  test("a restart after everything was acknowledged still does not reuse a number", () => {
    const dir = tmp();
    const a = new Outbox({ dir });
    for (let i = 0; i < 5; i++) a.append(SID, "x", {});
    a.ack({ [SID]: 5 });
    assert.equal(new Outbox({ dir }).append(SID, "x", {}).seq, 6);
  });
  test("a crash that left a torn last line loses only that line", () => {
    const dir = tmp();
    const a = new Outbox({ dir });
    a.append(SID, "x", {});
    fs.appendFileSync(path.join(dir, `${SID}.jsonl`), '{"session_id":"x","seq":');
    const b = new Outbox({ dir });
    assert.deepEqual(b.pending(10).map((e) => e.seq), [1]);
    assert.equal(b.append(SID, "x", {}).seq, 2);
  });
  test("pending is in append order across sessions; ack is per session; an acknowledgement below an event keeps it", () => {
    const o = new Outbox({ dir: tmp() });
    o.append(SID, "x", {}); o.append(SID2, "x", {}); o.append(SID, "x", {});
    assert.deepEqual(o.pending(2).map((e) => [e.session_id === SID ? 1 : 2, e.seq]), [[1, 1], [2, 1]]);
    o.ack({ [SID]: 1 });
    assert.deepEqual(o.pending(10).map((e) => [e.session_id === SID ? 1 : 2, e.seq]), [[2, 1], [1, 2]]);
    o.ack({ [SID2]: 0 });
    assert.equal(o.size, 2);
  });
  test("a refused event is dropped and does not come back after a restart", () => {
    const dir = tmp();
    const o = new Outbox({ dir });
    o.append(SID, "x", {}); o.append(SID, "x", {});
    o.drop(SID, 1);
    assert.deepEqual(new Outbox({ dir }).pending(10).map((e) => e.seq), [2]);
  });
  test("over its cap a session sheds only streaming events, never a permission request or a turn end", () => {
    const o = new Outbox({ dir: tmp(), maxBytesPerSession: 4000 });
    o.append(SID, "permissionRequest", { actionId: "a", pad: "p".repeat(500) });
    for (let i = 0; i < 40; i++) o.append(SID, "agent_message_chunk", { text: "t".repeat(300) });
    o.append(SID, "turn_end", { stopReason: "end_turn" });
    const kept = o.pending(1000).map((e) => e.type);
    assert.ok(kept.includes("permissionRequest") && kept.includes("turn_end"));
    assert.ok(kept.filter((t) => t === "agent_message_chunk").length < 40, "some chunks were shed");
    assert.ok([...new Set(kept)].every((t) => !DROPPABLE_TYPES.has(t) || t === "agent_message_chunk"));
    // Nothing droppable is left to shed when the rest is not droppable: it is kept, over the cap.
    const p = new Outbox({ dir: tmp(), maxBytesPerSession: 1000 });
    for (let i = 0; i < 10; i++) p.append(SID, "permissionRequest", { actionId: String(i), pad: "p".repeat(300) });
    assert.equal(p.size, 10);
  });
  test("shedding does not lose the high-water mark: an event shed right after it was written does not let its number come back after a restart", () => {
    const dir = tmp();
    const o = new Outbox({ dir, maxBytesPerSession: 600 });
    assert.equal(o.append(SID, "permissionRequest", { actionId: "a" }).seq, 1);
    assert.equal(o.append(SID, "agent_message_chunk", { text: "t".repeat(1000) }).seq, 2); // over the cap by itself: shed at once
    assert.deepEqual(o.pending(10).map((e) => e.seq), [1]);
    // The log no longer holds a line numbered 2; only the saved high-water mark remembers it.
    assert.equal(new Outbox({ dir }).append(SID, "x", {}).seq, 3);
  });
  test("a refused event that was the newest does not let its number come back", () => {
    const dir = tmp();
    const o = new Outbox({ dir });
    o.append(SID, "x", {}); o.append(SID, "x", {});
    o.drop(SID, 2);
    assert.equal(new Outbox({ dir }).append(SID, "x", {}).seq, 3);
  });
  test("an event over the size limit keeps its type and says what happened", () => {
    const o = new Outbox({ dir: tmp() });
    const ev = o.append(SID, "tool_call_update", { text: "z".repeat(70_000) });
    assert.deepEqual(ev.data, { truncated: true, original_bytes: 70_000 + '{"text":""}'.length });
  });
  test("a closed session's files go once everything is acknowledged", () => {
    const dir = tmp();
    const o = new Outbox({ dir });
    o.append(SID, "session_closed", {});
    o.markClosed(SID);
    assert.ok(fs.readdirSync(dir).length > 0);
    o.ack({ [SID]: 1 });
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

describe("permission book", () => {
  const options = normalizeOptions([
    { optionId: "allow-once", name: "Yes", kind: "allow_once" }, { optionId: "allow-with-updates", name: "Always", kind: "allow_always" }, { optionId: "reject", name: "No", kind: "reject_once" },
  ]);
  test("normalizeOptions keeps the adapter's ids verbatim, drops junk, caps the list", () => {
    assert.deepEqual(options.map((o) => o.optionId), ["allow-once", "allow-with-updates", "reject"]);
    assert.deepEqual(normalizeOptions([{ optionId: "" }, { name: "x" }, 7, null, { optionId: "k" }]), [{ optionId: "k", name: "k", kind: "allow_once" }]);
    assert.deepEqual(normalizeOptions("nope"), []);
    assert.equal(normalizeOptions(Array.from({ length: 40 }, (_, i) => ({ optionId: `o${i}` }))).length, 12);
  });
  test("only an offered option answers; anything else leaves the request waiting", () => {
    const answers: Array<string | null> = [];
    const book = new PermissionBook(60_000, () => {});
    const p = book.open(options, (id) => ({ actionId: id }), (o) => answers.push(o));
    assert.deepEqual(book.decide(p.actionId, "bypass-everything"), { ok: false, reason: "option_not_offered" });
    assert.deepEqual(book.decide("nope", "allow-once"), { ok: false, reason: "unknown_action" });
    assert.deepEqual(answers, []);
    assert.equal(book.size, 1);
    assert.deepEqual(book.decide(p.actionId, "allow-with-updates"), { ok: true, optionId: "allow-with-updates" });
    assert.deepEqual(answers, ["allow-with-updates"]);
    assert.deepEqual(book.decide(p.actionId, "allow-once"), { ok: false, reason: "unknown_action" }, "answered once however often it is clicked");
  });
  test("an unanswered request is answered cancelled after the time-to-live", async () => {
    const answers: Array<string | null> = [];
    const expired: string[] = [];
    const book = new PermissionBook(40, (id) => expired.push(id));
    const p = book.open(options, (id) => ({ actionId: id }), (o) => answers.push(o));
    await sleep(120);
    assert.deepEqual(answers, [null]);
    assert.deepEqual(expired, [p.actionId]);
    assert.equal(book.size, 0);
  });
  test("cancelAll answers every waiting request cancelled", () => {
    const answers: Array<string | null> = [];
    const book = new PermissionBook(60_000, () => {});
    book.open(options, (id) => ({ actionId: id }), (o) => answers.push(o));
    book.open(options, (id) => ({ actionId: id }), (o) => answers.push(o));
    assert.equal(book.cancelAll().length, 2);
    assert.deepEqual(answers, [null, null]);
  });
  test("boundedInput passes a small input through and cuts a large one", () => {
    assert.deepEqual(boundedInput({ a: 1 }), { a: 1 });
    assert.equal(boundedInput(undefined), null);
    const big = boundedInput({ content: "x".repeat(10_000) }) as string;
    assert.equal(typeof big, "string");
    assert.match(big, /truncated, \d+ bytes in all/);
  });

  describe("auto-allow", () => {
    const cwd = fs.realpathSync(tmp());
    fs.mkdirSync(path.join(cwd, "docs"));
    fs.mkdirSync(path.join(cwd, "src"));
    const rules = [{ kind: "edit", pathGlob: "docs/**" }];
    const call = (kind: string, ...paths: string[]) => ({ kind, locations: paths.map((p) => ({ path: p })) });
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ["an edit inside docs", call("edit", path.join(cwd, "docs", "a.md")), true],
      ["a relative path inside docs", call("edit", "docs/a.md"), true],
      ["an edit outside the glob", call("edit", path.join(cwd, "src", "a.ts")), false],
      ["another kind in docs", call("execute", path.join(cwd, "docs", "a.md")), false],
      ["one path in, one out", call("edit", path.join(cwd, "docs", "a.md"), path.join(cwd, "src", "a.ts")), false],
      ["a path that climbs out of the directory", call("edit", path.join(cwd, "docs", "..", "..", "etc", "x")), false],
      ["no path at all", { kind: "edit" }, false],
      ["a path only in the raw input", { kind: "edit", rawInput: { file_path: path.join(cwd, "docs", "b.md") } }, true],
    ];
    for (const [name, toolCall, want] of cases) test(name, () => assert.equal(matchAutoAllow(rules, toolCall, cwd) !== null, want));
    test("no rules never matches", () => assert.equal(matchAutoAllow([], call("edit", "docs/a.md"), cwd), null));
    test("a rule that matches every path still cannot reach outside the directory", () => {
      const everything = [{ kind: "edit", pathGlob: "**" }];
      const outside = fs.realpathSync(tmp("cc-outside-"));
      assert.equal(matchAutoAllow(everything, call("edit", path.join(outside, "x.txt")), cwd), null);
      assert.equal(matchAutoAllow(everything, call("edit", "../../x"), cwd), null);
      assert.notEqual(matchAutoAllow(everything, call("edit", "docs/a.md"), cwd), null);
    });
  });
});

describe("credentials are never sent over plain http", () => {
  test("the client, the token refresh and the device sign-in all refuse an http URL that is not this machine, without making a request", async () => {
    const { ClawClient } = await import("../src/claw-client.js");
    const mustNotBeCalled = (async () => { throw new Error("a request was made"); }) as unknown as typeof fetch;
    assert.throws(() => new ClawClient({ server: "http://claw.example/api", tokens: { async bearer() { return "t"; }, invalidate() {} }, fetch: mustNotBeCalled }), UrlError);
    const p = new DeviceTokenProvider({ creds: { v: 1, server: "s", kind: "device", identity_url: "http://identity.example", refresh_token: "r", saved_at: "" }, save: () => {}, fetch: mustNotBeCalled });
    await assert.rejects(p.bearer(), UrlError);
    await assert.rejects(deviceLogin({ identityUrl: "http://identity.example", deviceName: "h", fetch: mustNotBeCalled }), UrlError);
  });
});

describe("Claw client credentials", () => {
  test("a 401 that is not a revocation gets one retry with a fresh credential; a second 401 is an error", async () => {
    const { FakeClaw } = await import("./support/fake-claw.js");
    const { ClawClient, HttpError } = await import("../src/claw-client.js");
    const claw = await FakeClaw.start();
    try {
      let issued = 0;
      const tokens = { async bearer() { return issued === 0 ? "stale" : "good-token"; }, invalidate() { issued++; } };
      const client = new ClawClient({ server: claw.url, tokens });
      assert.equal(await client.register("n", "v"), claw.connectorId, "the retry carried the new credential");
      assert.equal(issued, 1);
      const never = new ClawClient({ server: claw.url, tokens: { async bearer() { return "stale"; }, invalidate() {} } });
      await assert.rejects(never.register("n", "v"), (e) => e instanceof HttpError && e.status === 401);
    } finally { await claw.close(); }
  });
});

describe("session store: permission requests nobody answered", () => {
  test("kept until answered, handed back once after a crash", () => {
    const file = path.join(tmp(), "sessions.json");
    const a = new SessionStore(file);
    a.addPending("s1", "a1"); a.addPending("s1", "a2"); a.addPending("s2", "b1");
    a.removePending("s1", "a1");
    const b = new SessionStore(file);
    assert.deepEqual(b.takePending(), [{ session_id: "s1", action_id: "a2" }, { session_id: "s2", action_id: "b1" }]);
    assert.deepEqual(new SessionStore(file).takePending(), [], "forgotten once handed back");
  });
});

describe("command ledger", () => {
  test("the cursor sent to the server never passes a command still in flight", () => {
    const l = new CommandLedger();
    l.begin(1, "a"); l.begin(2, "b"); l.begin(3, "c");
    l.end(2, "b");
    assert.equal(l.cursor, 0, "1 is still running: the server must keep it");
    l.end(1, "a");
    assert.equal(l.cursor, 2, "3 is still running");
    l.end(3, "c");
    assert.equal(l.cursor, 3);
  });
  test("seen: by number at or below the cursor, by id, and while in flight", () => {
    const l = new CommandLedger(5, ["old"]);
    assert.deepEqual([l.seen(5, "x"), l.seen(6, "old"), l.seen(6, "new")], [true, true, false]);
    l.begin(6, "new");
    assert.deepEqual([l.seen(6, "other"), l.seen(7, "new"), l.seen(7, "fresh")], [true, true, false]);
  });
  test("the id list is bounded", () => {
    const l = new CommandLedger();
    for (let i = 1; i <= 600; i++) { l.begin(i, `c${i}`); l.end(i, `c${i}`); }
    assert.equal(l.recentIds.length, 500);
    assert.equal(l.recentIds.at(-1), "c600");
  });
});

describe("audit log", () => {
  test("one JSON object per line, appended 0600; a detail field can never overwrite what the record is; secrets in details are masked", () => {
    const file = path.join(tmp(), "state", "audit.jsonl");
    const a = fileAudit(file, () => 1_700_000_000_000);
    a.record("auto_allow", { kind: "edit", note: "Bearer abcdefghijklmnopqrstuvwxyz0123" });
    a.record("second");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.kind), ["auto_allow", "second"]);
    assert.equal(lines[0].ts, "2023-11-14T22:13:20.000Z");
    assert.equal(lines[0].note, "[hidden]");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe("credentials file", () => {
  const creds: Credentials = { v: 1, server: "http://x", kind: "device", identity_url: "http://id", client_id: "claw-connector", refresh_token: "r1", saved_at: "now" };
  test("written 0600 and read back; a lax mode is refused", () => {
    const file = path.join(tmp(), "cfg", "credentials.json");
    saveCredentials(file, creds);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(loadCredentials(file), creds);
    fs.chmodSync(file, 0o644);
    assert.throws(() => loadCredentials(file), (e) => e instanceof CredentialsError && /readable by other users/.test(e.message));
    fs.chmodSync(file, 0o640);
    assert.throws(() => loadCredentials(file), CredentialsError);
  });
  test("missing is null; garbage is an error", () => {
    const d = tmp();
    assert.equal(loadCredentials(path.join(d, "none.json")), null);
    fs.writeFileSync(path.join(d, "bad.json"), "{nope", { mode: 0o600 });
    assert.throws(() => loadCredentials(path.join(d, "bad.json")), CredentialsError);
    fs.writeFileSync(path.join(d, "odd.json"), '{"v":1}', { mode: 0o600 });
    assert.throws(() => loadCredentials(path.join(d, "odd.json")), CredentialsError);
  });
});

describe("token provider (rotating refresh)", () => {
  test("refreshes before expiry, stores the NEW refresh token before using the access token, and is single-flight", async () => {
    const id = await FakeIdentity.start();
    try {
      id.refreshTokens.add("r1");
      let clock = 1_000_000;
      const saved: string[] = [];
      const p = new DeviceTokenProvider({
        creds: { v: 1, server: "s", kind: "device", identity_url: id.url, refresh_token: "r1", saved_at: "" },
        save: (c) => saved.push(c.refresh_token!), now: () => clock, skewMs: 60_000,
      });
      const [a, b, c] = await Promise.all([p.bearer(), p.bearer(), p.bearer()]);
      assert.equal(id.requests.filter((r) => r.form.grant_type === "refresh_token").length, 1, "one refresh for three callers");
      assert.deepEqual([a, b, c], ["access-1", "access-1", "access-1"]);
      assert.deepEqual(saved, ["refresh-1"]);
      assert.equal(await p.bearer(), "access-1", "still fresh: no second refresh");
      clock += 241_000; // 300 s lifetime, 60 s skew
      assert.equal(await p.bearer(), "access-2");
      assert.deepEqual(saved, ["refresh-1", "refresh-2"]);
      p.invalidate();
      assert.equal(await p.bearer(), "access-3");
      assert.ok(id.requests.filter((r) => r.form.grant_type === "refresh_token").every((r) => r.form.scope === "claw.connector"), "every refresh asks for it again");
    } finally { await id.close(); }
  });
  test("an invalid_grant means the sign-in was revoked; a network failure is only transient", async () => {
    const id = await FakeIdentity.start();
    try {
      const mk = () => new DeviceTokenProvider({ creds: { v: 1, server: "s", kind: "device", identity_url: id.url, refresh_token: "stale", saved_at: "" }, save: () => {} });
      await assert.rejects(mk().bearer(), GrantRevokedError);
      const dead = new DeviceTokenProvider({ creds: { v: 1, server: "s", kind: "device", identity_url: "http://127.0.0.1:1", refresh_token: "r", saved_at: "" }, save: () => {} });
      await assert.rejects(dead.bearer(), TransientAuthError);
      id.refreshError = "temporarily_unavailable";
      await assert.rejects(mk().bearer(), TransientAuthError);
    } finally { await id.close(); }
  });
});

describe("device authorization flow (RFC 8628)", () => {
  const run = async (script: FakeIdentity["pollScript"], tweak: (i: FakeIdentity) => void = () => {}) => {
    const id = await FakeIdentity.start();
    id.pollScript = script;
    tweak(id);
    const waits: number[] = [];
    const lines: string[] = [];
    try {
      const out = await deviceLogin({ identityUrl: id.url, deviceName: "dev-box", sleep: async (ms) => { waits.push(ms); }, print: (l) => lines.push(l) }).then((tok): { tok?: Awaited<ReturnType<typeof deviceLogin>>; error?: any } => ({ tok }), (error): { tok?: undefined; error?: any } => ({ error }));
      return { id, waits, lines, ...out };
    } finally { await id.close(); }
  };
  test("pending, then slow_down (the interval grows by 5 s), then the tokens", async () => {
    const r = await run(["authorization_pending", "authorization_pending", "slow_down", "ok"]);
    assert.deepEqual(r.waits, [1000, 1000, 1000, 6000], "polls at the server's interval; slow_down adds 5 s");
    assert.equal(r.tok?.refresh_token, "refresh-1");
    assert.match(r.lines.join("\n"), /ABCD-EFGH/);
    const auth = r.id.requests[0]!;
    assert.deepEqual([auth.path, auth.form.client_id, auth.form.device_name], ["/oauth/device_authorization", "claw-connector", "dev-box"]);
    assert.equal(auth.form.scope, "claw.connector", "the scope Claw's connector routes require is asked for, not left to the provider's defaults");
    const poll = r.id.requests[1]!;
    assert.deepEqual([poll.form.grant_type, poll.form.device_code], ["urn:ietf:params:oauth:grant-type:device_code", "dev-code-1"]);
  });
  test("denied in the browser", async () => {
    const r = await run(["authorization_pending", "access_denied"]);
    assert.ok(r.error instanceof DeviceFlowError && r.error.code === "access_denied");
  });
  test("the server says the code expired", async () => {
    const r = await run(["expired_token"]);
    assert.ok(r.error instanceof DeviceFlowError && r.error.code === "expired_token");
  });
  test("the code's own lifetime ends the wait even if the server keeps saying pending", async () => {
    const id = await FakeIdentity.start();
    id.pollScript = ["authorization_pending"];
    id.expiresIn = 30;
    let clock = 0;
    try {
      const err = await deviceLogin({ identityUrl: id.url, deviceName: "h", sleep: async (ms) => { clock += ms; }, now: () => clock }).catch((e) => e);
      assert.ok(err instanceof DeviceFlowError && err.code === "expired_token");
      assert.ok(id.polls.length >= 2 && id.polls.length <= 31);
    } finally { await id.close(); }
  });
  test("a service that keeps answering 5xx ends the flow after five answers, but one that recovers is waited for", async () => {
    const dead = await run(["server_error"]);
    assert.ok(dead.error instanceof DeviceFlowError && dead.error.code === "unreachable");
    assert.equal(dead.id.polls.length, 5);
    const flaky = await run(["server_error", "server_error", "authorization_pending", "server_error", "server_error", "ok"]);
    assert.equal(flaky.tok?.refresh_token, "refresh-1", "a real answer in between starts the count again");
  });
  test("an unreachable identity service ends the flow after a few tries", async () => {
    const err = await deviceLogin({ identityUrl: "http://127.0.0.1:1", deviceName: "h", sleep: async () => {} }).catch((e) => e);
    assert.ok(err instanceof DeviceFlowError && err.code === "unreachable");
  });
});

describe("recorded child processes", () => {
  test("only a recorded process whose start time still matches is signalled", async () => {
    const dir = tmp();
    const reg = new ChildRegistry(path.join(dir, "children.json"));
    const mine = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    const stale = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    try {
      reg.add({ pid: mine.pid!, pgid: mine.pid!, agent_id: "a", session_id: "s" });
      // A record whose pid now belongs to a different process (wrong start time) must be left alone.
      reg.add({ pid: stale.pid!, pgid: stale.pid!, agent_id: "a", session_id: "s", start: "1" });
      const res = await reg.killAll(500);
      assert.deepEqual(res.killed, [mine.pid]);
      assert.deepEqual(res.skipped, [stale.pid]);
      await sleep(100);
      assert.equal(processStart(mine.pid!), null, "the recorded process is gone");
      assert.notEqual(processStart(bystander.pid!), null, "an unrecorded process is untouched");
      assert.notEqual(processStart(stale.pid!), null, "a recycled pid is untouched");
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "children.json"), "utf8")), []);
    } finally {
      for (const p of [mine, bystander, stale]) { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } }
    }
  });
  const orphaned = async (reg: ChildRegistry) => {
    // A leader (think: an npx wrapper) that starts the real agent in its group and then dies, as when the connector was killed hard.
    const script = "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
    const leader = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const agent = Number(await new Promise<string>((r) => leader.stdout!.once("data", (d) => r(String(d).trim()))));
    reg.add({ pid: leader.pid!, pgid: leader.pid!, agent_id: "a", session_id: "s" }); // records the leader's start time while it lives
    const gone = new Promise<void>((r) => leader.once("exit", () => r()));
    process.kill(leader.pid!, "SIGKILL");
    await gone;
    assert.equal(processStart(leader.pid!), null, "the leader is gone");
    assert.notEqual(processStart(agent), null, "the agent it started is still running, in the leader's group");
    return { leader, agent };
  };
  test("an agent left behind by a dead group leader is still stopped (killAll), by the group it was recorded in", async () => {
    const reg = new ChildRegistry(path.join(tmp(), "children.json"));
    const { leader, agent } = await orphaned(reg);
    try {
      assert.equal(reg.isOurs(reg.list()[0]!), true);
      const res = await reg.killAll(500);
      assert.deepEqual(res.killed, [leader.pid]);
      await sleep(100);
      assert.equal(processStart(agent), null);
    } finally { try { process.kill(-leader.pid!, "SIGKILL"); } catch { /* gone */ } }
  });
  test("the same through kill() of one record, which is what an adapter's own stop uses", async () => {
    const reg = new ChildRegistry(path.join(tmp(), "children.json"));
    const { leader, agent } = await orphaned(reg);
    try {
      assert.equal(await reg.kill(leader.pid!, 500), true);
      await sleep(100);
      assert.equal(processStart(agent), null);
      assert.deepEqual(reg.list(), []);
    } finally { try { process.kill(-leader.pid!, "SIGKILL"); } catch { /* gone */ } }
  });
  test("a record whose leader is gone and whose group is empty is just dropped", async () => {
    const reg = new ChildRegistry(path.join(tmp(), "children.json"));
    const p = spawn(process.execPath, ["-e", "0"], { detached: true, stdio: "ignore" });
    reg.add({ pid: p.pid!, pgid: p.pid!, agent_id: "a", session_id: "s" });
    await new Promise<void>((r) => p.once("exit", () => r()));
    const res = await reg.killAll(200);
    assert.deepEqual([res.killed, res.skipped], [[], [p.pid]]);
  });
  test("a recorded group is stopped as a whole, grandchildren included", async () => {
    const dir = tmp();
    const reg = new ChildRegistry(path.join(dir, "children.json"));
    const script = "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log(c.pid);setInterval(()=>{},1000)";
    const leader = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const grandchild = Number(await new Promise<string>((r) => leader.stdout!.once("data", (d) => r(String(d).trim()))));
    try {
      reg.add({ pid: leader.pid!, pgid: leader.pid!, agent_id: "a", session_id: "s" });
      assert.notEqual(processStart(grandchild), null);
      const t0 = Date.now();
      await reg.killAll(5000);
      assert.ok(Date.now() - t0 < 2500, "the whole group got SIGTERM at once; nothing waited for the SIGKILL after the grace period");
      await sleep(100);
      assert.equal(processStart(grandchild), null, "the leader's child died with its group");
    } finally { try { process.kill(-leader.pid!, "SIGKILL"); } catch { /* gone */ } }
  });
});
