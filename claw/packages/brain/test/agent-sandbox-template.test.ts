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
  renderTemplate, templateHashKey, lifetimeOverrides, type BaseTemplate,
} from "../src/sandbox/agent-sandbox-provider.js";
import type { SandboxCreateParams } from "../src/sandbox/provider.js";
import {
  AGENT_SANDBOX_WARM_POOL_SIZE, AGENT_SANDBOX_SESSION_TIMEOUT,
  AGENT_SANDBOX_MAX_SESSION_DURATION,
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
    maxSessionDuration: "48h",
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

// --- lifetime overrides ---
//
// The sandbox is deleted once `lastActivity + sessionTimeout` passes, and only
// Router traffic moves lastActivity -- computation inside the pod does not. So
// the timeout decides whether a job that outlives its agent turn survives, and
// maxSessionDuration is the deadline underneath it that nothing moves at all.
// Until these existed every sandbox took 15m and 24h no matter what it was for.
//
// They travel as Workload Manager create overrides, not in the rendered
// template, and that is what these pin: the template name is a content hash, so
// baking a value into the spec would give every distinct timeout its own
// CodeInterpreter -- and its own warm pool.

test("what is sent is what the deployment configured", () => {
  assert.deepEqual(lifetimeOverrides(), {
    ...(AGENT_SANDBOX_SESSION_TIMEOUT ? { sessionTimeout: AGENT_SANDBOX_SESSION_TIMEOUT } : {}),
    ...(AGENT_SANDBOX_MAX_SESSION_DURATION
      ? { maxSessionDuration: AGENT_SANDBOX_MAX_SESSION_DURATION } : {}),
  });
});

test("an unset knob is absent, not empty", () => {
  // An override sent empty is still an override: it would replace a base
  // template's own value with nothing.
  const got = lifetimeOverrides();
  for (const [k, v] of Object.entries(got)) {
    assert.notEqual(v, "", `${k} was sent as an empty string`);
  }
  if (!AGENT_SANDBOX_SESSION_TIMEOUT) {
    assert.ok(!("sessionTimeout" in got), "nothing was configured, so nothing goes");
  }
});

test("neither value reaches the template name", () => {
  // The regression this exists for: putting them in the hash renamed every
  // template on upgrade even for deployments that set nothing, orphaning the old
  // CodeInterpreters and -- with a warm pool -- leaving a pool behind each.
  const a = templateHashKey(foreignBase, params);
  const b = templateHashKey(foreignBase, { ...params, image: params.image });

  assert.equal(a, b);
  assert.ok(!a.includes("idle="), "the key must not carry a lifetime at all");
  assert.ok(!a.includes("life="));
});

test("the base template's own lifetime survives rendering", () => {
  const { spec } = renderTemplate(foreignBase, params);

  assert.equal(spec.sessionTimeout, "30m",
    "a ConfigMap that set its own value meant it; the override path is how a "
      + "deployment changes its mind, not the renderer");
  assert.equal(spec.maxSessionDuration, "48h");
});
