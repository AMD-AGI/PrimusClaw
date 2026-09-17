// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every HTTPS fetch in claw/Dockerfile has to run in a stage that already
 * trusts the EXTRA_CA_CERT_URLS anchors.
 *
 * The Dockerfile documents, at length, that this image is built and run in
 * environments "whose egress is behind a TLS-intercepting proxy" and that
 * EXTRA_CA_CERT_URLS is "the supported way to reach such an endpoint -- the
 * alternative deployments reach for otherwise is tls.insecureSkipVerify".
 * Those anchors are fetched and installed in exactly one stage, `builder`, and
 * carried from there into `runtime` by an explicit COPY. No other stage has
 * them. A `curl https://...` in a stage that never received them cannot
 * validate the certificate the proxy presents, and the build dies -- not at
 * runtime, not behind a flag, but in the image build, for everyone who opted
 * in to the mechanism this file exists to offer.
 *
 * That is not hypothetical: the Bun download used to sit in `builder`,
 * immediately after `update-ca-certificates`, and was moved into a new
 * `bun-builder` stage (a different distro, a bare trust store) when that stage
 * was re-based. The move looked like a relocation of six lines and was in fact
 * the removal of the only thing making the fetch work.
 *
 * There is no compiler for a Dockerfile and no container runtime in CI's lint
 * job, so this reads the stage graph the way Docker does -- instructions,
 * continuations joined, comment lines dropped so that a comment naming a URL is
 * not mistaken for a fetch of it -- and asserts the reachability property
 * directly.
 *
 * Coverage:
 *   R1 some stage still installs the EXTRA_CA_CERT_URLS anchors (without this,
 *      R2 would pass by having nothing to compare against)
 *   R2 every curl/wget of a literal https:// URL runs in a stage whose trust
 *      store already holds those anchors
 *   R3 the Bun release archive is one of the fetches R2 examined, so R2 cannot
 *      go green on an empty set
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOCKERFILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "Dockerfile");
const TEXT = readFileSync(DOCKERFILE, "utf8");

/** Where the builder stage installs the opted-in anchors. */
const ANCHOR_DIR = "/usr/local/share/ca-certificates";

interface Instruction {
  /** Stage name from `FROM ... AS <name>`. */
  stage: string;
  /** Position of this instruction within its own stage, FROM included. */
  index: number;
  /** FROM / RUN / COPY / ... */
  keyword: string;
  /** The whole instruction, continuation lines joined, comments dropped. */
  text: string;
  /** 1-based line number of the instruction's first line. */
  line: number;
}

/**
 * Parse the Dockerfile into instructions.
 *
 * Continuations matter here: the URL of a `curl -fsSL -o /tmp/bun.zip \` sits
 * on the *next* line, so a line-at-a-time scan sees a curl with no URL and a
 * URL with no curl, and concludes there are no fetches at all. Comment lines
 * are dropped for the reason lint-dockerfile-build-order.sh drops them -- the
 * comment block above the Bun fetch names `https://bun.sh/install`, which is
 * the installer this file deliberately does *not* use.
 */
function parse(text: string): Instruction[] {
  const out: Instruction[] = [];
  const lines = text.split("\n");
  const counters = new Map<string, number>();
  let stage = "<preamble>";
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === "" || /^\s*#/.test(raw)) {
      i++;
      continue;
    }
    const line = i + 1;
    let joined = raw;
    let continues = /\\[ \t]*$/.test(raw);
    while (continues && i + 1 < lines.length) {
      i++;
      const next = lines[i];
      // Docker skips comment lines inside a continuation without ending it.
      if (/^\s*#/.test(next)) continue;
      joined += "\n" + next;
      continues = /\\[ \t]*$/.test(next);
    }
    i++;
    const keyword = (/^\s*([A-Za-z]+)/.exec(joined)?.[1] ?? "").toUpperCase();
    if (keyword === "FROM") {
      stage = /\sAS\s+(\S+)/i.exec(joined)?.[1] ?? `<unnamed@${line}>`;
    }
    const index = counters.get(stage) ?? 0;
    counters.set(stage, index + 1);
    out.push({ stage, index, keyword, text: joined, line });
  }
  return out;
}

