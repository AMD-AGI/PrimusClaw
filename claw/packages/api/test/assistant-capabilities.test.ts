// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the assistant can and cannot do, generated (`assistant/capabilities.ts`, `claw_capabilities`), and how an answer about it is
 * graded (`test/e2e/self-knowledge.ts`).
 *
 *   K1  every ability is on with its feature and its tools, and each feature or tool taken away turns exactly its entry off
 *   K2  the review mode says how a merge goes; limits are data, lifted by a system that provides them; the chat apps are listed
 *   K3  every tool the router's server can register is classified by how it takes effect, and the tool lists what that server offers
 *   K4  the router is told to call claw_capabilities first for any question about itself, and that its own tools act by themselves
 *   K5  the four false limits of 2026-11-23 are contradictions against a list that has those abilities, and none against one that lacks them
 *   K6  a claim of an ability the list has off is a contradiction; a plain answer about other things is none; the detectors name real entries
 *
 * The configuration is set before the source is imported: every switch on, so the router's server registers every tool it can.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

Object.assign(process.env, {
  CLAW_ASSISTANT_ENABLED: "true", CLAW_ASSISTANT_TOOLS: "on", CLAW_ASSISTANT_MEMORY_TOOLS: "on", CLAW_ASSISTANT_GITHUB_EVENTS: "true",
  CLAW_ASSISTANT_JOB_EVENTS: "true", CLAW_REMOTE_AGENTS_ENABLED: "true", CLAW_USER_SKILLS_ENABLED: "true", CLAW_ASSISTANT_MODEL_CHOICE: "on",
  CLAW_ASSISTANT_SELF_STATUS: "true", CLAW_GITHUB_REVIEW_ENABLED: "true", CLAW_MEMORY_ENABLED: "true", CLAW_TRIGGERS_ENABLED: "true",
  CLAW_TRIGGER_TOOLS_ENABLED: "true", CLAW_ASSISTANT_MODELS: "model-a=default,model-b=fast",
});

const caps = await import("../src/assistant/capabilities.js");
const { createAssistantMcpServer, recordToolNames, routerToolNames } = await import("../src/assistant/mcp.js");
const { renderRouterSelfSection, ROUTER_SELF_PROMPT_VERSION } = await import("../src/assistant/self-status.js");
const { renderRouterAbilities } = await import("../src/assistant/prompts.js");
const { contradictedClaims, DETECTOR_ENTRY_IDS } = await import("./e2e/self-knowledge.js");

type Inputs = Parameters<typeof caps.capabilityList>[0];

const ALL_ON: Inputs["features"] = {
  review_tools: true, github_review: true, review_items: true, github_events: true, memory: true, remote_agents: true, triggers: true, job_watch: true,
  files_and_images: true, user_skills: true, github_poll_sec: 30, job_poll_sec: 30, images_per_message: 4,
};
const EVERY_TOOL = Object.keys(caps.TOOL_EFFECTS);
const WEB_BOTH = { search: true, fetch: true };

function inputs(over: Partial<Inputs> = {}): Inputs {
  return {
    tools: EVERY_TOOL, features: ALL_ON, lookups: { web: WEB_BOTH, github: true, systems: ["safe", "agent-board"] },
    reviewMode: "high_risk_confirm", userMemory: { enabled: true, here: true }, channels: ["teams"], ...over,
  };
}
const on = (list: ReturnType<typeof caps.capabilityList>, id: string): boolean | undefined =>
  [...list.abilities, ...list.limits].find((e) => e.id === id)?.on;
const onIds = (list: ReturnType<typeof caps.capabilityList>): string[] => list.abilities.filter((a) => a.on).map((a) => a.id);

