// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The plain sentences help teaches, and close ways of saying the same, each read as the command it means (`natural.ts`). A whole
 * message is looked up as a phrase: lower case, no spaces between the words, no punctuation at either end (`phraseKey`).
 */
import { BOT_NAME } from "../branding.js";
import { LEGACY_BOT_NAME } from "../legacy-names.js";

export const HELP = [
  "help",
  "帮助",
  "使用说明",
  "说明",
  "怎么用",
  "怎么使用",
  "如何使用",
  "你能做什么",
  "你能干什么",
  "你会做什么",
  "你会什么",
  "你都能做什么",
  "你可以做什么",
  "能做什么",
  "你能帮我做什么",
  "what can you do",
  "how do i use you",
  "how does this work",
];
/**
 * Asking the bot to introduce itself, read as help in a group only: there the answer is said to everyone, and help is what knows
 * what the bot does (a group's session is shared and knows nothing of it). In a 1:1 chat the words stay the person's, as before.
 */
export const INTRODUCE = [
  "介绍一下你自己",
  "介绍下你自己",
  "介绍你自己",
  "介绍一下自己",
  "介绍下自己",
  "介绍一下你",
  "做个自我介绍",
  "自我介绍一下",
  "自我介绍",
  "你是谁",
  "你是干什么的",
  "你是做什么的",
  "你能帮我们做什么",
  "你能帮大家做什么",
  "introduce yourself",
  "please introduce yourself",
  "tell us about yourself",
  "tell me about yourself",
  "who are you",
  "what are you",
  "what can you help with",
];
export const STOP = ["停", "停下", "停止", "停一下", "先停一下", "先停下", "别做了", "不用做了"];
/**
 * "Stop it" said to a chat attached to an agent's session: that agent's turn is stopped (`/stop`). With the assistant the same words
 * are the assistant's to read, so they are a command only while attached (`naturalCommand`'s `off` carries "stop it" otherwise).
 */
export const STOP_IT = [
  "停掉它",
  "停掉",
  "把它停了",
  "把它停掉",
  "让它停下",
  "让它停下来",
  "让它停一下",
  "别跑了",
  "不要跑了",
  "停掉agent",
  "stop it",
  "stop that",
  "stop the agent",
  "stop the run",
];
export const NEW = [
  "开个新会话",
  "新会话",
  "新开一个会话",
  "换个话题",
  "重新开始",
  "start a new session",
  "new session",
];
export const SESSIONS = ["我之前的会话", "之前的会话", "最近的会话", "我的会话", "my sessions"];
export const BOARD = ["看看我的任务", "我的任务", "任务板", "看看任务", "show my tasks", "my tasks"];
export const WHOAMI = [
  "我连的是哪个账号",
  "我连的哪个账号",
  "连的是哪个账号",
  "我是谁",
  "which account am i connected to",
];
export const MEMORY = ["你记得我什么", "你记住了我什么", "你记得我哪些事", "what do you remember about me"];
export const MEMORY_ON = ["打开记忆", "开启记忆", "把记忆打开", "turn memory on", "turn on memory"];
export const MEMORY_OFF = ["关掉记忆", "关闭记忆", "把记忆关掉", "turn memory off", "turn off memory"];
export const UNLINK = ["断开我的账号", "断开账号", "断开账号连接", "解除账号连接", "disconnect my account"];
export const AGENTS = [
  "看看我电脑上的agent",
  "我电脑上的agent",
  "我电脑上的agent有哪些",
  "看看我的远程agent",
  "我的远程agent",
  "show my agents",
  "show the agents on my machines",
];
export const AGENT_SESSIONS = [
  "我的agent会话",
  "我之前的agent会话",
  "my agent sessions",
  "会话列表",
  "切换会话",
  "agent会话列表",
  "开发环境会话",
];
/** "Back to <name>" for the bot's name `name` (a deployment's own name is read beside these: `naturalCommand`'s `bot`). */
export function backToBot(name: string): string[] {
  const lower = name.toLowerCase();
  return [`回到${lower}`, `back to ${lower}`, `come back to ${lower}`];
}
/**
 * The default name, and the name an earlier release gave the bot: "back to ..." buttons under cards it sent are still in
 * people's chats.
 */
