// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Deleting from S3, which nothing did until now.
 *
 * Uploads only ever added, so what accumulated under a session prefix was the
 * union of every file that had ever been there, and a file the user deleted
 * came back the next time the session was rehydrated. The S3 copy was not a
 * snapshot.
 *
 * Deletion is the dangerous direction, and the whole decision rests on one
 * `find` run inside a sandbox that may be half torn down. So what is pinned
 * here is mostly what is *not* deleted: objects belonging to another
 * lifecycle, and anything at all when the listing cannot prove it is complete.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  isPruneExempt,
  isRestoreSkipped,
  prunePlan,
  parseWorkspaceListing,
  syncWorkspaceToS3,
  TRANSCRIPT_PREFIX,
} from "../src/workspace/s3-uploader.js";
import type { HandsClient } from "../src/clients/hands.js";

test("deletion goes one object at a time, never through the batch endpoint", () => {
  // Not a behaviour test -- a guard on a decision whose failure mode is silent.
  // MinIO requires a Content-MD5 header on the batch endpoint that aws-sdk v3
  // does not attach, so DeleteObjects fails every single time with "Missing
  // required header for this request: Content-Md5". A prune written that way
  // logs a warning and deletes nothing, for ever, which reads exactly like a
  // workspace that had nothing stale in it. The upload sweeper found this the
  // hard way and has been deleting per object ever since
  // (`packages/api/src/sessions/upload-sweeper.ts`).
  const src = readFileSync(
    fileURLToPath(new URL("../src/workspace/s3-uploader.ts", import.meta.url)),
    "utf-8",
  );
  assert.ok(!src.includes("DeleteObjectsCommand"), "batch delete does not work against MinIO here");
  assert.ok(src.includes("DeleteObjectCommand"), "per-object delete is the one that works");
});

const BEGIN = "__claw_ls_begin__";
const END = "__claw_ls_end__";

/** What Hands returns for a healthy `find`, fences and all. */
function fenced(paths: string[], exit = 0): string {
  return [BEGIN, ...paths, `${END}:${exit}`].join("\n");
}

// ===== exemptions =====

test("user uploads are left to their own expiry", () => {
  // Their TTL is managed by the upload sweeper and encoded in object tags.
  // They are excluded from the workspace listing, so without this exemption
  // every one of them would look stale and be deleted on the first sync.
  assert.equal(isPruneExempt(".uploads/input.csv"), true);
});

test("zip-cache artefacts are left to theirs", () => {
  assert.equal(isPruneExempt(".zip-cache/bundle.zip"), true);
});

test("past-run archives outlive the current workspace", () => {
  // The whole point of an archive directory is that it is a copy of a run that
  // has finished. It does not correspond to anything in /workspace and never
  // will.
  assert.equal(isPruneExempt("claw-1776000000000/report.md"), true);
});

test("a run's transcript is not deleted by the next run", () => {
  // flushTranscript PUTs into this directory, which no sandbox has, so it has no
  // counterpart in /workspace and looks stale to every prune. On a warm sandbox
  // that would mean message two deleting message one's transcript, leaving only
  // the last -- and these are visible to the user in the file browser. Asserted
  // through the predicate rather than pruneRemovedObjects because this is the
  // whole of the decision; the caller only lists and deletes.
  assert.equal(isPruneExempt(`${TRANSCRIPT_PREFIX}claw-1786000000000.jsonl`), true);
  assert.equal(isPruneExempt(`${TRANSCRIPT_PREFIX}claw-1786000000000-attempt2.jsonl`), true);
  assert.equal(
    isPruneExempt(`${TRANSCRIPT_PREFIX}claw-1786000000000-sigterm-1786000000001.jsonl`), true,
  );
});

test("ordinary workspace files are not exempt", () => {
  assert.equal(isPruneExempt("src/main.py"), false);
  assert.equal(isPruneExempt("notes.md"), false);
  // Not an archive directory: no path separator after the prefix.
  assert.equal(isPruneExempt("claw-notes.md"), false);
});

