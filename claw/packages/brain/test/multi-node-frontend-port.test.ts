// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInferaWorkloadBody,
  inferaFrontendPort,
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

test("the derived port avoids the NodePort and ephemeral ranges", () => {
  // SaFE puts the frontend on hostNetwork whenever a worker asks for RDMA, so
  // --port binds a node port: it must not land on Kubernetes' NodePort range
  // (30000-32767) nor Linux's ephemeral range (32768+).
  for (let i = 0; i < 2000; i += 1) {
    const port = inferaFrontendPort(`claw-${1785300000000 + i}-infera`);
    assert.ok(port >= 20000 && port < 30000, `port ${port} escaped the window`);
  }
});

test("the port is stable for a workload name, so a redelivery reproduces it", () => {
  const first = inferaFrontendPort("claw-1785321912798-infera");
  assert.equal(inferaFrontendPort("claw-1785321912798-infera"), first);
  assert.notEqual(inferaFrontendPort("claw-1785321912799-infera"), first);
});

test("distinct workloads spread across the window", () => {
  const ports = new Set<number>();
  for (let i = 0; i < 500; i += 1) ports.add(inferaFrontendPort(`claw-${1785300000000 + i * 7}-infera`));
  // A hash that ignored its input would collapse to one value; anything above a
  // few hundred distinct ports out of 500 names means it is actually mixing.
  assert.ok(ports.size > 450, `only ${ports.size} distinct ports for 500 workloads`);
});

test("entryPoint, Service and targetPort all carry the same derived port", () => {
  const displayName = "claw-1785321912798-infera";
  const body = buildInferaWorkloadBody({ ...BASE, displayName }) as Record<string, any>;
  const port = inferaFrontendPort(displayName);

  // A mismatch between these three is the failure mode that matters: the Service
  // would route to a port nothing listens on.
  assert.equal(body.service.port, port);
  assert.equal(body.service.targetPort, port);
  assert.match(decodeEp(body.entryPoints[0]), new RegExp(`--port ${port}\\b`));
  assert.ok(!decodeEp(body.entryPoints[0]).includes("--port 8000"), "still pinned to 8000");
});

test("an explicit frontendPort still wins over the derived one", () => {
  const body = buildInferaWorkloadBody({
    ...BASE,
    displayName: "claw-1-infera",
    frontendPort: 21234,
  }) as Record<string, any>;
  assert.equal(body.service.port, 21234);
  assert.match(decodeEp(body.entryPoints[0]), /--port 21234\b/);
});
