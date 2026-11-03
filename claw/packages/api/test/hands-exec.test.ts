// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One command in an existing sandbox, over the real MCP client against a Hands
 * stand-in that speaks the real protocol: the token travels as a bearer, a command's
 * output and failure come back as Hands' own text and flag, and a sandbox that does
 * not answer is `SandboxUnreachableError` -- never a reason to start another.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { execInSandbox, SandboxUnreachableError } from "../src/sessions/hands-exec.js";
import { startHandsBashStub, type HandsBashStub } from "./support/hands-bash-stub.js";

let stub: HandsBashStub;
before(async () => { stub = await startHandsBashStub({ token: "tok-123", env: { PATH: process.env.PATH ?? "" } }); });
after(async () => { await stub.close(); });

test("a command's output comes back as text, with the timeout it was given and the token as a bearer", async () => {
  stub.commands.length = 0;
  const r = await execInSandbox({ url: stub.url, token: "tok-123" }, "echo hello; printf 'a\\0b'", 12);
  assert.deepEqual(r, { text: "hello\na\0b", isError: false });
  assert.deepEqual(stub.commands, [{ command: "echo hello; printf 'a\\0b'", timeout: 12 }]);
  assert.ok(stub.headers.length >= 1);
  assert.ok(stub.headers.every((h) => h.authorization === "Bearer tok-123"));
});

test("a command that fails is Hands' own error text and flag, not an exception", async () => {
  const r = await execInSandbox({ url: stub.url, token: "tok-123" }, "echo out; echo err >&2; exit 3", 10);
  assert.equal(r.isError, true);
  assert.match(r.text, /^exit 3\nstdout: out\n\nstderr: err\n$/);
});

test("a wrong token is an unreachable sandbox (the entry describes a different one), and nothing ran", async () => {
  stub.commands.length = 0;
  const before = stub.refused;
  await assert.rejects(() => execInSandbox({ url: stub.url, token: "wrong" }, "echo no", 10), SandboxUnreachableError);
  assert.equal(stub.commands.length, 0);
  assert.ok(stub.refused > before);
});

test("a closed port, a name that does not resolve and a server that answers nonsense are all unreachable", async () => {
  const closed = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  await assert.rejects(() => execInSandbox({ url: `http://127.0.0.1:${closed}/mcp`, token: "t" }, "echo x", 5), SandboxUnreachableError);
  await assert.rejects(() => execInSandbox({ url: "http://sandbox-that-is-gone.invalid/mcp", token: "t" }, "echo x", 5), SandboxUnreachableError);
  const junk = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("not mcp"); });
  await new Promise<void>((r) => junk.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(() => execInSandbox({ url: `http://127.0.0.1:${(junk.address() as net.AddressInfo).port}/mcp`, token: "t" }, "echo x", 5), SandboxUnreachableError);
  } finally {
    junk.closeAllConnections?.();
    await new Promise<void>((r) => junk.close(() => r()));
  }
});

test("a sandbox that accepts the connection and then goes quiet is unreachable at the timeout, not a hang", async () => {
  const silent = http.createServer((_req, _res) => { /* never answers */ });
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  const t0 = Date.now();
  try {
    await assert.rejects(
      () => execInSandbox({ url: `http://127.0.0.1:${(silent.address() as net.AddressInfo).port}/mcp`, token: "t" }, "echo x", 1),
      SandboxUnreachableError,
    );
  } finally {
    silent.closeAllConnections?.();
    await new Promise<void>((r) => silent.close(() => r()));
  }
  assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0} ms`);
});

test("a sandbox that answers the handshake and then dies mid-command is unreachable, and the reason says it was the call", async () => {
  const dying = await startHandsBashStub({ token: "tok-d", env: { PATH: process.env.PATH ?? "" }, dropToolCalls: true });
  try {
    await assert.rejects(
      () => execInSandbox({ url: dying.url, token: "tok-d" }, "echo x", 5),
      (err: unknown) => err instanceof SandboxUnreachableError && /^sandbox unreachable: call: /.test((err as Error).message),
    );
    assert.equal(dying.commands.length, 0, "the command never ran");
  } finally {
    await dying.close();
  }
});

test("the stand-in leaves no pooled connection for a server-side close to strand", async () => {
  // Its server closes a connection that has sat idle (six seconds, on the real clock), and this
  // process's client only hears of that on its next turn of the loop. A command sent in the same turn goes
  // out on a socket that is already shut -- "connect: fetch failed" -- and the changes route reports a
  // sandbox that is not running. In CI that was the command after one that had blocked the loop for six
  // seconds (git over 230 files), which no test could depend on. The close is made here directly, in the
  // turn the next command is sent, so it is the same on every run: with one connection per request there
  // is nothing idle to close, and the command goes out on a new one.
  const first = await execInSandbox({ url: stub.url, token: "tok-123" }, "echo one", 10);
  assert.equal(first.text.trim(), "one");
  stub.dropIdleConnections();
  const second = await execInSandbox({ url: stub.url, token: "tok-123" }, "echo two", 10);
  assert.equal(second.text.trim(), "two");
});
