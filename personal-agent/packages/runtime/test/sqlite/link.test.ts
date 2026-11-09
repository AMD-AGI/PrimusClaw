// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Account links: a /link code is stored only as a keyed hash, limited per person and for everyone together, single
// use, short lived, and every attempt is reported without the code (Python: test_store.py, test_link_code_hardening.py).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  ATTEMPT_WINDOW_SECONDS,
  CODE_ALPHABET,
  LINK_CODE_TTL_SECONDS,
  MAX_FAILED_ATTEMPTS,
  type LinkLimits,
} from "@primusclaw/personal-agent";
import {
  DEFAULT_LINK_LIMITS,
  Fernet,
  hashLinkCode,
  linkHashKey,
  type SecurityEventFields,
} from "@primusclaw/personal-agent-runtime";

import {
  advanceSeconds,
  openFileTestStore,
  openTestStore,
  type FileTestStore,
  type TestStoreOptions,
} from "../../../../test-support/index.js";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CAROL = "33333333-3333-4333-8333-333333333333";
const MALLORY = "44444444-4444-4444-8444-444444444444";

interface Event {
  readonly event: string;
  readonly fields: SecurityEventFields;
}

/** A store whose security events are recorded. */
function recorded(limits: Partial<LinkLimits> = {}, options: Omit<TestStoreOptions, "securityEvent"> = {}) {
  const events: Event[] = [];
  const opened = openTestStore({
    ...options,
    linkLimits: { ...DEFAULT_LINK_LIMITS, ...limits },
    securityEvent: (event, fields) => events.push({ event, fields }),
  });
  return { ...opened, events };
}

const attempts = (events: readonly Event[]): Event[] => events.filter((e) => e.event === "link_attempt");
const lockouts = (events: readonly Event[]): Event[] => events.filter((e) => e.event === "link_lockout");
const outcomes = (events: readonly Event[]): unknown[] => attempts(events).map((e) => e.fields["outcome"]);

function withFile(fn: (f: FileTestStore) => void, options: Omit<TestStoreOptions, "path"> = {}): void {
  const f = openFileTestStore(options);
  try {
    fn(f);
  } finally {
    f.close();
  }
}

const storedHashes = (f: FileTestStore): string[] =>
  f.raw
    .prepare("SELECT code_hash FROM pending_keys")
    .all()
    .map((r) => String(r["code_hash"]));

test("a code is short, from an unambiguous alphabet, and stored hashed", () => {
  withFile((f) => {
    const code = f.store.links.stashPending("ak-1");
    assert.equal(code.length, 8);
    assert.ok(Array.from(code).every((c) => CODE_ALPHABET.includes(c)));
    assert.ok(!/[01OI]/.test(code));
    assert.deepEqual(storedHashes(f).length, 1);
    assert.notEqual(storedHashes(f)[0], code);
  });
});

test("a code expires after ten minutes and works just before", () => {
  const { store, clock } = openTestStore();
  const late = store.links.stashPending("ak-1");
  advanceSeconds(clock, LINK_CODE_TTL_SECONDS + 1);
  assert.equal(store.links.redeemPending("aad-a", "Alice", late), "invalid");
  assert.equal(store.links.getKey("aad-a"), null);
  const inTime = store.links.stashPending("ak-2");
  advanceSeconds(clock, LINK_CODE_TTL_SECONDS - 1);
  assert.equal(store.links.redeemPending("aad-a", "Alice", inTime), "ok");
});

test("a code is single use: a second redeemer gets nothing", () => {
  const { store } = openTestStore();
  const code = store.links.stashPending("ak-1");
  assert.equal(store.links.redeemPending("aad-a", "Alice", code), "ok");
  assert.equal(store.links.redeemPending("aad-b", "Bob", code), "invalid");
  assert.equal(store.links.getKey("aad-a"), "ak-1");
  assert.equal(store.links.getKey("aad-b"), null);
});

