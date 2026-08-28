// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// An unset CORS_ORIGINS must not let another site read an authenticated
// response.
//
// The assertion is on the response headers a browser actually reads, driven
// through the real @fastify/cors with the option resolveCorsOrigin() returns --
// not on that function's return value. The bug this replaces was not a wrong
// return value, it was `origin: true` + `credentials: true` reaching the
// browser as "https://evil.example.com may read this", and only the header
// says whether that is still true.
//
// Coverage:
//   C1 unset      -> no Access-Control-Allow-Origin at all
//   C2 blank/commas -> same as unset (this is what `set -a; source .env` gives)
//   C3 allowlisted origin -> echoed back, with credentials
//   C4 non-allowlisted origin -> not echoed
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { resolveCorsOrigin } from "../src/config.js";

const EVIL = "https://evil.example.com";
const GOOD = "https://app.example.com";

async function headersFor(rawEnv: string | undefined, requestOrigin: string) {
  const app = Fastify();
  // The same three options index.ts passes; only `origin` is under test.
  await app.register(cors, {
    origin: resolveCorsOrigin(rawEnv),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
  });
  app.get("/probe", async () => ({ ok: true }));
  const res = await app.inject({ method: "GET", url: "/probe", headers: { origin: requestOrigin } });
  await app.close();
  return res.headers;
}

test("C1 an unset CORS_ORIGINS refuses cross-origin reads", async () => {
  const h = await headersFor(undefined, EVIL);
  assert.equal(
    h["access-control-allow-origin"], undefined,
    "reflecting the request Origin with credentials lets any site read an authenticated response",
  );
});

test("C2 a blank CORS_ORIGINS is the same as unset", async () => {
  // `set -a; source .env` exports every key .env.example leaves empty as "",
  // so this, not undefined, is what the documented quick start produces.
  for (const raw of ["", "   ", ",", " , ,"]) {
    const h = await headersFor(raw, EVIL);
    assert.equal(h["access-control-allow-origin"], undefined, `raw=${JSON.stringify(raw)}`);
  }
});

test("C3 an allowlisted origin is still served, with credentials", async () => {
  const h = await headersFor(`${GOOD}, https://other.example.com`, GOOD);
  assert.equal(h["access-control-allow-origin"], GOOD);
  assert.equal(h["access-control-allow-credentials"], "true");
});

test("C4 an origin outside the allowlist is not echoed", async () => {
  const h = await headersFor(GOOD, EVIL);
  assert.notEqual(h["access-control-allow-origin"], EVIL);
});
