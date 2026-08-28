// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the NATS subject builders.
 *
 * Isolation between environments comes from NATS accounts, not from subject
 * prefixes, so these builders are intentionally thin. What still matters is
 * that each session's subjects stay in their own namespace and that the four
 * channels never collide.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  taskSubject,
  eventSubject,
  interruptSubject,
  cleanupSubject,
} from "../src/subjects.js";

const SESSION = "9f8c1a2b-0000-4000-8000-000000000001";

test("taskSubject: is a fixed shared work queue subject", () => {
  assert.equal(taskSubject(), "tasks.execute");
});

test("per-session builders namespace by session id", () => {
  assert.equal(eventSubject(SESSION), `events.${SESSION}`);
  assert.equal(interruptSubject(SESSION), `interrupt.${SESSION}`);
  assert.equal(cleanupSubject(SESSION), `cleanup.${SESSION}`);
});

test("the four channels never collide for the same session", () => {
  const subjects = [
    taskSubject(),
    eventSubject(SESSION),
    interruptSubject(SESSION),
    cleanupSubject(SESSION),
  ];
  assert.equal(new Set(subjects).size, subjects.length);
});

test("different sessions never share a subject", () => {
  const other = "9f8c1a2b-0000-4000-8000-000000000002";
  for (const build of [eventSubject, interruptSubject, cleanupSubject]) {
    assert.notEqual(build(SESSION), build(other));
  }
});

test("subjects are single-token under their prefix for UUID session ids", () => {
  // A NATS subscriber filters on `events.<id>`; the id must not introduce extra
  // tokens or wildcards. UUIDs (the only session id format Claw generates)
  // contain no `.`, `*` or `>`, so each subject stays exactly two tokens.
  for (const build of [eventSubject, interruptSubject, cleanupSubject]) {
    const tokens = build(SESSION).split(".");
    assert.equal(tokens.length, 2);
    assert.ok(!/[*>\s]/.test(tokens[1]));
  }
});

test("builders are pure — repeated calls are stable", () => {
  assert.equal(eventSubject(SESSION), eventSubject(SESSION));
  assert.equal(taskSubject(), taskSubject());
});
