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
 * It used to return every user_env / session_env value, which put a
 * `<redacted>` into the persisted history of any session whose environment
 * named a path. What it destroyed was ordinary content -- a build path inside
 * `sed -n '140,340p' ...`, a model root inside `export MODEL_PATH=...`, and a
 * word excised from the middle of `backends/remote_runner.py`.
 *
 * Two guards now stand between a config value and that outcome, and this file
 * pins both, in both directions. Narrowing them re-opens the bug; removing
 * them the other way leaks a credential. The fixtures below are illustrative
 * of the shapes that were being mangled, not of any one deployment.
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
      BUILD_ROOT: "/models/qwen3-8b/backends",
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

// ── The other half: shape ───────────────────────────────────────────────────
//
// Narrowing runtimeSecrets() to credential-NAMED env vars leaves a real gap by
// construction: a token stored under an unremarkable name is not collected, so
// the exact-value pass never sees it. That gap is covered by redactSecrets(),
// which matches on what a value looks like instead. The two halves are only
// safe together, so the seam is tested rather than each half alone.

test("a token under an unremarkable name is still caught, by its shape", () => {
  // The case the name filter cannot answer and must not be widened to answer:
  // widening it back is what deleted MODEL_PATH out of the transcript.
  const ghp = `ghp_${"a".repeat(36)}`;
  const secrets = runtimeSecrets(request({ user_env: { BUILD_CONFIG: ghp } }));
  assert.ok(
    !secrets.includes(ghp),
    "BUILD_CONFIG does not read as a credential, so the exact-value pass must not collect it",
  );

  const evt = redactPersistedEvent(
    { type: "toolUsed", argumentsDetail: { bash: { command: `git clone https://${ghp}@host/r` } } },
    secrets,
  );
  assert.ok(!JSON.stringify(evt).includes(ghp), "…and the shape pass must catch it anyway");
});

test("a URI carrying inline credentials loses the credentials and keeps the host", () => {
  // Which host a run talked to is usually the point of the log line, so only
  // the credential half goes. Both halves of that are asserted: a redactor
  // that blanked the whole URI would pass a test that only checked the
  // password was gone.
  const evt = redactPersistedEvent({
    type: "toolUsed",
    full_output: "connect mongodb://svc:s3cr3t@mongo.internal:27017/claw failed",
  }, runtimeSecrets(request({ user_env: {} })));

  const text = String(evt.full_output);
  assert.ok(!text.includes("s3cr3t"), "the inline password must not survive");
  assert.ok(!text.includes("svc:"), "nor the user it belongs to");
  assert.ok(text.includes("mongo.internal:27017/claw"), "the endpoint stays legible");
});

test("a plain endpoint URL is not mistaken for a credential-bearing one", () => {
  // The other direction on the same rule. A URL with a port, a path, or an @
  // in a path segment carries no inline credentials, and rewriting it would
  // cut the endpoint out of the very log line that needs it.
  const ordinary = "curl https://api.example.invalid:8443/v1/models && ls pkgs/@scope/name";
  const evt = redactPersistedEvent(
    { type: "toolUsed", description: ordinary },
    runtimeSecrets(request({ user_env: {} })),
  );
  assert.equal(evt.description, ordinary, "no part of an ordinary URL may be rewritten");
});

test("a credential-named var holding an ordinary word is collected but never hunted", () => {
  // The seam between the two guards, stated directly: the name filter lets the
  // value through (it errs towards redacting, by design) and the
  // distinctiveness filter is what stops it from cutting the word out of
  // prose. A patch that drops either one has to fail something here.
  const secrets = runtimeSecrets(request({ user_env: { BRANCH_TOKEN: "main" } }));
  assert.ok(secrets.includes("main"), "the name filter errs towards collecting");

  const evt = redactPersistedEvent(
    { type: "toolUsed", description: "git switch main" },
    secrets,
  );
  assert.equal(evt.description, "git switch main", "and the distinctiveness filter declines it");
});

// ── The second collection ground: shape ─────────────────────────────────────

test("a credential-shaped value under an unremarkable name is collected by shape", () => {
  // The name check has no chance here -- BUILD_CONFIG is as ordinary as a name
  // gets -- and no vendor prefix matches, so without a shape ground this walks
  // out of the run verbatim.
  const secrets = runtimeSecrets(request({
    user_env: { BUILD_CONFIG: "P@ssw0rd", DEPLOY_OPTS: "Xk9$mzPl2vQ" },
  }));
  assert.ok(secrets.includes("P@ssw0rd"), "a symbol-bearing credential must be hunted");
  assert.ok(secrets.includes("Xk9$mzPl2vQ"));
});

