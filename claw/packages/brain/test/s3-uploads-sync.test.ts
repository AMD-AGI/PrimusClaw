// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What `syncUploadsFromS3` asks Hands for: every object under the session's
 * `.uploads/`, at its workspace path and with its size, so Hands fetches only
 * the ones it does not already hold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { syncUploadsFromS3 } from "../src/workspace/s3-uploader.js";
import type { HandsClient } from "../src/clients/hands.js";

function fakeHands(answer: string) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const hands = {
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return answer;
    },
  } as unknown as HandsClient;
  return { hands, calls };
}

test("every upload is offered at its workspace path with its size", async (t) => {
  const prefixes: string[] = [];
  t.mock.method(S3Client.prototype, "send", async (cmd: unknown) => {
    assert.ok(cmd instanceof ListObjectsV2Command);
    prefixes.push(String(cmd.input.Prefix));
    return {
      Contents: [
        { Key: "users/u1/sessions/s1/.uploads/teams/m1/report.pdf", Size: 1234 },
        { Key: "users/u1/sessions/s1/.uploads/shot.png", Size: 70 },
      ],
      IsTruncated: false,
    };
  });
  const { hands, calls } = fakeHands(JSON.stringify({ ok: [], failed: [], total: 2 }));
  const offered = await syncUploadsFromS3(hands, "s1", "u1");

  assert.equal(offered, 2);
  assert.deepEqual(prefixes, ["users/u1/sessions/s1/.uploads/"], "only the uploads are listed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "download_from_s3");
  const files = calls[0].args.files as Array<{ local_path: string; presigned_url: string; size: number }>;
  assert.deepEqual(files.map((f) => [f.local_path, f.size]), [
    ["/workspace/.uploads/teams/m1/report.pdf", 1234],
    ["/workspace/.uploads/shot.png", 70],
  ]);
  assert.ok(files.every((f) => f.presigned_url.includes(".uploads")), "each is fetched from its own object");
});

test("a session with no uploads costs no call to the sandbox", async (t) => {
  t.mock.method(S3Client.prototype, "send", async () => ({ Contents: [], IsTruncated: false }));
  const { hands, calls } = fakeHands("{}");
  assert.equal(await syncUploadsFromS3(hands, "s1", "u1"), 0);
  assert.equal(calls.length, 0);
});
