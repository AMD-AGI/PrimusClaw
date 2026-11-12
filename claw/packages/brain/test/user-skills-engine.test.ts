// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The user's personal skills in a turn, through the real engine and agent loop; only the network edges are fake: the
 * LLM, the marketplace that serves the platform's default skills, a Hands that records what is written, and the API's
 * `POST /v1/internal/skills/read`, answered as the API answers it (session, turn, name and fingerprint in; SKILL.md
 * and the list of files, or one file, out; 409 for a fingerprint that is no longer current, 404 for a skill that is
 * gone).
 *
 *   P1 listed under their own heading by name and description, most recently used first; no text in the prompt; a
 *      `manual` one is not listed; an imported one is marked
 *   P2 load_skill reads one from the API with the turn's fingerprint; the result has its text and its files; a second
 *      read in the turn fetches nothing again; a `manual` one is loaded by name though never listed; the read is
 *      counted, and the skill is reported used at the version the turn was told
 *   P3 an imported skill is wrapped as a third party's text when loaded
 *   P4 changed during the turn (409) or gone (404): the model is told so and is given none of it; counted not_found
 *   P5 which skill a name means: the request's own (plugin) > personal > repository > platform default; the loser is
 *      neither listed nor served, and the list says what a personal skill replaces
 *   P6 the list's share: the platform's skills keep their place beside many personal skills, and personal skills
 *      beyond the list are counted, said, and still loadable
 *   P7 written into the sandbox only when a command names it, under .skills/.personal-skills/<name>/, before that
 *      command, binary files as binary; a bare `.skills` command writes none; a skill that cannot be had fails the call
 *   P8 a read through the sandbox path counts as a use, as a platform skill's does
 *   P9 none of it where the API did not send it, or in a run that acts as a user or is a router's/observer's turn
 *   P10 what was fetched is in a private directory under the run's work root, gone when the run ends
 *   P11 the sandbox's copy leaves with the run that wrote it (a sandbox outlives the run); a run that wrote none
 *       removes nothing
 *   P12 a skill's text goes to the model only: not into a log line or the turn's events
 *   P13 a skill changed between its SKILL.md and its files is refused whole, never served mixed
 *   P14 where the sandbox's shell cannot remove what `write` created (a per-run identity), the write goes on and the
 *       run empties every file it wrote instead
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startWorld, skillZip, fakeHands, baseRequest, type Turn } from "./support/platform-defaults-world.js";

const world = await startWorld({ skills: [{ tool_id: 31 }, { tool_id: 32 }] });
process.env.PROGRESSIVE_SKILLS_ENABLED = "true";
process.env.AUTH_INTERNAL_TOKEN = "internal-token-for-test";
world.setTools([
  { id: 31, name: "weekly-report", zip: skillZip("weekly-report", "PLATFORM-WR-BODY", "The platform's weekly report") },
  { id: 32, name: "fleet-default", zip: skillZip("fleet-default", "PLATFORM-FLEET-BODY", "Platform fleet helper") },
]);
const { AgentEngine } = await import("../src/agent/engine.js");
const { registry } = await import("../src/infra/metrics.js");
test.after(async () => { await world.close(); });

interface Stored {
  version: number; sha: string; description: string; invocation?: "auto" | "manual"; origin?: string | null;
  content: string; files?: Array<{ path: string; content: string; is_binary?: boolean }>;
}
const md = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

