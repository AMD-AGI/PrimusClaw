// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
// The PublicErrors interface module declares types only; loading it is what the coverage of `--all` counts.
import "../../src/public-error/public-errors.js";
import {
  PublicErrorLog,
  SCAN_MAX,
  looksInternal,
  looksLikeFailure,
  looksLikeServiceError,
  newRef,
  splitErrorTail,
  type LogFields,
  type Logger,
} from "../../src/index.js";
import { SeededRandom } from "../../../../test-support/index.js";

const HOST = "litellm-proxy.primus-safe.svc.cluster.local";
const IP = "10.42.7.19";
const PATH = "/opt/claw/brain/runner.py";
// Brain's text for a failed model call, as measured: the status, the gateway's JSON, LiteLLM's router lines.
const BRAIN_ERROR =
  `API Error: 502 {"error":{"message":"upstream connect error to http://${HOST}:4000/v1/chat/completions ` +
  `(${IP}:4000): connection refused","type":"None","param":"None","code":"502"}}\n` +
  "No fallback model group found for original model_group=claude-sonnet-5.5. Fallbacks=[]";
const STACK =
  `Traceback (most recent call last):\n  File "${PATH}", line 88, in run\n    raise ConnectionError(...)\n` +
  `ConnectionError: cannot reach ${HOST}:4000 (${IP})`;
const UNSHAPED = `upstream failed at http://${HOST}:4000 (${IP})`; // an error that does not begin with a status
const RESET = `dial tcp redis:6379 (${IP}): connection reset by peer`;
const MODEL_FIX =
  "Here is the fix for your parser:\n\n```python\ndef load(cfg):\n    return {k: v for k, v in cfg.items()}\n```\n\n" +
  "It reads /etc/app/config.yaml as before.";
const PUBLIC_LINK_NOTE =
  "CI status: the lint job failed on https://github.com/example-org/example-repo/pull/5, fixing it now.";
const LONG_UNSHAPED =
  "upstream failed at http://brain-gateway.prod:8080/v1/chat/completions: " + "gateway response detail ".repeat(30);

/** A logger that keeps each line as `message key=value ...`, the way a line logger writes it. */
function capture() {
  const lines: string[] = [];
  const make = (bound: LogFields): Logger => {
    const at = (message: string, fields: LogFields = {}): void => {
      const all = Object.entries({ ...bound, ...fields }).map(([k, v]) => ` ${k}=${String(v)}`);
      lines.push(message + all.join(""));
    };
    return { debug: at, info: at, warn: at, error: at, child: (fields) => make({ ...bound, ...fields }) };
  };
  return { lines, errors: new PublicErrorLog(make({}), new SeededRandom(7)) };
}

describe("looksInternal", () => {
  it("recognises internal shapes", () => {
    for (const text of [
      `http://${HOST}/x`,
      IP,
      "fe80::1%eth0",
      "[2001:db8::7]:443",
      HOST,
      "claw-api.primus.svc",
      "redis.internal",
      "api.example.com",
      "db-0.cluster:5432",
      PATH,
      "C:\\Users\\svc\\app.log",
      STACK,
      'File "x.py", line 3',
      "KeyError: 'model'",
      '{"error": "x"}',
      "localhost refused",
      "x".repeat(SCAN_MAX + 1),
      "dial tcp redis:6379: connection refused",
      "connection to brain-gateway.prod failed",
      "gateway.prod refused the call",
      "connection to brain-gateway failed",
      "connection refused by primus-brain",
      "Claw-API timed out",
      "litellm_proxy unavailable",
      "brain_gateway",
      "redis_service down",
      "primus_brain_v2",
    ]) {
      assert.equal(looksInternal(text), true, text);
    }
  });

  it("does not take plain reasons for internal ones", () => {
    for (const text of [
      "the connector was revoked",
      "session_live",
      "cwd is outside the allowed roots",
      "model gateway returned 502",
      "github_rate_limited",
      "Base branch was modified",
      "12:30",
      "",
      "Running test-user.py failed",
      "a one-off check",
      "connector_offline",
      "invalid_api_key",
      "agent_not_found",
      "session_limit_reached",
    ]) {
      assert.equal(looksInternal(text), false, text);
    }
    assert.equal(looksInternal(42), false);
  });
});

