// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/**
 * What the group-context switch says. Each text is bilingual in itself (Chinese, then English), as observation's are:
 * a group's members do not share one language, so both languages of the catalog hold the same texts.
 */
const texts = {
  turnedOff: (p: { bot: string }) =>
    `已关闭：之后在本群 @${p.bot} 时，不再带上最近的群聊消息，已记下的也已清空。@${p.bot} /context on 可重新打开。\n` +
    `Off: when you @${p.bot} here, the recent messages of this chat are no longer included, and what was kept is ` +
    `cleared. @${p.bot} /context on turns it back on.`,
  turnedOn: (p: { bot: string }) =>
    `已打开：在本群 @${p.bot} 时，会带上最近的群聊消息（只在内存中，不保存）作为背景。@${p.bot} /context off 可关闭。\n` +
    `On: when you @${p.bot} here, the recent messages of this chat go along as background (kept in memory only, ` +
    `never stored). @${p.bot} /context off turns it off.`,
  isOn: (p: { bot: string; count: string }) =>
    `本群开着最近消息背景，现在记着 ${p.count} 条。@${p.bot} /context off 可关闭。\n` +
    `Recent-messages context is on here, ${p.count} message(s) kept now. @${p.bot} /context off turns it off.`,
  isOnEmpty: (p: { bot: string }) =>
    `本群开着最近消息背景，但还没有收到未 @ 我的消息（本群可能没有授权我读取聊天消息）。@${p.bot} /context off 可关闭。\n` +
    `Recent-messages context is on here, but no message that does not @mention me has reached me (this chat may not ` +
    `have allowed me to read its messages). @${p.bot} /context off turns it off.`,
  isOff: (p: { bot: string }) =>
    `本群关着最近消息背景。@${p.bot} /context on 可打开。\n` +
    `Recent-messages context is off here. @${p.bot} /context on turns it on.`,
  unavailable: "这个部署没有开启最近消息背景。 / Recent-messages context is not enabled in this deployment.",
  usage: (p: { bot: string }) =>
    `用法：@${p.bot} /context on | off | status / Usage: @${p.bot} /context on | off | status`,
};

export const groupContextText = defineCatalog({ en: texts, zh: texts });
export const GROUP_CONTEXT_TEXT = texts;
