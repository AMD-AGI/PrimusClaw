// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The probe's whole job is to be trusted by a caller that is about to destroy
 * a sandbox, so what matters is which answers license that and which do not.
 *
 * `dead` is the only one that does. The cases below are mostly about the ways
 * of not knowing -- an unreadable KV bucket, a Router that throws, a response
 * with no exit code, a caller that gave up -- because each of those used to
 * come back as `false` alongside a genuinely absent container, and `false` was
 * what the rebuild path took as permission to stop the workload.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  bindContainerProbeEffects,
  parseHandsProbeValue,
  probeSandboxContainer,
  sameHandsSandbox,
  HANDS_ENTRY_CORRUPT,
} from "../src/sandbox/container-probe.js";
import { SandboxGoneError } from "../src/sandbox/errors.js";
import type { SandboxInstance } from "../src/sandbox/provider.js";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function bind(over: Parameters<typeof bindContainerProbeEffects>[0]): void {
  restore = bindContainerProbeEffects(over);
}

const SAFE_ENTRY = {
  provider: "safe-workload",
  workloadId: "claw-sandbox-1",
  platformKey: "pk",
  namespace: "ns",
};
const AGENT_ENTRY = {
  provider: "agent-sandbox",
  sessionId: "sess-1",
  sandboxName: "box",
  namespace: "ns",
  userId: "u-1",
};

const neverExec = async (): Promise<never> => {
  throw new Error("exec must not run in this scenario");
};