/** The user's skills as the API holds them. */
let store: Record<string, Stored> = {};
/** Every read Brain asked the API for. */
let reads: Array<Record<string, unknown>> = [];
let authHeaders: string[] = [];
function resetStore(): void {
  store = {
    "weekly-report": {
      version: 3, sha: "sha-wr-3", description: "Write the user's weekly report. Use when they ask for a weekly report or 周报.",
      content: md("weekly-report", "weekly", "WR-BODY-MARKER: end with -- by canary"),
      files: [{ path: "scripts/collect.sh", content: "echo COLLECT\n" }, { path: "assets/logo.png", content: PNG.toString("base64"), is_binary: true }],
    },
    "pr-notes": { version: 1, sha: "sha-pr-1", description: "Draft PR notes", origin: "import", content: md("pr-notes", "pr", "PR-BODY-MARKER") },
    "deploy-now": { version: 2, sha: "sha-dn-2", description: "Deploy to production", invocation: "manual", content: md("deploy-now", "deploy", "DEPLOY-BODY-MARKER") },
  };
  reads = [];
  authHeaders = [];
}
resetStore();

world.internal = (url, body, headers) => {
  if (url !== "/v1/internal/skills/read") return { status: 404, body: { ok: false, error: "not_found" } };
  reads.push(body);
  authHeaders.push(String(headers.authorization ?? ""));
  if (body.message_id !== "m-turn") return { status: 409, body: { ok: false, error: "no_live_turn" } };
  const s = store[String(body.name)];
  if (!s) return { status: 404, body: { ok: false, error: "not_found" } };
  if (body.content_sha && body.content_sha !== s.sha) return { status: 409, body: { ok: false, error: "changed", version: s.version, content_sha: s.sha } };
  const entry = { name: body.name, version: s.version, description: s.description, invocation: s.invocation ?? "auto", content_sha: s.sha, origin: s.origin ?? null };
  if (typeof body.path === "string") {
    const f = (s.files ?? []).find((x) => x.path === body.path);
    if (!f) return { status: 404, body: { ok: false, error: "not_found" } };
    return { status: 200, body: { ok: true, name: body.name, version: s.version, content_sha: s.sha, path: f.path, content: f.content, is_binary: !!f.is_binary, size_bytes: f.content.length } };
  }
  return { status: 200, body: { ok: true, ...entry, content: s.content, files: (s.files ?? []).map((f) => ({ path: f.path, size_bytes: f.content.length, is_binary: !!f.is_binary })) } };
};

/** The manifest the API sends with a turn: most recently used first. */
function manifest(names = Object.keys(store)) {
  return names.map((n) => ({
    name: n, version: store[n].version, description: store[n].description, invocation: store[n].invocation ?? "auto",
    content_sha: store[n].sha, origin: store[n].origin ?? null,
  }));
}

/** A recording Hands whose bash answers an `rm -rf ... && echo CLAW_RM_OK` as a sandbox does. */
function skillHands() {
  const h = fakeHands();
  return {
    ...h,
    async callTool(name: string, args: Record<string, unknown>) {
      h.calls.push({ name, args });
      return name === "bash" && String(args.command).includes("CLAW_RM_OK") ? "CLAW_RM_OK\n" : "ok";
    },
  };
}