test("what is not the workspace is not restored into it either", () => {
  assert.equal(isRestoreSkipped("claw-1776000000000/report.md"), true);
  assert.equal(isRestoreSkipped(".hands-binary"), true);
  assert.equal(
    isRestoreSkipped(`${TRANSCRIPT_PREFIX}claw-1786000000000.jsonl`), true,
    "restored, a transcript joins /workspace and is uploaded and archived again every turn",
  );

  assert.equal(isRestoreSkipped("src/main.py"), false);
});

test("a file the user's own run wrote is restored into their workspace", () => {
  // Both filters used to guess a transcript from its name -- any flat `.jsonl`
  // -- which is also what a run writing `/workspace/results.jsonl` produces, so
  // the restore withheld the user's own file. Deciding by prefix is what makes
  // it ordinary again on the side where getting it wrong destroys something.
  for (const rel of ["results.jsonl", "claw-notes.jsonl", "data/records.jsonl"]) {
    assert.equal(isRestoreSkipped(rel), false, `${rel} has to come back`);
  }
});

test("nothing is exempted for being named like a transcript", () => {
  // Neither filter guesses from a name any more, so a flat `.jsonl` is prunable
  // whoever wrote it. The exemption it used to have could only be the shape, and
  // the shape covers `results.jsonl` too: while it stood, a user deleting their
  // own file got it back on the next restore, for ever.
  assert.equal(isPruneExempt("results.jsonl"), false);
  assert.equal(isPruneExempt("claw-1786000000000.jsonl"), false,
    "including the transcripts already written there, which are workspace files "
      + "now with the protection every workspace file has -- see prunePlan, which "
      + "bounds how many one sync may delete and defers the rest to the next");
  assert.equal(isPruneExempt("data/records.jsonl"), false);
  assert.equal(isPruneExempt("notes.md"), false);

  // What replaced the guess: the directory nothing but Brain writes to.
  assert.equal(isPruneExempt(`${TRANSCRIPT_PREFIX}claw-1786000000000.jsonl`), true);
});

// ===== the listing has to prove itself before anything is deleted =====

test("a complete listing is believed", () => {
  const listing = parseWorkspaceListing(fenced(["/workspace/a.py", "/workspace/b.md"]));
  assert.equal(listing.trusted, true);
  assert.deepEqual(listing.files, ["/workspace/a.py", "/workspace/b.md"]);
});

test("a find that walked only part of the tree is not believed", () => {
  // The command used to end in `|| true`, so this case arrived looking exactly
  // like a workspace whose files had genuinely gone.
  const listing = parseWorkspaceListing(fenced(["/workspace/a.py"], 1));
  assert.equal(listing.trusted, false);
  assert.equal(listing.reason, "find_exit_1");
  assert.deepEqual(listing.files, ["/workspace/a.py"], "what was found is still uploaded");
});

test("a listing whose head was dropped is not believed", () => {
  // Hands caps bash output with a ring buffer that discards from the front, so
  // on a large workspace the surviving text is the *tail* of the file list --
  // every path before the cut then has no counterpart and looks deleted. The
  // trailing fence survives this untouched, which is exactly why there is a
  // leading one. Hands also says so in a footer; that is a different refusal,
  // pinned next door. This is the case where the footer never arrived and the
  // leading fence is simply gone.
  const truncated = [
    "rkspace/half-a-path.py",
    "/workspace/b.md",
    `${END}:0`,
  ].join("\n");
  const listing = parseWorkspaceListing(truncated);
  assert.equal(listing.trusted, false);
  assert.equal(listing.reason, "listing_head_dropped");
  assert.deepEqual(
    listing.files,
    ["/workspace/b.md"],
    "the severed path is discarded; what was found is still uploaded",
  );
});

test("a head fence forged where the cut left nothing in front of it is still refused", () => {
  // What the counting cannot catch. It rests on truncation leaving a partial
  // line before a planted marker, and usually it does -- but the ring buffer
  // cuts on a byte, and the agent chooses both the filenames and their lengths,
  // so a cut landing on the newline just before the marker leaves nothing to
  // count. The listing then looks perfect: one fence, one path, a clean exit,
  // and every real file absent and therefore prunable.
  const forged = [
    BEGIN,
    "/workspace/what-the-agent-wants-kept.py",
    `${END}:0`,
    "[stdout truncated; 8388608 bytes dropped]",
  ].join("\n");

  const listing = parseWorkspaceListing(forged);

  assert.equal(listing.trusted, false, "the footer does not depend on where the cut fell");
  assert.equal(listing.reason, "listing_truncated");
});