const INSTRUCTIONS = parse(TEXT);

/**
 * For each stage, the instruction index at which the EXTRA_CA_CERT_URLS
 * anchors are in that stage's trust store.
 *
 * A stage earns them one of two ways, both of which the Dockerfile uses today:
 * it runs the installer block itself (the RUN that names EXTRA_CA_CERT_URLS and
 * ends in `update-ca-certificates`), or it copies the anchor directory out of a
 * stage that already has them and runs the trust-store update itself --
 * `update-ca-certificates` on Debian, `update-ca-trust` on a RHEL-family base.
 */
function anchoredAt(instructions: Instruction[]): Map<string, number> {
  const anchored = new Map<string, number>();
  const copied = new Set<string>();
  for (const ins of instructions) {
    if (ins.keyword === "COPY") {
      const from = /--from=(\S+)/.exec(ins.text)?.[1];
      if (from !== undefined && anchored.has(from) && ins.text.includes(ANCHOR_DIR)) {
        copied.add(ins.stage);
      }
      continue;
    }
    if (ins.keyword !== "RUN") continue;
    if (!/update-ca-certificates|update-ca-trust/.test(ins.text)) continue;
    if (anchored.has(ins.stage)) continue;
    const installsHere = ins.text.includes("EXTRA_CA_CERT_URLS");
    if (installsHere || copied.has(ins.stage)) anchored.set(ins.stage, ins.index);
  }
  return anchored;
}

const ANCHORED = anchoredAt(INSTRUCTIONS);

/** Every RUN that pulls a literal https:// URL down with curl or wget. */
const FETCHES = INSTRUCTIONS.filter(
  (ins) => ins.keyword === "RUN" && /\b(curl|wget)\b/.test(ins.text) && /https:\/\//.test(ins.text),
).map((ins) => ({
  ...ins,
  urls: ins.text.match(/https:\/\/[^\s"'\\]+/g) ?? [],
}));

test("R1 the Dockerfile still installs the EXTRA_CA_CERT_URLS anchors somewhere", () => {
  assert.ok(
    ANCHORED.size > 0,
    "no stage installs the EXTRA_CA_CERT_URLS anchors. Either the mechanism was " +
      "removed -- in which case TLS-intercepted deployments are back to " +
      "tls.insecureSkipVerify and this test should not be the only thing that " +
      "noticed -- or this test no longer recognises how it is installed.",
  );
});

test("R2 every https fetch runs in a stage that already trusts those anchors", () => {
  const unanchored = FETCHES.filter((f) => {
    const at = ANCHORED.get(f.stage);
    return at === undefined || at >= f.index;
  });
  assert.deepEqual(
    unanchored.map((f) => `${DOCKERFILE.replace(/^.*\//, "")}:${f.line} [${f.stage}] ${f.urls[0]}`),
    [],
    "these fetches run in a stage with no EXTRA_CA_CERT_URLS anchors in its trust store.\n" +
      `Stages that have them: ${JSON.stringify([...ANCHORED.keys()])}.\n` +
      "Behind the TLS-intercepting proxy this Dockerfile documents, curl cannot verify\n" +
      "the certificate the proxy substitutes and the build fails with\n" +
      '  "curl: (60) SSL certificate problem: unable to get local issuer certificate".\n' +
      "Fix: fetch from a stage that installed the anchors and COPY the result, or COPY\n" +
      `${ANCHOR_DIR} into this stage and run the trust-store update before the fetch.`,
  );
});

test("R3 the Bun archive is one of the fetches R2 looked at", () => {
  const bun = FETCHES.filter((f) => f.urls.some((u) => /bun/.test(u)));
  assert.equal(
    bun.length,
    1,
    "expected exactly one https fetch of the pinned Bun release archive; found " +
      `${bun.length}. R2 is only as good as the fetches it can see, so a Bun download ` +
      "this scan cannot find means R2 stopped guarding the thing it was written for.",
  );
});
