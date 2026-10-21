// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The presigned URLs workspace sync hands a sandbox name the host they were
 * signed for, and the sandbox is the one that fetches them. When sandboxes run
 * where Brain's in-cluster S3 name does not resolve, every upload and restore
 * fails ("Unable to connect"). S3_SANDBOX_ENDPOINT is the endpoint those URLs
 * carry; Brain's own S3 calls keep S3_API_ENDPOINT.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.S3_API_ENDPOINT = "http://minio.internal.invalid:9000";
process.env.S3_SANDBOX_ENDPOINT = "https://s3.sandbox-reachable.invalid";
process.env.S3_ACCESS_KEY = "AK";
process.env.S3_SECRET_KEY = "SK";
process.env.S3_BUCKET = "claw";

const { presignPut, presignGet } = await import("../src/workspace/s3-uploader.js");

test("presigned PUT and GET URLs name the sandbox-facing endpoint, path-style", async () => {
  for (const signed of [
    await presignPut("users/u/sessions/s/a.txt", "origin=workspace"),
    await presignGet("users/u/sessions/s/a.txt"),
  ]) {
    const url = new URL(signed);
    assert.equal(url.origin, "https://s3.sandbox-reachable.invalid");
    assert.equal(url.pathname, "/claw/users/u/sessions/s/a.txt");
    assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
  }
});
