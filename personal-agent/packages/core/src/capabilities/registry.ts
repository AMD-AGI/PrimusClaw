/**
 * What the bot can do for a person, as one registry; help is rendered from it (`help.ts`).
 *
 * Help teaches what can be got done, grouped by what it is for, each with one sentence a person would really type on a phone; it
 * does not list commands. The slash commands keep working, and the commands menu has the common ones, which help says once at the
 * end. `test/capabilities.test.ts` walks the code's closed sets and fails when one is not covered by an entry here, and sends every
 * example sentence through the real routing to check it reaches the capability it is the example of.
 */

export type CategoryKey = "chat" | "review" | "settings" | "remote" | "notify" | "feedback";

export interface Category {
  readonly key: CategoryKey;
  readonly zh: string;
  readonly en: string;
}

/** In the order help shows them. */
export const CATEGORIES: readonly Category[] = [
  { key: "chat", zh: "对话与任务", en: "Chat and tasks" },
  { key: "review", zh: "代你审 PR 和合入", en: "Reviews and merges for you" },
  { key: "settings", zh: "你自己的设置", en: "Your settings" },
  { key: "remote", zh: "远程 agent", en: "Remote agents" },
  { key: "notify", zh: "通知与免打扰", en: "Notifications and quiet hours" },
  { key: "feedback", zh: "反馈", en: "Feedback" },
];

/** Where help shows a capability: a 1:1 chat, a group chat, or both. */
export type Where = "dm" | "group" | "both";
/** "assistant" only with the assistant on, "session" only without it, "understanding" only for the people the assistant
 * understands every message of, "" either way. */
export type CapabilityMode = "" | "assistant" | "session" | "understanding";
/** The parts of the worker a capability needs on: shown only then. */
export type Part = "github" | "remote" | "brief" | "schedule" | "watch_job";

export interface Capability {
  readonly key: string;
  /** A CATEGORIES key; "" for help itself (the closing line, not a category). */
  readonly category: CategoryKey | "";
  /** What it is, in a few words. */
  readonly zh: string;
  readonly en: string;
  /** One sentence a person would type for it ("" : it is done with buttons). */
  readonly sayZh: string;
  readonly sayEn: string;
  /**
   * Where the example goes: "turn", "group_review [MODEL]" (one review per pull request it names), "review_mode MODE" (the card
   * to choose it), "unlink_ask", or "<command> [ARG]" as the worker reads it.
   */
  readonly reaches: string;
  /** The code's surfaces it stands for: command:, github:, agent:, card:, setting:, route:. */
  readonly covers: readonly string[];
  readonly where: Where;
  /** Where its example is typed: "dm", or "group" (after an @mention). */
  readonly typedIn: "dm" | "group";
  readonly mode: CapabilityMode;
  /** Whose current value help shows (a key of the `values` help is given). */
  readonly setting: string;
  readonly needs: Part | "";
  /**
   * The assistant may ask the chat to do it (`channelActions`): its command, carried out as if typed. Never one that cannot be
   * undone or that loosens a safety setting (`NOT_ACTIONS`).
   */
  readonly action: boolean;
}

type Fields = Pick<Capability, "key" | "category" | "zh" | "en"> & Partial<Capability>;

function capability(fields: Fields): Capability {
  return {
    sayZh: "",
    sayEn: "",
    reaches: "",
    covers: [],
    where: "dm",
    typedIn: "dm",
    mode: "",
    setting: "",
    needs: "",
    action: false,
    ...fields,
  };
}

