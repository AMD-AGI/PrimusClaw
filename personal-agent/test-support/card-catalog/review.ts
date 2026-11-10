// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The review delegation's cards (W7), with the Python catalog's inputs. */
import {
  githubConfirmCard,
  githubConnectCard,
  reviewItemCard,
  reviewModeCard,
} from "../../packages/teams/src/views/review/index.js";
import { TYPED_MODE_HINT } from "../../packages/core/src/review/views.js";
import { entries } from "./catalog.js";

const ITEM = {
  seq: 14,
  pull: "example-org/example-repo#292",
  who: "Lin Mei",
  reviewOnly: false,
  model: "claude-opus-4-8",
  cardId: "card-1",
  lang: "zh",
  queued: false,
} as const;

const CONFIRM = {
  title: "",
  author: "",
  headSha: "",
  reasons: [] as string[],
  checks: "",
  requester: "Robin Lang",
  room: "",
  review: undefined,
  model: "",
  hint: false,
  installUrl: "",
  base: "",
  login: "linmei-amd",
  lang: "zh",
  summary: "",
} as const;

export const REVIEW_CARDS = entries(
  ["review_start", () => reviewItemCard(ITEM)],
  ["review_end", () => reviewItemCard(ITEM, "已批准并合入：没有需要修改的地方，检查全部通过。")],
  [
    "review_confirm_merge",
    () =>
      githubConfirmCard({
        ...CONFIRM,
        confirmationId: "conf-1",
        repo: "AMD-AGI/Primus-SaFE",
        number: 481,
        title: "safe-node: rotate node credentials on join",
        author: "zhangsan",
        headSha: "9f8e7d6c5b4a3210",
        reasons: ["改动了凭据轮换逻辑", "修改了 CI 发布流程"],
        checks: "12/12 passed",
        room: "Primus 运维群",
        model: "claude-opus-4-8",
        hint: true,
        installUrl: "https://teams.microsoft.com/l/app/x",
        base: "main",
      }),
  ],
  [
    "review_confirm_post",
    () =>
      githubConfirmCard({
        ...CONFIRM,
        confirmationId: "conf-2",
        repo: "AMD-AGI/Primus-SaFE",
        number: 482,
        title: "docs: node join runbook",
        author: "lisi",
        headSha: "0a1b2c3d4e5f",
        reasons: ["别人请求，以你的身份发布"],
        review: {
          event: "REQUEST_CHANGES",
          body: "两处需要修改：1) 加入节点前没有校验 token 过期；2) runbook 的命令少了 --namespace。",
          comments: 2,
        },
      }),
  ],
  [
    "review_mode",
    () =>
      reviewModeCard({
        current: "high_risk_confirm",
        suggested: "",
        lead: "",
        hint: TYPED_MODE_HINT,
        installUrl: "https://teams.microsoft.com/l/app/x",
      }),
  ],
  [
    "github_connect",
    () =>
      githubConnectCard({
        code: "ABCD-1234",
        uri: "https://github.com/login/device",
        minutes: 15,
        question: "我开着几个 PR？",
        lang: "zh",
        cardId: "card-6",
      }),
  ],
);
