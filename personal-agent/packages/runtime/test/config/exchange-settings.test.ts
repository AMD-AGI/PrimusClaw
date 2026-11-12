// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError } from "@primusclaw/personal-agent";
import { readSettings, type Env } from "../../src/index.js";

const BASE: Env = {
  TEAMS_ENCRYPTION_KEYS: "k",
  CLAW_API_URL: "https://claw.example.com/claw-api",
  SAFE_API_URL: "https://safe.example.com",
  PUBLIC_BASE_URL: "https://claw.example.com",
};
const ON: Env = { TEAMS_EXCHANGE_ENABLED: "true", TEAMS_EXCHANGE_CLIENT_ID: "cid", TEAMS_EXCHANGE_CLIENT_SECRET: "s" };

const settings = (extra: Env = {}): ReturnType<typeof readSettings> => readSettings({ ...BASE, ...extra });
const refused = (extra: Env, message: string): void => {
  assert.throws(
    () => settings(extra),
    (err: unknown) => err instanceof ConfigError && err.message.includes(message),
  );
};

describe("the token exchange settings", () => {
  it("the exchange defaults are what identity registered for the worker", () => {
    const s = settings(ON);
    assert.deepEqual(
      [s.exchange.issuer, s.exchange.audience, s.exchange.scope],
      ["teams.microsoft.com", "claw-api", "claw.api"],
    );
    assert.equal(s.exchange.bindingRequestUrl, `${s.publicBaseUrl}/oauth/binding-requests`);
    const other = settings({ ...ON, TEAMS_EXCHANGE_ISSUER: "other.example", TEAMS_EXCHANGE_SCOPE: "safe.read" });
    assert.deepEqual([other.exchange.issuer, other.exchange.scope], ["other.example", "safe.read"]);
  });

  it("flag off by default in settings", () => {
    assert.equal(settings().exchange.enabled, false);
    assert.equal(settings().exchange.tokenUrl, "");
    refused({ TEAMS_EXCHANGE_ENABLED: "true" }, "environment variable PA_EXCHANGE_CLIENT_ID is required");
    const s = settings(ON);
    assert.ok(s.exchange.enabled);
    assert.equal(s.exchange.tokenUrl, `${s.publicBaseUrl}/oauth/token`);
    assert.equal(s.exchange.clientSecret, "s");
  });

  it("the exchange for chat flag is off by default and needs the exchange", () => {
    assert.equal(settings().exchange.forChat, false);
    refused({ TEAMS_EXCHANGE_FOR_CHAT: "true" }, "TEAMS_EXCHANGE_FOR_CHAT needs PA_EXCHANGE_ENABLED");
    assert.equal(settings({ ...ON, TEAMS_EXCHANGE_FOR_CHAT: "true" }).exchange.forChat, true);
    const s = settings(ON);
    assert.ok(s.exchange.enabled && !s.exchange.forChat);
  });
});

describe("the review for a colleague", () => {
  it("needs the exchange and the owners whose pull requests are taken", () => {
    refused({ TEAMS_GITHUB_REVIEW_ENABLED: "on" }, "TEAMS_GITHUB_REVIEW_ENABLED needs PA_EXCHANGE_ENABLED");
    refused({ ...ON, TEAMS_GITHUB_REVIEW_ENABLED: "on" }, "needs PA_GITHUB_REVIEW_OWNERS");
    const s = settings({
      ...ON,
      TEAMS_GITHUB_REVIEW_ENABLED: "on",
      TEAMS_GITHUB_REVIEW_OWNERS: "AMD-AGI, other ,",
      CLAWY_MODEL: "m",
    });
    assert.deepEqual(s.githubReview.owners, ["AMD-AGI", "other"]);
    assert.equal(s.githubReview.intentModel, "m");
    assert.equal(s.githubReview.credentialUrl, "https://claw.example.com/oauth/external-credentials");
    const own = settings({
      ...ON,
      TEAMS_GITHUB_REVIEW_ENABLED: "on",
      TEAMS_GITHUB_REVIEW_OWNERS: "o",
      TEAMS_REVIEW_INTENT_MODEL: "small",
      TEAMS_GITHUB_CREDENTIAL_URL: "https://id.example/creds/",
      TEAMS_GITHUB_CLIENT_ID: " ",
    });
    assert.deepEqual(
      [own.githubReview.intentModel, own.githubReview.credentialUrl, own.githubReview.clientId],
      ["small", "https://id.example/creds", "178c6fc778ccc68e1d6a"],
    );
  });
});

describe("the assistant's settings", () => {
  it("off by default and on only for the people listed", () => {
    assert.deepEqual([...settings().assistant.understandingUsers], []);
    assert.deepEqual([...settings({ TEAMS_ASSISTANT_UNDERSTANDING_USERS: "AAD-Y" }).assistant.understandingUsers], []);
    const on = settings({
      ASSISTANT_ENABLED: "1",
      TEAMS_ASSISTANT_UNDERSTANDING: "on",
      TEAMS_ASSISTANT_UNDERSTANDING_USERS: "AAD-Y, aad-w,",
    });
    assert.deepEqual(new Set(on.assistant.understandingUsers), new Set(["aad-y", "aad-w"]));
    const fromAssistant = settings({
      ASSISTANT_ENABLED: "1",
      ASSISTANT_USERS: "AAD-Z",
      TEAMS_ASSISTANT_UNDERSTANDING: "on",
    });
    assert.deepEqual([...fromAssistant.assistant.understandingUsers], ["aad-z"]);
  });

  const cannot: Array<[Env, string]> = [
    [{ TEAMS_ASSISTANT_UNDERSTANDING: "on", TEAMS_ASSISTANT_UNDERSTANDING_USERS: "aad-y" }, "needs ASSISTANT_ENABLED"],
    [{ ASSISTANT_ENABLED: "1", TEAMS_ASSISTANT_UNDERSTANDING: "on" }, "names nobody"],
    [
      { ASSISTANT_ENABLED: "1", TEAMS_ASSISTANT_UNDERSTANDING: "shadow", TEAMS_ASSISTANT_UNDERSTANDING_USERS: "aad-y" },
      "on or off",
    ],
    [
      {
        ASSISTANT_ENABLED: "1",
        ASSISTANT_USERS: "aad-x",
        TEAMS_ASSISTANT_UNDERSTANDING: "on",
        TEAMS_ASSISTANT_UNDERSTANDING_USERS: "aad-y",
      },
      "names people who are not in ASSISTANT_USERS",
    ],
    [
      { ASSISTANT_REPLY_WINDOW_SECONDS: "0" },
      "ASSISTANT_REPLY_WINDOW_SECONDS must be a positive number of seconds, not '0'",
    ],
  ];
  for (const [extra, error] of cannot) {
    it(`a setting that cannot be meant stops the start: ${error}`, () => {
      refused(extra, error);
    });
  }

  it("the reply window", () => {
    assert.equal(settings({ ASSISTANT_REPLY_WINDOW_SECONDS: "60" }).assistant.replyWindowSeconds, 60);
    // Python's isdigit and int read decimal digits of any script
    assert.equal(settings({ ASSISTANT_REPLY_WINDOW_SECONDS: "\u0666\u0660" }).assistant.replyWindowSeconds, 60);
  });
});
