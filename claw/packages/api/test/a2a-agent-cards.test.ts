// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where an A2A agent card says its agent lives, and what a per-plugin agent's
 * card says about the plugin.
 *
 * Behind an ingress that strips a path prefix, the process sees `/a2a` while a
 * caller has to use `<prefix>/a2a`; a card that advertises the relative path
 * sends every client to the wrong place. The base comes from the operator's
 * `CLAW_PUBLIC_URL` first, the proxy's forwarded headers second, and is empty
 * (today's relative URL) when neither says anything.
 *
 * No database, NATS or server: these are the pure rules, driven as tables. The
 * routes that serve them are in a2a-plugin-agents.test.ts.
 *
 * Coverage:
 *   U1 base URL: configured value, forwarded headers, nothing -- one table
 *   U2 every header the caller can send is validated, and a bad one is ignored
 *   U3 the generic card carries the base and the generic skills
 *   U4 a plugin card carries the plugin's name, description, version and skills
 *   U5 a plugin with nothing to list still advertises one skill
 *   U6 a send is bound to the endpoint's plugin; a different plugin is refused
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  bindPluginToSend, genericAgentCard, pluginAgentCard, pluginAgentPath, publicBaseUrl,
} from "../src/routes/a2a-agents.js";

type Headers = Record<string, string | string[] | undefined>;

describe("U1 the public base URL", () => {
  const cases: Array<{
    name: string; env?: string; headers: Headers; want: string;
  }> = [
    // Today's behaviour, which stays the default.
    { name: "nothing configured, nothing forwarded", headers: {}, want: "" },
    { name: "a plain Host header alone is not a proxy", headers: { host: "api.internal:8080" }, want: "" },
    { name: "blank env is not configured", env: "  ", headers: {}, want: "" },
    // The operator's word.
    { name: "env", env: "https://claw.example.com/claw-api", headers: {}, want: "https://claw.example.com/claw-api" },
    { name: "env loses its trailing slashes", env: "https://claw.example.com/claw-api//", headers: {}, want: "https://claw.example.com/claw-api" },
    {
      name: "env wins over forwarded headers",
      env: "https://configured.example.com",
      headers: { "x-forwarded-host": "fwd.example.com", "x-forwarded-proto": "http", "x-forwarded-prefix": "/p" },
      want: "https://configured.example.com",
    },
    // The proxy's word.
    {
      name: "forwarded host, proto and prefix",
      headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-proto": "https", "x-forwarded-prefix": "/claw-api" },
      want: "https://claw.example.com/claw-api",
    },
    {
      name: "forwarded host with a port, over http",
      headers: { "x-forwarded-host": "claw.example.com:8443", "x-forwarded-proto": "http" },
      want: "http://claw.example.com:8443",
    },
    {
      name: "a missing scheme is taken to be https",
      headers: { "x-forwarded-host": "claw.example.com" },
      want: "https://claw.example.com",
    },
    {
      name: "Host stands in for a missing forwarded host once a proxy has spoken",
      headers: { host: "claw.example.com", "x-forwarded-proto": "https", "x-forwarded-prefix": "/claw-api" },
      want: "https://claw.example.com/claw-api",
    },
    {
      name: "a prefix loses its trailing slash",
      headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-prefix": "/claw-api/" },
      want: "https://claw.example.com/claw-api",
    },
    {
      name: "a nested prefix",
      headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-prefix": "/a/b-c/d.e" },
      want: "https://claw.example.com/a/b-c/d.e",
    },
    {
      name: "a bare slash prefix is no prefix",
      headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-prefix": "/" },
      want: "https://claw.example.com",
    },
    {
      name: "a proxy chain: the outermost entry wins",
      headers: { "x-forwarded-host": "claw.example.com, hop1.internal", "x-forwarded-proto": "https, http" },
      want: "https://claw.example.com",
    },
    {
      name: "a repeated header: the first value wins",
      headers: { "x-forwarded-host": ["claw.example.com", "other.example.com"], "x-forwarded-proto": ["http", "https"] },
      want: "http://claw.example.com",
    },
    {
      name: "an IPv6 literal host",
      headers: { "x-forwarded-host": "[2001:db8::1]:8443", "x-forwarded-proto": "https" },
      want: "https://[2001:db8::1]:8443",
    },
    {
      name: "the scheme is case-insensitive",
      headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-proto": "HTTP" },
      want: "http://claw.example.com",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(publicBaseUrl(c.headers, { CLAW_PUBLIC_URL: c.env }), c.want);
    });
  }
});

