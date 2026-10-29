// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/images`: the image search the web client's image fields use, answered
 * from SaFE's registry as the caller.
 *
 * The route is driven through a real Fastify instance and a real `fetch` against
 * a small HTTP server standing in for SaFE, so what is asserted is what crossed
 * the wire: which credential was forwarded, which query SaFE was asked, and what
 * the browser is told when SaFE misbehaves. Each refusal is paired with the same
 * request that succeeds, because a route that refuses everything would pass
 * otherwise.
 *
 * Coverage:
 *   T1 an image reference's tag (table-driven)
 *   Q1 the query string: what is accepted, lowered to the maximum, or refused (table-driven)
 *   M1 SaFE's list reduced to what an image field uses, and nothing else of it
 *   C1 the caller's own credential is what is forwarded, and only that
 *   W1 what SaFE is asked: the flat list and the count, search encoded, the limit
 *   F1 SaFE failing: unreachable, slow, refusing, erroring, redirecting, answering nonsense
 *   A1 without a user, 401; a request with no forwardable credential is 503 and asks nobody
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach, describe } from "node:test";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";

// Read once when config loads, so it is set before the dynamic imports below.
let seen: Array<{ url: string; headers: IncomingMessage["headers"] }> = [];
type Reply = { status?: number; body?: unknown; raw?: string; headers?: Record<string, string>; hang?: boolean };
let answer: (url: URL) => Reply = () => ({});

const GOOD_LIST = [
  { id: 7, tag: "registry.example.com/team/pytorch:2.5", description: "internal note", created_at: 1_760_000_000, created_by: "someone", secretId: "sec-1" },
  { id: 8, tag: "registry.example.com:5000/team/base", created_at: 1_760_000_100, created_by: "someone" },
];

function defaultAnswer(url: URL): Reply {
  if (url.searchParams.get("flat") === "true") return { body: GOOD_LIST };
  return { body: { totalCount: 120, images: [] } };
}

const fake: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  seen.push({ url: req.url ?? "", headers: req.headers });
  const reply = answer(new URL(req.url ?? "/", "http://fake"));
  if (reply.hang) return; // never answers
  res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...(reply.headers ?? {}) });
  res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
});

let app: FastifyInstance;
let caller: { userId: string; userName: string; roles: string[]; platformKey: string; virtualKey: string } | null;
let images: typeof import("../src/routes/images.js");

const USER = { userId: "u1", userName: "u1", roles: ["default"], platformKey: "", virtualKey: "vk" };

before(async () => {
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  process.env.SAFE_API_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.CLAW_DEPLOY_MODE = "safe";
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  images = await import("../src/routes/images.js");
  app = Fastify();
  await app.register(cookie);
  app.addHook("preHandler", async (req) => { (req as any).user = caller; });
  await images.registerImageRoutes(app);
  await app.ready();
});
after(async () => {
  await app?.close();
  fake.closeAllConnections();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
});
beforeEach(() => {
  seen = [];
  answer = defaultAnswer;
  caller = USER;
});

const COOKIE = { cookie: "Token=abc123; userType=default" };
const get = (url: string, headers: Record<string, string> = COOKIE) => app.inject({ method: "GET", url, headers });
const askedOf = () => seen.map((s) => new URL(s.url, "http://fake"));

describe("T1 the tag of an image reference", () => {
  const CASES: Array<[string, string, string | undefined]> = [
    ["name and tag", "pytorch:2.5", "2.5"],
    ["a registry host and path", "registry.example.com/team/pytorch:2.5-rocm", "2.5-rocm"],
    ["a registry port and no tag", "registry.example.com:5000/team/base", undefined],
    ["a registry port and a tag", "registry.example.com:5000/team/base:v1", "v1"],
    ["no tag at all", "registry.example.com/team/base", undefined],
    ["a digest only", "team/base@sha256:0123abcd", undefined],
    ["a tag and a digest", "team/base:v1@sha256:0123abcd", "v1"],
    ["a trailing colon", "team/base:", undefined],
    ["a bare name", "ubuntu", undefined],
  ];
  for (const [name, ref, tag] of CASES) {
    test(name, () => assert.equal(images.imageTagOf(ref), tag));
  }
});

