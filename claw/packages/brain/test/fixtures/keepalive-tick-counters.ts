// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One handle, swept until it is reclaimed, with the scan line going to stdout.
 *
 * A child process because pino writes fd 1 through sonic-boom, which neither a
 * stubbed `process.stdout.write` nor a stubbed `fs.writeSync` intercepts -- the
 * same reason `deadline-log-turns` runs its subject out of process.
 *
 * The run ends on the tick that performs the reclaim, which is the interesting
 * one: the handle expires instead of becoming a ping target, so that tick has
 * zero targets. A scan line emitted only when targets remain would drop exactly
 * the tick where the mechanism succeeded, leaving "reclaimed it" and "reclaim
 * stalled" indistinguishable from outside.
 */
import { StringCodec } from "nats";
import { filterToRegExp } from "../nats-kv-stub.js";
import type { KV } from "nats";
import { runKeepaliveTickForTest } from "../../src/sandbox/keepalive.js";
import { bindSandboxProviders } from "../../src/sandbox/factory.js";
import type { SandboxProvider } from "../../src/sandbox/provider.js";

const sc = StringCodec();
const SESSION = "sess-counters";
const KEY = `hands.${SESSION}`;

const provider = {
  kind: "safe-workload",
  async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
  async get() { return { running: true, healthy: true }; },
  async stop() {},
} as unknown as SandboxProvider;
bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });

const deleted: string[] = [];
let value = sc.encode(JSON.stringify({
  status: "ready", provider: "safe-workload", workloadId: "wl-c",
  platformKey: "pk", namespace: "ns",
  handsUrl: "http://sandbox:9100/mcp", token: "tok",
  keepalive: false, idleSince: 0,
}));
let revision = 5;

const kv = {
  // Honours the filter, because the sweep is not the only thing walking this
  // bucket: the retry-pending scan uses a different prefix, and a stub that
  // answers every filter hands it the Hands entry, which it cannot decode and
  // therefore deletes.
  async keys(filter = ">") {
    const matched = filterToRegExp(filter).test(KEY) && !deleted.includes(KEY) ? [KEY] : [];
    return (async function* () { yield* matched; })();
  },
  async get(key: string) {
    if (key !== KEY || deleted.includes(key)) return null;
    return { key, value, revision };
  },
  async delete(key: string) { deleted.push(key); },
  async put() { return ++revision; },
  async update(_k: string, v: unknown, rev: number) {
    if (rev !== revision) throw new Error("revision conflict");
    value = v as Uint8Array; return ++revision;
  },
} as unknown as KV;

const deps = { kv, countActiveShells: async () => 0 };

for (let i = 0; i < 4 && !deleted.includes(KEY); i++) {
  await runKeepaliveTickForTest(deps);
  await new Promise((r) => setImmediate(r));
}
// Flush: pino writes through sonic-boom, and the parent reads what reached fd 1.
await new Promise((r) => setTimeout(r, 50));
