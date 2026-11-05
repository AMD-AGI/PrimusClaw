// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The headers a Hands URL needs, derived from the URL alone. */
import test from "node:test";
import assert from "node:assert/strict";
import { handsCredentialHeaders, handsRouteHeaders, routedHandsPort, routedHandsSessionId } from "../src/sandbox/hands-route.js";

test("a Router port-proxy URL names its session; a direct one names none", () => {
  const routed = "http://10.0.0.1/v1/namespaces/ns/code-interpreters/wl-1/invocations/proxy/9100/mcp";
  assert.equal(routedHandsSessionId(routed), "wl-1");
  assert.equal(routedHandsSessionId(routed.replace(/\/mcp$/, "")), "wl-1");
  assert.equal(routedHandsSessionId("http://wl-1.ns.svc.cluster.local:9100/mcp"), null);
  assert.equal(routedHandsSessionId("http://x/v1/namespaces/ns/code-interpreters/wl-1/invocations/api/execute"), null);
  assert.equal(routedHandsSessionId("not a url"), null);
  assert.deepEqual(handsRouteHeaders("http://wl-1.ns.svc.cluster.local:9100/mcp"), {});
  assert.deepEqual(handsRouteHeaders(routed), { "x-session-id": "wl-1" });
});

test("a routed URL carries the platform key for the Router and the Hands token for Hands", () => {
  const routed = "http://r/v1/namespaces/ns/code-interpreters/wl/invocations/proxy/9100/mcp";
  // A direct URL keeps exactly the header it always had, platform key or not.
  assert.deepEqual(handsCredentialHeaders("http://wl.ns.svc.cluster.local:9100/mcp", "t", "ak-1"), {
    Authorization: "Bearer t",
  });
  assert.deepEqual(handsCredentialHeaders(routed, "t", "ak-1"), {
    "x-session-id": "wl", Authorization: "Bearer ak-1", "X-Hands-Token": "t",
  });
  assert.deepEqual(handsRouteHeaders(routed, "ak-1"), { "x-session-id": "wl", Authorization: "Bearer ak-1" });
});

test("the Hands token is never offered to the Router as a caller credential", () => {
  const routed = "http://r/v1/namespaces/ns/code-interpreters/wl/invocations/proxy/9100/mcp";
  assert.deepEqual(handsCredentialHeaders(routed, "t"), { "x-session-id": "wl", "X-Hands-Token": "t" });
});

test("a routed URL names the sandbox port, not the Router's", () => {
  assert.equal(routedHandsPort("http://r:8080/v1/namespaces/ns/code-interpreters/wl/invocations/proxy/9100/mcp"), "9100");
  assert.equal(routedHandsPort("http://wl.ns.svc.cluster.local:9100/mcp"), null);
});