describe("Q1 the query string", () => {
  const ok = (q: unknown) => {
    const p = images.parseImageQuery(q);
    assert.equal(p.ok, true, JSON.stringify(p));
    return p as Extract<typeof p, { ok: true }>;
  };
  const refused = (q: unknown) => {
    const p = images.parseImageQuery(q);
    assert.equal(p.ok, false, `${JSON.stringify(q)} should be refused`);
    return p as Extract<typeof p, { ok: false }>;
  };

  test("nothing given is the default limit and no search", () => {
    assert.deepEqual(ok({}), { ok: true, search: "", limit: images.IMAGES_DEFAULT_LIMIT });
    assert.equal(images.IMAGES_DEFAULT_LIMIT, 50);
  });
  test("a search is trimmed", () => assert.equal(ok({ search: "  torch " }).search, "torch"));
  test("a search of exactly the longest length is accepted, one more is not", () => {
    assert.equal(ok({ search: "s".repeat(images.IMAGES_SEARCH_MAX_CHARS) }).search.length, images.IMAGES_SEARCH_MAX_CHARS);
    assert.equal(refused({ search: "s".repeat(images.IMAGES_SEARCH_MAX_CHARS + 1) }).error, "invalid_search");
  });
  test("a search given twice, or not as text, is refused", () => {
    assert.equal(refused({ search: ["a", "b"] }).error, "invalid_search");
    assert.equal(refused({ search: { a: "b" } }).error, "invalid_search");
  });
  for (const [limit, expected] of [["1", 1], ["50", 50], ["199", 199], ["200", 200], ["201", 200], ["100000", 200], ["9999999999", 200]] as Array<[string, number]>) {
    test(`limit=${limit} is ${expected}`, () => assert.equal(ok({ limit }).limit, expected));
  }
  for (const limit of ["0", "-1", "1.5", "abc", "", " 5", "5 ", "1e2", "0x10", ["5", "6"], ["5"]] as unknown[]) {
    test(`limit=${JSON.stringify(limit)} is refused`, () => assert.equal(refused({ limit }).error, "invalid_limit"));
  }
});

describe("M1 the list, reduced", () => {
  test("an item is the reference, its tag and when it was registered, and nothing else of SaFE's", async () => {
    const res = await get("/v1/images");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      items: [
        { name: "registry.example.com/team/pytorch:2.5", tag: "2.5", createdAt: new Date(1_760_000_000 * 1000).toISOString() },
        { name: "registry.example.com:5000/team/base", createdAt: new Date(1_760_000_100 * 1000).toISOString() },
      ],
      total: 120,
    });
    const text = res.body;
    for (const leaked of ["internal note", "someone", "sec-1", "secretId", "created_by", "description"]) {
      assert.equal(text.includes(leaked), false, `${leaked} reached the browser`);
    }
  });

  test("total is what SaFE counts, not how many came back", async () => {
    answer = (url) => url.searchParams.get("flat") === "true"
      ? { body: GOOD_LIST }
      : { body: { totalCount: 4000, images: [] } };
    assert.equal((await get("/v1/images")).json().total, 4000);
  });

  test("an empty registry is an empty list and a zero", async () => {
    answer = (url) => url.searchParams.get("flat") === "true" ? { body: [] } : { body: { totalCount: 0, images: [] } };
    assert.deepEqual((await get("/v1/images")).json(), { items: [], total: 0 });
  });

  test("a total below what came back never reads as fewer than the list", async () => {
    answer = (url) => url.searchParams.get("flat") === "true" ? { body: GOOD_LIST } : { body: { totalCount: 1 } };
    assert.equal((await get("/v1/images")).json().total, 2);
  });

  test("entries that name no image are dropped, and a bad timestamp is left out, not thrown on", async () => {
    answer = (url) => url.searchParams.get("flat") === "true"
      ? { body: [null, 5, "x", {}, { tag: "" }, { tag: "   " }, { tag: 7 }, { tag: "ok:1", created_at: 1e20 }, { tag: "ok:2", created_at: -5 }, { tag: "ok:3", created_at: "yesterday" }, { tag: "ok:4", created_at: 0 }, { tag: "ok:5", created_at: "1760000000" }] }
      : { body: { totalCount: 10 } };
    const res = await get("/v1/images");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items, [
      { name: "ok:1", tag: "1" }, { name: "ok:2", tag: "2" }, { name: "ok:3", tag: "3" }, { name: "ok:4", tag: "4" }, { name: "ok:5", tag: "5" },
    ]);
  });

  test("more than the limit from SaFE is cut to the limit", async () => {
    answer = (url) => url.searchParams.get("flat") === "true"
      ? { body: Array.from({ length: 9 }, (_, i) => ({ id: i, tag: `img:${i}` })) }
      : { body: { totalCount: 9 } };
    assert.equal((await get("/v1/images?limit=3")).json().items.length, 3);
  });
});

