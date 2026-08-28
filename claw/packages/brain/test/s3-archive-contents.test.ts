// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a per-run archive copies out of the session prefix.
 *
 * The archive is a point-in-time copy of the workspace, taken after every run,
 * and it is taken from the same listing the restore uses -- so anything that
 * listing hands back is copied once per run, for ever. That is what made the
 * transcripts' old flat location expensive rather than untidy: each run's
 * transcript joined the workspace, and every later archive copied every earlier
 * transcript, so a session's object count grew with the square of its turns.
 *
 * Driven through the real archiveRunToS3 against a local endpoint standing in for
 * S3, because the exclusion lives in a listing helper that is not exported and
 * the whole question is which keys the copies name.
 *
 * Coverage:
 *   A1 the workspace is archived, and the transcripts are not
 *   A2 what else the archive leaves where it is
 *   A3 the zip cache is copied into every archive, as it always has been
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const BUCKET = "claw-archive-test";
const SESSION_PREFIX = "users/u1/sessions/sess-archive/";

/** Keys the stub bucket answers a listing with. */
let contents: string[] = [];
/** Every CopyObject the archive issued, as `<source> -> <destination>`. */
const copies: string[] = [];

function listResponse(prefix: string): string {
  const entries = contents.map((key) => (
    `<Contents><Key>${key}</Key><Size>7</Size>`
    + `<LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`
  )).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Name>${BUCKET}</Name><Prefix>${prefix}</Prefix><KeyCount>${contents.length}</KeyCount>
<MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${entries}</ListBucketResult>`;
}

const s3 = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://s3.test");
  const copySource = req.headers["x-amz-copy-source"];
  req.resume();
  if (typeof copySource === "string") {
    copies.push(`${decodeURIComponent(copySource)} -> ${decodeURIComponent(url.pathname)}`);
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end('<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"s"</ETag>'
      + "<LastModified>2026-01-01T00:00:00.000Z</LastModified></CopyObjectResult>");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/xml" });
  // Prefix is a fixture, not the query string: echoing `prefix` here was a
  // CodeQL reflected-xss hit on a stub that never serves a browser.
  res.end(listResponse(SESSION_PREFIX));
});
await new Promise<void>((resolve) => { s3.listen(0, "127.0.0.1", resolve); });
s3.unref();

// Set before the first import of config.ts, which reads each of these once at
// module scope; hence the dynamic import below rather than a static one.
process.env.S3_API_ENDPOINT = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
process.env.S3_BUCKET = BUCKET;
process.env.S3_ACCESS_KEY = "stub-access-key";
process.env.S3_SECRET_KEY = "stub-secret-key";

const { archiveRunToS3, TRANSCRIPT_PREFIX } = await import("../src/workspace/s3-uploader.js");

/** The relative paths this archive run copied, in listing order. */
async function archivedRelPaths(messageId: string): Promise<string[]> {
  copies.length = 0;
  await archiveRunToS3("sess-archive", "u1", messageId);
  return copies.map((c) => {
    const dst = c.split(" -> ")[1] ?? "";
    return dst.slice(`/${BUCKET}/${SESSION_PREFIX}${messageId}/`.length);
  });
}

test("A1 the workspace is archived, and the transcripts are not", async () => {
  contents = [
    `${SESSION_PREFIX}notes.md`,
    `${SESSION_PREFIX}results.jsonl`,
    `${SESSION_PREFIX}${TRANSCRIPT_PREFIX}claw-1.jsonl`,
    `${SESSION_PREFIX}${TRANSCRIPT_PREFIX}claw-2-attempt2.jsonl`,
  ];

  assert.deepEqual(
    (await archivedRelPaths("claw-3")).sort(),
    ["notes.md", "results.jsonl"],
    "a run's own output is the archive; the record of past runs is not, and copying"
    + " it would make the prefix grow with the square of the session's turns",
  );
});

test("A2 what else the archive leaves where it is", async () => {
  // Past archives are excluded by the listing the archive shares with the
  // restore, so an earlier archive is not copied into every later one.
  // `.uploads/` is excluded by the archive's own check instead -- the restore
  // hands it back deliberately, because the user put those files there to be
  // worked on -- and without it an upload would be duplicated into copies that
  // outlive the TTL its uploader set.
  contents = [
    `${SESSION_PREFIX}notes.md`,
    `${SESSION_PREFIX}claw-1/notes.md`,
    `${SESSION_PREFIX}.uploads/input.csv`,
  ];

  assert.deepEqual(await archivedRelPaths("claw-3"), ["notes.md"]);
});

test("A3 the zip cache is copied into every archive, as it always has been", async () => {
  // Neither filter covers it: the restore hands it back like `.uploads/`, and
  // the archive's own check names only `.uploads/`. So a cached zip is copied
  // into every run's archive and each copy outlives the cache's own expiry.
  //
  // Pinned rather than fixed, because changing what an archive contains is not
  // this layer's to change and the behaviour predates it. The assertion is here
  // so the next person to touch the reserved prefixes finds it stated.
  contents = [
    `${SESSION_PREFIX}notes.md`,
    `${SESSION_PREFIX}.zip-cache/bundle.zip`,
  ];

  assert.deepEqual(
    (await archivedRelPaths("claw-3")).sort(),
    [".zip-cache/bundle.zip", "notes.md"],
    "this pins a known leak, not desired behaviour: the cached zip is copied into "
    + "every run's archive and each copy outlives the cache's own expiry. If you are "
    + "reading this because you just fixed that, drop `.zip-cache/bundle.zip` from the "
    + "expectation -- the failure is the fix landing, not a regression",
  );
});
