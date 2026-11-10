// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the asker is told when Claw starts none of a request's reviews (`github_review.py`'s `_batch_refusal`): each expected line
 * was produced by the Python worker's own function from the same answer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ReviewsRefused, silentLogger } from "../../src/index.js";
import { PublicErrorLog } from "../../src/public-error/public-error-log.js";
import { SeededRandom } from "../../../../test-support/random.js";
import { batchRefusal } from "../../src/review/refusals.js";

const errors = new PublicErrorLog(silentLogger, new SeededRandom(1));

const CASES: readonly [number, string, Record<string, unknown>, string][] = [
  [
    409,
    "rate_limited",
    { scope: "account", remaining: 3 },
    "这一小时Bob 的 GitHub 账号能代审的次数只剩 3 次，不够这 3 个 PR（PrimusClaw 的代审限流），所以一个也没有开始。请少发几个，或稍后再试。",
  ],
  [
    409,
    "rate_limited",
    { scope: "platform" },
    "这一小时整个平台能代审的次数不够这 3 个 PR（PrimusClaw 的代审限流），所以一个也没有开始。请少发几个，或稍后再试。",
  ],
  [
    409,
    "rate_limited",
    { remaining: true },
    "这一小时整个平台能代审的次数不够这 3 个 PR（PrimusClaw 的代审限流），所以一个也没有开始。请少发几个，或稍后再试。",
  ],
  [
    409,
    "too_many_active_items",
    { scope: "reviewer", limit: 5 },
    "Bob 手上别人请 TA 做、还没结束的代审已经到上限（5 个），所以这次一个也没有开始。等 TA 的代审结束一些后再发一次。",
  ],
  [
    409,
    "too_many_active_items",
    { scope: "requester" },
    "你请 Bob 做、还没结束的代审已经到上限，所以这次一个也没有开始。等其中一些结束或停掉一些后再发一次。",
  ],
  [
    409,
    "too_many_active_items",
    {},
    "你进行中的任务已经到上限，所以没有开始 review。请先停掉或等一些任务结束后再发一次。",
  ],
  [
    409,
    "too_many_active_items",
    { limit: 2.5 },
    "你进行中的任务已经到上限，所以没有开始 review。请先停掉或等一些任务结束后再发一次。",
  ],
  [
    503,
    "pr_check_unavailable",
    {},
    "我暂时没法向 GitHub 确认这些 PR（GitHub 或身份服务暂时不可用），所以一个也没有开始。请稍后再试。",
  ],
  [
    400,
    "model_not_allowed",
    { models: [{ name: "a b!c" }, "x", { name: 7 }, { label: "no" }] },
    "指定的模型不在 PrimusClaw 允许的模型里，所以没有开始 review。可以用的模型：abc。",
  ],
  [400, "model_not_allowed", {}, "指定的模型不在 PrimusClaw 允许的模型里，所以没有开始 review。"],
  [
    503,
    "model_unverifiable",
    {},
    "暂时没法向模型网关确认指定的模型能不能用，所以没有开始 review。请稍后再试，或不指定模型。",
  ],
  [
    409,
    "pr_check_failed",
    { reason: "acting_login_unknown" },
    "PrimusClaw 没有接受这次 review 请求（pr check failed），一个也没有开始。",
  ],
  [
    403,
    "service_client_not_allowed",
    {},
    "PrimusClaw does not take answers from me yet: its operator has to allow this worker's client. 没有开始 review。",
  ],
  [
    403,
    "interactive_sign_in_required",
    {},
    "PrimusClaw did not take my credential for you as a sign-in; tell the operator. 没有开始 review。",
  ],
];

for (const [status, error, data, expected] of CASES) {
  test(`a request claw refuses whole is said as the python worker says it: ${error} ${JSON.stringify(data)}`, () => {
    assert.equal(batchRefusal(new ReviewsRefused(status, error, "", data), "Bob", 3, errors), expected);
  });
}