describe("looksLikeFailure", () => {
  it("shows the model's narration of a snake_case identifier that failed", () => {
    for (const text of ["test_api failed; fixing the fixture now.", "run_worker raised an error, looking at it."]) {
      assert.equal(looksLikeFailure(text), false, text);
    }
  });

  it("shows narration that names a host without a failure", () => {
    assert.equal(looksLikeFailure(`Checking ${HOST} next.`), false);
  });

  it("shows narration about a failure without an address", () => {
    for (const text of [
      "The test fails with KeyError in parse(); I'll fix it next.",
      "Checking /etc/hosts for errors now.",
      'The response was {"status": "failed"}, so I will retry.',
    ]) {
      assert.equal(looksLikeFailure(text), false, text);
    }
  });

  it("shows narration that cites a public link with failure words", () => {
    for (const text of [
      PUBLIC_LINK_NOTE,
      "Let me check the CI status of https://github.com/example-org/example-repo/pull/5.",
      "Fixed the 404 handler; the PR is at https://github.com/example-org/example-repo/pull/7.",
    ]) {
      assert.equal(looksLikeFailure(text), false, text);
    }
  });

  it("still takes a public lookalike, or a public link beside an internal name, for a failure", () => {
    for (const text of [
      "request to https://github.com.corp.internal/x failed",
      "error at https://api.github.com:8443/x failed",
      "error at https://svc:pw@github.com/x failed",
      "https://github.com/o/r is fine but brain-gateway refused the connection",
    ]) {
      assert.equal(looksLikeFailure(text), true, text);
    }
  });

  it("knows Brain's error and a stack trace", () => {
    assert.equal(looksLikeServiceError(BRAIN_ERROR), true);
    assert.equal(looksLikeServiceError(STACK), true);
    assert.equal(looksLikeServiceError("  litellm.InternalServerError: 500"), true);
    assert.equal(looksLikeServiceError("ValueError: x"), true);
    assert.equal(looksLikeServiceError("All good."), false);
    assert.equal(looksLikeFailure(RESET), true);
    assert.equal(looksLikeFailure(null), false);
  });
});

describe("splitErrorTail", () => {
  it("cuts off only Brain's error", () => {
    const cases: ReadonlyArray<readonly [string, string, string, string]> = [
      ["code", MODEL_FIX, MODEL_FIX, ""],
      ["tail", `Words.\n\n${BRAIN_ERROR}`, "Words.", BRAIN_ERROR],
      [
        "split-error",
        `Words.\n\nAPI Error: 500 {}\n\nNo fallback model group for ${HOST}`,
        "Words.",
        `API Error: 500 {}\n\nNo fallback model group for ${HOST}`,
      ],
      ["error-only", RESET, "", RESET],
      ["unshaped-tail", `Done with the change.\n\n${UNSHAPED}`, "Done with the change.", UNSHAPED],
      ["fenced", `\`\`\`\n\n${UNSHAPED}\n\`\`\``, `\`\`\`\n\n${UNSHAPED}\n\`\`\``, ""],
      ["plain-failure", "The test fails with KeyError in parse().", "The test fails with KeyError in parse().", ""],
      ["model-names-a-class", "ValueError: Set timeout=5 to retry.", "ValueError: Set timeout=5 to retry.", ""],
      [
        "dotted-class",
        "Edited it.\n\nlitellm.InternalServerError: boom",
        "Edited it.",
        "litellm.InternalServerError: boom",
      ],
      ["long-unshaped", LONG_UNSHAPED, "", LONG_UNSHAPED.trim()],
      [
        "fenced-brain-error-last",
        `Here is what it printed:\n\n\`\`\`\n${BRAIN_ERROR}\n\`\`\``,
        `Here is what it printed:\n\n\`\`\`\n${BRAIN_ERROR}\n\`\`\``,
        "",
      ],
      [
        "fenced-brain-error-middle",
        "Words.\n\nAPI Error: 500 is what the proxy returns here:\n```\n{}\n```\n\nDone.",
        "Words.\n\nAPI Error: 500 is what the proxy returns here:\n```\n{}\n```\n\nDone.",
        "",
      ],
      ["public-link", `Pushed the fix.\n\n${PUBLIC_LINK_NOTE}`, `Pushed the fix.\n\n${PUBLIC_LINK_NOTE}`, ""],
    ];
    for (const [id, text, kept, tail] of cases) {
      assert.deepEqual(splitErrorTail(text), { kept, tail }, id);
    }
    assert.deepEqual(splitErrorTail("  \n "), { kept: "", tail: "" });
    assert.deepEqual(splitErrorTail(undefined), { kept: "", tail: "" });
    assert.deepEqual(splitErrorTail("a\r\n\r\nAPI Error: 500 x"), { kept: "a", tail: "API Error: 500 x" });
  });
});

