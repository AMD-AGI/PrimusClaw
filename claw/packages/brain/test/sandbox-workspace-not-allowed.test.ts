// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// SANDBOX_ALLOWED_NAMESPACES, Brain's half: the API refuses a request naming a
// workspace the deployment does not isolate, and each provider refuses to
// create a sandbox there for whatever reached it without that check (a session
// pinned before the list was set, a namespace only a template rendered). The
// refusal is terminal, made before the platform is asked for anything, and
// reads as a sentence for the person. Each refusal is paired with the same
// create in a listed workspace reaching the platform, and with no list at all.

process.env.AGENT_SANDBOX_ROUTER_URL = "http://router.test";

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

const { SafeWorkloadProvider } = await import("../src/sandbox/safe-workload-provider.js");
const { AgentSandboxProvider } = await import("../src/sandbox/agent-sandbox-provider.js");
const { SandboxProvisionTerminalError, SANDBOX_UNAVAILABLE_REASONS, SANDBOX_WORKSPACE_NOT_ALLOWED, assertSandboxWorkspaceAllowed } =
  await import("../src/sandbox/errors.js");

const KEYS = ["SANDBOX_ALLOWED_NAMESPACES", "SANDBOX_NAMESPACE", "SANDBOX_CPU_NAMESPACE", "AGENT_SANDBOX_NAMESPACE"];
const savedEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
let calls: string[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Record every platform call and answer it with a failure, so a create that got that far is visible. */
function recordFetch(): void {
  calls = [];
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response("stop here", { status: 500 });
  }) as unknown as typeof fetch;
}

function setList(value: string | undefined): void {
  for (const k of KEYS) delete process.env[k];
  if (value !== undefined) process.env.SANDBOX_ALLOWED_NAMESPACES = value;
}

const params = (namespace: string) => ({
  sessionId: "s", namespace, image: "img:1", resources: { cpu: "1" }, env: {}, platformKey: "pk", userId: "u",
});

const providers = [
  ["safe-workload", () => new SafeWorkloadProvider()],
  ["agent-sandbox", () => new AgentSandboxProvider()],
] as const;

for (const [name, make] of providers) {
  test(`${name}: a workspace off the list is refused terminally before the platform is asked`, async () => {
    setList("ws-isolated");
    recordFetch();
    const err = await make().create(params("ws-open") as never).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof SandboxProvisionTerminalError, String(err));
    assert.equal(err.reason, SANDBOX_WORKSPACE_NOT_ALLOWED);
    assert.match(err.message, /The ws-open workspace is not one of them/);
    assert.match(err.message, /\(default, ws-isolated\)/, "the list names the listed workspace and the default a request naming none goes to");
    assert.deepEqual(calls, [], "the platform was asked for a sandbox in a refused workspace");
  });

  test(`${name}: a listed workspace, and any workspace with no list, reaches the platform`, async () => {
    for (const list of ["ws-isolated", undefined]) {
      setList(list);
      recordFetch();
      const ws = list === undefined ? "ws-open" : "ws-isolated";
      const err = await make().create(params(ws) as never).then(() => null, (e: unknown) => e);
      assert.ok(!(err instanceof SandboxProvisionTerminalError && err.reason === SANDBOX_WORKSPACE_NOT_ALLOWED), String(err));
      assert.ok(calls.length > 0, `list ${String(list)}: ${ws} never reached the platform`);
    }
  });
}

test("the deployment's own default workspace is always allowed, so a request naming none still opens", async () => {
  setList("ws-isolated");
  process.env.SANDBOX_CPU_NAMESPACE = "ws-cpu";
  recordFetch();
  const err = await new SafeWorkloadProvider().create(params("ws-cpu") as never).then(() => null, (e: unknown) => e);
  assert.ok(!(err instanceof SandboxProvisionTerminalError && err.reason === SANDBOX_WORKSPACE_NOT_ALLOWED), String(err));
  assert.ok(calls.length > 0);
});

test("with SANDBOX_NAMESPACE / AGENT_SANDBOX_NAMESPACE unset, the \"default\" a request naming nothing lands in is allowed", async () => {
  // config.ts read neither at import (this file sets neither), so both are "default".
  for (const [name, make] of providers) {
    for (const ns of ["", "default"]) {
      setList("ws-isolated");
      recordFetch();
      const err = await make().create(params(ns) as never).then(() => null, (e: unknown) => e);
      assert.ok(!(err instanceof SandboxProvisionTerminalError && err.reason === SANDBOX_WORKSPACE_NOT_ALLOWED), `${name} ${JSON.stringify(ns)}: ${String(err)}`);
      assert.ok(calls.length > 0, `${name} ${JSON.stringify(ns)} never reached the platform`);
    }
  }
});

test("the defaults are the deploy mode's: kubernetes mode's AGENT_SANDBOX_NAMESPACE, safe mode's SANDBOX_NAMESPACE and CPU workspace", () => {
  const env = { SANDBOX_ALLOWED_NAMESPACES: "ws-isolated" };
  assert.doesNotThrow(() => assertSandboxWorkspaceAllowed("agent-ns", env, ["agent-ns"]));
  assert.doesNotThrow(() => assertSandboxWorkspaceAllowed("gpu-ws", env, ["gpu-ws", "cpu-ws"]));
  assert.doesNotThrow(() => assertSandboxWorkspaceAllowed("cpu-ws", env, ["gpu-ws", "cpu-ws"]));
  assert.throws(() => assertSandboxWorkspaceAllowed("other", env, ["gpu-ws", "cpu-ws"]), SandboxProvisionTerminalError);
  // No list: nothing is refused, whatever the defaults.
  assert.doesNotThrow(() => assertSandboxWorkspaceAllowed("other", {}, []));
});

test("a refused workspace is not offered to the model again: a second try names the same workspace", () => {
  assert.ok(SANDBOX_UNAVAILABLE_REASONS.has(SANDBOX_WORKSPACE_NOT_ALLOWED));
});
