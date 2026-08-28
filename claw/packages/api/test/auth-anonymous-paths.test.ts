// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Pins the set of routes that skip global SaFE authentication.
 *
 * The allowlist used to be a prefix test (`pathname.startsWith("/a2a/")`), which
 * made every future route under `/a2a/` anonymous by default. It is now an
 * explicit path set, and these tests are what keep it explicit: adding a route
 * under `/a2a/` or `/.well-known/` should require a deliberate edit here rather
 * than silently serving anonymous traffic.
 *
 * The cases mirror the routes actually registered in `routes/a2a.ts` — note that
 * the JSON-RPC endpoint is `POST /a2a` with no trailing slash, which is why the
 * old prefix never exempted it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isAnonymousPath } from "../src/auth/middleware.js";

test("isAnonymousPath: infra probes stay anonymous", () => {
  assert.equal(isAnonymousPath("/health"), true);
  assert.equal(isAnonymousPath("/metrics"), true);
  assert.equal(isAnonymousPath("/a2a/health"), true);
});

test("isAnonymousPath: A2A discovery stays anonymous on both prefixes", () => {
  // A2A spec §8.2 — discovery is unauthenticated. v1.0 path plus the v0.x legacy
  // spelling, each served at the root and under /a2a/.
  assert.equal(isAnonymousPath("/.well-known/agent-card.json"), true);
  assert.equal(isAnonymousPath("/a2a/.well-known/agent-card.json"), true);
  assert.equal(isAnonymousPath("/.well-known/agent.json"), true);
  assert.equal(isAnonymousPath("/a2a/.well-known/agent.json"), true);
});

test("isAnonymousPath: the A2A JSON-RPC endpoint requires authentication", () => {
  // The tenant boundary for SendMessage / GetTask / ListTasks / CancelTask is
  // the authenticated user id, so this must never be exempt.
  assert.equal(isAnonymousPath("/a2a"), false);
});

test("isAnonymousPath: a trailing slash does not exempt the JSON-RPC endpoint", () => {
  // Belt and braces: `ignoreTrailingSlash` is off so `/a2a/` 404s rather than
  // reaching the handler, but the allowlist must not be the thing relied upon.
  assert.equal(isAnonymousPath("/a2a/"), false);
});

test("isAnonymousPath: no unlisted route under /a2a/ is anonymous", () => {
  // The regression the explicit list exists to prevent.
  assert.equal(isAnonymousPath("/a2a/tasks"), false);
  assert.equal(isAnonymousPath("/a2a/v1"), false);
  assert.equal(isAnonymousPath("/a2a/.well-known/openid-configuration"), false);
});

test("isAnonymousPath: the legacy SaFE Gateway invoke routes require authentication", () => {
  assert.equal(isAnonymousPath("/invoke"), false);
  assert.equal(isAnonymousPath("/invoke/code-generation"), false);
});

test("isAnonymousPath: /v1/internal/* defers to internalTaskAuth", () => {
  // Not anonymous — authenticated by per-task token instead of SaFE. Skipping
  // the global middleware here is what lets Brain callbacks through.
  assert.equal(isAnonymousPath("/v1/internal/tasks/t1/event"), true);
  assert.equal(isAnonymousPath("/v1/internal/tasks/t1/agent_done"), true);
});

test("isAnonymousPath: the tenant API is never anonymous", () => {
  assert.equal(isAnonymousPath("/v1/sessions"), false);
  assert.equal(isAnonymousPath("/v1/sessions/abc/files/main.py"), false);
  assert.equal(isAnonymousPath("/v1/admin/users"), false);
  assert.equal(isAnonymousPath("/anthropic/v1/messages"), false);
});

test("isAnonymousPath: cannot be widened by a crafted path", () => {
  // Path matching is exact, so neither a prefix nor a traversal segment gets in.
  assert.equal(isAnonymousPath("/healthz"), false);
  assert.equal(isAnonymousPath("/health/../v1/sessions"), false);
  assert.equal(isAnonymousPath("/evil/health"), false);
  assert.equal(isAnonymousPath("/v1/internal"), false);
  assert.equal(isAnonymousPath("//health"), false);
  // A near-miss on the internal prefix must not inherit its exemption.
  assert.equal(isAnonymousPath("/v1/internalx/tasks"), false);
});