describe("C1 whose credential is asked with", () => {
  test("a session cookie is forwarded as the cookie, with no authorization", async () => {
    await get("/v1/images", { cookie: "Token=abc123; userType=default" });
    assert.equal(seen.length, 2);
    for (const s of seen) {
      assert.equal(s.headers.cookie, "Token=abc123; userType=default");
      assert.equal(s.headers.authorization, undefined);
    }
  });

  test("an API key in Authorization is forwarded as it came, with no cookie", async () => {
    await get("/v1/images", { authorization: "Bearer ak-user-key" });
    for (const s of seen) {
      assert.equal(s.headers.authorization, "Bearer ak-user-key");
      assert.equal(s.headers.cookie, undefined);
    }
  });

  test("an API key in x-api-key is forwarded as a Bearer key, and the header itself is not", async () => {
    await get("/v1/images", { "x-api-key": "ak-user-key" });
    for (const s of seen) {
      assert.equal(s.headers.authorization, "Bearer ak-user-key");
      assert.equal(s.headers["x-api-key"], undefined);
    }
  });

  test("a gateway's own Bearer token beside the user's key is not the credential that is forwarded", async () => {
    await get("/v1/images", { authorization: "Bearer gateway-token", "x-api-key": "ak-user-key" });
    for (const s of seen) assert.equal(s.headers.authorization, "Bearer ak-user-key");
  });

  test("a request with no credential SaFE could be asked with is 503 and asks nobody", async () => {
    const res = await get("/v1/images", { authorization: "Bearer gateway-token" });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, "images_unavailable");
    assert.equal(seen.length, 0);
  });
});

describe("W1 what SaFE is asked", () => {
  test("the flat list with the page size, and a one-row count of the ready images", async () => {
    await get("/v1/images");
    const asked = askedOf();
    assert.equal(asked.length, 2);
    assert.ok(asked.every((u) => u.pathname === "/api/v1/images"));
    const flat = asked.find((u) => u.searchParams.get("flat") === "true")!;
    const count = asked.find((u) => u.searchParams.get("flat") !== "true")!;
    assert.equal(flat.searchParams.get("page_size"), "50");
    assert.equal(flat.searchParams.has("tag"), false);
    assert.equal(count.searchParams.get("ready"), "true");
    assert.equal(count.searchParams.get("page_size"), "1");
  });

  test("the limit is the page size, lowered to the maximum", async () => {
    await get("/v1/images?limit=7");
    assert.equal(askedOf().find((u) => u.searchParams.get("flat") === "true")!.searchParams.get("page_size"), "7");
    seen = [];
    await get("/v1/images?limit=5000");
    assert.equal(askedOf().find((u) => u.searchParams.get("flat") === "true")!.searchParams.get("page_size"), String(images.IMAGES_MAX_LIMIT));
  });

  test("the search goes to both requests as one value, however it is spelled", async () => {
    const search = "a&page_size=9999&flat=false#x%y z";
    await get(`/v1/images?search=${encodeURIComponent(search)}`);
    const asked = askedOf();
    assert.equal(asked.length, 2);
    for (const u of asked) {
      assert.equal(u.searchParams.get("tag"), search);
      assert.equal(u.searchParams.getAll("page_size").length, 1);
    }
    assert.equal(asked.find((u) => u.searchParams.get("flat") === "true")!.searchParams.get("page_size"), "50");
  });

  test("a blank search asks for no filter", async () => {
    await get("/v1/images?search=%20%20");
    assert.ok(askedOf().every((u) => !u.searchParams.has("tag")));
  });

  test("a refused query asks SaFE nothing", async () => {
    for (const q of ["limit=0", "limit=abc", `search=${"s".repeat(images.IMAGES_SEARCH_MAX_CHARS + 1)}`, "search=a&search=b"]) {
      const res = await get(`/v1/images?${q}`);
      assert.equal(res.statusCode, 400, q);
      assert.match(res.json().error, /^invalid_(limit|search)$/);
    }
    assert.equal(seen.length, 0);
  });
});