test("K1 every ability is on with its feature and its tools, and taking one away turns exactly that entry off", () => {
  const full = caps.capabilityList(inputs());
  assert.equal(full.version, "capabilities-v2");
  assert.deepEqual(full.abilities.filter((a) => !a.on).map((a) => a.id), [], "everything on");
  assert.match(full.abilities.find((a) => a.id === "see_images")!.what, /Images sent with a message are shown to you \(up to 4 per message\)/);
  assert.match(full.abilities.find((a) => a.id === "watch_pull_requests")!.what, /in the background.*read every 30 s/);
  assert.match(full.abilities.find((a) => a.id === "look_up")!.what, /search the web \(web_search\); read a web page at an address \(web_fetch\); the user's GitHub .*these systems: safe, agent-board\.$/);
  assert.deepEqual(full.abilities.find((a) => a.id === "look_up")!.tools, ["web_search", "web_fetch", "github", "safe", "agent-board"]);

  // Each switch off: its entry, and nothing else, goes off (the tool may still be listed: the switch decides).
  const features: Array<[keyof Inputs["features"], string]> = [
    ["files_and_images", "see_images"], ["github_events", "watch_pull_requests"], ["job_watch", "watch_jobs"], ["triggers", "scheduled_tasks"],
    ["memory", "memory"], ["review_tools", "reviews"], ["github_review", "reviews"], ["review_items", "reviews"], ["remote_agents", "dev_environments"], ["user_skills", "personal_skills"],
  ];
  for (const [feature, id] of features) {
    const list = caps.capabilityList(inputs({ features: { ...ALL_ON, [feature]: false } }));
    assert.deepEqual(list.abilities.filter((a) => !a.on).map((a) => a.id), [id], `${feature} off`);
  }
  // Each tool's absence: the ability it is the only evidence of goes off.
  const tools: Array<[string[], string]> = [
    [["work_subscribe"], "watch_pull_requests"], [["job_watch"], "watch_jobs"], [["trigger_create", "brief"], "scheduled_tasks"],
    [["memory_save", "memory_recall"], "memory"], [["review_start"], "reviews"], [["work_recall", "pr_state"], "check_work"],
    [["work_create", "work_send", "work_stop"], "hand_off_work"], [["claw_self_status"], "self_status"], [["github_comment"], "github_comment"],
    [["deliver_text"], "deliver_files"], [["model_default_set"], "model_choice"],
  ];
  for (const [gone, id] of tools) {
    const list = caps.capabilityList(inputs({ tools: EVERY_TOOL.filter((t) => !gone.includes(t)) }));
    assert.deepEqual(list.abilities.filter((a) => !a.on).map((a) => a.id), [id], `without ${gone.join(", ")}`);
  }
  // One of two tools is enough, and the entry names the one there is.
  const half = caps.capabilityList(inputs({ tools: EVERY_TOOL.filter((t) => t !== "pr_state") }));
  assert.equal(on(half, "check_work"), true);
  assert.deepEqual(half.abilities.find((a) => a.id === "check_work")!.tools, ["work_recall"]);
  assert.doesNotMatch(half.abilities.find((a) => a.id === "check_work")!.what, /pr_state/);
  // No lookups at all: nothing to look up with.
  assert.equal(on(caps.capabilityList(inputs({ lookups: { web: { search: false, fetch: false }, github: false, systems: [] } })), "look_up"), false);
  // A router with only the base tools (every switch off): what is on is what those tools do.
  const bare = caps.capabilityList(inputs({
    tools: ["say", "deliver_text", "work_create", "work_send", "work_stop", "work_recall", CAPABILITIES_TOOL()],
    features: Object.fromEntries(Object.entries(ALL_ON).map(([k, v]) => [k, typeof v === "boolean" ? false : v])) as Inputs["features"],
  }));
  assert.deepEqual(onIds(bare), ["look_up", "hand_off_work", "check_work", "deliver_files"]);
});

function CAPABILITIES_TOOL(): string { return caps.CAPABILITIES_TOOL; }

test("K2 the review mode says how a merge goes, limits are data a system lifts, and the chat apps are listed", () => {
  const auto = caps.capabilityList(inputs({ reviewMode: "fully_auto" }));
  assert.deepEqual(auto.review_mode?.mode, "fully_auto");
  assert.match(auto.review_mode!.means, /happens once the review approves, without asking them/);
  assert.match(auto.abilities.find((a) => a.id === "reviews")!.what, /fully_auto: a merge asked for happens once the review approves, without asking them/);
  const careful = caps.capabilityList(inputs());
  assert.match(careful.review_mode!.means, /waits for the user's confirmation/);
  assert.equal(caps.capabilityList(inputs({ features: { ...ALL_ON, review_tools: false } })).review_mode, null, "no reviews, no mode to tell");

  assert.deepEqual(careful.limits.map((l) => [l.id, l.on]), [
    ["email", false], ["calendar", false], ["documents", false], ["voice", false], ["other_chat_apps", false],
  ]);
  assert.match(careful.limits.find((l) => l.id === "other_chat_apps")!.what, /^Only in teams: not in other chat apps/);
  const mail = caps.capabilityList(inputs({ lookups: { web: WEB_BOTH, github: true, systems: ["outlook-mail"] } }));
  assert.equal(on(mail, "email"), true);
  assert.equal(on(mail, "calendar"), true, "outlook holds the calendar too");
  assert.equal(on(mail, "documents"), false);
  assert.equal(on(caps.capabilityList(inputs({ lookups: { web: WEB_BOTH, github: true, systems: ["confluence"] } })), "documents"), true);
  assert.equal(on(caps.capabilityList(inputs({ lookups: { web: WEB_BOTH, github: true, systems: ["voice-gw"] } })), "voice"), false, "nothing lifts voice");
  const two = caps.capabilityList(inputs({ channels: ["slack", "teams"] }));
  assert.equal(on(two, "other_chat_apps"), true);
  assert.deepEqual(two.channels, ["slack", "teams"]);
  assert.deepEqual(caps.channelsOf(), ["teams"]);
  assert.deepEqual(caps.channelsOf("slack"), ["slack", "teams"]);
  assert.deepEqual(caps.channelsOf("Not A Channel!"), ["teams"], "what is no channel id is the default one");

  // The tools by how they act: its own changes need no worker, and only some show a card first.
  assert.ok(careful.acts_at_once.includes("review_start") && careful.acts_at_once.includes("memory_save") && careful.acts_at_once.includes("work_create"));
  assert.deepEqual(careful.asks_first, ["devenv_hide", "devenv_send", "github_comment", "skill_draft", "trigger_cancel", "trigger_create"]);
  assert.ok(careful.reads.includes(caps.CAPABILITIES_TOOL) && careful.reads.includes("work_recall"));
  assert.equal(careful.unclassified, undefined);
  assert.deepEqual(caps.capabilityList(inputs({ tools: [...EVERY_TOOL, "brand_new_tool"] })).unclassified, ["brand_new_tool"]);
});

test("K3 every tool the router's server can register is classified, and the tool lists exactly what that server offers", async () => {
  const names = routerToolNames();
  assert.ok(names.includes(caps.CAPABILITIES_TOOL) && names.includes("review_start") && names.includes("work_subscribe") && names.includes("job_watch")
    && names.includes("memory_save") && names.includes("devenv_send") && names.includes("skill_save") && names.includes("trigger_create"), names.join(","));
  assert.deepEqual(names.filter((t) => !Object.hasOwn(caps.TOOL_EFFECTS, t)), [], "a registered tool nobody classified");
  // Every classified tool is one the server registers with every switch on: a stale entry would describe a tool that does not exist.
  assert.deepEqual(Object.keys(caps.TOOL_EFFECTS).filter((t) => !names.includes(t)), []);
  // What the recorder saw is what tools/list answers.
  const registered: string[] = [];
  const server = createAssistantMcpServer({ sid: "s", mid: "m", task_id: "t", exp: 4102444800, role: "router" }, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, registered);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "k3", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [...registered].sort());
  } finally {
    await client.close();
    await server.close();
  }
  // A worker and an observer have no claw_capabilities: nobody asks them about the assistant.
  const worker: string[] = [];
  createAssistantMcpServer({ sid: "s", mid: "m", task_id: "t", exp: 4102444800, role: "worker", item_id: "i", gen: 1 }, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, worker);
  assert.ok(!worker.includes(caps.CAPABILITIES_TOOL));
  const observer: string[] = [];
  createAssistantMcpServer({ sid: "s", mid: "m", task_id: "t", exp: 4102444800, role: "observer" }, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, observer);
  assert.ok(!observer.includes(caps.CAPABILITIES_TOOL) && observer.includes("say"));
  // The recorder passes registration through and keeps the order.
  const fake = { tool: (n: string) => `t:${n}`, registerTool: (n: string) => `r:${n}` };
  const seen = recordToolNames(fake as never);
  assert.equal((fake.tool as (n: string) => string)("x"), "t:x");
  assert.equal((fake.registerTool as (n: string) => string)("y"), "r:y");
  assert.deepEqual(seen, ["x", "y"]);
});