let n = 0;
async function run(over: Record<string, unknown>, script: Turn[], hands: ReturnType<typeof fakeHands> = skillHands()) {
  const sessionId = `s-user-skills-${++n}`;
  let attached = 0;
  world.script(script);
  world.llmBodies.length = 0;
  const events: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const realWriteSync = fs.writeSync;
  const realWrite = fs.write;
  // pino writes to fd 1 with fs.write / fs.writeSync, not through process.stdout.
  fs.writeSync = ((fd: number, data: unknown, ...rest: unknown[]) => {
    if (fd === 1 || fd === 2) logs.push(String(data));
    return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
  }) as typeof fs.writeSync;
  fs.write = ((fd: number, data: unknown, ...rest: unknown[]) => {
    if (fd === 1 || fd === 2) logs.push(String(data));
    return (realWrite as (...a: unknown[]) => void)(fd, data, ...rest);
  }) as typeof fs.write;
  try {
    const result = await new AgentEngine().execute(
      baseRequest({ session_id: sessionId, message_id: "m-turn", user_skills_enabled: true, user_skills: manifest(), ...over }),
      (async (e: Record<string, unknown>) => { events.push(e); }) as never, undefined, null as never,
      { attachHands: async () => { attached++; return hands as never; } } as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { sessionId, attached, calls: hands.calls, prompt: world.llmBodies[0] ?? "", bodies: [...world.llmBodies], result, events, logs: logs.join("") };
  } finally {
    fs.writeSync = realWriteSync;
    fs.write = realWrite;
  }
}

async function counter(name: string, labels: Record<string, string>): Promise<number> {
  const m = await registry.getSingleMetric(name)!.get();
  return m.values.filter((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val)).reduce((a, v) => a + v.value, 0);
}

test("P1 listed under their own heading, most recently used first, no text; manual not listed; imported marked", async () => {
  resetStore();
  const r = await run({}, [{ text: "done" }]);
  assert.match(r.prompt, /Personal Skills \(the user's own/);
  assert.match(r.prompt, /- weekly-report: Write the user's weekly report\. Use when they ask for a weekly report or 周报\./);
  assert.match(r.prompt, /- pr-notes \(imported\): Draft PR notes/);
  assert.ok(r.prompt.indexOf("- weekly-report:") < r.prompt.indexOf("- pr-notes"), "the API's order: most recently used first");
  assert.ok(r.prompt.indexOf("Platform Skills") < r.prompt.indexOf("Personal Skills"), "after the platform's");
  assert.equal(r.prompt.includes("deploy-now"), false, "a manual skill is never listed");
  for (const body of ["WR-BODY-MARKER", "PR-BODY-MARKER", "DEPLOY-BODY-MARKER"]) assert.equal(r.prompt.includes(body), false, `${body} is not in the prompt`);
  assert.deepEqual(reads, [], "nothing is read from the API for a turn that uses no skill");
  assert.equal(r.attached, 0, "and no sandbox is opened");
  assert.ok(/"name":"load_skill"/.test(r.prompt), "load_skill is offered");
  assert.ok(r.prompt.includes("or a personal skill the user names"), "and says it loads personal skills");
});

test("P2 load_skill reads from the API with the turn's fingerprint, once; manual loads by name; counted and reported used", async () => {
  resetStore();
  const okBefore = await counter("claw_user_skill_read_total", { role: "worker", outcome: "ok" });
  const r = await run({}, [
    { tool: "load_skill", input: { name: "weekly-report" } },
    { tool: "load_skill", input: { name: "weekly-report", file: "scripts/collect.sh" } },
    { tool: "load_skill", input: { name: "weekly-report" } },
    { tool: "load_skill", input: { name: "deploy-now" } },
    { text: "done" },
  ]);
  const [, afterLoad, afterFile, , afterManual] = r.bodies;
  assert.ok(afterLoad.includes("WR-BODY-MARKER"), "SKILL.md is served");
  assert.ok(afterLoad.includes("the user's personal skill, version 3"), "and said to be the user's");
  assert.ok(afterLoad.includes("- scripts/collect.sh") && afterLoad.includes("- assets/logo.png"), "with its files listed");
  assert.ok(afterLoad.includes("/workspace/.skills/.personal-skills/weekly-report/"), "and where its scripts run");
  assert.ok(afterFile.includes("echo COLLECT"), "a file of it is served");
  assert.ok(afterManual.includes("DEPLOY-BODY-MARKER"), "a manual skill is loaded when named");
  const wr = reads.filter((b) => b.name === "weekly-report");
  assert.deepEqual(wr.map((b) => b.path ?? "SKILL.md").sort(), ["SKILL.md", "assets/logo.png", "scripts/collect.sh"], "staged once: SKILL.md and each file, no second fetch");
  for (const b of reads) {
    assert.equal(b.session_id, r.sessionId);
    assert.equal(b.message_id, "m-turn");
    assert.equal(b.content_sha, store[String(b.name)].sha, "the fingerprint the turn was told");
  }
  assert.ok(authHeaders.length > 0 && authHeaders.every((h) => h === "Bearer internal-token-for-test"), "with the internal token");
  assert.equal(r.attached, 0, "no sandbox");
  assert.deepEqual(r.result.skillsUsed, { "weekly-report": 3, "deploy-now": 2 }, "reported used at the turn's version");
  assert.equal(await counter("claw_user_skill_read_total", { role: "worker", outcome: "ok" }) - okBefore, 3, "each read of a SKILL.md counted");
});

test("P3 an imported skill is wrapped as a third party's text", async () => {
  resetStore();
  const r = await run({}, [{ tool: "load_skill", input: { name: "pr-notes" } }, { text: "done" }]);
  const second = r.bodies[1];
  assert.ok(second.includes("PR-BODY-MARKER"));
  assert.match(second, /The following is from a third-party skill the user imported \('pr-notes'\)/);
  assert.ok(second.indexOf("third-party skill") < second.indexOf("PR-BODY-MARKER"), "said before the text");
  assert.match(second, /imported from a third party/);
});

test("P4 changed during the turn or gone: the model is told, gets none of it, and it is counted not_found", async () => {
  resetStore();
  const before = await counter("claw_user_skill_read_total", { role: "worker", outcome: "not_found" });
  const sent = manifest();
  store["weekly-report"] = { ...store["weekly-report"], version: 4, sha: "sha-wr-4", content: md("weekly-report", "w", "WR-V4-BODY") };
  delete store["pr-notes"];
  const r = await run({ user_skills: sent }, [
    { tool: "load_skill", input: { name: "weekly-report" } },
    { tool: "load_skill", input: { name: "pr-notes" } },
    { text: "done" },
  ]);
  assert.match(r.bodies[1], /changed it after this message was sent/);
  assert.equal(r.bodies[1].includes("WR-V4-BODY") || r.bodies[1].includes("WR-BODY-MARKER"), false, "neither version");
  assert.match(r.bodies[2], /no longer exists/);
  assert.equal(await counter("claw_user_skill_read_total", { role: "worker", outcome: "not_found" }) - before, 2);
  assert.deepEqual(r.result.skillsUsed, {}, "not reported used");
});

test("P5 a personal skill replaces the platform default of its name, and is said to; the request's plugin replaces the personal one", async () => {
  resetStore();
  const r = await run({}, [{ tool: "load_skill", input: { name: "weekly-report" } }, { text: "done" }]);
  assert.equal(r.prompt.includes("The platform's weekly report"), false, "the default is not listed");
  assert.match(r.prompt, /personal skill 'weekly-report' replaces the platform skill of the same name/);
  assert.match(r.prompt, /fleet-default: Platform fleet helper/, "other defaults stay");
  assert.ok(r.bodies[1].includes("WR-BODY-MARKER") && !r.bodies[1].includes("PLATFORM-WR-BODY"), "load_skill serves the personal one");

  // A skill the request itself carries (what the caller passed for this turn) is what the name means.
  resetStore();
  const p = await run({ skills: { "weekly-report": { content: "REQUEST-WR-BODY", enabled: true } } }, [{ tool: "load_skill", input: { name: "weekly-report" } }, { text: "done" }]);
  assert.equal(p.prompt.includes("Write the user's weekly report"), false, "the personal one is not listed");
  assert.ok(p.prompt.includes("REQUEST-WR-BODY"), "the request's is used");
  assert.equal(reads.some((b) => b.name === "weekly-report"), false, "and the personal one is never read");
  assert.equal(p.bodies[1].includes("WR-BODY-MARKER"), false);
});

test("P6 the list's share: platform skills keep their place beside many personal skills; the rest are counted, said and loadable", async () => {
  resetStore();
  for (let i = 0; i < 40; i++) {
    const name = `mine-${String(i).padStart(2, "0")}`;
    store[name] = { version: 1, sha: `sha-${name}`, description: `${name} ${"d".repeat(250)}`, content: md(name, "x", `BODY-${name}`) };
  }
  const truncBefore = await counter("claw_user_skill_truncated_total", { role: "worker" });
  const r = await run({}, [{ tool: "load_skill", input: { name: "mine-39" } }, { text: "done" }]);
  assert.match(r.prompt, /fleet-default: Platform fleet helper/, "the platform's skill is still listed");
  const listed = Object.keys(store).filter((k) => k.startsWith("mine-") && r.prompt.includes(`- ${k}: `));
  assert.ok(listed.length > 0 && listed.length < 40, `some listed (${listed.length})`);
  assert.deepEqual(listed, listed.slice().sort(), "a prefix of the API's order");
  const line = r.prompt.slice(r.prompt.indexOf(`- ${listed[0]}: `)).split("\\n")[0];
  const desc = line.slice(`- ${listed[0]}: `.length);
  assert.ok(desc.endsWith("…") && desc.length === 200, `a description is listed at most 200 characters (${desc.length})`);
  const omitted = 40 + 2 - listed.length - 2; // weekly-report and pr-notes come first and fit
  assert.match(r.prompt, new RegExp(`\\(${omitted} more of the user's personal skills not listed; when the user names one, load it with load_skill by that name\\)`));
  assert.equal(await counter("claw_user_skill_truncated_total", { role: "worker" }) - truncBefore, omitted);
  assert.ok(r.bodies[1].includes("BODY-mine-39"), "one not listed is still loaded by name");
});

test("P7 written into the sandbox only when a command names it, before that command; binary as binary; a bare .skills writes none", async () => {
  resetStore();
  const hands = skillHands();
  const r = await run({}, [
    { tool: "bash", input: { command: "ls /workspace/.skills" } },
    { tool: "bash", input: { command: "bash /workspace/.skills/.personal-skills/weekly-report/scripts/collect.sh" } },
    { tool: "bash", input: { command: "bash /workspace/.skills/.personal-skills/weekly-report/scripts/collect.sh" } },
    { text: "done" },
  ], hands);
  const writes = r.calls.map((c, at) => ({ at, c })).filter(({ c }) => c.name === "write" && String(c.args.path).includes(".personal-skills"));
  const bashes = r.calls.map((c, at) => ({ at, c })).filter(({ c }) => c.name === "bash" && !String(c.args.command).startsWith("rm -rf"));
  assert.deepEqual(writes.map(({ c }) => String(c.args.path)).sort(), [
    ".skills/.personal-skills/weekly-report/SKILL.md",
    ".skills/.personal-skills/weekly-report/assets/logo.png",
    ".skills/.personal-skills/weekly-report/scripts/collect.sh",
  ], "only the named skill, once");
  assert.ok(writes.every(({ at }) => at > bashes[0].at && at < bashes[1].at), "after the bare ls, before the command that names it");
  const png = writes.find(({ c }) => String(c.args.path).endsWith("logo.png"))!.c.args;
  assert.equal(png.encoding, "base64");
  assert.equal(png.contents, PNG.toString("base64"), "the bytes the API holds");
  assert.ok(String(writes.find(({ c }) => String(c.args.path).endsWith("SKILL.md"))!.c.args.contents).includes("WR-BODY-MARKER"));

  // A skill the API no longer has: the call that needs it is not run, and the model is told why.
  resetStore();
  const sent = manifest();
  delete store["pr-notes"];
  const h2 = skillHands();
  const f = await run({ user_skills: sent }, [{ tool: "bash", input: { command: "cat /workspace/.skills/.personal-skills/pr-notes/SKILL.md" } }, { text: "done" }], h2);
  assert.match(f.bodies[1], /Failed to write personal skill 'pr-notes' into the sandbox; this call was not run/);
  assert.equal(h2.calls.some((c) => c.name === "bash" && String(c.args.command).includes("pr-notes")), false, "the command did not run");
});

test("P8 a read through the sandbox path counts as a use of the personal skill, a name from before the kebab-case rule too", async () => {
  resetStore();
  store["Old_notes.v1"] = { version: 5, sha: "sha-old", description: "Old notes", content: md("Old_notes.v1", "o", "OLD-BODY") };
  const r = await run({}, [
    { tool: "read", input: { path: "/workspace/.skills/.personal-skills/weekly-report/SKILL.md" } },
    { tool: "read", input: { path: "/workspace/.skills/.personal-skills/Old_notes.v1/SKILL.md" } },
    { text: "done" },
  ]);
  assert.deepEqual(r.result.skillsUsed, { "weekly-report": 3, "Old_notes.v1": 5 });
});

test("P9 none of it where the API did not send it, or in a run that acts as a user, or a router's or observer's turn", async () => {
  for (const over of [
    { user_skills_enabled: false },
    { user_skills_enabled: undefined },
    { withhold_sandbox_keys: true },
    { skip_platform_defaults: true },
  ]) {
    resetStore();
    const r = await run(over, [{ tool: "load_skill", input: { name: "weekly-report" } }, { text: "done" }]);
    assert.equal(r.prompt.includes("Personal Skills"), false, `${JSON.stringify(over)}: no list, and load_skill's description does not mention them`);
    if (/"name":"load_skill"/.test(r.prompt)) {
      assert.ok(r.prompt.includes("Load a skill listed under 'Platform Skills' in the prompt: with only `name`"), `${JSON.stringify(over)}: load_skill described as before`);
    }
    assert.equal(r.prompt.includes("Write the user's weekly report"), false);
    assert.equal(r.bodies[1].includes("WR-BODY-MARKER"), false, `${JSON.stringify(over)}: not served`);
    assert.deepEqual(reads, [], `${JSON.stringify(over)}: nothing read from the API`);
  }
});

test("P10 what was fetched is in a private directory under the run's work root, and gone when the run ends", async () => {
  resetStore();
  const sid = `s-user-skills-${n + 1}`;
  const root = path.join(os.tmpdir(), "claw-plugin-work", sid, "user-skills");
  let during: { mode: number; files: string[] } | null = null;
  const r = await run({}, [
    { tool: "load_skill", input: { name: "weekly-report" } },
    () => {
      const dirs = fs.readdirSync(root).filter((d) => d.startsWith("run-"));
      assert.equal(dirs.length, 1, "one staged copy");
      const dir = path.join(root, dirs[0]);
      during = { mode: fs.statSync(dir).mode & 0o777, files: fs.readdirSync(dir).sort() };
      return { text: "done" };
    },
  ]);
  assert.equal(r.sessionId, sid);
  assert.ok(during, "seen during the run");
  assert.equal(during!.mode & 0o077, 0, "a private directory");
  assert.deepEqual(during!.files, ["SKILL.md", "assets", "scripts"]);
  assert.equal(fs.existsSync(path.join(os.tmpdir(), "claw-plugin-work", sid)), false, "gone with the run");
});

// --- P5b: the bound repository's skill of the same name ---------------------------------------

const REPO_URL = "https://github.com/example-org/example-repo";
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

/** A sandbox that has bound the repository before; the repository carries skills `weekly-report` and `fmt`. */
function boundHands() {
  const h = fakeHands();
  return {
    ...h,
    async callToolFull(name: string, args: Record<string, unknown>) {
      h.calls.push({ name, args });
      const c = String(args.command ?? args.path ?? "");
      if (/CLAW_REPO_STATE/.test(c)) {
        return { isError: false, text: [
          "CLAW_REPO_CRED=ok", "CLAW_REPO_STATE=git", `CLAW_REPO_ORIGIN_HEX=${hex(REPO_URL)}`, "CLAW_REPO_BOUND=yes",
          "CLAW_REPO_BRANCH=main", "CLAW_REPO_HEAD=abc1234", "CLAW_REPO_CHANGED=0",
          `@@CLAW-REPO-SKILL ${hex(".claude/skills/weekly-report")}@@${hex(md("weekly-report", "THE REPOSITORY'S WEEKLY", "REPO-WR-BODY"))}`,
          `@@CLAW-REPO-SKILL ${hex(".claude/skills/fmt")}@@${hex(md("fmt", "Format the code", "REPO-FMT-BODY"))}`,
        ].join("\n") };
      }
      return { isError: false, text: "" };
    },
  };
}

test("P5b a personal skill replaces the bound repository's skill of its name; the repository's others stay", async () => {
  resetStore();
  const r = await run({ repo: { url: REPO_URL } }, [{ tool: "load_skill", input: { name: "weekly-report" } }, { text: "done" }], boundHands() as never);
  assert.equal(r.prompt.includes("THE REPOSITORY'S WEEKLY"), false, "the repository's is not listed");
  assert.match(r.prompt, /fmt: \[repository\] Format the code/, "its other skills are");
  assert.match(r.prompt, /- weekly-report: Write the user's weekly report/);
  assert.ok(r.bodies[1].includes("WR-BODY-MARKER") && !r.bodies[1].includes("REPO-WR-BODY"), "load_skill serves the personal one");
});

test("P11 the sandbox's copy leaves with the run that wrote it; it is written from a clean directory; a run that wrote none removes nothing", async () => {
  resetStore();
  const r = await run({}, [
    { tool: "bash", input: { command: "bash /workspace/.skills/.personal-skills/weekly-report/scripts/collect.sh" } },
    { text: "done" },
  ]);
  const at = (pred: (c: { name: string; args: Record<string, unknown> }) => boolean) => r.calls.findIndex(pred);
  const cleanSkill = at((c) => c.name === "bash" && String(c.args.command) === "rm -rf -- '/workspace/.skills/.personal-skills/weekly-report' && echo CLAW_RM_OK");
  const firstWrite = at((c) => c.name === "write" && String(c.args.path).includes(".personal-skills/weekly-report"));
  const script = at((c) => c.name === "bash" && String(c.args.command).includes("collect.sh") && !String(c.args.command).startsWith("rm"));
  const removeAll = r.calls.map((c) => String(c.args.command ?? "")).lastIndexOf("rm -rf -- '/workspace/.skills/.personal-skills' && echo CLAW_RM_OK");
  assert.ok(cleanSkill >= 0 && cleanSkill < firstWrite, "the skill's directory is emptied before it is written");
  assert.ok(script > firstWrite, "the command runs after the write");
  assert.ok(removeAll > script, "and every personal skill is taken out of the sandbox when the run ends");
  assert.equal(removeAll, r.calls.length - 1, "as the run's last sandbox call");

  resetStore();
  const none = await run({}, [{ tool: "bash", input: { command: "ls /workspace" } }, { text: "done" }]);
  assert.equal(none.attached, 1);
  assert.equal(none.calls.some((c) => String(c.args.command ?? "").startsWith("rm -rf")), false, "nothing to take out: no extra call");
});

test("P12 a personal skill's text goes to the model only: not into a log line or the turn's events", async () => {
  resetStore();
  const r = await run({}, [
    { tool: "load_skill", input: { name: "weekly-report" } },
    { tool: "load_skill", input: { name: "weekly-report", file: "scripts/collect.sh" } },
    { text: "done" },
  ]);
  assert.ok(r.bodies[1].includes("WR-BODY-MARKER"), "the model has it");
  assert.equal(r.logs.includes("WR-BODY-MARKER"), false, "no log line has it");
  assert.equal(r.logs.includes("echo COLLECT"), false, "nor a file of it");
  assert.match(r.logs, /\[personal skill 'weekly-report': \d+ chars loaded\]/, "the log says what was loaded");
  const used = r.events.filter((e) => e.type === "toolUsed" && e.tool === "load_skill" && e.status === "success");
  assert.equal(used.length, 2);
  assert.equal(JSON.stringify(used).includes("WR-BODY-MARKER") || JSON.stringify(used).includes("echo COLLECT"), false, "no event has it");
  assert.match(String(used[1].description), /\[personal skill 'weekly-report', file 'scripts\/collect\.sh': \d+ chars loaded\]/);
});

test("P13 a skill changed between its SKILL.md and its files is refused whole, never served mixed", async () => {
  resetStore();
  const inner = world.internal!;
  world.internal = (url, body, headers) => {
    const out = inner(url, body, headers);
    // The user saves a new version right after Brain read SKILL.md.
    if (body.name === "weekly-report" && body.path === undefined) {
      store["weekly-report"] = { ...store["weekly-report"], version: 4, sha: "sha-wr-4", content: md("weekly-report", "w", "WR-V4-BODY") };
    }
    return out;
  };
  try {
    const r = await run({}, [{ tool: "load_skill", input: { name: "weekly-report" } }, { text: "done" }]);
    assert.match(r.bodies[1], /changed it after this message was sent/);
    assert.equal(r.bodies[1].includes("WR-BODY-MARKER") || r.bodies[1].includes("WR-V4-BODY"), false, "neither version");
    assert.deepEqual(r.result.skillsUsed, {});
  } finally {
    world.internal = inner;
  }
});

test("P14 where the sandbox's shell cannot remove the copy, the write goes on, and every file under .personal-skills is emptied, an earlier run's too", async () => {
  resetStore();
  const h = fakeHands();
  const ROOT = "/workspace/.skills/.personal-skills";
  // What an interrupted earlier run left: a file the current version no longer has, and a skill since deleted.
  const leftover = [`${ROOT}/weekly-report/old-notes.md`, `${ROOT}/gone-skill/SKILL.md`];
  const denied = {
    ...h,
    async callTool(name: string, args: Record<string, unknown>) {
      h.calls.push({ name, args });
      const cmd = String(args.command ?? "");
      // A shell under a per-run identity: what the sandbox's own `write` created is not its to remove, but it can list it.
      if (name === "bash" && cmd.startsWith("rm -rf")) return "exit 1\nstdout: \nstderr: rm: cannot remove: Permission denied";
      if (name === "bash" && cmd.includes("CLAW_LS_BEGIN")) {
        const dir = cmd.match(/find '([^']+)'/)![1];
        return `CLAW_LS_BEGIN\n${leftover.filter((f) => f.startsWith(`${dir}/`)).join("\n")}\nCLAW_LS_END\n`;
      }
      return "ok";
    },
  };
  const r = await run({}, [
    { tool: "bash", input: { command: "bash /workspace/.skills/.personal-skills/weekly-report/scripts/collect.sh" } },
    { text: "done" },
  ], denied as never);
  const calls = r.calls.map((c, at) => ({ c, at }));
  const script = calls.find(({ c }) => c.name === "bash" && String(c.args.command).includes("collect.sh") && !String(c.args.command).startsWith("rm"))!.at;
  const uploads = calls.filter(({ c }) => c.name === "write" && c.args.contents !== "");
  const emptied = calls.filter(({ c }) => c.name === "write" && c.args.contents === "");
  assert.ok(script > 0, "the command ran: a copy that could not be removed first does not fail it");
  const before = emptied.filter(({ at }) => at < uploads[0].at).map(({ c }) => String(c.args.path));
  assert.deepEqual(before, [`${ROOT}/weekly-report/old-notes.md`], "before the write: the older version's file is emptied");
  const after = emptied.filter(({ at }) => at > script).map(({ c }) => String(c.args.path)).sort();
  assert.deepEqual(after, [
    `${ROOT}/gone-skill/SKILL.md`,
    `${ROOT}/weekly-report/SKILL.md`,
    `${ROOT}/weekly-report/assets/logo.png`,
    `${ROOT}/weekly-report/old-notes.md`,
    `${ROOT}/weekly-report/scripts/collect.sh`,
  ], "when the run ends: every file there, this run's and an earlier one's");
});
