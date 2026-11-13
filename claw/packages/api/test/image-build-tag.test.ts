// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The published claw image knows the tag it is published under.
 *
 * claw_self_status (src/assistant/self-status.ts) reports the running build from
 * CLAW_BUILD, else packages/api/BUILD. The image CI publishes to
 * docker.io/primussafe/claw had neither, so the assistant answered "build
 * unknown" on every live deployment. CI now passes its yyyymmddHHMM tag as a
 * build-arg that the runtime stage turns into ENV CLAW_BUILD; the build job also
 * asserts the built image's CLAW_BUILD equals that tag. This test pins the two
 * ends of that wiring, which no other test reads.
 *
 * Coverage:
 *   T1 the runtime stage declares ARG CLAW_BUILD and exports it as ENV CLAW_BUILD
 *   T2 the build workflow passes the same DATE_TIME it pushes as a tag as CLAW_BUILD
 *   T3 the workflow asserts the built claw image's CLAW_BUILD equals that tag
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLAW = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOCKERFILE = readFileSync(join(CLAW, "Dockerfile"), "utf8");
const WORKFLOW = readFileSync(join(CLAW, "..", ".github", "workflows", "build.yaml"), "utf8");

/** Instructions of the named stage, comment lines dropped. */
function stage(name: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const raw of DOCKERFILE.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) current = from[1] ?? "";
    if (current === name) out.push(line);
  }
  return out;
}

test("T1 the runtime stage turns the CLAW_BUILD build-arg into ENV CLAW_BUILD", () => {
  const runtime = stage("runtime");
  assert.ok(runtime.length > 0, "runtime stage exists");
  const arg = runtime.findIndex((l) => /^ARG\s+CLAW_BUILD(=|\s|$)/.test(l));
  const env = runtime.findIndex((l) => /^ENV\s+CLAW_BUILD=\$\{?CLAW_BUILD\}?\s*$/.test(l));
  assert.ok(arg >= 0, "ARG CLAW_BUILD in runtime");
  assert.ok(env > arg, "ENV CLAW_BUILD=${CLAW_BUILD} after the ARG");
});

test("T2 CI passes the tag it pushes as CLAW_BUILD", () => {
  assert.match(WORKFLOW, /--build-arg CLAW_BUILD=\$\{DATE_TIME\}/);
  assert.match(WORKFLOW, /-t \$\{\{ matrix\.name \}\}:\$\{DATE_TIME\}/, "DATE_TIME is a built tag");
  assert.match(WORKFLOW, /buildah push (?:--\S+ \S+ )*\$\{DOCKERIO_REPOSITORY\}\/\$\{\{ matrix\.name \}\}:\$\{DATE_TIME\}/, "DATE_TIME is a pushed tag");
});

test("T3 CI asserts the built image's CLAW_BUILD equals its tag", () => {
  const step = WORKFLOW.split("- name: ").find((s) => s.startsWith("Assert the image knows its tag"));
  assert.ok(step, "assert step exists");
  assert.match(step, /buildah inspect/);
  assert.match(step, /"\$GOT" != "\$DATE_TIME"/);
  assert.match(step, /exit 1/);
  const build = WORKFLOW.indexOf("--build-arg CLAW_BUILD=");
  const push = WORKFLOW.indexOf("- name: Push with Buildah");
  const at = WORKFLOW.indexOf("- name: Assert the image knows its tag");
  assert.ok(build < at && at < push, "the assertion runs after the build and before the push");
});
