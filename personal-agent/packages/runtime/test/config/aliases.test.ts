// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's own settings under their `PA_` names and their older `TEAMS_` names: each is read under either, the `PA_`
 * name wins when both are set, a blank `PA_` name leaves the `TEAMS_` one in force, a message names the variable the
 * value came from, and a deployment that still writes `TEAMS_` gets one warning that never carries a value.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ConfigError } from "@primusclaw/personal-agent";

import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import {
  ALIASED_SETTINGS,
  EnvReader,
  EnvSecretSource,
  SETTING_ALIASES,
  legacySettings,
  readSettings,
  settingSource,
  wantedSecrets,
  warnLegacySettings,
  type Env,
} from "../../src/index.js";

const BASE: Env = {
  CLAW_API_URL: "https://claw.example.com/claw-api",
  SAFE_API_URL: "https://safe.example.com",
  PUBLIC_BASE_URL: "https://claw.example.com",
  ASSISTANT_ENABLED: "1",
  ASSISTANT_USERS: "aad-a,aad-b",
};

/** A value every aliased setting accepts, so one environment sets all of them at once (`which` tells two apart). */
function valueOf(stem: string, which: 1 | 2): string {
  if (stem.endsWith("_ENABLED") || stem === "EXCHANGE_FOR_CHAT" || stem === "CLAW_EVENTS_GONE") return "1";
  if (stem === "DIRECT_CHAT" || stem === "ASSISTANT_UNDERSTANDING") return "on";
  if (stem === "GROUP_CONTEXT_GRANTED") return "1";
  if (stem.startsWith("LIMIT_")) return `${String(which)}/600`;
  if (stem === "GROUP_CONTEXT_MESSAGES") return String(10 * which);
  if (/(LIMIT|SECONDS|TASKS|HOURS|CHARS|FAILURES_PER_USER|FAILURES_GLOBAL)$/.test(stem)) return String(which + 1);
  if (stem === "ASSISTANT_UNDERSTANDING_USERS") return which === 1 ? "aad-a" : "aad-b";
  if (stem === "ENCRYPTION_KEYS") return `key-${String(which)}`;
  if (stem.endsWith("_URL")) return `https://${stem.toLowerCase().replaceAll("_", "-")}-${String(which)}.example.com`;
  return `${stem.toLowerCase()}-${String(which)}`;
}

function everySetting(prefix: "PA_" | "TEAMS_", which: 1 | 2): Record<string, string> {
  return Object.fromEntries(ALIASED_SETTINGS.map((stem) => [prefix + stem, valueOf(stem, which)]));
}