describe("withhold", () => {
  it("masks credentials in the logged detail", () => {
    const { lines, errors } = capture();
    const shaped = "ghp_" + "A".repeat(36); // a fake value in a GitHub token's shape
    const ref = errors.withhold("test", `Authorization failed for ${shaped} at ${HOST}`);
    const line = lines.find((l) => l.includes(`ref=${ref}`)) ?? assert.fail("no line");
    assert.ok(!line.includes(shaped) && line.includes(HOST));
    assert.match(ref, /^[0-9a-f]{8}$/);
  });

  it("masks a password in a URL's user info", () => {
    const { lines, errors } = capture();
    const ref = errors.withhold("test", `connect to http://svc:SuperSecretPassword123@${HOST}:8443/x failed`);
    const line = lines.find((l) => l.includes(`ref=${ref}`)) ?? assert.fail("no line");
    assert.ok(!line.includes("SuperSecretPassword123") && line.includes(HOST));
    assert.ok(line.includes("http://[hidden]@"));
  });

  it("writes one line whatever the ids hold", () => {
    const { lines, errors } = capture();
    const ref = errors.withhold("test", "a\nb", { session: "s1\nuser-facing error ref=forged", empty: "", none: null });
    const line = lines.find((l) => l.includes(`ref=${ref}`)) ?? assert.fail("no line");
    assert.ok(!line.includes("\n") && !line.includes("\r"));
    assert.ok(line.includes("detail=a b") && !line.includes("empty=") && !line.includes("none="));
  });

  it("clips a long detail and reads an error's message", () => {
    const { lines, errors } = capture();
    errors.withhold("test", "x".repeat(600));
    errors.withhold("test", new Error("boom"));
    errors.withhold("test", { a: 1 });
    errors.withhold("test", 7);
    errors.withhold("test");
    assert.ok(lines[0]?.endsWith(`detail=${"x".repeat(500)}…`));
    assert.ok(lines[1]?.endsWith("detail=boom"));
    assert.ok(lines[2]?.endsWith('detail={"a":1}'));
    assert.ok(lines[3]?.endsWith("detail=7"));
    assert.ok(lines[4]?.endsWith("detail="));
  });

  it("makes a reference of eight hex characters from the injected randomness", () => {
    assert.equal(newRef(new SeededRandom(1)), newRef(new SeededRandom(1)));
    assert.match(newRef(new SeededRandom(2)), /^[0-9a-f]{8}$/);
  });
});

describe("publicReason", () => {
  it("shows a plain reason, and only a reference for an internal one", () => {
    const { lines, errors } = capture();
    assert.equal(errors.publicReason("the connector was revoked", "remote_agent"), "the connector was revoked");
    assert.equal(errors.publicReason("", "remote_agent"), "");
    assert.equal(errors.publicReason("   ", "remote_agent"), "");
    assert.equal(errors.publicReason(null, "remote_agent"), "");
    const shown = errors.publicReason(`dial tcp ${IP}:4000 refused`, "remote_agent", { session_id: "s1" });
    const ref = /^an internal error \(ref ([0-9a-f]{8})\)$/.exec(shown)?.[1] ?? assert.fail(shown);
    const line = lines.find((l) => l.includes(`ref=${ref}`)) ?? assert.fail("no line");
    assert.ok(line.includes("where=remote_agent") && line.includes("session_id=s1") && line.includes(IP));
    assert.match(errors.publicReason("API Error: 502 bad", "turn"), /^an internal error \(ref [0-9a-f]{8}\)$/);
  });
});
