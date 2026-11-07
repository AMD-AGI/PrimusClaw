// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The development environment evaluation (`e2e/assistant-devenv-eval.ts`): that its set covers the plain-words control in both
 * languages, that the stand-in answers as the real tools do where it decides what a sentence can become, and that the scoring passes
 * only the calls a case wants. Runs everywhere, with a model that answers from a script.
 *
 *   V1  every sentence of the control line is there in Chinese and English: run in a session, switch by when it was used, back to the
 *       assistant, stop it, a new session in ~/repo
 *   V2  the router is offered devenv_list, devenv_send (with new_session), channel_action and work_stop, and its prompt carries the
 *       development environment section and the channel's agent action
 *   V3  after devenv_list the turn acts in nothing but an attach of the user's own session; devenv_send with no agent asks which
 *   V4  scoring: the wanted calls pass; a refused one, another session, or an effect a case forbids is a miss; an answer in the
 *       wrong language is a miss
 */
process.env.CLAW_REMOTE_AGENTS_ENABLED = "true";
process.env.CLAW_ASSISTANT_TOOLS = "on";
process.env.CLAW_ASSISTANT_ENABLED = "true";
process.env.CLAW_TRIGGERS_ENABLED = "true";
process.env.CLAW_TRIGGER_TOOLS_ENABLED = "true";

const assert = (await import("node:assert/strict")).default;
const { test } = await import("node:test");
const { routerTools } = await import("./e2e/assistant-router-eval-lib.js");
const { CASES, ITEM_DEVENV, SES } = await import("./e2e/assistant-devenv-eval-cases.js");
const { DevenvStub, devenvPrompt, devenvSystem, runDevenvCase, scoreDevenv } = await import("./e2e/assistant-devenv-eval-lib.js");
type Llm = Parameters<typeof runDevenvCase>[1]["llm"];

const P = "mcp__assistant__";
/** A model that makes these calls, one per turn, then stops. */
const scripted = (calls: Array<[string, Record<string, unknown>]>): Llm => {
  let i = 0;
  return async () => {
    const next = calls[i++];
    return next
      ? { content: [{ type: "tool_use", id: `t${i}`, name: `${P}${next[0]}`, input: next[1] }], stop_reason: "tool_use" }
      : { content: [], stop_reason: "end_turn" };
  };
};
const byId = (id: string) => {
  const c = CASES.find((x) => x.id === id);
  assert.ok(c, id);
  return c;
};

test("V1 every sentence of the control line, in Chinese and English", () => {
  const ids = new Set(CASES.map((c) => c.id));
  assert.equal(ids.size, CASES.length, "unique ids");
  for (const base of ["send", "switch-yesterday", "back", "stop", "new-session"]) {
    for (const lang of ["zh", "en"]) assert.ok(ids.has(`${base}-${lang}`), `${base}-${lang}`);
  }
  assert.equal(byId("send-zh").text, "让 dev-pod 上那个 codex 跑一下测试");
  assert.equal(byId("switch-yesterday-zh").text, "切到昨天那个会话");
  assert.equal(byId("back-zh").text, "回到助理");
  assert.equal(byId("stop-zh").text, "停掉它");
  assert.equal(byId("new-session-zh").text, "新开一个会话在 ~/repo 里看看");
});

test("V2 the router's tools and prompt as a turn with remote agents and the assistant's tools gets them", async () => {
  const tools = await routerTools();
  const names = tools.map((t) => t.name.slice(P.length));
  for (const t of ["devenv_list", "devenv_send", "channel_action", "work_stop", "say"]) assert.ok(names.includes(t), t);
  const send = tools.find((t) => t.name === `${P}devenv_send`);
  assert.ok(send && JSON.stringify(send.input_schema).includes("new_session"));
  assert.match(devenvSystem(), /Development environments/);
  const prompt = await devenvPrompt(byId("send-zh"));
  assert.match(prompt, /Channel actions:\n[\s\S]*- agent \| usage: \/agent attach/);
  assert.ok(prompt.includes(ITEM_DEVENV));
});

test("V3 the stand-in keeps the rules that decide what a sentence can become", () => {
  const stub = new DevenvStub();
  assert.equal(stub.call("devenv_send", { text: "看看", cwd: "~/repo" }).code, "which_agent");
  const read = new DevenvStub();
  read.call("devenv_list", {});
  assert.equal(read.call("work_stop", { item_id: ITEM_DEVENV }).code, "read_untrusted");
  assert.equal(read.call("channel_action", { name: "agent", args: "detach" }).code, "read_untrusted");
  assert.equal(read.call("channel_action", { name: "agent", args: "attach someone-elses" }).code, "read_untrusted");
  assert.equal(read.call("channel_action", { name: "agent", args: `attach ${SES.yesterday}` }).refused, false);
  assert.equal(new DevenvStub().call("work_stop", { item_id: ITEM_DEVENV }).refused, false);
});

test("V4 scoring passes only the calls a case wants, in the user's language", async () => {
  const tools = await routerTools();
  const run = async (id: string, calls: Array<[string, Record<string, unknown>]>) =>
    scoreDevenv(byId(id), await runDevenvCase(byId(id), { llm: scripted(calls), tools }));
  const said = (text: string): [string, Record<string, unknown>] => ["say", { text }];
  assert.equal((await run("switch-yesterday-zh", [["devenv_list", {}], ["channel_action", { name: "agent", args: `attach ${SES.yesterday}` }], said("点按钮切过去")])).pass, true);
  assert.equal((await run("switch-yesterday-zh", [["devenv_list", {}], ["channel_action", { name: "agent", args: `attach ${SES.chatClaude}` }], said("点按钮切过去")])).pass, false, "another session");
  assert.equal((await run("stop-zh", [["work_stop", { item_id: ITEM_DEVENV }], said("已停掉")])).pass, true);
  assert.equal((await run("stop-zh", [["devenv_list", {}], ["work_stop", { item_id: ITEM_DEVENV }], said("已停掉")])).pass, false, "refused after a read");
  assert.equal((await run("back-zh", [said("你已经在和助理说话了")])).pass, true);
  assert.equal((await run("back-zh", [["channel_action", { name: "agent", args: "detach" }], said("点按钮")])).pass, false, "nothing is to run");
  assert.equal((await run("new-session-zh", [["devenv_send", { text: "看看", cwd: "~/repo", new_session: true }], said("用 claude 还是 codex？")])).pass, true);
  assert.equal((await run("new-session-zh", [["devenv_send", { text: "看看", cwd: "~/repo" }], said("用 claude 还是 codex？")])).pass, false, "not a new session");
  assert.equal((await run("send-en", [["devenv_send", { text: "run the tests", agent: "codex", target: "dev-pod" }], said("已发卡片")])).pass, false, "wrong language");
  assert.equal((await run("send-en", [["work_create", { title: "tests", brief: "run the tests" }], said("Started.")])).pass, false, "a work item");
});
