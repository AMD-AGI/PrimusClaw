// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Concurrent first calls on a fresh HandsClient share one connect.
 *
 * `connected` is set only after the MCP initialize round trip, and the SDK's
 * `connect` refuses a second transport while the first is still starting. The
 * restore sends its download batches four at a time on the client a fresh (or
 * rebuilt) sandbox was just given, so before this every batch but the first
 * failed with "Already connected to a transport" and cost a retry round. The
 * SDK client inside a real HandsClient is replaced by a stand-in that behaves
 * as the SDK's does here: it takes the transport at once, and answers only after
 * a slow initialize.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { HandsClient } from "../src/clients/hands.js";
import { syncWorkspaceFromS3 } from "../src/workspace/s3-uploader.js";

/** What the SDK's Client does on connect and callTool, with a slow initialize. */
class SlowSdkClient {
  transport: unknown = null;
  /** Every connect asked for, including the ones refused. */
  attempts = 0;
  connects = 0;
  failNextConnect = false;
  downloads: string[][] = [];
  async connect(transport: unknown): Promise<void> {
    this.attempts++;
    if (this.transport) {
      throw new Error("Already connected to a transport. Call close() before connecting to a new transport, "
        + "or use a separate Protocol instance per connection.");
    }
    this.connects++;
    this.transport = transport;
    await new Promise((r) => setTimeout(r, 50));
    if (this.failNextConnect) {
      this.failNextConnect = false;
      this.transport = null;
      throw new Error("initialize failed");
    }
  }
  async callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<unknown> {
    assert.ok(this.transport, "a call before connect");
    let text = "ok";
    if (req.name === "download_from_s3") {
      const files = (req.arguments.files as Array<{ local_path: string }>).map((f) => f.local_path);
      this.downloads.push(files);
      text = JSON.stringify({ ok: files, failed: [], total: files.length });
    }
    return { content: [{ type: "text", text }] };
  }
  async close(): Promise<void> { this.transport = null; }
}

function freshClient(): { hands: HandsClient; sdk: SlowSdkClient } {
  const hands = new HandsClient("http://sandbox.test:9100/mcp", "tok", "sess-1", "run-1");
  const sdk = new SlowSdkClient();
  (hands as unknown as { client: SlowSdkClient }).client = sdk;
  return { hands, sdk };
}

test("H1 four concurrent first calls on a fresh client connect once and all succeed", async () => {
  const { hands, sdk } = freshClient();
  const files = (i: number) => [{ local_path: `/workspace/f${i}`, presigned_url: "http://s3.test/x" }];
  const answers = await Promise.all(
    [0, 1, 2, 3].map((i) => hands.callTool("download_from_s3", { files: files(i) })),
  );
  assert.equal(sdk.attempts, 1);
  for (const [i, a] of answers.entries()) {
    assert.deepEqual(JSON.parse(a).ok, [`/workspace/f${i}`]);
  }
});

test("H2 a connect that failed is tried again by the next call", async () => {
  const { hands, sdk } = freshClient();
  sdk.failNextConnect = true;
  await assert.rejects(() => hands.callTool("bash", { command: "echo ok" }), /initialize failed/);
  assert.equal(await hands.callTool("bash", { command: "echo ok" }), "ok");
  assert.equal(sdk.connects, 2);
});

test("H3 a restore of 400 files on a fresh client lands every batch in the first round", async (t) => {
  const prefix = "users/u1/sessions/s1/";
  const keys = Array.from({ length: 400 }, (_, i) => `${prefix}src/f${i}.txt`);
  t.mock.method(S3Client.prototype, "send", async (cmd: unknown) => {
    assert.ok(cmd instanceof ListObjectsV2Command);
    return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
  });
  const { hands, sdk } = freshClient();
  let calls = 0;
  const callTool = hands.callTool.bind(hands);
  hands.callTool = ((name: string, args: Record<string, unknown>) => {
    if (name === "download_from_s3") calls++;
    return callTool(name, args);
  }) as typeof hands.callTool;
  assert.equal(await syncWorkspaceFromS3(hands, "s1", "u1"), keys.length);
  assert.equal(sdk.attempts, 1, "one connect, asked for once");
  assert.equal(calls, 4, "no batch failed and went round again");
  assert.equal(sdk.downloads.length, 4, "four batches of a hundred, none sent twice");
  assert.equal(new Set(sdk.downloads.flat()).size, keys.length);
});