describe("the worker's setting names", () => {
  it("every PA_ name has the TEAMS_ name it replaces, and nothing else is aliased", () => {
    assert.equal(SETTING_ALIASES.size, ALIASED_SETTINGS.length);
    for (const [neutral, legacy] of SETTING_ALIASES) {
      assert.match(neutral, /^PA_[A-Z_]+$/);
      assert.equal(legacy, neutral.replace(/^PA_/, "TEAMS_"));
    }
    // a surface's own settings keep the surface's prefix
    for (const own of ["TEAMS_STREAMING", "TEAMS_AI_LABEL", "TEAMS_GATE_ENTRY", "TEAMS_INSTALL_HINT_URL"]) {
      assert.equal(settingSource({ [own]: "x", ["PA_" + own.slice(6)]: "y" }, own), own);
    }
  });

  it("the TEAMS_ names alone give the same settings as the PA_ names alone", () => {
    const old = readSettings({ ...BASE, ...everySetting("TEAMS_", 1) });
    const neutral = readSettings({ ...BASE, ...everySetting("PA_", 1) });
    assert.deepEqual(neutral, old);
    // (and the values really were read: none is a default)
    assert.equal(neutral.dbPath, "db_path-1");
    assert.deepEqual(neutral.encryptionKeys, ["key-1"]);
    assert.equal(neutral.exchange.clientSecret, "exchange_client_secret-1");
    assert.equal(neutral.userLimits.messageLimit, 2);
    assert.deepEqual(neutral.sensitiveLimits.get("pr_merge"), { count: 1, windowSeconds: 600 });
    assert.equal(neutral.groupContext.messages, 10);
    assert.deepEqual([...neutral.assistant.understandingUsers], ["aad-a"]);
  });

  it("with both names set the PA_ value is read, for every setting", () => {
    const both = readSettings({ ...BASE, ...everySetting("TEAMS_", 1), ...everySetting("PA_", 2) });
    assert.deepEqual(both, readSettings({ ...BASE, ...everySetting("PA_", 2) }));
    assert.notDeepEqual(both, readSettings({ ...BASE, ...everySetting("TEAMS_", 1) }));
    for (const stem of ALIASED_SETTINGS) {
      const env = { ["TEAMS_" + stem]: valueOf(stem, 1), ["PA_" + stem]: valueOf(stem, 2) };
      assert.equal(new EnvReader(env).raw("PA_" + stem), valueOf(stem, 2), stem);
      // (asked by its old name, the same rule)
      assert.equal(new EnvReader(env).raw("TEAMS_" + stem), valueOf(stem, 2), stem);
    }
  });

  it("a blank PA_ name leaves the TEAMS_ value in force; a blank TEAMS_ name is read as blank", () => {
    assert.equal(
      readSettings({ ...BASE, PA_ENCRYPTION_KEYS: "k", PA_DB_PATH: " ", TEAMS_DB_PATH: "/x.db" }).dbPath,
      "/x.db",
    );
    assert.equal(settingSource({ PA_DB_PATH: "", TEAMS_DB_PATH: "/x.db" }, "PA_DB_PATH"), "TEAMS_DB_PATH");
    assert.equal(settingSource({ TEAMS_DB_PATH: "" }, "PA_DB_PATH"), "TEAMS_DB_PATH");
    assert.equal(settingSource({}, "TEAMS_DB_PATH"), "PA_DB_PATH");
    assert.equal(readSettings({ ...BASE, PA_ENCRYPTION_KEYS: "k" }).dbPath, "/data/state.db");
  });
});

