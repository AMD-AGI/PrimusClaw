// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The brief's SaFE read (`briefPorts.listWorkloads`) as SaFE answers a member who is not an administrator: the cross-workspace
 * list is refused (403, "workspace: []"), one workspace at a time is not. Measured 2026-11-07: every non-admin's brief said
 * "SaFE 没有回答：safe_http_403". These drive the port against a fake SaFE (`fetch`), no database.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.SAFE_API_URL = "https://safe.example.invalid";
const { briefPorts } = await import("../src/assistant/brief.js");

type Answer = { status: number; body?: unknown };
const realFetch = globalThis.fetch;
function fakeSafe(answer: (url: URL) => Answer): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    asked.push(`${url.pathname}${url.search}`);
    const a = answer(url);
    return new Response(a.body === undefined ? "{}" : JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return asked;
}
test.afterEach(() => { globalThis.fetch = realFetch; });

const wl = (id: string, created: string, extra: Record<string, unknown> = {}) =>
  ({ workloadId: id, displayName: id, phase: "Running", creationTime: created, kind: "PyTorchJob", userId: "u1", ...extra });

test("an administrator's cross-workspace list is used as it is: one request", async () => {
  const asked = fakeSafe(() => ({ status: 200, body: { items: [wl("a", "2026-11-07T10:00:00Z")] } }));
  const seen = await briefPorts.listWorkloads("u1", "ak-1");
  assert.deepEqual(seen.map((w) => w.id), ["a"]);
  assert.equal(asked.length, 1);
  assert.doesNotMatch(asked[0], /workspaceId/);
});

test("a member refused the cross-workspace list is read one workspace at a time, newest first", async () => {
  const asked = fakeSafe((url) => {
    if (url.pathname === "/api/v1/workspaces") return { status: 200, body: { items: [{ workspaceId: "global-cpu" }, { workspaceId: "spur-vk" }] } };
    const ws = url.searchParams.get("workspaceId");
    if (!ws) return { status: 403, body: { errorCode: "Primus.00003", errorMessage: "not allowed to list workload, workspace: []" } };
    if (ws === "global-cpu") return { status: 200, body: { items: [wl("old", "2026-11-06T01:00:00Z"), wl("new", "2026-11-07T09:00:00Z", { phase: "Failed" })] } };
    return { status: 200, body: { items: [wl("mid", "2026-11-07T01:00:00Z")] } };
  });
  const seen = await briefPorts.listWorkloads("u1", "ak-1");
  assert.deepEqual(seen.map((w) => w.id), ["new", "mid", "old"]);
  assert.equal(seen[0].phase, "Failed");
  const scoped = asked.filter((a) => a.includes("workspaceId="));
  assert.equal(scoped.length, 2);
  for (const a of scoped) assert.match(a, /userId=u1/, "still the user's own workloads only");
});

test("a workspace that refuses as well is left out; SaFE is unreadable only when every one refuses", async () => {
  fakeSafe((url) => {
    if (url.pathname === "/api/v1/workspaces") return { status: 200, body: { items: [{ workspaceId: "a" }, { workspaceId: "b" }] } };
    const ws = url.searchParams.get("workspaceId");
    if (ws === "a") return { status: 200, body: { items: [wl("x", "2026-11-07T00:00:00Z")] } };
    return { status: 403 };
  });
  assert.deepEqual((await briefPorts.listWorkloads("u1", "ak-1")).map((w) => w.id), ["x"]);
  fakeSafe((url) => (url.pathname === "/api/v1/workspaces" ? { status: 200, body: { items: [{ workspaceId: "a" }] } } : { status: 403 }));
  await assert.rejects(briefPorts.listWorkloads("u1", "ak-1"), /safe_http_403/);
});

test("a member with no workspace has no workloads; another refusal is said as it is", async () => {
  fakeSafe((url) => (url.pathname === "/api/v1/workspaces" ? { status: 200, body: { items: [] } } : { status: 403 }));
  assert.deepEqual(await briefPorts.listWorkloads("u1", "ak-1"), []);
  const asked = fakeSafe(() => ({ status: 500 }));
  await assert.rejects(briefPorts.listWorkloads("u1", "ak-1"), /safe_http_500/);
  assert.equal(asked.length, 1, "only a 403 is followed by the workspaces");
  fakeSafe((url) => (url.pathname === "/api/v1/workspaces" ? { status: 401 } : { status: 403 }));
  await assert.rejects(briefPorts.listWorkloads("u1", "ak-1"), /safe_http_401/);
});