test("exec exit 0 means the container is alive", async () => {
  const seen: SandboxInstance[] = [];
  bind({
    readHandsEntry: async () => SAFE_ENTRY,
    exec: async (inst) => {
      seen.push(inst);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(
    await probeSandboxContainer("sess-1"),
    { verdict: "alive", reason: "exec_ok" },
  );
  assert.equal(seen[0]?.id, "claw-sandbox-1");
  assert.equal(seen[0]?.provider, "safe-workload");
});

test("a missing KV entry is dead: KV answered, and named nothing to protect", async () => {
  bind({ readHandsEntry: async () => null, exec: neverExec });
  assert.deepEqual(
    await probeSandboxContainer("sess-1"),
    { verdict: "dead", reason: "no_kv_entry" },
  );
});

test("bytes that are not JSON are unknown, not an empty key", async () => {
  bind({
    readHandsEntry: async () => { throw new Error(HANDS_ENTRY_CORRUPT); },
    exec: neverExec,
  });
  assert.deepEqual(
    await probeSandboxContainer("sess-1"),
    { verdict: "unknown", reason: "entry_corrupt" },
  );
  assert.throws(() => parseHandsProbeValue("{"), { message: HANDS_ENTRY_CORRUPT });
  assert.equal(parseHandsProbeValue('{"workloadId":"w1"}').workloadId, "w1");
});

test("an entry with no workload to address is unknown, not probed", async () => {
  bind({ readHandsEntry: async () => ({ provider: "safe-workload" }), exec: neverExec });
  assert.deepEqual(
    await probeSandboxContainer("sess-1"),
    { verdict: "unknown", reason: "entry_unusable" },
  );
});

test("valid JSON with the wrong shape is corrupt, never dead", () => {
  for (const raw of ["null", "\"workload\"", "[]", "42", "true"]) {
    assert.throws(() => parseHandsProbeValue(raw), { message: HANDS_ENTRY_CORRUPT });
  }
});

test("a KV bucket that cannot be read is unknown, never dead", async () => {
  // The distinction the whole three-valued result exists for. This used to be
  // swallowed into `false`, so a NATS blip was indistinguishable from a
  // vanished container and licensed destroying a live one.
  bind({
    readHandsEntry: async () => { throw new Error("no responders for KV"); },
    exec: neverExec,
  });
  assert.deepEqual(
    await probeSandboxContainer("sess-1"),
    { verdict: "unknown", reason: "kv_unreachable" },
  );
});

test("a control plane that throws is unknown, not evidence about the container", async () => {
  bind({
    readHandsEntry: async () => SAFE_ENTRY,
    exec: async () => { throw new Error("sandboxExec failed: HTTP 500"); },
  });
  assert.deepEqual(
    await probeSandboxContainer("sess-1"),
    { verdict: "unknown", reason: "exec_unreachable" },
  );
});

test("a control plane that says the sandbox is not there is dead", async () => {
  for (const message of [
    "sandboxExec failed: HTTP 404 workload not found",
    "sandboxExec failed: HTTP 410 gone",
  ]) {
    bind({
      readHandsEntry: async () => SAFE_ENTRY,
      exec: async () => { throw new SandboxGoneError(message); },
    });
    assert.deepEqual(
      await probeSandboxContainer("sess-1"),
      { verdict: "dead", reason: "exec_sandbox_gone" },
      message,
    );
    restore?.();
    restore = null;
  }
});

test("a 404 quoted inside another failure's body is not proof of death", async () => {
  // Both providers append up to 300 characters of response body, so the status
  // has to be read where the provider puts it and nowhere else. Reading it
  // anywhere in the string is how an upstream error licensed a destroy.
  bind({
    readHandsEntry: async () => SAFE_ENTRY,
    exec: async () => {
      throw new Error('sandboxExec failed: HTTP 500 {"upstream":"router returned 404 for template"}');
    },
  });
  assert.deepEqual(
    await probeSandboxContainer("sess-1"),
    { verdict: "unknown", reason: "exec_unreachable" },
  );
});

test("the incident's own failure shape does not license a destroy", async () => {
  // Captured from the live Router on 2026-08-21 by reproducing the state of
  // INCIDENT-20260801: session still registered, backing pod gone so its
  // Service had no ready endpoint. The Router answers 502 for that and keeps
  // 404 for a session it has no record of, which is the whole reason the
  // 404-means-gone rule is safe to have. Pinned verbatim: if the Router ever
  // starts answering 404 for an unreachable backend, this is the test that has
  // to fail, because the alternative is destroying a live container with a
  // Hyperloom job in it.
  bind({
    readHandsEntry: async () => SAFE_ENTRY,
    exec: async () => {
      throw new Error(
        'sandboxExec failed: HTTP 502 {"error":"upstream error: Post '
        + '\\"http://sandbox.example.svc.cluster.local:8080/api/execute\\": '
        + 'dial tcp: lookup sandbox.example.svc.cluster.local: no such host"}',
      );
    },
  });
  assert.deepEqual(
    await probeSandboxContainer("sess-1"),
    { verdict: "unknown", reason: "exec_unreachable" },
  );
});

test("a session the Router has no record of is dead, in its real wording", async () => {
  bind({
    readHandsEntry: async () => AGENT_ENTRY,
    exec: async () => {
      throw new Error(
        'agent-sandbox exec failed: 404 {"error":"session \\"sess_c54e877\\" not found '
        + '(may have expired or been deleted). Create a new sandbox via POST '
        + '/v1/code-interpreter to get a fresh sessionId."}',
      );
    },
  });
  assert.deepEqual(
    await probeSandboxContainer("sess-1"),
    { verdict: "dead", reason: "exec_sandbox_gone" },
  );
});

test("a nonzero exit proves exec answered but does not authorize destroy", async () => {
  bind({
    readHandsEntry: async () => SAFE_ENTRY,
    exec: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
  });
  assert.deepEqual(
    await probeSandboxContainer("sess-1"),
    { verdict: "unknown", reason: "exec_nonzero" },
  );
});

test("a response carrying no exit code at all is unknown", async () => {
  // Both providers substitute a negative code when the response had none. That
  // is the control plane being odd, and reading it as a failed command would
  // destroy a container on the strength of a malformed reply.
  bind({
    readHandsEntry: async () => SAFE_ENTRY,
    exec: async () => ({ exitCode: -1, stdout: "", stderr: "" }),
  });
  assert.deepEqual(
    await probeSandboxContainer("sess-1"),
    { verdict: "unknown", reason: "exec_no_exit_code" },
  );
});

test("agent-sandbox probes via exec, not Hands MCP", async () => {
  let command = "";
  bind({
    readHandsEntry: async () => ({
      provider: "agent-sandbox",
      sessionId: "as-1",
      sandboxName: "pod-1",
      namespace: "ns",
      userId: "u1",
    }),
    exec: async (_inst, cmd) => {
      command = cmd;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(
    await probeSandboxContainer("sess-1"),
    { verdict: "alive", reason: "exec_ok" },
  );
  assert.equal(command, "true");
});

test("an explicit identity is probed instead of the session's key", async () => {
  // What keeps a DAG node from acting on a sibling's sandbox: every node shares
  // the session, so `hands.<sessionId>` names whichever one wrote it last.
  const seen: SandboxInstance[] = [];
  bind({
    readHandsEntry: async () => {
      throw new Error("the session key must not be consulted when the caller knows");
    },
    exec: async (inst) => {
      seen.push(inst);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  const outcome = await probeSandboxContainer("sess-shared", {
    provider: "safe-workload",
    workloadId: "inherited-workload",
    namespace: "ns",
  });
  assert.deepEqual(outcome, { verdict: "alive", reason: "exec_ok" });
  assert.equal(seen[0]?.id, "inherited-workload");
});

test("a caller that gives up gets unknown, and does not wait for the exec", async () => {
  let providerAborted = false;
  let execStarted!: () => void;
  const started = new Promise<void>((resolve) => { execStarted = resolve; });
  bind({
    readHandsEntry: async () => SAFE_ENTRY,
    // Never settles: without the abort race this probe would hang until the
    // deadline, on the tool-batch path, with the loop stopped behind it.
    exec: (_inst, _cmd, _timeout, signal) => new Promise((_resolve, reject) => {
      execStarted();
      signal?.addEventListener("abort", () => {
        providerAborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  const ctrl = new AbortController();
  const probe = probeSandboxContainer("sess-1", undefined, ctrl.signal);
  await started;
  ctrl.abort();
  assert.deepEqual(await probe, { verdict: "unknown", reason: "aborted" });
  assert.equal(providerAborted, true);
});

test("a caller that has already given up is not probed at all", async () => {
  bind({ readHandsEntry: async () => SAFE_ENTRY, exec: neverExec });
  assert.deepEqual(
    await probeSandboxContainer("sess-1", undefined, AbortSignal.abort()),
    { verdict: "unknown", reason: "aborted" },
  );
});

test("an exec that never answers is abandoned at the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let providerAborted = false;
  bind({
    readHandsEntry: async () => SAFE_ENTRY,
    exec: (_inst, _cmd, _timeout, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        providerAborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  const probe = probeSandboxContainer("sess-1");
  // Resolving the identity is asynchronous, so the deadline timer does not exist
  // yet. setImmediate is deliberately left unmocked to drain those turns.
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(8_000);
  assert.deepEqual(await probe, { verdict: "unknown", reason: "exec_deadline" });
  assert.equal(providerAborted, true);
});

test("sameHandsSandbox compares the workload, not the session", () => {
  const a = { provider: "safe-workload", workloadId: "wl-a" };
  const b = { provider: "safe-workload", workloadId: "wl-b" };
  assert.equal(sameHandsSandbox(a, a), true);
  assert.equal(sameHandsSandbox(a, { ...a, namespace: "other" }), true);
  assert.equal(sameHandsSandbox(a, b), false);
  assert.equal(sameHandsSandbox(a, null), false);
  assert.equal(
    sameHandsSandbox(
      { provider: "agent-sandbox", sessionId: "x", sandboxName: "pod-1", namespace: "ns" },
      { provider: "agent-sandbox", sessionId: "x", sandboxName: "pod-1", namespace: "ns" },
    ),
    true,
  );
  assert.equal(
    sameHandsSandbox(
      { provider: "agent-sandbox", sessionId: "x", sandboxName: "pod-1", namespace: "ns" },
      { provider: "agent-sandbox", sessionId: "x", sandboxName: "pod-2", namespace: "ns" },
    ),
    false,
  );
  assert.equal(
    sameHandsSandbox(
      { provider: "agent-sandbox", sessionId: "x", sandboxName: "pod-1", namespace: "ns-a" },
      { provider: "agent-sandbox", sessionId: "x", sandboxName: "pod-1", namespace: "ns-b" },
    ),
    false,
  );
});

test("an entry that was deleted is read as absent, not as corrupt", async () => {
  // NATS answers a deleted key with a readable entry whose value is empty, so
  // the parser sees "" and reports corruption. The two verdicts point opposite
  // ways: `entry_corrupt` is `unknown`, which tells the caller to leave the
  // container alone, so a sandbox whose entry is gone would never be replaced
  // and every attempt would spend another recovery. This drives the probe's
  // own reader rather than the injected one, because the reader is the part
  // under test.
  const { bindHandsKv } = await import("../src/sandbox/registry.js");
  bindHandsKv({
    async get(key: string) {
      return { key, value: new Uint8Array(0), revision: 9, operation: "DEL" };
    },
    async put() { return 1; },
    async delete() {},
    async keys() { return (async function* () { /* none */ })(); },
  } as never);
  bind({ exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });

  assert.deepEqual(
    await probeSandboxContainer("sess-deleted"),
    { verdict: "dead", reason: "no_kv_entry" },
  );
});
