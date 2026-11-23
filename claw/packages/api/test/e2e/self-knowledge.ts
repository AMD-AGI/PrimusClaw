// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether an answer about the assistant itself (what it can or cannot do, its limits, how it compares) says something its generated
 * capability list (`src/assistant/capabilities.ts`, `claw_capabilities`, `GET /v1/assistant/capabilities`) contradicts: a limit it does
 * not have ("I cannot see images" while `see_images` is on) or an ability it does not have ("I can read your email" while `email` is
 * off). Used by the super-agent evaluation (`sa-eval-lib.ts`, a case with `self_knowledge`) and the router evaluation
 * (`assistant-router-eval-lib.ts`, a case with `selfKnowledge`), so both grade an answer against the same list the same way.
 *
 * Every detector is tied to the list's entries by id: a denial is a contradiction only when the entries it names are on, a claim only
 * when they are off, so a deployment whose list differs (no pull request watching, a mail server added) grades the same words the other
 * way. The detectors are deliberately narrow: each says one thing about the assistant itself, in Chinese or English.
 */

/** The parts of the list the detectors read (`Capabilities`). */
export interface CapabilityView {
  abilities: ReadonlyArray<{ id: string; on: boolean }>;
  limits: ReadonlyArray<{ id: string; on: boolean }>;
  review_mode?: { mode: string } | null;
  acts_at_once?: readonly string[];
  /** Tools the assistant has that refuse here, their ability being off. */
  off_here?: readonly string[];
}

export interface Contradiction {
  /** The detector that matched. */
  detector: string;
  /** The words of the answer it matched. */
  words: string;
  /** Why the list contradicts them. */
  why: string;
}

type Contradicted = (caps: CapabilityView) => string | null;

interface Detector {
  id: string;
  re: RegExp;
  contradicted: Contradicted;
}

const entry = (caps: CapabilityView, id: string): { id: string; on: boolean } | undefined =>
  caps.abilities.find((a) => a.id === id) ?? caps.limits.find((l) => l.id === id);

/** A denial of these entries: contradicted when any of them is on. */
const deniesAny = (...ids: string[]): Contradicted => (caps) => {
  const on = ids.filter((id) => entry(caps, id)?.on === true);
  return on.length ? `the list has ${on.join(", ")} on` : null;
};

/** A claim of these entries: contradicted when every one of them is off (an entry the list does not name is not off). */
const claimsAll = (...ids: string[]): Contradicted => (caps) => {
  const off = ids.filter((id) => entry(caps, id)?.on === false);
  return off.length === ids.length ? `the list has ${off.join(", ")} off` : null;
};

// "I (cannot|am not able to|do not)" in English, and its Chinese forms, before what is denied.
const CANNOT_EN = String.raw`\bI(?:'m|’m| am)?\s+(?:currently\s+|still\s+|really\s+|actually\s+)?(?:can(?:'|’)?t|cannot|can not|unable to|not able to|don(?:'|’)?t|do not|won(?:'|’)?t|will not|never)`;
const CANNOT_ZH = "(?:无法|不能|不可以|没法|没办法|不会|做不到|不支持)";
const IMAGES_EN = String.raw`(?:images?|pictures?|screenshots?|photos?|diagrams?)`;
const IMAGES_ZH = "(?:图片|图像|截图|照片|图)";
const PRS_EN = String.raw`(?:PRs?|pull requests?)`;
const PRS_ZH = "(?:PR|pr|拉取请求|合并请求|pull request)";
// "I can", never "I can't" or "I cannot".
const CAN_EN = String.raw`\bI(?:'m| am)?\s+(?:also\s+)?(?:can(?![’']t\b|not\b|\s+not\b)|could(?![’']t\b|\s+not\b)|am able to|will(?!\s+not\b))\b`;
const CAN_ZH = "我(?:也)?(?:可以|能够|能|会)(?:帮你|为你|替你)?";