test("build flags and product names under the same names are left alone", () => {
  // BUILD_CONFIG really does hold cmake flags, and DEPLOY_OPTS really does
  // hold `-D...=...`. A shape rule that fires on "symbol plus mixed case"
  // catches those too, and then cuts them out of every command in the
  // transcript that used them -- the same failure as the name rule it was
  // added to complement, arriving by a different door.
  const env = {
    BUILD_CONFIG: "-DFoo=Bar1",
    CMAKE_FLAGS: "-DCMAKE_BUILD_TYPE=Release",
    VENDOR: "GitHub",
    HOST_OS: "macOS",
    HANDLER: "getUserById2",
    COMMENT_ANCHOR: "#Aa12Bb34",
  };
  const secrets = runtimeSecrets(request({ user_env: env }));
  for (const value of Object.values(env)) {
    assert.ok(!secrets.includes(value), `${JSON.stringify(value)} is ordinary configuration`);
  }
  // And end to end: a command line mentioning all of them comes back intact.
  const text = "cmake -DFoo=Bar1 -DCMAKE_BUILD_TYPE=Release # GitHub on macOS, see getUserById2";
  const evt = redactPersistedEvent(
    { type: "toolUsed", argumentsDetail: { bash: { command: text } } },
    secrets,
  ) as { argumentsDetail: { bash: { command: string } } };
  assert.equal(evt.argumentsDetail.bash.command, text);
});

test("the shape ground stays narrow enough not to re-open the incident", () => {
  // Every value below is distinctive by the length-and-entropy test, so a
  // shape rule written as "anything distinctive" would collect all of them --
  // and collecting them is precisely what cut holes in the transcripts they
  // appeared in. Paths, versions, URLs and prose are excluded by shape before
  // distinctiveness is ever consulted.
  const secrets = runtimeSecrets(request({
    user_env: {
      MODEL_PATH: "/models/qwen3-8b",
      MODEL_NAME: "Qwen3-8B",
      BUILD_ROOT: "/models/qwen3-8b/backends",
      APP_VERSION: "v1.2.3",
      ENDPOINT: "https://api.internal/v1",
      GIT_SUBCOMMAND: "remote",
      DEPLOY_ENV: "Staging",
    },
  }));
  for (const config of [
    "/models/qwen3-8b", "Qwen3-8B", "/models/qwen3-8b/backends",
    "v1.2.3", "https://api.internal/v1", "remote", "Staging",
  ]) {
    assert.ok(!secrets.includes(config), `${JSON.stringify(config)} is configuration`);
  }
});

test("an ordinary word is never hunted whatever case it is written in", () => {
  // Same word, three spellings. The exemption is on the word, not on the
  // shift key, so all three come back byte-identical.
  const text = "checkout MAIN then Staging then main";
  const evt = redactPersistedEvent(
    { type: "toolUsed", argumentsDetail: { bash: { command: text } } },
    runtimeSecrets(request({
      user_env: { A_TOKEN: "MAIN", B_TOKEN: "Staging", C_TOKEN: "main" },
    })),
  ) as { argumentsDetail: { bash: { command: string } } };
  assert.equal(evt.argumentsDetail.bash.command, text);
});

test("an identifier or a timezone under a credential name survives free text", () => {
  // The name pass collects these -- PROJECT_TOKEN and TZ_SETTING both read as
  // credentials -- so the second gate is the only thing between them and the
  // transcript. A run that reads its own timezone and calls its own helper
  // gets both words back intact.
  const text = "call getUserById2 with TZ America/New_York then retry3";
  const evt = redactPersistedEvent(
    { type: "toolUsed", argumentsDetail: { bash: { command: text } } },
    runtimeSecrets(request({
      user_env: {
        PROJECT_TOKEN: "getUserById2",
        TZ_SECRET: "America/New_York",
        RETRY_TOKEN: "retry3",
      },
    })),
  ) as { argumentsDetail: { bash: { command: string } } };
  assert.equal(evt.argumentsDetail.bash.command, text);
});