test("the used flag alone blocks reuse, and is reported as used", () => {
  withFile((f) => {
    const events: Event[] = [];
    const store = f.reopen({ securityEvent: (event, fields) => events.push({ event, fields }) });
    const hash = hashLinkCode("USEDC0DE", linkHashKey(f.encryptionKeys[0] ?? ""));
    f.raw.prepare("INSERT INTO pending_keys VALUES (?, x'00', ?, 1)").run(hash, store.now() + 100);
    assert.equal(store.links.redeemPending(ALICE, "Alice", "USEDC0DE"), "invalid");
    assert.equal(store.links.getKey(ALICE), null);
    assert.deepEqual(outcomes(events), ["used"]);
  });
});

test("the code, not the sender, decides whose key is bound", () => {
  const { store } = openTestStore();
  const codeA = store.links.stashPending("ak-alice");
  const codeB = store.links.stashPending("ak-bob");
  assert.equal(store.links.redeemPending("aad-b", "Bob", codeA), "ok");
  assert.equal(store.links.getKey("aad-b"), "ak-alice");
  assert.equal(store.links.getKey("aad-a"), null);
  assert.equal(store.links.redeemPending(BOB, "Bob", codeB), "ok");
  assert.equal(store.links.getKey(ALICE), null);
});

test("no store method makes a code from a chat identity: stashPending takes the key alone", () => {
  const { store } = openTestStore();
  const links = store.links as unknown as Record<string, unknown>;
  for (const name of ["issueCode", "peekCode", "redeemCode"]) assert.equal(Reflect.get(links, name), undefined);
  assert.equal(store.links.stashPending.length, 1);
});

test("wrong codes are limited and block even the right code until the window ends", () => {
  const { store, clock } = openTestStore();
  const code = store.links.stashPending("ak-1");
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
    assert.equal(store.links.redeemPending("aad-a", "Alice", "WRONGWRONG"), "invalid");
  assert.equal(store.links.redeemPending("aad-a", "Alice", code), "limited");
  assert.equal(store.links.redeemPending("aad-b", "Bob", "WRONGWRONG"), "invalid");
  advanceSeconds(clock, ATTEMPT_WINDOW_SECONDS + 1);
  assert.equal(store.links.redeemPending("aad-a", "Alice", store.links.stashPending("ak-2")), "ok");
});

test("expired pending keys are deleted and handed back for revocation", () => {
  withFile((f) => {
    f.store.links.stashPending("ak-old");
    advanceSeconds(f.clock, LINK_CODE_TTL_SECONDS + 1);
    const fresh = f.store.links.stashPending("ak-fresh");
    assert.deepEqual(f.store.links.takeExpiredPending(), ["ak-old"]);
    assert.equal(storedHashes(f).length, 1);
    assert.equal(f.store.links.redeemPending("aad-a", "Alice", fresh), "ok");
  });
});

test("pending and linked keys are encrypted at rest", () => {
  withFile((f) => {
    const code = f.store.links.stashPending("ak-secret-value");
    f.store.links.stashPending("ak-other-secret");
    f.store.links.redeemPending("aad-a", "Alice", code);
    f.raw.exec("PRAGMA wal_checkpoint(FULL)");
    const raw = Buffer.concat(readdirSync(f.dir).map((name) => readFileSync(join(f.dir, name))));
    assert.ok(raw.length > 0);
    assert.ok(!raw.includes("ak-secret-value") && !raw.includes("ak-other-secret"));
  });
});

test("unlink removes the key and the session; a re-link starts a fresh session", () => {
  const { store } = openTestStore();
  store.links.redeemPending("aad-a", "Alice", store.links.stashPending("ak-1"));
  store.sessions.setSession("aad-a", { sessionId: "s1" });
  store.links.redeemPending("aad-a", "Alice", store.links.stashPending("ak-2"));
  assert.equal(store.sessions.getSession("aad-a"), null);
  store.sessions.setSession("aad-a", { sessionId: "s2" });
  store.links.unlink("aad-a");
  assert.equal(store.links.getKey("aad-a"), null);
  assert.equal(store.sessions.getSession("aad-a"), null);
});

test("processed ids", () => {
  const { store } = openTestStore();
  assert.equal(store.idempotency.seen("x"), false);
  store.idempotency.markProcessed("x");
  assert.equal(store.idempotency.seen("x"), true);
});

// --- keyed hash ----------------------------------------------------------------------------------------------------

