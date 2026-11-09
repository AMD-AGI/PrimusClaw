// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The worker's settings from the environment: names, defaults, and a typo that stops the worker instead of picking a value. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError } from "@primusclaw/personal-agent";
import { readSettings, type Env } from "../../src/index.js";

/** What every deployment sets (the test environment's, as the Python suite's `conftest` gives it). */
const BASE: Env = {
  TEAMS_ENCRYPTION_KEYS: "k",
  CLAW_API_URL: "https://claw.example.com/claw-api/",
  SAFE_API_URL: "https://safe.example.com",
  PUBLIC_BASE_URL: "https://claw.example.com/",
};

function settings(extra: Env = {}): ReturnType<typeof readSettings> {
  return readSettings({ ...BASE, ...extra });
}

function refused(extra: Env, message: string | RegExp): void {
  assert.throws(
    () => settings(extra),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError || (err instanceof Error && err.name === "SecretsUnavailable"), String(err));
      if (typeof message === "string") assert.ok(err.message.includes(message), err.message);
      else assert.match(err.message, message);
      return true;
    },
  );
}

describe("settings", () => {
  it("the defaults, and every address without its trailing slash", () => {
    const s = settings();
    assert.equal(s.dbPath, "/data/state.db");
    assert.deepEqual(s.encryptionKeys, ["k"]);
    assert.equal(s.clawApiUrl, "https://claw.example.com/claw-api");
    assert.equal(s.publicBaseUrl, "https://claw.example.com");
    assert.equal(s.listenPort, 8080);
    assert.equal(s.metricsPort, 9090);
    assert.deepEqual(s.claw, { pluginId: null, ruleToolId: null, clientLabel: "clawy" });
    assert.deepEqual(s.models, { chat: "", fallback: "", review: "" });
    assert.equal(s.githubReview.enabled, false);
    assert.equal(s.githubReview.clientId, "178c6fc778ccc68e1d6a");
    assert.equal(s.assistant.replyWindowSeconds, 1800);
    assert.deepEqual(s.linkLimits, { perUser: 5, global: 100, windowSeconds: 600 });
    assert.equal(s.secretsSource, "env");
    assert.equal(s.clawEventsGone, false);
    assert.equal(s.directChat.enabled, false);
  });

  it("each required address", () => {
    for (const name of ["PUBLIC_BASE_URL", "CLAW_API_URL", "SAFE_API_URL", "TEAMS_ENCRYPTION_KEYS"]) {
      refused({ [name]: " " }, `environment variable ${name} is required`);
    }
  });

  it("lists, ids and keys as a deployment writes them", () => {
    const s = settings({
      TEAMS_ENCRYPTION_KEYS: " new, old ,",
      TEAMS_ON_BEHALF_USERS: "U-1, u-2,",
      TEAMS_OBSERVE_USERS: "AAD-A",
      TEAMS_DIRECT_CHAT: "on",
      TEAMS_DIRECT_CHAT_USERS: "AAD-B",
      TEAMS_CLAW_EVENTS_GONE: "yes",
      CLAW_PLUGIN_ID: " 3 ",
      CLAW_CLIENT_LABEL: "my-agent",
      TEAMS_DB_PATH: "/tmp/x.db",
      PORT: "8000",
    });
    assert.deepEqual(s.encryptionKeys, ["new", "old"]);
    assert.deepEqual([...s.onBehalfUsers], ["U-1", "u-2"]);
    assert.deepEqual([...s.observeUsers], ["aad-a"]);
    assert.deepEqual([s.directChat.enabled, [...s.directChat.users]], [true, ["aad-b"]]);
    assert.equal(s.clawEventsGone, true);
    assert.equal(s.claw.pluginId, 3);
    assert.equal(s.claw.clientLabel, "my-agent");
    assert.equal(s.dbPath, "/tmp/x.db");
    assert.equal(s.listenPort, 8000);
    refused({ TEAMS_DIRECT_CHAT: "maybe" }, "TEAMS_DIRECT_CHAT must be on or off, not 'maybe'");
    refused({ CLAW_PLUGIN_ID: "three" }, "CLAW_PLUGIN_ID must be a whole number");
    refused({ PORT: "" }, "PORT must be a whole number");
    assert.equal(settings({ PORT: "8_000" }).listenPort, 8000);
    refused({ PORT: "8__000" }, "PORT must be a whole number");
    assert.equal(settings({ METRICS_PORT: "\u0669\u0664\u0666\u0664" }).metricsPort, 9464); // Arabic-Indic digits, as Python's isdigit/int
    assert.equal(settings({ PORT: "\uff18\uff10\uff10\uff10" }).listenPort, 8000);
  });

  it("setting is read from the environment", () => {
    assert.equal(settings().claw.ruleToolId, null);
    assert.equal(settings({ CLAW_RULE_TOOL_ID: "17" }).claw.ruleToolId, 17);
  });

  it("the fallback model is the deployment's and none by default", () => {
    assert.equal(settings().models.fallback, "");
    assert.equal(settings({ CLAWY_FALLBACK_MODEL: "glm-5-3-with-fallback" }).models.fallback, "glm-5-3-with-fallback");
    assert.equal(settings({ CLAWY_FALLBACK_MODEL: "" }).models.fallback, "");
    assert.equal(settings({ CLAWY_FALLBACK_MODEL: " other-model " }).models.fallback, "other-model");
  });

  it("the metrics port defaults to 9090 and never shares the public port", () => {
    assert.equal(settings().metricsPort, 9090);
    assert.equal(settings({ METRICS_PORT: "9464" }).metricsPort, 9464);
    refused({ METRICS_PORT: "8080" }, "METRICS_PORT must differ from PORT (8080)");
    refused({ METRICS_PORT: "nine" }, "METRICS_PORT");
  });
});

