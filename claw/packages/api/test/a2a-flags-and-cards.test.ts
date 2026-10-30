// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The switches behind the context/task model, and what an agent card says
 * under them. Pure: no database, NATS or server.
 *
 * Coverage:
 *   F1 an identity-provider token's caller must be named by the operator; no other credential is asked
 *   F2 the card options follow the environment, and nothing set is the card it always was
 *   F3 the card under the new model: truthful skill, the identity scheme, v1.0 requirement shape
 *   F4 the card's validator
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  cardEtag, cardOptionsFromEnv, etagMatches, genericAgentCard, pluginAgentCard,
} from "../src/routes/a2a-agents.js";
import { identityCallerMayUseA2a } from "../src/routes/a2a-flags.js";

describe("F1 who may call with an identity-provider token", () => {
  const cases: Array<{ name: string; method: string | null; client: string | undefined; allowed: string[]; want: boolean }> = [
    { name: "a named upstream service", method: "identity_token", client: "dispatron", allowed: ["dispatron"], want: true },
    { name: "one of several", method: "identity_token", client: "teams-bot", allowed: ["dispatron", "teams-bot"], want: true },
    { name: "a client nobody named", method: "identity_token", client: "claw-web", allowed: ["dispatron"], want: false },
    { name: "nothing named, nobody is let in", method: "identity_token", client: "dispatron", allowed: [], want: false },
    { name: "a token with no client id", method: "identity_token", client: undefined, allowed: ["dispatron"], want: false },
    { name: "a blank client id is no client id", method: "identity_token", client: "", allowed: [""], want: false },
    { name: "a prefix of a name is not the name", method: "identity_token", client: "dispatron-x", allowed: ["dispatron"], want: false },
    { name: "an API key is not asked", method: "api_key", client: undefined, allowed: [], want: true },
    { name: "a cookie is not asked", method: "cookie", client: undefined, allowed: [], want: true },
    { name: "no credential path (BYOK, dev) is not asked", method: null, client: undefined, allowed: [], want: true },
  ];
  for (const c of cases) {
    test(c.name, () => assert.equal(identityCallerMayUseA2a(c.method, c.client, new Set(c.allowed)), c.want));
  }
});

describe("F2 the card options", () => {
  const cases: Array<{ name: string; env: Record<string, string>; want: Record<string, unknown> }> = [
    { name: "nothing set", env: {}, want: { contextTasks: false } },
    { name: "the model alone", env: { CLAW_A2A_CONTEXT_TASKS: "1" }, want: { contextTasks: true } },
    {
      name: "the identity scheme needs the client, the token path and an issuer",
      env: { CLAW_A2A_CONTEXT_TASKS: "1", IDENTITY_CLIENT_ENABLED: "true", CLAW_IDENTITY_TOKEN_AUTH_ENABLED: "true", IDENTITY_ISSUER_URL: "https://idp.example.com/" },
      want: { contextTasks: true, oidcUrl: "https://idp.example.com/.well-known/openid-configuration", oidcScope: "claw.api" },
    },
    {
      name: "the scope the token path requires is the one the card names",
      env: { CLAW_A2A_CONTEXT_TASKS: "1", IDENTITY_CLIENT_ENABLED: "true", CLAW_IDENTITY_TOKEN_AUTH_ENABLED: "true", IDENTITY_ISSUER_URL: "https://idp.example.com", CLAW_IDENTITY_TOKEN_SCOPE: " claw.chat " },
      want: { contextTasks: true, oidcUrl: "https://idp.example.com/.well-known/openid-configuration", oidcScope: "claw.chat" },
    },
    {
      name: "no issuer, no scheme",
      env: { CLAW_A2A_CONTEXT_TASKS: "1", IDENTITY_CLIENT_ENABLED: "true", CLAW_IDENTITY_TOKEN_AUTH_ENABLED: "true" },
      want: { contextTasks: true },
    },
    {
      name: "tokens off, no scheme",
      env: { CLAW_A2A_CONTEXT_TASKS: "1", IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: "https://idp.example.com" },
      want: { contextTasks: true },
    },
    {
      name: "the old model never advertises the identity scheme",
      env: { IDENTITY_CLIENT_ENABLED: "true", CLAW_IDENTITY_TOKEN_AUTH_ENABLED: "true", IDENTITY_ISSUER_URL: "https://idp.example.com" },
      want: { contextTasks: false },
    },
  ];
  for (const c of cases) test(c.name, () => assert.deepEqual(cardOptionsFromEnv(c.env), c.want));
});

