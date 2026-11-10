// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * HttpIdentityLookup against what the Python worker's `safe.whoami`, `safe.safe_user` and `safe.user_id_of` gave for the
 * same `/users/self` answers (data/users-self.json, generated with httpx's mock transport). The owner is read here the
 * way those three read it: a name or an id that is "" means none.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { KeyOwner } from "@primusclaw/personal-agent";
import { HttpIdentityLookup, type Fetch } from "../../src/index.js";

interface Case {
  readonly label: string;
  readonly status?: number;
  readonly body?: string;
  readonly failure?: string;
  readonly whoami: readonly [string, string] | null;
  readonly safeUser: { readonly name: string; readonly email: string; readonly type: string } | null;
  readonly userId: string | null;
}

const { cases } = JSON.parse(readFileSync(new URL("data/users-self.json", import.meta.url), "utf8")) as {
  cases: readonly Case[];
};
const BASE = "https://safe.example.com/api/v1";
const KEY = "ak-test-key";

/** A fetch that checks the request and answers with `answer`; the requests it saw. */
function platform(answer: (init: RequestInit) => Promise<Response>): { fetch: Fetch; seen: string[] } {
  const seen: string[] = [];
  const fetch: Fetch = (url, init) => {
    seen.push(url);
    assert.equal(init.method, "GET");
    assert.deepEqual(init.headers, { Authorization: `Bearer ${KEY}` });
    assert.equal(init.redirect, "manual");
    return answer(init);
  };
  return { fetch, seen };
}

/** A fetch that never answers until the request is aborted, then fails the way fetch does. */
const hanging = (init: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      reject(init.signal?.reason as Error);
    });
  });

function answerOf(c: Case): (init: RequestInit) => Promise<Response> {
  if (c.failure === "a timeout") return hanging;
  if (c.failure !== undefined) return () => Promise.reject(new TypeError("fetch failed"));
  const body = c.body === "" ? null : (c.body ?? null);
  return () => Promise.resolve(new Response(body, { status: c.status ?? 200 }));
}

// The Python readings of one owner: `whoami`, `safe_user` and `user_id_of` (each None when its field is "").
const whoami = (o: KeyOwner | undefined): readonly [string, string] | null =>
  o === undefined || o.name === "" ? null : [o.name, o.email];
const safeUser = (o: KeyOwner | undefined): Case["safeUser"] =>
  o === undefined || o.name === "" ? null : { name: o.name, email: o.email, type: o.accountType };
const userId = (o: KeyOwner | undefined): string | null => (o === undefined || o.id === "" ? null : o.id);

describe("the key owner from the platform's /users/self (Python safe.py)", () => {
  it("has Python's answers for every kind of reply, failures included", () => {
    assert.ok(cases.length >= 38);
    assert.ok(cases.some((c) => c.failure === "a timeout"));
    assert.ok(cases.some((c) => c.status === 401) && cases.some((c) => c.status === 403));
  });

  for (const c of cases) {
    it(`reads ${c.label} as the Python worker does`, async () => {
      const { fetch, seen } = platform(answerOf(c));
      const owner = await new HttpIdentityLookup(BASE, fetch, 50).ownerOfKey(KEY);
      assert.deepEqual(whoami(owner), c.whoami);
      assert.deepEqual(safeUser(owner), c.safeUser);
      assert.equal(userId(owner), c.userId);
      assert.deepEqual(seen, [`${BASE}/users/self`]);
    });
  }

  it("whoami reads name and email from the key's own users self", async () => {
    const seen: Array<readonly [string, unknown]> = [];
    const fetch: Fetch = (url, init) => {
      const authorization = (init.headers as Record<string, string>)["Authorization"];
      seen.push([new URL(url).pathname, authorization]);
      return Promise.resolve(
        authorization === "Bearer ak-bad"
          ? new Response(null, { status: 401 })
          : Response.json({ id: "u1", name: "Ada", email: "ada@example.com" }),
      );
    };
    const lookup = new HttpIdentityLookup("https://safe.test/api/v1", fetch);
    assert.deepEqual(
      [whoami(await lookup.ownerOfKey("ak-ok")), whoami(await lookup.ownerOfKey("ak-bad"))],
      [["Ada", "ada@example.com"], null],
    );
    assert.deepEqual(seen[0], ["/api/v1/users/self", "Bearer ak-ok"]);
  });

  it("gives up when the platform does not answer in time", async () => {
    const { fetch } = platform(hanging);
    const started = performance.now();
    assert.equal(await new HttpIdentityLookup(BASE, fetch, 50).ownerOfKey(KEY), undefined);
    assert.ok(performance.now() - started < 2_000);
  });
});