test("a real credential under the same names is still hunted", () => {
  // The other half: the gate above rejects shapes, not the name path itself.
  const evt = redactPersistedEvent(
    { type: "toolUsed", argumentsDetail: { bash: { command: "auth Tr0ub4dor&3x now" } } },
    runtimeSecrets(request({ user_env: { PROJECT_TOKEN: "Tr0ub4dor&3x" } })),
  ) as { argumentsDetail: { bash: { command: string } } };
  assert.equal(evt.argumentsDetail.bash.command.includes("Tr0ub4dor"), false);
});

test("a toolchain string under a credential name survives free text", () => {
  // TOOLCHAIN is named like a credential to the key pass, so the shape gate
  // is the only thing between a build string and a hole in the transcript.
  // Both spellings of the same release have to come back whole.
  const text = "build with Python3.12RC1+NumPy2 then Node20.0.0-rc.1+OpenSSL3";
  const evt = redactPersistedEvent(
    { type: "toolUsed", argumentsDetail: { bash: { command: text } } },
    runtimeSecrets(request({
      user_env: {
        TOOLCHAIN: "Python3.12RC1+NumPy2",
        RUNTIME_TOKEN: "Node20.0.0-rc.1+OpenSSL3",
      },
    })),
  ) as { argumentsDetail: { bash: { command: string } } };
  assert.equal(evt.argumentsDetail.bash.command, text);
});

test("a long ordinary word under a credential name survives free text", () => {
  // The repro exactly: a var named like a credential, holding a word, and a
  // sentence that uses the word for its own reasons.
  const text = "enable internationalization support and check responsibilities";
  const evt = redactPersistedEvent(
    { type: "toolUsed", argumentsDetail: { bash: { command: text } } },
    runtimeSecrets(request({
      user_env: {
        PROJECT_TOKEN: "internationalization",
        FEATURE_SECRET: "responsibilities",
      },
    })),
  ) as { argumentsDetail: { bash: { command: string } } };
  assert.equal(evt.argumentsDetail.bash.command, text);
});

test("a long compound word under a credential name survives free text", () => {
  // Round 8's repro. These stack consonants (ghtf, rdl, ndst) and fall under
  // a third vowels, which is what a shape heuristic read as "generated".
  const text = "preserve straightforwardly exactly and log misunderstandings";
  const evt = redactPersistedEvent(
    { type: "toolUsed", argumentsDetail: { bash: { command: text } } },
    runtimeSecrets(request({
      user_env: {
        PROJECT_TOKEN: "straightforwardly",
        OTHER_SECRET: "misunderstandings",
        THIRD_TOKEN: "straightforwardness",
      },
    })),
  ) as { argumentsDetail: { bash: { command: string } } };
  assert.equal(evt.argumentsDetail.bash.command, text);
});

test("a non-ASCII word under a credential name survives free text", () => {
  // Round 9's repro end to end. Collected by name, so the value gate is the
  // only thing standing between these words and a hole in the transcript.
  const text = "preserve naïveté and façade during développement, конфигурация";
  const evt = redactPersistedEvent(
    { type: "toolUsed", argumentsDetail: { bash: { command: text } } },
    runtimeSecrets(request({
      user_env: {
        PROJECT_TOKEN: "naïveté",
        OTHER_SECRET: "façade",
        THIRD_TOKEN: "développement",
        FOURTH_KEY: "конфигурация",
      },
    })),
  ) as { argumentsDetail: { bash: { command: string } } };
  assert.equal(evt.argumentsDetail.bash.command, text);
});

test("the field itself is still masked whatever the value looks like", () => {
  // Nothing above weakens the pass that does not guess. Declining to hunt a
  // value in free text is not declining to mask it where it sits, which is
  // the whole reason the free-text gap is an acceptable trade.
  const evt = redactPersistedEvent(
    { type: "toolUsed", argumentsDetail: { values: {
      PLATFORM_KEY: "naïveté", OTHER_SECRET: "конфигурация", PROJECT_TOKEN: "hunter2",
    } } },
    runtimeSecrets(request({ user_env: { PLATFORM_KEY: "naïveté" } })),
  ) as { argumentsDetail: { values: Record<string, string> } };
  assert.deepEqual(evt.argumentsDetail.values, {
    PLATFORM_KEY: "<redacted>", OTHER_SECRET: "<redacted>", PROJECT_TOKEN: "<redacted>",
  });
});
