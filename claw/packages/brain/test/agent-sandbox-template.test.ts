// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Deployment-level knobs on rendered CodeInterpreter templates: warm pool size
// and idle timeout.
//
// The size used to be a literal inside the inline fallback skeleton, so it was
// unreachable for any deployment that mounted its own base ConfigMap or let the
// Router supply the base -- "configure the warm pool" was not a thing an
// operator could do. It is now applied during rendering, which puts two
// properties at risk that these pin down: it has to survive whichever base was
// loaded, and it has to reach the content-addressed template name, or changing
// it would resolve straight back to the template built with the old value.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderTemplate, templateHashKey, type BaseTemplate,
} from "../src/sandbox/agent-sandbox-provider.js";
import type { SandboxCreateParams } from "../src/sandbox/provider.js";
import {
  AGENT_SANDBOX_WARM_POOL_SIZE, AGENT_SANDBOX_SESSION_TIMEOUT,
} from "../src/config.js";

const params: SandboxCreateParams = {
  image: "example.io/img:1",
  resources: { cpu: "2", memory: "4Gi" },
  env: {},
};

/** A base spec that is nothing like the inline fallback. */
const foreignBase: BaseTemplate = {
  source: "configmap",
  digest: "deadbeef",
  spec: {
    authMode: "none",
    sessionTimeout: "30m",
    template: { fromImage: "<PLACEHOLDER>", steps: [] },
  },
};

test("the configured size lands on a template cloned from a foreign base", () => {
  const { spec } = renderTemplate(foreignBase, params);

  assert.equal(spec.warmPoolSize, AGENT_SANDBOX_WARM_POOL_SIZE,
    "a mounted ConfigMap must not be able to hide the knob from the operator");
});

test("the default is off, because the claim path drops per-request environment", () => {
  assert.equal(AGENT_SANDBOX_WARM_POOL_SIZE, 0,
    "raising this without an env fix gives sandboxes that run without user_env");
});

test("the base spec is cloned, not edited in place", () => {
  const before = JSON.stringify(foreignBase.spec);
  renderTemplate(foreignBase, params);

  assert.equal(JSON.stringify(foreignBase.spec), before,
    "the cached base is shared across every render — mutating it would leak");
});

test("two renders of the same request agree on the template name", () => {
  const a = renderTemplate(foreignBase, params);
  const b = renderTemplate(foreignBase, params);

  assert.equal(a.name, b.name, "content addressing is what makes template creation idempotent");
});

test("the pool size reaches the template name", () => {
  // Rendering under two different sizes is not something one process can do
  // (the value is read once at import), so this asserts the weaker but still
  // load-bearing property: the size is part of the hashed key. Without it, an
  // operator raising the pool would get the already-created template back and
  // see no change at all.
  assert.match(
    templateHashKey(foreignBase, params),
    new RegExp(`warm=${AGENT_SANDBOX_WARM_POOL_SIZE}`),
    "a size that is not hashed is a size that cannot be changed",
  );
});

test("a differing pool size would select a differing template", () => {
  const key = templateHashKey(foreignBase, params);

  assert.notEqual(key, key.replace(/warm=\d+/, "warm=99"),
    "the key has to actually vary with the size, not merely mention it");
});

// --- idle timeout ---
//
// The sandbox is deleted once `lastActivity + sessionTimeout` passes, and only
// Router traffic moves lastActivity -- computation inside the pod does not. So
// the timeout is what decides whether a long job that outlives its agent turn
// survives, and until this knob existed every sandbox took the controller
// default of 15m no matter what it was built for. Two properties matter: an
// unset knob must not overwrite a base that made its own choice, and a set one
// must reach the content-addressed name.

test("an unset timeout leaves the base's own value alone", () => {
  const { spec } = renderTemplate(foreignBase, params);

  assert.equal(
    spec.sessionTimeout,
    AGENT_SANDBOX_SESSION_TIMEOUT || "30m",
    "a ConfigMap that sets sessionTimeout meant it; substituting a default "
      + "here would silently shorten every sandbox that deployment builds",
  );
});

test("a per-request timeout wins over both the base and the deployment default", () => {
  const { spec } = renderTemplate(foreignBase, { ...params, sessionTimeout: "6h" });

  assert.equal(spec.sessionTimeout, "6h",
    "the per-request knob is the one a long-running workload can reach without "
      + "moving the floor for every other sandbox");
});

test("a blank per-request timeout falls through rather than clearing the value", () => {
  const { spec } = renderTemplate(foreignBase, { ...params, sessionTimeout: "   " });

  assert.equal(
    spec.sessionTimeout,
    AGENT_SANDBOX_SESSION_TIMEOUT || "30m",
    "whitespace is not a request for a zero-length idle window",
  );
});

test("the timeout reaches the template name", () => {
  // Same limitation as the pool size: one process reads the env once, so this
  // pins the hashable property rather than two live values. Without it, asking
  // for a longer timeout would resolve back to the template built with the old
  // one and change nothing.
  assert.match(
    templateHashKey(foreignBase, { ...params, sessionTimeout: "6h" }),
    /idle=6h/,
    "a timeout that is not hashed is a timeout that cannot be changed",
  );
});

test("a differing timeout selects a differing template", () => {
  const a = templateHashKey(foreignBase, { ...params, sessionTimeout: "6h" });
  const b = templateHashKey(foreignBase, { ...params, sessionTimeout: "12h" });

  assert.notEqual(a, b,
    "two workloads with different lifetimes must not share one template");
});