export const CAPABILITIES: readonly Capability[] = [
  // --- chat
  capability({ key: "task", category: "chat", zh: "说出要做的事，我来做", en: "Say what you need done and I do it", sayZh: "帮我看看这个 CI 为什么挂了", sayEn: "find out why this CI run failed", reaches: "turn", covers: ["route:turn", "route:assistant"], where: "both" }),
  capability({ key: "github_ask", category: "chat", zh: "直接问你的 GitHub PR、issue 和 CI（只读，以你的身份）", en: "Ask about your GitHub PRs, issues and CI directly (read-only, as you)", sayZh: "我现在开着的 PR 有几个？", sayEn: "how many PRs do I have open?", reaches: "turn", mode: "assistant" }),
  capability({ key: "web", category: "chat", zh: "上网搜索，或读一个网页", en: "Search the web or read a page", sayZh: "上网搜一下 ROCm 7 有哪些新功能", sayEn: "search the web for what is new in ROCm 7", reaches: "turn", mode: "assistant" }),
  capability({ key: "follow_up", category: "chat", zh: "我在做时也能接着说，我会接着做", en: "Keep talking while I work; I take it next", sayZh: "做完再把 README 也改一下", sayEn: "when that is done, update the README too", reaches: "turn", covers: ["route:queue"], where: "both" }),
  capability({ key: "quote", category: "chat", zh: "长按一条消息选「回复」，我会连那条消息和里面的链接一起看", en: "Reply to a message (long-press, Reply) and I read it, links included", sayZh: "这个报错是什么意思？", sayEn: "what does this error mean?", reaches: "turn", covers: ["route:quote", "route:links"], where: "both" }),
  capability({ key: "files", category: "chat", zh: "做出来的文件放在回答后面，点「Download」下载", en: "Files I make come after the answer; tap Download", sayZh: "把结果整理成 csv 文件发给我", sayEn: "put the results in a csv file for me", reaches: "turn", covers: ["route:deliveries"], where: "both" }),
  capability({ key: "cards", category: "chat", zh: "要你拍板时我发卡片：点按钮回答、批准或拒绝", en: "When I need you, I send a card: tap to answer, approve or deny", covers: ["card:decision", "card:answer", "card:assistant_action"], where: "both" }),
  capability({ key: "changes", category: "chat", zh: "改完代码点「Create PR」开 PR；太长的回答点「Show here」看全", en: "Tap Create PR to open a pull request for my changes; Show here for a long answer", covers: ["card:create_pr", "card:show"] }),
  capability({ key: "stop", category: "chat", zh: "让我停下手上的事", en: "Stop what I am doing", sayZh: "停一下", sayEn: "stop", reaches: "stop", covers: ["command:stop"], where: "both" }),
  capability({ key: "board", category: "chat", zh: "看你的任务：进行中、等你、已完成，以及请别人代审的进度", en: "See your tasks: in progress, waiting for you, done, and the reviews you asked others to do", sayZh: "看看我的任务", sayEn: "show my tasks", reaches: "board", covers: ["command:board", "card:work", "card:observe"], mode: "assistant", action: true }),
  capability({ key: "repo_inline", category: "chat", zh: "在哪个仓库干活，消息里说一声就行", en: "Name the repository in your message", sayZh: "在 AMD-AGI/PrimusClaw 里修一下失败的测试", sayEn: "in AMD-AGI/PrimusClaw, fix the failing test", reaches: "turn", mode: "assistant" }),
  capability({ key: "new", category: "chat", zh: "换个话题，从头开始", en: "Start over on something new", sayZh: "开个新会话", sayEn: "start a new session", reaches: "new", covers: ["command:new"], where: "both", mode: "session" }),
  capability({ key: "sessions", category: "chat", zh: "回到之前的会话", en: "Go back to an earlier session", sayZh: "我之前的会话", sayEn: "my sessions", reaches: "sessions", covers: ["command:sessions"], mode: "session" }),
  capability({ key: "repo", category: "chat", zh: "到某个 GitHub 仓库里干活", en: "Work inside a GitHub repository", sayZh: "切到仓库 AMD-AGI/PrimusClaw", sayEn: "switch to repo AMD-AGI/PrimusClaw", reaches: "repo AMD-AGI/PrimusClaw", covers: ["command:repo", "card:repo"], mode: "session" }),
  // --- review
  capability({ key: "group_review", category: "review", zh: "在群里 @我，请同事用 TA 的 GitHub 审并合入你的 PR", en: "In a group, a colleague reviews and merges your PR with their GitHub", sayZh: "请 @Hui Rui 帮我 review 合入 AMD-AGI/Primus#12", sayEn: "@Hui Rui please review and merge AMD-AGI/Primus#12", reaches: "group_review", covers: ["route:group_review"], where: "both", typedIn: "group", needs: "github" }),
  capability({ key: "review_direct", category: "review", zh: "在这里也能请；不点名就用你自己的 GitHub 审", en: "Ask here too; naming nobody reviews with your own GitHub", sayZh: "帮我 review 合入 AMD-AGI/Primus#12", sayEn: "review and merge AMD-AGI/Primus#12 for me", reaches: "group_review", covers: ["route:review_direct"], needs: "github" }),
  capability({ key: "review_many", category: "review", zh: "怎么说都行，写名字也行；多个 PR 一起发，超 10 个排队", en: "Any wording, a plain name works; several PRs at once, past ten they queue", sayZh: "Hui Rui 看下这两个能不能合 AMD-AGI/Primus#12 AMD-AGI/Primus#13", sayEn: "Hui Rui, can you merge AMD-AGI/Primus#12 and AMD-AGI/Primus#13", reaches: "group_review", covers: ["route:review_any_wording", "route:review_by_name", "route:review_many"], where: "both", typedIn: "group", needs: "github" }),
  capability({ key: "review_model", category: "review", zh: "可以指定模型，结果里会写明", en: "Choose the model; the result names it", sayZh: "请 Hui Rui 用 claude-opus-5.5 帮我 review 合入 AMD-AGI/Primus#12", sayEn: "Hui Rui, review and merge AMD-AGI/Primus#12 with claude-opus-5.5", reaches: "group_review claude-opus-5.5", covers: ["route:review_model"], where: "both", typedIn: "group", needs: "github" }),
  capability({ key: "review_change", category: "review", zh: "代审在跑时也能改：停下、只审不合、换个模型重审", en: "Change a review while it runs: stop it, review without merging, or run it again on another model", sayZh: "把 825 的 review 停一下", sayEn: "stop the review of 825", reaches: "assistant", covers: ["route:understanding"], mode: "understanding", needs: "github" }),
  capability({ key: "review_stop_group", category: "review", zh: "在群里 @我 说「停 825」，你发起的代审就停下", en: "In a group, @mention me and say \"stop 825\" to stop a review you asked for", sayZh: "停 AMD-AGI/Primus#825", sayEn: "stop AMD-AGI/Primus#825", reaches: "review_stop", covers: ["route:review_stop_group"], typedIn: "group", mode: "understanding", needs: "github" }),
  capability({ key: "review_confirm", category: "review", zh: "合入前是否要审的人点确认，按 TA 的设置和审查结论决定", en: "Whether the reviewer must tap to confirm before a merge depends on their setting and the review's verdict", covers: ["card:github_confirm"], where: "both", needs: "github" }),
  capability({ key: "review_stop", category: "review", zh: "代审一开始，我在和你的 1:1 里发一张卡片：以谁的身份、只审还是合入、用哪个模型，点「停止」随时停下", en: "When a review starts, a card in your 1:1 chat with me says as whom, review only or merge, and the model; press Stop at any time", covers: ["route:review_stop"], where: "both", needs: "github" }),
  capability({ key: "review_notice", category: "review", zh: "以你的名义审或合入后会私聊告诉你", en: "After a review or merge in your name, I tell you here", covers: ["route:review_notice"], needs: "github" }),
  // --- settings
  capability({ key: "link", category: "settings", zh: "把这个聊天连到你的 PrimusClaw 账号，发控制台给的连接码", en: "Connect this chat to your PrimusClaw account with the code from the console", sayZh: "link 7KQ3M9XP", sayEn: "link 7KQ3M9XP", reaches: "link 7KQ3M9XP", covers: ["command:link", "card:bind", "card:onboard"], setting: "account" }),
  capability({ key: "whoami", category: "settings", zh: "看这个聊天连的是哪个账号", en: "See which account this chat is connected to", sayZh: "我连的是哪个账号", sayEn: "which account am I connected to", reaches: "whoami", covers: ["command:whoami"], where: "both", action: true }),
  capability({ key: "unlink", category: "settings", zh: "断开这个聊天和账号，我会先问你确认", en: "Disconnect this chat from your account; I ask first", sayZh: "断开我的账号", sayEn: "disconnect my account", reaches: "unlink_ask", covers: ["command:unlink"] }),
  capability({ key: "github_bind", category: "settings", zh: "连上你的 GitHub，同事才能请你代审合入", en: "Connect your GitHub, so colleagues can ask you to review and merge", sayZh: "把我的 GitHub 连上", sayEn: "connect my GitHub", reaches: "github bind", covers: ["command:github", "github:bind", "github:status", "card:github_connect", "route:github_connect"], setting: "github", needs: "github" }),
  capability({ key: "github_unbind", category: "settings", zh: "不用了就解绑 GitHub", en: "Remove your GitHub connection", sayZh: "解绑我的 GitHub", sayEn: "disconnect my GitHub", reaches: "github unbind", covers: ["github:unbind"], needs: "github" }),
  capability({ key: "github_delegation", category: "settings", zh: "同事可以点你的名，请我用你的 GitHub 审并合入", en: "Colleagues may name you to have me review and merge with your GitHub", sayZh: "允许同事请我代审合入", sayEn: "let colleagues ask me to review and merge", reaches: "github auto-merge on", covers: ["github:auto-merge"], setting: "delegation", needs: "github" }),
  capability({ key: "github_confirm_mode", category: "settings", zh: "代审确认方式：连 GitHub 时选，说一句就能改", en: "How reviews with your account are confirmed: chosen when you connect GitHub, changed by saying so", sayZh: "代审改成全自动合入", sayEn: "make my reviews fully automatic", reaches: "review_mode fully_auto", covers: ["github:mode", "card:github_mode", "route:review_mode_words"], setting: "confirm_mode", needs: "github" }),
  capability({ key: "memory", category: "settings", zh: "看我记得你哪些事", en: "See what I remember about you", sayZh: "你记得我什么", sayEn: "what do you remember about me", reaches: "memory", covers: ["command:memory"], action: true }),
  capability({ key: "memory_switch", category: "settings", zh: "打开或关闭记忆", en: "Turn memory on or off", sayZh: "关掉记忆", sayEn: "turn memory off", reaches: "memory off", covers: ["command:memory_switch"], action: true }),
  capability({ key: "timezone", category: "settings", zh: "你的时区，免打扰和简报按它算", en: "Your time zone, which quiet hours and the brief use", sayZh: "时区改成 Asia/Shanghai", sayEn: "set my time zone to Asia/Shanghai", reaches: "timezone Asia/Shanghai", covers: ["command:timezone", "setting:timezone"], setting: "timezone", action: true }),
  capability({ key: "lang", category: "settings", zh: "我回复你用的语言：按你最近写的话选；也可以说「以后用英文回复」，或「语言自动选」改回", en: "Language I answer in: what you last wrote, or say \"reply in English\" (\"language auto\" to undo)", sayZh: "以后用中文回复", sayEn: "reply in Chinese", reaches: "lang zh", covers: ["command:lang", "setting:lang", "setting:lang_set"], setting: "lang", action: true }),
  capability({ key: "settings_words", category: "settings", zh: "设置用自己的话说就行，我替你改", en: "Say a setting in your own words and I change it", sayZh: "把简报改到 10 点", sayEn: "move my brief to 10:00", reaches: "assistant", covers: ["route:channel_action"], mode: "understanding" }),
  // --- remote
  capability({ key: "agents", category: "remote", zh: "用你自己机器上的 codex / claude：开会话、切换、改权限、关掉，都在卡片上点", en: "Use codex or claude on your own machines: start, switch, change mode, close, all on the card", sayZh: "看看我电脑上的 agent", sayEn: "show my agents", reaches: "agents", covers: ["command:agents", "command:agent", "agent:new", "agent:mode", "agent:close", "agent:off", "card:remote", "card:remote_off"], needs: "remote", action: true }),
  capability({ key: "agent_switch", category: "remote", zh: "切到某台机器上的 agent，聊天窗就是那个会话：回复实时流式出现，你说的话直接给它", en: "Switch to an agent on your machine: the chat becomes its session, its replies stream in", sayZh: "切到 rohan-dev-pod 的 claude", sayEn: "switch to claude on rohan-dev-pod", reaches: "agent attach rohan-dev-pod/claude", covers: ["agent:attach"], needs: "remote", action: true }),
  capability({ key: "agent_sessions", category: "remote", zh: "看你所有机器上的 agent 会话，点一下切过去", en: "See every agent session on your machines; tap one to switch", sayZh: "会话列表", sayEn: "my agent sessions", reaches: "agent sessions", covers: ["agent:sessions"], needs: "remote", action: true }),
  capability({ key: "agent_talk", category: "remote", zh: "连着 agent 时你说的话直接给它；它要权限时发卡片给你点", en: "While attached, what you say goes to the agent; it asks for permission with a card", covers: ["route:remote_prompt", "card:remote_decision"], needs: "remote" }),
  capability({ key: "agent_window", category: "remote", zh: "会话卡片就是窗口：在卡片的输入框里写给会话，输出和审批都在卡片上，聊天框留给我", en: "The session card is the window: write to the session in its box; output and approvals are on it, the chat box stays mine", covers: ["setting:remote_window"], needs: "remote" }),
  capability({ key: "agent_pair", category: "remote", zh: "连一台新机器：给你一行命令，在那台机器上粘贴运行就连上，不用登录", en: "Connect a new machine: one line to paste on it, no sign-in", sayZh: "连接我的开发环境", sayEn: "connect my dev environment", reaches: "turn", covers: ["agent:pair"], mode: "assistant", needs: "remote" }),
  capability({ key: "agent_detach", category: "remote", zh: "不跟 agent 说了，回到助理", en: "Stop talking to the agent and come back to the assistant", sayZh: "回到助理", sayEn: "back to the assistant", reaches: "agent detach", covers: ["agent:detach"], needs: "remote", action: true }),
  // --- notify
  capability({ key: "quiet", category: "notify", zh: "免打扰时段：期间消息先攒着，结束后一起发", en: "Quiet hours: notices wait and come as one summary", sayZh: "晚上 10 点到早上 8 点别打扰我", sayEn: "quiet hours 22:00-08:00", reaches: "quiet 22:00-08:00", covers: ["command:quiet", "setting:quiet_enabled", "setting:quiet_start", "setting:quiet_end"], setting: "quiet", action: true }),
  capability({ key: "pause", category: "notify", zh: "一段时间内什么都别推", en: "Hold everything for a while", sayZh: "暂停通知 2 小时", sayEn: "pause notifications for 2 hours", reaches: "pause 2h", covers: ["command:pause", "setting:paused_until"], setting: "pause", action: true }),
  capability({ key: "resume", category: "notify", zh: "提前恢复，把攒着的发给你", en: "Resume early and get what was held", sayZh: "恢复通知", sayEn: "resume notifications", reaches: "resume", covers: ["command:resume"], action: true }),
  capability({ key: "brief", category: "notify", zh: "工作日定时给你发一份简报", en: "A brief on weekdays at a time you choose", sayZh: "每天早上 9 点给我发简报", sayEn: "send me a brief every day at 9:00", reaches: "brief on 09:00", covers: ["command:brief", "setting:brief_trigger_id"], setting: "brief", needs: "brief", action: true }),
  capability({ key: "brief_now", category: "notify", zh: "随时看一份简报：等你的事项、盯着的 PR、通知、作业和 SaFE", en: "Your brief any time: items waiting for you, watched PRs, notifications, jobs and SaFE", sayZh: "看看今天的简报", sayEn: "show me today's brief", reaches: "brief now", mode: "assistant", needs: "brief" }),
  capability({ key: "schedule", category: "notify", zh: "让我定时替你做事：说清什么时候、做什么，我发确认卡，你点一下才生效", en: "Have me do something on a schedule: say when and what, and tap the card I send to set it up", sayZh: "每天早上 9 点把我开着的 PR 和红色 CI 发给我", sayEn: "every day at 9:00 send me my open PRs and red CI", reaches: "turn", covers: ["card:assistant_confirm"], mode: "assistant", needs: "schedule" }),
  capability({ key: "watch_job", category: "notify", zh: "盯着一个作业，状态变了或结束了告诉你", en: "Watch a job and tell you when it changes or ends", sayZh: "盯着 workload train-7b，结束了告诉我", sayEn: "watch workload train-7b and tell me when it ends", reaches: "turn", mode: "assistant", needs: "watch_job" }),
  // --- feedback
  capability({ key: "feedback", category: "feedback", zh: "有问题直接说，我交给 PrimusClaw 团队", en: "Tell me what went wrong; I pass it to the PrimusClaw team", sayZh: "反馈：刚才那个回答不对", sayEn: "feedback: that answer was wrong", reaches: "feedback", covers: ["command:feedback"], where: "both" }),
  capability({ key: "thumbs", category: "feedback", zh: "回答下面点踩，或出错时点「Report a problem」，也是反馈", en: "A thumbs-down under an answer, or Report a problem when something fails, does the same", covers: ["card:thumb", "card:thumb_note", "card:report", "card:feedback"], where: "both" }),
  // --- help itself (the closing line, not a category)
  capability({ key: "help", category: "", zh: "随时问我", en: "Ask any time", sayZh: "你能做什么", sayEn: "what can you do", reaches: "help", covers: ["command:help"], where: "both" }),
];

export function byKey(key: string): Capability {
  const found = CAPABILITIES.find((c) => c.key === key);
  if (found === undefined) throw new RangeError(`no capability ${key}`);
  return found;
}
