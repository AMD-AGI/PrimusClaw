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
import { DROPPABLE_TYPES, Outbox } from "../src/outbox.js";
import { PermissionBook, boundedInput, matchAutoAllow, normalizeOptions } from "../src/permissions.js";
import { sleep } from "../src/util.js";
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
  test("a recorded group is stopped as a whole, grandchildren included", async () => {
    const dir = tmp();
    const reg = new ChildRegistry(path.join(dir, "children.json"));
    const script = "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log(c.pid);setInterval(()=>{},1000)";
    const leader = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const grandchild = Number(await new Promise<string>((r) => leader.stdout!.once("data", (d) => r(String(d).trim()))));
    try {
      reg.add({ pid: leader.pid!, pgid: leader.pid!, agent_id: "a", session_id: "s" });
      assert.notEqual(processStart(grandchild), null);
      await reg.killAll(500);
      await sleep(100);
      assert.equal(processStart(grandchild), null, "the leader's child died with its group");
    } finally { try { process.kill(-leader.pid!, "SIGKILL"); } catch { /* gone */ } }
  });
});
