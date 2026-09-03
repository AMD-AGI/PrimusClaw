// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The exact-value redaction pass gets credentials, and only credentials.
 *
 * `runtimeSecrets()` feeds a blind substring replace: every string it returns
 * is cut out of every string that leaves the run -- events into NATS and the
 * event DB, the transcript archive, SSE, the ExecuteResult that becomes a
 * downstream node's prompt, and the checkpoint that a resumed run replays to
 * the model. That last sink is what makes over-collection expensive rather
 * than merely untidy: a value cut there is not masked for a reader, it is gone
 * from the conversation, and the agent resumes without it.
 *
 * It used to return every user_env / session_env value. On one live deployment
 * that put a `<redacted>` into the persisted history of 342 of 344 sessions in
 * a week, and what it had destroyed was ordinary content -- a FORGE_PATH inside
 * `sed -n '140,340p' ...`, a MODEL_PATH inside `export MODEL_PATH=.../Qwen3-8B`,
 * and a word excised from the middle of `backends/remote_runner.py`.
 *
 * Two guards now stand between a config value and that outcome, and this file
 * pins both, in both directions. Narrowing them re-opens the bug; removing
 * them the other way leaks a credential. The fixtures below are transcribed
 * from the real corpus that was being mangled.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest } from "@claw/protocol";
import { __test__ } from "../src/tasks/runner.js";
import { redactPersistedEvent } from "../src/events/redaction.js";

const { runtimeSecrets } = __test__;

/** A live token: credential-named, credential-shaped, long. */
const HF_TOKEN = `hf_${"b".repeat(34)}`;
const LLM_KEY = `sk-ant-${"a".repeat(40)}`;

/** A line of the kind the redactor was cutting holes in. */
const TRANSCRIPT =
  "sed -n '140,340p' /models/qwen3-8b/backends/remote_runner.py"
  + " && export MODEL_PATH=/models/qwen3-8b/Qwen3-8B";

function request(overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    task_id: "t-1",
    session_id: "s-1",
    mode: "llm",
    llm_api_key: LLM_KEY,
    platform_key: `pk-${"c".repeat(30)}`,
    user_env: {
      // Ordinary configuration. Every one of these is >= 4 characters and
      // appears verbatim in TRANSCRIPT, which is exactly why the old rule
      // destroyed it.
      MODEL_PATH: "/models/qwen3-8b",
      GIT_SUBCOMMAND: "remote",
      FORGE_PATH: "/models/qwen3-8b/backends",
      // A credential, by name and by length.
      HF_TOKEN,
    },
    ...overrides,
  } as ExecuteRequest;
}

test("only credential-named env vars are collected as exact secrets", () => {
  const secrets = runtimeSecrets(request());

  assert.ok(secrets.includes(HF_TOKEN), "HF_TOKEN is a credential and must be hunted");
  assert.ok(secrets.includes(LLM_KEY), "the run's own LLM key must still be hunted");

  for (const config of ["/models/qwen3-8b", "remote", "/models/qwen3-8b/backends"]) {
    assert.ok(
      !secrets.includes(config),
      `${JSON.stringify(config)} is configuration, not a credential; collecting it `
        + "deletes it from the conversation the model resumes with",
    );
  }
});

test("session_env is filtered by the same rule as user_env", () => {
  const secrets = runtimeSecrets(request({
    user_env: {},
    session_env: { GBRAIN_TOKEN: `gb_${"d".repeat(30)}`, RECIPE_KB_REMOTE: "remote" },
  }));
  assert.ok(secrets.includes(`gb_${"d".repeat(30)}`));
  assert.ok(!secrets.includes("remote"));
});

test("a resolved platform key is still collected", () => {
  // It arrives from the KV fallback rather than the request, and is the one
  // credential with no field of its own on ExecuteRequest.
  const resolved = `resolved-${"e".repeat(24)}`;
  assert.ok(runtimeSecrets(request(), resolved).includes(resolved));
});

test("ordinary configuration survives a round trip through the redactor", () => {
  // The end-to-end property, and the one that fails against the old rule: the
  // transcript comes back byte-identical, so a resumed run replays what was
  // actually sent.
  const evt = redactPersistedEvent(
    { type: "toolUsed", argumentsDetail: { bash: { command: TRANSCRIPT } } },
    runtimeSecrets(request()),
  );
  assert.equal(
    (evt.argumentsDetail as any).bash.command,
    TRANSCRIPT,
    "no part of a path or identifier may be excised",
  );
});

test("a real credential in the same payload is still masked", () => {
  // The other direction. A patch that widens the transcript assertion by
  // weakening the redactor turns this red.
  const evt = redactPersistedEvent(
    {
      type: "toolUsed",
      argumentsDetail: { bash: { command: `${TRANSCRIPT} # HF_TOKEN=${HF_TOKEN}` } },
      full_output: `auth failed for ${LLM_KEY}`,
    },
    runtimeSecrets(request()),
  );
  const encoded = JSON.stringify(evt);
  assert.ok(!encoded.includes(HF_TOKEN), "a credential-named env value must not survive");
  assert.ok(!encoded.includes(LLM_KEY), "the run's LLM key must not survive");
  assert.ok(encoded.includes("/models/qwen3-8b/backends/remote_runner.py"), "…while the path does");
});

test("a short value cannot excise a word from prose even when its name says secret", () => {
  // Belt to the braces above: names are a heuristic, and a var called
  // *_TOKEN holding "true" or "main" would otherwise cut that word out of
  // every command in the payload. The floor is what makes the heuristic safe
  // to err towards redacting.
  const evt = redactPersistedEvent(
    { type: "toolUsed", description: "git remote add origin https://example.invalid/main.git" },
    runtimeSecrets(request({ user_env: { FEATURE_TOKEN: "true", BRANCH_TOKEN: "main" } })),
  );
  assert.equal(
    evt.description,
    "git remote add origin https://example.invalid/main.git",
    "a value too short to identify a credential must not be substituted",
  );
});

test("a whole environment block is still masked by key name", () => {
  // Narrowing which VALUES are hunted must not touch the key-name pass, which
  // is the only defence for a credential with no distinguishing shape.
  const evt = redactPersistedEvent({
    type: "toolUsed",
    argumentsDetail: { bash: { command: "env", env: { MODEL_PATH: "/models/qwen3-8b" } } },
  }, runtimeSecrets(request()));
  assert.equal((evt.argumentsDetail as any).bash.env, "<redacted>");
});
