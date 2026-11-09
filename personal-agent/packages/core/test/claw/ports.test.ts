// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
// The Claw port's modules declare types only; loading them is what the coverage of `--all` counts.
import "../../src/ports/claw/assistant.js";
import "../../src/ports/claw/index.js";
import "../../src/ports/claw/remote-agents.js";
import "../../src/ports/claw/sessions.js";
import "../../src/ports/claw/settings.js";
import "../../src/ports/claw/work-items.js";
import { ConfigError, SECRET_NAMES, SECURITY_EVENTS, SecretsUnavailable, noMetrics } from "../../src/index.js";

describe("W2 ports", () => {
  it("metrics that go nowhere take every call", () => {
    noMetrics.eventDelivered("assistant.say", 1, null);
    noMetrics.securityEvent({ event: "link_attempt" });
    noMetrics.processed(null, 1, true);
    noMetrics.limited("user_limit");
    noMetrics.filesDropped("session");
    assert.ok(true);
  });

  it("names the secrets and the events", () => {
    assert.deepEqual(
      [...SECRET_NAMES],
      ["TEAMS_ENCRYPTION_KEYS", "TEAMS_EXCHANGE_CLIENT_SECRET", "FEEDBACK_GITHUB_APP_KEY"],
    );
    assert.equal(SECURITY_EVENTS.link_lockout, "warn");
    assert.equal(new SecretsUnavailable("x").name, "SecretsUnavailable");
    assert.equal(new ConfigError("x").name, "ConfigError");
  });
});