describe("the per-person limits", () => {
  it("the limits have safe defaults and can be set", () => {
    assert.deepEqual(settings().userLimits, { messageLimit: 20, messageWindowSeconds: 60, maxConcurrentTasks: 12 });
    const set = settings({
      TEAMS_USER_MESSAGE_LIMIT: "7",
      TEAMS_USER_MESSAGE_WINDOW_SECONDS: "30",
      TEAMS_USER_MAX_CONCURRENT_TASKS: "2",
    });
    assert.deepEqual(set.userLimits, { messageLimit: 7, messageWindowSeconds: 30, maxConcurrentTasks: 2 });
  });

  for (const name of [
    "TEAMS_USER_MESSAGE_LIMIT",
    "TEAMS_USER_MESSAGE_WINDOW_SECONDS",
    "TEAMS_USER_MAX_CONCURRENT_TASKS",
  ]) {
    for (const value of ["0", "-1", "ten", "1.5"]) {
      it(`a limit that is not a positive number stops the worker: ${name}=${value}`, () => {
        refused({ [name]: value }, `${name} must be a positive whole number, not '${value}'`);
      });
    }
  }

  it("the limits are read from the environment and a typo stops the worker", () => {
    assert.deepEqual(settings({ TEAMS_LIMIT_REMOTE_AGENT: "3/60" }).sensitiveLimits.get("remote_agent"), {
      count: 3,
      windowSeconds: 60,
    });
    refused({ TEAMS_LIMIT_PR_REVIEW: "five/600" }, "TEAMS_LIMIT_PR_REVIEW");
  });

  it("link limits default and come from the environment", () => {
    assert.deepEqual(settings().linkLimits, { perUser: 5, global: 100, windowSeconds: 600 });
    const s = settings({
      TEAMS_LINK_MAX_FAILURES_GLOBAL: "40",
      TEAMS_LINK_MAX_FAILURES_PER_USER: "3",
      TEAMS_LINK_ATTEMPT_WINDOW_SECONDS: "900",
    });
    assert.deepEqual(s.linkLimits, { perUser: 3, global: 40, windowSeconds: 900 });
  });

  for (const value of ["0", "-1", "ten", "1.5"]) {
    it(`a bad link limit refuses to start: ${value}`, () => {
      refused({ TEAMS_LINK_MAX_FAILURES_GLOBAL: value }, "TEAMS_LINK_MAX_FAILURES_GLOBAL");
    });
  }
});