describe("F1 SaFE failing", () => {
  const FAILURES: Array<[string, (url: URL) => Reply, number, string]> = [
    ["refusing the credential", () => ({ status: 401, body: { errorCode: "Primus.00003" } }), 401, "unauthorized"],
    ["forbidding the listing", () => ({ status: 403, body: { errorCode: "Primus.00004" } }), 403, "forbidden"],
    ["erroring", () => ({ status: 500, body: { errorMessage: "boom: secret-detail" } }), 502, "upstream_error"],
    ["answering not found", () => ({ status: 404 }), 502, "upstream_error"],
    ["redirecting", () => ({ status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } }), 502, "upstream_error"],
    ["answering something that is not JSON", () => ({ raw: "<html>gateway</html>" }), 502, "upstream_bad_response"],
    ["answering an object where a list is", (url) => url.searchParams.get("flat") === "true" ? { body: { images: [] } } : { body: { totalCount: 1 } }, 502, "upstream_bad_response"],
    ["answering no count", (url) => url.searchParams.get("flat") === "true" ? { body: [] } : { body: { images: [] } }, 502, "upstream_bad_response"],
    ["answering a count that is not a number", (url) => url.searchParams.get("flat") === "true" ? { body: [] } : { body: { totalCount: "many" } }, 502, "upstream_bad_response"],
    ["answering null", () => ({ raw: "null" }), 502, "upstream_bad_response"],
    ["answering a count too large to be a number", (url) => url.searchParams.get("flat") === "true" ? { body: [] } : { raw: '{"totalCount": 1e999}' }, 502, "upstream_bad_response"],
  ];
  for (const [name, reply, status, error] of FAILURES) {
    test(`SaFE ${name} is ${status} ${error}, and says nothing of what SaFE said`, async () => {
      answer = reply;
      const res = await get("/v1/images");
      assert.equal(res.statusCode, status);
      const body = res.json();
      assert.equal(body.error, error);
      assert.equal(typeof body.reason, "string");
      assert.equal(body.ok, false);
      for (const leaked of ["Primus.0000", "secret-detail", "errorCode", "errorMessage", "gateway"]) {
        assert.equal(res.body.includes(leaked), false, `${leaked} reached the browser`);
      }
    });
  }

  test("a failure of the count alone fails the request, as one of the flat list would", async () => {
    answer = (url) => url.searchParams.get("flat") === "true" ? { body: GOOD_LIST } : { status: 500 };
    assert.equal((await get("/v1/images")).statusCode, 502);
    answer = (url) => url.searchParams.get("flat") === "true" ? { status: 500 } : { body: { totalCount: 3 } };
    assert.equal((await get("/v1/images")).statusCode, 502);
  });

  test("a redirect is not followed: its target is never asked", async () => {
    const target = createServer((_req, res) => { targetHits++; res.end("[]"); });
    let targetHits = 0;
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    try {
      const port = (target.address() as AddressInfo).port;
      answer = () => ({ status: 307, headers: { location: `http://127.0.0.1:${port}/steal` } });
      assert.equal((await get("/v1/images")).statusCode, 502);
      assert.equal(targetHits, 0);
    } finally {
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  test("a SaFE that does not answer in time is 503, not a hang", async () => {
    answer = () => ({ hang: true });
    const started = Date.now();
    const outcome = await images.searchImages({ cookie: "Token=t" }, { search: "", limit: 5 }, { timeoutMs: 150 });
    assert.deepEqual(outcome, { ok: false, status: 503, error: "upstream_unavailable", reason: "the image registry did not answer" });
    assert.ok(Date.now() - started < 3000);
  });

  test("a SaFE that is not listening is 503 upstream_unavailable", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const outcome = await images.searchImages({ cookie: "Token=t" }, { search: "", limit: 5 }, { baseUrl: `http://127.0.0.1:${port}` });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.ok === false && [outcome.status, outcome.error], [503, "upstream_unavailable"]);
  });

  test("the same request, with SaFE answering, succeeds", async () => {
    assert.equal((await get("/v1/images")).statusCode, 200);
  });
});

describe("A1 who may ask", () => {
  test("without a user the answer is 401 and SaFE is not asked", async () => {
    caller = null;
    const res = await get("/v1/images");
    assert.equal(res.statusCode, 401);
    assert.equal(seen.length, 0);
  });
});