test("a head fence a filename could have printed is not believed either", () => {
  // The mirror of the forged trailing fence, reachable through the same two
  // facts: the ring buffer drops the front of the output, and a filename may
  // contain a newline. With the real `echo` cut away, a file called
  // `x\n__claw_ls_begin__` supplies the first candidate, and everything the
  // truncation left in front of it would read as a listing that simply did not
  // mention those paths -- which is a request to prune them. Counting what
  // precedes the fence is what stops that: on a healthy listing there is nothing
  // there, because the echo is the first thing the command runs.
  const forged = [
    "/workspace/still-here.py",
    "/workspace/also-here.md",
    BEGIN,
    "/workspace/what-the-agent-wants-kept.py",
    `${END}:0`,
  ].join("\n");

  const listing = parseWorkspaceListing(forged);

  assert.equal(listing.trusted, false);
  assert.equal(listing.reason, "listing_unexpected_lines");
  assert.deepEqual(listing.files, ["/workspace/what-the-agent-wants-kept.py"],
    "the paths are still uploaded; what is refused is deciding what no longer exists");
});

test("a listing that stops mid-stream is not believed", () => {
  // A timed-out call returns whatever stdout had reached at the kill.
  const listing = parseWorkspaceListing([BEGIN, "/workspace/a.py"].join("\n"));
  assert.equal(listing.trusted, false);
  assert.equal(listing.reason, "listing_unterminated");
});

test("an empty workspace is a real answer when it is fenced", () => {
  // Distinct from a listing that failed to come back: this one is complete and
  // says there is nothing, so the prune may act on it.
  const listing = parseWorkspaceListing(fenced([]));
  assert.equal(listing.trusted, true);
  assert.deepEqual(listing.files, []);
});

test("a line between the fences that is not a path discredits the listing", () => {
  // Such a line means part of the output is unaccounted for, and the listing is
  // only ever believed as a complete account of the workspace. Dropping it
  // quietly is what let the forgery below through: the remainder still read as a
  // tidy list of paths, so nothing downstream could tell anything was missing.
  const listing = parseWorkspaceListing(
    [BEGIN, "", "/workspace/a.py", "find: '/workspace/x': Permission denied", `${END}:0`].join("\n"),
  );
  assert.equal(listing.trusted, false);
  assert.equal(listing.reason, "listing_unexpected_lines");
  assert.deepEqual(listing.files, ["/workspace/a.py"], "what was found is still uploaded");
});

// ===== the region between the fences is text the agent chooses =====

test("a filename cannot end the listing early", () => {
  // Filenames may contain newlines, and the agent picks them, so a file called
  // `evil\n__claw_ls_end__:0` prints as two lines whose second one is
  // indistinguishable from the real closing fence. Taking the first candidate
  // ended the region there: the listing became the handful of paths before the
  // forgery, and every genuine file after it had no counterpart -- which is a
  // request to delete it from S3, issued by choosing a filename.
  const forged = [
    BEGIN,
    "/workspace/evil",
    `${END}:0`,
    "/workspace/keep-me.py",
    "/workspace/keep-me-too.py",
    `${END}:0`,
  ].join("\n");

  const listing = parseWorkspaceListing(forged);
  assert.equal(listing.trusted, false,
    "a listing containing a forged fence cannot be used to decide what was deleted");
  assert.ok(
    listing.files.includes("/workspace/keep-me.py")
    && listing.files.includes("/workspace/keep-me-too.py"),
    "the paths after the forgery are real files and must not read as deleted",
  );
});

test("a marker with anything else on its line is not a fence", () => {
  // The check is the whole line, not a prefix, so trailing text cannot smuggle
  // one in -- and a fence that does not parse is an unterminated listing rather
  // than a zero exit status.
  const listing = parseWorkspaceListing(
    [BEGIN, "/workspace/a.py", `${END}:0 and some more`].join("\n"),
  );
  assert.equal(listing.trusted, false);
  assert.equal(listing.reason, "listing_unterminated");
});

