// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * HttpKeyRevoker against the Python worker's `safe.revoke_own_key` on the same platform answers (data/revoke-own-key.json,
 * generated with httpx's mock transport): what it returns and which requests it makes, in order.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HttpKeyRevoker, type Fetch } from "../../src/index.js";

type Answer = { readonly status: number; readonly body: string } | { readonly fail: string } | null;
interface Case {
  readonly label: string;
  readonly current: Answer;
  readonly delete: Answer;
  readonly revoked: boolean;
  readonly requests: ReadonlyArray<readonly [string, string]>;
}

const { cases } = JSON.parse(readFileSync(new URL("data/revoke-own-key.json", import.meta.url), "utf8")) as {
  cases: readonly Case[];
};
const BASE = "https://safe.example.com/api/v1";
const KEY = "ak-test-key";

/** A request that never answers until it is aborted, then fails the way fetch does. */
const hanging = (init: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      reject(init.signal?.reason as Error);
    });
  });

function respond(answer: Answer, init: RequestInit): Promise<Response> {
  assert.ok(answer !== null, "a request Python did not make");
  if ("fail" in answer)
    return answer.fail === "ReadTimeout" ? hanging(init) : Promise.reject(new TypeError("fetch failed"));
  return Promise.resolve(new Response(answer.body === "" ? null : answer.body, { status: answer.status }));
}

/** The platform of one case: answers GET with `current`, DELETE with `delete`; the requests it saw. */
function platform(c: Case): { fetch: Fetch; seen: Array<[string, string]> } {
  const seen: Array<[string, string]> = [];
  const fetch: Fetch = (url, init) => {
    assert.deepEqual(init.headers, { Authorization: `Bearer ${KEY}` });
    assert.equal(init.redirect, "manual");
    const method = init.method ?? "GET";
    seen.push([method, new URL(url).pathname]);
    return respond(method === "GET" ? c.current : c.delete, init);
  };
  return { fetch, seen };
}

describe("revoking a person's own key on the platform (Python safe.revoke_own_key)", () => {
  it("has Python's answers for successes, refusals, timeouts, broken connections and odd bodies", () => {
    assert.ok(cases.length >= 50);
    assert.ok(cases.some((c) => c.requests.some(([m, p]) => m === "DELETE" && p === "/api/v1/apikeys/123")));
    assert.ok(cases.filter((c) => c.revoked).length >= 10);
    assert.ok(cases.some((c) => c.current !== null && "fail" in c.current && c.current.fail === "ReadTimeout"));
    assert.ok(cases.some((c) => c.delete !== null && "fail" in c.delete && c.delete.fail === "ReadTimeout"));
  });

  for (const c of cases) {
    it(`does what the Python worker does: ${c.label}`, async () => {
      const { fetch, seen } = platform(c);
      assert.equal(await new HttpKeyRevoker(BASE, fetch, 50).revoke(KEY), c.revoked);
      assert.deepEqual(seen, c.requests);
    });
  }

  // Python keeps an integer past 2^53 exact; JavaScript has rounded it by the time it is read (to another key's id,
  // perhaps), so no delete goes out for one. 5.0 is the integer 5 once parsed (Python would refuse a float).
  for (const [label, body, revoked] of [
    ["an integer past 2^53", '{"id": 9007199254740993}', false],
    ["2^53 - 1", '{"id": 9007199254740991}', true],
    ["5.0", '{"id": 5.0}', true],
  ] as const) {
    it(`reads ${label} as a JavaScript number`, async () => {
      const seen: string[] = [];
      const fetch: Fetch = (url, init) => {
        seen.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
        return Promise.resolve(
          new Response(init.method === "DELETE" ? null : body, { status: init.method === "DELETE" ? 204 : 200 }),
        );
      };
      assert.equal(await new HttpKeyRevoker(BASE, fetch).revoke(KEY), revoked);
      assert.equal(seen.length, revoked ? 2 : 1);
    });
  }

  it("lets a programming error through rather than calling it a failed revoke", async () => {
    const fetch: Fetch = () => Promise.resolve(new Response('{"id": "k-1"}', { status: 200 }));
    const broken = new HttpKeyRevoker(BASE, fetch);
    Object.defineProperty(broken, "http", {
      value: {
        send: () => {
          throw new RangeError("a bug");
        },
      },
    });
    await assert.rejects(broken.revoke(KEY), RangeError);
  });
});

/** What revoking with `current` as the /apikeys/current answer returns and the requests it makes. */
async function revokeWith(current: unknown): Promise<[boolean, string[]]> {
  const sent: string[] = [];
  const fetch: Fetch = (url, init) => {
    sent.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
    return Promise.resolve(
      init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(current, { status: 200 }),
    );
  };
  return [await new HttpKeyRevoker(BASE, fetch).revoke(KEY), sent];
}

// The Python worker's own tests of the path-segment fix, with their parameters.
describe("the key id of a revoke (Python test_revoke_key_id.py)", () => {
  it("the key's own id is deleted", async () => {
    for (const [current, deleted] of [
      [{ id: 123 }, "/api/v1/apikeys/123"],
      [{ data: { id: 7 } }, "/api/v1/apikeys/7"],
      [{ id: "ak-Abc_1.2~x" }, "/api/v1/apikeys/ak-Abc_1.2~x"],
    ] as const) {
      assert.deepEqual(await revokeWith(current), [true, ["GET /api/v1/apikeys/current", `DELETE ${deleted}`]]);
    }
  });

  it("an id that is not one path segment deletes nothing", async () => {
    for (const current of [
      { id: "../users/self" },
      { id: ".." },
      { id: "." },
      { id: "a/b" },
      { id: "a b" },
      { id: "a%2F.." },
      { id: "a\nb" },
      { id: ["x"] },
      { id: { x: 1 } },
      { id: true },
      { id: -1 },
      { id: 0 },
      { id: "x".repeat(201) },
      { data: { id: "../users/self" } },
    ]) {
      assert.deepEqual(await revokeWith(current), [false, ["GET /api/v1/apikeys/current"]], JSON.stringify(current));
    }
  });
});