const DETECTORS: readonly Detector[] = [
  // --- Limits it says it has, which the list contradicts -----------------------------------------------------------
  {
    id: "denies see_images",
    re: new RegExp([
      `${CANNOT_EN}\\s+(?:directly\\s+)?(?:see|view|read|process|analy[sz]e|interpret|look at|open|understand)\\s+(?:any\\s+|the\\s+|your\\s+)?${IMAGES_EN}`,
      // "Only text", unless the same clause goes on to name images ("text, files and images" is right).
      String.raw`\bI\s+(?:can\s+)?only\s+(?:handle|read|process|understand|work with|see)\s+text\b(?![^.;!?\n]{0,30}\b(?:images?|pictures?|screenshots?|photos?)\b)`,
      String.raw`\bI(?:'m| am)\s+text[- ]only\b`,
      `${CANNOT_ZH}(?:直接)?(?:查看|看到|看|识别|读取|理解|处理|解析|分析|打开)(?:你发的|你的|发来的|你发来的)?${IMAGES_ZH}`,
      `${IMAGES_ZH}(?:我)?(?:看不了|看不到|看不见|无法(?:查看|识别|读取|处理))`, `看不(?:到|了|见)(?:你发的|你的)?${IMAGES_ZH}`,
      `只能(?:处理|看|读|理解|接收)(?:文字|文本)(?![^。！？；;\\n]{0,12}${IMAGES_ZH})`,
    ].join("|"), "i"),
    contradicted: deniesAny("see_images"),
  },
  {
    id: "denies watch_pull_requests",
    re: new RegExp([
      // Not a qualified one: "I don't watch PRs that no item is tied to" agrees with the list.
      `${CANNOT_EN}\\s+(?:actively\\s+|proactively\\s+|continuously\\s+|automatically\\s+)?(?:watch|monitor|track|follow|subscribe to|keep an eye on)\\s+(?:your\\s+|the\\s+|any\\s+|new\\s+)?${PRS_EN}\\b(?!\\s+(?:that|which|unless|without|outside|not|no)\\b)`,
      `${CANNOT_ZH}(?:在后台|主动|持续|自动|实时|一直)*(?:地)?(?:盯|盯着|监控|监听|关注|跟踪|追踪|订阅)[^。！？\\n]{0,8}${PRS_ZH}`,
    ].join("|"), "i"),
    contradicted: deniesAny("watch_pull_requests"),
  },
  {
    // "No background watching" is false when anything watches or runs on a schedule in the background.
    id: "denies background",
    re: new RegExp([
      String.raw`\bI\s+(?:have\s+no|don(?:'|’)?t\s+have(?:\s+any)?|do\s+not\s+have(?:\s+any)?)\s+(?:a\s+)?background\s+(?:process|processes|monitoring|watching|tasks?|jobs?|execution|agents?)\b`,
      `${CANNOT_EN}\\s+(?:run|work|act|do anything|keep working)\\s+in the background\\b`,
      String.raw`\bI\s+only\s+(?:act|respond|work|run)\s+when\s+you\s+(?:message|write to|talk to|send)\b`,
      "(?:我)?没有(?:任何)?(?:后台|常驻|持续)(?:运行|监控|任务|进程|能力|盯梢)", "(?:我)?(?:无法|不能|没法|不会)在后台(?:运行|工作|监控|盯)",
      "(?:我)?只(?:有|能|会)在你(?:发|给我发|找我|发消息)[^。！？\\n]{0,6}(?:时|的时候)(?:才)?",
    ].join("|"), "i"),
    contradicted: deniesAny("watch_pull_requests", "watch_jobs", "scheduled_tasks"),
  },
  {
    id: "denies watch_jobs",
    re: new RegExp([
      `${CANNOT_EN}\\s+(?:actively\\s+|proactively\\s+|continuously\\s+|automatically\\s+)?(?:watch|monitor|track|follow)\\s+(?:your\\s+|the\\s+|any\\s+)?(?:jobs?|workloads?|training runs?)\\b`,
      `${CANNOT_ZH}(?:在后台|主动|持续|自动|实时)*(?:地)?(?:盯|盯着|监控|监听|跟踪)[^。！？\\n]{0,6}(?:作业|job|workload|训练)`,
    ].join("|"), "i"),
    contradicted: deniesAny("watch_jobs"),
  },
  {
    id: "denies scheduled_tasks",
    re: new RegExp([
      `${CANNOT_EN}\\s+(?:schedule|set\\s+(?:up\\s+)?(?:reminders?|recurring|scheduled)|run\\s+(?:tasks?\\s+|anything\\s+)?(?:on a schedule|periodically|regularly))`,
      `${CANNOT_ZH}(?:设置|设定|安排|创建)?(?:定时|定期|周期性?)(?:任务|执行|运行|提醒)`,
    ].join("|"), "i"),
    contradicted: deniesAny("scheduled_tasks"),
  },
  {
    id: "denies memory",
    re: new RegExp([
      `${CANNOT_EN}\\s+remember\\s+(?:anything\\s+|things\\s+)?(?:between|across|from one)\\b`,
      String.raw`\bI\s+have\s+no\s+(?:long[- ]term\s+|persistent\s+)?memory\b`,
      String.raw`\b(?:each|every)\s+(?:conversation|session|chat)\s+(?:starts|is)\s+(?:fresh|from scratch|new)\b`,
      "(?:我)?(?:无法|不能|没法|不会)(?:长期|跨对话|跨会话)?(?:地)?(?:记住|记忆|记得)", "(?:我)?没有(?:长期|持久)?记忆", "记不住",
      "(?:每次|每个)(?:对话|会话)都是(?:全新|新的|独立)",
    ].join("|"), "i"),
    contradicted: deniesAny("memory"),
  },
  {
    id: "denies check_work",
    re: new RegExp([
      `${CANNOT_EN}\\s+(?:check|verify|see|inspect|review|confirm)\\s+(?:what\\s+)?(?:the\\s+|a\\s+|my\\s+)?(?:workers?|sub-?agents?|work items?)(?:'s?)?\\b`,
      `(?:无法|不能|没法|没办法)(?:检查|核实|验证|查看|确认|看到|审查)[^。！？\\n]{0,10}(?:worker|工作者|子任务|执行者|子代理|事项)[^。！？\\n]{0,8}(?:结论|结果|产出|做了什么|输出|对不对)`,
    ].join("|"), "i"),
    contradicted: deniesAny("check_work"),
  },
  {
    // "Every change needs a worker and a confirmation": false while the assistant has tools that change things themselves.
    id: "denies acting directly",
    re: new RegExp([
      String.raw`\b(?:every|all|any)\s+(?:write|change|action|modification|operation)s?\b[^.!?\n]{0,40}\b(?:needs?|requires?|must)\b[^.!?\n]{0,30}\b(?:worker|work item|confirm(?:ation)?|approv(?:e|al))`,
      String.raw`\bI\s+(?:can(?:'|’)?t|cannot|never)\s+(?:change|write|do)\s+anything\s+(?:myself|directly|without)\b`,
      "(?:所有|每个|每一个|任何|每次|一切)(?:的)?(?:写|修改|改动|变更|操作|写入|动作)[^。！？\\n]{0,12}(?:都)?(?:需要|要|必须|得)[^。！？\\n]{0,12}(?:worker|工作者|执行者|子任务|事项|确认|批准|审批)",
      "(?:我)?(?:自己)?(?:不能|无法|没法)(?:直接|自己)(?:修改|改动|操作|执行|做)任何",
    ].join("|"), "i"),
    contradicted: (caps) => ((caps.acts_at_once ?? []).length ? `the list has tools that act at once: ${(caps.acts_at_once ?? []).join(", ")}` : null),
  },
  {
    // Under fully_auto a merge the user asked for happens once the review approves: "I always ask before merging" is false then.
    id: "denies merging by itself",
    re: new RegExp([
      String.raw`\b(?:always|will|must)\s+(?:ask|need|wait for)\s+(?:you(?:r)?\s+)?(?:to\s+)?(?:confirm(?:ation)?|approv(?:e|al)|go-ahead)\s+(?:before|for)\s+(?:a\s+|any\s+|every\s+|each\s+)?merg`,
      String.raw`\bI\s+(?:never|won(?:'|’)?t|cannot|can(?:'|’)?t)\s+merge\b[^.!?\n]{0,20}\b(?:on my own|automatically|by myself|without (?:asking|your))`,
      "(?:合并|合入)(?:之?前)[^。！？\\n]{0,8}(?:都|总是|一定|必须)?(?:会|需要|要|得)[^。！？\\n]{0,4}(?:你|您)?(?:的)?(?:确认|批准|同意)",
      "(?:我)?(?:不会|不能|无法)(?:自动|直接|自己)(?:合并|合入)",
    ].join("|"), "i"),
    contradicted: (caps) => (entry(caps, "reviews")?.on && caps.review_mode?.mode === "fully_auto" ? "the user's review mode is fully_auto" : null),
  },
  {
    id: "denies dev_environments",
    re: new RegExp([
      `${CANNOT_EN}\\s+(?:access|reach|connect to|see|control|use)\\s+(?:your\\s+)?(?:own\\s+)?(?:machines?|computers?|laptops?|dev(?:elopment)?\\s+(?:environments?|machines?|boxes?))\\b`,
      `${CANNOT_ZH}(?:访问|连接|连到|操作|控制|看到|进入)(?:你的)?(?:开发机|开发环境|电脑|本地机器|机器)`,
    ].join("|"), "i"),
    contradicted: deniesAny("dev_environments"),
  },
  // --- Abilities it says it has, which the list says it does not ---------------------------------------------------
  {
    id: "claims email",
    re: new RegExp([
      `${CAN_EN}[^.!?\\n]{0,20}\\b(?:read|send|check|manage|answer|triage|draft and send)\\b[^.!?\\n]{0,12}\\b(?:e-?mails?|inbox|outlook)\\b`,
      `${CAN_ZH}(?:读|看|查看|查|收|发|发送|处理|回复|整理)(?:你的)?(?:邮件|邮箱|email|Email)`,
    ].join("|"), "i"),
    contradicted: claimsAll("email"),
  },
  {
    id: "claims calendar",
    re: new RegExp([
      `${CAN_EN}[^.!?\\n]{0,20}\\b(?:read|check|book|manage|schedule|set up)\\b[^.!?\\n]{0,12}\\b(?:calendar|meetings?)\\b`,
      `${CAN_ZH}(?:查看|看|查|安排|预约|预订|管理|创建|约)(?:你的)?(?:日历|日程|会议)`,
    ].join("|"), "i"),
    contradicted: claimsAll("calendar"),
  },
  {
    id: "claims documents",
    re: new RegExp([
      `${CAN_EN}[^.!?\\n]{0,20}\\b(?:open|read|access|search|edit)\\b[^.!?\\n]{0,12}\\b(?:SharePoint|OneDrive|Google\\s*Docs|Google\\s*Drive)\\b`,
      `${CAN_ZH}(?:打开|读取|访问|查看|搜索|编辑)(?:你的)?(?:SharePoint|OneDrive|Google\\s*Docs|Google\\s*Drive|云文档|网盘)`,
    ].join("|"), "i"),
    contradicted: claimsAll("documents"),
  },
  {
    id: "claims voice",
    re: new RegExp([
      `${CAN_EN}[^.!?\\n]{0,20}\\b(?:take|make|join|answer)\\s+(?:voice\\s+|phone\\s+|video\\s+)?calls\\b`,
      `${CAN_EN}[^.!?\\n]{0,20}\\b(?:listen to|transcribe|understand|hear)\\s+(?:your\\s+)?(?:voice|audio)`,
      `${CAN_ZH}(?:接听|听|听懂|处理|识别|回复|打)(?:你的)?(?:语音|电话|通话|录音)`,
    ].join("|"), "i"),
    contradicted: claimsAll("voice"),
  },
  {
    id: "claims other_chat_apps",
    re: new RegExp([
      String.raw`\bI(?:'m| am)?\s+(?:also\s+)?(?:available|reachable|usable|on)\s+(?:in|on|through)\s+(?:Slack|WeChat|WhatsApp|Telegram|DingTalk|Feishu|Lark)\b`,
      `${CAN_ZH}(?:在)?(?:Slack|微信|钉钉|飞书|WhatsApp|Telegram)(?:上|里)?(?:和你|跟你)?(?:聊|用|使用|回复|对话)`,
    ].join("|"), "i"),
    contradicted: claimsAll("other_chat_apps"),
  },
  {
    id: "claims watch_pull_requests",
    re: new RegExp([
      `${CAN_EN}[^.!?\\n]{0,20}\\b(?:watch|monitor|track|follow)\\b[^.!?\\n]{0,10}\\b${PRS_EN}`,
      `${CAN_ZH}(?:在后台)?(?:盯|盯着|监控|跟踪|关注|订阅)[^。！？\\n]{0,6}${PRS_ZH}`,
    ].join("|"), "i"),
    contradicted: claimsAll("watch_pull_requests"),
  },
  {
    id: "claims see_images",
    re: new RegExp([
      `${CAN_EN}[^.!?\\n]{0,12}\\b(?:see|view|read|look at|understand|analy[sz]e)\\b[^.!?\\n]{0,8}\\b${IMAGES_EN}`,
      `${CAN_ZH}(?:看|查看|看懂|识别|读|理解|分析)(?:你发的)?${IMAGES_ZH}`,
    ].join("|"), "i"),
    contradicted: claimsAll("see_images"),
  },
];

