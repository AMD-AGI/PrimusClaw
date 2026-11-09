// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { OBSERVE_TEXT as T, observeText } from "../../src/locales/observe.js";

// Each right-hand side is what the Python worker's observe.py says for the same parameters.
const FIXED: readonly (readonly [string, string])[] = [
  [
    T.noticeOff,
    "静默观察已关闭：本群的消息不再交给任何人的助理。\nSilent observation is off: messages in this chat no longer go to anyone's assistant.",
  ],
  [T.notAllowed, "只有指定的人可以在群里打开静默观察。 / Only the people this is enabled for can turn observation on."],
  [
    T.notLinked,
    "先在和我的 1:1 聊天里连接你的 PrimusClaw 账号，再打开观察。 / Connect your PrimusClaw account in a 1:1 chat with me first, then turn observation on.",
  ],
  [T.notOn, "本群没有打开静默观察。 / Observation is not on in this chat."],
  [T.noScope, "这个聊天不能观察。 / This chat cannot be observed."],
  [
    T.clawOff,
    "PrimusClaw 现在没有开观察功能，什么都没改。 / PrimusClaw does not observe chats right now; nothing changed.",
  ],
  [
    T.cardGone,
    "这个按钮已失效。发 /board 看最新的建议。 / That button is no longer valid. Send /board for the latest suggestions.",
  ],
  [T.cardUsed, "这条建议已经处理过了。 / That suggestion was already handled."],
  [T.dismissed, "已忽略这条建议。 / Dismissed."],
  [T.posted, "已在群里发出。 / Posted in the group."],
  [T.handed, "已交给你的助理去做，进展看 /board。 / Handed to your assistant; /board shows how it goes."],
  [T.groupGone, "找不到那个群了，没有发出。 / That group chat is not known any more; nothing was posted."],
  [
    T.assistantDown,
    "你的助理现在接不了，可以稍后再按一次。 / Your assistant cannot take it right now; press again in a moment.",
  ],
];

test("observation's texts are the Python worker's, byte for byte", () => {
  for (const [ours, python] of FIXED) assert.equal(ours, python);
  assert.equal(
    T.noticeOn({ who: "Alice", bot: "Clawy" }),
    "🔔 Alice 在本群打开了静默观察：之后本群的消息会交给 Alice 的助理，它只记录“本会做什么”，不会在群里发言，也不会做任何事；Alice 确认后才会执行其中某一条。任何人都可以 @Clawy /observe off 关闭。\nAlice turned on silent observation here: messages in this chat go to Alice's assistant, which only writes down what it would do and does nothing; Alice decides one by one. Anyone can turn it off with @Clawy /observe off.",
  );
  assert.equal(
    T.isOn({ bot: "Clawy" }),
    "本群开着静默观察（只记录，不行动）。任何人都可以 @Clawy /observe off 关闭。 / Observation is on here (recorded only, nothing is done).",
  );
  assert.equal(
    T.usage({ bot: "Clawy" }),
    "用法：@Clawy /observe on | off | status / Usage: @Clawy /observe on | off | status",
  );
  assert.equal(
    T.clawFailed({ status: "503" }),
    "现在打不开观察（PrimusClaw 返回 503），什么都没改。请稍后再试。 / Could not turn observation on (PrimusClaw 503).",
  );
  assert.equal(
    T.clawFailed({ status: "—" }),
    "现在打不开观察（PrimusClaw 返回 —），什么都没改。请稍后再试。 / Could not turn observation on (PrimusClaw —).",
  );
  assert.equal(
    T.footer({ who: "Alice" }),
    "\n\n—— Alice 的助理起草，Alice 确认后发出 / drafted by Alice's assistant, sent on their say",
  );
  assert.equal(
    T.unsureInGroup,
    "不确定有没有送达，为免重复不会再发；请自己看一下群里。 / It is not certain this went through; to avoid doing it twice it is not sent again: please check the group.",
  );
  assert.equal(
    T.unsureWithAssistant,
    "不确定有没有送达，为免重复不会再发；请自己看一下和助理的聊天和 /board。 / It is not certain this went through; to avoid doing it twice it is not sent again: please check your assistant's chat and /board.",
  );
  assert.equal(
    T.noSuggestions({ on: 2 }),
    "群聊观察：2 个群在观察，最近没有建议。 / Group observation: 2 chat(s) observed, no suggestions lately.",
  );
  assert.equal(
    T.moreSuggestions({ more: 4 }),
    "还有 4 条建议，处理上面的再发 /board。 / 4 more suggestions; handle these and send /board again.",
  );
  assert.ok(
    T.acceptedRequest({ kind: "k", what: "w", message: "m" }).startsWith(
      "我确认了群聊观察里的一条建议，请照做：k\nw\n\n",
    ),
  );
  assert.equal(observeText.in("zh"), observeText.in("en"));
});