describe("U2 forwarded headers are the caller's to send, so they are validated", () => {
  const cases: Array<{ name: string; headers: Headers; want: string }> = [
    // A host that is not a host: the card falls back to relative, it does not
    // advertise an address the caller chose.
    { name: "a host with a path", headers: { "x-forwarded-host": "evil.example.com/x" }, want: "" },
    { name: "a host with userinfo", headers: { "x-forwarded-host": "claw.example.com@evil.example.com" }, want: "" },
    { name: "a host with a space", headers: { "x-forwarded-host": "claw example.com" }, want: "" },
    { name: "a host with a scheme", headers: { "x-forwarded-host": "https://evil.example.com" }, want: "" },
    { name: "a host with an oversized port", headers: { "x-forwarded-host": "claw.example.com:123456" }, want: "" },
    { name: "a host that starts with a dot", headers: { "x-forwarded-host": ".example.com" }, want: "" },
    { name: "an empty host", headers: { "x-forwarded-host": "", "x-forwarded-proto": "https" }, want: "" },
    { name: "an oversized host", headers: { "x-forwarded-host": `${"a".repeat(300)}.example.com` }, want: "" },
    // A scheme that is not one is dropped, and the default stands.
    {
      name: "a non-http scheme",
      headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-proto": "javascript" },
      want: "https://claw.example.com",
    },
    // A prefix that is not a plain path is dropped; the host is still good.
    { name: "a prefix climbing out", headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-prefix": "/a/../b" }, want: "https://claw.example.com" },
    { name: "a prefix that is only dots", headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-prefix": "/.." }, want: "https://claw.example.com" },
    { name: "a protocol-relative prefix", headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-prefix": "//evil.example.com" }, want: "https://claw.example.com" },
    { name: "a prefix with a space", headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-prefix": "/a b" }, want: "https://claw.example.com" },
    { name: "a prefix with a query", headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-prefix": "/a?x=1" }, want: "https://claw.example.com" },
    { name: "a prefix with an encoded slash", headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-prefix": "/a%2Fb" }, want: "https://claw.example.com" },
    { name: "a prefix without its leading slash", headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-prefix": "claw-api" }, want: "https://claw.example.com" },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(publicBaseUrl(c.headers, {}), c.want);
    });
  }

  test("a long run of slashes in a prefix is rejected in linear time", () => {
    const started = process.hrtime.bigint();
    const base = publicBaseUrl({ "x-forwarded-host": "claw.example.com", "x-forwarded-prefix": `/${"/".repeat(250)}x` }, {});
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(base, "https://claw.example.com");
    assert.ok(ms < 100, `took ${ms}ms`);
  });
});

describe("U3 the generic agent's card", () => {
  const cases = [
    { base: "", want: "/a2a" },
    { base: "https://claw.example.com/claw-api", want: "https://claw.example.com/claw-api/a2a" },
  ];
  for (const c of cases) {
    test(`interface URL for base ${JSON.stringify(c.base)}`, () => {
      const card = genericAgentCard(c.base);
      assert.equal(card.supportedInterfaces.length, 1);
      assert.equal(card.supportedInterfaces[0]!.url, c.want);
      assert.equal(card.supportedInterfaces[0]!.protocolBinding, "JSONRPC");
      assert.equal(card.supportedInterfaces[0]!.protocolVersion, "1.0");
    });
  }

  test("it is the generic agent: name and its four skills", () => {
    const card = genericAgentCard("");
    assert.equal(card.name, "PrimusClaw");
    assert.deepEqual(card.skills.map((s) => s.id), ["code-generation", "debugging", "code-review", "optimization"]);
    assert.deepEqual(card.securityRequirements, [{ bearer: [] }]);
  });
});

describe("U4 a plugin's card", () => {
  const plugin = {
    id: 7,
    name: "gpu-triage",
    description: "Finds the failing GPU job",
    version: "1.4.0",
    tools: [
      { id: 1, type: "skill", name: "triage-steps", description: "How to triage" },
      { id: 2, type: "mcp", name: "cluster", description: "" },
      { id: 3, type: "rule", name: "no-rm", description: "never delete" },
      { id: 4, type: "hooks", name: "audit", description: "" },
      { id: 5, type: "skill", name: "triage-steps", description: "a duplicate" },
      { id: 6, type: "skill", name: "", description: "nameless" },
      null,
      "not a tool",
    ],
  };

  const urls = [
    { base: "", want: "/a2a/plugins/7" },
    { base: "https://claw.example.com/claw-api", want: "https://claw.example.com/claw-api/a2a/plugins/7" },
  ];
  for (const c of urls) {
    test(`interface URL for base ${JSON.stringify(c.base)}`, () => {
      assert.equal(pluginAgentCard(c.base, plugin).supportedInterfaces[0]!.url, c.want);
    });
  }

  test("the path is the one the route is registered at", () => {
    assert.equal(pluginAgentPath(7), "/a2a/plugins/7");
  });

  test("name, description and version are the plugin's", () => {
    const card = pluginAgentCard("", plugin);
    assert.equal(card.name, "gpu-triage");
    assert.equal(card.description, "Finds the failing GPU job");
    assert.equal(card.version, "1.4.0");
  });

  test("skills are the plugin's skills and MCP servers, not its rules or hooks, once each", () => {
    assert.deepEqual(pluginAgentCard("", plugin).skills, [
      { id: "skill-triage-steps", name: "triage-steps", description: "How to triage", tags: ["skill"] },
      { id: "mcp-cluster", name: "cluster", description: "mcp cluster", tags: ["mcp"] },
    ]);
  });

  test("it advertises the same transport and security as the generic agent", () => {
    const generic = genericAgentCard("");
    const card = pluginAgentCard("", plugin);
    assert.deepEqual(card.capabilities, generic.capabilities);
    assert.deepEqual(card.securitySchemes, generic.securitySchemes);
    assert.deepEqual(card.securityRequirements, generic.securityRequirements);
    assert.deepEqual(card.defaultInputModes, generic.defaultInputModes);
  });
});

describe("U5 a plugin with nothing to list", () => {
  const cases: Array<{ name: string; plugin: Parameters<typeof pluginAgentCard>[1]; skill: object; card: { name: string; description: string; version: string } }> = [
    {
      name: "no tools",
      plugin: { id: 3, name: "bare", description: "Does one thing", version: "2", tools: [] },
      skill: { id: "chat", name: "bare", description: "Does one thing", tags: [] },
      card: { name: "bare", description: "Does one thing", version: "2" },
    },
    {
      name: "only rules",
      plugin: { id: 3, name: "bare", description: "Does one thing", tools: [{ type: "rule", name: "r" }] },
      skill: { id: "chat", name: "bare", description: "Does one thing", tags: [] },
      card: { name: "bare", description: "Does one thing", version: "1" },
    },
    {
      name: "nothing but an id",
      plugin: { id: 9 },
      skill: { id: "chat", name: "plugin-9", description: 'PrimusClaw agent running the "plugin-9" plugin', tags: [] },
      card: { name: "plugin-9", description: 'PrimusClaw agent running the "plugin-9" plugin', version: "1" },
    },
    {
      name: "tools that are not a list",
      plugin: { id: 4, name: "odd", description: "d", tools: { type: "skill", name: "x" } },
      skill: { id: "chat", name: "odd", description: "d", tags: [] },
      card: { name: "odd", description: "d", version: "1" },
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const card = pluginAgentCard("", c.plugin);
      assert.deepEqual(card.skills, [c.skill]);
      assert.equal(card.name, c.card.name);
      assert.equal(card.description, c.card.description);
      assert.equal(card.version, c.card.version);
    });
  }
});

describe("U6 a send is bound to the plugin the endpoint serves", () => {
  const message = { messageId: "m1", role: "ROLE_USER", parts: [{ text: "hi" }] };
  const cases: Array<{ name: string; params: Record<string, unknown>; want: Record<string, unknown> | { error: string } }> = [
    {
      name: "no metadata",
      params: { message },
      want: { params: { message, metadata: { plugin_id: 7 } } },
    },
    {
      name: "null metadata",
      params: { message, metadata: null },
      want: { params: { message, metadata: { plugin_id: 7 } } },
    },
    {
      name: "other metadata is kept",
      params: { message, metadata: { workspace_id: "w1" } },
      want: { params: { message, metadata: { workspace_id: "w1", plugin_id: 7 } } },
    },
    {
      name: "the same plugin, as a number",
      params: { message, metadata: { plugin_id: 7 } },
      want: { params: { message, metadata: { plugin_id: 7 } } },
    },
    {
      name: "the same plugin, as a string",
      params: { message, metadata: { plugin_id: "7" } },
      want: { params: { message, metadata: { plugin_id: 7 } } },
    },
    {
      name: "a different plugin is refused, not overridden",
      params: { message, metadata: { plugin_id: 8 } },
      want: { error: "metadata.plugin_id does not match the plugin this agent serves" },
    },
    {
      name: "an unparseable plugin is refused",
      params: { message, metadata: { plugin_id: "seven" } },
      want: { error: "metadata.plugin_id does not match the plugin this agent serves" },
    },
    {
      name: "metadata that is not an object",
      params: { message, metadata: "plugin 7" },
      want: { error: "metadata must be an object" },
    },
    {
      name: "metadata that is a list",
      params: { message, metadata: [7] },
      want: { error: "metadata must be an object" },
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.deepEqual(bindPluginToSend(c.params, 7), c.want);
    });
  }

  test("the caller's params are not mutated", () => {
    const params = { message, metadata: { workspace_id: "w1" } };
    bindPluginToSend(params, 7);
    assert.deepEqual(params, { message, metadata: { workspace_id: "w1" } });
  });
});
