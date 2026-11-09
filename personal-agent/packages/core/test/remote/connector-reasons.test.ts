// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A connector's refusal codes are told as what happened and what to do, never as the bare code (`remote/connector/reasons.ts`).
import assert from "node:assert/strict";
import { describe as group, test } from "node:test";

import {
  OLD_CONNECTOR,
  SANDBOX,
  UPGRADE,
  describe,
  ended,
  explain,
  knownReasons,
} from "../../src/remote/connector/reasons.js";
import { setupFrom } from "../../src/remote/connector/setup.js";

// The closed set, from connector/src: every `SessionRefusal("...")`, `refuse("...")`, `rejectCommand(..., "...")`, `close("...")` /
// `killAll("...")`, the cwd verdicts of roots.ts, attach.ts's reasons, and the `error` a failed turn_end carries. A code the
// connector gains must be added here and to `REASON_TEXTS`.
const CONNECTOR_CODES = [
  // session.ts
  "mode_unavailable",
  "mode_not_enforced",
  "mode_not_confirmed",
  "mode_mismatch",
  "mode_not_allowed",
  "adapter_gone",
  "adapter_start_failed",
  "adapter_protocol",
  "adapter_cannot_resume",
  "adapter_error",
  "agent_auth_required",
  "attach_unavailable",
  "session_live",
  "session_closed",
  "set_mode_failed",
  "too_many_queued_prompts",
  "cancelled",
  "adapter_unavailable",
  // manager.ts
  "unknown_session",
  "unknown_agent",
  "resume_not_supported",
  "too_many_sessions",
  "resume_ref_required",
  "invalid_resume_ref",
  "already_attached",
  "cwd_mismatch",
  "text_required",
  "mode_id_required",
  "action_and_option_required",
  "closed",
  // roots.ts
  "invalid_cwd",
  "cwd_not_absolute",
  "cwd_not_found",
  "cwd_not_directory",
  "cwd_outside_roots",
  // attach.ts
  "recently_written",
  "twin_check_failed",
  "catalog_unavailable",
  // attach.ts endHolders (a takeover the person confirmed)
  "session_live_elsewhere",
  "takeover_not_permitted",
  "takeover_failed",
  "terminal_did_not_exit",
  // session.ts typing into a terminal that has the conversation open (terminal-input.ts)
  "terminal_busy",
  "terminal_gone",
  "terminal_switched",
  "terminal_input_failed",
  "terminal_input_unconfirmed",
  "terminal_input_unavailable",
  "terminal_session",
  "empty_prompt",
  "terminal_mode_not_allowed",
  "terminal_mode_unknown",
  "terminal_command_refused",
  "takeover_expired",
  "terminal_screen_unknown",
  // roots.ts (a folder named by its base name; a root whose disk does not answer)
  "cwd_ambiguous",
  "root_unavailable",
  // connector.ts (killAll)
  "revoked",
  "stopped",
  "paused",
  // permissions.ts (a decision refused)
  "unknown_action",
  "option_not_offered",
];

// The codes Claw itself writes (`data.by = "claw"`): a command never collected, and a session closed with its connector's row.
const CLAW_CODES = [
  "not_delivered",
  "delivery_unconfirmed",
  "connector_revoked",
  "machine_reconnected",
];

const HAN = /[一-鿿]/u;
const isAscii = (text: string): boolean =>
  [...text].every((ch) => ch.charCodeAt(0) < 0x80);
const UPGRADE_LINE =
  "npm install -g @primusclaw/connector@latest && claw-connector stop && claw-connector service install";

test("the closed set is all known", () => {
  const known = new Set(knownReasons());
  assert.deepEqual(
    CONNECTOR_CODES.filter((c) => !known.has(c)),
    [],
  );
  assert.deepEqual(
    CLAW_CODES.filter((c) => !known.has(c)),
    [],
  );
});

group("every code is said in words not as the code", () => {
  for (const code of [...CONNECTOR_CODES, ...CLAW_CODES]) {
    for (const lang of ["zh", "en", null] as const) {
      test(`${code} in ${lang ?? "both"}`, () => {
        const text = describe(code, lang);
        assert.ok(text && text !== `${code}.` && text.length >= 6, text);
        // (a plain word such as "closed" may be part of the sentence; a code with an underscore never is)
        if (code.includes("_")) assert.ok(!text.includes(code), text);
        const [zh, en] = explain(code);
        assert.ok(HAN.test(zh) && isAscii(en) && zh !== en);
        if (lang === "zh") assert.equal(text, zh);
        else if (lang === "en") assert.equal(text, en);
        else assert.equal(text, `${zh}\n${en}`); // (no language known: both)
      });
    }
  }
});

group(
  "an old or unknown connector is told to upgrade and how to get by",
  () => {
    for (const code of [...OLD_CONNECTOR].sort()) {
      for (const version of [null, "", "0.1.3", "0.1.4", "v0.1.4", "garbage"]) {
        test(`${code} at ${JSON.stringify(version)}`, () => {
          for (const [lang, upgrade, sandbox] of [
            ["zh", UPGRADE[0], SANDBOX[0]],
            ["en", UPGRADE[1], SANDBOX[1]],
          ] as const) {
            const text = describe(code, lang, version);
            assert.ok(text.includes(upgrade) && text.includes(sandbox));
            assert.ok(text.includes(UPGRADE_LINE));
            assert.ok(text.includes('env = { IS_SANDBOX = "1" }'));
          }
        });
      }
    }
  },
);

group("a fixed connector is not told to upgrade", () => {
  for (const version of ["0.1.5", "0.1.10", "0.2.0", "1.0.0", "0.1.5-rc.1"]) {
    test(version, () => {
      for (const code of OLD_CONNECTOR) {
        const text = describe(code, "en", version);
        assert.ok(
          !text.includes("npm install") &&
            !text.includes("IS_SANDBOX") &&
            text.includes("claw-connector status"),
        );
      }
    });
  }
});

test("an unknown code gets a generic sentence that names it and words stay as they are", () => {
  assert.ok(describe("brand_new_reason", "en").includes("(brand_new_reason)"));
  assert.ok(
    describe("brand_new_reason", "zh").includes("（brand_new_reason）"),
  );
  assert.equal(
    describe("the connector was revoked", "en"),
    "the connector was revoked.",
  );
  assert.equal(describe("", "en"), "");
  assert.equal(describe(null, "zh"), "");
});

test("ended puts the lead first in the language", () => {
  assert.ok(
    ended(
      ["会话没能启动", "The session could not start"],
      "too_many_sessions",
      "en",
    ).startsWith("The session could not start: Too many sessions"),
  );
  assert.ok(
    ended(
      ["会话没能启动", "The session could not start"],
      "too_many_sessions",
      "zh",
    ).startsWith("会话没能启动："),
  );
  assert.equal(
    ended(["会话已结束", "The session ended"], "", "en"),
    "The session ended.",
  );
  const both = ended(["会话已结束", "The session ended"], "adapter_gone", null);
  assert.ok(
    both.startsWith("会话已结束：") && both.includes("\nThe session ended: "),
  );
});

test("a revoked connector is given the whole login command", () => {
  // (the address this worker reaches Claw at: what a deployment sets as CLAW_API_URL)
  const setup = setupFrom(null, "https://claw.example.com/claw-api");
  for (const lang of ["zh", "en"] as const) {
    const text = describe("revoked", lang, null, setup);
    assert.ok(
      text.includes(
        "claw-connector login --server https://claw.example.com/claw-api --identity-url https://claw.example.com",
      ),
      text,
    );
  }
});