export const DETACH = [
  ...backToBot(BOT_NAME),
  ...backToBot(LEGACY_BOT_NAME),
  "回到你这里",
  "回来吧",
  "不跟agent说了",
  "断开agent",
  "detach the agent",
  "回到助理",
  "回到助手",
  "切回助理",
  "切回助手",
  "回助理",
  "退出会话",
  "退出agent",
  "back to the assistant",
  "back to assistant",
];
/**
 * What people put around "回到助理" without changing what it asks (好了，回到助理吧 / ok, back to the assistant please): dropped from
 * either end before the phrase is looked up. Only these words: "回到助理然后跑测试" is not a detach.
 */
export const DETACH_LEAD = [
  "好了",
  "好的",
  "好",
  "行了",
  "行",
  "嗯",
  "那就",
  "那",
  "先",
  "我们",
  "咱们",
  "请",
  "帮我",
  "现在",
  "ok",
  "okay",
  "alright",
  "please",
  "now",
  "let'sgo",
  "letsgo",
  "go",
];
export const DETACH_TAIL = [
  "吧谢谢",
  "谢谢",
  "吧",
  "啦",
  "了",
  "吧了",
  "please",
  "thanks",
  "thankyou",
  "now",
  "fornow",
];
export const RESUME = ["恢复通知", "继续通知", "可以发通知了", "可以打扰我了", "resume notifications"];
export const QUIET_SHOW = ["免打扰", "免打扰时间", "免打扰时段", "quiet hours"];
export const QUIET_OFF = [
  "关掉免打扰",
  "关闭免打扰",
  "取消免打扰",
  "不要免打扰",
  "turn off quiet hours",
  "quiet hours off",
];
export const BRIEF_OFF = [
  "关掉简报",
  "关闭简报",
  "不要简报了",
  "不要简报",
  "关掉日报",
  "关闭日报",
  "不要日报了",
  "turn off the brief",
  "stop the brief",
];
export const BRIEF_NOW = [
  "看看今天的简报",
  "今天的简报",
  "给我一份简报",
  "看看简报",
  "我的简报",
  "show me today's brief",
  "my brief",
  "brief me",
];
export const PAUSE_ALL = ["暂停通知", "先别给我发消息", "pause notifications"];
export const GITHUB_BIND = [
  "把我的github连上",
  "连上我的github",
  "连上github",
  "连接github",
  "连接我的github",
  "绑定github",
  "绑定我的github",
  "我要绑定github",
  "connect my github",
];
export const GITHUB_UNBIND = [
  "解绑我的github",
  "解绑github",
  "断开github",
  "断开我的github",
  "取消绑定github",
  "disconnect my github",
];
export const GITHUB_STATUS = [
  "我的github",
  "github状态",
  "我的github状态",
  "我的github连上了吗",
  "github连上了吗",
  "my github",
];
export const DELEGATION_ON = [
  "允许同事请我代审合入",
  "同事可以请我代审合入",
  "开启自动合入",
  "打开自动合入",
  "let colleagues ask me to review and merge",
];
export const DELEGATION_OFF = [
  "不允许同事请我代审合入",
  "不许同事请我代审合入",
  "关掉自动合入",
  "关闭自动合入",
  "stop colleagues asking me to review and merge",
];
export const TIMEZONE_SHOW = ["我的时区", "时区", "现在是什么时区", "my time zone"];
export const LANG_AUTO = [
  "语言自动选",
  "自动选语言",
  "回复语言自动选",
  "按我写的话选语言",
  "pick the language automatically",
  "language auto",
];
export const FEEDBACK_ALONE = ["我要反馈", "反馈问题", "报告问题", "报个问题", "我要报个问题"];
