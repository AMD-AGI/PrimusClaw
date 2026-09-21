// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A marketplace skill archive cannot write outside its staging directory.
 *
 * `downloadSkill` unpacks a ZIP that arrived over the network into a temp
 * directory on *Brain's* filesystem, and reads SKILL.md back out of it. An
 * entry named `../evil` is therefore an arbitrary file write on the
 * orchestrator, as the orchestrator's user -- not inside a sandbox, where the
 * path guard would have caught it. adm-zip hands `entryName` back exactly as
 * the archive spelled it (it sanitizes names on *write*, not on read), so the
 * only thing standing between a hostile archive and that write is the pair of
 * checks in the extraction loop. Nothing exercised them: both could be deleted
 * with the suite still green. This pins them, and pins that rejecting entries
 * does not reject the archive -- the legitimate files still arrive.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";

import { resolveToolIds } from "../src/tools/resolve.js";

const TOOL_ID = 4242;
const TMP = os.tmpdir();
const TAG = `claw-zipslip-${process.pid}`;

/**
 * Build a ZIP whose entry names traverse.
 *
 * adm-zip refuses to write one -- `addFile("../evil.txt")` is stored as
 * `evil.txt` -- so each name goes in as a same-length placeholder and the
 * bytes are patched afterwards. Equal lengths keep every name-length field in
 * the local and central headers correct, and the CRCs cover the data, not the
 * name. A real attacker's ZIP writer simply has no such scruples.
 */
function hostileZip(names: string[]): Buffer {
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from("# staged skill\n"));
  const placeholders = names.map((real, i) => {
    const tag = `zipslip${i}`;
    assert.ok(real.length > tag.length, `traversal name ${real} too short to patch`);
    return (tag + "z".repeat(real.length - tag.length));
  });
  for (const p of placeholders) zip.addFile(p, Buffer.from("pwned\n"));

  let bytes = zip.toBuffer().toString("latin1");
  for (const [i, p] of placeholders.entries()) {
    assert.ok(bytes.includes(p), `placeholder ${p} not found in archive`);
    bytes = bytes.replaceAll(p, names[i]);
  }
  return Buffer.from(bytes, "latin1");
}

/** Stand in for the SaFE Tools API: one skill, whose download is `body`. */
function stubToolsApi(body: Buffer): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/download")) {
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    }
    return new Response(
      JSON.stringify({ data: { tools: [{ id: TOOL_ID, name: "hostile-skill", type: "skill" }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = real; };
}

test("a skill ZIP cannot write outside its staging directory", async () => {
  // The staging directory is `<tmpdir>/claw-skill-<id>-XXXXXX`, so one "../"
  // lands the write in the temp directory beside it: the shortest real escape,
  // and the one a carelessly flattened archive produces by accident.
  const sibling = path.join(TMP, `${TAG}-sibling.txt`);
  const nestedDir = path.join(TMP, `${TAG}-nested`);
  const absolute = path.join(TMP, `${TAG}-absolute.txt`);
  const victims = [sibling, path.join(nestedDir, "payload.txt"), absolute];

  const entryNames = [
    `../${path.basename(sibling)}`,
    // Deeper, with the traversal buried mid-path rather than leading.
    `docs/../../${path.basename(nestedDir)}/payload.txt`,
    // An absolute entry name, saying plainly what the archive is trying to do.
    absolute,
    // Backslash separators: Windows-authored archives reach us this way, and
    // the loop normalizes them before deciding, so ".." must still be seen.
    `..\\${path.basename(sibling)}`,
  ];

  fs.rmSync(sibling, { force: true });
  fs.rmSync(absolute, { force: true });
  fs.rmSync(nestedDir, { force: true, recursive: true });

  const restore = stubToolsApi(hostileZip(entryNames));
  let resolved;
  try {
    resolved = await resolveToolIds([TOOL_ID], "test-key");
  } finally {
    restore();
  }

  for (const victim of victims) {
    assert.equal(fs.existsSync(victim), false, `skill ZIP escaped staging and wrote ${victim}`);
  }
  // The benign entry still arrives: the guards reject entries, not archives.
  assert.equal(resolved.skillContents["hostile-skill"], "# staged skill\n");
});
