// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The credential that carries a scope, and what it refuses.
 *
 * The routes it protects can count another owner's shells and terminate
 * another run's processes, so the properties that matter are negative: a proof
 * minted for one pair must not verify as another, and no re-reading of one
 * credential's bytes may yield a second pair.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ABSENT_RUN_SCOPE, mintScopeCredential, scopeBytes, verifyScopeCredential,
} from "../src/index.js";

const SECRET = "sandbox-internal-token";

test("a minted credential verifies back to exactly the scope it was minted for", () => {
  for (const scope of [
    { owner: "sess-1", run: "ktsk_9" },
    { owner: "sess-1", run: null },
    { owner: "dag-root", run: "node-3" },
    { owner: "owner with spaces", run: "run/with/slashes" },
    { owner: "ünïcode-öwner", run: "рун" },
  ]) {
    const verified = verifyScopeCredential(mintScopeCredential(scope, SECRET), SECRET);
    assert.ok(verified.ok, `${scope.owner} did not verify`);
    assert.deepEqual(verified.scope, scope);
  }
});

test("the parts cannot span the separator, so two pairs cannot share one proof", () => {
  // The whole point of encoding before signing. Without it these two pairs
  // would produce the same signed bytes and one proof would authorise both.
  assert.notEqual(scopeBytes({ owner: "a/b", run: "c" }), scopeBytes({ owner: "a", run: "b/c" }));
  const cred = mintScopeCredential({ owner: "a/b", run: "c" }, SECRET);
  const verified = verifyScopeCredential(cred, SECRET);
  assert.ok(verified.ok);
  assert.deepEqual(verified.scope, { owner: "a/b", run: "c" });
});

test("no run identity can spell the absent-run segment", () => {
  // The absent run is a typed absence, not a string a caller could present:
  // the encoding writes `.` only as an escape, so its image never contains one.
  const spelled = mintScopeCredential({ owner: "sess", run: ABSENT_RUN_SCOPE }, SECRET);
  const verified = verifyScopeCredential(spelled, SECRET);
  assert.ok(verified.ok);
  assert.equal(verified.scope.run, ABSENT_RUN_SCOPE, "it round-trips as the string it is");

  const absent = verifyScopeCredential(mintScopeCredential({ owner: "sess", run: null }, SECRET), SECRET);
  assert.ok(absent.ok);
  assert.equal(absent.scope.run, null);
  assert.notEqual(spelled, mintScopeCredential({ owner: "sess", run: null }, SECRET));
});

test("a proof for one scope does not authorise another", () => {
  const mine = mintScopeCredential({ owner: "sess-a", run: "run-a" }, SECRET);
  const proof = mine.slice(mine.lastIndexOf(".") + 1);
  const theirs = `${scopeBytes({ owner: "sess-b", run: "run-b" })}.${proof}`;

  const verified = verifyScopeCredential(theirs, SECRET);
  assert.equal(verified.ok, false);
  assert.equal(verified.ok === false && verified.error, "scope_proof_invalid");
});

test("a credential is refused rather than read from when it proves nothing", () => {
  const cases: Array<[string, string]> = [
    ["", "scope_credential_malformed"],
    ["sess-1", "scope_credential_malformed"],
    [".proof", "scope_credential_malformed"],
    [`sess-1/run-1.${"0".repeat(64)}`, "scope_proof_invalid"],
    // The bare sandbox token, which is what authenticated these routes before
    // the scope moved into the credential.
    [SECRET, "scope_credential_malformed"],
  ];
  for (const [presented, error] of cases) {
    const verified = verifyScopeCredential(presented, SECRET);
    assert.equal(verified.ok, false, `${JSON.stringify(presented)} was accepted`);
    assert.equal(verified.ok === false && verified.error, error, `for ${JSON.stringify(presented)}`);
  }
});

test("a credential minted under a different secret does not verify", () => {
  const cred = mintScopeCredential({ owner: "sess-1", run: "run-1" }, "another-sandbox-token");
  assert.equal(verifyScopeCredential(cred, SECRET).ok, false);
  // An empty secret verifies nothing rather than everything.
  assert.equal(verifyScopeCredential(cred, "").ok, false);
});

test("a scope with more than two parts is refused, not truncated to two", () => {
  const bytes = "a/b/c";
  const forged = `${bytes}.${mintScopeCredential({ owner: "x", run: null }, SECRET)}`;
  assert.equal(verifyScopeCredential(forged, SECRET).ok, false);
});