describe("F3 the card", () => {
  test("with no options it is the card it always was", () => {
    const card = genericAgentCard("https://claw.example.com");
    assert.equal(card.skills.length, 4);
    assert.equal(card.capabilities.pushNotifications, false);
    assert.deepEqual(card.securityRequirements, [{ bearer: [] }]);
    assert.deepEqual(Object.keys(card.securitySchemes ?? {}), ["bearer"]);
  });

  test("under the new model it describes the one way in", () => {
    const card = genericAgentCard("https://claw.example.com", { contextTasks: true });
    assert.deepEqual(card.skills.map((s) => s.id), ["chat"]);
    assert.equal(card.capabilities.pushNotifications, false);
    assert.equal(card.supportedInterfaces[0].url, "https://claw.example.com/a2a");
    // v1.0 spells a requirement { schemes: { name: { list: [...] } } }.
    assert.deepEqual(card.securityRequirements, [{ schemes: { bearer: { list: [] } } }]);
  });

  test("the card names the scope the operator configured", () => {
    const card = genericAgentCard("", { contextTasks: true, oidcUrl: "https://idp.example.com/.well-known/openid-configuration", oidcScope: "claw.chat" });
    assert.deepEqual(card.securityRequirements?.[0], { schemes: { identity: { list: ["claw.chat"] } } });
    assert.match(String((card.securitySchemes?.identity as { openIdConnectSecurityScheme: { description: string } }).openIdConnectSecurityScheme.description), /scope claw\.chat/);
  });

  test("the identity scheme is offered beside the bearer one, with its scope", () => {
    const opts = { contextTasks: true, oidcUrl: "https://idp.example.com/.well-known/openid-configuration" };
    for (const card of [genericAgentCard("", opts), pluginAgentCard("", { id: 3, name: "p" }, opts)]) {
      assert.deepEqual(card.securitySchemes?.identity, {
        openIdConnectSecurityScheme: {
          openIdConnectUrl: opts.oidcUrl,
          description: "Access token from the deployment's identity provider (scope claw.api)",
        },
      });
      assert.ok(card.securitySchemes?.bearer);
      assert.deepEqual(card.securityRequirements, [
        { schemes: { identity: { list: ["claw.api"] } } },
        { schemes: { bearer: { list: [] } } },
      ]);
    }
  });

  test("a plugin card keeps the plugin's own skills under the new model", () => {
    const card = pluginAgentCard("", { id: 3, name: "reviewer", tools: [{ type: "skill", name: "lint", description: "Lints" }] }, { contextTasks: true });
    assert.deepEqual(card.skills.map((s) => s.id), ["skill-lint"]);
  });
});

describe("F4 the card's validator", () => {
  test("the same card has the same tag, and a different card another", () => {
    const a = cardEtag(genericAgentCard("https://a.example.com", { contextTasks: true }));
    assert.equal(a, cardEtag(genericAgentCard("https://a.example.com", { contextTasks: true })));
    assert.notEqual(a, cardEtag(genericAgentCard("https://b.example.com", { contextTasks: true })));
    assert.match(a, /^"[0-9a-f]{32}"$/);
  });

  const tag = '"abc"';
  const matches: Array<[string, string | string[] | undefined, boolean]> = [
    ["the tag", tag, true],
    ["a weak form of it", `W/${tag}`, true],
    ["among others", `"x", ${tag}, "y"`, true],
    ["a list across headers", ['"x"', tag], true],
    ["anything", "*", true],
    ["another tag", '"abd"', false],
    ["nothing", undefined, false],
    ["blank", "", false],
  ];
  for (const [name, header, want] of matches) test(`If-None-Match: ${name}`, () => assert.equal(etagMatches(header, tag), want));
});
