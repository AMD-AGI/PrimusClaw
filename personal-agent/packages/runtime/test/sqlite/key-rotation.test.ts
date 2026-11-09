// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Key rotation: `reencrypt` moves every stored secret to the first key of TEAMS_ENCRYPTION_KEYS, so an older key can be
// removed without losing a linked key, a pending key or a notification secret (Python: test_key_rotation.py).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { LINK_CODE_TTL_SECONDS, type LogFields, type Logger } from "@primusclaw/personal-agent";
import {
  ENCRYPTED_COLUMNS,
  Fernet,
  InvalidToken,
  MultiFernet,
  openWorkerStore,
  type SqliteStore,
} from "@primusclaw/personal-agent-runtime";

import { advanceSeconds, openFileTestStore, type FileTestStore } from "../../../../test-support/index.js";

function seed(f: FileTestStore): void {
  const { links, notifySubs } = f.store;
  assert.equal(links.redeemPending("aad-alice", "Alice", links.stashPending("ak-alice-linked")), "ok");
  links.stashPending("ak-bob-pending");
  notifySubs.saveNotifySub("aad-alice", { route: "route-alice", subscriptionId: "sub-1", secret: "whsec-alice" });
}

/** Every stored token, by (table, row key). */
function raw(f: FileTestStore): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const [table, key, column] of ENCRYPTED_COLUMNS) {
    for (const row of f.raw.prepare(`SELECT ${key} AS k, ${column} AS v FROM ${table}`).all()) {
      out.set(`${table}/${String(row["k"])}`, Buffer.from(row["v"] as Uint8Array));
    }
  }
  return out;
}

/** What the worker reads back: the linked key, the notification secret and (once expired) the pending key. */
function readable(store: SqliteStore, f: FileTestStore): [string | null, unknown, string[]] {
  const linked = store.links.getKey("aad-alice");
  const secret = store.notifySubs.notifySubByRoute("route-alice");
  advanceSeconds(f.clock, LINK_CODE_TTL_SECONDS + 1);
  return [linked, secret, store.links.takeExpiredPending()];
}

const ALL_BACK: [string, unknown, string[]] = [
  "ak-alice-linked",
  { userId: "aad-alice", secret: "whsec-alice" },
  ["ak-bob-pending"],
];

function withSeeded(fn: (f: FileTestStore, keys: { old: string; fresh: string }) => void): void {
  const old = Fernet.generateKey();
  const fresh = Fernet.generateKey();
  const f = openFileTestStore({ encryptionKeys: [old] });
  try {
    seed(f);
    fn(f, { old, fresh });
  } finally {
    f.close();
  }
}

test("every Fernet column of the schema is listed for re-encryption", () => {
  const schema = readFileSync(new URL("../../src/sqlite/schema.sql", import.meta.url), "utf8");
  const columns = new Set([...schema.matchAll(/(\w+_enc) BLOB/g)].map((m) => m[1]));
  assert.deepEqual(columns, new Set(ENCRYPTED_COLUMNS.map(([, , column]) => column)));
});

test("after reencrypt the old key can be removed", () => {
  withSeeded((f, { old, fresh }) => {
    const rotating = f.reopen({ encryptionKeys: [fresh, old] });
    assert.equal(rotating.links.getKey("aad-alice"), "ak-alice-linked");
    assert.deepEqual(rotating.reencrypt(), { rotated: 3, current: 0, undecryptable: 0 });
    assert.equal(rotating.links.getKey("aad-alice"), "ak-alice-linked");
    for (const token of raw(f).values()) {
      new Fernet(fresh).decrypt(token);
      assert.throws(() => new Fernet(old).decrypt(token), InvalidToken);
    }
    assert.deepEqual(readable(f.reopen({ encryptionKeys: [fresh] }), f), ALL_BACK);
  });
});

test("without reencrypt, removing the old key loses the secrets", () => {
  withSeeded((f, { old, fresh }) => {
    f.reopen({ encryptionKeys: [fresh, old] }); // opened with the new key first, never re-encrypted
    assert.deepEqual(readable(f.reopen({ encryptionKeys: [fresh] }), f), [null, null, []]);
  });
});