test("the stored hash is an HMAC under a key derived from the encryption key, not a plain digest", () => {
  withFile((f) => {
    const key = f.encryptionKeys[0] ?? "";
    const code = f.store.links.stashPending("ak-1");
    const [stored] = storedHashes(f);
    assert.notEqual(stored, createHash("sha256").update(code).digest("hex"));
    assert.ok(stored !== undefined && !stored.includes(code));
    assert.equal(stored, hashLinkCode(code, linkHashKey(key)));
    assert.notDeepEqual(linkHashKey(key), new Fernet(key).signingKey);
  });
});

test("a code cannot be found without the server key, and survives a rotation that keeps its key", () => {
  withFile((f) => {
    const code = f.store.links.stashPending("ak-1");
    const other = f.reopen({ encryptionKeys: [Fernet.generateKey()] });
    assert.equal(other.links.redeemPending(ALICE, "Alice", code), "invalid");
    assert.equal(other.links.getKey(ALICE), null);
    const rotated = f.reopen({ encryptionKeys: [Fernet.generateKey(), f.encryptionKeys[0] ?? ""] });
    assert.equal(rotated.links.redeemPending(BOB, "Bob", code), "ok");
    assert.equal(rotated.links.getKey(BOB), "ak-1");
  });
});

test("a code stored by the old plain SHA-256 is void but still revoked", () => {
  withFile((f) => {
    const enc = new Fernet(f.encryptionKeys[0] ?? "").encrypt("ak-legacy");
    f.raw
      .prepare("INSERT INTO pending_keys (code_hash, key_enc, expires_at) VALUES (?, ?, ?)")
      .run(createHash("sha256").update("LEGACY23").digest("hex"), Buffer.from(enc), f.store.now() + 100);
    assert.equal(f.store.links.redeemPending(ALICE, "Alice", "LEGACY23"), "invalid");
    advanceSeconds(f.clock, 101);
    assert.deepEqual(f.store.links.takeExpiredPending(), ["ak-legacy"]);
  });
});

// --- outcomes, as reported ---------------------------------------------------------------------------------------------

test("a used code replayed is refused and reported as wrong", () => {
  const { store, events } = recorded();
  const code = store.links.stashPending("ak-alice");
  assert.equal(store.links.redeemPending(ALICE, "Alice", code, "act-1"), "ok");
  assert.equal(store.links.redeemPending(ALICE, "Alice", code, "act-2"), "invalid");
  assert.deepEqual(outcomes(events), ["success", "wrong"]);
});

test("an expired code is refused and reported as expired", () => {
  const { store, clock, events } = recorded();
  const code = store.links.stashPending("ak-alice");
  advanceSeconds(clock, LINK_CODE_TTL_SECONDS);
  assert.equal(store.links.redeemPending(ALICE, "Alice", code, "act-1"), "invalid");
  assert.equal(store.links.getKey(ALICE), null);
  assert.deepEqual(events, [
    { event: "link_attempt", fields: { aad_object_id: ALICE, activity_id: "act-1", outcome: "expired" } },
  ]);
});

test("two stores on one file racing for one code bind it once", () => {
  withFile((f) => {
    const other = f.reopen();
    for (let round = 0; round < 20; round++) {
      const code = f.store.links.stashPending(`ak-${String(round)}`);
      const [first, second] = round % 2 === 0 ? [f.store, other] : [other, f.store];
      const [a, b] = [`a-${String(round)}`, `b-${String(round)}`];
      assert.deepEqual(
        [first.links.redeemPending(a, "A", code), second.links.redeemPending(b, "B", code)],
        ["ok", "invalid"],
      );
      assert.deepEqual(
        [a, b].filter((who) => f.store.links.getKey(who) === `ak-${String(round)}`),
        [a],
      );
    }
  });
});

test("a code redeemed by A cannot be redeemed by B; a code binds only its own key to its redeemer", () => {
  const { store } = openTestStore();
  store.links.stashPending("ak-other");
  const code = store.links.stashPending("ak-alice");
  assert.equal(store.links.redeemPending(ALICE, "Alice", code), "ok");
  assert.equal(store.links.redeemPending(BOB, "Bob", code), "invalid");
  assert.equal(store.links.getKey(BOB), null);
  assert.equal(store.links.getKey(ALICE), "ak-alice");
});

// --- limits ------------------------------------------------------------------------------------------------------------

