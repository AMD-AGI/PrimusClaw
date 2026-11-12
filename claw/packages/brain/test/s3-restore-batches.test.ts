// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A restore sends Hands its file list in batches Hands accepts.
 *
 * Hands takes a request body of 1 MiB at most (Fastify's default) and answers a
 * larger one with 413. The restore used to put every file of the session into
 * one `download_from_s3` call, a presigned URL each, so a session past a
 * thousand-odd files was never restored: a 3,632-file clone came back as an
 * empty /workspace. These run the real `syncWorkspaceFromS3` and
 * `syncUploadsFromS3` against a Hands stand-in that refuses a body over the
 * limit exactly as Hands does, and count what arrives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { chunkForHands, syncUploadsFromS3, syncWorkspaceFromS3 } from "../src/workspace/s3-uploader.js";
import type { HandsClient } from "../src/clients/hands.js";

/** Hands' limit on a request body: Fastify's default `bodyLimit`. */
const HANDS_BODY_LIMIT = 1024 * 1024;

const USER = "0123456789abcdef0123456789abcdef";
const SESSION = "6f1c2a8e-3b4d-4e5f-9a0b-1c2d3e4f5a6b";
const PREFIX = `users/${USER}/sessions/${SESSION}/`;

/** The 3,632-file clone the restore was measured failing on, with paths as deep as a real repository's. */
function cloneKeys(prefix = PREFIX, n = 3632): string[] {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    keys.push(`${prefix}PrimusClaw/claw/packages/brain/src/workspace/module-${i % 40}/component-${i}/implementation.test.ts`);
  }
  return keys;
}

/** A listing served the way S3 serves it: a thousand keys a page. */
function serveListing(t: { mock: { method: (...a: never[]) => unknown } }, keys: string[], sizes = false): void {
  (t.mock.method as (o: object, m: string, f: (cmd: unknown) => Promise<unknown>) => unknown)(
    S3Client.prototype, "send", async (cmd: unknown) => {
      assert.ok(cmd instanceof ListObjectsV2Command);
      const prefix = String(cmd.input.Prefix);
      const mine = keys.filter((k) => k.startsWith(prefix));
      const start = Number(cmd.input.ContinuationToken ?? 0);
      const page = mine.slice(start, start + 1000);
      const more = start + 1000 < mine.length;
      return {
        Contents: page.map((Key) => (sizes ? { Key, Size: 10 } : { Key })),
        IsTruncated: more,
        NextContinuationToken: more ? String(start + 1000) : undefined,
      };
    },
  );
}

/** Hands, as far as a restore sees it: a request over the limit is refused with 413 and nothing in it is fetched. */
class FakeHands {
  restored = new Set<string>();
  bodies: number[] = [];
  calls = 0;
  /** When set, decides per call whether to throw it instead. */
  refuse: ((call: number) => Error | undefined) | undefined;
  readonly client = {
    generation: "http://sandbox.test/mcp",
    callTool: async (tool: string, args: Record<string, unknown>): Promise<string> => {
      if (tool !== "download_from_s3") return "OK";
      const call = ++this.calls;
      const body = Buffer.byteLength(JSON.stringify({
        jsonrpc: "2.0", id: call, method: "tools/call", params: { name: tool, arguments: args },
      }));
      this.bodies.push(body);
      if (body > HANDS_BODY_LIMIT) {
        throw new Error('Streamable HTTP error: Error POSTing to endpoint (HTTP 413): {"statusCode":413,'
          + '"code":"FST_ERR_CTP_BODY_TOO_LARGE","error":"Payload Too Large","message":"Request body is too large"}');
      }
      const refused = this.refuse?.(call);
      if (refused) throw refused;
      const files = (args.files as Array<{ local_path: string }>).map((f) => f.local_path);
      for (const f of files) this.restored.add(f);
      return JSON.stringify({ ok: files, failed: [], total: files.length });
    },
  } as unknown as HandsClient;
}

test("B1 a 3,632-file session, which one call could not carry, is restored whole in batches under the limit", async (t) => {
  const keys = cloneKeys();
  serveListing(t, keys);
  const hands = new FakeHands();

  const restored = await syncWorkspaceFromS3(hands.client, SESSION, USER);

  assert.equal(restored, keys.length);
  assert.equal(hands.restored.size, keys.length, "every file arrived");
  assert.ok(hands.bodies.every((b) => b <= HANDS_BODY_LIMIT), `largest body ${Math.max(...hands.bodies)} B`);
  const total = hands.bodies.reduce((a, b) => a + b, 0);
  assert.ok(total > HANDS_BODY_LIMIT, `the whole list (${total} B) is more than one request may carry`);
  assert.equal(hands.calls, Math.ceil(keys.length / 100), "a hundred files a call, as the upload sends them");
});

test("B2 a batch refused on its own fails only its files, and the next round brings them back", async (t) => {
  const keys = cloneKeys(PREFIX, 1000);
  serveListing(t, keys);
  const hands = new FakeHands();
  hands.refuse = (call) => (call === 3 ? new Error("MCP error -32603: tool failed") : undefined);

  const restored = await syncWorkspaceFromS3(hands.client, SESSION, USER);

  assert.equal(restored, keys.length);
  assert.equal(hands.restored.size, keys.length);
  assert.equal(hands.calls, 11, "ten batches, then the one refused sent again");
});

test("B3 an unreachable sandbox stops the restore instead of failing every batch in turn", async (t) => {
  const keys = cloneKeys();
  serveListing(t, keys);
  const hands = new FakeHands();
  hands.refuse = () => Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });

  await assert.rejects(() => syncWorkspaceFromS3(hands.client, SESSION, USER), /fetch failed/);
  assert.ok(hands.calls <= 4, `stopped after the batches already in flight (${hands.calls} calls)`);
});

test("B4 the user's uploads are offered in batches under the limit too", async (t) => {
  const keys = cloneKeys(`${PREFIX}.uploads/`);
  serveListing(t, keys, true);
  const hands = new FakeHands();

  const offered = await syncUploadsFromS3(hands.client, SESSION, USER);

  assert.equal(offered, keys.length);
  assert.equal(hands.restored.size, keys.length);
  assert.ok(hands.bodies.every((b) => b <= HANDS_BODY_LIMIT), `largest body ${Math.max(...hands.bodies)} B`);
});

test("B5 batches keep order and both bounds, and an entry over the byte bound goes alone", () => {
  const items = ["a", "b", "c", "d", "e"].map((x) => ({ x }));
  assert.deepEqual(chunkForHands(items, 2, 1_000_000), [[items[0], items[1]], [items[2], items[3]], [items[4]]]);
  // Each `{"x":"a"}` is 9 bytes, 10 with its comma.
  assert.deepEqual(chunkForHands(items, 100, 25), [[items[0], items[1]], [items[2], items[3]], [items[4]]]);
  const big = { x: "y".repeat(100) };
  assert.deepEqual(chunkForHands([items[0], big, items[1]], 100, 50), [[items[0]], [big], [items[1]]]);
  assert.deepEqual(chunkForHands([], 100, 50), []);
});
