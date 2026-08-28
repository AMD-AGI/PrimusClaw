// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Tagging workspace uploads so a lifecycle rule can address them at all.
 *
 * The existing rules filter on `imports/staging/` by prefix and on two tags the
 * workspace uploader never set. A lifecycle prefix is literal with no wildcard,
 * and the only common ancestor of `users/<uid>/sessions/<sid>/` is `users/`,
 * which would cover every user's live files. So a tag is the only filter that
 * can single these objects out.
 *
 * This was deferred once on the belief that it needed a coordinated release
 * with Hands: sign `x-amz-tagging` into the URL, and an uploader that does not
 * echo the header back gets 403 on every object. That belief was wrong, and
 * the test below is what establishes it -- the presigner hoists the tag into
 * the query string instead of signing it as a header, so the uploader sends
 * exactly what it sent before and cannot get it wrong.
 *
 * The same fact rules out the belt-and-braces version of the idea: sending the
 * header as well would make it an unsigned `x-amz-*` header on a presigned
 * request, which S3 refuses with "There were headers present in the request
 * which were not signed".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function client(): S3Client {
  return new S3Client({
    region: "us-east-1",
    endpoint: "http://minio.invalid:9000",
    forcePathStyle: true,
    credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
  });
}

test("the tag rides in the query string, not in a header the uploader must repeat", async () => {
  const url = new URL(
    await getSignedUrl(
      client(),
      new PutObjectCommand({
        Bucket: "claw",
        Key: "users/u/sessions/s/a.txt",
        Tagging: "origin=workspace",
      }),
      { expiresIn: 300 },
    ),
  );

  assert.equal(url.searchParams.get("x-amz-tagging"), "origin=workspace");
  assert.equal(
    url.searchParams.get("X-Amz-SignedHeaders"),
    "host",
    "if this ever includes x-amz-tagging, the uploader has to send the header "
      + "and Hands needs a coordinated change before tagging can be turned on",
  );
});

test("an untagged upload is signed the same way, so the flag is a safe switch", async () => {
  const url = new URL(
    await getSignedUrl(
      client(),
      new PutObjectCommand({ Bucket: "claw", Key: "users/u/sessions/s/a.txt" }),
      { expiresIn: 300 },
    ),
  );
  assert.equal(url.searchParams.has("x-amz-tagging"), false);
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
});
