// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The headers a Hands URL needs, derived from the URL alone. */
import test from "node:test";
import assert from "node:assert/strict";
import { handsCredentialHeaders, handsRouteHeaders, routedHandsSessionId } from "../src/sandbox/hands-route.js";

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

test("the credential goes in both headers, with the session only when routed", () => {
  assert.deepEqual(handsCredentialHeaders("http://wl.ns.svc.cluster.local:9100/mcp", "t"), {
    Authorization: "Bearer t",
    "X-Hands-Token": "t",
  });
  assert.deepEqual(
    handsCredentialHeaders("http://r/v1/namespaces/ns/code-interpreters/wl/invocations/proxy/9100/mcp", "t"),
    { "x-session-id": "wl", Authorization: "Bearer t", "X-Hands-Token": "t" },
  );
});