test("a second run changes nothing, not even to a fresh ciphertext", () => {
  withSeeded((f, { old, fresh }) => {
    const store = f.reopen({ encryptionKeys: [fresh, old] });
    store.reencrypt();
    const before = raw(f);
    assert.deepEqual(store.reencrypt(), { rotated: 0, current: 3, undecryptable: 0 });
    assert.deepEqual(raw(f), before);
    assert.equal(f.reopen({ encryptionKeys: [fresh] }).links.getKey("aad-alice"), "ak-alice-linked");
  });
});

test("an interrupted run is finished by the next", (t) => {
  withSeeded((f, { old, fresh }) => {
    const store = f.reopen({ encryptionKeys: [fresh, old] });
    let calls = 0;
    const real: (this: MultiFernet, ...args: Parameters<MultiFernet["rotate"]>) => string = Reflect.get(
      MultiFernet.prototype,
      "rotate",
    );
    t.mock.method(
      MultiFernet.prototype,
      "rotate",
      function (this: MultiFernet, ...args: Parameters<MultiFernet["rotate"]>) {
        calls += 1;
        if (calls === 2) throw new Error("stopped mid-run");
        return real.apply(this, args);
      },
    );
    assert.throws(() => store.reencrypt(), /stopped mid-run/);
    t.mock.restoreAll();
    const restarted = f.reopen({ encryptionKeys: [fresh, old] });
    assert.equal(restarted.links.getKey("aad-alice"), "ak-alice-linked");
    assert.deepEqual(restarted.notifySubs.notifySubByRoute("route-alice"), {
      userId: "aad-alice",
      secret: "whsec-alice",
    });
    assert.deepEqual(restarted.reencrypt(), { rotated: 2, current: 1, undecryptable: 0 });
    assert.deepEqual(readable(f.reopen({ encryptionKeys: [fresh] }), f), ALL_BACK);
  });
});

test("a row rewritten during the run is not overwritten", (t) => {
  withSeeded((f, { old, fresh }) => {
    const store = f.reopen({ encryptionKeys: [fresh, old] });
    const real: (this: MultiFernet, ...args: Parameters<MultiFernet["rotate"]>) => string = Reflect.get(
      MultiFernet.prototype,
      "rotate",
    );
    t.mock.method(
      MultiFernet.prototype,
      "rotate",
      function (this: MultiFernet, ...args: Parameters<MultiFernet["rotate"]>) {
        if (new TextDecoder().decode(new Fernet(old).decrypt(args[0])) === "ak-alice-linked") {
          // Alice links a new key between the read and the write of her row.
          assert.equal(store.links.redeemPending("aad-alice", "Alice", store.links.stashPending("ak-alice-new")), "ok");
        }
        return real.apply(this, args);
      },
    );
    const counts = store.reencrypt();
    t.mock.restoreAll();
    assert.equal(counts.undecryptable, 0);
    assert.equal(f.reopen({ encryptionKeys: [fresh] }).links.getKey("aad-alice"), "ak-alice-new");
  });
});

test("a token no key reads is left alone", () => {
  withSeeded((f, { fresh }) => {
    const before = raw(f);
    assert.deepEqual(f.reopen({ encryptionKeys: [fresh] }).reencrypt(), { rotated: 0, current: 0, undecryptable: 3 });
    assert.deepEqual(raw(f), before);
  });
});

test("the worker re-encrypts when it opens the store, and logs counts but no secret", () => {
  withSeeded((f, { old, fresh }) => {
    const lines: { message: string; fields?: LogFields }[] = [];
    const record = (message: string, fields?: LogFields): void => {
      lines.push(fields === undefined ? { message } : { message, fields });
    };
    const logger: Logger = { debug: record, info: record, warn: record, error: record, child: () => logger };
    openWorkerStore({ path: f.path, encryptionKeys: [fresh, old], clock: f.clock }, logger).close();
    assert.equal(f.reopen({ encryptionKeys: [fresh] }).links.getKey("aad-alice"), "ak-alice-linked");
    assert.deepEqual(lines, [
      {
        message: "encryption keys: stored secrets re-encrypted to the first key",
        fields: { rotated: 3, current: 0, undecryptable: 0 },
      },
    ]);
    const text = JSON.stringify(lines);
    for (const secret of ["ak-alice-linked", "ak-bob-pending", "whsec-alice", old, fresh])
      assert.ok(!text.includes(secret));
  });
});
