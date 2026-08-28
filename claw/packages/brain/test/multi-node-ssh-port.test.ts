// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInferaWorkloadBody,
  inferaFrontendPort,
  inferaSshPortBase,
  INFERA_SSH_PORT_ROLE_STRIDE,
  sshPortForPod,
} from "../src/sandbox/multi-node/safe-body.js";

const BASE = {
  workspace: "test-workspace",
  image: "harbor/sglang:sshd",
  nodes: 2,
  gpusPerNode: 8,
  cpusPerNode: 64,
  memGiPerNode: 1024,
  ephemeralGiPerNode: 200,
  sshAuthorizedKey: "ssh-ed25519 AAAA key",
  model: "/models/Qwen3-30B-A3B",
  framework: "sglang",
  kvTransferBackend: "mooncake",
  pdMode: "aggregated" as const,
};

function decodeEp(ep: string): string {
  return Buffer.from(ep, "base64").toString("utf-8");
}

test("the sshd base is never the fixed 2222 that clashed on shared nodes", () => {
  // The GPU pods ride hostNetwork for RDMA, so MN_SSH_PORT binds a NODE port.
  // With 2222 the second workload on a node silently answered for the first.
  for (let i = 0; i < 2000; i += 1) {
    assert.notEqual(inferaSshPortBase(`claw-${1785300000000 + i}-infera`), 2222);
  }
});

test("the derived base leaves its whole window below NodePort and ephemeral", () => {
  for (let i = 0; i < 2000; i += 1) {
    const base = inferaSshPortBase(`claw-${1785300000000 + i}-infera`);
    assert.ok(base >= 25000, `base ${base} below the window`);
    // The top port a role can compute must stay clear of NodePort (30000+).
    const highest = base + INFERA_SSH_PORT_ROLE_STRIDE * 2 - 1;
    assert.ok(highest < 30000, `window top ${highest} escaped the band`);
  }
});

test("bases are window-aligned so two workloads never partially overlap", () => {
  for (let i = 0; i < 500; i += 1) {
    const base = inferaSshPortBase(`claw-${1785300000000 + i * 7}-infera`);
    assert.equal((base - 25000) % 32, 0, `base ${base} is not window-aligned`);
  }
});

test("the base is stable for a workload name, so a redelivery reproduces it", () => {
  // adoptExisting re-derives instead of storing the port: an unstable hash would
  // make the optimizer SSH to a port nothing listens on.
  const first = inferaSshPortBase("claw-1785321912798-infera");
  assert.equal(inferaSshPortBase("claw-1785321912798-infera"), first);
  assert.notEqual(inferaSshPortBase("claw-1785321912799-infera"), first);
});

test("no frontend port can ever land inside any sshd window", () => {
  // The halves are disjoint by construction, so this holds across workloads too,
  // not just within one -- the frontend shares the node under hostNetwork.
  for (let i = 0; i < 2000; i += 1) {
    const name = `claw-${1785300000000 + i}-infera`;
    assert.ok(inferaFrontendPort(name) < 25000, "frontend escaped its half");
    assert.ok(inferaSshPortBase(name) >= 25000, "sshd base escaped its half");
  }
});

test("distinct workloads spread across the available windows", () => {
  const bases = new Set<number>();
  for (let i = 0; i < 500; i += 1) bases.add(inferaSshPortBase(`claw-${1785300000000 + i * 7}-infera`));
  // Only 156 windows exist, so 500 names cannot all differ; a hash ignoring its
  // input would collapse to one, and an even spread lands near 150.
  assert.ok(bases.size > 120, `only ${bases.size} distinct bases for 500 workloads`);
});

test("entryPoint, env and pod discovery all agree on the derived base", () => {
  const displayName = "claw-1785321912798-infera";
  const body = buildInferaWorkloadBody({ ...BASE, displayName }) as Record<string, any>;
  const base = inferaSshPortBase(displayName);

  // A mismatch here is the failure that matters: the pod would listen on one
  // port while the optimizer dials another.
  assert.equal(body.env.MN_SSH_PORT, String(base));
  assert.equal(
    decodeEp(body.entryPoints[1]),
    `export MN_SSH_PORT=$(( ${base} + \${LWS_WORKER_INDEX:-0} )); exec /usr/local/bin/mn-idle.sh`,
  );
  assert.equal(sshPortForPod("worker", 0, base), base);
  assert.equal(sshPortForPod("decode", 0, base), base + INFERA_SSH_PORT_ROLE_STRIDE);
});

test("an explicit sshPortBase still wins over the derived one", () => {
  const body = buildInferaWorkloadBody({
    ...BASE,
    displayName: "claw-1-infera",
    sshPortBase: 24096,
  }) as Record<string, any>;
  assert.equal(body.env.MN_SSH_PORT, "24096");
  assert.match(decodeEp(body.entryPoints[1]), /MN_SSH_PORT=\$\(\( 24096 \+/);
});