test("a file whose name contains a newline is not silently split into two", () => {
  // Without the forged marker this is the same hazard in its innocent form: the
  // second half of the name is not a path, so the listing cannot claim to
  // enumerate the workspace and the file's real object is not pruned.
  const listing = parseWorkspaceListing(
    [BEGIN, "/workspace/two", "line-name.txt", `${END}:0`].join("\n"),
  );
  assert.equal(listing.trusted, false);
  assert.equal(listing.reason, "listing_unexpected_lines");
});

/** A sandbox whose `find` returns exactly `output`, and `ok` to the probe. */
function handsListing(output: string): HandsClient {
  return {
    callTool: async (_tool: string, args: { command?: string }) =>
      (args.command?.includes("find") ? output : "ok"),
  } as unknown as HandsClient;
}

test("a listing that did not parse is reported as a failure, not as an empty workspace", async () => {
  // `empty` is what the caller turns into "no files under /workspace at sync
  // time" for the user, so returning it here reports a listing that never parsed
  // as a completed sync of a workspace that had nothing in it -- the one outcome
  // indistinguishable from success. Thrown instead, which puts it on the path a
  // listing call that never came back already takes: `workspace_sync_failed`.
  await assert.rejects(
    () => syncWorkspaceToS3(handsListing("whatever this is, it is not a listing"), "sess-unparseable-listing", "user-1"),
    /listing could not be trusted/,
  );
});

test("the failure names itself, so the event does not say the reason was `Error`", async () => {
  // The caller derives the user-facing `workspace_sync_failed` reason from the
  // error's type, so a bare `Error` reached the user as the literal string
  // "Error" beside a sync that had in fact failed for a specific, printable
  // reason. The listing's own verdict is in the message for the same reason.
  await assert.rejects(
    () => syncWorkspaceToS3(handsListing(fenced([], 1)), "sess-teardown", "user-1"),
    (err: Error) => {
      assert.equal(err.constructor.name, "WorkspaceListingUntrusted",
        "the type is what becomes the reason on the event");
      assert.match(err.message, /find_exit_1/, "and which failure it was has to survive too");
      return true;
    },
  );
});

test("an empty workspace is still reported as empty when the listing proved itself", async () => {
  // The other side of the throw above, and the case whose comment used to claim
  // the tearing-down sandbox: a fenced listing that exited zero with nothing in
  // it is a run that produced no files, which the user is told about as
  // `workspace_sync_empty` rather than as a failed sync. A sandbox whose
  // /workspace is unmounted no longer arrives here -- `find` exits non-zero on a
  // missing directory, which is the case above.
  const result = await syncWorkspaceToS3(handsListing(fenced([])), "sess-nothing-made", "user-1");

  assert.equal(result.empty, true);
  assert.equal(result.totalFiles, 0);
});

// ===== the cap bounds the rate, it does not veto =====

test("a normal prune goes ahead whole", () => {
  const stale = ["k1", "k2", "k3"];
  const { doomed, deferred } = prunePlan(stale);
  assert.deepEqual(doomed, stale);
  assert.equal(deferred, 0);
});

test("an enormous prune is spread over syncs rather than refused", () => {
  // The guard this replaced refused outright above a proportion of the prefix,
  // and refused identically on every subsequent sync, because the stale set it
  // tripped on never got any smaller. A workspace that lost more than half its
  // files at once was therefore never reconciled again. Deferring converges;
  // refusing did not.
  const stale = Array.from({ length: 12_000 }, (_, i) => `k${i}`);
  const { doomed, deferred } = prunePlan(stale);
  assert.equal(doomed.length, 5000);
  assert.equal(deferred, 7000);
  assert.equal(doomed.length + deferred, stale.length);
});

test("removing most of a prefix is allowed once the listing is trusted", () => {
  // This is the case the proportional guard existed to stop. It is now stopped
  // upstream, by the listing having to prove it is complete -- so a user who
  // really did delete nine tenths of their workspace gets that reflected.
  const stale = Array.from({ length: 900 }, (_, i) => `k${i}`);
  assert.equal(prunePlan(stale).deferred, 0);
});