/** The ids of the list's entries the detectors name, for the test that holds them to the list the server generates. */
export const DETECTOR_ENTRY_IDS: readonly string[] = [
  "see_images", "watch_pull_requests", "watch_jobs", "scheduled_tasks", "memory", "check_work", "reviews", "dev_environments",
  "email", "calendar", "documents", "voice", "other_chat_apps",
];

/** Every statement of `text` about the assistant itself that `caps` contradicts ([] when there is none). */
export function contradictedClaims(text: string, caps: CapabilityView): Contradiction[] {
  const out: Contradiction[] = [];
  for (const d of DETECTORS) {
    const m = d.re.exec(text);
    if (!m) continue;
    const why = d.contradicted(caps);
    if (why) out.push({ detector: d.id, words: m[0], why });
  }
  return out;
}

/** The list for a judge: what is on and what is off, one line each, as the truth about the assistant for this run. */
export function capabilityTruth(caps: CapabilityView & { abilities: ReadonlyArray<{ id: string; on: boolean; what?: string }>; limits: ReadonlyArray<{ id: string; on: boolean; what?: string }> }): string[] {
  const line = (e: { id: string; on: boolean; what?: string }): string => `${e.id}: ${e.on ? "on" : "off"}${e.what ? ` (${e.what})` : ""}`;
  return [
    ...caps.abilities.map(line),
    ...caps.limits.map(line),
    ...(caps.review_mode ? [`review_mode: ${caps.review_mode.mode}`] : []),
    ...(caps.acts_at_once?.length ? [`tools that act at once, with no worker or card: ${caps.acts_at_once.join(", ")}`] : []),
    ...(caps.off_here?.length ? [`tools that refuse here (their ability is off): ${caps.off_here.join(", ")}`] : []),
  ];
}