describe("what a deployment with the older names sees", () => {
  it("a malformed value is named by the variable it was read from", () => {
    const refused = (env: Env, message: string): void => {
      assert.throws(
        () => readSettings({ ...BASE, PA_ENCRYPTION_KEYS: "k", ...env }),
        (err: unknown) => err instanceof ConfigError && err.message.startsWith(message),
      );
    };
    refused({ TEAMS_USER_MESSAGE_LIMIT: "many" }, "TEAMS_USER_MESSAGE_LIMIT must be a positive whole number");
    refused({ PA_USER_MESSAGE_LIMIT: "many", TEAMS_USER_MESSAGE_LIMIT: "5" }, "PA_USER_MESSAGE_LIMIT must be");
    refused({ TEAMS_DIRECT_CHAT: "maybe" }, "TEAMS_DIRECT_CHAT must be on or off");
    refused({ PA_LIMIT_PR_MERGE: "five" }, "PA_LIMIT_PR_MERGE must be COUNT/SECONDS");
    refused({ TEAMS_LIMIT_PR_MERGE: "five" }, "TEAMS_LIMIT_PR_MERGE must be COUNT/SECONDS");
    refused({ PA_GROUP_CONTEXT_MESSAGES: "500" }, "PA_GROUP_CONTEXT_MESSAGES must be between 0 and 200");
    refused({ PA_GITHUB_REVIEW_ENABLED: "1" }, "PA_GITHUB_REVIEW_ENABLED needs PA_EXCHANGE_ENABLED");
    refused({ PA_EXCHANGE_ENABLED: "1", PA_EXCHANGE_CLIENT_SECRET: "s" }, "environment variable PA_EXCHANGE_CLIENT_ID");
  });

  it("the secrets are read from either name, the PA_ one first", async () => {
    const load = (env: Env) => new EnvSecretSource(env).load(wantedSecrets(env));
    const old = await load({
      TEAMS_ENCRYPTION_KEYS: "a",
      TEAMS_EXCHANGE_ENABLED: "1",
      TEAMS_EXCHANGE_CLIENT_SECRET: "s",
    });
    assert.deepEqual(Object.fromEntries(old), { TEAMS_ENCRYPTION_KEYS: "a", TEAMS_EXCHANGE_CLIENT_SECRET: "s" });
    const neutral = await load({ PA_ENCRYPTION_KEYS: "b", PA_EXCHANGE_ENABLED: "1", PA_EXCHANGE_CLIENT_SECRET: "t" });
    assert.deepEqual(Object.fromEntries(neutral), { TEAMS_ENCRYPTION_KEYS: "b", TEAMS_EXCHANGE_CLIENT_SECRET: "t" });
    const both = await load({ PA_ENCRYPTION_KEYS: "b", TEAMS_ENCRYPTION_KEYS: "a" });
    assert.deepEqual(Object.fromEntries(both), { TEAMS_ENCRYPTION_KEYS: "b" });
    await assert.rejects(load({}), { message: "environment variable PA_ENCRYPTION_KEYS is required" });
  });

  it("one warning names the TEAMS_ names in use and their PA_ names, never a value", () => {
    const logger = new RecordingLogger();
    warnLegacySettings(
      { PA_DB_PATH: "/a.db", TEAMS_ENCRYPTION_KEYS: "secret-key", TEAMS_DIRECT_CHAT: "on", TEAMS_STREAMING: "off" },
      logger,
    );
    assert.equal(logger.lines.length, 1);
    const [line] = logger.lines;
    assert.ok(line);
    assert.equal(line.level, "warn");
    assert.equal(
      line.message,
      "deprecated setting names: TEAMS_ENCRYPTION_KEYS (now PA_ENCRYPTION_KEYS), TEAMS_DIRECT_CHAT (now PA_DIRECT_CHAT); " +
        "they still work, the PA_ names take precedence",
    );
    assert.ok(!logger.dump().includes("secret-key"));
    assert.ok(!logger.dump().includes("TEAMS_STREAMING"));
  });

  it("a TEAMS_ name set beside its PA_ name is said to be ignored; PA_ names alone log nothing", () => {
    const logger = new RecordingLogger();
    warnLegacySettings({ PA_ENCRYPTION_KEYS: "b", TEAMS_ENCRYPTION_KEYS: "a", TEAMS_DB_PATH: "" }, logger);
    assert.deepEqual(
      logger.lines.map((l) => l.message),
      ["TEAMS_ENCRYPTION_KEYS is ignored: PA_ENCRYPTION_KEYS is set"],
    );
    assert.deepEqual(legacySettings({ PA_ENCRYPTION_KEYS: "b", TEAMS_ENCRYPTION_KEYS: "a" }), [
      { legacy: "TEAMS_ENCRYPTION_KEYS", neutral: "PA_ENCRYPTION_KEYS", ignored: true },
    ]);
    const quiet = new RecordingLogger();
    warnLegacySettings({ ...everySetting("PA_", 1), TEAMS_AI_LABEL: "on" }, quiet);
    assert.deepEqual(quiet.lines, []);
  });
});

describe("the guide and the example", () => {
  it("the configuration guide lists every PA_ name with the TEAMS_ name it replaces", () => {
    const guide = readFileSync(new URL("../../../../docs/configuration.md", import.meta.url), "utf8");
    const table = guide.slice(guide.indexOf("## Setting names"));
    assert.ok(table.length < guide.length, "the guide has a Setting names section");
    for (const [neutral, legacy] of SETTING_ALIASES) {
      assert.ok(guide.includes("`" + neutral + "`"), `${neutral} is documented`);
      assert.ok(table.includes("`" + legacy + "`"), `${legacy} is listed as the alias of ${neutral}`);
    }
    // (and the guide documents no TEAMS_ name of these as the one to write)
    const before = guide.slice(0, guide.indexOf("## Setting names"));
    for (const legacy of SETTING_ALIASES.values()) {
      assert.ok(!before.includes("`" + legacy + "`"), `${legacy} is written under its PA_ name`);
    }
  });

  it("the example environment writes the PA_ names", () => {
    const example = readFileSync(new URL("../../../../examples/worker.env.example", import.meta.url), "utf8");
    for (const legacy of SETTING_ALIASES.values()) assert.ok(!example.includes(legacy), legacy);
    for (const neutral of ["PA_ENCRYPTION_KEYS", "PA_DB_PATH", "PA_EXCHANGE_ENABLED", "PA_LIMIT_PR_MERGE"]) {
      assert.ok(example.includes(neutral), neutral);
    }
  });
});
