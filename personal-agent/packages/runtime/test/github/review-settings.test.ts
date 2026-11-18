// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The model reviews run on is the deployment's PERSONAL_AGENT_REVIEW_MODEL, with no built-in default (`test_review_model_default`). */
import assert from "node:assert/strict";
import { test } from "node:test";

import { readSettings, type Env } from "../../src/index.js";

/** What every deployment sets, and the chat model. */
const BASE: Env = {
  TEAMS_ENCRYPTION_KEYS: "k",
  CLAW_API_URL: "https://claw.example.com/claw-api/",
  SAFE_API_URL: "https://safe.example.com",
  PUBLIC_BASE_URL: "https://claw.example.com/",
  PERSONAL_AGENT_MODEL: "claude-sonnet-5.5",
};

test("the setting has no default and can be set", () => {
  const unset = readSettings({ ...BASE });
  assert.equal(unset.models.review, ""); // unset: reviews run on PERSONAL_AGENT_MODEL
  const set = readSettings({ ...BASE, PERSONAL_AGENT_REVIEW_MODEL: " gpt-6-luna " });
  assert.equal(set.models.review, "gpt-6-luna");
  assert.equal(set.models.chat, "claude-sonnet-5.5");
});