test("K4 the router is told to answer any question about itself from claw_capabilities, called first", () => {
  assert.equal(ROUTER_SELF_PROMPT_VERSION, "router-self-v5");
  for (const self of [true, false]) {
    const section = renderRouterSelfSection(self, undefined, "Helper");
    assert.match(section, /What you can or cannot do, your limits, or how you compare with other assistants \(你能做什么, 你不能做什么, 你能看图吗, 你会盯 PR 吗/);
    assert.match(section, /call claw_capabilities first, before you say anything, and answer from what it returns alone, never from what you remember or guess about yourself\./);
    assert.match(section, /An ability it lists with on true is one you have: never say you cannot do it, need a worker for it or must ask first when it says otherwise\./);
    assert.match(section, /One it lists with on false, and a limit with on false, is one you do not have: say so plainly, and never claim it\./);
    assert.ok(section.indexOf("claw_capabilities first") < section.indexOf("Counting what a lookup returned"));
  }
  const abilities = renderRouterAbilities(["agent-board"], true);
  assert.match(abilities, /call claw_capabilities first/);
  assert.doesNotMatch(abilities, /changes go through a work item that asks them first/, "the false limit of 2026-11-23 is gone");
  assert.match(abilities, /Your own tools change things themselves, with no worker: claw_capabilities lists which act at once \(acts_at_once\)/);
  assert.match(abilities, /Never say every change needs a worker or a confirmation\./);
});

// What the router said on 2026-11-23, asked what it could not do (paraphrased, one claim per line).
const FALSE_LIMITS_ZH = [
  "我没有后台监控能力，只有在你发消息的时候才会工作。",
  "我看不到你发的图片，只能处理文字。",
  "所有写操作都需要开 worker 并经过你的确认。",
  "我无法检查 worker 的结论对不对。",
];
const FALSE_LIMITS_EN = [
  "I don't have any background monitoring: I only act when you message me.",
  "I can't see images you send; I can only read text.",
  "Every change I make requires a worker and your confirmation.",
  "I can't verify what the workers concluded.",
];

test("K5 the four false limits are contradictions against a list that has those abilities, and none against one that lacks them", () => {
  const full = caps.capabilityList(inputs({ reviewMode: "fully_auto" }));
  for (const [k, line] of [...FALSE_LIMITS_ZH, ...FALSE_LIMITS_EN].entries()) {
    assert.equal(contradictedClaims(line, full).length, 1, `${k}: ${line}`);
  }
  const all = contradictedClaims(FALSE_LIMITS_ZH.join("\n"), full).map((c) => c.detector).sort();
  assert.deepEqual(all, ["denies acting directly", "denies background", "denies check_work", "denies see_images"]);
  // The same words are true of a deployment without those abilities: nothing is contradicted there.
  const none = caps.capabilityList(inputs({
    tools: ["say", "work_create", "work_send", "work_stop"],
    features: { ...ALL_ON, files_and_images: false, github_events: false, job_watch: false, triggers: false },
  }));
  assert.equal(none.acts_at_once.length > 0, true, "work_create still acts at once");
  assert.deepEqual(
    contradictedClaims([FALSE_LIMITS_ZH[0], FALSE_LIMITS_ZH[1], FALSE_LIMITS_ZH[3]].join("\n"), none), [],
    "no background watching, no images and no way to check a worker are true here",
  );
  // "I always ask before merging" contradicts fully_auto only.
  const merge = "合并前我都会先问你确认。";
  assert.equal(contradictedClaims(merge, full).length, 1);
  assert.equal(contradictedClaims(merge, caps.capabilityList(inputs())).length, 0, "true under high_risk_confirm");
  // An answer from the list says none of it.
  const right = "我能看你发的图片（每条消息最多 4 张），可以在后台盯你的 PR，有新评论或 CI 失败会告诉你；我也能查看 worker 的报告和最新进展，核对它的结论。"
    + "我做不到的：读写邮件、日历，接语音电话，也只在 Teams 里。";
  assert.deepEqual(contradictedClaims(right, full), []);
  // A real-model answer (router eval, 2026-11-23): "only text, files and images" names images, so it is no denial of them.
  assert.deepEqual(contradictedClaims("没有语音：听不了语音消息，也不能打电话，只能处理文字、文件和图片", full), []);
  assert.deepEqual(contradictedClaims("I can only handle text, files and images.", full), []);
  assert.equal(contradictedClaims("我只能处理文字。", full).length, 1);
  // Another (self-03, same run): a qualified statement that agrees with the list.
  assert.deepEqual(contradictedClaims("I watch pull requests in the background, but only through a work item. I don't watch PRs that no item is tied to.", full), []);
  assert.equal(contradictedClaims("I don't watch PRs.", full).length, 1);
  assert.equal(contradictedClaims("I can only handle text.", full).length, 1);
  assert.deepEqual(contradictedClaims("I can see images you send, watch your pull requests in the background and check a worker's reports. "
    + "I can't read your email or calendar, and I don't take voice calls.", full), []);
});

test("K6 claiming an ability the list has off is a contradiction, a plain answer is none, and the detectors name real entries", () => {
  const list = caps.capabilityList(inputs({ features: { ...ALL_ON, github_events: false } }));
  const claims = [
    ["我可以帮你查看邮件并回复。", "claims email"], ["I can check your calendar and book meetings.", "claims calendar"],
    ["我可以接听语音电话。", "claims voice"], ["我也可以在微信上和你聊。", "claims other_chat_apps"],
    ["我可以帮你在后台盯着 PR。", "claims watch_pull_requests"], ["I can open your SharePoint files.", "claims documents"],
  ] as const;
  for (const [line, detector] of claims) assert.deepEqual(contradictedClaims(line, list).map((c) => c.detector), [detector], line);
  // Lifted by the deployment, the same claim is true.
  const mail = caps.capabilityList(inputs({ lookups: { web: WEB_BOTH, github: true, systems: ["outlook-mail"] } }));
  assert.deepEqual(contradictedClaims("我可以帮你查看邮件并回复。", mail), []);
  // Answers that are not about the assistant's abilities, or that deny what is really off, are none.
  for (const line of ["PR #12 的 CI 失败了，我已经让 worker 去看。", "节点 n1 现在无法访问。", "我不能读你的邮件。", "I can't take voice calls.", "There are 3 open pull requests."]) {
    assert.deepEqual(contradictedClaims(line, list), [], line);
  }
  const ids = new Set([...list.abilities, ...list.limits].map((e) => e.id));
  for (const id of DETECTOR_ENTRY_IDS) assert.ok(ids.has(id), `${id} is an entry the server generates`);
});

test("K7 what is listed is what works: the web tools as the Brain has them, reviews only where review_start would start one, memory only where it is kept", () => {
  const look = (web: Inputs["lookups"]["web"], github = false) => {
    const list = caps.capabilityList(inputs({ lookups: { web, github, systems: [] } }));
    const a = list.abilities.find((x) => x.id === "look_up")!;
    return { on: a.on, what: a.what, tools: a.tools, web: list.lookups.web };
  };
  // Brain's defaults: neither tool. Nothing to look up, and the list says the web is not there.
  const none = look({ search: false, fetch: false });
  assert.equal(none.on, false);
  assert.match(none.what, /No web search here\. No reading web pages here\.$/);
  assert.deepEqual(none.web, { search: false, fetch: false });
  // Each on its own: only that one is listed, and the other is said to be missing.
  const search = look({ search: true, fetch: false });
  assert.equal(search.on, true);
  assert.deepEqual(search.tools, ["web_search"]);
  assert.match(search.what, /search the web \(web_search\)\. No reading web pages here\.$/);
  assert.doesNotMatch(search.what, /web_fetch/);
  const fetch = look({ search: false, fetch: true });
  assert.deepEqual(fetch.tools, ["web_fetch"]);
  assert.match(fetch.what, /read a web page at an address \(web_fetch\)\. No web search here\.$/);
  assert.doesNotMatch(fetch.what, /web_search/);
  // Not known (the API's own list, a Brain that does not say): neither is claimed, and no absence is asserted either.
  const unknown = look(null, true);
  assert.equal(unknown.on, true, "GitHub is still there");
  assert.deepEqual(unknown.tools, ["github"]);
  assert.doesNotMatch(unknown.what, /web/i);
  assert.equal(unknown.web, null);

  // The header a Brain names its web tools in.
  assert.deepEqual(caps.parseWebTools(undefined), null);
  assert.deepEqual(caps.parseWebTools("none"), { search: false, fetch: false });
  assert.deepEqual(caps.parseWebTools(""), { search: false, fetch: false });
  assert.deepEqual(caps.parseWebTools("web_search"), { search: true, fetch: false });
  assert.deepEqual(caps.parseWebTools(" web_fetch , web_search "), { search: true, fetch: true });
  assert.deepEqual(caps.parseWebTools(["web_fetch"]), { search: false, fetch: true });
  assert.deepEqual(caps.parseWebTools("web_searchx,bash"), { search: false, fetch: false }, "only the names themselves");

  // Reviews: off when review_start would refuse (no reviews, or no review items), and then no review mode is claimed either.
  for (const off of ["review_tools", "github_review", "review_items"] as const) {
    const list = caps.capabilityList(inputs({ reviewMode: "fully_auto", features: { ...ALL_ON, [off]: false } }));
    assert.equal(on(list, "reviews"), false, `${off} off`);
    assert.equal(list.review_mode, null, `${off} off: no fully_auto merge claimed`);
  }
  assert.equal(caps.capabilityList(inputs({ reviewMode: "fully_auto" })).review_mode?.mode, "fully_auto");

  // Memory: the deployment's switch, the user's own setting and this conversation all have to keep it.
  const memory = (userMemory: Inputs["userMemory"], features = ALL_ON) => caps.capabilityList(inputs({ userMemory, features })).abilities.find((a) => a.id === "memory")!;
  assert.equal(memory({ enabled: true, here: true }).on, true);
  assert.match(memory({ enabled: true, here: true }).what, /^Remember things across conversations/);
  const userOff = memory({ enabled: false, here: true });
  assert.equal(userOff.on, false);
  assert.match(userOff.what, /^Long-term memory is off for this user: nothing is saved or recalled; they can turn it on in their settings\.$/);
  const groupChat = memory({ enabled: true, here: false });
  assert.equal(groupChat.on, false);
  assert.match(groupChat.what, /not kept in this conversation/);
  assert.equal(memory({ enabled: true, here: true }, { ...ALL_ON, memory: false }).on, false);
});

test("K8 the inputs read the user's memory only where the deployment has it, and carry the Brain's web tools as given", async () => {
  const q = (async () => ({ rows: [] })) as never;
  const asked: Array<[string, string | null]> = [];
  const deps = {
    systems: async () => [], github: async () => false,
    memory: async (u: string, s: string | null) => { asked.push([u, s]); return { enabled: false, here: true }; },
  };
  const on_ = await caps.capabilityInputs(q, "alice", "sid-1", EVERY_TOOL, undefined, { ...deps, features: ALL_ON, web: { search: true, fetch: false } });
  assert.deepEqual(on_.userMemory, { enabled: false, here: true });
  assert.deepEqual(asked, [["alice", "sid-1"]]);
  assert.deepEqual(on_.lookups.web, { search: true, fetch: false });
  assert.equal(on(caps.capabilityList(on_), "memory"), false, "the user's own setting is off");
  const off = await caps.capabilityInputs(q, "alice", "sid-1", EVERY_TOOL, undefined, { ...deps, features: { ...ALL_ON, memory: false } });
  assert.deepEqual(off.userMemory, { enabled: false, here: false });
  assert.equal(asked.length, 1, "not asked where the deployment has no memory");
  assert.equal(off.lookups.web, null, "no web tools named: not known");
});