test("guessing locks the person out and reports one lockout", () => {
  const { store, events } = recorded();
  const code = store.links.stashPending("ak-alice");
  for (let i = 0; i < 5; i++)
    assert.equal(store.links.redeemPending(MALLORY, "Mallory", "WRONG222", `g${String(i)}`), "invalid");
  assert.equal(store.links.redeemPending(MALLORY, "Mallory", code, "g5"), "limited");
  assert.equal(store.links.getKey(MALLORY), null);
  assert.deepEqual(outcomes(events), [...Array<string>(5).fill("wrong"), "locked"]);
  assert.deepEqual(lockouts(events), [
    {
      event: "link_lockout",
      fields: { aad_object_id: MALLORY, activity_id: "g4", scope: "user", count: 5, limit: 5, window_seconds: 600 },
    },
  ]);
});

test("a success does not reset the person's wrong codes", () => {
  const { store } = openTestStore();
  for (let i = 0; i < 4; i++) store.links.redeemPending(MALLORY, "Mallory", "WRONG222");
  assert.equal(store.links.redeemPending(MALLORY, "Mallory", store.links.stashPending("ak-mallory")), "ok");
  const victim = store.links.stashPending("ak-victim");
  assert.equal(store.links.redeemPending(MALLORY, "Mallory", "WRONG333"), "invalid");
  assert.equal(store.links.redeemPending(MALLORY, "Mallory", victim), "limited");
});

test("the global limit refuses everyone and reports the global lockout", () => {
  const { store, clock, events } = recorded({ perUser: 5, global: 3, windowSeconds: 600 });
  for (const who of [ALICE, BOB, MALLORY]) assert.equal(store.links.redeemPending(who, "x", "WRONG222"), "invalid");
  const code = store.links.stashPending("ak-carol");
  assert.equal(store.links.redeemPending(CAROL, "Carol", code, "c1"), "global_limit");
  assert.equal(store.links.getKey(CAROL), null);
  const [lockout, ...more] = lockouts(events);
  assert.equal(more.length, 0);
  assert.deepEqual([lockout?.fields["scope"], lockout?.fields["count"], lockout?.fields["limit"]], ["global", 3, 3]);
  assert.deepEqual(attempts(events).at(-1), {
    event: "link_attempt",
    fields: { aad_object_id: CAROL, activity_id: "c1", outcome: "global_limit" },
  });
  advanceSeconds(clock, 601);
  assert.equal(store.links.redeemPending(CAROL, "Carol", store.links.stashPending("ak-carol")), "ok");
});

