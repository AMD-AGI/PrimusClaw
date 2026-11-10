// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the asker is told while a review request is checked and started (Chinese, as the Python worker says it). */

import { HOW_TO_ASK } from "./review-request.js";

export const reviewStartText = {
  attachPulls: (unread: string) =>
    `请附上要 review 合入的 PR（链接或 owner/repo#编号），例如 ${HOW_TO_ASK}` +
    (unread ? `（${unread} 没有当作 PR，因为不知道是哪个仓库的）` : ""),
  tooMany: (max: number, atOnce: number, count: number) =>
    `一次最多交给我 ${String(max)} 个 PR（前 ${String(atOnce)} 个立即开始，其余排队自动开始），这次有 ${String(count)} 个，所以一个也没有开始。请先发前 ${String(max)} 个，其余等前面开始后再发。`,
  oneModel: (models: string) => `一次只能指定一个模型（这次写了 ${models}），所以一个也没有开始。`,
  ownersOnly: (owners: string) => `只处理 ${owners} 的公开仓库`,
  ownersOnlyOne: (owners: string) => `我只处理这些组织的公开仓库里的 PR：${owners}。`,
  noneStarted: (why: string) => `没有开始任何 review：${why}。`,
  notStarted: (why: string) => `没有开始 review：${why}。`,
  alreadyReviewing: (pull: string) => `${pull} 已经在 review 中，没有重复开始。`,
  identityOnly: (who: string) =>
    `${who}：让我代同事 review 合入，需要通过 Primus 身份服务确认是你本人，只用 API key 连接的账号不行。请先在身份服务里完成连接（我会私信说明），然后再 @ 我一次。`,
  connectLead:
    "To review and merge pull requests I need to know which Primus account you are. / 代审需要先确认你的 Primus 账号。 ",
  platformDown: "我暂时联系不上 Primus 平台，没能确认你的身份，所以没有开始 review。请稍后再 @ 我一次。",
  unsureWho: `我不确定你请的是谁，所以没有开始 review。请写出 reviewer 的名字，例如 ${HOW_TO_ASK}`,
  unsureWhoFull: `我不确定你请的是谁，所以没有开始 review。请写出 reviewer 的全名，例如 ${HOW_TO_ASK}`,
  githubUnknown: (who: string) => `暂时无法确认 ${who} 的 GitHub 绑定，请稍后再试。`,
  notAuthorized: (who: string, merge: boolean) =>
    `${who} 还没有授权我代 TA ${merge ? "review 合入" : "review"}（需要 TA 在 1:1 里发 \`/github auto-merge on\` 开启一次长期授权），我不会动用 TA 的 GitHub 账号，所以没有开始 review。请 ${who} 授权后再 @ 我一次。`,
  reviewerNotLinked: (who: string) =>
    `${who} 还没有在 Clawy 里连接自己的 Primus key（1:1 里发 \`/link\`），代 TA review 要用 TA 自己的账号和模型额度，所以没有开始 review。请 ${who} 先连接，然后再 @ 我一次。`,
  reviewerNotConnected: (who: string) =>
    `${who} 还没有通过 Primus 身份服务连接 Clawy，我没法以 TA 的身份开始，所以没有开始 review。请 ${who} 先在 1:1 里完成连接，然后再 @ 我一次。`,
  reviewerPlatformDown: (who: string) =>
    `我暂时联系不上 Primus 平台，没能确认 ${who} 的身份，所以没有开始 review。请稍后再 @ 我一次。`,
  modelsUnknown: (whose: string, model: string) =>
    `暂时没法向 PrimusClaw 确认${whose} key 能用哪些模型，所以没有用 ${model} 开始 review。请稍后再试，或不指定模型。`,
  modelUnusable: (whose: string, model: string, listed: string, any: boolean) =>
    `${whose} key 用不了模型 ${model}，所以没有开始 review。` +
    (any ? `可以用的模型：${listed}。` : `${whose} key 目前没有可用的模型。`),
  ownPull: (pull: string, who: string) =>
    `${pull} 是 ${who} 自己提交的，作者不能 review 合入自己的 PR（自己的批准 GitHub 也不算数）。请另外指定一位 committer，例如 ${HOW_TO_ASK}`,
  ownPullShort: (who: string) => `${who} 自己提交的，作者不能 review 合入自己的 PR`,
  limited: (pull: string, zh: string, en: string) => `${pull} 没有开始 review：${zh}\n\n${en}`,
  limitedShort: "你发起 review 的次数达到了每人的上限，请稍后再试",
  overTasks: (running: number, limit: number) =>
    `你同时运行的任务已经有 ${String(running)} 个，到了上限 ${String(limit)} 个；等有任务结束，或在那个聊天里发 /stop 停掉一个，再发一次`,
  readAs: (repo: string) => (repo ? `（按 ${repo} 处理）` : ""),
  unreadNumbers: (numbers: string) =>
    `\n\n这些数字没有当作 PR：${numbers}。如果它们也要 review 合入，请写成 owner/repo#编号再发一次。`,
  stopInGroup: "\n\n要停下，点我私聊里那张卡片上的「停止」。",
  stopHere: "\n\n要停下，点下面卡片上的「停止」。",
  received: (readAs: string, rest: string) => `收到${readAs}。${rest}`,
  several: (p: {
    readAs: string;
    who: string;
    verb: string;
    count: number;
    note: string;
    lined: boolean;
    pulls: string;
    allTheirs: boolean;
    where: string;
  }) =>
    `收到${p.readAs}，以 ${p.who} 的身份${p.lined ? " " : "同时 "}${p.verb}这 ${String(p.count)} 个 PR${p.note}` +
    (p.lined ? "。" : `：${p.pulls}。`) +
    "每个 PR 分别 review，" +
    (p.allTheirs ? `有结论、合入或出问题时会汇总发在${p.where}（同一时间的合成一条）。` : `结果会逐个发在${p.where}。`),
  single: (readAs: string, who: string, verb: string, pull: string, note: string) =>
    `收到${readAs}，以 ${who} 的身份 ${verb} ${pull}${note}。`,
  notStartedHere: (pull: string) => `${pull} 没有开始：我这边出了问题。需要的话请单独再发一次。`,
  startedNotFollowed: (pull: string) => `${pull} 已经开始，但我这边没能跟进它的进展；结果在任务卡片上看。`,
} as const;
