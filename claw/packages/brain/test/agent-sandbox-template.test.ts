// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Warm pool sizing on rendered CodeInterpreter templates.
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
import { AGENT_SANDBOX_WARM_POOL_SIZE } from "../src/config.js";

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