test("with the default limits, many accounts guessing report every user lockout and then the global one", () => {
  const { store, events } = recorded();
  const accounts = Array.from(
    { length: 20 },
    (_, i) => `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
  );
  for (const who of accounts) {
    for (let n = 0; n < 5; n++)
      assert.equal(store.links.redeemPending(who, "x", "WRONG222", `g${String(n)}`), "invalid");
  }
  assert.equal(store.links.redeemPending(CAROL, "Carol", store.links.stashPending("ak-carol")), "global_limit");
  const all = lockouts(events);
  assert.deepEqual(
    all.map((e) => e.fields["scope"]),
    [...Array<string>(20).fill("user"), "global"],
  );
  assert.deepEqual(all.at(-1)?.fields, {
    aad_object_id: accounts.at(-1),
    activity_id: "g4",
    scope: "global",
    count: 100,
    limit: 100,
    window_seconds: 600,
  });
});

test("refused attempts do not extend a lockout", () => {
  const { store, clock } = openTestStore({ linkLimits: { perUser: 2, global: 100, windowSeconds: 600 } });
  for (let i = 0; i < 2; i++) store.links.redeemPending(MALLORY, "Mallory", "WRONG222");
  advanceSeconds(clock, 300);
  for (let i = 0; i < 10; i++) assert.equal(store.links.redeemPending(MALLORY, "Mallory", "WRONG222"), "limited");
  advanceSeconds(clock, 301);
  assert.equal(store.links.redeemPending(MALLORY, "Mallory", store.links.stashPending("ak-m")), "ok");
});

test("wrong codes from several stores on one file cannot overrun the limit", () => {
  withFile(
    (f) => {
      const stores = [f.store, f.reopen(), f.reopen(), f.reopen()];
      for (let i = 0; i < 16; i++) stores[i % stores.length]?.links.redeemPending(MALLORY, "Mallory", "WRONG222");
      assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM link_attempts").get()?.["n"], 5);
    },
    { linkLimits: { perUser: 5, global: 1000, windowSeconds: 600 } },
  );
});

test("no reported event carries the code (in any case or spacing) or the key", () => {
  const { store, clock, events } = recorded({ perUser: 2, global: 5, windowSeconds: 600 });
  const good = store.links.stashPending("ak-secret-alice");
  const expired = store.links.stashPending("ak-secret-expired");
  advanceSeconds(clock, LINK_CODE_TTL_SECONDS - 1);
  const late = store.links.stashPending("ak-secret-late");
  store.links.redeemPending(ALICE, "Alice", Array.from(good.toLowerCase()).join(" "), "a1"); // success, typed spaced and lower case
  store.links.redeemPending(BOB, "Bob", good, "b1"); // used
  advanceSeconds(clock, 2);
  store.links.redeemPending(BOB, "Bob", expired, "b2"); // expired
  store.links.redeemPending(CAROL, "Carol", "WRONG222", "c1"); // wrong
  store.links.redeemPending(CAROL, "Carol", "WRONG333", "c2"); // wrong, user lockout
  store.links.redeemPending(CAROL, "Carol", late, "c3"); // locked
  store.links.redeemPending(MALLORY, "Mallory", "WRONG444", "m1"); // wrong, global lockout
  store.links.redeemPending(MALLORY, "Mallory", late, "m2"); // global_limit
  assert.deepEqual(new Set(outcomes(events)), new Set(["success", "wrong", "expired", "locked", "global_limit"]));
  assert.deepEqual(new Set(lockouts(events).map((e) => e.fields["scope"])), new Set(["user", "global"]));
  const text = JSON.stringify(events);
  for (const code of [good, expired, late, "WRONG222", "WRONG333", "WRONG444"]) {
    assert.ok(
      !text.includes(code) &&
        !text.includes(code.toLowerCase()) &&
        !text.includes(Array.from(code.toLowerCase()).join(" ")),
    );
  }
  assert.ok(!text.includes("ak-secret"));
});

test("the configured link limits are the store's (window and per-person count)", () => {
  const { store } = openTestStore({ linkLimits: { perUser: 2, global: 50, windowSeconds: 900 } });
  assert.equal(store.links.linkWindowSeconds, 900);
  for (let i = 0; i < 2; i++) assert.equal(store.links.redeemPending(MALLORY, "Mallory", "WRONG222"), "invalid");
  assert.equal(store.links.redeemPending(MALLORY, "Mallory", "WRONG222"), "limited");
});

test("the default link limits are 5 per person, 100 for everyone, in 600 seconds", () => {
  assert.deepEqual(DEFAULT_LINK_LIMITS, { perUser: 5, global: 100, windowSeconds: 600 });
  assert.equal(openTestStore().store.links.linkWindowSeconds, 600);
});

test("a link records its Claw user, found back from either side", () => {
  const { store } = openTestStore();
  const links = store.links;
  assert.equal(links.needsClawUserId("aad-a"), false); // not linked: nothing to fill in
  links.redeemPending("aad-b", "Bob", links.stashPending("ak-b"));
  links.redeemPending("aad-a", "Alice", links.stashPending("ak-a"));
  assert.equal(links.needsClawUserId("aad-a"), true);
  assert.equal(links.clawUserIdOf("aad-a"), null);
  links.setClawUserId("aad-a", "u-1");
  links.setClawUserId("aad-b", "u-1");
  assert.equal(links.needsClawUserId("aad-a"), false);
  assert.equal(links.clawUserIdOf("aad-a"), "u-1");
  assert.deepEqual(links.linkedUsers(), ["aad-a", "aad-b"]);
  assert.ok(["aad-a", "aad-b"].includes(links.userForClawUser("u-1") ?? ""));
  assert.equal(links.userForClawUser("u-9"), null);
  assert.deepEqual(new Set(links.usersForClawUser("u-1")), new Set(["aad-a", "aad-b"]));
  assert.equal(links.getKey("aad-a"), "ak-a");
});
